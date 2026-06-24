/**
 * AIDC booking backend — Cloudflare Worker + D1.
 *
 * Identity is custom magic-link auth (the Worker is the auth authority — see
 * auth.ts), so there is no per-seat cap. Surfaces:
 *   - /auth/*      magic-link sign in/out + identity (public to start)
 *   - /public/*    unauthenticated teasers for the marketing page
 *   - /api/*       slot reservations + training roster (cookie-authed)
 *   - /api/admin/* instructor-only (cookie email === INSTRUCTOR_EMAIL)
 *   - /api/holder/current  server-to-server (ORCH_SHARED_SECRET) for the orchestrator gate
 *
 * Served same-origin under lab.<domain>/booking-api/* (a Workers Route), so the
 * session cookie travels to both the UI and the orchestrator.
 */

import {
  SESSION_COOKIE,
  clearCookieHeader,
  randomToken,
  readCookie,
  sessionCookieHeader,
  sha256hex,
  signSession,
  verifySession,
} from "./auth";
import { b64, bookingEmail, buildIcs, magicLinkEmail, sendEmail, trainingEmail } from "./email";

export interface Env {
  DB: D1Database;
  INSTRUCTOR_EMAIL: string;
  AUTH_SIGNING_SECRET: string;
  ORCH_SHARED_SECRET?: string;
  // email (Resend) + app config
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  APP_BASE_URL?: string;
}

// ---- booking schedule -------------------------------------------------------
// The single shared fabric is bookable 24/7 as a 4-hour window starting at any
// 30-minute mark (or "right now"). There is no pre-generated grid: the `slots`
// table holds only real bookings, and availability is the complement of those
// booked windows. The single-fabric invariant (no two reservations overlap) is
// enforced at book time by an atomic overlap-guarded insert. Learners always
// see times in their own local zone.

const SLOT_MS = 4 * 3_600_000; // 4-hour session duration
const STEP_MS = 30 * 60_000; // start-time granularity surfaced in the UI (informational)
const HORIZON_MS = 14 * 86_400_000; // how far ahead a window may be booked
const ALIGN_MS = 5 * 60_000; // lenient server-side start alignment (accepts every tz's 30-min local starts)
const MAX_ACTIVE = 1; // at most one upcoming booking per learner
// No lifetime cap in beta. `used` is still computed for telemetry but never gates.

// ---- small helpers ----------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Per-learner booking counts: upcoming (active) + total ever booked (telemetry). */
async function bookingCounts(env: Env, email: string): Promise<{ active: number; used: number }> {
  const now = nowIso();
  const active: any = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM slots WHERE holder_email = ?1 AND status = 'booked' AND ends_at > ?2",
  )
    .bind(email, now)
    .first();
  const used: any = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM slots WHERE holder_email = ?1 AND status = 'booked'",
  )
    .bind(email)
    .first();
  return { active: active?.n ?? 0, used: used?.n ?? 0 };
}

function appBase(env: Env): string {
  return (env.APP_BASE_URL || "https://lab.munibshah.com").replace(/\/$/, "");
}

function sanitizeNext(n: string | null | undefined): string {
  // Only allow same-origin absolute paths (avoid open redirect).
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/portal";
}

function json(data: unknown, init: ResponseInit = {}, origin?: string | null): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  applyCors(headers, origin);
  return new Response(JSON.stringify(data), { ...init, headers });
}

function err(status: number, detail: string, origin?: string | null): Response {
  return json({ detail }, { status }, origin);
}

// CORS: requests are same-origin in production (lab.<domain>), but mirror Origin
// + allow credentials so the session cookie travels and dev cross-origin works.
function applyCors(headers: Headers, origin?: string | null): void {
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "content-type");
}

/** Resolve the caller's identity from the session cookie (or null). */
async function authenticate(req: Request, env: Env): Promise<string | null> {
  const val = readCookie(req, SESSION_COOKIE);
  if (!val) return null;
  const email = await verifySession(val, env.AUTH_SIGNING_SECRET);
  return email ? email.trim().toLowerCase() : null;
}

// ---- auth (magic link) ------------------------------------------------------

