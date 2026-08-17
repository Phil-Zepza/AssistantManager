import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SectionTitleProps {
  children: ReactNode;
  /** Optional trailing slot (link / action) aligned to the right. */
  right?: ReactNode;
  className?: string;
}

export function SectionTitle({ children, right, className }: SectionTitleProps) {
  return (
    <div className={cn("mb-2 mt-6 flex items-center justify-between", className)}>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
        {children}
      </h2>
      {right}
    </div>
  );
}
