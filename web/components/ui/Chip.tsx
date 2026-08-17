import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  icon?: ReactNode;
}

/** A compact selectable pill — used for filters (position, presets, etc.). */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { selected = false, icon, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors duration-micro ease-out-soft",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base",
        "disabled:pointer-events-none disabled:opacity-40",
        selected
          ? "border-accent bg-[rgba(22,225,163,0.14)] text-accent"
          : "border-subtle bg-surface text-secondary hover:text-primary",
        "[&>svg]:h-3.5 [&>svg]:w-3.5",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});
