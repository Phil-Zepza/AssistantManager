import type { CSSProperties } from "react";
import { Clock, Lock } from "lucide-react";
import { clubTheme } from "@/lib/clubTheme";
import { cn } from "@/lib/cn";

export type ClubBadgeSize = 24 | 32 | 44 | 64;
export type ClubBadgeState =
  | "default"
  | "used"
  | "recommended"
  | "reserved"
  | "out";

export interface ClubBadgeProps {
  /** teams.short_name (3-letter code). */
  code: string | null | undefined;
  size?: ClubBadgeSize;
  state?: ClubBadgeState;
  /** Custom ring colour — overrides the state ring. */
  ring?: string;
  className?: string;
  title?: string;
}

const SIZES: Record<
  ClubBadgeSize,
  { font: number; ring: number; chip: number; icon: number; underline: number }
> = {
  24: { font: 9, ring: 1.5, chip: 11, icon: 7, underline: 2 },
  32: { font: 11, ring: 2, chip: 14, icon: 9, underline: 2 },
  44: { font: 13, ring: 2, chip: 18, icon: 11, underline: 3 },
  64: { font: 18, ring: 2.5, chip: 24, icon: 14, underline: 3 },
};

const HAIRLINE = "inset 0 0 0 1px rgba(255,255,255,0.12)";

/**
 * Circular club badge: primary fill, thin secondary underline, 3-letter code
 * in the on-primary colour. States add rings + a status chip. Colours come from
 * lib/clubTheme (keyed off teams.short_name) — never hard-coded here.
 */
export function ClubBadge({
  code,
  size = 32,
  state = "default",
  ring,
  className,
  title,
}: ClubBadgeProps) {
  const theme = clubTheme(code);
  const label = (code ?? "").slice(0, 3).toUpperCase() || "—";
  const s = SIZES[size];
  const used = state === "used";

  let boxShadow = HAIRLINE;
  if (ring) {
    boxShadow = `0 0 0 ${s.ring}px ${ring}`;
  } else if (state === "recommended") {
    boxShadow = `0 0 0 ${s.ring}px var(--accent), 0 0 0 ${s.ring + 4}px rgba(22,225,163,0.28)`;
  } else if (state === "reserved") {
    boxShadow = `0 0 0 ${s.ring}px var(--warning)`;
  } else if (state === "out") {
    boxShadow = `0 0 0 ${s.ring}px var(--danger)`;
  }

  const style: CSSProperties = {
    width: size,
    height: size,
    background: theme.primary,
    color: theme.text,
    boxShadow,
    filter: used ? "grayscale(1)" : undefined,
    opacity: used ? 0.75 : 1,
  };

  const overlay =
    state === "used" ? "used" : state === "reserved" ? "reserved" : null;

  return (
    <span
      className={cn(
        "relative inline-grid shrink-0 place-items-center rounded-full",
        className,
      )}
      style={style}
      role="img"
      aria-label={
        title ?? `${label}${state !== "default" ? ` (${state})` : ""}`
      }
      title={title}
    >
      <span
        className="font-extrabold leading-none tracking-tight"
        style={{ fontSize: s.font }}
      >
        {label}
      </span>
      <span
        className="pointer-events-none absolute rounded-full"
        style={{
          bottom: Math.round(size * 0.16),
          height: s.underline,
          width: Math.round(size * 0.42),
          background: theme.secondary,
          opacity: 0.9,
        }}
        aria-hidden
      />
      {overlay && (
        <span
          className="absolute grid place-items-center rounded-full"
          style={{
            right: -2,
            bottom: -2,
            width: s.chip,
            height: s.chip,
            background:
              overlay === "reserved" ? "var(--warning)" : "var(--surface-2)",
            color:
              overlay === "reserved"
                ? "var(--on-warning)"
                : "var(--text-primary)",
            boxShadow: "0 0 0 2px var(--bg-base)",
          }}
          aria-hidden
        >
          {overlay === "reserved" ? (
            <Clock size={s.icon} />
          ) : (
            <Lock size={s.icon} />
          )}
        </span>
      )}
    </span>
  );
}
