import type { ReactNode } from "react";
import { Info, CircleCheck, TriangleAlert, OctagonAlert } from "lucide-react";
import { cn } from "@/lib/cn";

export type CalloutTone = "info" | "success" | "warning" | "danger";

export interface CalloutProps {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Override the default tone icon. */
  icon?: ReactNode;
  className?: string;
}

const TONE: Record<
  CalloutTone,
  { wrap: string; icon: string; Icon: typeof Info }
> = {
  info: {
    wrap: "border-[rgba(59,158,255,0.40)] bg-[rgba(59,158,255,0.10)]",
    icon: "text-info",
    Icon: Info,
  },
  success: {
    wrap: "border-[rgba(34,197,94,0.40)] bg-[rgba(34,197,94,0.10)]",
    icon: "text-success",
    Icon: CircleCheck,
  },
  warning: {
    wrap: "border-[rgba(245,180,0,0.40)] bg-[rgba(245,180,0,0.10)]",
    icon: "text-warning",
    Icon: TriangleAlert,
  },
  danger: {
    wrap: "border-[rgba(244,63,94,0.40)] bg-[rgba(244,63,94,0.10)]",
    icon: "text-danger",
    Icon: OctagonAlert,
  },
};

export function Callout({
  tone = "info",
  title,
  children,
  icon,
  className,
}: CalloutProps) {
  const t = TONE[tone];
  const Icon = t.Icon;
  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg border p-3.5",
        t.wrap,
        className,
      )}
      role="note"
    >
      <span className={cn("mt-0.5 shrink-0", t.icon)} aria-hidden>
        {icon ?? <Icon className="h-5 w-5" />}
      </span>
      <div className="min-w-0 text-sm">
        {title && <p className="font-semibold text-primary">{title}</p>}
        {children && (
          <div className={cn("text-secondary", !!title && "mt-0.5")}>{children}</div>
        )}
      </div>
    </div>
  );
}
