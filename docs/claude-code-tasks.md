# Claude Code Tasks — Prompt Log

Every Claude Code task is recorded here (verbatim prompt + model + thinking level + status + PR).
Append new tasks at the bottom. See `dev-workflow.md` for the format and PR rules.

| # | Task | Model | Thinking | Status | PR |
|---|------|-------|----------|--------|----|
| CC-1 | Fix crashing Auth.js middleware | Opus | think hard | merged | d716b18 (pushed direct, pre-PR-convention) |
| CC-2 | FPL-0: validate & tune projection model | Opus | think hard | issued | — |
| CC-3 | FPL-1a: manual squad picker (optimizer split to CC-3b) | Opus | think hard | in review | https://github.com/Phil-Zepza/AssistantManager/pull/2 |
| CC-4 | FPL-1: recommendation engine (XI, captain, transfer) | Opus | think hard | queued | — |

---

## CC-1 — Fix crashing Auth.js middleware  (Model: Opus · think hard)
Status: DONE (commit d716b18 — pushed directly to staging before the PR convention was set).

Prompt:
> The Next.js app in `web/` uses Auth.js v5 (`next-auth@beta`) with the Resend email provider and
> `@auth/pg-adapter` (Postgres via `pg`), deployed on Vercel. The staging deployment returns HTTP 500
> `MIDDLEWARE_INVOCATION_FAILED` — the edge routing middleware crashes on every request. Diagnose and
> fix the root cause. Steps: (1) Read `web/middleware.ts`, `web/auth.config.ts`, `web/auth.ts`,
> `web/lib/db.ts`; confirm the middleware imports ONLY the edge-safe `auth.config` and nothing
> node-only is reachable. (2) Ensure Auth.js init doesn't throw when an env var is absent; degrade
> gracefully in middleware. (3) If the adapter/Resend provider leaks into the edge bundle, refactor so
> the edge middleware uses a minimal config and adapter/provider live only in `auth.ts`. (4) Reproduce
> with `cd web && npm run build`. (5) Keep the split-config pattern and pg data layer intact; `/`
> redirects unauthenticated users to `/login` without crashing. (6) `npm run build` passes, commit,
> push. Report root cause and changes.

Outcome: root cause was ungraceful failure at the edge — `auth()` threw `MissingSecret` /
`UntrustedHost`. Fix: wrapped the edge handler in try/catch (degrade to `/login`) + added
`trustHost: true` in `auth.config.ts`.

---

## CC-2 — FPL-0: validate & tune the projection model  (Model: Opus · think hard)
Status: ISSUED.

Diagnosis (from Cowork review of `pipeline/models.py`): projections are inflated because
(1) per-90 rates aren't regressed for small samples, (2) `DEFAULT_START_RATE = 0.70` treats fringe
players as starters, (3) `att_mult` is unbounded (~3.6 for easy fixtures). Result: a bit-part
midfielder projected 16.6 pts/GW.

Prompt:
> The v1 expected-points model in `pipeline/models.py` produces implausible projections (e.g. a fringe
> midfielder at 16.6 pts for one GW; realistic single-GW projections sit ~2-8, elite premiums ~6-9).
> Diagnose against the seeded staging DB and fix the inflation. Address all three root causes and add a
> guardrail:
> 1. Regress per-90 rates for small samples: shrink expected_goals_per_90 / expected_assists_per_90 /
>    defensive_contribution_per_90 toward a position prior weighted by minutes played
>    (`rate_adj = (minutes*rate + k*prior)/(minutes + k)`); expose k + priors as constants.
> 2. Fix nailed-ness / expected minutes: derive start likelihood from actual minutes
>    (`minutes/(team_games*90)`) blended with starts_per_90 so bench players project near zero; keep
>    availability (status/chance_next) as a multiplier.
> 3. Bound the fixture multiplier: clamp att_mult (and clean-sheet effect) to ~0.6-1.6.
> 4. Guardrail + validation: soft-cap total EP; extend the models.py self-check to flag any projection
>    above a sane max; add a script that prints the TOP-20 projected players against the seeded DB and
>    asserts they look sane (premiums at top ~6-9, no bit-part players in the top 20).
> Keep the model transparent (constants at top, pure functions). Don't change the schema or pipeline
> control flow beyond recomputing model_player_ep; re-run the projection step so model_player_ep is
> refreshed. Verify `python -m py_compile pipeline/*.py` and `python models.py` pass; paste the top-20.
> Branch `fix/projection-model-tuning` off staging, commit, push, open PR into staging, do NOT merge.
> Report PR URL, changes, and the top-20 list.

---

