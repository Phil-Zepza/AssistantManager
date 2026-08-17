"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  Badge,
  BottomSheet,
  Button,
  Card,
  ClubBadge,
} from "@/components/ui";
import {
  formatEp,
  formatPrice,
  formatSignedEp,
  formatSignedPrice,
} from "@/lib/format";
import type { TransferProjection } from "@/lib/projections";
import { TransferProjectionView } from "./TransferProjectionView";

export interface DashboardTransferCardProps {
  projection: TransferProjection;
}

/**
 * "Best transfer" — the single highest-swing like-for-like move, framed as a
 * projection. The primary action opens the detail; the actual transfer is made
 * in the FPL app. Nothing here mutates the squad.
 */
export function DashboardTransferCard({ projection }: DashboardTransferCardProps) {
  const [open, setOpen] = useState(false);
  const { out, in: incoming, epSwing, costDelta, netHit } = projection;

  return (
    <>
      <Card className="mb-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
          Best transfer
        </p>

        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ClubBadge code={out.team?.short_name} size={32} state="out" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-primary">
                {out.player.web_name}
              </p>
              <p className="text-[11px] uppercase tracking-wide text-muted">
                Out · {formatPrice(out.player.price)}
              </p>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ClubBadge code={incoming.team?.short_name} size={32} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-primary">
                {incoming.player.web_name}
              </p>
              <p className="text-[11px] uppercase tracking-wide text-muted">
                In · {formatPrice(incoming.player.price)}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone={epSwing != null && epSwing > 0 ? "success" : "gray"}>
            {formatSignedEp(epSwing)} xPts
          </Badge>
          <Badge tone="warning">−4 hit</Badge>
          <Badge tone={netHit != null && netHit > 0 ? "success" : "danger"}>
            {formatSignedEp(netHit)} net
          </Badge>
          <Badge tone="gray">{formatSignedPrice(costDelta)}</Badge>
        </div>

        <div className="mt-3">
          <Button onClick={() => setOpen(true)} iconRight={<ArrowRight />}>
            See transfer
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">Make this in the FPL app.</p>
      </Card>

      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Transfer projection"
      >
        <p className="mb-3 text-sm text-secondary">
          Projected one-gameweek swing from this like-for-like move. Base EP:{" "}
          {formatEp(out.expected_points)} → {formatEp(incoming.expected_points)}.
        </p>
        <TransferProjectionView projection={projection} />
      </BottomSheet>
    </>
  );
}
