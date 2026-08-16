"""FPL/LMS pipeline entrypoint.

Runs the 5 steps from SPEC.md 'What the pipeline must do':
  1. fetch bootstrap + fixtures -> upsert teams / players / fixtures / gameweeks
  2. update Elo from finished fixtures -> model_fixture_probs for upcoming GWs
  3. model_player_ep for the next GW
  4. per-user squads + recommendations_log
  5. all upserts idempotent; one summary line per step

Run locally:  DATABASE_URL=... python pipeline/run.py
Requires env: DATABASE_URL (Railway Postgres connection string)
"""
from __future__ import annotations

import sys
import traceback
from collections import defaultdict
from typing import Optional

import fpl_api
import models
from db import connect, query, replace_recommendation, upsert


# ------------------------------ small helpers ------------------------------
def _to_float(x) -> Optional[float]:
    if x is None or x == "":
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _find_current_gw(events: list[dict]) -> Optional[int]:
    for e in events:
        if e.get("is_current"):
            return e["id"]
    return None


def _find_next_gw(events: list[dict]) -> Optional[int]:
    for e in events:
        if e.get("is_next"):
            return e["id"]
    # fall back to first unfinished GW
    for e in events:
        if not e.get("finished"):
            return e["id"]
    return None


# ------------------------------ row builders ------------------------------
def build_team_rows(teams: list[dict]) -> list[dict]:
    return [
        {
            "fpl_id": t["id"],
            "name": t["name"],
            "short_name": t["short_name"],
        }
        for t in teams
    ]


def build_player_rows(elements: list[dict]) -> list[dict]:
    rows = []
    for e in elements:
        rows.append(
            {
                "fpl_id": e["id"],
                "web_name": e["web_name"],
                "first_name": e.get("first_name"),
                "second_name": e.get("second_name"),
                "team_id": e["team"],
                "position": models.POSITION_BY_ELEMENT_TYPE.get(e["element_type"], "MID"),
                "price": e["now_cost"],  # tenths of a million
                "status": e.get("status"),
                "chance_next": e.get("chance_of_playing_next_round"),
                "selected_by": _to_float(e.get("selected_by_percent")),
                "form": _to_float(e.get("form")),
            }
        )
    return rows


def build_fixture_rows(fixtures: list[dict]) -> list[dict]:
    return [
        {
            "fpl_id": f["id"],
            "gw": f.get("event"),
            "home_team": f.get("team_h"),
            "away_team": f.get("team_a"),
            "kickoff": f.get("kickoff_time"),
            "home_diff": f.get("team_h_difficulty"),
            "away_diff": f.get("team_a_difficulty"),
            "home_score": f.get("team_h_score"),
            "away_score": f.get("team_a_score"),
            "finished": bool(f.get("finished")),
        }
        for f in fixtures
    ]


def build_gameweek_rows(events: list[dict], fixture_rows: list[dict]) -> list[dict]:
    counts: dict[int, int] = defaultdict(int)
    for fx in fixture_rows:
        if fx["gw"] is not None:
            counts[fx["gw"]] += 1
    # lms_eligible is a generated column — do NOT set it here.
    return [
        {
            "gw": e["id"],
            "deadline": e.get("deadline_time"),
            "num_fixtures": counts.get(e["id"], 0),
            "finished": bool(e.get("finished")),
        }
        for e in events
    ]


# ------------------------------ pipeline steps ------------------------------
def step1_reference_data(conn, bootstrap, fixtures):
    team_rows = build_team_rows(bootstrap["teams"])
    player_rows = build_player_rows(bootstrap["elements"])
    fixture_rows = build_fixture_rows(fixtures)
    gw_rows = build_gameweek_rows(bootstrap["events"], fixture_rows)

    upsert(conn, "teams", team_rows, "fpl_id")
    upsert(conn, "players", player_rows, "fpl_id")
    upsert(conn, "fixtures", fixture_rows, "fpl_id")
    upsert(conn, "gameweeks", gw_rows, "gw")

    print(
        f"[step 1] reference data: {len(team_rows)} teams, {len(player_rows)} players, "
        f"{len(fixture_rows)} fixtures, {len(gw_rows)} gameweeks"
    )
    return fixture_rows


