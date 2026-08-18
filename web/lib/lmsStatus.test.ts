import { describe, it, expect } from "vitest";
import { deriveGwStatus, type StatusFixture } from "./lmsStatus";

// Fixed reference clock and relative helpers (ms).
const NOW = new Date("2026-08-15T12:00:00Z").getTime();
const HOUR = 3600_000;
const iso = (offsetHours: number) =>
  new Date(NOW + offsetHours * HOUR).toISOString();

function fx(kickoffOffsetH: number | null, finished = false): StatusFixture {
  return { kickoff: kickoffOffsetH == null ? null : iso(kickoffOffsetH), finished };
}

describe("deriveGwStatus", () => {
  it("is 'unknown' with no fixtures", () => {
    expect(
      deriveGwStatus({ deadline: iso(24), fixtures: [], nowMs: NOW }),
    ).toBe("unknown");
  });

  it("is 'open' before the deadline", () => {
    expect(
      deriveGwStatus({
        deadline: iso(24), // deadline in the future
        fixtures: [fx(30), fx(32)],
        nowMs: NOW,
      }),
    ).toBe("open");
  });

  it("is 'open' when no deadline is known yet and kickoff is future", () => {
    expect(
      deriveGwStatus({ deadline: null, fixtures: [fx(30)], nowMs: NOW }),
    ).toBe("open");
  });

  it("is 'starting_soon' after the deadline but before first kickoff", () => {
    expect(
      deriveGwStatus({
        deadline: iso(-2), // deadline passed
        fixtures: [fx(5), fx(7)], // kickoffs still ahead
        nowMs: NOW,
      }),
    ).toBe("starting_soon");
  });

  it("is 'in_progress' once the earliest kickoff has been reached", () => {
    expect(
      deriveGwStatus({
        deadline: iso(-6),
        fixtures: [fx(-1, false), fx(3, false)], // one kicked off, none finished
        nowMs: NOW,
      }),
    ).toBe("in_progress");
  });

  it("is 'complete' only when every fixture is finished", () => {
    expect(
      deriveGwStatus({
        deadline: iso(-48),
        fixtures: [fx(-40, true), fx(-38, true)],
        nowMs: NOW,
      }),
    ).toBe("complete");

    // one still pending -> not complete
    expect(
      deriveGwStatus({
        deadline: iso(-48),
        fixtures: [fx(-40, true), fx(-2, false)],
        nowMs: NOW,
      }),
    ).toBe("in_progress");
  });
});
