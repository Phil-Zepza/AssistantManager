"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import {
  Badge,
  BottomSheet,
  Chip,
  ClubBadge,
  PositionTag,
} from "@/components/ui";
import { formatEp, formatPrice } from "@/lib/format";
import { POSITION_ORDER } from "@/lib/squad";
import type { PickPoolEntry, Position } from "@/lib/types";
import { cn } from "@/lib/cn";

export interface AddValidation {
  ok: boolean;
  /** Short blocking reason when !ok, e.g. "Already 3 from ARS". */
  reason: string | null;
}

export interface PlayerSearchSheetProps {
  open: boolean;
  onClose: () => void;
  /** Slot position being filled — sets the title + default filter. */
  position: Position;
  pool: PickPoolEntry[];
  /** Player ids already in the squad (rendered as "Added"). */
  picked: Set<number>;
  /** Live budget/quota/club-cap check for a candidate add. */
  validateAdd: (entry: PickPoolEntry) => AddValidation;
  /** Tenths of a million currently over the £100.0m cap (0 when within). */
  overBudgetBy: number;
  onAdd: (entry: PickPoolEntry) => void;
  /** Remove an already-picked player from the plan (edits the scratchpad only). */
  onRemove: (entry: PickPoolEntry) => void;
}

const MAX_ROWS = 80;

type PriceBand = "ALL" | "budget" | "mid" | "premium";
const PRICE_BANDS: { value: PriceBand; label: string; test: (t: number) => boolean }[] = [
  { value: "ALL", label: "Any price", test: () => true },
  { value: "budget", label: "≤ £6.0m", test: (t) => t <= 60 },
  { value: "mid", label: "£6.0–9.0m", test: (t) => t > 60 && t <= 90 },
  { value: "premium", label: "£9.0m+", test: (t) => t > 90 },
];

/**
 * Add-a-player sheet (bottom sheet on mobile, centred dialog ≥ md). Every row
 * is live-validated against the £100.0m budget, the position quota, and the max
 * 3-per-club rule; an illegal add is disabled with its blocking reason inline.
 */
export function PlayerSearchSheet({
  open,
  onClose,
  position,
  pool,
  picked,
  validateAdd,
  overBudgetBy,
  onAdd,
  onRemove,
}: PlayerSearchSheetProps) {
  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState<Position | "ALL">(position);
  const [club, setClub] = useState<string>("ALL");
  const [band, setBand] = useState<PriceBand>("ALL");

  // Reset the position filter to the slot's position whenever it changes.
  const [lastPosition, setLastPosition] = useState(position);
  if (position !== lastPosition) {
    setLastPosition(position);
    setPosFilter(position);
  }

  const clubs = useMemo(() => {
    const set = new Map<string, string>();
    for (const e of pool) {
      if (e.team?.short_name) set.set(e.team.short_name, e.team.name);
    }
    return [...set.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [pool]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const bandTest = PRICE_BANDS.find((b) => b.value === band)!.test;
    const out: PickPoolEntry[] = [];
    for (const e of pool) {
      if (posFilter !== "ALL" && e.player.position !== posFilter) continue;
      if (club !== "ALL" && e.team?.short_name !== club) continue;
      if (!bandTest(e.player.price)) continue;
      if (term) {
        const hay = `${e.player.web_name} ${e.team?.name ?? ""} ${
          e.team?.short_name ?? ""
        }`.toLowerCase();
        if (!hay.includes(term)) continue;
      }
      out.push(e);
      if (out.length >= MAX_ROWS) break;
    }
    return out;
  }, [pool, posFilter, club, band, search]);

  const title = (
    <div className="flex items-center gap-2">
      <span>Add {position}</span>
      {overBudgetBy > 0 && (
        <Badge tone="danger">{formatPrice(overBudgetBy)} over</Badge>
      )}
    </div>
  );

  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      {/* search field */}
      <div className="relative mb-3">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search player or club…"
          aria-label="Search players"
          className="h-11 w-full rounded-lg border border-strong bg-raised pl-9 pr-3 text-base text-primary placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* filter chips */}
      <div className="mb-3 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {(["ALL", ...POSITION_ORDER] as const).map((pos) => (
            <Chip
              key={pos}
              selected={posFilter === pos}
              onClick={() => setPosFilter(pos)}
            >
              {pos === "ALL" ? "All positions" : pos}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRICE_BANDS.map((b) => (
            <Chip
              key={b.value}
              selected={band === b.value}
              onClick={() => setBand(b.value)}
            >
              {b.label}
            </Chip>
          ))}
        </div>
        <select
          value={club}
          onChange={(e) => setClub(e.target.value)}
          aria-label="Filter by club"
          className="h-9 w-full rounded-lg border border-strong bg-raised px-2.5 text-sm text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="ALL">All clubs</option>
          {clubs.map(([short, name]) => (
            <option key={short} value={short}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {/* rows */}
      {filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-strong bg-surface px-3 py-6 text-center text-sm text-secondary">
          No players match your filters.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {filtered.map((e) => (
            <PoolRow
              key={e.player.fpl_id}
              entry={e}
              added={picked.has(e.player.fpl_id)}
              validation={validateAdd(e)}
              onAdd={() => onAdd(e)}
              onRemove={() => onRemove(e)}
            />
          ))}
          {filtered.length >= MAX_ROWS && (
            <li className="px-1 pt-1 text-xs text-muted">
              Showing the first {MAX_ROWS} — refine your search to see more.
            </li>
          )}
        </ul>
      )}
    </BottomSheet>
  );
}

function PoolRow({
  entry,
  added,
  validation,
  onAdd,
  onRemove,
}: {
  entry: PickPoolEntry;
  added: boolean;
  validation: AddValidation;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const p = entry.player;
  const blocked = !added && !validation.ok;
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-subtle bg-surface px-3 py-2">
      <ClubBadge code={entry.team?.short_name} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold text-primary">
            {p.web_name}
          </span>
          <PositionTag pos={p.position} size="sm" />
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-secondary tnum">
          <span className="font-semibold text-accent">
            {formatEp(entry.expected_points)} xPts
          </span>
          <span aria-hidden>·</span>
          <span>Form {p.form != null ? p.form.toFixed(1) : "—"}</span>
          <span aria-hidden>·</span>
          <span>{formatPrice(p.price)}</span>
        </div>
      </div>
      {added ? (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-lg border border-strong px-3 py-1.5 text-xs font-semibold text-secondary hover:bg-surface-2"
        >
          Remove
        </button>
      ) : (
        <button
          type="button"
          onClick={onAdd}
          disabled={blocked}
          title={blocked ? validation.reason ?? undefined : "Add to squad"}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold",
            blocked
              ? "cursor-not-allowed bg-surface-2 text-muted"
              : "bg-accent text-on-accent hover:bg-accent-press",
          )}
        >
          {blocked ? (
            validation.reason ?? "Can't add"
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add
            </>
          )}
        </button>
      )}
    </li>
  );
}
