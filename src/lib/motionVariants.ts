// ── LOOM motion system ──────────────────────────────────────────────────────────
// Single source of truth for Framer Motion presets. Components import these —
// no one-off motion props. Reduced motion is handled globally by
// <MotionConfig reducedMotion="user"> in main.tsx (transform/layout animations
// become instant) plus the prefers-reduced-motion media block in index.css for
// the CSS keyframe animations. Max duration anywhere: 400ms.

import type { Variants, Transition } from "framer-motion";

// Springs (preferred over linear easing)
export const springFast: Transition = { type: "spring", stiffness: 520, damping: 34, mass: 0.7 };
export const springBase: Transition = { type: "spring", stiffness: 400, damping: 30 };
export const springSoft: Transition = { type: "spring", stiffness: 260, damping: 26 };

// Route/page transitions: fade + y(8→0), 250ms enter
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  enter: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12, ease: "easeIn" } },
};

// List containers stagger their children by 40ms
export const listStagger: Variants = {
  initial: {},
  enter: { transition: { staggerChildren: 0.04 } },
};
export const listItem: Variants = {
  initial: { opacity: 0, y: 6 },
  enter: { opacity: 1, y: 0, transition: springBase },
};

// Modal / drawer (layered on Radix Dialog)
export const scrimVariants: Variants = {
  initial: { opacity: 0 },
  enter: { opacity: 1, transition: { duration: 0.16 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};
export const modalVariants: Variants = {
  initial: { opacity: 0, y: 16, scale: 0.97 },
  enter: { opacity: 1, y: 0, scale: 1, transition: springBase },
  exit: { opacity: 0, y: 8, scale: 0.985, transition: { duration: 0.14, ease: "easeIn" } },
};

// Toast entry from bottom-right, exit slide out
export const toastVariants: Variants = {
  initial: { opacity: 0, x: 48, scale: 0.97 },
  enter: { opacity: 1, x: 0, scale: 1, transition: springBase },
  exit: { opacity: 0, x: 56, transition: { duration: 0.18, ease: "easeIn" } },
};

// Interactive element presets
export const cardHover = { y: -2 };
export const cardTap = { scale: 0.98 };
export const buttonTap = { scale: 0.97 };
