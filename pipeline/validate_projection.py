"""Validate the refreshed `model_player_ep` against the seeded staging DB.

Reads the top projected players straight from Postgres (the values the pipeline
wrote in step 3), prints the top-20, and asserts they look sane:

  * no projection exceeds the guardrail (`models.EP_SANE_MAX`);
  * the very top is a premium, not a bit-part player;
  * recognizable premiums show up near the top;
  * the top-20 isn't flooded with cheap fringe/bench fodder.

Run:  DATABASE_URL=... python validate_projection.py [gw]
Exits non-zero (AssertionError) if the projections look inflated again.
"""
from __future__ import annotations

import sys

import models
from db import connect, query

# A projection above this many points for a single GW is implausible.
SANE_MAX = models.EP_SANE_MAX
# Every top-20 EP should sit in this band once inflation is fixed.
TOP20_EP_MIN, TOP20_EP_MAX = 3.0, 9.5
# Known premiums (by FPL web_name) — at least MIN_PREMIUMS_IN_TOP should appear.
PREMIUM_NAMES = {
    "Haaland", "M.Salah", "Salah", "Palmer", "Saka", "B.Fernandes",
    "Semenyo", "Mbeumo", "Bruno G.", "Rice", "Enzo", "Foden", "Gabriel",
}
MIN_PREMIUMS_IN_TOP = 3
# Bit-part players are cheap bench fodder; the top-20 shouldn't be full of them.
BIT_PART_PRICE = 45          # tenths of a million (£4.5m)
MAX_CHEAP_IN_TOP20 = 4
MIN_AVG_PRICE = 55           # £5.5m average across the top-20


def top_projections(conn, gw: int, limit: int = 40) -> list[dict]:
    return query(
        conn,
        """
        SELECT p.web_name, p.position, t.short_name AS team, p.price,
               p.status, ep.expected_points AS ep
        FROM model_player_ep ep
        JOIN players p ON p.fpl_id = ep.player_id
        JOIN teams   t ON t.fpl_id = p.team_id
        WHERE ep.gw = %s AND ep.horizon = 1
        ORDER BY ep.expected_points DESC
        LIMIT %s
        """,
        (gw, limit),
    )


def _resolve_gw(conn, gw_arg: str | None) -> int:
    if gw_arg is not None:
        return int(gw_arg)
    row = query(
        conn,
        "SELECT gw FROM model_player_ep GROUP BY gw ORDER BY gw LIMIT 1",
    )
    if not row:
        raise SystemExit("no rows in model_player_ep — run the pipeline first")
    return row[0]["gw"]


def main() -> int:
    gw_arg = sys.argv[1] if len(sys.argv) > 1 else None
    with connect() as conn:
        gw = _resolve_gw(conn, gw_arg)
        rows = top_projections(conn, gw)
        stats = query(
            conn,
            "SELECT MAX(expected_points) AS mx, COUNT(*) AS n "
            "FROM model_player_ep WHERE gw = %s AND horizon = 1",
            (gw,),
        )[0]

    if not rows:
        raise SystemExit(f"no model_player_ep rows for GW{gw}")

    print(f"=== GW{gw} — top 20 projected players ({stats['n']} total) ===")
    print(f"{'#':>2}  {'name':<14} {'pos':<3} {'team':<4} {'price':>5}  {'EP':>5}  status")
    for i, r in enumerate(rows[:20], 1):
        print(
            f"{i:>2}  {r['web_name']:<14} {r['position']:<3} {r['team']:<4} "
            f"{r['price']/10:>4.1f}m  {r['ep']:>5.2f}  {r['status']}"
        )

    top20 = rows[:20]
    max_ep = float(stats["mx"])
    premiums = [r["web_name"] for r in rows if r["web_name"] in PREMIUM_NAMES]
    cheap = [r for r in top20 if (r["price"] or 0) < BIT_PART_PRICE]
    avg_price = sum((r["price"] or 0) for r in top20) / len(top20)

    # ----- assertions: the projections must look sane -----
    assert max_ep <= SANE_MAX, f"max EP {max_ep} exceeds sane max {SANE_MAX}"
    assert rows[0]["web_name"] in PREMIUM_NAMES, (
        f"top projection is {rows[0]['web_name']} (£{rows[0]['price']/10}m), "
        "not a recognized premium — smells like the old inflation bug"
    )
    assert all(TOP20_EP_MIN <= r["ep"] <= TOP20_EP_MAX for r in top20), (
        f"a top-20 EP is outside the sane band [{TOP20_EP_MIN}, {TOP20_EP_MAX}]"
    )
    assert len(premiums) >= MIN_PREMIUMS_IN_TOP, (
        f"only {len(premiums)} known premiums near the top: {premiums}"
    )
    assert len(cheap) <= MAX_CHEAP_IN_TOP20, (
        f"{len(cheap)} sub-£{BIT_PART_PRICE/10}m players in the top-20 "
        f"(bit-part flood): {[r['web_name'] for r in cheap]}"
    )
    assert avg_price >= MIN_AVG_PRICE, (
        f"top-20 average price £{avg_price/10:.1f}m below £{MIN_AVG_PRICE/10}m floor"
    )

    print(
        f"\nOK  projections look sane — max EP {max_ep:.2f} (<= {SANE_MAX}), "
        f"top pick {rows[0]['web_name']}, {len(premiums)} premiums near top, "
        f"top-20 avg £{avg_price/10:.1f}m, {len(cheap)} cheap."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
