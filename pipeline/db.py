"""Postgres data-access layer for the pipeline (psycopg v3).

Connects directly to Railway Postgres via the `DATABASE_URL` env var — the same
database the Next.js app uses. Server-side only. No RLS: access is scoped in the
app/query layer by user id, so the pipeline (a trusted server process) has full
read/write.

Public surface:
  * ``connect()``               — context manager yielding a committed connection.
  * ``upsert(conn, table, rows, conflict_cols)`` — batched, parameterized
    ``INSERT ... ON CONFLICT (...) DO UPDATE``; updates all non-conflict columns.
  * ``query(conn, sql, params=None)`` — run SQL, return list of dict rows.
  * ``replace_recommendation(conn, user_id, gw, kind, payload)`` — delete-then-
    insert for ``recommendations_log`` (identity PK, no natural conflict key).

Identifiers are always quoted via ``psycopg.sql.Identifier`` so camelCase columns
(e.g. the Auth.js adapter tables) would be handled correctly if ever touched —
the pipeline itself only writes the snake_case reference/domain tables.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterable, Iterator, Optional, Sequence, Union

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

# Cap the number of rows per INSERT statement so a full-season players/fixtures
# upsert stays a handful of round-trips rather than one giant statement.
UPSERT_CHUNK = 500


@contextmanager
def connect(dsn: Optional[str] = None) -> Iterator[psycopg.Connection]:
    """Yield a psycopg connection built from `DATABASE_URL` (or an explicit dsn).

    Commits on clean exit, rolls back on exception, and always closes.
    """
    dsn = dsn or os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL must be set in the environment")
    conn = psycopg.connect(dsn)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _chunks(rows: list, size: int) -> Iterable[list]:
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


def _conflict_list(conflict_cols: Union[str, Sequence[str]]) -> list[str]:
    if isinstance(conflict_cols, str):
        return [c.strip() for c in conflict_cols.split(",") if c.strip()]
    return list(conflict_cols)


def upsert(
    conn: psycopg.Connection,
    table: str,
    rows: list[dict[str, Any]],
    conflict_cols: Union[str, Sequence[str]],
) -> int:
    """Idempotent upsert of `rows` into `table`.

    Builds a parameterized ``INSERT INTO table (cols) VALUES (...), (...) ON
    CONFLICT (conflict_cols) DO UPDATE SET <all non-conflict cols> = EXCLUDED...``
    executed in batches of ``UPSERT_CHUNK``. No-op (returns 0) when `rows` empty.
    Column set is taken from the first row (builders emit uniform dicts).
    """
    if not rows:
        return 0

    cols = list(rows[0].keys())
    conflict = _conflict_list(conflict_cols)
    update_cols = [c for c in cols if c not in conflict]

    col_idents = sql.SQL(", ").join(sql.Identifier(c) for c in cols)
    conflict_idents = sql.SQL(", ").join(sql.Identifier(c) for c in conflict)
    if update_cols:
        set_clause = sql.SQL(", ").join(
            sql.SQL("{c} = EXCLUDED.{c}").format(c=sql.Identifier(c))
            for c in update_cols
        )
        conflict_action = sql.SQL("DO UPDATE SET ") + set_clause
    else:
        # every column is part of the conflict key -> nothing to update
        conflict_action = sql.SQL("DO NOTHING")

    total = 0
    with conn.cursor() as cur:
        for chunk in _chunks(rows, UPSERT_CHUNK):
            one_tuple = sql.SQL("({})").format(
                sql.SQL(", ").join(sql.Placeholder() for _ in cols)
            )
            values_sql = sql.SQL(", ").join(one_tuple for _ in chunk)
            stmt = sql.SQL(
                "INSERT INTO {table} ({cols}) VALUES {vals} "
                "ON CONFLICT ({conflict}) {action}"
            ).format(
                table=sql.Identifier(table),
                cols=col_idents,
                vals=values_sql,
                conflict=conflict_idents,
                action=conflict_action,
            )
            params = [row.get(c) for row in chunk for c in cols]
            cur.execute(stmt, params)
            total += len(chunk)
    return total


def query(
    conn: psycopg.Connection,
    sql_text: str,
    params: Optional[Sequence[Any]] = None,
) -> list[dict]:
    """Run `sql_text` and return the result as a list of dict rows.

    Returns an empty list for statements that produce no result set.
    """
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql_text, params or ())
        if cur.description is None:
            return []
        return cur.fetchall()


def replace_recommendation(
    conn: psycopg.Connection,
    user_id: int,
    gw: int,
    kind: str,
    payload: dict,
) -> int:
    """Idempotent write for `recommendations_log` (identity PK).

    Deletes any existing row for (user_id, gw, kind) then inserts the new one,
    since there is no natural conflict key to ON CONFLICT against.
    """
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM recommendations_log "
            "WHERE user_id = %s AND gw = %s AND kind = %s",
            (user_id, gw, kind),
        )
        cur.execute(
            "INSERT INTO recommendations_log (user_id, gw, kind, payload) "
            "VALUES (%s, %s, %s, %s)",
            (user_id, gw, kind, Jsonb(payload)),
        )
    return 1
