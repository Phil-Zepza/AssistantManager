import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type StatEmphasis = "none" | "accent" | "hot";
export type StatSize = "sm" | "md" | "lg";
export type StatAlign = "left" | "center" | "right";

export interface StatBlockProps {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  emphasis?: StatEmphasis;
  size?: StatSize;
  align?: StatAlign;
  className?: string;
}

const VALUE_SIZE: Record<StatSize, string> = {
  sm: "text-lg",
  md: "text-2xl",
  lg: "text-3xl",
};

const EMPHASIS: Record<StatEmphasis, string> = {
  none: "text-primary",
  accent: "text-accent",
  hot: "text-hot",
};

const ALIGN: Record<StatAlign, string> = {
  left: "items-start text-left",
  center: "items-center text-center",
  right: "items-end text-right",
};

/** A labelled numeric readout (price, points, %, budget). Numbers are tabular. */
export function StatBlock({
  label,
  value,
  unit,
  emphasis = "none",
  size = "md",
  align = "left",
  className,
}: StatBlockProps) {
  return (
    <div className={cn("flex flex-col", ALIGN[align], className)}>
      <div className="flex items-baseline gap-1">
        <span
          className={cn("font-bold leading-none tnum", VALUE_SIZE[size], EMPHASIS[emphasis])}
        >
          {value}
        </span>
        {unit != null && (
          <span className="text-xs font-medium text-muted">{unit}</span>
        )}
      </div>
      <span className="mt-1 text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
    </div>
  );
}
