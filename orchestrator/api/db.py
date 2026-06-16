"""
SQLite persistence for the AIDC orchestrator.

We use plain stdlib sqlite3, file-backed. Path comes from $AIDC_DB_PATH; default
is /data/aidc.db (inside the container, that's a host-bound volume so state
survives container restarts).

Tables:
  sessions      one row per anonymous browser session (resolved from cookie)
  lab_runs      one row per (session, lab); tracks state machine + stats
  check_events  append-only audit log of every start/check/submit/solve/reset
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

DB_PATH = Path(os.environ.get("AIDC_DB_PATH", "/data/aidc.db"))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  created_at   TIMESTAMP NOT NULL,
  last_seen    TIMESTAMP NOT NULL,
  display_name TEXT
);

CREATE TABLE IF NOT EXISTS lab_runs (
  session_id   TEXT NOT NULL,
  lab_id       TEXT NOT NULL,
  state        TEXT NOT NULL,
  started_at   TIMESTAMP,
  submitted_at TIMESTAMP,
  passed_at    TIMESTAMP,
  attempts     INTEGER NOT NULL DEFAULT 0,
  used_solve   INTEGER NOT NULL DEFAULT 0,
  last_summary TEXT,
  PRIMARY KEY (session_id, lab_id)
);

CREATE TABLE IF NOT EXISTS check_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  lab_id      TEXT NOT NULL,
  ts          TIMESTAMP NOT NULL,
  kind        TEXT NOT NULL,
  passed      INTEGER,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_check_events_session_lab
  ON check_events (session_id, lab_id, ts);
"""

_conn: Optional[sqlite3.Connection] = None
_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        DB_PATH,
        detect_types=sqlite3.PARSE_DECLTYPES,
        check_same_thread=False,
        isolation_level=None,  # autocommit; we manage transactions explicitly
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(_SCHEMA)
    return conn


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        with _lock:
            if _conn is None:
                _conn = _connect()
    return _conn


# ---- sessions ---------------------------------------------------------------
def get_or_create_session(session_id: Optional[str]) -> str:
    """Look up a session by id; create a new one if missing or absent."""
    c = conn()
    with _lock:
        if session_id:
            row = c.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row:
                c.execute("UPDATE sessions SET last_seen = ? WHERE id = ?", (_now(), session_id))
                return session_id
        new_id = uuid.uuid4().hex
        now = _now()
        c.execute(
            "INSERT INTO sessions (id, created_at, last_seen) VALUES (?, ?, ?)",
            (new_id, now, now),
        )
        return new_id


def set_display_name(session_id: str, display_name: str) -> None:
    """Stamp an identity (e.g. the Cloudflare Access email) onto a session so
    the audit log can attribute actions to a real person. No-op if unchanged."""
    c = conn()
    with _lock:
        c.execute(
            "UPDATE sessions SET display_name = ? WHERE id = ? AND IFNULL(display_name, '') <> ?",
            (display_name, session_id, display_name),
        )


# ---- lab runs ---------------------------------------------------------------
def _row_to_lab_run(row: sqlite3.Row, lab_id: str) -> dict[str, Any]:
    if row is None:
        return {
            "lab_id": lab_id,
            "state": "not_started",
            "started_at": None,
            "submitted_at": None,
            "passed_at": None,
            "attempts": 0,
            "used_solve": False,
            "last_summary": None,
        }
    return {
        "lab_id": row["lab_id"],
        "state": row["state"],
        "started_at": row["started_at"].isoformat() if row["started_at"] else None,
        "submitted_at": row["submitted_at"].isoformat() if row["submitted_at"] else None,
        "passed_at": row["passed_at"].isoformat() if row["passed_at"] else None,
        "attempts": row["attempts"],
        "used_solve": bool(row["used_solve"]),
        "last_summary": json.loads(row["last_summary"]) if row["last_summary"] else None,
    }


def get_lab_run(session_id: str, lab_id: str) -> dict[str, Any]:
    c = conn()
    row = c.execute(
        "SELECT * FROM lab_runs WHERE session_id = ? AND lab_id = ?",
        (session_id, lab_id),
    ).fetchone()
    return _row_to_lab_run(row, lab_id)


def start_lab_run(session_id: str, lab_id: str) -> dict[str, Any]:
    """Start (or restart) a lab. Bumps attempts, resets used_solve, state=in_progress."""
    c = conn()
    now = _now()
    with _lock:
        existing = c.execute(
            "SELECT attempts FROM lab_runs WHERE session_id = ? AND lab_id = ?",
            (session_id, lab_id),
        ).fetchone()
        attempts = (existing["attempts"] if existing else 0) + 1
        c.execute(
            """
            INSERT INTO lab_runs (session_id, lab_id, state, started_at, attempts, used_solve, last_summary)
            VALUES (?, ?, 'in_progress', ?, ?, 0, NULL)
            ON CONFLICT(session_id, lab_id) DO UPDATE SET
              state       = 'in_progress',
              started_at  = excluded.started_at,
              submitted_at= NULL,
              passed_at   = NULL,
              attempts    = ?,
              used_solve  = 0,
              last_summary= NULL
            """,
            (session_id, lab_id, now, attempts, attempts),
        )
    return get_lab_run(session_id, lab_id)


def mark_used_solve(session_id: str, lab_id: str) -> dict[str, Any]:
    c = conn()
    with _lock:
        c.execute(
            """
            INSERT INTO lab_runs (session_id, lab_id, state, started_at, attempts, used_solve)
            VALUES (?, ?, 'in_progress', ?, 1, 1)
            ON CONFLICT(session_id, lab_id) DO UPDATE SET used_solve = 1
            """,
            (session_id, lab_id, _now()),
        )
    return get_lab_run(session_id, lab_id)


def record_submit(
    session_id: str,
    lab_id: str,
    summary: dict[str, Any],
    all_passed: bool,
) -> dict[str, Any]:
    """Persist a submit outcome. Transitions state to 'passed' iff all_passed."""
    c = conn()
    now = _now()
    summary_json = json.dumps(summary)
    with _lock:
        existing = c.execute(
            "SELECT state, passed_at FROM lab_runs WHERE session_id = ? AND lab_id = ?",
            (session_id, lab_id),
        ).fetchone()
        # First passed_at sticks (never overwrite once passed).
        passed_at = None
        if all_passed:
            passed_at = existing["passed_at"] if existing and existing["passed_at"] else now
        new_state = "passed" if all_passed else "in_progress"
        c.execute(
            """
            INSERT INTO lab_runs (session_id, lab_id, state, started_at, submitted_at, passed_at, attempts, last_summary)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(session_id, lab_id) DO UPDATE SET
              state        = excluded.state,
              submitted_at = excluded.submitted_at,
              passed_at    = excluded.passed_at,
              last_summary = excluded.last_summary
            """,
            (session_id, lab_id, new_state, now, now, passed_at, summary_json),
        )
    return get_lab_run(session_id, lab_id)


# ---- check events -----------------------------------------------------------
def log_event(
    session_id: str,
    lab_id: str,
    kind: str,
    passed: Optional[bool] = None,
    detail: Optional[dict[str, Any]] = None,
) -> None:
    c = conn()
    with _lock:
        c.execute(
            "INSERT INTO check_events (session_id, lab_id, ts, kind, passed, detail) VALUES (?, ?, ?, ?, ?, ?)",
            (
                session_id,
                lab_id,
                _now(),
                kind,
                None if passed is None else (1 if passed else 0),
                json.dumps(detail) if detail is not None else None,
            ),
        )
