/**
 * Custom magic-link identity: the Worker is the auth authority (replaces
 * Cloudflare Access, which caps at 50 users on the free tier).
 *
 * Session cookie `aidc_auth` = base64url(JSON{email,iat,exp}).base64url(HMAC-SHA256(payloadB64, secret)).
 * Issued here after magic-link verify; verified here AND by the orchestrator
 * (same AIDC_AUTH_SECRET, stdlib HMAC) so both can identify the caller.
 */

export const SESSION_COOKIE = "aidc_auth";
const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

const enc = new TextEncoder();

function bytesToB64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToB64url(s: string): string {
  return bytesToB64url(enc.encode(s));
}

function b64urlToStr(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
}

async function hmacB64url(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Mint a signed session-cookie value for `email`. */
export async function signSession(email: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payloadB64 = strToB64url(JSON.stringify({ email, iat: now, exp: now + SESSION_TTL_SEC }));
  const sig = await hmacB64url(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/** Verify a session-cookie value; returns the email or null. */
export async function verifySession(value: string, secret: string): Promise<string | null> {
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = await hmacB64url(payloadB64, secret);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(b64urlToStr(payloadB64)) as { email?: string; exp?: number };
    if (!p.email || !p.exp || p.exp * 1000 < Date.now()) return null;
    return p.email;
  } catch {
    return null;
  }
}

/** Build the Set-Cookie header value for the session. */
export function sessionCookieHeader(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`;
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Read a named cookie out of a Cookie header. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ---- magic-link tokens ------------------------------------------------------

/** A URL-safe random token for the magic link (the raw value emailed). */
export function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToB64url(b);
}

/** SHA-256 hex of a token — only the hash is stored in D1. */
export async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
