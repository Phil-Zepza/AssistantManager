import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

// New tones per the design system, plus legacy aliases (green/red/amber/purple)
// so pre-existing call sites keep compiling during the dark-theme migration.
export type BadgeTone =
  | "gray"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "green"
  | "red"
  | "amber"
  | "purple";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children: ReactNode;
}

const TONES: Record<BadgeTone, string> = {
  gray: "bg-[rgba(255,255,255,0.06)] text-secondary",
  accent: "bg-[rgba(22,225,163,0.14)] text-accent",
  success: "bg-[rgba(34,197,94,0.15)] text-success",
  warning: "bg-[rgba(245,180,0,0.16)] text-warning",
  danger: "bg-[rgba(244,63,94,0.15)] text-danger",
  info: "bg-[rgba(59,158,255,0.15)] text-info",
  // Legacy aliases.
  green: "bg-[rgba(34,197,94,0.15)] text-success",
  red: "bg-[rgba(244,63,94,0.15)] text-danger",
  amber: "bg-[rgba(245,180,0,0.16)] text-warning",
  purple: "bg-[rgba(185,139,255,0.16)] text-[#c7abff]",
};

export function Badge({
  tone = "gray",
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
