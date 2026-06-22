// Booking backend client (Cloudflare Worker).
//
// The Worker is served SAME-ORIGIN as the UI under /booking-api/* (a Workers
// Route), so one Cloudflare Access login covers it and the identity cookie
// always travels. Resolution order:
//   1. NEXT_PUBLIC_BOOKING_API_BASE — set at build time (preferred, explicit).
//   2. window.location.origin + "/booking-api" — same-origin default.
//   3. empty string (SSR) => the panel renders a graceful "not configured" state.

function resolveBookingBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_BOOKING_API_BASE;
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") {
    return `${window.location.origin}/booking-api`;
  }
  return "";
}

export const BOOKING_BASE = resolveBookingBase();

// Same cross-origin posture as lib/api.ts: send credentials so the Cloudflare
// Access cookie travels (book.<domain> is same registrable domain as the UI).
const FETCH_OPTS: RequestInit = { credentials: "include", cache: "no-store" };

/** A real booking on the shared fabric. The API only returns booked windows;
 *  availability is computed client-side as the complement of these. */
export interface BookedWindow {
  id: string;
  starts_at: string;
  ends_at: string;
  /** True if this booking belongs to the caller. */
  mine: boolean;
}

/** Booking knobs surfaced by the server so the UI doesn't hard-code them. */
export interface BookingConfig {
  /** Session duration in minutes (240). */
  slot_minutes: number;
  /** Start-time granularity in minutes (30). */
  step_minutes: number;
  /** How far ahead a window may be booked, in days. */
  horizon_days: number;
}

export interface BookingLimits {
  /** Upcoming bookings the learner currently holds. */
  active: number;
  /** Max concurrent upcoming bookings allowed. */
  max_active: number;
}

export interface TrainingSession {
  id: string;
  title: string;
  starts_at: string;
  capacity: number | null;
  location: string | null;
  signups: number;
  signed_up: boolean;
}

export interface HolderStatus {
  /** A slot is active right now (held by the caller or someone else). */
  reserved: boolean;
  /** The caller holds the active slot. */
  you_hold: boolean;
  ends_at: string | null;
}

export class BookingError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

/** The browser's IANA timezone (e.g. "America/New_York"), sent with booking /
 * signup requests so confirmation emails render times in the user's zone. */
function browserTz(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BOOKING_BASE) throw new BookingError(0, "Booking service is not configured.");
  const r = await fetch(`${BOOKING_BASE}${path}`, { ...FETCH_OPTS, ...init });
  if (!r.ok) {
    let detail = `request failed: ${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new BookingError(r.status, detail);
  }
  return r.json() as Promise<T>;
}

export function listSlots(): Promise<{ booked: BookedWindow[]; config: BookingConfig; limits: BookingLimits }> {
  return call<{ booked: BookedWindow[]; config: BookingConfig; limits: BookingLimits }>("/api/slots");
}

export interface BookResult {
  ok: boolean;
  id: string;
  starts_at: string;
  ends_at: string;
}

/** Book a 4-hour window starting at a specific 30-minute mark (ISO UTC). */
export function bookSlot(startsAt: string): Promise<BookResult> {
  return call("/api/slots/book", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ starts_at: startsAt, tz: browserTz() }),
  });
}

/** Book a 4-hour window beginning immediately. */
export function bookNow(): Promise<BookResult> {
  return call("/api/slots/book", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ start_now: true, tz: browserTz() }),
  });
}

export function cancelSlot(id: string): Promise<{ ok: boolean }> {
  return call(`/api/slots/${id}/cancel`, { method: "POST" });
}

export function nextTraining(): Promise<{ session: TrainingSession | null }> {
  return call<{ session: TrainingSession | null }>("/api/training/next");
}

export function joinTraining(id: string, name?: string): Promise<{ ok: boolean }> {
  return call(`/api/training/${id}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: name ?? null, tz: browserTz() }),
  });
}

export function leaveTraining(id: string): Promise<{ ok: boolean }> {
  return call(`/api/training/${id}/signup`, { method: "DELETE" });
}

export function holderStatus(): Promise<HolderStatus> {
  return call<HolderStatus>("/api/holder/status");
}

// ---- admin (instructor-only) ------------------------------------------------

/** One self-serve fabric reservation, as seen by the instructor (includes the
 *  booker's email — never exposed on the learner-facing /api/slots). */
export interface AdminLabBooking {
  id: string;
  holder_email: string | null;
  starts_at: string;
  ends_at: string;
  payment_status: string;
  created_at: string;
}

/** One learner on an instructor-led training session. */
export interface AdminTrainingSignup {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  session_id: string;
  session_title: string;
  session_starts_at: string;
}

export interface AdminBookings {
  generated_at: string;
  summary: { lab_total: number; lab_upcoming: number; training_signups: number };
  lab_bookings: AdminLabBooking[];
  training_signups: AdminTrainingSignup[];
}

/** Instructor-only ledger. Returns 403 (BookingError) for non-instructors;
 *  the server enforces this, the page only gates the UI. */
export function adminBookings(): Promise<AdminBookings> {
  return call<AdminBookings>("/api/admin/bookings");
}

// ---- public (unauthenticated) teasers for the marketing page ----------------

export interface PublicTraining {
  title: string;
  starts_at: string;
  seats_left: number | null;
}

export function publicNextTraining(): Promise<{ session: PublicTraining | null }> {
  return call<{ session: PublicTraining | null }>("/public/next-training");
}

export function publicAvailability(): Promise<{ open: boolean; next_free: string }> {
  return call<{ open: boolean; next_free: string }>("/public/availability");
}