// POST /auth/request {email, next?}  — email a one-time sign-in link. Always 200.
async function authRequest(req: Request, env: Env, ctx: ExecutionContext, origin: string | null): Promise<Response> {
  let body: { email?: string; next?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* ignore */
  }
  const email = (body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return err(400, "A valid email is required", origin);

  // Throttle: max 5 link requests per email per hour (anti email-bomb).
  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const recent: any = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM auth_tokens WHERE email = ?1 AND created_at > ?2",
  )
    .bind(email, cutoff)
    .first();
  if ((recent?.n ?? 0) >= 5) return json({ ok: true }, {}, origin); // silently skip

  const token = randomToken();
  const tokenHash = await sha256hex(token);
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO auth_tokens (token_hash, email, expires_at, used, created_at) VALUES (?1, ?2, ?3, 0, ?4)",
  )
    .bind(tokenHash, email, expires, nowIso())
    .run();

  const next = sanitizeNext(body.next);
  const link = `${appBase(env)}/booking-api/auth/verify?token=${token}&next=${encodeURIComponent(next)}`;
  // Fallback before Resend is configured: surface the link in `wrangler tail`
  // so sign-in is testable without email. Never logs once RESEND_API_KEY is set.
  if (!env.RESEND_API_KEY) console.log(`[auth] magic link for ${email}: ${link}`);
  const tmpl = magicLinkEmail(link);
  ctx.waitUntil(sendEmail(env, { to: email, ...tmpl }));
  return json({ ok: true }, {}, origin);
}

// GET /auth/verify?token=&next=  — validate, set cookie, redirect into the app.
async function authVerify(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const next = sanitizeNext(url.searchParams.get("next"));
  const base = appBase(env);
  if (!token) return Response.redirect(`${base}/login?error=invalid`, 302);

  const hash = await sha256hex(token);
  const row: any = await env.DB.prepare(
    "SELECT email, expires_at, used FROM auth_tokens WHERE token_hash = ?1",
  )
    .bind(hash)
    .first();
  if (!row || row.used || row.expires_at < nowIso()) {
    return Response.redirect(`${base}/login?error=expired`, 302);
  }
  await env.DB.prepare("UPDATE auth_tokens SET used = 1 WHERE token_hash = ?1").bind(hash).run();

  const cookie = await signSession(String(row.email).toLowerCase(), env.AUTH_SIGNING_SECRET);
  return new Response(null, {
    status: 302,
    headers: { Location: `${base}${next}`, "Set-Cookie": sessionCookieHeader(cookie) },
  });
}

// POST /auth/logout  — clear the session cookie.
function authLogout(origin: string | null): Response {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("Set-Cookie", clearCookieHeader());
  applyCors(headers, origin);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// GET /auth/me  — identity for the UI account control.
async function authMe(req: Request, env: Env, origin: string | null): Promise<Response> {
  const email = await authenticate(req, env);
  if (!email) return err(401, "Not signed in", origin);
  return json({ email, is_admin: email === env.INSTRUCTOR_EMAIL.toLowerCase() }, {}, origin);
}

// ---- public (unauthenticated) teasers for the marketing page ----------------

async function publicNextTraining(env: Env, origin: string | null): Promise<Response> {
  const s: any = await env.DB.prepare(
    `SELECT id, title, starts_at, capacity FROM training_sessions
      WHERE starts_at >= ?1 ORDER BY starts_at ASC LIMIT 1`,
  )
    .bind(nowIso())
    .first();
  if (!s) return json({ session: null }, {}, origin);
  const c: any = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM training_signups WHERE session_id = ?1",
  )
    .bind(s.id)
    .first();
  const seats_left = s.capacity != null ? Math.max(0, s.capacity - (c?.n ?? 0)) : null;
  return json({ session: { title: s.title, starts_at: s.starts_at, seats_left } }, {}, origin);
}

// Marketing teaser. Availability is continuous now, so "N open slots" is
// meaningless — report whether the fabric is free right now and, if not, when it
// next frees up (the live booking's end).
async function publicAvailability(env: Env, origin: string | null): Promise<Response> {
  const now = nowIso();
  const live: any = await env.DB.prepare(
    `SELECT ends_at FROM slots
      WHERE status = 'booked' AND starts_at <= ?1 AND ends_at > ?1
      ORDER BY ends_at DESC LIMIT 1`,
  )
    .bind(now)
    .first();
  return json({ open: !live, next_free: live?.ends_at ?? now }, {}, origin);
}

