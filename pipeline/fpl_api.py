"""Pure fetch layer for the public (unauthenticated) FPL API.

Every function returns parsed JSON (dict / list) and does no transformation
beyond what `requests` gives us. Keep model/DB logic out of here so this stays
trivially mockable.
"""
from __future__ import annotations

from typing import Any, Optional

import requests

BASE = "https://fantasy.premierleague.com/api"

# The FPL API rejects some default client User-Agents; send a browser-like one.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

DEFAULT_TIMEOUT = 30  # seconds


def _get(url: str, timeout: int = DEFAULT_TIMEOUT) -> Any:
    """GET a URL and return parsed JSON, raising on non-2xx."""
    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def get_bootstrap_static() -> dict:
    """Teams, players (elements), gameweeks (events), element_types."""
    return _get(f"{BASE}/bootstrap-static/")


def get_fixtures() -> list:
    """All fixtures for the season."""
    return _get(f"{BASE}/fixtures/")


def get_fixtures_by_event(event: int) -> list:
    """Fixtures for a single gameweek."""
    return _get(f"{BASE}/fixtures/?event={event}")


def get_element_summary(player_id: int) -> dict:
    """Per-player history[] and history_past[]."""
    return _get(f"{BASE}/element-summary/{player_id}/")


def get_entry(entry_id: int) -> dict:
    """Manager summary + leagues for an FPL entry (team) id."""
    return _get(f"{BASE}/entry/{entry_id}/")


def get_entry_history(entry_id: int) -> dict:
    """chips[], current[], past[] for an entry."""
    return _get(f"{BASE}/entry/{entry_id}/history/")


def get_entry_picks(entry_id: int, gw: int) -> Optional[dict]:
    """Picks for an entry in a given GW.

    Only available AFTER that GW's deadline; the API returns 404 before then.
    Returns None on 404 rather than raising, so callers can skip gracefully.
    """
    url = f"{BASE}/entry/{entry_id}/event/{gw}/picks/"
    resp = requests.get(url, headers=HEADERS, timeout=DEFAULT_TIMEOUT)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()
