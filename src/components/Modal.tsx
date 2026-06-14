import React, { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { scrimVariants, modalVariants } from "../lib/motionVariants";
import { I, cx } from "../lib/context";
import { Button } from "./ui/Button";

// ── LOOM modal system ───────────────────────────────────────────────────────────
// Promise-based, fully themed replacement for window.prompt / confirm / alert.
// Built on Radix Dialog (focus trap, aria-modal, Escape, outside-click) with
// Framer Motion enter/exit layered on top. A modal collects input; the CALLER
// performs the IPC mutation — the modal never persists anything itself.

export interface ModalField {
  name: string;
  label: string;
  type?: "text" | "textarea" | "url" | "select" | "datetime-local" | "date" | "password";
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  options?: { value: string; label: string; icon?: string }[];
}
export interface FormConfig {
  title: string;
  icon?: string;
  accent?: string;       // --mod color for the header glyph + focus ring tint
  submitLabel?: string;
  fields: ModalField[];
}
export interface ConfirmConfig {
  title: string;
  message: React.ReactNode;
  icon?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ModalApi {
  form: (cfg: FormConfig) => Promise<Record<string, string> | null>;
  confirm: (cfg: ConfirmConfig) => Promise<boolean>;
}

const ModalCtx = createContext<ModalApi | null>(null);
export const useModal = () => {
  const c = useContext(ModalCtx);
  if (!c) throw new Error("useModal must be used within ModalProvider");
  return c;
};

type Active =
  | { kind: "form"; cfg: FormConfig; resolve: (v: Record<string, string> | null) => void }
  | { kind: "confirm"; cfg: ConfirmConfig; resolve: (v: boolean) => void }
  | null;

export function ModalProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<Active>(null);

  const form = useCallback(
    (cfg: FormConfig) => new Promise<Record<string, string> | null>((resolve) => setActive({ kind: "form", cfg, resolve })),
    []
  );
  const confirm = useCallback(
    (cfg: ConfirmConfig) => new Promise<boolean>((resolve) => setActive({ kind: "confirm", cfg, resolve })),
    []
  );
  const api = useMemo<ModalApi>(() => ({ form, confirm }), [form, confirm]);

  return (
    <ModalCtx.Provider value={api}>
      {children}
      <AnimatePresence>
        {active?.kind === "form" && (
          <FormModal
            key="form"
            cfg={active.cfg}
            onDone={(v) => { active.resolve(v); setActive(null); }}
          />
        )}
        {active?.kind === "confirm" && (
          <ConfirmModal
            key="confirm"
            cfg={active.cfg}
            onDone={(v) => { active.resolve(v); setActive(null); }}
          />
        )}
      </AnimatePresence>
    </ModalCtx.Provider>
  );
}

// Shared Radix + motion chrome. Radix supplies role="dialog", aria-modal,
// labelling, the focus trap, Escape, and outside-click dismissal; the wrapper
// is pointer-events:none so backdrop clicks land on the Overlay (= outside).
function ModalShell({ mod, onDismiss, onOpenAutoFocus, children }: {
  mod: string;
  onDismiss: () => void;
  onOpenAutoFocus?: (e: Event) => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onDismiss(); }}>
      <Dialog.Portal forceMount>
        <Dialog.Overlay asChild forceMount>
          <motion.div className="modal-scrim" variants={scrimVariants} initial="initial" animate="enter" exit="exit" />
        </Dialog.Overlay>
        <Dialog.Content asChild forceMount onOpenAutoFocus={onOpenAutoFocus}>
          <motion.div className="modal-wrap" variants={modalVariants} initial="initial" animate="enter" exit="exit">
            <div className="modal" style={{ "--mod": mod } as any}>
              {children}
            </div>
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FormModal({ cfg, onDone }: { cfg: FormConfig; onDone: (v: Record<string, string> | null) => void }) {
  const init = useMemo(() => {
    const o: Record<string, string> = {};
    for (const f of cfg.fields) o[f.name] = f.defaultValue ?? (f.type === "select" ? f.options?.[0]?.value ?? "" : "");
    return o;
  }, [cfg]);
  const [values, setValues] = useState<Record<string, string>>(init);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const fieldError = (f: ModalField) =>
    f.required && (values[f.name] ?? "").trim() === "" ? "This field is required" : null;
  const fieldOk = (f: ModalField) =>
    f.required && (values[f.name] ?? "").trim() !== "";

  const valid = cfg.fields.every((f) => !fieldError(f));
  const set = (name: string, v: string) => setValues((p) => ({ ...p, [name]: v }));
  const blur = (name: string) => setTouched((p) => ({ ...p, [name]: true }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) {
      // Surface every missing field instead of failing silently.
      const all: Record<string, boolean> = {};
      for (const f of cfg.fields) all[f.name] = true;
      setTouched(all);
      return;
    }
    const trimmed: Record<string, string> = {};
    for (const k of Object.keys(values)) trimmed[k] = values[k].trim();
    onDone(trimmed);
  };

  return (
    <ModalShell
      mod={cfg.accent || "var(--accent)"}
      onDismiss={() => onDone(null)}
      onOpenAutoFocus={(e) => { e.preventDefault(); firstRef.current?.focus(); firstRef.current?.select?.(); }}
    >
      <div className="modal-head">
        <div className="modal-ico"><I n={cfg.icon || "ph-pencil-simple"} w="fill" /></div>
        <Dialog.Title asChild><span className="modal-t">{cfg.title}</span></Dialog.Title>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {cfg.fields.map((f, i) => {
            const err = touched[f.name] ? fieldError(f) : null;
            return (
              <div className="modal-field" key={f.name}>
                <label htmlFor={`mf-${f.name}`}>
                  {f.label}{f.required && <span style={{ color: "var(--mod)" }}> *</span>}
                  {f.required && touched[f.name] && fieldOk(f) && (
                    <I n="ph-check-circle" w="fill" style={{ color: "var(--h-habits)", marginLeft: 5, fontSize: "var(--fs-sm)" }} />
                  )}
                </label>
                {f.type === "textarea" ? (
                  <textarea
                    id={`mf-${f.name}`}
                    ref={i === 0 ? (firstRef as any) : undefined}
                    value={values[f.name]}
                    placeholder={f.placeholder}
                    aria-invalid={!!err || undefined}
                    onChange={(e) => set(f.name, e.target.value)}
                    onBlur={() => blur(f.name)}
                  />
                ) : f.type === "select" ? (
                  <div className="modal-seg" role="radiogroup" aria-label={f.label}>
                    {f.options?.map((o) => (
                      <button type="button" key={o.value} role="radio" aria-checked={values[f.name] === o.value}
                        className={cx(values[f.name] === o.value && "on")} onClick={() => set(f.name, o.value)}>
                        {o.icon && <I n={o.icon} />} {o.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <input
                    id={`mf-${f.name}`}
                    ref={i === 0 ? (firstRef as any) : undefined}
                    type={f.type === "url" ? "url" : f.type === "datetime-local" ? "datetime-local" : f.type === "date" ? "date" : f.type === "password" ? "password" : "text"}
                    value={values[f.name]}
                    placeholder={f.placeholder}
                    aria-invalid={!!err || undefined}
                    onChange={(e) => set(f.name, e.target.value)}
                    onBlur={() => blur(f.name)}
                  />
                )}
                <AnimatePresence>
                  {err && (
                    <motion.div className="field-err" role="alert"
                      initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                      <I n="ph-warning-circle" /> {err}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
        <div className="modal-foot">
          <Button type="button" onClick={() => onDone(null)}>Cancel</Button>
          <Button type="submit" variant="primary" iconLeft="ph-check" disabled={!valid}>
            {cfg.submitLabel || "Save"}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

function ConfirmModal({ cfg, onDone }: { cfg: ConfirmConfig; onDone: (v: boolean) => void }) {
  const okRef = useRef<HTMLButtonElement | null>(null);

  // Enter confirms (Radix already maps Escape to dismiss).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); onDone(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  return (
    <ModalShell
      mod={cfg.danger ? "var(--danger)" : "var(--accent)"}
      onDismiss={() => onDone(false)}
      onOpenAutoFocus={(e) => { e.preventDefault(); okRef.current?.focus(); }}
    >
      <div className="modal-head">
        <div className="modal-ico"><I n={cfg.icon || (cfg.danger ? "ph-warning" : "ph-question")} w="fill" /></div>
        <Dialog.Title asChild><span className="modal-t">{cfg.title}</span></Dialog.Title>
      </div>
      <div className="modal-body">
        <Dialog.Description asChild><div className="modal-msg">{cfg.message}</div></Dialog.Description>
      </div>
      <div className="modal-foot">
        <Button type="button" onClick={() => onDone(false)}>{cfg.cancelLabel || "Cancel"}</Button>
        <Button
          type="button"
          ref={okRef as any}
          variant={cfg.danger ? "destructive" : "primary"}
          onClick={() => onDone(true)}
        >
          {cfg.confirmLabel || "Confirm"}
        </Button>
      </div>
    </ModalShell>
  );
}
