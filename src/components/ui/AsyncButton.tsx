import React from "react";
import { I, cx } from "../../lib/context";
import { useInteraction } from "../../lib/useInteraction";

interface AsyncButtonProps {
  onClick: () => Promise<any>;
  children: React.ReactNode;
  className?: string;
  icon?: string;                  // idle-state leading icon
  loadingLabel?: React.ReactNode; // label shown while loading (falls back to children)
  title?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  "aria-label"?: string;
}

// A button whose async onClick has a visible lifecycle: a spinner + optional label
// while loading (disabled to block double-fire), a brief check on success, a warning
// icon on error. Built on useInteraction so the feedback is identical everywhere —
// every async action becomes intent-aware instead of silently pending.
export function AsyncButton({
  onClick, children, className, icon, loadingLabel, title, disabled, style, ...rest
}: AsyncButtonProps) {
  const { state, isLoading, run } = useInteraction();
  const leadingIcon =
    state === "loading" ? "ph-spinner ph-spin"
    : state === "success" ? "ph-check"
    : state === "error" ? "ph-warning"
    : icon;
  return (
    <button
      className={cx(className, isLoading && "is-loading", state === "error" && "is-error", state === "success" && "is-success")}
      title={title}
      disabled={disabled || isLoading}
      aria-busy={isLoading}
      aria-label={rest["aria-label"]}
      style={style}
      onClick={() => { void run(onClick); }}
    >
      {leadingIcon && <I n={leadingIcon} />} {isLoading && loadingLabel ? loadingLabel : children}
    </button>
  );
}
