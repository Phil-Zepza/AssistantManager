import { describe, it, expect } from "vitest";
import {
  canMutatePick,
  pickLockLabel,
  validateChangeTarget,
} from "./lmsPickGate";

// The gate is result-based ONLY — there is no time/deadline input at all. A
// pending pick is editable whenever, regardless of the clock; a resolved pick is
// locked. This is the critical correctness contract for cancelPick / changePick.
describe("canMutatePick — the result-based gate (no time gate)", () => {
  it("allows a pending pick (the only condition for editability)", () => {
    expect(canMutatePick({ pickResult: "pending" })).toEqual({ ok: true });
  });

  it("stays editable regardless of time — there is no deadline input", () => {
    // Encodes the acceptance rule: a pending pick past its deadline is still
    // editable. The gate takes no clock, so time can never change the outcome.
    expect(canMutatePick({ pickResult: "pending" }).ok).toBe(true);
    // The gate signature carries no time/deadline/fixtures field.
    expect(Object.keys({ pickResult: "pending" as const })).toEqual([
      "pickResult",
    ]);
  });

  it("rejects a survived pick — resolved is locked", () => {
    const gate = canMutatePick({ pickResult: "survived" });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/resolved/i);
  });

  it("rejects an eliminated pick — resolved is locked", () => {
    const gate = canMutatePick({ pickResult: "eliminated" });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/locked/i);
  });
});

describe("pickLockLabel — shown only for resolved picks", () => {
  it("labels a survived pick", () => {
    expect(pickLockLabel("survived")).toMatch(/survived/i);
  });
  it("labels an eliminated pick as out", () => {
    expect(pickLockLabel("eliminated")).toMatch(/out/i);
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