def step2_elo_and_fixture_probs(conn, bootstrap, fixture_rows):
    """Return (strengths, exp_goals_by_fixture) for reuse in step 3."""
    elo = models.seed_elo(bootstrap["teams"])

    finished = [
        fx
        for fx in fixture_rows
        if fx["finished"] and fx["home_score"] is not None and fx["away_score"] is not None
    ]
    elo = models.update_elo(elo, finished)
    strengths = models.team_strengths_from_elo(elo)

    # persist Elo + derived attack/defence ratings back onto teams.
    # Include name/short_name so the INSERT candidate satisfies NOT NULL
    # (ON CONFLICT still just updates the rows already inserted in step 1).
    team_meta = {t["id"]: t for t in bootstrap["teams"]}
    team_updates = []
    for tid, (attack, defence) in strengths.items():
        meta = team_meta.get(tid, {})
        team_updates.append(
            {
                "fpl_id": tid,
                "name": meta.get("name"),
                "short_name": meta.get("short_name"),
                "elo": round(elo[tid], 1),
                "strength_attack": round(attack, 3),
                "strength_defence": round(defence, 3),
            }
        )
    upsert(conn, "teams", team_updates, "fpl_id")

    # fixture probs for every upcoming (not-finished) fixture with a GW assigned
    prob_rows = []
    exp_goals_by_fixture: dict[int, tuple[float, float]] = {}
    for fx in fixture_rows:
        if fx["finished"] or fx["gw"] is None:
            continue
        if fx["home_team"] is None or fx["away_team"] is None:
            continue
        row = models.fixture_prob_row(fx, strengths)
        prob_rows.append(
            {
                "fixture_id": row["fixture_id"],
                "p_home": round(row["p_home"], 4),
                "p_draw": round(row["p_draw"], 4),
                "p_away": round(row["p_away"], 4),
                "exp_goals_h": round(row["exp_goals_h"], 3),
                "exp_goals_a": round(row["exp_goals_a"], 3),
            }
        )
        exp_goals_by_fixture[fx["fpl_id"]] = (row["exp_goals_h"], row["exp_goals_a"])

    upsert(conn, "model_fixture_probs", prob_rows, "fixture_id")
    print(
        f"[step 2] elo updated from {len(finished)} finished fixtures; "
        f"wrote {len(prob_rows)} fixture probabilities"
    )
    return strengths, exp_goals_by_fixture


def step3_player_ep(conn, bootstrap, fixture_rows, exp_goals_by_fixture, next_gw):
    if next_gw is None:
        print("[step 3] no upcoming GW found; skipped player EP")
        return next_gw

    # map team -> list of (exp_goals_for, exp_goals_against) across its GW fixtures
    team_fixture_xg: dict[int, list[tuple[float, float]]] = defaultdict(list)
    for fx in fixture_rows:
        if fx["gw"] != next_gw or fx["fpl_id"] not in exp_goals_by_fixture:
            continue
        exp_h, exp_a = exp_goals_by_fixture[fx["fpl_id"]]
        team_fixture_xg[fx["home_team"]].append((exp_h, exp_a))  # home: for=h, against=a
        team_fixture_xg[fx["away_team"]].append((exp_a, exp_h))  # away: for=a, against=h

    # games each team has played (denominator for minutes-based nailed-ness)
    team_games = models.team_games_played(bootstrap["elements"])

    ep_rows = []
    for e in bootstrap["elements"]:
        fixtures_for_team = team_fixture_xg.get(e["team"], [])
        tg = team_games.get(e["team"])
        if not fixtures_for_team:
            # blank GW for this player's team -> 0 EP
            ep = 0.0
        else:
            # double GWs: sum EP across each fixture the team plays
            ep = sum(
                models.compute_player_ep(e, gf, ga, tg) for gf, ga in fixtures_for_team
            )
        ep_rows.append(
            {
                "player_id": e["id"],
                "gw": next_gw,
                "horizon": 1,
                "expected_points": round(ep, 3),
            }
        )

    upsert(conn, "model_player_ep", ep_rows, "player_id,gw,horizon")
    print(f"[step 3] wrote model_player_ep for GW{next_gw}: {len(ep_rows)} players")
    return next_gw


def step4_users(conn, current_gw, next_gw):
    users = query(conn, "SELECT * FROM users")
    entrants = [u for u in users if u.get("fpl_entry_id")]
    if not entrants:
        print("[step 4] no users with fpl_entry_id; skipped")
        return

    # EP lookup for the next GW to drive captain / transfer recs
    ep_rows = query(
        conn,
        "SELECT player_id, expected_points FROM model_player_ep "
        "WHERE gw = %s AND horizon = 1",
        (next_gw,),
    )
    ep_by_player = {r["player_id"]: r["expected_points"] for r in ep_rows}

    # fixture probs -> best LMS team for the next GW (highest outright win prob)
    lms_rec = _best_lms_team(conn, next_gw)

    squads_written = recs_written = 0
    for u in entrants:
        try:
            squads_written += _sync_user_squad(conn, u, current_gw)
            recs_written += _write_user_recs(
                conn, u, next_gw, ep_by_player, lms_rec
            )
        except Exception as exc:  # keep other users going
            print(f"  ! user {u.get('id')} failed: {exc}")

    print(
        f"[step 4] processed {len(entrants)} user(s); "
        f"{squads_written} squad rows, {recs_written} recommendations"
    )


