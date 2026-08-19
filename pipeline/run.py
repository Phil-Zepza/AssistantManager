"""FPL/LMS pipeline entrypoint.

Runs these steps (see SPEC.md 'What the pipeline must do'):
  1. fetch bootstrap + fixtures -> upsert teams / players / fixtures / gameweeks
  2. update Elo from finished fixtures -> model_fixture_probs for upcoming GWs
  3. model_player_ep for the next GW
  6. player_season_stats: current-season totals (bootstrap) + last-season
     totals (element-summary history_past) for the /lms scouting block
  4. per-user squads + recommendations_log
  5. auto-resolve finished LMS rounds -> settle lms_entry_picks + entry status
All upserts idempotent; one summary line per step.

Run locally:  DATABASE_URL=... python pipeline/run.py
Requires env: DATABASE_URL (Railway Postgres connection string)
"""
from __future__ import annotations

import logging
import os
import sys
import traceback
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import fpl_api
import models
import odds_api
from db import connect, query, replace_recommendation, upsert

logger = logging.getLogger("pipeline")


# ------------------------------ small helpers ------------------------------
def _to_float(x) -> Optional[float]:
    if x is None or x == "":
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _to_int(x) -> Optional[int]:
    if x is None or x == "":
        return None
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return None


def _season_label(events: list[dict]) -> Optional[str]:
    """Derive the current season label (e.g. "2026/27") from the events'
    earliest deadline year. The PL season starts in August, so the minimum
    deadline year is the season's opening year."""
    years = [
        int(e["deadline_time"][:4])
        for e in events
        if e.get("deadline_time")
    ]
    if not years:
        return None
    start = min(years)
    return f"{start}/{str(start + 1)[-2:]}"


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
    """Return (strengths, exp_goals_by_fixture) for reuse in step 3.

    Seeds each team's Elo straight from last season's strength proxy (see
    models.seed_elo) — no squad-value transfer modifier — then applies match
    updates from finished fixtures. Writes the MODEL distribution to both the
    canonical model_p_* columns and the SHOWN p_* columns; the odds step
    (step_odds_calibration) overwrites p_* with the market distribution for any
    fixture the book has priced. `market_available` is defaulted false here so a
    fixture the market no longer prices reverts to the model on the next run.
    """
    now = datetime.now(timezone.utc)
    seed = models.seed_elo(bootstrap["teams"])

    finished = [
        fx
        for fx in fixture_rows
        if fx["finished"] and fx["home_score"] is not None and fx["away_score"] is not None
    ]

    elo = models.update_elo(seed, finished)
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

    # fixture probs for every upcoming (not-finished) fixture with a GW assigned.
    # computed_at is set explicitly so it refreshes on every run: the column
    # default only fires on INSERT, so an ON CONFLICT UPDATE that omits it would
    # leave "last computed" stale even though the p_* values did update.
    # (reuse `now` stamped above so the SVI + prob rows share one run timestamp)
    prob_rows = []
    exp_goals_by_fixture: dict[int, tuple[float, float]] = {}
    for fx in fixture_rows:
        if fx["finished"] or fx["gw"] is None:
            continue
        if fx["home_team"] is None or fx["away_team"] is None:
            continue
        row = models.fixture_prob_row(fx, strengths)
        ph, pd, pa = round(row["p_home"], 4), round(row["p_draw"], 4), round(row["p_away"], 4)
        prob_rows.append(
            {
                "fixture_id": row["fixture_id"],
                # model distribution: canonical, always the model's own view.
                "model_p_home": ph,
                "model_p_draw": pd,
                "model_p_away": pa,
                # shown distribution: defaults to the model; the odds step
                # overwrites these with the market for any priced fixture.
                "p_home": ph,
                "p_draw": pd,
                "p_away": pa,
                # reset each run: true only once the odds step matches a book.
                "market_available": False,
                "exp_goals_h": round(row["exp_goals_h"], 3),
                "exp_goals_a": round(row["exp_goals_a"], 3),
                "computed_at": now,
            }
        )
        exp_goals_by_fixture[fx["fpl_id"]] = (row["exp_goals_h"], row["exp_goals_a"])

    upsert(conn, "model_fixture_probs", prob_rows, "fixture_id")
    print(
        f"[step 2] elo updated from {len(finished)} finished fixtures; "
        f"wrote {len(prob_rows)} fixture probabilities (model; market applied in odds step)"
    )
    return strengths, exp_goals_by_fixture


