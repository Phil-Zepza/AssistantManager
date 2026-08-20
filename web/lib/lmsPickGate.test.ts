import { describe, it, expect } from "vitest";
import { canMutatePick, validateChangeTarget } from "./lmsPickGate";
import type { StatusFixture } from "./lmsStatus";

// Fixed reference clock and relative helpers (ms).
const NOW = new Date("2026-08-15T12:00:00Z").getTime();
const HOUR = 3600_000;
const iso = (offsetHours: number) =>
  new Date(NOW + offsetHours * HOUR).toISOString();

function fx(kickoffOffsetH: number | null, finished = false): StatusFixture {
  return { kickoff: kickoffOffsetH == null ? null : iso(kickoffOffsetH), finished };
}

describe("canMutatePick — the Open + pending gate", () => {
  it("allows a pending pick while the round is open (before the deadline)", () => {
    expect(
      canMutatePick({
        deadline: iso(24), // deadline in the future
        fixtures: [fx(30), fx(32)],
        nowMs: NOW,
        pickResult: "pending",
      }),
    ).toEqual({ ok: true });
  });

  it("allows a pending pick when no deadline is known yet and kickoff is future", () => {
    expect(
      canMutatePick({
        deadline: null,
        fixtures: [fx(30)],
        nowMs: NOW,
        pickResult: "pending",
      }).ok,
    ).toBe(true);
  });

  it("rejects once the effective deadline has passed (starting_soon)", () => {
    const gate = canMutatePick({
      deadline: iso(-2), // deadline passed
      fixtures: [fx(4)], // no fixture kicked off yet
      nowMs: NOW,
      pickResult: "pending",
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/deadline has passed/i);
  });

  it("rejects once the first kickoff has been reached (in_progress)", () => {
    const gate = canMutatePick({
      deadline: iso(-26),
      fixtures: [fx(-1), fx(2)], // first fixture already kicked off
      nowMs: NOW,
      pickResult: "pending",
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/has started/i);
  });

  it("rejects when the round is complete (all fixtures finished)", () => {
    const gate = canMutatePick({
      deadline: iso(-48),
      fixtures: [fx(-40, true), fx(-38, true)],
      nowMs: NOW,
      pickResult: "pending",
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/is over/i);
  });

  it("rejects a resolved pick even while the round still reads as open", () => {
    // Clock says open, but the pick has already been settled — locked wins.
    const survived = canMutatePick({
      deadline: iso(24),
      fixtures: [fx(30)],
      nowMs: NOW,
      pickResult: "survived",
    });
    expect(survived.ok).toBe(false);
    if (!survived.ok) expect(survived.reason).toMatch(/survived/i);

    const eliminated = canMutatePick({
      deadline: iso(24),
      fixtures: [fx(30)],
      nowMs: NOW,
      pickResult: "eliminated",
    });
    expect(eliminated.ok).toBe(false);
    if (!eliminated.ok) expect(eliminated.reason).toMatch(/settled/i);
  });

  it("rejects when there are no fixtures to derive status from (unknown)", () => {
    expect(
      canMutatePick({
        deadline: null,
        fixtures: [],
        nowMs: NOW,
        pickResult: "pending",
      }).ok,
    ).toBe(false);
  });
});

describe("validateChangeTarget — single-use per entry", () => {
  const picks = [
    { gw: 3, teamId: 1 }, // Arsenal, this round
    { gw: 1, teamId: 11 }, // Man City, an earlier round
    { gw: 2, teamId: 14 }, // Man Utd, an earlier round
  ];

  it("allows switching to a team not yet used by the entry", () => {
    expect(validateChangeTarget(picks, 3, 9)).toEqual({
      ok: true,
      noop: false,
    });
  });

  it("rejects a team already spent by the entry in another round", () => {
    const res = validateChangeTarget(picks, 3, 11);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/already used/i);
  });

  it("treats re-picking this round's own team as a clean no-op", () => {
    expect(validateChangeTarget(picks, 3, 1)).toEqual({
      ok: true,
      noop: true,
    });
  });
});
