import { StatBlock } from "@/components/ui";
import { formatPrice } from "@/lib/format";
import { BUDGET_CAP_TENTHS, SQUAD_SIZE } from "@/lib/squad";
import { cn } from "@/lib/cn";

export interface BudgetBarProps {
  /** Total squad value in tenths of a million. */
  value: number;
  /** Number of players currently picked. */
  count: number;
  className?: string;
}

/**
 * Persistent budget bar for the planner: budget remaining (danger when
 * negative), squad value, and fill progress. Budget is a soft cap — you can
 * plan over it, but it reads as danger so it's obvious.
 */
export function BudgetBar({ value, count, className }: BudgetBarProps) {
  const remaining = BUDGET_CAP_TENTHS - value;
  const over = remaining < 0;
  const full = count === SQUAD_SIZE;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border border-subtle bg-surface px-4 py-3",
        className,
      )}
    >
      {/* Budget remaining — rendered manually so it can go danger-red. */}
      <div className="flex flex-col">
        <span
          className={cn(
            "text-3xl font-bold leading-none tnum",
            over ? "text-danger" : "text-accent",
          )}
        >
          {over ? "−" : ""}
          {formatPrice(Math.abs(remaining))}
        </span>
        <span className="mt-1 text-xs font-medium uppercase tracking-wide text-muted">
          Budget remaining
        </span>
      </div>
      <StatBlock
        label="Squad value"
        value={formatPrice(value)}
        size="md"
        align="center"
      />
      <StatBlock
        label="Filled"
        value={`${count}/${SQUAD_SIZE}`}
        size="md"
        align="right"
        emphasis={full ? "accent" : "none"}
      />
    </div>
  );
}
