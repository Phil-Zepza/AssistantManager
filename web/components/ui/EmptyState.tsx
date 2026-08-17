import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  title: string;
  /** Supporting copy. `hint` kept as an alias for back-compat. */
  hint?: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  hint,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  const body = description ?? hint;
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-strong bg-surface/60 p-6 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-secondary [&>svg]:h-5 [&>svg]:w-5">
          {icon}
        </div>
      )}
      <p className="font-semibold text-primary">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-sm text-sm text-secondary">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
