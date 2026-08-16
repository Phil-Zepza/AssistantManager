"""Model v1 — transparent heuristics for FPL/LMS.

Three concerns, all as PURE functions (data in -> rows/values out) so they are
trivially unit-testable offline:

  (a) team Elo: seed from bootstrap strengths, update from finished fixtures;
  (b) Poisson fixture win probabilities from Elo-derived attack/defence;
  (c) per-player expected FPL points (EP) for the next GW.

Everything tunable lives in the CONSTANTS block below. Refine later — search
for `# TODO`.
"""
from __future__ import annotations

import math
from typing import Optional

# ============================ TUNABLE CONSTANTS ============================
# --- Elo ---
ELO_BASE = 1500.0            # league-average team rating
ELO_PROMOTED = 1420.0        # rough floor for freshly-promoted / weakest sides
ELO_SEED_SCALE = 0.5         # maps bootstrap strength deviation -> Elo points
ELO_K = 20.0                 # Elo update step size
ELO_HOME_ADV = 60.0          # home side gets +60 Elo when computing expectation
ELO_DIV = 400.0             # standard Elo logistic divisor

# --- Poisson / expected goals ---
LEAGUE_AVG_GOALS = 1.40      # avg goals per team per game (PL ~2.8 total / 2)
HOME_ADV_GOAL_MULT = 1.15    # home scoring boost / away suppression
XG_MIN, XG_MAX = 0.15, 5.0   # clamp expected goals to a sane range
MAX_GOALS = 8                # score-matrix dimension (0..8 inclusive)

# --- Player expected points ---
POSITION_BY_ELEMENT_TYPE = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
GOAL_POINTS = {"GK": 6, "DEF": 6, "MID": 5, "FWD": 4}
ASSIST_POINTS = 3
CLEAN_SHEET_POINTS = {"GK": 4, "DEF": 4, "MID": 1, "FWD": 0}
APPEARANCE_60_POINTS = 2.0   # points for playing 60+ minutes
DEFCON_POINTS = 2.0
DEFCON_THRESHOLD = {"GK": 10.0, "DEF": 10.0, "MID": 12.0, "FWD": 12.0}
DEFAULT_START_RATE = 0.70    # assumed start likelihood when 'starts_per_90' absent
MINUTES_IF_START = 85.0      # expected minutes for a nominal starter
STATUS_AVAIL = {"a": 1.0, "d": 0.5, "i": 0.0, "s": 0.0, "u": 0.0, "n": 0.0}
BONUS_PER_BPS = 0.02         # bonus EP per (bps-per-start) point
BONUS_CAP = 1.0              # max bonus EP contribution


# ============================ small helpers ============================
def _f(x, default: float = 0.0) -> float:
    """Coerce FPL API values (often strings / None) to float."""
    if x is None or x == "":
        return default
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _poisson_pmf(k: int, lam: float) -> float:
    return math.exp(-lam) * lam ** k / math.factorial(k)


# ============================ (a) Elo ============================
def seed_elo(teams: list[dict]) -> dict[int, float]:
    """Seed each team's Elo from bootstrap `strength_overall_home/away`.

    Uses the average overall strength as an early-season proxy: teams above the
    league mean start above 1500, weakest sides land near ELO_PROMOTED.
    """
    overalls: dict[int, float] = {}
    for t in teams:
        home = _f(t.get("strength_overall_home"))
        away = _f(t.get("strength_overall_away"))
        overalls[t["id"]] = (home + away) / 2.0

    vals = [v for v in overalls.values() if v > 0]
    mean = sum(vals) / len(vals) if vals else 0.0

    elo: dict[int, float] = {}
    for tid, ov in overalls.items():
        if ov <= 0 or mean <= 0:
            elo[tid] = ELO_BASE
        else:
            seeded = ELO_BASE + ELO_SEED_SCALE * (ov - mean)
            # don't let a proxy pull anyone below the promoted floor
            elo[tid] = max(ELO_PROMOTED, seeded)
    return elo


