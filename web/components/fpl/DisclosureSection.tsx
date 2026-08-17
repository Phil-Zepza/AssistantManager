"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export interface DisclosureSectionProps {
  title: ReactNode;
  /** Small trailing summary shown on the header row (e.g. a projected value). */
  summary?: ReactNode;
  icon?: ReactNode;
  defaultOpen?: boolean;
  /** Visually emphasise as the primary section. */
  primary?: boolean;
  children: ReactNode;
}

/** A lightweight, accessible expand/collapse row used inside the sheets. */
export function DisclosureSection({
  title,
  summary,
  icon,
  defaultOpen = false,
  primary = false,
  children,
}: DisclosureSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border",
        primary ? "border-hot/50 bg-[rgba(255,45,120,0.05)]" : "border-subtle bg-surface",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 px-3.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {icon && (
          <span
            className={cn("shrink-0", primary ? "text-hot" : "text-secondary")}
            aria-hidden
          >
            {icon}
          </span>
        )}
        <span className="flex-1 text-sm font-semibold text-primary">{title}</span>
        {summary != null && (
          <span className="text-sm font-semibold tnum text-secondary">
            {summary}
          </span>
        )}
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted transition-transform duration-micro ease-out-soft",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open && (
        <div id={panelId} className="border-t border-subtle px-3.5 py-3">
          {children}
        </div>
      )}
    </div>
  );
}
