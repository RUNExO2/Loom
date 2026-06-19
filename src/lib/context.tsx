import React, { createContext, useContext } from "react";
import { ThemePref, NavStyle } from "./settings";

export interface ToastAction { label: string; onClick: () => void; }
export type ToastKind = "success" | "error" | "warning" | "info";
export interface LoomContextType {
  navigate: (view: string) => void;
  inspect: (id: string) => void;
  toast: (msg: string, icon?: string, action?: ToastAction, kind?: ToastKind) => void;
  openPalette: () => void;
  editDash: () => void;
  showShortcuts: () => void;
  toggleTheme: () => void;
  themePref: ThemePref;
  setTheme: (p: ThemePref) => void;
  accent: string;
  setAccent: (a: string) => void;
  dragTargetId: string | null;
  setDragTargetId: (id: string | null) => void;
  navStyle: NavStyle;
  setNavStyle: (style: NavStyle) => void;
}

export const LoomCtx = createContext<LoomContextType | null>(null);
export const useLoom = () => {
  const ctx = useContext(LoomCtx);
  if (!ctx) throw new Error("useLoom must be used within LoomCtx.Provider");
  return ctx;
};

export function cx(...args: (string | boolean | undefined | null)[]): string {
  return args.filter(Boolean).join(" ");
}

// Make a div/section behave like a button for keyboard users: role + tab stop +
// Enter/Space activation. Spread onto any clickable non-button element.
export function clickable(onActivate: () => void): {
  role: "button"; tabIndex: 0; onKeyDown: (e: React.KeyboardEvent) => void;
} {
  return {
    role: "button",
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
        e.preventDefault();
        onActivate();
      }
    },
  };
}

export function I({ n, w, style }: { n: string; w?: "fill" | "bold" | "regular"; style?: React.CSSProperties }) {
  const cls = w === "fill" ? "ph-fill" : w === "bold" ? "ph-bold" : "ph";
  return <i className={cx(cls, n)} style={style} aria-hidden="true"></i>;
}