def update_elo(elo: dict[int, float], finished_fixtures: list[dict]) -> dict[int, float]:
    """Apply Elo updates for finished fixtures (processed in kickoff order).

    Each fixture dict needs: home_team, away_team, home_score, away_score.
    K=ELO_K, home advantage ELO_HOME_ADV, scaled by goal difference. Pure:
    returns a NEW dict, does not mutate the input.
    """
    out = dict(elo)
    ordered = sorted(
        finished_fixtures, key=lambda fx: (fx.get("kickoff") or "", fx.get("fpl_id") or 0)
    )
    for fx in ordered:
        h, a = fx.get("home_team"), fx.get("away_team")
        hs, as_ = fx.get("home_score"), fx.get("away_score")
        if h is None or a is None or hs is None or as_ is None:
            continue
        eh = out.get(h, ELO_BASE)
        ea = out.get(a, ELO_BASE)

        # expected result for the home side, with home advantage baked in
        exp_home = 1.0 / (1.0 + 10 ** ((ea - (eh + ELO_HOME_ADV)) / ELO_DIV))
        if hs > as_:
            actual_home = 1.0
        elif hs == as_:
            actual_home = 0.5
        else:
            actual_home = 0.0

        gd = abs(hs - as_)
        gd_mult = math.log(gd + 1)  # 0 for a draw, grows with margin
        delta = ELO_K * gd_mult * (actual_home - exp_home)
        out[h] = eh + delta
        out[a] = ea - delta
    return out


# ============================ (b) Poisson fixture probs ============================
def team_strengths_from_elo(elo: dict[int, float]) -> dict[int, tuple[float, float]]:
    """Map each team's Elo -> (attack, defence) expected-goal ratings.

    attack  = goals we'd expect vs an average defence,
    defence = goals we'd expect to concede vs an average attack.
    Derived from a single multiplicative strength s = 10^((elo-BASE)/DIV).
    """
    strengths: dict[int, tuple[float, float]] = {}
    for tid, e in elo.items():
        s = 10 ** ((e - ELO_BASE) / ELO_DIV)
        attack = LEAGUE_AVG_GOALS * s
        defence = LEAGUE_AVG_GOALS / s
        strengths[tid] = (attack, defence)
    return strengths


def expected_goals(
    home_id: int, away_id: int, strengths: dict[int, tuple[float, float]]
) -> tuple[float, float]:
    """Expected goals (home, away) for a fixture, with home advantage."""
    ha, hd = strengths.get(home_id, (LEAGUE_AVG_GOALS, LEAGUE_AVG_GOALS))
    aa, ad = strengths.get(away_id, (LEAGUE_AVG_GOALS, LEAGUE_AVG_GOALS))
    exp_h = ha * ad / LEAGUE_AVG_GOALS * HOME_ADV_GOAL_MULT
    exp_a = aa * hd / LEAGUE_AVG_GOALS / HOME_ADV_GOAL_MULT
    return _clamp(exp_h, XG_MIN, XG_MAX), _clamp(exp_a, XG_MIN, XG_MAX)


def poisson_match_probs(exp_h: float, exp_a: float) -> dict[str, float]:
    """Build a 0..MAX_GOALS score matrix -> p_home / p_draw / p_away.

    Returns dict with p_home, p_draw, p_away, exp_goals_h, exp_goals_a.
    Probabilities are normalised to sum to exactly 1.0 (the small mass beyond
    MAX_GOALS goals is redistributed, which matters for high-xG fixtures).
    """
    home_pmf = [_poisson_pmf(i, exp_h) for i in range(MAX_GOALS + 1)]
    away_pmf = [_poisson_pmf(j, exp_a) for j in range(MAX_GOALS + 1)]
    p_home = p_draw = p_away = 0.0
    for i in range(MAX_GOALS + 1):
        for j in range(MAX_GOALS + 1):
            p = home_pmf[i] * away_pmf[j]
            if i > j:
                p_home += p
            elif i == j:
                p_draw += p
            else:
                p_away += p
    total = p_home + p_draw + p_away
    if total > 0:
        p_home, p_draw, p_away = p_home / total, p_draw / total, p_away / total
    return {
        "p_home": p_home,
        "p_draw": p_draw,
        "p_away": p_away,
        "exp_goals_h": exp_h,
        "exp_goals_a": exp_a,
    }


