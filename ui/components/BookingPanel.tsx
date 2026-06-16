"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookingError,
  bookSlot,
  cancelSlot,
  joinTraining,
  leaveTraining,
  listSlots,
  nextTraining,
  type Slot,
  type TrainingSession,
} from "@/lib/booking";
import { useToasts } from "@/components/Toast";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtRange(start: string, end: string): string {
  try {
    const e = new Date(end);
    const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${fmtDate(start)} – ${time(e)}`;
  } catch {
    return `${start} – ${end}`;
  }
}

export default function BookingPanel() {
  const { push } = useToasts();
  const [session, setSession] = useState<TrainingSession | null | undefined>(undefined);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([nextTraining(), listSlots()]);
      setSession(t.session);
      setSlots(s.slots);
      setError(null);
    } catch (e) {
      const msg = e instanceof BookingError ? e.message : String(e);
      setError(msg);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const guard = async (key: string, fn: () => Promise<unknown>, okTitle: string) => {
    setBusy(key);
    try {
      await fn();
      push({ tone: "success", title: okTitle });
      await refresh();
    } catch (e) {
      const msg = e instanceof BookingError ? e.message : String(e);
      push({ tone: "error", title: "Something went wrong", body: msg });
    } finally {
      setBusy(null);
    }
  };

  if (error)
    return (
      <div className="p-6 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm">
        {error.includes("not configured")
          ? "Booking isn't set up on this deployment yet."
          : `Couldn't reach the booking service: ${error}`}
      </div>
    );

  const mine = (slots ?? []).filter((s) => s.mine);
  const available = (slots ?? []).filter((s) => !s.mine && s.status === "available");

  return (
    <div className="space-y-8">
      {/* ---- Instructor-led training ------------------------------------ */}
      <section className="rounded-2xl border border-purple-500/20 bg-gradient-to-br from-[#0b0820] via-[#120a2e] to-[#1a0d3b] p-6">
        <div className="text-[11px] uppercase tracking-[0.22em] text-purple-300/80 mb-2">
          Instructor-led
        </div>
        <h2 className="text-2xl font-semibold text-white">Book SONiC training</h2>
        {session === undefined ? (
          <p className="text-white/60 mt-3 text-sm">Loading…</p>
        ) : session === null ? (
          <p className="text-white/70 mt-3 text-sm">
            No training session is scheduled right now. Check back soon — the next cohort will appear
            here.
          </p>
        ) : (
          <div className="mt-4 flex flex-col md:flex-row md:items-end gap-4 md:gap-8">
            <div className="min-w-0">
              <div className="text-lg font-semibold text-white">{session.title}</div>
              <div className="text-sm text-white/70 mt-1">{fmtDate(session.starts_at)}</div>
              {session.location && (
                <div className="text-xs text-white/50 mt-1 break-words">{session.location}</div>
              )}
              <div className="text-xs text-white/50 mt-2">
                {session.signups} signed up
                {session.capacity != null ? ` · ${session.capacity - session.signups} spots left` : ""}
              </div>
            </div>
            <div className="md:ml-auto">
              {session.signed_up ? (
                <button
                  disabled={busy === "training"}
                  onClick={() =>
                    guard("training", () => leaveTraining(session.id), "Removed from the roster")
                  }
                  className="rounded-lg border border-white/20 px-4 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-50"
                >
                  You're in — remove my name
                </button>
              ) : (
                <button
                  disabled={busy === "training"}
                  onClick={() =>
                    guard("training", () => joinTraining(session.id), "Added to the roster")
                  }
                  className="rounded-lg bg-purple-500/80 hover:bg-purple-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  Add my name
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ---- Self-serve lab slots --------------------------------------- */}
      <section>
        <h2 className="text-xl font-semibold text-white">Reserve fabric time</h2>
        <p className="text-white/60 text-sm mt-1 max-w-2xl">
          The lab runs on one shared fabric, so each slot gives you exclusive use of it. While your
          slot is active you can Start, Reset, and Solve; outside it those actions are locked.
        </p>

        {mine.length > 0 && (
          <div className="mt-5">
            <div className="text-xs uppercase tracking-wider text-emerald-300/80 mb-2">Your bookings</div>
            <ul className="space-y-2">
              {mine.map((s) => {
                const now = Date.now();
                const live = new Date(s.starts_at).getTime() <= now && now < new Date(s.ends_at).getTime();
                return (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3"
                  >
                    <span className="text-sm text-white/90">{fmtRange(s.starts_at, s.ends_at)}</span>
                    {live && (
                      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/30 text-emerald-200 border border-emerald-400/40">
                        Live now
                      </span>
                    )}
                    {live && (
                      <a
                        href="/"
                        className="rounded-lg bg-emerald-500/80 hover:bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white"
                      >
                        Browse labs to run →
                      </a>
                    )}
                    <button
                      disabled={busy === s.id}
                      onClick={() => guard(s.id, () => cancelSlot(s.id), "Booking cancelled")}
                      className="ml-auto text-xs text-white/60 hover:text-rose-300 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="mt-5">
          <div className="text-xs uppercase tracking-wider text-white/50 mb-2">Available slots</div>
          {slots === null ? (
            <p className="text-white/60 text-sm">Loading…</p>
          ) : available.length === 0 ? (
            <p className="text-white/60 text-sm">No open slots right now — check back later.</p>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {available.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-3 rounded-xl border border-white/15 bg-black/40 px-4 py-3"
                >
                  <span className="text-sm text-white/90">{fmtRange(s.starts_at, s.ends_at)}</span>
                  <span className="text-[10px] uppercase tracking-wider text-white/40">Free</span>
                  <button
                    disabled={busy === s.id}
                    onClick={() => guard(s.id, () => bookSlot(s.id), "Slot reserved")}
                    className="ml-auto rounded-lg bg-sky-500/80 hover:bg-sky-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Reserve
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
