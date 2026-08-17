"use client";

import { useMemo, useState } from "react";
import { saveSquad } from "@/app/actions";
import { formatEp, formatPct, formatPrice } from "@/lib/format";
import {
  BENCH_COUNT,
  BUDGET_CAP_TENTHS,
  MAX_PER_CLUB,
  POSITION_ORDER,
  POSITION_QUOTA,
  SQUAD_SIZE,
  STARTER_COUNT,
  totalCost,
  validateSquad,
  type SquadMember,
} from "@/lib/squad";
import type { PickPoolEntry, Position, SquadSelection } from "@/lib/types";
import { Badge } from "@/components/ui";

interface Pick {
  id: number;
  onBench: boolean;
  isCaptain: boolean;
  isVice: boolean;
}

const MAX_LIST_ROWS = 80;

export default function SquadEditor({
  gw,
  pool,
  initialSelections,
}: {
  gw: number;
  pool: PickPoolEntry[];
  initialSelections: SquadSelection[];
}) {
  const poolById = useMemo(() => {
    const m = new Map<number, PickPoolEntry>();
    for (const e of pool) m.set(e.player.fpl_id, e);
    return m;
  }, [pool]);

  const [picks, setPicks] = useState<Pick[]>(() =>
    initialSelections
      .filter((s) => poolById.has(s.playerId))
      .map((s) => ({
        id: s.playerId,
        onBench: s.onBench,
        isCaptain: s.isCaptain,
        isVice: s.isVice,
      })),
  );
  // Bench display order — a live helper only (the schema has no bench-order
  // column, so this is not persisted on save).
  const [benchOrder, setBenchOrder] = useState<number[]>(() =>
    initialSelections.filter((s) => s.onBench).map((s) => s.playerId),
  );

  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState<Position | "ALL">("ALL");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pickedIds = useMemo(() => new Set(picks.map((p) => p.id)), [picks]);

  // ---- derived counts / validation ----
  const members: SquadMember[] = useMemo(
    () =>
      picks.map((p) => {
        const e = poolById.get(p.id)!;
        return {
          playerId: p.id,
          position: e.player.position,
          teamId: e.player.team_id,
          onBench: p.onBench,
          isCaptain: p.isCaptain,
          isVice: p.isVice,
        };
      }),
    [picks, poolById],
  );

  const posCounts = useMemo(() => {
    const c: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const m of members) c[m.position] += 1;
    return c;
  }, [members]);

  const clubCounts = useMemo(() => {
    const c = new Map<number, number>();
    for (const m of members) {
      if (m.teamId == null) continue;
      c.set(m.teamId, (c.get(m.teamId) ?? 0) + 1);
    }
    return c;
  }, [members]);

  const cost = useMemo(
    () => totalCost(picks.map((p) => poolById.get(p.id)!.player.price)),
    [picks, poolById],
  );
  const overBudget = cost > BUDGET_CAP_TENTHS;

  const starters = picks.filter((p) => !p.onBench);
  const benchPicks = picks.filter((p) => p.onBench);

  const projectedXi = useMemo(() => {
    let total = 0;
    for (const p of starters) {
      const ep = poolById.get(p.id)!.expected_points ?? 0;
      total += ep;
      if (p.isCaptain) total += ep; // captain scores double
    }
    return total;
  }, [starters, poolById]);

  const errors = useMemo(() => validateSquad(members), [members]);
  const canSave = errors.length === 0 && !saving;

  // ---- mutations ----
  function addPlayer(entry: PickPoolEntry) {
    const p = entry.player;
    if (pickedIds.has(p.fpl_id)) return;
    if (picks.length >= SQUAD_SIZE) return;
    if (posCounts[p.position] >= POSITION_QUOTA[p.position]) return;
    if (
      p.team_id != null &&
      (clubCounts.get(p.team_id) ?? 0) >= MAX_PER_CLUB
    ) {
      return;
    }
    // Default to starter until the XI is full, then bench.
    const asStarter = starters.length < STARTER_COUNT;
    setPicks((prev) => [
      ...prev,
      { id: p.fpl_id, onBench: !asStarter, isCaptain: false, isVice: false },
    ]);
    if (!asStarter) setBenchOrder((prev) => [...prev, p.fpl_id]);
  }

  function removePlayer(id: number) {
    setPicks((prev) => prev.filter((p) => p.id !== id));
    setBenchOrder((prev) => prev.filter((x) => x !== id));
  }

  function toggleBench(id: number) {
    setPicks((prev) => {
      const pick = prev.find((p) => p.id === id);
      if (!pick) return prev;
      const movingToBench = !pick.onBench;
      if (movingToBench && benchPicks.length >= BENCH_COUNT) return prev;
      if (!movingToBench && starters.length >= STARTER_COUNT) return prev;
      return prev.map((p) =>
        p.id === id
          ? {
              ...p,
              onBench: movingToBench,
              // captain / vice must be starters
              isCaptain: movingToBench ? false : p.isCaptain,
              isVice: movingToBench ? false : p.isVice,
            }
          : p,
      );
    });
    setBenchOrder((prev) => {
      const pick = picks.find((p) => p.id === id);
      if (!pick) return prev;
      // if it was a starter → now benched, append; else remove
      return pick.onBench ? prev.filter((x) => x !== id) : [...prev, id];
    });
  }

  function setCaptain(id: number) {
    setPicks((prev) =>
      prev.map((p) => ({
        ...p,
        isCaptain: p.id === id,
        // can't be both C and V
        isVice: p.id === id ? false : p.isVice,
      })),
    );
  }

  function setVice(id: number) {
    setPicks((prev) =>
      prev.map((p) => ({
        ...p,
        isVice: p.id === id,
        isCaptain: p.id === id ? false : p.isCaptain,
      })),
    );
  }

  function moveBench(id: number, dir: -1 | 1) {
    setBenchOrder((prev) => {
      const order = orderedBenchIds(prev, benchPicks);
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return prev;
      const next = [...order];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function onSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    const selections: SquadSelection[] = picks.map((p) => ({
      playerId: p.id,
      onBench: p.onBench,
      isCaptain: p.isCaptain,
      isVice: p.isVice,
    }));
    try {
      await saveSquad({ gw, selections });
      // saveSquad redirects to "/" on success; if we get here, no redirect
      // happened — leave the button enabled again.
    } catch {
      setSaveError("Could not save your squad. Please try again.");
      setSaving(false);
    }
  }

  // ---- filtered browse list ----
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const out: PickPoolEntry[] = [];
    for (const e of pool) {
      if (posFilter !== "ALL" && e.player.position !== posFilter) continue;
      if (term) {
        const hay = `${e.player.web_name} ${e.team?.name ?? ""} ${
          e.team?.short_name ?? ""
        }`.toLowerCase();
        if (!hay.includes(term)) continue;
      }
      out.push(e);
      if (out.length >= MAX_LIST_ROWS) break;
    }
    return out;
  }, [pool, posFilter, search]);

  const orderedBench = orderedBenchIds(benchOrder, benchPicks);

  return (
    <div className="space-y-4">
      {/* ---- summary bar ---- */}
      <div className="sticky top-0 z-10 -mx-4 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Squad cost
            </div>
            <div
              className={`text-lg font-bold ${
                overBudget ? "text-red-600" : "text-brand"
              }`}
            >
              {formatPrice(cost)}
              <span className="ml-1 text-xs font-normal text-gray-400">
                / {formatPrice(BUDGET_CAP_TENTHS)}
              </span>
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Players
            </div>
            <div className="text-lg font-bold text-gray-800">
              {picks.length}
              <span className="text-xs font-normal text-gray-400">
                /{SQUAD_SIZE}
              </span>
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Proj. XI
            </div>
            <div className="text-lg font-bold text-brand">
              {formatEp(projectedXi)}
              <span className="ml-1 text-xs font-normal text-gray-400">xPts</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save squad"}
          </button>
        </div>

        {/* position tally */}
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          {POSITION_ORDER.map((pos) => {
            const have = posCounts[pos];
            const need = POSITION_QUOTA[pos];
            const done = have === need;
            return (
              <span
                key={pos}
                className={`rounded-full px-2 py-0.5 font-medium ${
                  done
                    ? "bg-green-100 text-green-800"
                    : "bg-gray-100 text-gray-600"
                }`}
              >
                {pos} {have}/{need}
              </span>
            );
          })}
        </div>

        {overBudget && (
          <p className="mt-2 text-xs font-medium text-red-600">
            Over the £{(BUDGET_CAP_TENTHS / 10).toFixed(1)}m budget by{" "}
            {formatPrice(cost - BUDGET_CAP_TENTHS)} — you can still save, but a
            real FPL squad must be within budget.
          </p>
        )}

        {errors.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-gray-500">
            {errors.slice(0, 3).map((e) => (
              <li key={e}>• {e}</li>
            ))}
          </ul>
        )}
        {saveError && (
          <p className="mt-2 text-xs font-medium text-red-600">{saveError}</p>
        )}
      </div>

      {/* ---- your squad ---- */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Starting XI
        </h2>
        {starters.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 bg-white px-3 py-4 text-center text-sm text-gray-500">
            Add players from the list below to build your XI.
          </p>
        ) : (
          <div className="space-y-1.5">
            {POSITION_ORDER.flatMap((pos) =>
              starters
                .filter((p) => poolById.get(p.id)!.player.position === pos)
                .map((p) => (
                  <SelectedRow
                    key={p.id}
                    entry={poolById.get(p.id)!}
                    pick={p}
                    onRemove={() => removePlayer(p.id)}
                    onToggleBench={() => toggleBench(p.id)}
                    onCaptain={() => setCaptain(p.id)}
                    onVice={() => setVice(p.id)}
                    benchFull={benchPicks.length >= BENCH_COUNT}
                  />
                )),
            )}
          </div>
        )}

        <h2 className="mb-2 mt-5 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Bench{" "}
          <span className="font-normal normal-case text-gray-400">
            (in order)
          </span>
        </h2>
        {orderedBench.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 bg-white px-3 py-4 text-center text-sm text-gray-500">
            Your 4 substitutes appear here.
          </p>
        ) : (
          <div className="space-y-1.5">
            {orderedBench.map((id, idx) => {
              const p = picks.find((x) => x.id === id)!;
              return (
                <SelectedRow
                  key={id}
                  entry={poolById.get(id)!}
                  pick={p}
                  benchIndex={idx}
                  onRemove={() => removePlayer(id)}
                  onToggleBench={() => toggleBench(id)}
                  onMoveUp={idx > 0 ? () => moveBench(id, -1) : undefined}
                  onMoveDown={
                    idx < orderedBench.length - 1
                      ? () => moveBench(id, 1)
                      : undefined
                  }
                  starterFull={starters.length >= STARTER_COUNT}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* ---- add players ---- */}
      <section>
        <h2 className="mb-2 mt-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Add players
        </h2>
        <div className="mb-2 flex flex-col gap-2 sm:flex-row">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search player or club…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <div className="flex gap-1">
            {(["ALL", ...POSITION_ORDER] as const).map((pos) => (
              <button
                key={pos}
                type="button"
                onClick={() => setPosFilter(pos)}
                className={`rounded-lg px-3 py-2 text-sm font-medium ${
                  posFilter === pos
                    ? "bg-brand text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {pos}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 bg-white px-3 py-4 text-center text-sm text-gray-500">
            No players match your search.
          </p>
        ) : (
          <div className="space-y-1.5">
            {filtered.map((e) => {
              const p = e.player;
              const picked = pickedIds.has(p.fpl_id);
              const posFull =
                posCounts[p.position] >= POSITION_QUOTA[p.position];
              const clubFull =
                p.team_id != null &&
                (clubCounts.get(p.team_id) ?? 0) >= MAX_PER_CLUB;
              const full = picks.length >= SQUAD_SIZE;
              const blocked = !picked && (posFull || clubFull || full);
              return (
                <PoolRow
                  key={p.fpl_id}
                  entry={e}
                  picked={picked}
                  blocked={blocked}
                  blockReason={
                    posFull
                      ? `${p.position} full`
                      : clubFull
                        ? "3 from club"
                        : full
                          ? "Squad full"
                          : null
                  }
                  onAdd={() => addPlayer(e)}
                  onRemove={() => removePlayer(p.fpl_id)}
                />
              );
            })}
            {filtered.length >= MAX_LIST_ROWS && (
              <p className="px-1 pt-1 text-xs text-gray-400">
                Showing the first {MAX_LIST_ROWS} — refine your search to see
                more.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// Stable bench display order: known order first (intersected with current bench
// members), then any bench members not yet ordered.
function orderedBenchIds(order: number[], benchPicks: Pick[]): number[] {
  const benchSet = new Set(benchPicks.map((p) => p.id));
  const known = order.filter((id) => benchSet.has(id));
  const rest = benchPicks.map((p) => p.id).filter((id) => !known.includes(id));
  return [...known, ...rest];
}

function difficultyTone(diff: number | null): string {
  if (diff == null) return "bg-gray-100 text-gray-500";
  if (diff <= 2) return "bg-green-100 text-green-800";
  if (diff === 3) return "bg-gray-200 text-gray-700";
  return "bg-red-100 text-red-700";
}

function availabilityLabel(
  status: string | null,
  chanceNext: number | null,
): { text: string; tone: "green" | "amber" | "red" } | null {
  // 'a' = available. Anything else is a doubt/out.
  if (status == null || status === "a") {
    if (chanceNext != null && chanceNext < 100) {
      return { text: `${chanceNext}%`, tone: chanceNext >= 75 ? "amber" : "red" };
    }
    return null;
  }
  if (chanceNext != null) {
    return { text: `${chanceNext}%`, tone: chanceNext >= 75 ? "amber" : "red" };
  }
  return { text: "Out", tone: "red" };
}

function FixtureTag({ entry }: { entry: PickPoolEntry }) {
  const nf = entry.next_fixture;
  if (!nf || !nf.opponent?.short_name) {
    return <span className="text-xs text-gray-400">—</span>;
  }
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${difficultyTone(
        nf.difficulty,
      )}`}
      title={
        nf.win_prob != null ? `Win prob ${formatPct(nf.win_prob)}` : undefined
      }
    >
      {nf.opponent.short_name} {nf.is_home ? "(H)" : "(A)"}
    </span>
  );
}

function PoolRow({
  entry,
  picked,
  blocked,
  blockReason,
  onAdd,
  onRemove,
}: {
  entry: PickPoolEntry;
  picked: boolean;
  blocked: boolean;
  blockReason: string | null;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const p = entry.player;
  const avail = availabilityLabel(p.status, p.chance_next);
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Badge tone="gray">{p.position}</Badge>
          <span className="truncate font-medium">{p.web_name}</span>
          <span className="text-xs text-gray-400">
            {entry.team?.short_name ?? ""}
          </span>
          {avail && (
            <Badge tone={avail.tone}>{avail.text}</Badge>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
          <span>{formatPrice(p.price)}</span>
          <span>·</span>
          <span className="font-semibold text-brand">
            {formatEp(entry.expected_points)} xPts
          </span>
          <span>·</span>
          <span>{formatPct(p.selected_by != null ? p.selected_by / 100 : null)} own</span>
          <FixtureTag entry={entry} />
        </div>
      </div>
      {picked ? (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          Remove
        </button>
      ) : (
        <button
          type="button"
          onClick={onAdd}
          disabled={blocked}
          title={blocked && blockReason ? blockReason : undefined}
          className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400"
        >
          {blocked && blockReason ? blockReason : "Add"}
        </button>
      )}
    </div>
  );
}

function SelectedRow({
  entry,
  pick,
  benchIndex,
  benchFull,
  starterFull,
  onRemove,
  onToggleBench,
  onCaptain,
  onVice,
  onMoveUp,
  onMoveDown,
}: {
  entry: PickPoolEntry;
  pick: Pick;
  benchIndex?: number;
  benchFull?: boolean;
  starterFull?: boolean;
  onRemove: () => void;
  onToggleBench: () => void;
  onCaptain?: () => void;
  onVice?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const p = entry.player;
  const onBench = pick.onBench;
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {benchIndex != null && (
          <span className="text-xs font-semibold text-gray-400">
            {benchIndex + 1}.
          </span>
        )}
        <Badge tone="gray">{p.position}</Badge>
        <span className="truncate font-medium">{p.web_name}</span>
        <span className="text-xs text-gray-400">
          {entry.team?.short_name ?? ""}
        </span>
        {pick.isCaptain && <Badge tone="purple">C</Badge>}
        {pick.isVice && <Badge tone="gray">V</Badge>}
        <span className="ml-1 text-xs text-gray-500">
          {formatPrice(p.price)} · {formatEp(entry.expected_points)}
        </span>
        <FixtureTag entry={entry} />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!onBench && onCaptain && (
          <IconBtn
            active={pick.isCaptain}
            onClick={onCaptain}
            label="Set captain"
          >
            C
          </IconBtn>
        )}
        {!onBench && onVice && (
          <IconBtn active={pick.isVice} onClick={onVice} label="Set vice">
            V
          </IconBtn>
        )}
        {onBench && (
          <div className="flex flex-col">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!onMoveUp}
              aria-label="Move up"
              className="px-1 text-xs text-gray-500 disabled:opacity-30"
            >
              ▲
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!onMoveDown}
              aria-label="Move down"
              className="px-1 text-xs text-gray-500 disabled:opacity-30"
            >
              ▼
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onToggleBench}
          disabled={onBench ? starterFull : benchFull}
          title={
            onBench
              ? starterFull
                ? "XI is full"
                : "Move to XI"
              : benchFull
                ? "Bench is full"
                : "Move to bench"
          }
          className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {onBench ? "→ XI" : "Bench"}
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove player"
          className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function IconBtn({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`h-7 w-7 rounded-full text-xs font-bold ${
        active
          ? "bg-brand text-white"
          : "border border-gray-300 text-gray-500 hover:bg-gray-50"
      }`}
    >
      {children}
    </button>
  );
}
