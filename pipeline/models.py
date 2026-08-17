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
MINUTES_IF_START = 85.0      # expected minutes for a nominal starter
STATUS_AVAIL = {"a": 1.0, "d": 0.5, "i": 0.0, "s": 0.0, "u": 0.0, "n": 0.0}
BONUS_PER_BPS = 0.02         # bonus EP per (bps-per-start) point
BONUS_CAP = 1.0              # max bonus EP contribution

# --- per-90 rate regression (small-sample shrinkage) ---
# Per-90 rates from the FPL API are noise for low-minute players (a 2-minute
# cameo can read xG/90 = 3.6). Shrink each rate toward a position prior with a
# minutes-weighted Bayesian mean:
#     rate_adj = (minutes * rate + k * prior) / (minutes + k)
# so a player must log real minutes before a high rate is believed. Priors are
# the season medians for established players (>1500 min) per position.
RATE_REGRESSION_K = 900.0    # prior weight, in "minutes" (~10 full matches)
XG90_PRIOR = {"GK": 0.00, "DEF": 0.06, "MID": 0.13, "FWD": 0.45}
XA90_PRIOR = {"GK": 0.00, "DEF": 0.06, "MID": 0.13, "FWD": 0.06}
DEFCON90_PRIOR = {"GK": 0.0, "DEF": 8.0, "MID": 8.0, "FWD": 4.5}

# --- expected minutes / nailed-ness ---
# Start likelihood is derived from minutes actually played, NOT a flat default:
#     played_frac = minutes / (team_games * 90)        # share of team minutes
# blended with starts_per_90, weighting the starts signal by played_frac so a
# tiny sample can't fake a nailed starter. Genuine bench players -> ~0.
FALLBACK_TEAM_GAMES = 38     # full PL season, used only if a game count is absent

# --- fixture multiplier bounds ---
# An easy fixture must not triple output. Clamp the attack multiplier and the
# clean-sheet probability to sane bands.
ATT_MULT_MIN, ATT_MULT_MAX = 0.6, 1.6
CS_PROB_MIN, CS_PROB_MAX = 0.05, 0.55

# --- EP guardrail ---
EP_SOFT_CAP = 12.0           # EP above this is smoothly compressed (asymptotic)
EP_SANE_MAX = 15.0           # any single-GW EP above this is flagged implausible


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


def _regress(rate: float, minutes: float, prior: float, k: float = RATE_REGRESSION_K) -> float:
    """Minutes-weighted shrinkage of a per-90 `rate` toward `prior`.

    rate_adj = (minutes * rate + k * prior) / (minutes + k). With few minutes the
    result sits near `prior`; with many, near the observed `rate`.
    """
    denom = minutes + k
    return (minutes * rate + k * prior) / denom if denom > 0 else prior


def _soft_cap(x: float, cap: float) -> float:
    """Leave values <= cap untouched; smoothly compress the excess above it.

    Anything over `cap` asymptotes toward cap+1, so a runaway EP can never blow
    past the guardrail while legitimate values below the cap are unchanged.
    """
    if x <= cap:
        return x
    excess = x - cap
    return cap + excess / (1.0 + excess)


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
def team_games_played(elements: list[dict]) -> dict[int, float]:
    """Estimate games played per team from squad minutes.

    The `minutes` totals are measured over however many games a team has played,
    so the most-used player's minutes/90 is a robust proxy for that count
    (an ever-present player logs ~1 game per 90). Used as the denominator for
    minutes-based nailed-ness. Falls back to FALLBACK_TEAM_GAMES when unknown.
    """
    max_min: dict[int, float] = {}
    for e in elements:
        tid = e.get("team")
        if tid is None:
            continue
        m = _f(e.get("minutes"))
        if m > max_min.get(tid, 0.0):
            max_min[tid] = m
    return {tid: max(1.0, round(m / 90.0)) for tid, m in max_min.items()}