## CC-3 — FPL-1a: manual squad picker  (Model: Opus · think hard)
Status: IN REVIEW (PR: https://github.com/Phil-Zepza/AssistantManager/pull/2). Scope was split: this PR ships the **manual** squad picker
only; the **strategy-aware optimizer** is deferred to a separate follow-up (tracked as CC-3b) so users
can load their 15 players now (the FPL picks endpoint returns nothing pre-deadline, so `user_squad` is
empty until then).

Prompt:
> Build a manual squad picker so a user can load their 15 players now (the FPL API only exposes real
> picks after the GW deadline, so `user_squad` is empty until then). The strategy-aware optimizer is a
> separate follow-up PR — do NOT build it here.
> Web: add a squad editor at `/squad/edit`, launched from the dashboard's empty state and from Settings.
> • A searchable, position-filterable player list read from `players` joined to `teams` (name/short_name)
>   and `model_player_ep` for the current/next GW, plus each team's next fixture from `fixtures`
>   (+ difficulty from `fixtures.*_diff` and/or `model_fixture_probs`). For each player show: web_name,
>   club, position, price (£m), projected points, ownership %, availability (status / chance_next), and
>   next opponent + a difficulty indicator.
> • Let the user assemble a 15-man squad enforcing 2 GK / 5 DEF / 5 MID / 3 FWD and max 3 per club;
>   choose 11 starters + 4 bench (bench order), and captain + vice from the starters.
> • Live helpers: running squad cost vs the £100.0m cap (soft warning if over, don't hard-block),
>   per-position and per-club counts, and a projected-XI points tally.
> • Load an existing `user_squad` (current GW) into the editor if one exists. On save, a server action
>   (session-scoped, server-only DB) writes the rows to `user_squad` for the current GW (`is_captain`,
>   `is_vice`, `on_bench`), replacing prior rows for that user+GW. Redirect back to the dashboard, which
>   should now render the squad.
> Pipeline: confirm (and comment) that the post-deadline auto-fetch only overwrites `user_squad` when the
> FPL picks endpoint actually returns data — it must never wipe a manually-entered squad when picks 404.
> Constraints: match `db/schema.sql` exactly; keep the auth/edge-node split and pg data layer; all DB
> access server-only and scoped by the session user id; graceful loading/empty/validation states.
> Verify: `cd web && npm run build` and `python -m py_compile pipeline/*.py` pass. Docs + roadmap update
> in the same PR. Branch `feat/squad-picker` off `staging`, PR into `staging`, do NOT merge.

Summary:
- **New route** `web/app/squad/edit/page.tsx` (server component): auths, resolves the current GW, and
  loads the player pool + any existing squad, then renders the client editor. Graceful empty state when
  player data isn't seeded yet.
- **Client editor** `web/components/SquadEditor.tsx`: searchable + position-filtered player list; add/
  remove with hard enforcement of 2/5/5/3 and max-3-per-club; 11 starters / 4 bench with bench reorder;
  captain + vice (starters only, mutually exclusive). Live helpers: cost vs £100.0m (soft over-budget
  warning, never blocks save), per-position tally, per-club counts, projected-XI xPts (captain doubled),
  and a running validation list that gates the Save button.
- **Data layer** `web/lib/queries.ts`: `getPlayerPool(gw)` joins `players ⋈ teams ⋈ model_player_ep`
  (current GW, horizon 1) with a LATERAL subquery for each team's next unfinished fixture (opponent +
  `*_diff` difficulty + optional win prob from `model_fixture_probs`); `getSquadSelections(userId, gw)`
  seeds the editor. Rules live in a pure, shared `web/lib/squad.ts` used by BOTH the client and the
  server action (single source of truth).
- **Server action** `saveSquad` (`web/app/actions.ts`): session-scoped, re-reads authoritative
  position/club/price from the DB (never trusts the client for anything but ids + roles), re-validates,
  then atomically (new `tx()` helper in `lib/db.ts`) DELETEs prior rows for (user, gw) and inserts the
  new 15. Redirects to `/`.
- **Pipeline** `pipeline/run.py`: added an explicit comment on `_sync_user_squad` confirming the
  auto-fetch bails out (no DELETE, no upsert) whenever `get_entry_picks` returns None/no picks (404 pre-
  deadline), so a manually-entered squad is never wiped. Behaviour was already correct; this documents
  and guards the invariant.
- **Schema note:** `user_squad` has no bench-order column, so bench order is a live editor helper only
  (not persisted) — matches the "match schema exactly" constraint.
- Dashboard empty state and Settings both launch `/squad/edit`; the dashboard also shows an "Edit squad"
  link once a squad exists. Verified `npm run build` and `py_compile` pass.

Deferred to CC-3b: the strategy-aware "optimise" action (optimal £100m squad under the rules, shaped by
template/balanced/differential + big-at-the-back/DEFCON + premium-core presets).

---

## CC-4 — FPL-1: recommendation engine  (Model: Opus · think hard)
Status: QUEUED (after a squad can be loaded). Best XI from the 15 (valid formation) maximising
projections; captain/vice; best single transfer weighing the −4 hit (budget = bank + sell value,
sell ≈ current price for now); write fpl_xi / fpl_captain / fpl_transfer to recommendations_log;
surface on the dashboard. Handle empty-squad (pre-deadline) gracefully.

---

## CC-LMS-pass1b — LMS competition screen: three pass-1 review fixes  (Model: Opus)
Status: IN REVIEW — branch `fix/lms-pass1-bugs`, PR into `staging` (do not merge).

Scope (fixes on top of the LMS rework + skip-rounds UI already on `staging`):
1. **Duplicate countdowns disagreed.** Root cause: the top app bar counted down to a *generic*
   next-LMS-round deadline (`getNextLmsDeadline` → `computeDefaultDeadline`), which ignores a
   competition's `setRoundDeadline` override and its skipped-round shifts, while the competition
   status header used the competition's effective `nextDeadline` (override-aware). Fix: new
   `TopbarDeadlineContext` — the competition screen publishes its effective `{gw, deadline}` to the
   top bar via `useSetTopbarDeadline`, so both read one value; cleared to the layout default when no
   competition is open.
2. **Expanded fixture showed last-season stats.** The view already rendered a pending state for
   non-current data, but `getTeamScouting` still *fetched* and returned the last-season fallback.
   Removed the fetch/fallback (query is now `is_current = true` only; `season` collapses to
   `current | none`), and updated the empty-state copy. **Deliberate reversal** of the earlier
   labelled-last-season decision.
3. **Forward-plan override sheet.** Inspection: the sheet already uses the shared `BottomSheet`
   (backdrop/Esc/Cancel all wired — 3a already sound on `staging`), and `computeCompetitionPlan`
   already honours a per-entry pin under spread (excludes the pinned entry from the joint pool,
   pre-assigns its team, tags `manualOverride`/`spreadSource=null`) with the UI passing the override
   in as a pin — so 3b is functional. Added the still-missing pieces: a warning-tone `Callout` before
   the pick list when spread is active (soft/strong + ≥2 entries), an explicit "Manual override" tile
   chip, and a spread test proving a per-entry pin survives the joint pass while siblings coordinate
   around it. Skip / Restore controls preserved.

Verify: `npx tsc --noEmit` (0), `npm test` (51 passing, +2 new), `npm run build` (exit 0).

---

## CC-LMS-pass1c — LMS competition screen: picks-above-fixtures + backable-either-side  (Model: Opus)
Status: IN REVIEW — branch `feat/lms-picks-and-fixtures-layout`, PR into `staging` (do not merge).

Three layout/interaction changes from pass-1 review, built on the approved LMS v5 canvas
(Frame 4 mobile / Frame 7 desktop), reusing existing primitives:

1. **Top-3 above the fixtures list.** Swapped `Top3Section` before `FixturesSection` in the
   competition view. `Top3Section` list is now responsive: mobile stacks vertically (#1 first);
   desktop lays the three ranked cards in one 12-col row — #1 dominant (`md:col-span-6`, keeps the
   `Card selected` / "#1 · Safest banker" accent treatment), #2 & #3 compact (`md:col-span-3`). The
   compact `PickCard` was rebuilt as a vertical mini-card (badge · team · win% · scouting · full-width
   "Back this pick") so it reads well both stacked and in a narrow column. No horizontal scroller.
2. **Fixture row — back either team, lock out used teams.** `FixtureRow` no longer shows a single
   favoured "Back". A new `buildSidePick(fixture, isHome)` yields a RankedPick for either side; a
   per-side controls row renders under the summary — a "Back <team>" button per side (opens the same
   `SubmitConfirmSheet`), or, for a team already spent this season, a disabled locked control
   "Used · GW<n>" (Lock icon) with that side's `ClubBadge` in the `used` state. The spent round comes
   from a new `usedGwByTeamId` map derived from the entry's real submitted `picks` (not re-derived).
   Back buttons sit outside the expand-toggle button (no nested buttons).
3. **Divergence callout.** Confirmed the "Model X% · Market Y% — worth a look" callout is not present
   in the current fixtures list on `staging` — nothing to remove. (The unrelated "Market unavailable —
   model estimate" availability badge is left as-is; flagged for Phil.)

Verify: `npx tsc --noEmit` (0), `npm test` (51 passing), `npm run build` (exit 0). Renders at 360/1280.
