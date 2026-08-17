"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface CountdownProps {
  deadline: string | Date | null | undefined;
  className?: string;
  prefix?: ReactNode;
  /** Shown once the deadline has passed. */
  passedLabel?: string;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Live countdown to a deadline. Turns `--accent-2` (hot) inside 6h. Numbers are
 * tabular. Renders a stable placeholder until mounted to avoid hydration drift.
 */
export function Countdown({
  deadline,
  className,
  prefix,
  passedLabel = "Deadline passed",
}: CountdownProps) {
  const target = deadline ? new Date(deadline).getTime() : null;
  const invalid = target == null || Number.isNaN(target);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (invalid) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [invalid, target]);

  if (invalid) {
    return <span className={cn("tnum text-muted", className)}>—</span>;
  }

  if (now == null) {
    return (
      <span
        className={cn("tnum text-secondary", className)}
        suppressHydrationWarning
      >
        {prefix}
        ··:··:··
      </span>
    );
  }

  const ms = (target as number) - now;
  if (ms <= 0) {
    return <span className={cn("tnum text-muted", className)}>{passedLabel}</span>;
  }

  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const urgent = ms <= SIX_HOURS_MS;

  return (
    <span
      className={cn(
        "tnum font-semibold",
        urgent ? "text-hot" : "text-primary",
        className,
      )}
      aria-label="Time until deadline"
    >
      {prefix}
      {days > 0
        ? `${days}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`
        : `${pad(hours)}:${pad(mins)}:${pad(secs)}`}
    </span>
  );
}