def expected_minutes(player: dict, team_games: Optional[float] = None) -> tuple[float, float]:
    """(p_start, expected_minutes) derived from minutes actually played.

    `team_games` is how many games the player's team has played (the basis the
    `minutes` total is measured over). Start likelihood is:

        played_frac = minutes / (team_games * 90)   # share of team minutes
        p_start     = avail * blend(played_frac, starts_per_90)

    where the starts_per_90 signal is trusted in proportion to played_frac, so a
    low-minute player cannot look nailed on a fluky sample. Availability
    (status / chance_next) is applied as a straight multiplier.
    """
    status = (player.get("status") or "a").lower()
    chance = player.get("chance_next")
    if chance is not None and chance != "":
        avail = _f(chance) / 100.0
    else:
        avail = STATUS_AVAIL.get(status, 0.5)

    tg = team_games if (team_games and team_games > 0) else FALLBACK_TEAM_GAMES
    minutes = _f(player.get("minutes"))
    played_frac = _clamp(minutes / (tg * 90.0), 0.0, 1.0)
    start_rate = _clamp(_f(player.get("starts_per_90")), 0.0, 1.0)

    # Evidence-weighted blend: weight = played_frac. With few minutes the blend
    # collapses to played_frac itself (~0); with a full season it lets a nailed
    # starter who gets subbed off (played_frac ~0.8, starts_per_90 ~1) rise to ~1.
    w = played_frac
    nailed = _clamp((1.0 - w) * played_frac + w * start_rate, 0.0, 1.0)

    p_start = avail * nailed
    exp_min = p_start * MINUTES_IF_START
    return p_start, exp_min


def compute_player_ep(
    player: dict,
    exp_goals_for: Optional[float],
    exp_goals_against: Optional[float],
    team_games: Optional[float] = None,
) -> float:
    """Expected FPL points for a player in one upcoming fixture.

    `exp_goals_for` / `exp_goals_against` come from that GW's fixture model for
    the player's team. If the team has no fixture (blank GW) pass None -> 0.0.
    `team_games` feeds the minutes-based nailed-ness (see `expected_minutes`).
    Returns a non-negative float, soft-capped at EP_SOFT_CAP.
    """
    if exp_goals_for is None or exp_goals_against is None:
        return 0.0

    pos = POSITION_BY_ELEMENT_TYPE.get(player.get("element_type"), "MID")
    p_start, exp_min = expected_minutes(player, team_games)
    if p_start <= 0:
        return 0.0
    minutes_frac = exp_min / 90.0
    minutes = _f(player.get("minutes"))

    # appearance points (assume a starter reaches 60'+): p_start * 2
    ep_appearance = p_start * APPEARANCE_60_POINTS

    # attacking: per-90 xG/xA -> points, scaled by minutes and fixture ease.
    # Per-90 rates are regressed to a position prior so small samples can't spike.
    xg90 = _regress(_f(player.get("expected_goals_per_90")), minutes, XG90_PRIOR[pos])
    xa90 = _regress(_f(player.get("expected_assists_per_90")), minutes, XA90_PRIOR[pos])
    # opponent-defence / fixture-ease proxy, bounded so an easy game can't triple EP
    att_mult = _clamp(exp_goals_for / LEAGUE_AVG_GOALS, ATT_MULT_MIN, ATT_MULT_MAX)
    ep_attack = (xg90 * GOAL_POINTS[pos] + xa90 * ASSIST_POINTS) * minutes_frac * att_mult

    # clean sheet: needs 60'+, so scale by p_start. P(CS) = P(opp scores 0),
    # clamped to a sane band so a very easy fixture can't imply a near-certain CS.
    p_cs = _clamp(math.exp(-exp_goals_against), CS_PROB_MIN, CS_PROB_MAX)
    ep_cs = CLEAN_SHEET_POINTS[pos] * p_cs * p_start

    # defensive contribution (DEFCON) — +2 if per-90 clears position threshold.
    defcon90 = _regress(
        _f(player.get("defensive_contribution_per_90")), minutes, DEFCON90_PRIOR[pos]
    )
    thresh = DEFCON_THRESHOLD[pos]
    p_defcon = _clamp(defcon90 / thresh, 0.0, 1.0) if thresh > 0 else 0.0
    ep_defcon = DEFCON_POINTS * p_defcon * minutes_frac  # TODO: use true CBIT distribution

    # bonus: rough estimate from bonus-point-system per start.  TODO: use bps trend
    starts = _f(player.get("starts"))
    bps_per_start = _f(player.get("bps")) / starts if starts > 0 else 0.0
    ep_bonus = _clamp(bps_per_start * BONUS_PER_BPS, 0.0, BONUS_CAP) * minutes_frac

    total = ep_appearance + ep_attack + ep_cs + ep_defcon + ep_bonus
    return _soft_cap(max(0.0, total), EP_SOFT_CAP)