def fixture_prob_row(fixture: dict, strengths: dict[int, tuple[float, float]]) -> dict:
    """Full model_fixture_probs row for one fixture."""
    exp_h, exp_a = expected_goals(fixture["home_team"], fixture["away_team"], strengths)
    probs = poisson_match_probs(exp_h, exp_a)
    return {"fixture_id": fixture["fpl_id"], **probs}


# ============================ (c) Player expected points ============================
def expected_minutes(player: dict) -> tuple[float, float]:
    """(p_start, expected_minutes) from status / chance_next / starts_per_90."""
    status = (player.get("status") or "a").lower()
    chance = player.get("chance_next")
    if chance is not None and chance != "":
        avail = _f(chance) / 100.0
    else:
        avail = STATUS_AVAIL.get(status, 0.5)

    start_rate = _f(player.get("starts_per_90"), default=0.0)
    if start_rate <= 0:
        start_rate = DEFAULT_START_RATE
    start_rate = _clamp(start_rate, 0.0, 1.0)

    p_start = avail * start_rate
    exp_min = p_start * MINUTES_IF_START
    return p_start, exp_min


def compute_player_ep(
    player: dict,
    exp_goals_for: Optional[float],
    exp_goals_against: Optional[float],
) -> float:
    """Expected FPL points for a player in one upcoming fixture.

    `exp_goals_for` / `exp_goals_against` come from that GW's fixture model for
    the player's team. If the team has no fixture (blank GW) pass None -> 0.0.
    Returns a non-negative float.
    """
    if exp_goals_for is None or exp_goals_against is None:
        return 0.0

    pos = POSITION_BY_ELEMENT_TYPE.get(player.get("element_type"), "MID")
    p_start, exp_min = expected_minutes(player)
    if p_start <= 0:
        return 0.0
    minutes_frac = exp_min / 90.0

    # appearance points (assume a starter reaches 60'+): p_start * 2
    ep_appearance = p_start * APPEARANCE_60_POINTS

    # attacking: per-90 xG/xA -> points, scaled by minutes and fixture ease.
    xg90 = _f(player.get("expected_goals_per_90"))
    xa90 = _f(player.get("expected_assists_per_90"))
    att_mult = exp_goals_for / LEAGUE_AVG_GOALS  # opponent-defence / fixture-ease proxy
    ep_attack = (xg90 * GOAL_POINTS[pos] + xa90 * ASSIST_POINTS) * minutes_frac * att_mult

    # clean sheet: needs 60'+, so scale by p_start. P(CS) = P(opp scores 0).
    p_cs = math.exp(-exp_goals_against)
    ep_cs = CLEAN_SHEET_POINTS[pos] * p_cs * p_start

    # defensive contribution (DEFCON) — +2 if per-90 clears position threshold.
    defcon90 = _f(player.get("defensive_contribution_per_90"))
    thresh = DEFCON_THRESHOLD[pos]
    p_defcon = _clamp(defcon90 / thresh, 0.0, 1.0) if thresh > 0 else 0.0
    ep_defcon = DEFCON_POINTS * p_defcon * minutes_frac  # TODO: use true CBIT distribution

    # bonus: rough estimate from bonus-point-system per start.  TODO: use bps trend
    starts = _f(player.get("starts"))
    bps_per_start = _f(player.get("bps")) / starts if starts > 0 else 0.0
    ep_bonus = _clamp(bps_per_start * BONUS_PER_BPS, 0.0, BONUS_CAP) * minutes_frac

    total = ep_appearance + ep_attack + ep_cs + ep_defcon + ep_bonus
    return max(0.0, total)


def player_ep_row(
    player: dict,
    gw: int,
    exp_goals_for: Optional[float],
    exp_goals_against: Optional[float],
    horizon: int = 1,
) -> dict:
    """Full model_player_ep row for one player/GW."""
    ep = compute_player_ep(player, exp_goals_for, exp_goals_against)
    return {
        "player_id": player["id"],
        "gw": gw,
        "horizon": horizon,
        "expected_points": round(ep, 3),
    }


