// Real file-at-rest + vault-value encryption. AES-256-GCM with an Argon2id-derived key.
//
// VERSIONED ENVELOPE. The KDF parameters (memory/iteration/parallelism) and the
// algorithm version are serialized alongside the ciphertext, so the cost can be
// raised in future releases without breaking entries written by older releases.
//
// File on-disk formats:
//   Legacy "LOOMENC1": MAGIC(8) | salt(16) | nonce(12) | ct+tag        (Argon2id defaults)
//   Versioned "LOOMENC2": MAGIC(8) | m_cost(4 LE) | t_cost(4) | p_cost(4)
//                         | salt(16) | nonce(12) | ct+tag
//
// Vault-value (string) formats:
//   Legacy: "{salt_hex}:{nonce_hex}:{ct_hex}"                          (Argon2id defaults)
//   Versioned: "v1:{m}:{t}:{p}:{salt_hex}:{nonce_hex}:{ct_hex}"
//
// New writes always use the versioned format with CURRENT params. Old entries keep
// decrypting via the legacy path; they migrate forward transparently the next time
// they are re-saved (edit re-encrypts with CURRENT). The password is never stored;
// a wrong password yields a GCM tag mismatch => decrypt error.

use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::{Aead, KeyInit};
use argon2::{Argon2, Algorithm, Version, Params};
use rand::RngCore;
use std::fs;
use std::path::Path;
use zeroize::Zeroizing;

const MAGIC_V1: &[u8; 8] = b"LOOMENC1"; // legacy file: Argon2id default params, no header
const MAGIC_V2: &[u8; 8] = b"LOOMENC2"; // versioned file: KDF params in header

#[derive(Clone, Copy)]
struct KdfParams {
    m_cost: u32, // memory cost (KiB)
    t_cost: u32, // iterations
    p_cost: u32, // parallelism (lanes)
}

// Params used for all NEW entries. These intentionally equal the argon2 crate
// defaults (Argon2id, v0x13, m=19456 KiB, t=2, p=1) so introducing the envelope
// changes nothing about today's derived keys. To harden later: bump these values
// (and, for the string format, the "v1" tag -> "v2") — old entries still decrypt
// from their own stored params, new entries use the stronger cost.
const CURRENT: KdfParams = KdfParams { m_cost: 19456, t_cost: 2, p_cost: 1 };
// Params implied by the legacy formats, which never stored them.
const LEGACY: KdfParams = KdfParams { m_cost: 19456, t_cost: 2, p_cost: 1 };

// Returns the derived key wrapped in Zeroizing so the 32 bytes are wiped from
// memory when the value is dropped, rather than lingering on the stack/heap.
fn derive_key(password: &str, salt: &[u8], kp: KdfParams) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(kp.m_cost, kp.t_cost, kp.p_cost, Some(32))
        .map_err(|e| format!("Invalid KDF params: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, &mut *key)
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(key)
}

// Pure crypto primitive — returns the new on-disk path. DB integration (preserving the
// item id + relationships) lives in fs_commands::fs_encrypt_file.
pub fn encrypt_path(path: &str, password: &str) -> Result<String, String> {
    let path = path.to_string();
    let password = password.to_string();
    if password.is_empty() {
        return Err("A password is required to encrypt.".into());
    }
    let p = Path::new(&path);
    if !p.exists() || !p.is_file() {
        return Err("File not found.".into());
    }
    let plaintext = fs::read(p).map_err(|e| e.to_string())?;
    if is_encrypted_bytes(&plaintext) {
        return Err("This file is already encrypted.".into());
    }

    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);

    let kp = CURRENT;
    let key = derive_key(&password, &salt, kp)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|e| format!("Encryption failed: {e}"))?;

    let mut out = Vec::with_capacity(8 + 12 + salt.len() + nonce_bytes.len() + ciphertext.len());
    out.extend_from_slice(MAGIC_V2);
    out.extend_from_slice(&kp.m_cost.to_le_bytes());
    out.extend_from_slice(&kp.t_cost.to_le_bytes());
    out.extend_from_slice(&kp.p_cost.to_le_bytes());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);

    let enc_path = format!("{}.enc", path);
    if Path::new(&enc_path).exists() {
        return Err("An encrypted copy already exists at that location.".into());
    }
    fs::write(&enc_path, &out).map_err(|e| e.to_string())?;
    // Only remove the plaintext once the encrypted file is safely written.
    fs::remove_file(p).map_err(|e| e.to_string())?;
    Ok(enc_path)
}

