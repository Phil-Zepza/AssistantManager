"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";

/**
 * A single source of truth for the deadline the top app bar counts down to.
 *
 * The layout seeds the bar with a generic "next LMS round" deadline (see
 * app/(app)/layout.tsx). While a specific competition is on screen, that screen
 * publishes its OWN effective round deadline (the setRoundDeadline override if
 * set, else computeDefaultDeadline) via useSetTopbarDeadline — so the app-bar
 * countdown and the competition-screen status header always read the exact same
 * value instead of drifting apart (the generic deadline ignores per-competition
 * overrides and skipped-round shifts).
 *
 * Two contexts on purpose: the value context re-renders consumers when the
 * override changes, while the setter context hands publishers the STABLE
 * useState setter — depending on that setter in an effect can never loop.
 */
export interface TopbarDeadline {
  deadline: string | null;
  gw: number | null;
}

const ValueContext = createContext<TopbarDeadline | null>(null);
const SetterContext = createContext<(v: TopbarDeadline | null) => void>(() => {});

export function TopbarDeadlineProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<TopbarDeadline | null>(null);
  return (
    <SetterContext.Provider value={setOverride}>
      <ValueContext.Provider value={override}>{children}</ValueContext.Provider>
    </SetterContext.Provider>
  );
}

/** Read the current top-bar deadline override (null → use the layout default). */
export function useTopbarDeadlineOverride(): TopbarDeadline | null {
  return useContext(ValueContext);
}

/**
 * Publish `{ deadline, gw }` to the top bar while `active` is true; clears the
 * override on unmount or when `active` flips false, so the bar reverts to the
 * layout default. Safe to call unconditionally (Rules of Hooks): pass
 * `active=false` instead of skipping the call.
 */
export function useSetTopbarDeadline(
  deadline: string | null,
  gw: number | null,
  active: boolean,
): void {
  const setOverride = useContext(SetterContext);
  useEffect(() => {
    if (!active) {
      setOverride(null);
      return;
    }
    setOverride({ deadline, gw });
    return () => setOverride(null);
  }, [setOverride, active, deadline, gw]);
}
