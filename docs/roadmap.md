# Roadmap

Work is split into streams, one PR at a time. **FPL first, then LMS.**

## FPL stream
| ID | Task | Status |
|----|------|--------|
| FPL-0  | Validate & tune the projection model (fix inflated projections) | prompt issued |
| FPL-1a | Squad picker: manual entry (`/squad/edit`) | in review ([PR #2](https://github.com/Phil-Zepza/AssistantManager/pull/2)); optimizer split to FPL-1b |
| FPL-1b | Strategy-aware optimizer (auto-suggest optimal £100m squad) | next |
| FPL-1  | Recommendation engine: best XI, captain/vice, best transfer (−4 maths) | queued |
| FPL-2  | Chip strategy advice (WC / BB / TC / FH timing from fixtures) | backlog |
| FPL-3  | Multi-gameweek expected-points horizon (horizon > 1) | backlog |

## LMS stream (after FPL)
| ID | Task | Status |
|----|------|--------|
| LMS-1 | Multi-round planner: rank only 7+-game rounds, respect used teams, save bankers | backlog |
| LMS-2 | Used-teams tracking + survival state per user | backlog |

## Cross-cutting
| ID | Task | Status |
|----|------|--------|
| X-1 | History / accuracy: back-fill recommendations_log.outcome + /history view | backlog |
| X-2 | Weekly scheduled reminder before deadlines | backlog |
| X-3 | Hardening: log the middleware auth-catch instead of swallowing it | backlog |

## Product decisions baked in
- Squad picker: **strategy-aware optimizer** (not just manual entry).
- Model: **tuned first** — everything depends on trustworthy projections.
- Budget: initial squad ≤ £100.0m (sum of prices); transfers use bank + sell value
  (sell value ≈ current price for now; real bank only known after a GW deadline).
- All 587 players are already in the `players` table (pipeline seeds/refreshes them).
