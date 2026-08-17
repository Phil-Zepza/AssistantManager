import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Accent outline for a chosen / active card. */
  selected?: boolean;
  padding?: CardPadding;
}

const PADDING: Record<CardPadding, string> = {
  none: "p-0",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
};

export function Card({
  selected = false,
  padding = "md",
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg bg-surface shadow-card border",
        selected ? "border-accent ring-1 ring-accent" : "border-subtle",
        PADDING[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