def player_ep_row(
    player: dict,
    gw: int,
    exp_goals_for: Optional[float],
    exp_goals_against: Optional[float],
    horizon: int = 1,
    team_games: Optional[float] = None,
) -> dict:
    """Full model_player_ep row for one player/GW."""
    ep = compute_player_ep(player, exp_goals_for, exp_goals_against, team_games)
    return {
        "player_id": player["id"],
        "gw": gw,
        "horizon": horizon,
        "expected_points": round(ep, 3),
    }


# ============================ LMS auto-resolve ============================
# Pure settlement logic for LMS entry picks. Strict rules: a WIN survives; a
# DRAW or LOSS eliminates. Kept DB-free so it is unit-testable offline; the
# pipeline step (run.py step5) feeds it DB rows and applies the returned updates.


def resolve_lms_result(is_home: bool, home_score: int, away_score: int) -> str:
    """Outcome for a backed team in a finished fixture.

    win -> 'survived'; draw or loss -> 'eliminated' (strict: a draw is OUT).
    """
    team_score = home_score if is_home else away_score
    opp_score = away_score if is_home else home_score
    return "survived" if team_score > opp_score else "eliminated"


def resolve_lms_picks(pending_picks, fixtures_by_gw):
    """Settle a batch of pending LMS entry picks (pure).

    Args:
      pending_picks: list of {"id", "entry_id", "gw", "team_id"} (result='pending').
      fixtures_by_gw: {gw: {"all_finished": bool,
                            "by_team": {team_id: {"is_home", "home_score", "away_score"}}}}.

    Returns (pick_updates, entry_outs):
      pick_updates: [{"id", "result"}] for picks whose round is FULLY finished and
                    whose team actually played (win->survived, else eliminated).
      entry_outs:   {entry_id: eliminated_gw} = earliest gw each entry was eliminated.

    Only fully-finished rounds are settled; a pick whose team did not play that
    round (blank GW) is left pending. Idempotent by construction — callers pass
    ONLY currently-pending picks.
    """
    pick_updates = []
    entry_outs: dict[int, int] = {}
    for p in pending_picks:
        gw = p["gw"]
        fx = fixtures_by_gw.get(gw)
        if not fx or not fx.get("all_finished"):
            continue  # round not fully finished yet
        team_fx = fx.get("by_team", {}).get(p["team_id"])
        if not team_fx:
            continue  # blank GW / team didn't play -> leave pending
        result = resolve_lms_result(
            team_fx["is_home"], team_fx["home_score"], team_fx["away_score"]
        )
        pick_updates.append({"id": p["id"], "result": result})
        if result == "eliminated":
            prev = entry_outs.get(p["entry_id"])
            if prev is None or gw < prev:
                entry_outs[p["entry_id"]] = gw
    return pick_updates, entry_outs


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

    # team has played a full season -> minutes below are measured over 38 games
    TG = 38
    players = [
        # nailed attacking MID, easy fixture, full season of minutes
        {"id": 101, "element_type": 3, "status": "a", "chance_next": None,
         "minutes": 3200, "starts_per_90": 0.95, "expected_goals_per_90": 0.45,
         "expected_assists_per_90": 0.30, "defensive_contribution_per_90": 3.0,
         "bps": 600, "starts": 35},
        # solid nailed DEF, decent defcon
        {"id": 102, "element_type": 2, "status": "a", "chance_next": None,
         "minutes": 3150, "starts_per_90": 0.9, "expected_goals_per_90": 0.05,
         "expected_assists_per_90": 0.08, "defensive_contribution_per_90": 12.0,
         "bps": 400, "starts": 35},
        # injured player -> should be zero
        {"id": 103, "element_type": 4, "status": "i", "chance_next": 0,
         "minutes": 2000, "starts_per_90": 0.8, "expected_goals_per_90": 0.6,
         "expected_assists_per_90": 0.2, "defensive_contribution_per_90": 1.0,
         "bps": 500, "starts": 25},
        # FRINGE: 40-minute cameo with a fluky per-90 (the 16.6-pt bug). Regression
        # + minutes-based nailed-ness must keep this near zero, NOT near the top.
        {"id": 104, "element_type": 3, "status": "a", "chance_next": None,
         "minutes": 40, "starts_per_90": 0.0, "expected_goals_per_90": 3.6,
         "expected_assists_per_90": 0.0, "defensive_contribution_per_90": 0.0,
         "bps": 6, "starts": 0},
    ]
    exp_for, exp_against = expected_goals(1, 2, strengths)
    eps = {}
    for p in players:
        row = player_ep_row(
            p, gw=1, exp_goals_for=exp_for, exp_goals_against=exp_against, team_games=TG
        )
        eps[p["id"]] = row["expected_points"]
        assert row["expected_points"] >= 0.0, f"negative EP: {row}"
        # guardrail: no single-GW projection should exceed the sane maximum
        assert row["expected_points"] <= EP_SANE_MAX, f"implausible EP: {row}"
    assert eps[103] == 0.0, "injured player should have 0 EP"
    assert eps[101] > 0.0 and eps[102] > 0.0
    assert eps[104] < 1.0, f"fringe cameo should project near zero, got {eps[104]}"
    assert eps[101] > eps[104], "nailed premium must outrank a fringe cameo"

    # --- LMS auto-resolve (offline, stubbed finished fixtures) ---
    assert resolve_lms_result(True, 2, 0) == "survived"  # home win
    assert resolve_lms_result(False, 0, 1) == "survived"  # away win
    assert resolve_lms_result(True, 1, 1) == "eliminated"  # draw = OUT
    assert resolve_lms_result(False, 2, 0) == "eliminated"  # away loss
    stub_picks = [
        {"id": 1, "entry_id": 7, "gw": 1, "team_id": 100},  # home win  -> survived
        {"id": 2, "entry_id": 8, "gw": 1, "team_id": 200},  # away draw -> eliminated
        {"id": 3, "entry_id": 9, "gw": 2, "team_id": 100},  # gw2 not finished -> skip
        {"id": 4, "entry_id": 7, "gw": 1, "team_id": 999},  # blank GW (no fixture) -> skip
    ]
    stub_fixtures = {
        1: {
            "all_finished": True,
            "by_team": {
                100: {"is_home": True, "home_score": 2, "away_score": 0},
                200: {"is_home": False, "home_score": 1, "away_score": 1},
            },
        },
        2: {"all_finished": False, "by_team": {}},
    }
    lms_updates, lms_outs = resolve_lms_picks(stub_picks, stub_fixtures)
    upd_by_id = {u["id"]: u["result"] for u in lms_updates}
    assert upd_by_id == {1: "survived", 2: "eliminated"}, f"bad LMS updates: {lms_updates}"
    assert 3 not in upd_by_id and 4 not in upd_by_id, "unfinished/blank picks must skip"
    assert lms_outs == {8: 1}, f"entry 8 should flip out at gw1: {lms_outs}"

    print("OK  models.py self-check passed")
    print(f"  seeded Elo:        {{1:{elo[1]:.0f}, 2:{elo[2]:.0f}, 3:{elo[3]:.0f}}}")
    print(f"  Elo after 0-3:     {{1:{elo2[1]:.0f}, 2:{elo2[2]:.0f}}}")
    print(f"  fixtures checked:  {checked} (all probs summed to 1.000 +/- 1e-3)")
    print(f"  1 vs 2 probs:      p_home={p12['p_home']:.3f} "
          f"p_draw={p12['p_draw']:.3f} p_away={p12['p_away']:.3f} "
          f"(xg {p12['exp_goals_h']:.2f}-{p12['exp_goals_a']:.2f})")
    print(f"  player EP (gw1):   MID#101={eps[101]:.2f}  DEF#102={eps[102]:.2f}  "
          f"INJ#103={eps[103]:.2f}  FRINGE#104={eps[104]:.2f}")
    print(f"  guardrail:         soft cap {EP_SOFT_CAP}, sane max {EP_SANE_MAX} "
          f"(all {len(players)} test players within bounds)")
    print("  LMS resolve:       pick1->survived, pick2->eliminated, entry8 OUT@gw1")
