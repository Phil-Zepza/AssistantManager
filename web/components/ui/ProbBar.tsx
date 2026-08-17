import { cn } from "@/lib/cn";
import { formatPct } from "@/lib/format";

export interface ProbBarProps {
  /** Win probability (backed / home team). */
  home: number | null | undefined;
  /** Draw probability. */
  draw: number | null | undefined;
  /** Loss probability (away team). */
  away: number | null | undefined;
  /** Show a small H / D / A legend row with percentages. */
  showLabels?: boolean;
  className?: string;
}

function seg(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Stacked win / draw / loss probability bar. Segments are normalised so they
 * always fill the track even when the three probabilities don't sum to 1.
 */
export function ProbBar({ home, draw, away, showLabels, className }: ProbBarProps) {
  const h = seg(home);
  const d = seg(draw);
  const a = seg(away);
  const total = h + d + a;

  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);

  return (
    <div className={cn("w-full", className)}>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-surface-2"
        role="img"
        aria-label={`Win ${formatPct(total > 0 ? h / total : null)}, draw ${formatPct(
          total > 0 ? d / total : null,
        )}, loss ${formatPct(total > 0 ? a / total : null)}`}
      >
        <span className="h-full bg-accent" style={{ width: `${pct(h)}%` }} />
        <span className="h-full bg-strong" style={{ width: `${pct(d)}%` }} />
        <span className="h-full bg-danger" style={{ width: `${pct(a)}%` }} />
      </div>
      {showLabels && (
        <div className="mt-1.5 flex justify-between text-[11px] font-medium tnum">
          <span className="text-accent">W {formatPct(total > 0 ? h / total : null)}</span>
          <span className="text-secondary">D {formatPct(total > 0 ? d / total : null)}</span>
          <span className="text-danger">L {formatPct(total > 0 ? a / total : null)}</span>
        </div>
      )}
    </div>
  );
}