def _sync_user_squad(conn, user, current_gw) -> int:
    if current_gw is None:
        return 0
    picks = fpl_api.get_entry_picks(user["fpl_entry_id"], current_gw)
    if not picks or "picks" not in picks:
        return 0  # 404 before deadline, or no data
    rows = []
    for p in picks["picks"]:
        rows.append(
            {
                "user_id": user["id"],
                "gw": current_gw,
                "player_id": p["element"],
                "is_captain": bool(p.get("is_captain")),
                "is_vice": bool(p.get("is_vice_captain")),
                "on_bench": p.get("position", 0) > 11,
            }
        )
    return upsert(conn, "user_squad", rows, "user_id,gw,player_id")


def _best_lms_team(conn, next_gw) -> Optional[dict]:
    """Highest outright win probability among next-GW fixtures (LMS-eligible)."""
    if next_gw is None:
        return None
    gw_row = query(
        conn, "SELECT lms_eligible FROM gameweeks WHERE gw = %s", (next_gw,)
    )
    if gw_row and gw_row[0].get("lms_eligible") is False:
        # still return a pick, but note it's not a "clean" LMS round
        pass
    fixtures = query(
        conn,
        "SELECT fpl_id, home_team, away_team FROM fixtures "
        "WHERE gw = %s AND finished = false",
        (next_gw,),
    )
    if not fixtures:
        return None
    probs = query(
        conn, "SELECT fixture_id, p_home, p_away FROM model_fixture_probs"
    )
    prob_by_fx = {r["fixture_id"]: r for r in probs}

    best = None  # (team_id, win_prob, fixture_id, is_home)
    for fx in fixtures:
        pr = prob_by_fx.get(fx["fpl_id"])
        if not pr:
            continue
        for team_id, win_p, is_home in (
            (fx["home_team"], pr["p_home"], True),
            (fx["away_team"], pr["p_away"], False),
        ):
            if best is None or win_p > best[1]:
                best = (team_id, win_p, fx["fpl_id"], is_home)
    if best is None:
        return None
    return {"team_id": best[0], "win_prob": best[1], "fixture_id": best[2], "is_home": best[3]}


def _write_user_recs(conn, user, next_gw, ep_by_player, lms_rec) -> int:
    if next_gw is None:
        return 0
    written = 0

    # captain: highest-EP player the user currently owns (latest squad we have)
    squad = query(
        conn,
        "SELECT player_id, gw FROM user_squad WHERE user_id = %s ORDER BY gw DESC",
        (user["id"],),
    )
    if squad:
        latest_gw = squad[0]["gw"]
        owned = [s["player_id"] for s in squad if s["gw"] == latest_gw]
        ranked = sorted(owned, key=lambda pid: ep_by_player.get(pid, 0.0), reverse=True)
        if ranked:
            cap = ranked[0]
            written += replace_recommendation(
                conn, user["id"], next_gw, "fpl_captain",
                {"player_id": cap, "expected_points": ep_by_player.get(cap, 0.0)},
            )

    # lms pick: best win-prob team not already used by this user
    if lms_rec:
        used = query(
            conn, "SELECT team_id FROM lms_picks WHERE user_id = %s", (user["id"],)
        )
        used_ids = {r["team_id"] for r in used}
        if lms_rec["team_id"] not in used_ids:
            written += replace_recommendation(
                conn, user["id"], next_gw, "lms_pick",
                {
                    "team_id": lms_rec["team_id"],
                    "win_prob": lms_rec["win_prob"],
                    "fixture_id": lms_rec["fixture_id"],
                    "note": "strict rules: a draw eliminates you",
                },
            )
    return written


# ------------------------------ main ------------------------------
def main() -> int:
    print("Fetching FPL API ...")
    bootstrap = fpl_api.get_bootstrap_static()
    fixtures = fpl_api.get_fixtures()
    events = bootstrap["events"]
    current_gw = _find_current_gw(events)
    next_gw = _find_next_gw(events)
    print(f"  current GW = {current_gw}, next GW = {next_gw}")

    with connect() as conn:
        fixture_rows = step1_reference_data(conn, bootstrap, fixtures)
        _, exp_goals_by_fixture = step2_elo_and_fixture_probs(conn, bootstrap, fixture_rows)
        step3_player_ep(conn, bootstrap, fixture_rows, exp_goals_by_fixture, next_gw)
        step4_users(conn, current_gw, next_gw)

    print("Pipeline complete.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
