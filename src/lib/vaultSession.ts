import { emit } from "@tauri-apps/api/event";

class VaultSession {
  private masterPassword: string | null = null;
  private timer: any = null;
  private readonly TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  public unlock(password: string): boolean {
    this.masterPassword = password;
    this.resetTimer();
    emit("loom://event", { type: "VAULT_UNLOCKED" }).catch(console.error);
    return true;
  }

  public access(): string {
    if (!this.masterPassword) {
      throw new Error("Vault is locked");
    }
    this.resetTimer();
    return this.masterPassword;
  }

  public invalidate() {
    this.lock();
  }

  public lock() {
    this.masterPassword = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    emit("loom://event", { type: "VAULT_LOCKED" }).catch(console.error);
  }

  public isUnlocked(): boolean {
    return this.masterPassword !== null;
  }

  private resetTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      console.log("Vault auto-locked due to inactivity");
      this.lock();
    }, this.TIMEOUT_MS);
  }
}

export const vaultSession = new VaultSession();
