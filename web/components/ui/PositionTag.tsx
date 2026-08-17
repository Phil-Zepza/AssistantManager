import { cn } from "@/lib/cn";
import type { Position } from "@/lib/types";

export type PositionTagSize = "sm" | "md";

export interface PositionTagProps {
  pos: Position;
  size?: PositionTagSize;
  className?: string;
}

// Tinted background (literal rgba of the --pos-* token) + solid token text.
const POS_STYLE: Record<Position, string> = {
  GK: "bg-[rgba(234,179,8,0.16)] text-pos-gk",
  DEF: "bg-[rgba(20,184,166,0.16)] text-pos-def",
  MID: "bg-[rgba(99,102,241,0.18)] text-pos-mid",
  FWD: "bg-[rgba(236,72,153,0.16)] text-pos-fwd",
};

const SIZE: Record<PositionTagSize, string> = {
  sm: "h-5 min-w-[2.25rem] px-1.5 text-[10px]",
  md: "h-6 min-w-[2.5rem] px-2 text-xs",
};

/** Position pill (GK/DEF/MID/FWD) coloured from the --pos-* tokens. */
export function PositionTag({ pos, size = "md", className }: PositionTagProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-md font-bold uppercase tracking-wide",
        POS_STYLE[pos],
        SIZE[size],
        className,
      )}
    >
      {pos}
    </span>
  );
}

/** Alias kept for canvases that call it PositionBadge. */
export const PositionBadge = PositionTag;