def record_pipeline_health(conn, step: str, status: str, detail: Optional[str] = None) -> None:
    """Append a visible health marker for `step` and commit it immediately.

    Append-only log so an outage leaves a durable, queryable trace even if a
    later step crashes and rolls back the rest of the run. Best-effort: a failure
    to write the marker (e.g. the table missing before its migration) is logged
    but never raised — health logging must not itself break the pipeline.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO pipeline_health (step, status, detail) VALUES (%s, %s, %s)",
                (step, status, detail),
            )
        conn.commit()
    except Exception as exc:  # noqa: BLE001 — health logging is best-effort
        logger.error("failed to record pipeline_health(%s, %s): %s", step, status, exc)


def step_odds_calibration(conn) -> None:
    """Hard switch: use the de-vigged MARKET distribution as the shown p_* for any
    fixture the book has priced; fixtures the market hasn't priced keep the model.

    Fetches h2h odds once from The Odds API, matches each event to our upcoming
    fixtures, takes the MEDIAN odds across bookmakers, de-vigs to implied
    probabilities, and for each matched fixture:
      * overwrites the shown p_home/p_draw/p_away with the (renormalised) market
        distribution and sets market_available = true,
      * persists market_p_* / market_odds_source / market_fetched_at, and
      * records market_divergence = |model_p - market_p| on the model's FAVOURED
        WIN SIDE (max of model_p_home/model_p_away), the team we most back to win.
    Fixtures with no market row keep market_available = false (set in step 2) and
    therefore keep showing the model — most such fixtures are simply future rounds.

    FAILS LOUD, not soft. A missing ODDS_API_KEY, a failed fetch, or an empty feed
    logs at ERROR and records a `pipeline_health` marker so the outage is
    impossible to miss. The run still completes and every fixture falls back to the
    model, but the health signal makes the degraded state visible.
    """
    api_key = os.environ.get("ODDS_API_KEY")
    if not api_key:
        logger.error(
            "ODDS_API_KEY is not set — market prices unavailable; "
            "ALL fixtures fall back to the model estimate this run"
        )
        record_pipeline_health(conn, "odds", "error", "ODDS_API_KEY not set")
        return

    try:
        events = odds_api.get_h2h_odds(api_key)
    except Exception as exc:  # noqa: BLE001 — surface loudly, but let the run finish on model
        logger.error("odds fetch failed (%s) — ALL fixtures fall back to the model estimate", exc)
        record_pipeline_health(conn, "odds", "error", f"fetch failed: {exc}")
        return

    if not events:
        logger.error("odds fetch returned no events — ALL fixtures fall back to the model estimate")
        record_pipeline_health(conn, "odds", "error", "empty odds feed")
        return

    # our upcoming fixtures with the MODEL distribution, keyed by (home_id, away_id).
    # Divergence is measured against model_p_* (the canonical model view), not the
    # shown p_* which this step is about to overwrite with the market.
    fx_rows = query(
        conn,
        "SELECT f.fpl_id, f.home_team, f.away_team, f.kickoff, "
        "       mp.model_p_home, mp.model_p_away "
        "  FROM fixtures f "
        "  JOIN model_fixture_probs mp ON mp.fixture_id = f.fpl_id "
        " WHERE f.finished = false AND f.gw IS NOT NULL",
    )
    fx_by_teams = {(r["home_team"], r["away_team"]): r for r in fx_rows}

    teams = query(conn, "SELECT fpl_id, name, short_name FROM teams")
    lookup = odds_api.build_team_lookup(teams)

    now = datetime.now(timezone.utc)
    rows = []
    matched = unmatched = flagged = 0
    for ev in events:
        home_id = odds_api.match_team_id(ev.get("home_team"), lookup)
        away_id = odds_api.match_team_id(ev.get("away_team"), lookup)
        fx = fx_by_teams.get((home_id, away_id))
        if fx is None or home_id is None or away_id is None:
            unmatched += 1
            continue

        mo = odds_api.median_odds(ev)
        if mo is None:
            unmatched += 1
            continue
        devig = odds_api.implied_devig(mo["home"], mo["draw"], mo["away"])
        if devig is None:
            unmatched += 1
            continue
        mkt_home, mkt_draw, mkt_away = devig

        # defensive renormalise: implied_devig already sums to 1, but guard anyway
        # so the shown distribution can never drift off 1.0.
        tot = mkt_home + mkt_draw + mkt_away
        if tot <= 0:
            unmatched += 1
            continue
        mkt_home, mkt_draw, mkt_away = mkt_home / tot, mkt_draw / tot, mkt_away / tot

        # divergence on the model's favoured win side (model_p_home vs model_p_away)
        m_home, m_away = fx["model_p_home"], fx["model_p_away"]
        divergence = None
        if m_home is not None and m_away is not None:
            if m_home >= m_away:
                divergence = abs(m_home - mkt_home)
            else:
                divergence = abs(m_away - mkt_away)
            if divergence > 0.15:
                flagged += 1

        rows.append(
            {
                "fixture_id": fx["fpl_id"],
                # HARD SWITCH: shown probs become the market for this priced fixture.
                "p_home": round(mkt_home, 4),
                "p_draw": round(mkt_draw, 4),
                "p_away": round(mkt_away, 4),
                "market_available": True,
                "market_p_home": round(mkt_home, 4),
                "market_p_draw": round(mkt_draw, 4),
                "market_p_away": round(mkt_away, 4),
                "market_divergence": round(divergence, 4) if divergence is not None else None,
                "market_odds_source": "the-odds-api/median-uk",
                "market_fetched_at": now,
            }
        )
        matched += 1

    # Partial-column upsert: each row carries p_* + market_* + market_available, so
    # ON CONFLICT (fixture_id) DO UPDATE overwrites the shown probs with the market
    # for matched fixtures while leaving model_p_*/exp_goals_*/computed_at intact.
    upsert(conn, "model_fixture_probs", rows, "fixture_id")
    record_pipeline_health(
        conn, "odds", "ok",
        f"{matched} matched, {unmatched} unmatched, {flagged} divergent",
    )
    print(
        f"[odds] market applied to {matched} fixtures (shown p_* = market), "
        f"{unmatched} unmatched (model fallback), {flagged} flagged (divergence > 0.15)"
    )


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


def build_current_season_stat_rows(
    elements: list[dict], season: str
) -> list[dict]:
    """Current-season per-player season totals, straight from the bootstrap
    `elements` (already fetched — no extra API calls). These accumulate through
    the season; the /lms scouting block prefers them over last-season stats as
    soon as any minutes have been played."""
    rows = []
    for e in elements:
        rows.append(
            {
                "player_id": e["id"],
                "season": season,
                "is_current": True,
                "minutes": _to_int(e.get("minutes")),
                "goals": _to_int(e.get("goals_scored")),
                "assists": _to_int(e.get("assists")),
                "xg": _to_float(e.get("expected_goals")),
                "xa": _to_float(e.get("expected_assists")),
                "xgi": _to_float(e.get("expected_goal_involvements")),
                "xgc": _to_float(e.get("expected_goals_conceded")),
                "points": _to_int(e.get("total_points")),
            }
        )
    return rows


def step_player_season_stats(conn, bootstrap, current_season):
    """Populate player_season_stats: current-season totals from the bootstrap
    (cheap) plus each player's most recent PAST season from element-summary
    history_past. The scouting detail block on /lms falls back to the past
    season (labelled "last season") until real games have been played.

    The per-player element-summary fetch is bounded: players that already have
    any past-season row are skipped, so the ~1-call-per-player cost is paid on
    the first run and then only for newly-added players."""
    if current_season is None:
        print("[step 6] no season label derivable; skipped season stats")
        return

    elements = bootstrap["elements"]
    cur_rows = build_current_season_stat_rows(elements, current_season)
    upsert(conn, "player_season_stats", cur_rows, ["player_id", "season"])

    existing = query(
        conn,
        "SELECT DISTINCT player_id FROM player_season_stats WHERE is_current = false",
    )
    have = {r["player_id"] for r in existing}

    past_rows = []
    fetched = 0
    errors = 0
    for e in elements:
        pid = e["id"]
        if pid in have:
            continue
        try:
            summary = fpl_api.get_element_summary(pid)
        except Exception:
            errors += 1
            continue
        past = summary.get("history_past") or []
        if not past:
            continue
        last = past[-1]  # most recent past season
        season_name = last.get("season_name")
        if not season_name:
            continue
        past_rows.append(
            {
                "player_id": pid,
                "season": season_name,
                "is_current": False,
                "minutes": _to_int(last.get("minutes")),
                "goals": _to_int(last.get("goals_scored")),
                "assists": _to_int(last.get("assists")),
                "xg": _to_float(last.get("expected_goals")),
                "xa": _to_float(last.get("expected_assists")),
                "xgi": _to_float(last.get("expected_goal_involvements")),
                "xgc": _to_float(last.get("expected_goals_conceded")),
                "points": _to_int(last.get("total_points")),
            }
        )
        fetched += 1

    if past_rows:
        upsert(conn, "player_season_stats", past_rows, ["player_id", "season"])

    print(
        f"[step 6] season stats: {len(cur_rows)} current-season rows; "
        f"fetched {fetched} players' last-season totals "
        f"({len(have)} already had one, {errors} fetch errors)"
    )


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
    # IMPORTANT: only ever overwrite user_squad when the FPL picks endpoint
    # actually returns data. `get_entry_picks` returns None on a 404 (picks are
    # not published until AFTER the GW deadline), so pre-deadline we bail out
    # here WITHOUT touching user_squad. This is what protects a manually-entered
    # squad (see web /squad/edit) from being wiped: we never DELETE, and the
    # upsert below only runs when real picks exist. A blank/404 response leaves
    # any existing rows for this (user, gw) exactly as they were.
    if not picks or "picks" not in picks:
        return 0  # 404 before deadline, or no data — do NOT clear existing rows
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


def step5_lms_resolve(conn) -> None:
    """Auto-resolve pending LMS entry picks whose round has fully finished.

    For every lms_entry_picks row with result='pending' in a GW where ALL
    fixtures are finished: a win -> 'survived', a draw/loss -> 'eliminated'
    (strict rules: a draw is OUT). On elimination the parent entry is set
    status='out', eliminated_gw=gw.

    Idempotent: only touches result='pending' rows, and only for fully-finished
    rounds, so re-runs are no-ops. Reads finished fixtures only. NEVER writes to
    FPL — this settles OUR own LMS tables. Operates on lms_entry_picks (the
    rework tables); the deprecated lms_picks table is intentionally left alone.
    """
    pending = query(
        conn,
        "SELECT id, entry_id, gw, team_id FROM lms_entry_picks WHERE result = 'pending'",
    )
    if not pending:
        print("[step 5] no pending LMS picks; skipped")
        return

    # For each round with pending picks, is it fully finished, and what are the
    # per-team scorelines?
    fixtures_by_gw: dict[int, dict] = {}
    for gw in sorted({p["gw"] for p in pending}):
        status = query(
            conn,
            "SELECT bool_and(finished) AS all_finished, count(*) AS n "
            "FROM fixtures WHERE gw = %s",
            (gw,),
        )
        row = status[0] if status else None
        all_finished = bool(row and row["n"] and row["all_finished"])
        by_team: dict[int, dict] = {}
        if all_finished:
            for fx in query(
                conn,
                "SELECT home_team, away_team, home_score, away_score FROM fixtures "
                "WHERE gw = %s AND finished = true "
                "AND home_score IS NOT NULL AND away_score IS NOT NULL",
                (gw,),
            ):
                by_team[fx["home_team"]] = {
                    "is_home": True,
                    "home_score": fx["home_score"],
                    "away_score": fx["away_score"],
                }
                by_team[fx["away_team"]] = {
                    "is_home": False,
                    "home_score": fx["home_score"],
                    "away_score": fx["away_score"],
                }
        fixtures_by_gw[gw] = {"all_finished": all_finished, "by_team": by_team}

    pick_updates, entry_outs = models.resolve_lms_picks(pending, fixtures_by_gw)

    with conn.cursor() as cur:
        for u in pick_updates:
            cur.execute(
                "UPDATE lms_entry_picks SET result = %s "
                "WHERE id = %s AND result = 'pending'",
                (u["result"], u["id"]),
            )
        for entry_id, gw in entry_outs.items():
            cur.execute(
                "UPDATE lms_entries SET status = 'out', eliminated_gw = %s "
                "WHERE id = %s AND status <> 'out'",
                (gw, entry_id),
            )

    print(
        f"[step 5] resolved {len(pick_updates)} LMS pick(s); "
        f"{len(entry_outs)} entries newly out"
    )


# ------------------------------ main ------------------------------
def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    print("Fetching FPL API ...")
    bootstrap = fpl_api.get_bootstrap_static()
    fixtures = fpl_api.get_fixtures()
    events = bootstrap["events"]
    current_gw = _find_current_gw(events)
    next_gw = _find_next_gw(events)
    current_season = _season_label(events)
    print(f"  current GW = {current_gw}, next GW = {next_gw}, season = {current_season}")

    with connect() as conn:
        fixture_rows = step1_reference_data(conn, bootstrap, fixtures)
        _, exp_goals_by_fixture = step2_elo_and_fixture_probs(
            conn, bootstrap, fixture_rows
        )
        # market hard switch: overwrites shown p_* with market for priced fixtures.
        # Fails LOUD (ERROR log + pipeline_health marker); must run after step 2.
        step_odds_calibration(conn)
        step3_player_ep(conn, bootstrap, fixture_rows, exp_goals_by_fixture, next_gw)
        step_player_season_stats(conn, bootstrap, current_season)
        step4_users(conn, current_gw, next_gw)
        step5_lms_resolve(conn)

    print("Pipeline complete.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