pub fn decrypt_path(path: &str, password: &str) -> Result<String, String> {
    let path = path.to_string();
    let password = password.to_string();
    if password.is_empty() {
        return Err("A password is required to decrypt.".into());
    }
    let p = Path::new(&path);
    if !p.exists() || !p.is_file() {
        return Err("File not found.".into());
    }
    let data = fs::read(p).map_err(|e| e.to_string())?;

    // Parse the envelope header by magic, recovering KDF params + slice offsets.
    let (kp, salt, nonce_bytes, ciphertext): (KdfParams, &[u8], &[u8], &[u8]) =
        if data.len() >= 8 && &data[..8] == MAGIC_V2 {
            let header = 8 + 12 + 16 + 12; // magic + params(3*u32) + salt + nonce
            if data.len() < header {
                return Err("This file is not a LOOM-encrypted file.".into());
            }
            let m = u32::from_le_bytes(data[8..12].try_into().unwrap());
            let t = u32::from_le_bytes(data[12..16].try_into().unwrap());
            let pc = u32::from_le_bytes(data[16..20].try_into().unwrap());
            (
                KdfParams { m_cost: m, t_cost: t, p_cost: pc },
                &data[20..36],
                &data[36..48],
                &data[48..],
            )
        } else if data.len() >= 8 && &data[..8] == MAGIC_V1 {
            let header = 8 + 16 + 12;
            if data.len() < header {
                return Err("This file is not a LOOM-encrypted file.".into());
            }
            (LEGACY, &data[8..24], &data[24..36], &data[36..])
        } else {
            return Err("This file is not a LOOM-encrypted file.".into());
        };

    let key = derive_key(&password, salt, kp)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "Wrong password, or the file is corrupted.".to_string())?;

    let out_path = if path.ends_with(".enc") {
        path[..path.len() - 4].to_string()
    } else {
        format!("{}.dec", path)
    };
    if Path::new(&out_path).exists() {
        return Err("A decrypted file already exists at that location.".into());
    }
    fs::write(&out_path, &plaintext).map_err(|e| e.to_string())?;
    fs::remove_file(p).map_err(|e| e.to_string())?;
    Ok(out_path)
}

// True if the bytes begin with any recognized LOOM envelope magic.
fn is_encrypted_bytes(data: &[u8]) -> bool {
    data.len() >= 8 && (&data[..8] == MAGIC_V1 || &data[..8] == MAGIC_V2)
}

#[tauri::command]
pub fn is_file_encrypted(path: String) -> Result<bool, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(false);
    }
    let mut buf = [0u8; 8];
    use std::io::Read;
    let mut f = fs::File::open(p).map_err(|e| e.to_string())?;
    match f.read_exact(&mut buf) {
        Ok(_) => Ok(&buf == MAGIC_V1 || &buf == MAGIC_V2),
        Err(_) => Ok(false),
    }
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn from_hex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("Invalid hex string".into());
    }
    let mut bytes = Vec::with_capacity(s.len() / 2);
    for i in (0..s.len()).step_by(2) {
        let res = u8::from_str_radix(&s[i..i+2], 16).map_err(|e| e.to_string())?;
        bytes.push(res);
    }
    Ok(bytes)
}

