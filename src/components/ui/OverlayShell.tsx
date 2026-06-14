import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import { scrimVariants, modalVariants } from "../../lib/motionVariants";

// Radix-backed chrome shared by every non-form overlay (command palette,
// widget gallery, expanded widget, link picker). Radix supplies the focus
// trap, aria-modal, Escape and backdrop dismissal; framer-motion animates
// scrim and panel separately. Render inside <AnimatePresence> at the call
// site so the exit animation plays.
export function OverlayShell({ onClose, title, align = "center", children }: {
  onClose: () => void;
  /** Accessible dialog name (visually hidden). */
  title: string;
  align?: "center" | "top";
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal forceMount>
        <Dialog.Overlay asChild forceMount>
          <motion.div className="overlay-scrim" variants={scrimVariants} initial="initial" animate="enter" exit="exit" />
        </Dialog.Overlay>
        <Dialog.Content asChild forceMount aria-describedby={undefined}>
          <motion.div
            className={align === "top" ? "overlay-wrap top" : "overlay-wrap"}
            variants={modalVariants} initial="initial" animate="enter" exit="exit"
          >
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            {children}
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
