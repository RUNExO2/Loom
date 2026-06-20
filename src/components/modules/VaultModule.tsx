import React, { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { listStagger, listItem } from "../../lib/motionVariants";
import { I, cx, useLoom, clickable } from "../../lib/context";
import { EmptyState } from "../shared";
import { Item } from "../../ipc/items";
import { useVault, useItemStore } from "../../lib/itemStore";
import { vaultSession } from "../../lib/vaultSession";
import { getVaultMeta } from "../../lib/meta";
import { createVaultViewModel } from "../../lib/viewmodels";
import { deleteCommand, useCommands } from "../../lib/commands";
import { useModal } from "../Modal";
import { getSetting, setSetting } from "../../ipc/items";
import { encryptVaultValue, decryptVaultValue, helloAvailable, helloEnrolled, helloEnable, helloDisable, helloUnlock } from "../../ipc/content";
import { PageHead } from "./shared";

const fld: React.CSSProperties = {
  background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)",
  color: "var(--text)", padding: "7px 10px", fontSize: "var(--fs-sm)", width: "100%",
};

export function VaultModule() {
  const { toast } = useLoom();
  const modal = useModal();
  const commands = useCommands();
  const { items, create, updateMeta, updateFields, remove, restore, ready } = useVault();
  const { links, items: allItems, isVaultUnlocked } = useItemStore();

  const [hasMasterPassword, setHasMasterPassword] = useState<boolean | null>(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [helloAvail, setHelloAvail] = useState(false);
  const [helloOn, setHelloOn] = useState(false);

  const { list } = useMemo(() => createVaultViewModel({ items, links, allItems }), [items, links, allItems]);

  useEffect(() => {
    getSetting("vault_verification")
      .then((val) => { setHasMasterPassword(!!val); })
      .catch(console.error);
    helloAvailable().then(setHelloAvail).catch(() => setHelloAvail(false));
    helloEnrolled().then(setHelloOn).catch(() => setHelloOn(false));
  }, []);

  const handleHelloUnlock = async () => {
    try {
      const pw = await helloUnlock();
      const verif = await getSetting("vault_verification");
      if (verif && (await decryptVaultValue(verif, pw)) === "verification_token") {
        vaultSession.unlock(pw);
        setErrorMsg("");
        setPasswordInput("");
      } else {
        setErrorMsg("Saved Hello credential no longer matches the master password.");
      }
    } catch (err: any) {
      setErrorMsg(String(err).replace(/^Error:\s*/, ""));
    }
  };

  const toggleHello = async () => {
    try {
      if (helloOn) {
        await helloDisable();
        setHelloOn(false);
        toast("Windows Hello unlock disabled", "ph-lock");
      } else {
        await helloEnable(vaultSession.access());
        setHelloOn(true);
        toast("Windows Hello unlock enabled", "ph-fingerprint");
      }
    } catch (err: any) {
      toast(String(err).replace(/^Error:\s*/, ""), "ph-warning");
    }
  };

  const handleSetUpMaster = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordInput.trim()) return;
    try {
      const verif = await encryptVaultValue("verification_token", passwordInput);
      await setSetting("vault_verification", verif);
      vaultSession.unlock(passwordInput);
      setHasMasterPassword(true);
      setErrorMsg("");
      setPasswordInput("");
    } catch (err: any) {
      setErrorMsg(String(err));
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const verif = await getSetting("vault_verification");
      if (!verif) { setHasMasterPassword(false); return; }
      const decrypted = await decryptVaultValue(verif, passwordInput);
      if (decrypted === "verification_token") {
        vaultSession.unlock(passwordInput);
        setErrorMsg("");
        setPasswordInput("");
      } else {
        setErrorMsg("Incorrect master password.");
      }
    } catch {
      setErrorMsg("Incorrect master password.");
    }
  };

  const handleAdd = async () => {
    if (!isVaultUnlocked) return;
    const r = await modal.form({ panel: true,
      title: "Add Vault Credential", icon: "ph-shield-plus", accent: "var(--h-vault)", submitLabel: "Create",
      fields: [
        { name: "title", label: "Title", placeholder: "e.g., GitHub Personal Token", required: true },
        { name: "kind", label: "Kind", type: "select", defaultValue: "API key", options: [
          { value: "API key", label: "API Key" }, { value: "Login", label: "Login" },
          { value: "SSH key", label: "SSH Key" }, { value: "Secure note", label: "Secure Note" },
          { value: "Password", label: "Password" }
        ] },
        { name: "secret", label: "Secret / Password", type: "password", required: true, placeholder: "Enter secret value to encrypt" }
      ]
    });
    if (!r) return;

    try {
      const password = vaultSession.access();
      const encrypted = await encryptVaultValue(r.secret, password);
      let icon = "ph-shield-check";
      if (r.kind === "API key") icon = "ph-key";
      if (r.kind === "Login") icon = "ph-user-focus";
      if (r.kind === "SSH key") icon = "ph-terminal";
      if (r.kind === "Password") icon = "ph-lock-key";
      await create(r.title, { kind: r.kind, icon, color: "var(--h-vault)", updated: "Just now", secret: encrypted });
      toast("Credential added securely", "ph-check-circle");
    } catch (err) { console.error(err); toast("Failed to create credential", "ph-warning"); }
  };

  const handleEdit = async (item: Item, meta: any, currentSecret: string) => {
    if (!isVaultUnlocked) return;
    const r = await modal.form({ panel: true,
      title: "Edit Vault Credential", icon: "ph-pencil", accent: "var(--h-vault)", submitLabel: "Save changes",
      fields: [
        { name: "title", label: "Title", defaultValue: item.title, required: true },
        { name: "kind", label: "Kind", type: "select", defaultValue: meta.kind || "API key", options: [
          { value: "API key", label: "API Key" }, { value: "Login", label: "Login" },
          { value: "SSH key", label: "SSH Key" }, { value: "Secure note", label: "Secure Note" },
          { value: "Password", label: "Password" }
        ] },
        { name: "secret", label: "Secret / Password", type: "password", defaultValue: currentSecret, required: true }
      ]
    });
    if (!r) return;

    try {
      const password = vaultSession.access();
      const encrypted = await encryptVaultValue(r.secret, password);
      let icon = meta.icon || "ph-shield-check";
      if (r.kind === "API key") icon = "ph-key";
      if (r.kind === "Login") icon = "ph-user-focus";
      if (r.kind === "SSH key") icon = "ph-terminal";
      if (r.kind === "Password") icon = "ph-lock-key";
      if (r.title !== item.title) await updateFields(item.id, r.title, "vault");
      await updateMeta(item.id, { ...meta, kind: r.kind, icon, updated: "Updated just now", secret: encrypted });
      toast("Credential updated securely", "ph-check-circle");
    } catch (err) { console.error(err); toast("Failed to update credential", "ph-warning"); }
  };

  const handleViewDetails = async (item: Item) => {
    if (!isVaultUnlocked) return;
    const meta = getVaultMeta(item);

    let secret = "";
    if (meta.secret) {
      try {
        const password = vaultSession.access();
        secret = await decryptVaultValue(meta.secret, password);
      } catch {
        secret = "Failed to decrypt secret.";
      }
    }

    const ok = await modal.confirm({
      title: item.title,
      icon: meta.icon || "ph-shield-check",
      confirmLabel: "Done",
      cancelLabel: "Edit",
      message: (
        <div className="col gap12" style={{ padding: "10px 0" }}>
          <div>
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>Kind</span>
            <div style={{ fontSize: "var(--fs-sm)", fontWeight: 550 }}>{meta.kind}</div>
          </div>
          <div>
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>Secret / Password</span>
            <div className="row gap8" style={{ alignItems: "center", marginTop: 4 }}>
              <input
                type="password"
                value={secret}
                readOnly
                style={{ ...fld, flex: 1, fontFamily: "monospace" }}
                onClick={(e) => {
                  const target = e.target as HTMLInputElement;
                  target.type = target.type === "password" ? "text" : "password";
                }}
                title="Click to toggle visibility"
              />
              <button className="btn sm" type="button" onClick={() => {
                navigator.clipboard.writeText(secret);
                toast("Copied — clipboard clears in 20s", "ph-clipboard");
                setTimeout(() => {
                  navigator.clipboard.readText()
                    .then((cur) => { if (cur === secret) navigator.clipboard.writeText(""); })
                    .catch(() => {});
                }, 20000);
              }}>Copy</button>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn sm danger" type="button" onClick={async () => {
              const confirmDelete = await modal.confirm({ title: "Delete item", message: `Are you sure you want to delete "${item.title}"?`, icon: "ph-trash", danger: true, confirmLabel: "Delete" });
              if (confirmDelete) {
                try {
                  const itemLinks = links.filter((l) => l.source_id === item.id || l.target_id === item.id);
                  await commands.run(deleteCommand(remove, restore, item, itemLinks, "Delete Vault Item"));
                } catch (err) { console.error(err); }
              }
            }}>Delete Item</button>
          </div>
        </div>
      )
    });

    if (ok === false) handleEdit(item, meta, secret);
  };

  if (!ready || hasMasterPassword === null) {
    return (
      <div className="content-pad fade-in" style={{ "--mod": "var(--h-vault)" } as any}>
        <PageHead mod="var(--h-vault)" icon="ph-vault" kicker="Vault" title="Secure vault" />
        <div className="muted" style={{ padding: "20px 0" }}>Loading vault...</div>
      </div>
    );
  }

  if (hasMasterPassword === false) {
    return (
      <div className="content-pad fade-in" style={{ "--mod": "var(--h-vault)" } as any}>
        <PageHead mod="var(--h-vault)" icon="ph-vault" kicker="Vault" title="Secure vault" />
        <div className="col gap12" style={{ maxWidth: 360, margin: "40px auto", padding: 24, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)" }}>
          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <div className="vault-ico" style={{ width: 48, height: 48, margin: "0 auto 12px", borderRadius: "50%", background: "color-mix(in oklch, var(--h-vault) 15%, transparent)", color: "var(--h-vault)", display: "grid", placeItems: "center", fontSize: "24px" }}>
              <I n="ph-shield-check" w="fill" />
            </div>
            <h3 style={{ fontSize: "var(--fs-lg)", fontWeight: 600 }}>Set up Master Password</h3>
            <p className="muted" style={{ fontSize: "var(--fs-xs)", marginTop: 4 }}>Choose a strong password to encrypt your vault credentials at rest.</p>
          </div>
          <form onSubmit={handleSetUpMaster} className="col gap12">
            <input type="password" placeholder="New Master Password" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} style={fld} autoFocus />
            {errorMsg && <div style={{ color: "var(--danger)", fontSize: "var(--fs-xs)" }}><I n="ph-warning-circle" /> {errorMsg}</div>}
            <button type="submit" className="btn primary" style={{ width: "100%", justifyContent: "center" }}>Set Password</button>
          </form>
        </div>
      </div>
    );
  }

  if (!isVaultUnlocked) {
    return (
      <div className="content-pad fade-in" style={{ "--mod": "var(--h-vault)" } as any}>
        <PageHead mod="var(--h-vault)" icon="ph-vault" kicker="Vault" title="Secure vault" />
        <div className="col gap12" style={{ maxWidth: 360, margin: "40px auto", padding: 24, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)" }}>
          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <div className="vault-ico" style={{ width: 48, height: 48, margin: "0 auto 12px", borderRadius: "50%", background: "color-mix(in oklch, var(--h-vault) 15%, transparent)", color: "var(--h-vault)", display: "grid", placeItems: "center", fontSize: "24px" }}>
              <I n="ph-lock-key" w="fill" />
            </div>
            <h3 style={{ fontSize: "var(--fs-lg)", fontWeight: 600 }}>Unlock Vault</h3>
            <p className="muted" style={{ fontSize: "var(--fs-xs)", marginTop: 4 }}>Enter your Master Password to access credentials.</p>
          </div>
          <form onSubmit={handleUnlock} className="col gap12">
            <input type="password" placeholder="Master Password" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} style={fld} autoFocus />
            {errorMsg && <div style={{ color: "var(--danger)", fontSize: "var(--fs-xs)" }}><I n="ph-warning-circle" /> {errorMsg}</div>}
            <button type="submit" className="btn primary" style={{ width: "100%", justifyContent: "center" }}>Unlock</button>
          </form>
          {helloAvail && helloOn && (
            <>
              <div className="row" style={{ alignItems: "center", gap: 8, margin: "4px 0" }}>
                <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                <span className="muted" style={{ fontSize: "var(--fs-2xs)" }}>OR</span>
                <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              </div>
              <button type="button" className="btn outline" style={{ width: "100%", justifyContent: "center" }} onClick={handleHelloUnlock}>
                <I n="ph-fingerprint" /> Unlock with Windows Hello
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="content-pad fade-in" style={{ "--mod": "var(--h-vault)" } as any}>
      <PageHead mod="var(--h-vault)" icon="ph-vault" kicker="Vault" title="Secure vault"
        sub="A registry of credentials, keys, and secure notes — titles and links, organised in one place.">
        {helloAvail && (
          <button className={cx("btn outline", helloOn && "active")} onClick={toggleHello} title={helloOn ? "Disable Windows Hello unlock" : "Enable Windows Hello unlock"}>
            <I n="ph-fingerprint" /> {helloOn ? "Hello: On" : "Enable Hello"}
          </button>
        )}
        <button className="btn outline" onClick={() => { vaultSession.lock(); setPasswordInput(""); }}><I n="ph-lock" /> Lock Vault</button>
        <button className="btn primary" onClick={handleAdd}><I n="ph-plus" w="bold" /> Add credential</button>
      </PageHead>
      <div className="vault-banner">
        <I n="ph-info" w="fill" />
        <div style={{ flex: 1 }}>
          <b>Reference registry.</b>{" "}
          <span className="muted">This catalogues your secure items and their links. To store an encrypted value on disk, attach a file and encrypt it from the Files module.</span>
        </div>
      </div>
      {list.length === 0 ? (
        <EmptyState icon="ph-lock-key" mod="var(--h-vault)" title="No vault entries yet" sub="Catalogue a credential or secure note here." />
      ) : (
        <motion.div className="vault-grid" variants={listStagger} initial="initial" animate="enter">
          {list.map(({ item, meta, linkCount }) => (
            <motion.div variants={listItem} key={item.id} className="vault-card" style={{ "--mod": meta.color } as any} onClick={() => handleViewDetails(item)} {...clickable(() => handleViewDetails(item))}>
              <div className="vault-ico"><I n={meta.icon || "ph-shield-check"} w="fill" /></div>
              <div className="vault-main">
                <div className="vault-t">{item.title}</div>
                <div className="vault-s">{meta.kind}</div>
              </div>
              {linkCount > 0 && <span className="mono-sm ghost" title={linkCount + " links"}><I n="ph-link" /> {linkCount}</span>}
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
