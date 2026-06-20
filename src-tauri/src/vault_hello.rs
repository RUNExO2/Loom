// OS-native vault unlock via Windows Hello.
//
// The vault master password is the encryption key for every stored secret, so Hello can't
// replace it — instead we store the master password protected by Windows DPAPI (bound to
// the current OS user) and gate its retrieval behind a Windows Hello consent prompt. Hello
// surfaces whatever the user has enrolled: face, fingerprint, or PIN.
//
// Non-Windows builds compile with stubs that report "unavailable".

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn blob_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("vault_hello.bin"))
}

/// Whether a Windows Hello credential is enrolled and usable on this machine.
#[tauri::command]
pub fn hello_available() -> bool {
    imp::available()
}

/// Whether the user has linked their vault to Hello on this machine.
#[tauri::command]
pub fn hello_enrolled(app_handle: tauri::AppHandle) -> Result<bool, String> {
    Ok(blob_path(&app_handle)?.exists())
}

/// Link the vault to Hello: DPAPI-protect the master password and store it.
#[tauri::command]
pub fn hello_enable(app_handle: tauri::AppHandle, secret: String) -> Result<(), String> {
    let protected = imp::protect(secret.as_bytes())?;
    fs::write(blob_path(&app_handle)?, protected).map_err(|e| e.to_string())
}

/// Unlink the vault from Hello (delete the protected blob).
#[tauri::command]
pub fn hello_disable(app_handle: tauri::AppHandle) -> Result<(), String> {
    let p = blob_path(&app_handle)?;
    if p.exists() { fs::remove_file(&p).map_err(|e| e.to_string())?; }
    Ok(())
}

/// Prompt Windows Hello; on success return the master password for the vault to unlock.
#[tauri::command]
pub fn hello_unlock(app_handle: tauri::AppHandle) -> Result<String, String> {
    let p = blob_path(&app_handle)?;
    if !p.exists() { return Err("Windows Hello is not set up for the vault.".into()); }
    if !imp::verify("Unlock your Loom vault")? {
        return Err("Windows Hello verification was cancelled or failed.".into());
    }
    let blob = fs::read(&p).map_err(|e| e.to_string())?;
    let plain = imp::unprotect(&blob)?;
    String::from_utf8(plain).map_err(|_| "Stored credential was corrupt.".into())
}

#[cfg(windows)]
mod imp {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Security::Credentials::UI::{
        UserConsentVerifier, UserConsentVerifierAvailability, UserConsentVerificationResult,
    };
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    pub fn available() -> bool {
        UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.get())
            .map(|a| a == UserConsentVerifierAvailability::Available)
            .unwrap_or(false)
    }

    pub fn verify(message: &str) -> Result<bool, String> {
        let msg = HSTRING::from(message);
        let op = UserConsentVerifier::RequestVerificationAsync(&msg).map_err(|e| e.to_string())?;
        let res = op.get().map_err(|e| e.to_string())?;
        Ok(res == UserConsentVerificationResult::Verified)
    }

    unsafe fn take_out(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let slice = std::slice::from_raw_parts(out.pbData, out.cbData as usize);
        let v = slice.to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
        v
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let in_blob = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptProtectData(&in_blob, PCWSTR::null(), None, None, None, 0, &mut out).map_err(|e| e.to_string())?;
            Ok(take_out(out))
        }
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let in_blob = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptUnprotectData(&in_blob, None, None, None, None, 0, &mut out).map_err(|e| e.to_string())?;
            Ok(take_out(out))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    const MSG: &str = "Windows Hello is only available on Windows.";
    pub fn available() -> bool { false }
    pub fn verify(_message: &str) -> Result<bool, String> { Err(MSG.into()) }
    pub fn protect(_data: &[u8]) -> Result<Vec<u8>, String> { Err(MSG.into()) }
    pub fn unprotect(_data: &[u8]) -> Result<Vec<u8>, String> { Err(MSG.into()) }
}
