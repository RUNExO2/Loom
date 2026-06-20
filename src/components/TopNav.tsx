/**
 * TopNav — Pill Navigation Bar
 *
 * Consumes the EXACT SAME navGroups data as the sidebar. Navigation logic,
 * routes, badges, dots, and "soon" states are all identical. Only the
 * presentation structure differs.
 *
 * Rendered inside a horizontal scrollable pill bar below the titlebar.
 * Active pill has accent background + glow. Badges appear as superscript bubbles.
 */

import React from "react";
import { motion } from "framer-motion";
import { I, cx, ToastAction } from "../lib/context";
import { NavGroupLive } from "../lib/stats";

interface TopNavProps {
  navGroups: NavGroupLive[];
  view: string;
  navigate: (id: string) => void;
  // Accept App.tsx's toast exactly as-is; using any for kind avoids
  // TypeScript function-parameter contravariance between duplicate ToastKind types.
  toast: (msg: string, icon?: string, action?: ToastAction, kind?: any) => void;
}

const springBase = { type: "spring" as const, stiffness: 500, damping: 40, mass: 0.8 };

export function TopNav({ navGroups, view, navigate, toast }: TopNavProps) {
  const innerRef = React.useRef<HTMLDivElement>(null);

  // Vertical mouse wheel scrolls the pill row horizontally, so every nav item is
  // reachable on screens too narrow to fit them all (no trackpad needed). Attached
  // as a non-passive listener so preventDefault can stop the page from also moving.
  React.useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active pill visible even when it lives in the overflow.
  React.useEffect(() => {
    innerRef.current
      ?.querySelector<HTMLElement>(".top-pill.active")
      ?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [view]);

  return (
    <nav
      className="tb-top-nav"
      aria-label="Main navigation"
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const els = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>(".top-pill")
        );
        const idx = els.indexOf(document.activeElement as HTMLButtonElement);
        if (idx === -1) return;
        e.preventDefault();
        els[(idx + (e.key === "ArrowRight" ? 1 : els.length - 1)) % els.length]?.focus();
      }}
    >
      <div className="tb-top-nav-inner" ref={innerRef}>
        {navGroups.map((group, gi) => (
          <div key={group.group} className="top-nav-group">
            {/* Group separator (not shown for the first group) */}
            {gi > 0 && <span className="top-nav-sep" aria-hidden />}
            {group.items.map((item) => {
              const isActive = view === item.id;
              return (
                <button
                  key={item.id}
                  id={`topnav-${item.id}`}
                  className={cx(
                    "top-pill",
                    isActive && "active",
                    item.soon && "soon"
                  )}
                  style={{ "--mod": item.mod } as React.CSSProperties}
                  onClick={() =>
                    item.soon
                      ? toast(
                          `${item.label} is coming soon.`,
                          "ph-hourglass-medium",
                          undefined,
                          "info"
                        )
                      : navigate(item.id)
                  }
                  title={
                    item.soon ? `${item.label} — coming soon` : item.label
                  }
                  aria-current={isActive ? "page" : undefined}
                  aria-disabled={item.soon || undefined}
                >
                  {isActive && (
                    <motion.span
                      layoutId="top-nav-active-ind"
                      className="top-pill-bg"
                      transition={springBase}
                      aria-hidden
                    />
                  )}
                  <span className="top-pill-ico">
                    <I n={item.icon} w={isActive ? "fill" : "regular"} />
                  </span>
                  <span className="top-pill-label">{item.label}</span>
                  {!item.soon && item.badgeValue != null && item.badgeValue > 0 && (
                    <span className="top-pill-badge">{item.badgeValue}</span>
                  )}
                  {!item.soon && item.dot && (
                    <span className="top-pill-dot" aria-hidden />
                  )}
                  {item.soon && (
                    <span className="top-pill-soon">Soon</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
