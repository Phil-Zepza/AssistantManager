"use client";

import { Plus } from "lucide-react";
import { ClubBadge } from "@/components/ui";
import { formatPrice } from "@/lib/format";
import { PITCH_ROWS } from "@/lib/pitch";
import type { Position, SquadEntry } from "@/lib/types";
import { cn } from "@/lib/cn";

// A slot on the pitch / bench: either a picked player or an empty "add" token.
export type PitchSlot =
  | { kind: "filled"; entry: SquadEntry; isCaptain: boolean }
  | { kind: "empty"; position: Position };

export interface PitchRow {
  position: Position;
  slots: PitchSlot[];
}

export interface PitchProps {
  rows: PitchRow[];
  bench: PitchSlot[];
  onSelectPlayer: (entry: SquadEntry) => void;
  onAddSlot: (position: Position) => void;
}

/** The green pitch: GK/DEF/MID/FWD rows for the current formation + a bench. */
export function Pitch({ rows, bench, onSelectPlayer, onAddSlot }: PitchProps) {
  return (
    <div>
      <div
        className="relative overflow-hidden rounded-xl border border-subtle px-2 py-4 sm:px-4"
        style={{
          background:
            "linear-gradient(to bottom, var(--pitch-top), var(--pitch-bottom))",
        }}
      >
        <PitchMarkings />
        <div className="relative flex flex-col gap-3 sm:gap-5">
          {rows.map((row) => (
            <div
              key={row.position}
              className="flex items-start justify-center gap-1.5 sm:gap-3"
            >
              {row.slots.map((slot, i) => (
                <SlotView
                  key={slotKey(slot, row.position, i)}
                  slot={slot}
                  onSelectPlayer={onSelectPlayer}
                  onAddSlot={onAddSlot}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* bench strip */}
      <div className="mt-2 rounded-xl border border-subtle bg-raised px-2 py-2.5 sm:px-4">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Bench
          </span>
          <span className="h-px flex-1 bg-subtle" />
        </div>
        <div className="flex items-start justify-center gap-1.5 sm:gap-3">
          {bench.map((slot, i) => (
            <SlotView
              key={slotKey(slot, "BENCH", i)}
              slot={slot}
              onSelectPlayer={onSelectPlayer}
              onAddSlot={onAddSlot}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function slotKey(slot: PitchSlot, group: string, i: number): string {
  return slot.kind === "filled"
    ? `f-${slot.entry.player.fpl_id}`
    : `e-${group}-${slot.position}-${i}`;
}

const POS_RING: Record<Position, string> = {
  GK: "var(--pos-gk)",
  DEF: "var(--pos-def)",
  MID: "var(--pos-mid)",
  FWD: "var(--pos-fwd)",
};

function SlotView({
  slot,
  onSelectPlayer,
  onAddSlot,
}: {
  slot: PitchSlot;
  onSelectPlayer: (entry: SquadEntry) => void;
  onAddSlot: (position: Position) => void;
}) {
  if (slot.kind === "empty") {
    return (
      <button
        type="button"
        onClick={() => onAddSlot(slot.position)}
        className="flex w-[4.25rem] flex-col items-center gap-1 focus-visible:outline-none sm:w-20"
        aria-label={`Add ${slot.position}`}
      >
        <span className="grid h-11 w-11 place-items-center rounded-full border-2 border-dashed border-white/45 text-white/70 transition-colors hover:border-white/80 hover:text-white">
          <Plus className="h-5 w-5" aria-hidden />
        </span>
        <span className="rounded bg-black/25 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/85">
          Add {slot.position}
        </span>
      </button>
    );
  }

  const { entry, isCaptain } = slot;
  const p = entry.player;
  return (
    <button
      type="button"
      onClick={() => onSelectPlayer(entry)}
      className="flex w-[4.25rem] flex-col items-center gap-1 focus-visible:outline-none sm:w-20"
      aria-label={`${p.web_name}${isCaptain ? ", suggested captain" : ""} — options`}
    >
      <span className="relative">
        <ClubBadge code={entry.team?.short_name} size={44} ring={POS_RING[p.position]} />
        {isCaptain && (
          <span
            className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full text-[11px] font-black text-white ring-2 ring-black/30"
            style={{ background: "var(--accent-2)" }}
            aria-hidden
          >
            C
          </span>
        )}
      </span>
      <span className="max-w-full truncate rounded bg-black/25 px-1.5 py-0.5 text-[11px] font-semibold text-white">
        {p.web_name}
      </span>
      <span className="text-[10px] font-medium tabular-nums text-white/80">
        {isCaptain ? "Suggested" : formatPrice(p.price)}
      </span>
    </button>
  );
}

function PitchMarkings() {
  const line = "var(--pitch-line)";
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {/* mowing stripes */}
      <div
        className="absolute inset-0 opacity-60"
        style={{
          background:
            "repeating-linear-gradient(to bottom, rgba(255,255,255,0.05) 0 8%, transparent 8% 16%)",
        }}
      />
      {/* outer border */}
      <div
        className="absolute inset-2 rounded-lg"
        style={{ border: `1.5px solid ${line}` }}
      />
      {/* halfway line + centre circle */}
      <div
        className="absolute left-2 right-2 top-1/2 h-px -translate-y-1/2"
        style={{ background: line }}
      />
      <div
        className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ border: `1.5px solid ${line}` }}
      />
      {/* penalty boxes */}
      <div
        className="absolute left-1/2 top-2 h-10 w-28 -translate-x-1/2 rounded-b-md"
        style={{ border: `1.5px solid ${line}`, borderTop: "none" }}
      />
      <div
        className="absolute bottom-2 left-1/2 h-10 w-28 -translate-x-1/2 rounded-t-md"
        style={{ border: `1.5px solid ${line}`, borderBottom: "none" }}
      />
    </div>
  );
}

export { PITCH_ROWS };
