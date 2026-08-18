"""Bookmaker odds fetch + calibration helpers (The Odds API).

QA layer ONLY. The strength model is deliberately self-contained (we build our
own ratings rather than depend on bookmaker odds — see docs/approach). This
module fetches h2h (1X2) odds once per pipeline run, de-vigs them to implied
probabilities, and lets run.py flag fixtures where our model diverges sharply
from the market. It NEVER feeds the probability calculation.

Design mirrors fpl_api.py: a thin `_get` over `requests` returning parsed JSON,
plus PURE transform helpers (median, de-vig, name-match) that take data in and
return values out — trivially unit-testable offline with no network.

Free tier is 500 requests/month; one h2h call fetches the whole round, so a
daily cron uses ~30/month. The API key comes from the ODDS_API_KEY env var and
is passed in by the caller — this module reads no env of its own.
"""
from __future__ import annotations

from statistics import median
from typing import Any, Optional

import requests

BASE = "https://api.the-odds-api.com/v4"
SPORT = "soccer_epl"
DEFAULT_TIMEOUT = 30  # seconds

DRAW = "Draw"  # the outcome name The Odds API uses for the draw in h2h markets

# The Odds API returns full club names; the FPL API (our `teams` table) uses
# short/informal ones. Map the exact strings that differ so a fixture can be
# matched back to a team id. Keys are lowercased Odds-API names; values are the
# lowercased FPL `name`. Clubs whose names already match (Arsenal, Chelsea,
# Everton, Fulham, Liverpool, Brentford, Sunderland, Leeds United, Burnley...)
# need no entry — the matcher also compares on our `name`/`short_name` directly.
# VERIFY against the live response during rollout and extend as needed.
ODDS_TEAM_ALIASES = {
    "tottenham hotspur": "spurs",
    "manchester city": "man city",
    "manchester united": "man utd",
    "newcastle united": "newcastle",
    "nottingham forest": "nott'm forest",
    "wolverhampton wanderers": "wolves",
    "brighton and hove albion": "brighton",
    "brighton & hove albion": "brighton",
    "west ham united": "west ham",
    "afc bournemouth": "bournemouth",
    "leeds united": "leeds",
    "leicester city": "leicester",
    "ipswich town": "ipswich",
}