// ---- slots ------------------------------------------------------------------

// GET /api/slots?from=&to=  — only the BOOKED windows in range. The calendar
// computes availability as the complement of these (any 30-min start whose
// 4-hour window doesn't overlap a booked one). Other learners' emails are never
// exposed: someone else's booking is just an opaque `{mine:false}` block. Also
// returns the caller's active-booking limit so the UI can message in one call.
async function listSlots(req: Request, env: Env, email: string, origin: string | null): Promise<Response> {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? nowIso();
  const to = url.searchParams.get("to") ?? new Date(Date.now() + HORIZON_MS).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, starts_at, ends_at, holder_email
       FROM slots
      WHERE status = 'booked' AND ends_at >= ?1 AND starts_at <= ?2
      ORDER BY starts_at ASC`,
  )
    .bind(from, to)
    .all();
  const booked = (rows.results ?? []).map((s: any) => ({
    id: s.id,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    mine: s.holder_email === email,
  }));
  const { active } = await bookingCounts(env, email);
  return json(
    {
      booked,
      config: { slot_minutes: SLOT_MS / 60_000, step_minutes: STEP_MS / 60_000, horizon_days: HORIZON_MS / 86_400_000 },
      limits: { active, max_active: MAX_ACTIVE },
    },
    {},
    origin,
  );
}

// POST /api/slots/book  — body {starts_at?, start_now?}. Create a 4-hour booking
// beginning at the chosen 30-min mark (or right now). Atomic overlap guard keeps
// the single fabric to one reservation at a time. Emails an iCal invite.
async function bookSlot(req: Request, env: Env, ctx: ExecutionContext, email: string, origin: string | null): Promise<Response> {
  let body: { starts_at?: string; start_now?: boolean; tz?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body ⇒ start now */
  }
  const now = Date.now();

  // Resolve the start. An immediate "start now" books at the literal current
  // instant and bypasses the past/alignment checks (it is, by definition, now).
  const isNow = Boolean(body.start_now) || !body.starts_at;
  let startMs: number;
  if (isNow) {
    startMs = now;
  } else {
    startMs = new Date(body.starts_at as string).getTime();
    if (Number.isNaN(startMs)) return err(400, "Invalid start time.", origin);
    if (startMs < now - 60_000) return err(422, "That start time is in the past.", origin);
    if (startMs > now + HORIZON_MS) return err(422, "That start time is beyond the 14-day window.", origin);
    // Lenient alignment: a 5-minute grid accepts every timezone's 30-minute local
    // starts (incl. half-hour zones) while rejecting arbitrary instants.
    if (startMs % ALIGN_MS !== 0) return err(422, "Pick a start on a 30-minute mark.", origin);
  }
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(startMs + SLOT_MS).toISOString();

  // One upcoming booking per learner (no lifetime cap in beta).
  const { active } = await bookingCounts(env, email);
  if (active >= MAX_ACTIVE) {
    return err(409, "You already have an upcoming session. Book another once it ends.", origin);
  }

  // Atomic, overlap-safe insert. Under D1's single-writer model the NOT EXISTS
  // probe and the insert are one serialized statement, so two overlapping
  // bookings can't both succeed. Half-open test: adjacent windows that touch at a
  // boundary (1AM–5AM after 9PM–1AM) do NOT overlap and are both allowed.
  const id = uuid();
  const res = await env.DB.prepare(
    `INSERT INTO slots (id, starts_at, ends_at, holder_email, status, payment_status, created_at)
     SELECT ?1, ?2, ?3, ?4, 'booked', 'free', ?5
     WHERE NOT EXISTS (
       SELECT 1 FROM slots
        WHERE status = 'booked' AND starts_at < ?3 AND ends_at > ?2
     )`,
  )
    .bind(id, startIso, endIso, email, nowIso())
    .run();
  if (!res.meta.changes) {
    return err(409, "That window overlaps an existing reservation — pick another start.", origin);
  }

  const base = appBase(env);
  const tmpl = bookingEmail({ startUtc: startIso, endUtc: endIso, launchUrl: `${base}/portal`, cancelUrl: `${base}/portal`, tz: body.tz });
  const ics = buildIcs({
    uid: `slot-${id}@aidc`,
    start: startIso,
    end: endIso,
    stamp: nowIso(),
    summary: "AIDC Lab — hands-on fabric session",
    description: "Exclusive hands-on access to the AI DC lab fabric. Open the workbench and click Start.",
    url: `${base}/portal`,
  });
  ctx.waitUntil(
    sendEmail(env, { to: email, ...tmpl, attachments: [{ filename: "aidc-lab-session.ics", content: b64(ics) }] }),
  );
  return json({ ok: true, id, starts_at: startIso, ends_at: endIso, status: "booked" }, {}, origin);
}

// POST /api/slots/:id/cancel  — hard-delete a booking the caller holds, freeing
// the window immediately. Cancelling never counts against the learner.
async function cancelSlot(id: string, env: Env, email: string, origin: string | null): Promise<Response> {
  const res = await env.DB.prepare(
    "DELETE FROM slots WHERE id = ?1 AND holder_email = ?2 AND status = 'booked'",
  )
    .bind(id, email)
    .run();
  if (!res.meta.changes) return err(403, "You don't hold that booking", origin);
  return json({ ok: true, id, status: "cancelled" }, {}, origin);
}

// ---- training roster --------------------------------------------------------

async function nextTraining(env: Env, email: string, origin: string | null): Promise<Response> {
  const session: any = await env.DB.prepare(
    `SELECT id, title, starts_at, capacity, location FROM training_sessions
      WHERE starts_at >= ?1 ORDER BY starts_at ASC LIMIT 1`,
  )
    .bind(nowIso())
    .first();
  if (!session) return json({ session: null }, {}, origin);

  const count: any = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM training_signups WHERE session_id = ?1",
  )
    .bind(session.id)
    .first();
  const mine: any = await env.DB.prepare(
    "SELECT 1 FROM training_signups WHERE session_id = ?1 AND email = ?2",
  )
    .bind(session.id, email)
    .first();

  return json(
    {
      session: {
        id: session.id,
        title: session.title,
        starts_at: session.starts_at,
        capacity: session.capacity,
        location: session.location,
        signups: count?.n ?? 0,
        signed_up: Boolean(mine),
      },
    },
    {},
    origin,
  );
}

// POST /api/training/:id/signup  — add my name (idempotent). Emails on first join.
async function signupTraining(id: string, req: Request, env: Env, ctx: ExecutionContext, email: string, origin: string | null): Promise<Response> {
  const session: any = await env.DB.prepare(
    "SELECT title, starts_at, location, capacity FROM training_sessions WHERE id = ?1",
  )
    .bind(id)
    .first();
  if (!session) return err(404, "No such training session", origin);

  const already: any = await env.DB.prepare(
    "SELECT 1 FROM training_signups WHERE session_id = ?1 AND email = ?2",
  )
    .bind(id, email)
    .first();

  if (session.capacity != null && !already) {
    const count: any = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM training_signups WHERE session_id = ?1",
    )
      .bind(id)
      .first();
    if ((count?.n ?? 0) >= session.capacity) return err(409, "Training is full", origin);
  }

  let name: string | null = null;
  let tz: string | undefined;
  try {
    const body = (await req.json()) as { name?: string; tz?: string };
    name = body?.name ?? null;
    tz = body?.tz;
  } catch {
    /* name + tz optional */
  }

  await env.DB.prepare(
    `INSERT INTO training_signups (id, session_id, email, name, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (session_id, email) DO UPDATE SET name = excluded.name`,
  )
    .bind(uuid(), id, email, name, nowIso())
    .run();

  if (!already) {
    const tmpl = trainingEmail({ title: session.title, startUtc: session.starts_at, location: session.location, tz });
    const ics = buildIcs({
      uid: `training-${id}@aidc`,
      start: session.starts_at,
      end: new Date(new Date(session.starts_at).getTime() + 90 * 60_000).toISOString(),
      stamp: nowIso(),
      summary: session.title,
      description: "AIDC Labs instructor-led training session.",
      url: `${appBase(env)}/portal`,
    });
    ctx.waitUntil(
      sendEmail(env, { to: email, ...tmpl, attachments: [{ filename: "aidc-training.ics", content: b64(ics) }] }),
    );
  }
  return json({ ok: true, signed_up: true }, {}, origin);
}

async function unsignupTraining(id: string, env: Env, email: string, origin: string | null): Promise<Response> {
  await env.DB.prepare("DELETE FROM training_signups WHERE session_id = ?1 AND email = ?2")
    .bind(id, email)
    .run();
  return json({ ok: true, signed_up: false }, {}, origin);
}

// ---- fabric holder ----------------------------------------------------------

// GET /api/holder/status  — browser-facing: does *the caller* hold the fabric now?
async function holderStatus(env: Env, email: string, origin: string | null): Promise<Response> {
  const now = nowIso();
  const row: any = await env.DB.prepare(
    `SELECT holder_email, ends_at FROM slots
      WHERE status = 'booked' AND starts_at <= ?1 AND ends_at > ?1
      ORDER BY starts_at ASC LIMIT 1`,
  )
    .bind(now)
    .first();
  return json(
    { reserved: Boolean(row), you_hold: Boolean(row) && row.holder_email === email, ends_at: row?.ends_at ?? null },
    {},
    origin,
  );
}

// GET /api/holder/current  — server-to-server (ORCH_SHARED_SECRET); the gate calls this.
async function currentHolder(req: Request, env: Env): Promise<Response> {
  const secret = req.headers.get("X-Orch-Secret");
  if (!env.ORCH_SHARED_SECRET || secret !== env.ORCH_SHARED_SECRET) {
    return new Response(JSON.stringify({ detail: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  const now = nowIso();
  const row: any = await env.DB.prepare(
    `SELECT holder_email, ends_at FROM slots
      WHERE status = 'booked' AND starts_at <= ?1 AND ends_at > ?1
      ORDER BY starts_at ASC LIMIT 1`,
  )
    .bind(now)
    .first();
  return new Response(
    JSON.stringify({ holder_email: row?.holder_email ?? null, ends_at: row?.ends_at ?? null }),
    { headers: { "content-type": "application/json" } },
  );
}

// ---- admin (instructor-only) ------------------------------------------------

async function adminCreateSlots(req: Request, env: Env, origin: string | null): Promise<Response> {
  const body = (await req.json()) as { starts_at?: string; slot_minutes?: number; count?: number };
  const start = body.starts_at ? new Date(body.starts_at) : new Date();
  const minutes = body.slot_minutes ?? 60;
  const count = Math.min(body.count ?? 1, 200);
  if (Number.isNaN(start.getTime())) return err(400, "Invalid starts_at", origin);

  const created: string[] = [];
  const stmt = env.DB.prepare(
    `INSERT INTO slots (id, starts_at, ends_at, status, payment_status, created_at)
     VALUES (?1, ?2, ?3, 'available', 'free', ?4)`,
  );
  const batch = [];
  for (let i = 0; i < count; i++) {
    const s = new Date(start.getTime() + i * minutes * 60_000);
    const e = new Date(s.getTime() + minutes * 60_000);
    const id = uuid();
    created.push(id);
    batch.push(stmt.bind(id, s.toISOString(), e.toISOString(), nowIso()));
  }
  await env.DB.batch(batch);
  return json({ ok: true, created: created.length }, {}, origin);
}

// GET /api/admin/bookings — instructor-only ledger of everything booked: every
// self-serve fabric reservation (with the booker's email) plus the full
// instructor-led training roster. The instructor gate is applied by the router
// (path.startsWith("/api/admin/") => email === INSTRUCTOR_EMAIL), so this is the
// only place learner emails are exposed; the learner-facing /api/slots never is.
async function adminListBookings(env: Env, origin: string | null): Promise<Response> {
  const now = nowIso();
  const labRows = await env.DB.prepare(
    `SELECT id, holder_email, starts_at, ends_at, payment_status, created_at
       FROM slots WHERE status = 'booked' ORDER BY starts_at DESC`,
  ).all();
  const trainingRows = await env.DB.prepare(
    `SELECT su.id, su.email, su.name, su.created_at,
            ts.id AS session_id, ts.title AS session_title, ts.starts_at AS session_starts_at
       FROM training_signups su
       JOIN training_sessions ts ON ts.id = su.session_id
      ORDER BY ts.starts_at DESC, su.created_at ASC`,
  ).all();

  const lab_bookings = (labRows.results ?? []) as any[];
  const upcoming = lab_bookings.filter((b) => b.ends_at > now).length;
  return json(
    {
      generated_at: now,
      summary: { lab_total: lab_bookings.length, lab_upcoming: upcoming, training_signups: (trainingRows.results ?? []).length },
      lab_bookings,
      training_signups: trainingRows.results ?? [],
    },
    {},
    origin,
  );
}

async function adminCreateTraining(req: Request, env: Env, origin: string | null): Promise<Response> {
  const body = (await req.json()) as { title?: string; starts_at?: string; capacity?: number | null; location?: string | null };
  if (!body.title || !body.starts_at) return err(400, "title and starts_at are required", origin);
  if (Number.isNaN(new Date(body.starts_at).getTime())) return err(400, "Invalid starts_at", origin);
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO training_sessions (id, title, starts_at, capacity, location, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, body.title, new Date(body.starts_at).toISOString(), body.capacity ?? null, body.location ?? null, nowIso())
    .run();
  return json({ ok: true, id }, {}, origin);
}

// ---- router -----------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");
    const method = req.method;
    // Served same-origin under lab.<domain>/booking-api/* via a Workers Route.
    let path = url.pathname;
    if (path.startsWith("/booking-api")) path = path.slice("/booking-api".length) || "/";

    if (method === "OPTIONS") {
      const headers = new Headers();
      applyCors(headers, origin);
      return new Response(null, { status: 204, headers });
    }

    // Server-to-server (own auth).
    if (path === "/api/holder/current" && method === "GET") return currentHolder(req, env);

    // Auth — public to start (no session required).
    if (path === "/auth/request" && method === "POST") return authRequest(req, env, ctx, origin);
    if (path === "/auth/verify" && method === "GET") return authVerify(req, env);
    if (path === "/auth/logout" && method === "POST") return authLogout(origin);
    if (path === "/auth/me" && method === "GET") return authMe(req, env, origin);

    // Public marketing teasers (no auth).
    if (path === "/public/next-training" && method === "GET") return publicNextTraining(env, origin);
    if (path === "/public/availability" && method === "GET") return publicAvailability(env, origin);

    // Everything below requires a signed-in identity.
    const email = await authenticate(req, env);
    if (!email) return err(401, "Not signed in", origin);

    // Admin (instructor only).
    if (path.startsWith("/api/admin/")) {
      if (email !== env.INSTRUCTOR_EMAIL.toLowerCase()) return err(403, "Instructor only", origin);
      if (path === "/api/admin/bookings" && method === "GET") return adminListBookings(env, origin);
      if (path === "/api/admin/slots" && method === "POST") return adminCreateSlots(req, env, origin);
      if (path === "/api/admin/training" && method === "POST") return adminCreateTraining(req, env, origin);
      return err(404, "Unknown admin route", origin);
    }

    // Slots.
    if (path === "/api/slots" && method === "GET") return listSlots(req, env, email, origin);
    if (path === "/api/slots/book" && method === "POST") return bookSlot(req, env, ctx, email, origin);
    let m = path.match(/^\/api\/slots\/([^/]+)\/cancel$/);
    if (m && method === "POST") return cancelSlot(m[1], env, email, origin);

    // Fabric-holder status (banner).
    if (path === "/api/holder/status" && method === "GET") return holderStatus(env, email, origin);

    // Training roster.
    if (path === "/api/training/next" && method === "GET") return nextTraining(env, email, origin);
    m = path.match(/^\/api\/training\/([^/]+)\/signup$/);
    if (m && method === "POST") return signupTraining(m[1], req, env, ctx, email, origin);
    if (m && method === "DELETE") return unsignupTraining(m[1], env, email, origin);

    return err(404, "Not found", origin);
  },
};
