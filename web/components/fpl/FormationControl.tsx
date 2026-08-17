"use client";

import { FORMATIONS, type Formation } from "@/lib/pitch";
import { cn } from "@/lib/cn";

export interface FormationControlProps {
  value: Formation;
  onChange: (formation: Formation) => void;
  /** "select" = compact dropdown (mobile); "grid" = button grid (desktop panel). */
  variant?: "select" | "grid";
  className?: string;
}

/** Formation picker. Changing it re-lays and re-validates the XI upstream. */
export function FormationControl({
  value,
  onChange,
  variant = "select",
  className,
}: FormationControlProps) {
  if (variant === "grid") {
    return (
      <div className={cn("grid grid-cols-2 gap-1.5", className)} role="radiogroup" aria-label="Formation">
        {FORMATIONS.map((f) => {
          const active = f === value;
          return (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(f)}
              className={cn(
                "rounded-lg border px-2 py-2 text-sm font-semibold tnum transition-colors duration-micro ease-out-soft",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                active
                  ? "border-accent bg-[rgba(22,225,163,0.14)] text-accent"
                  : "border-subtle bg-surface text-secondary hover:text-primary",
              )}
            >
              {f}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <label className={cn("flex items-center gap-2", className)}>
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">
        Formation
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Formation)}
        aria-label="Formation"
        className="h-9 rounded-lg border border-strong bg-raised px-2.5 text-sm font-semibold tnum text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      >
        {FORMATIONS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </label>
  );
}
