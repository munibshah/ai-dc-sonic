-- AIDC booking backend — D1 schema.
--
-- Apply with:
--   wrangler d1 execute aidc-booking --file=schema.sql            (local dev DB)
--   wrangler d1 execute aidc-booking --remote --file=schema.sql   (production DB)
--
-- Two independent surfaces:
--   slots             — exclusive reservations on the single shared fabric.
--   training_sessions — instructor-led sessions; learners add their name (no scheduler).
--   training_signups  — the roster rows.

-- Exclusive fabric reservations (self-serve). All timestamps are ISO-8601 UTC.
-- This table now holds ONLY real bookings (status='booked'); there is no
-- pre-generated grid. Availability is the complement of these rows. A 4-hour
-- window may start at any 30-minute mark; the no-overlap invariant is enforced
-- at book time by an atomic INSERT ... WHERE NOT EXISTS(overlap) in the Worker.
CREATE TABLE IF NOT EXISTS slots (
  id             TEXT PRIMARY KEY,
  starts_at      TEXT NOT NULL,
  ends_at        TEXT NOT NULL,
  holder_email   TEXT,                                   -- the booker
  status         TEXT NOT NULL DEFAULT 'available',      -- 'booked' in practice (available is computed, not stored)
  payment_status TEXT NOT NULL DEFAULT 'free',           -- free | pending | paid  (paid-ready seam; always 'free' today)
  created_at     TEXT NOT NULL
);

-- Index the window lookup the orchestrator gate hits on every Start/Reset/Solve,
-- and the overlap probe at book time.
CREATE INDEX IF NOT EXISTS idx_slots_window ON slots (status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_slots_holder ON slots (holder_email);

-- Drop the legacy grid-era uniqueness on starts_at: a UNIQUE index can't express
-- the half-open overlap predicate (that's the app-level NOT EXISTS guard now) and
-- would wrongly block re-booking a start that was previously booked then cancelled.
DROP INDEX IF EXISTS uq_slots_starts_at;

-- Instructor-led training sessions. The "next" one is surfaced on /booking.
CREATE TABLE IF NOT EXISTS training_sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  starts_at  TEXT NOT NULL,
  capacity   INTEGER,                                    -- NULL = unlimited
  location   TEXT,                                       -- video link / room note
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_training_starts ON training_sessions (starts_at);

-- Roster: one row per learner who added their name to a session.
CREATE TABLE IF NOT EXISTS training_signups (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  name       TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, email)
);

CREATE INDEX IF NOT EXISTS idx_signups_session ON training_signups (session_id);

-- Magic-link sign-in tokens. Only the SHA-256 hash of the token is stored;
-- single-use, ~15-min expiry. The session itself is a signed cookie (no table).
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_email ON auth_tokens (email, created_at);
