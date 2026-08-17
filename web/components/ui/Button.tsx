import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (e.g. a Lucide element). */
  icon?: ReactNode;
  /** Trailing icon. */
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-press",
  secondary: "bg-surface-2 text-primary border border-strong hover:bg-surface",
  ghost: "bg-transparent text-secondary hover:bg-surface hover:text-primary",
  danger: "bg-danger text-white hover:brightness-110",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-md px-3 text-xs",
  md: "h-10 gap-2 rounded-lg px-4 text-sm",
  lg: "h-12 gap-2 rounded-lg px-5 text-base",
};

const ICON = "inline-flex shrink-0 items-center [&>svg]:h-[1.15em] [&>svg]:w-[1.15em]";

/**
 * Presentational button. Neutral by default so it can also be used inside
 * server components (e.g. a form submit) — pass handlers from a client parent.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    icon,
    iconRight,
    fullWidth,
    className,
    children,
    type,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap font-semibold transition-colors duration-micro ease-out-soft",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {icon != null && (
        <span className={ICON} aria-hidden>
          {icon}
        </span>
      )}
      {children}
      {iconRight != null && (
        <span className={ICON} aria-hidden>
          {iconRight}
        </span>
      )}
    </button>
  );
});
