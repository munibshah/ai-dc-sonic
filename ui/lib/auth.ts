// Magic-link auth client. Talks to the booking Worker's /auth/* endpoints
// (same-origin under /booking-api), which issue/verify the aidc_auth cookie.

import { BOOKING_BASE } from "@/lib/booking";

const FETCH_OPTS: RequestInit = { credentials: "include", cache: "no-store" };

export interface Me {
  email: string;
  is_admin: boolean;
}

/** Email a sign-in link. Resolves regardless of whether the email exists. */
export async function requestMagicLink(email: string, next?: string): Promise<void> {
  const r = await fetch(`${BOOKING_BASE}/auth/request`, {
    ...FETCH_OPTS,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, next }),
  });
  if (!r.ok) {
    let detail = `request failed: ${r.status}`;
    try {
      const b = await r.json();
      if (b?.detail) detail = b.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
}

/** Current identity, or null when signed out. */
export async function getMe(): Promise<Me | null> {
  if (!BOOKING_BASE) return null;
  try {
    const r = await fetch(`${BOOKING_BASE}/auth/me`, FETCH_OPTS);
    if (!r.ok) return null;
    return (await r.json()) as Me;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${BOOKING_BASE}/auth/logout`, { ...FETCH_OPTS, method: "POST" });
  } catch {
    /* ignore */
  }
}