#[tauri::command]
pub fn encrypt_vault_value(plaintext: String, password: String) -> Result<String, String> {
    if password.is_empty() {
        return Err("Password is required.".into());
    }
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);

    let kp = CURRENT;
    let key = derive_key(&password, &salt, kp)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {e}"))?;

    // Versioned "v1" string: KDF params travel with the ciphertext.
    Ok(format!(
        "v1:{}:{}:{}:{}:{}:{}",
        kp.m_cost, kp.t_cost, kp.p_cost,
        to_hex(&salt), to_hex(&nonce_bytes), to_hex(&ciphertext)
    ))
}

#[tauri::command]
pub fn decrypt_vault_value(ciphertext_str: String, password: String) -> Result<String, String> {
    if password.is_empty() {
        return Err("Password is required.".into());
    }
    let parts: Vec<&str> = ciphertext_str.split(':').collect();

    // Dispatch on shape: 3 parts = legacy (default params), 7 parts w/ "v1" = versioned.
    let (kp, salt, nonce_bytes, ciphertext) = match parts.len() {
        3 => (
            LEGACY,
            from_hex(parts[0])?,
            from_hex(parts[1])?,
            from_hex(parts[2])?,
        ),
        7 if parts[0] == "v1" => {
            let m = parts[1].parse::<u32>().map_err(|_| "Invalid KDF param.".to_string())?;
            let t = parts[2].parse::<u32>().map_err(|_| "Invalid KDF param.".to_string())?;
            let pc = parts[3].parse::<u32>().map_err(|_| "Invalid KDF param.".to_string())?;
            (
                KdfParams { m_cost: m, t_cost: t, p_cost: pc },
                from_hex(parts[4])?,
                from_hex(parts[5])?,
                from_hex(parts[6])?,
            )
        }
        _ => return Err("Invalid cipher text format.".into()),
    };

    let key = derive_key(&password, &salt, kp)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
    let decrypted_bytes = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_slice())
        .map_err(|_| "Wrong password.".to_string())?;

    String::from_utf8(decrypted_bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_value_roundtrip_is_versioned() {
        let enc = encrypt_vault_value("hunter2".into(), "master".into()).unwrap();
        assert!(enc.starts_with("v1:"), "new writes must use versioned envelope");
        let dec = decrypt_vault_value(enc, "master".into()).unwrap();
        assert_eq!(dec, "hunter2");
    }

    #[test]
    fn legacy_3part_value_still_decrypts() {
        // Build a pre-envelope blob exactly as the old code did: bare salt:nonce:ct,
        // default Argon2id params, no version tag. Must remain decryptable.
        let mut salt = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let key = derive_key("master", &salt, LEGACY).unwrap();
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), b"legacy-secret".as_ref())
            .unwrap();
        let legacy = format!("{}:{}:{}", to_hex(&salt), to_hex(&nonce), to_hex(&ct));

        let dec = decrypt_vault_value(legacy, "master".into()).unwrap();
        assert_eq!(dec, "legacy-secret");
    }

    #[test]
    fn wrong_password_is_rejected() {
        let enc = encrypt_vault_value("s3cret".into(), "right".into()).unwrap();
        assert!(decrypt_vault_value(enc, "wrong".into()).is_err());
    }

    #[test]
    fn future_params_decrypt_from_envelope() {
        // Simulate a stronger-cost entry: params read from the blob, not from CURRENT.
        let kp = KdfParams { m_cost: 32768, t_cost: 3, p_cost: 1 };
        let mut salt = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let key = derive_key("master", &salt, kp).unwrap();
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]));
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), b"strong".as_ref())
            .unwrap();
        let blob = format!(
            "v1:{}:{}:{}:{}:{}:{}",
            kp.m_cost, kp.t_cost, kp.p_cost,
            to_hex(&salt), to_hex(&nonce), to_hex(&ct)
        );
        let dec = decrypt_vault_value(blob, "master".into()).unwrap();
        assert_eq!(dec, "strong");
    }
}
