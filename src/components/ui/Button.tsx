import React from "react";
import { motion } from "framer-motion";
import { buttonTap, springFast } from "../../lib/motionVariants";
import { I, cx } from "../../lib/context";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg";

type MotionButtonProps = React.ComponentProps<typeof motion.button>;
export interface ButtonProps extends Omit<MotionButtonProps, "children"> {
  variant?: Variant;
  size?: Size;
  /** Replaces the label with a spinner, disables the button, keeps its width. */
  loading?: boolean;
  iconLeft?: string;
  iconRight?: string;
  /** Icon-only button — pass aria-label alongside. */
  iconOnly?: string;
  children?: React.ReactNode;
}

const VARIANT_CLASS: Record<Variant, string | false> = {
  primary: "primary",
  secondary: false,
  ghost: "ghost",
  destructive: "danger-solid",
};

export function Button({
  variant = "secondary", size = "md", loading = false,
  iconLeft, iconRight, iconOnly, className, children, disabled, ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <motion.button
      whileTap={isDisabled ? undefined : buttonTap}
      transition={springFast}
      className={cx(
        "btn",
        VARIANT_CLASS[variant],
        size === "sm" && "sm",
        size === "lg" && "lg",
        !!iconOnly && "icon",
        loading && "loading",
        typeof className === "string" ? className : undefined,
      )}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      <span className="btn-label">
        {iconOnly
          ? <I n={iconOnly} />
          : <>{iconLeft && <I n={iconLeft} />}{children}{iconRight && <I n={iconRight} />}</>}
      </span>
      {loading && (
        <span className="btn-spinner" aria-hidden>
          <I n="ph-circle-notch" w="bold" />
        </span>
      )}
    </motion.button>
  );
}
