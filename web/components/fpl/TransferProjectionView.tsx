import { ArrowRight } from "lucide-react";
import { Badge, ClubBadge } from "@/components/ui";
import {
  formatEp,
  formatPrice,
  formatSignedEp,
  formatSignedPrice,
} from "@/lib/format";
import type { TransferProjection } from "@/lib/projections";
import { cn } from "@/lib/cn";

export interface TransferProjectionViewProps {
  projection: TransferProjection;
  /** Show the FPL-app reminder caption under the projection. */
  caption?: boolean;
  className?: string;
}

/**
 * Read-only out → in transfer projection: two club badges, the projected EP
 * swing, price delta, and free-transfer-vs-hit net. Simulates only — the user
 * makes any real transfer in the FPL app.
 */
export function TransferProjectionView({
  projection,
  caption = true,
  className,
}: TransferProjectionViewProps) {
  const { out, in: incoming, epSwing, costDelta, netFree, netHit } = projection;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center gap-2">
        <PlayerChip
          code={out.team?.short_name}
          name={out.player.web_name}
          sub={formatPrice(out.player.price)}
          tone="out"
        />
        <ArrowRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <PlayerChip
          code={incoming.team?.short_name}
          name={incoming.player.web_name}
          sub={formatPrice(incoming.player.price)}
          tone="in"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge tone={swingTone(epSwing)}>{formatSignedEp(epSwing)} xPts</Badge>
        <Badge tone="gray">{formatSignedPrice(costDelta)}</Badge>
        <Badge tone={netTone(netFree)}>
          Free: {formatSignedEp(netFree)} net
        </Badge>
        <Badge tone={netTone(netHit)}>
          −4 hit: {formatSignedEp(netHit)} net
        </Badge>
      </div>

      {caption && (
        <p className="text-xs text-muted">
          You&apos;ll make this transfer in the FPL app — this is a projection,
          nothing here changes your team.
        </p>
      )}
    </div>
  );
}

function swingTone(swing: number | null): "success" | "danger" | "gray" {
  if (swing == null) return "gray";
  return swing > 0 ? "success" : swing < 0 ? "danger" : "gray";
}

function netTone(net: number | null): "success" | "danger" | "gray" {
  if (net == null) return "gray";
  return net > 0 ? "success" : net < 0 ? "danger" : "gray";
}

function PlayerChip({
  code,
  name,
  sub,
  tone,
}: {
  code: string | null | undefined;
  name: string;
  sub: string;
  tone: "out" | "in";
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-subtle bg-surface px-2.5 py-2">
      <ClubBadge code={code} size={24} state={tone === "out" ? "out" : "default"} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-primary">{name}</p>
        <p className="text-[11px] uppercase tracking-wide text-muted">
          {tone === "out" ? "Out" : "In"} · {sub}
        </p>
      </div>
    </div>
  );
}