def _get(url: str, params: dict, timeout: int = DEFAULT_TIMEOUT) -> Any:
    """GET a URL with query params and return parsed JSON, raising on non-2xx."""
    resp = requests.get(url, params=params, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def get_h2h_odds(
    api_key: str, regions: str = "uk", timeout: int = DEFAULT_TIMEOUT
) -> list:
    """Fetch h2h (1X2) odds for every upcoming EPL fixture in one call.

    Returns the raw list of event dicts, each shaped like:
        {"home_team", "away_team", "commence_time",
         "bookmakers": [{"markets": [{"key": "h2h",
             "outcomes": [{"name": <team|"Draw">, "price": <decimal>}]}]}]}
    Raises on a non-2xx response (the caller wraps this in try/except to fail soft).
    """
    return _get(
        f"{BASE}/sports/{SPORT}/odds",
        {
            "regions": regions,
            "markets": "h2h",
            "oddsFormat": "decimal",
            "apiKey": api_key,
        },
        timeout=timeout,
    )


def median_odds(event: dict) -> Optional[dict[str, float]]:
    """Median decimal odds per outcome across all bookmakers in one event.

    Taking the median (not mean) across books reduces single-book noise/outliers.
    Returns {"home": od, "draw": od, "away": od} keyed by the event's own
    home_team / away_team names (+ Draw), or None if any of the three outcomes is
    missing from every bookmaker.
    """
    home_name = event.get("home_team")
    away_name = event.get("away_team")
    if not home_name or not away_name:
        return None

    prices: dict[str, list[float]] = {home_name: [], DRAW: [], away_name: []}
    for book in event.get("bookmakers", []):
        for market in book.get("markets", []):
            if market.get("key") != "h2h":
                continue
            for oc in market.get("outcomes", []):
                name = oc.get("name")
                price = oc.get("price")
                if name in prices and isinstance(price, (int, float)) and price > 0:
                    prices[name].append(float(price))

    if not (prices[home_name] and prices[DRAW] and prices[away_name]):
        return None
    return {
        "home": median(prices[home_name]),
        "draw": median(prices[DRAW]),
        "away": median(prices[away_name]),
    }


def implied_devig(
    home_odds: float, draw_odds: float, away_odds: float
) -> Optional[tuple[float, float, float]]:
    """Convert decimal odds -> de-vigged implied probabilities (home, draw, away).

    implied = 1/odds; the three carry the bookmaker's overround (sum > 1), so
    normalise them to sum to exactly 1. Returns None on non-positive odds.
    """
    if home_odds <= 0 or draw_odds <= 0 or away_odds <= 0:
        return None
    ih, id_, ia = 1.0 / home_odds, 1.0 / draw_odds, 1.0 / away_odds
    total = ih + id_ + ia
    if total <= 0:
        return None
    return ih / total, id_ / total, ia / total


def _norm_name(name: Optional[str]) -> str:
    """Lowercase + strip a team name for tolerant matching."""
    return (name or "").strip().lower()


def build_team_lookup(teams: list[dict]) -> dict[str, int]:
    """Map normalised team-name strings -> fpl team id, for matching odds events.

    Indexes each team by its `name` and `short_name` (both lowercased). Callers
    resolve an Odds-API name via `match_team_id`, which also consults
    ODDS_TEAM_ALIASES. `teams` rows are our DB rows: {"fpl_id", "name",
    "short_name", ...}.
    """
    lookup: dict[str, int] = {}
    for t in teams:
        tid = t.get("fpl_id")
        if tid is None:
            continue
        for key in (t.get("name"), t.get("short_name")):
            k = _norm_name(key)
            if k:
                lookup[k] = tid
    return lookup


def match_team_id(odds_name: str, lookup: dict[str, int]) -> Optional[int]:
    """Resolve an Odds-API team name to our fpl team id (via alias table + lookup)."""
    key = _norm_name(odds_name)
    if key in lookup:
        return lookup[key]
    alias = ODDS_TEAM_ALIASES.get(key)
    if alias and alias in lookup:
        return lookup[alias]
    return None


# ============================ offline self-check ============================
if __name__ == "__main__":
    # No network. Proves median/de-vig/name-match behave.
    ev = {
        "home_team": "Manchester City",
        "away_team": "Brentford",
        "commence_time": "2025-08-16T14:00:00Z",
        "bookmakers": [
            {"markets": [{"key": "h2h", "outcomes": [
                {"name": "Manchester City", "price": 1.30},
                {"name": "Draw", "price": 6.0},
                {"name": "Brentford", "price": 11.0},
            ]}]},
            {"markets": [{"key": "h2h", "outcomes": [
                {"name": "Manchester City", "price": 1.34},
                {"name": "Draw", "price": 5.5},
                {"name": "Brentford", "price": 10.0},
            ]}]},
        ],
    }
    mo = median_odds(ev)
    assert mo == {"home": 1.32, "draw": 5.75, "away": 10.5}, mo
    probs = implied_devig(mo["home"], mo["draw"], mo["away"])
    assert probs is not None and abs(sum(probs) - 1.0) < 1e-9, probs
    assert probs[0] > probs[1] > probs[2], f"strong fav should top the probs: {probs}"

    # a bad event (missing an outcome) yields None, not a crash
    assert median_odds({"home_team": "A", "away_team": "B", "bookmakers": []}) is None
    assert implied_devig(0, 1, 1) is None

    # name matching: alias + direct short_name
    teams = [
        {"fpl_id": 11, "name": "Man City", "short_name": "MCI"},
        {"fpl_id": 4, "name": "Brentford", "short_name": "BRE"},
    ]
    lk = build_team_lookup(teams)
    assert match_team_id("Manchester City", lk) == 11, "alias must resolve"
    assert match_team_id("Brentford", lk) == 4, "direct name must resolve"
    assert match_team_id("MCI", lk) == 11, "short_name must resolve"
    assert match_team_id("Real Madrid", lk) is None, "unknown -> None"

    print("OK  odds_api.py self-check passed")
    print(f"  median odds:   {mo}")
    print(f"  de-vig probs:  home={probs[0]:.3f} draw={probs[1]:.3f} away={probs[2]:.3f}")
