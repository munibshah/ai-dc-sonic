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

export interface Slot {
  id: string;
  starts_at: string;
  ends_at: string;
  status: "available" | "booked" | "cancelled";
  payment_status: "free" | "pending" | "paid";
  mine: boolean;
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

export function listSlots(): Promise<{ slots: Slot[] }> {
  return call<{ slots: Slot[] }>("/api/slots");
}

export function bookSlot(id: string): Promise<{ ok: boolean }> {
  return call(`/api/slots/${id}/book`, { method: "POST" });
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
    body: JSON.stringify({ name: name ?? null }),
  });
}

export function leaveTraining(id: string): Promise<{ ok: boolean }> {
  return call(`/api/training/${id}/signup`, { method: "DELETE" });
}

export function holderStatus(): Promise<HolderStatus> {
  return call<HolderStatus>("/api/holder/status");
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

export function publicAvailability(): Promise<{ open: number; next_slot: string | null }> {
  return call<{ open: number; next_slot: string | null }>("/public/availability");
}
