/**
 * Transactional email via Resend, plus a tiny iCalendar (.ics) generator.
 *
 * sendEmail() is a no-op (returns false) when RESEND_API_KEY is unset, so the
 * booking flow keeps working in dev / before email is configured.
 */

export interface MailEnv {
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string; // e.g. "AIDC Labs <labs@munibshah.com>"
  APP_BASE_URL?: string; // e.g. "https://lab.munibshah.com"
}

interface Attachment {
  filename: string;
  content: string; // base64
}

export async function sendEmail(
  env: MailEnv,
  msg: { to: string; subject: string; html: string; text: string; attachments?: Attachment[] },
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    console.log(`[email] skipped (RESEND_API_KEY/FROM_EMAIL unset): ${msg.subject} -> ${msg.to}`);
    return false;
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: msg.attachments,
      }),
    });
    if (!r.ok) {
      console.log(`[email] resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.log(`[email] send failed: ${String(e)}`);
    return false;
  }
}

// ---- base64 (for .ics attachment) -------------------------------------------

export function b64(s: string): string {
  let out = "";
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

// ---- iCalendar --------------------------------------------------------------

function icsStamp(iso: string): string {
  // 2026-06-16T00:33:33.000Z -> 20260616T003333Z
  return iso.replace(/[-:]/g, "").replace(/\.\d+/, "");
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export function buildIcs(ev: {
  uid: string;
  start: string; // ISO UTC
  end: string; // ISO UTC
  stamp: string; // ISO UTC (now)
  summary: string;
  description: string;
  url?: string;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AIDC Labs//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${icsStamp(ev.stamp)}`,
    `DTSTART:${icsStamp(ev.start)}`,
    `DTEND:${icsStamp(ev.end)}`,
    `SUMMARY:${icsEscape(ev.summary)}`,
    `DESCRIPTION:${icsEscape(ev.description)}`,
    ev.url ? `URL:${ev.url}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.join("\r\n");
}

// ---- templates --------------------------------------------------------------

const SHELL = (body: string) =>
  `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1f2430;line-height:1.5">
     <div style="font-weight:700;font-size:18px;color:#6d28d9;margin-bottom:16px">AIDC Labs</div>
     ${body}
     <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
     <div style="font-size:12px;color:#888">AI Data Center networking labs · hands-on SONiC/FRR fabrics</div>
   </div>`;

// Human-friendly timestamp in the recipient's timezone (passed from the browser
// at booking time as an IANA name, e.g. "America/New_York"). Always carries the
// zone abbreviation so there's no ambiguity. Falls back to clearly-labelled UTC
// when no/invalid tz is supplied. The .ics still carries the exact UTC instant.
function fmtWhen(iso: string, tz?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: tz || "UTC",
    }).format(new Date(iso));
  } catch {
    try {
      return new Date(iso).toUTCString().replace("GMT", "UTC");
    } catch {
      return iso;
    }
  }
}

export function magicLinkEmail(link: string): { subject: string; html: string; text: string } {
  return {
    subject: "Your AIDC Labs sign-in link",
    html: SHELL(
      `<p>Click below to sign in. This link works once and expires in 15 minutes.</p>
       <p><a href="${link}" style="display:inline-block;background:#6d28d9;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Sign in to AIDC Labs</a></p>
       <p style="font-size:12px;color:#888">If you didn't request this, you can ignore this email.</p>`,
    ),
    text: `Sign in to AIDC Labs (expires in 15 min, single use):\n${link}\n\nIf you didn't request this, ignore this email.`,
  };
}

export function bookingEmail(opts: {
  startUtc: string;
  endUtc: string;
  launchUrl: string;
  cancelUrl: string;
  tz?: string;
}): { subject: string; html: string; text: string } {
  const start = fmtWhen(opts.startUtc, opts.tz);
  const end = fmtWhen(opts.endUtc, opts.tz);
  return {
    subject: `Lab slot confirmed — ${start}`,
    html: SHELL(
      `<p>Your hands-on lab slot is reserved. You'll have <b>exclusive access to the fabric</b> for this window.</p>
       <p><b>${start}</b> &rarr; ${end}<br/>
       <span style="font-size:12px;color:#888">A calendar invite is attached — it shows in your local time.</span></p>
       <p>When your slot starts, open the workbench and click Start:</p>
       <p><a href="${opts.launchUrl}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Launch the lab</a></p>
       <p style="font-size:12px;color:#888">Can't make it? <a href="${opts.cancelUrl}">Cancel this booking</a> to free the slot for others.</p>`,
    ),
    text: `Lab slot confirmed.\n${start} -> ${end} (calendar invite attached)\n\nLaunch: ${opts.launchUrl}\nCancel: ${opts.cancelUrl}`,
  };
}

export function trainingEmail(opts: {
  title: string;
  startUtc: string;
  location: string | null;
  tz?: string;
}): { subject: string; html: string; text: string } {
  const when = fmtWhen(opts.startUtc, opts.tz);
  return {
    subject: `You're registered — ${opts.title}`,
    html: SHELL(
      `<p>You're on the roster for the live instructor-led session.</p>
       <p><b>${opts.title}</b><br/>${when}<br/>
       ${opts.location ? `<span style="font-size:13px">${opts.location}</span>` : ""}</p>
       <p style="font-size:12px;color:#888">A calendar invite is attached. Joining details follow before the session.</p>`,
    ),
    text: `You're registered for ${opts.title}\n${when}\n${opts.location ?? ""}\n(calendar invite attached)`,
  };
}