# ============================ offline self-check ============================
if __name__ == "__main__":
    # Synthetic data — no network. Proves probs sum to ~1 and EP is non-negative.
    teams = [
        {"id": 1, "strength_overall_home": 1350, "strength_overall_away": 1330},  # strong
        {"id": 2, "strength_overall_home": 1080, "strength_overall_away": 1060},  # weak
        {"id": 3, "strength_overall_home": 1200, "strength_overall_away": 1200},  # average
    ]
    elo = seed_elo(teams)
    assert elo[1] > elo[3] > elo[2], f"seeding order wrong: {elo}"

    finished = [
        {"fpl_id": 10, "kickoff": "2025-08-16T14:00:00Z",
         "home_team": 2, "away_team": 1, "home_score": 0, "away_score": 3},
    ]
    elo2 = update_elo(elo, finished)
    assert elo2[1] > elo[1] and elo2[2] < elo[2], "big away win should shift Elo"

    strengths = team_strengths_from_elo(elo2)

    checked = 0
    for home, away in [(1, 2), (2, 1), (3, 3), (2, 3)]:
        probs = poisson_match_probs(*expected_goals(home, away, strengths))
        total = probs["p_home"] + probs["p_draw"] + probs["p_away"]
        assert abs(total - 1.0) < 1e-3, f"probs don't sum to 1: {total} for {home}-{away}"
        assert probs["exp_goals_h"] > 0 and probs["exp_goals_a"] > 0
        checked += 1
    # stronger home team should be favoured
    p12 = poisson_match_probs(*expected_goals(1, 2, strengths))
    assert p12["p_home"] > p12["p_away"], "strong home team should be favourite"

    players = [
        # regular attacking MID, easy fixture
        {"id": 101, "element_type": 3, "status": "a", "chance_next": None,
         "starts_per_90": 0.95, "expected_goals_per_90": 0.45,
         "expected_assists_per_90": 0.30, "defensive_contribution_per_90": 3.0,
         "bps": 600, "starts": 30},
        # solid DEF, decent defcon
        {"id": 102, "element_type": 2, "status": "a", "chance_next": None,
         "starts_per_90": 0.9, "expected_goals_per_90": 0.05,
         "expected_assists_per_90": 0.08, "defensive_contribution_per_90": 12.0,
         "bps": 400, "starts": 30},
        # injured player -> should be zero
        {"id": 103, "element_type": 4, "status": "i", "chance_next": 0,
         "starts_per_90": 0.8, "expected_goals_per_90": 0.6,
         "expected_assists_per_90": 0.2, "defensive_contribution_per_90": 1.0,
         "bps": 500, "starts": 25},
    ]
    exp_for, exp_against = expected_goals(1, 2, strengths)
    eps = {}
    for p in players:
        row = player_ep_row(p, gw=1, exp_goals_for=exp_for, exp_goals_against=exp_against)
        eps[p["id"]] = row["expected_points"]
        assert row["expected_points"] >= 0.0, f"negative EP: {row}"
    assert eps[103] == 0.0, "injured player should have 0 EP"
    assert eps[101] > 0.0 and eps[102] > 0.0

    print("OK  models.py self-check passed")
    print(f"  seeded Elo:        {{1:{elo[1]:.0f}, 2:{elo[2]:.0f}, 3:{elo[3]:.0f}}}")
    print(f"  Elo after 0-3:     {{1:{elo2[1]:.0f}, 2:{elo2[2]:.0f}}}")
    print(f"  fixtures checked:  {checked} (all probs summed to 1.000 +/- 1e-3)")
    print(f"  1 vs 2 probs:      p_home={p12['p_home']:.3f} "
          f"p_draw={p12['p_draw']:.3f} p_away={p12['p_away']:.3f} "
          f"(xg {p12['exp_goals_h']:.2f}-{p12['exp_goals_a']:.2f})")
    print(f"  player EP (gw1):   MID#101={eps[101]:.2f}  DEF#102={eps[102]:.2f}  "
          f"INJ#103={eps[103]:.2f}")
