"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookingError,
  bookSlot,
  bookNow,
  cancelSlot,
  listSlots,
  type BookingConfig,
  type BookingLimits,
  type BookedWindow,
} from "@/lib/booking";
import { useToasts } from "@/components/Toast";
import ConfirmDialog from "@/components/ConfirmDialog";
import { ArrowRight, Check, Clock, Lock, Bolt } from "@/components/icons";
import { fetchProgress } from "@/lib/api";

const DAY_MS = 86_400_000;
const HORIZON_DAYS = 14;

const TZ_LABEL = (() => {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "local time";
  } catch {
    return "local time";
  }
})();

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function fmtTime(iso: string | number): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtDayLong(iso: string | number): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
/** Time range; appends a "+1d" hint when the 4-hour window crosses local midnight. */
function fmtRange(start: string | number, end: string | number): string {
  const s = new Date(start);
  const e = new Date(end);
  const crosses = s.getDate() !== e.getDate() || s.getMonth() !== e.getMonth() || s.getFullYear() !== e.getFullYear();
  return `${fmtTime(s.getTime())} – ${fmtTime(e.getTime())}${crosses ? " (+1d)" : ""}`;
}

type CandState = "available" | "unavailable" | "past";

export default function BookingCalendar() {
  const { push } = useToasts();
  const [booked, setBooked] = useState<BookedWindow[] | null>(null);
  const [config, setConfig] = useState<BookingConfig | null>(null);
  const [limits, setLimits] = useState<BookingLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<
    | { kind: "now" }
    | { kind: "book"; startMs: number }
    | { kind: "cancel"; id: string; startsAt: string; endsAt: string }
    | null
  >(null);
  // Where "Launch" drops the learner: their current lab in the journey (Lab 1 first time).
  const [resumeLab, setResumeLab] = useState("1");

  useEffect(() => {
    let alive = true;
    fetchProgress()
      .then((p) => alive && p.current && setResumeLab(p.current))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await listSlots();
      setBooked(r.booked);
      setConfig(r.config);
      setLimits(r.limits);
      setError(null);
    } catch (e) {
      setError(e instanceof BookingError ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const todayKey = dayKey(new Date());
  useEffect(() => {
    if (!selectedKey && booked) setSelectedKey(todayKey);
  }, [booked, selectedKey, todayKey]);

  const now = Date.now();
  const slotMs = (config?.slot_minutes ?? 240) * 60_000;
  const stepMs = (config?.step_minutes ?? 30) * 60_000;

  // Booked windows as numeric intervals (computed once per refresh).
  const intervals = useMemo(
    () => (booked ?? []).map((b) => ({ bs: new Date(b.starts_at).getTime(), be: new Date(b.ends_at).getTime() })),
    [booked],
  );

  // The caller's own current/upcoming booking (max 1 active). The API only
  // returns windows ending in the future, so this is never a stale past slot.
  const myBooking = useMemo(() => {
    const mine = (booked ?? []).filter((b) => b.mine).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return mine[0] ?? null;
  }, [booked]);
  const myLive = myBooking && new Date(myBooking.starts_at).getTime() <= now && now < new Date(myBooking.ends_at).getTime();

  // Is the fabric free at this instant (nobody's window covers now)?
  const liveInterval = intervals.find((i) => i.bs <= now && now < i.be);
  const freeNow = !liveInterval;

  const capActive = !!limits && limits.active >= limits.max_active;

  // Half-open overlap test, identical to the server's guard.
  const candState = useCallback(
    (startMs: number): CandState => {
      if (startMs <= now) return "past";
      if (startMs > now + HORIZON_DAYS * DAY_MS) return "past"; // beyond horizon — treat as unbookable
      const end = startMs + slotMs;
      for (const { bs, be } of intervals) if (bs < end && be > startMs) return "unavailable";
      return "available";
    },
    [now, slotMs, intervals],
  );

  // All 30-min start marks on a given LOCAL day (00:00 → 23:30).
  const dayStarts = useCallback(
    (d: Date): number[] => {
      const out: number[] = [];
      const base = startOfDay(d).getTime();
      for (let t = base; t < base + DAY_MS; t += stepMs) out.push(t);
      return out;
    },
    [stepMs],
  );

  const dayHasAvailability = useCallback(
    (d: Date) => dayStarts(d).some((t) => candState(t) === "available"),
    [dayStarts, candState],
  );

  const base = startOfDay(new Date());
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(base.getTime() + (weekOffset * 7 + i) * DAY_MS)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weekOffset],
  );
  const maxOffset = Math.floor((HORIZON_DAYS - 1) / 7);

  const selectedDate = useMemo(() => {
    const k = selectedKey ?? todayKey;
    return days.find((d) => dayKey(d) === k) ?? new Date();
  }, [selectedKey, todayKey, days]);

  // Future 30-min starts on the selected day (past marks hidden; "now" is the
  // Start-now card's job, not the list's).
  const selectedStarts = useMemo(
    () => dayStarts(selectedDate).map((t) => ({ t, st: candState(t) })).filter((c) => c.st !== "past"),
    [dayStarts, selectedDate, candState],
  );

  async function runAction(fn: () => Promise<unknown>, okTitle: string) {
    setBusy(true);
    try {
      await fn();
      push({ tone: "success", title: okTitle });
      await refresh();
    } catch (e) {
      push({ tone: "error", title: "Couldn't complete that", body: e instanceof BookingError ? e.message : String(e) });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }
  const doNow = () => runAction(() => bookNow(), "Session started — the fabric is yours. Check your email for the invite.");
  const doBook = (startMs: number) =>
    runAction(() => bookSlot(new Date(startMs).toISOString()), "Slot reserved — check your email for the calendar invite.");
  const doCancel = (id: string) => runAction(() => cancelSlot(id), "Booking cancelled — the window is free again.");

  if (error) {
    return (
      <div className="p-6 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm">
        {error.includes("not configured")
          ? "Booking isn't set up on this deployment yet."
          : `Couldn't reach the booking service: ${error}`}
      </div>
    );
  }

  const loading = booked === null;

  return (
    <section className="rounded-2xl border border-white/10 bg-black/30 overflow-hidden">
      {/* Header */}
      <div className="p-6 md:p-7 border-b border-white/10">
        <h2 className="text-xl font-semibold text-white">Reserve fabric time</h2>
        <p className="text-white/60 text-sm mt-1 max-w-2xl leading-relaxed">
          The lab runs on one shared fabric, so each 4-hour session gives you exclusive use of it. Start one right
          now, or pick any 30-minute start time that suits you.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          {limits && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-white/70">
              <Clock className="w-3.5 h-3.5" />
              {limits.active} upcoming · {limits.max_active} at a time
            </span>
          )}
          <span className="text-white/40 ml-auto">Times shown in {TZ_LABEL}</span>
        </div>
      </div>

      {/* My booking — shown when the learner already holds a session. */}
      {myBooking && (
        <div className="mx-4 md:mx-6 mt-5 rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-4 flex flex-wrap items-center gap-3">
          <Check className="w-5 h-5 text-emerald-300 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-white">
              {myLive ? "Your session is live" : "Your upcoming session"}
            </div>
            <div className="text-xs text-white/60 mt-0.5">
              {fmtDayLong(myBooking.starts_at)} · {fmtRange(myBooking.starts_at, myBooking.ends_at)}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {myLive && (
              <a href={`/portal/labs/${resumeLab}`} className="btn btn-success btn-sm">
                Launch <ArrowRight className="w-3.5 h-3.5" />
              </a>
            )}
            <button
              onClick={() => setConfirm({ kind: "cancel", id: myBooking.id, startsAt: myBooking.starts_at, endsAt: myBooking.ends_at })}
              disabled={busy}
              className="text-xs text-white/60 hover:text-rose-300 transition-colors disabled:opacity-50"
            >
              {myLive ? "End session" : "Cancel"}
            </button>
          </div>
        </div>
      )}

      {/* Start now — the headline action when the fabric is free and you have no booking. */}
      {!myBooking && (
        <div className="mx-4 md:mx-6 mt-5">
          {freeNow ? (
            <button
              onClick={() => setConfirm({ kind: "now" })}
              disabled={busy || capActive || loading}
              className="w-full text-left rounded-xl border border-[var(--accent-brand-line)] bg-[var(--accent-brand-soft)] p-4 flex items-center gap-3 transition-colors hover:border-[var(--accent-brand)] disabled:opacity-50"
            >
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--accent-brand)] text-[var(--accent-brand-ink)] shrink-0">
                <Bolt className="w-5 h-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-white">Start a session now</span>
                <span className="block text-xs text-white/60 mt-0.5">
                  The fabric is free — claim it for 4 hours, {fmtTime(now)} to {fmtTime(now + slotMs)}.
                </span>
              </span>
              <ArrowRight className="ml-auto w-4 h-4 text-[var(--accent-brand)] shrink-0" />
            </button>
          ) : (
            <div className="w-full rounded-xl border border-white/10 bg-white/5 p-4 flex items-center gap-3 text-white/60">
              <Lock className="w-5 h-5 shrink-0 text-white/40" />
              <span className="text-sm">
                The fabric is in use right now. It frees up at{" "}
                <strong className="text-white/80">{liveInterval ? fmtTime(liveInterval.be) : "soon"}</strong> — book a
                start time below.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Week strip */}
      <div className="px-4 md:px-6 pt-5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous week"
            disabled={weekOffset <= 0}
            onClick={() => setWeekOffset((w) => Math.max(0, w - 1))}
            className="btn btn-ghost btn-sm shrink-0 disabled:opacity-30"
          >
            <ArrowRight className="w-4 h-4 rotate-180" />
          </button>
          <div className="grid grid-cols-7 gap-1.5 flex-1 min-w-0">
            {days.map((d) => {
              const k = dayKey(d);
              const hasOpen = dayHasAvailability(d);
              const selected = k === (selectedKey ?? todayKey);
              const isToday = k === todayKey;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSelectedKey(k)}
                  className={`flex flex-col items-center gap-1 py-2 rounded-xl border text-center transition-colors ${
                    selected
                      ? "border-transparent bg-[var(--accent-brand)] text-[var(--accent-brand-ink)]"
                      : "border-white/10 bg-white/5 hover:bg-white/10 text-white/80"
                  }`}
                >
                  <span className={`text-[10px] uppercase tracking-wider ${selected ? "opacity-80" : "text-white/40"}`}>
                    {d.toLocaleDateString(undefined, { weekday: "short" })}
                  </span>
                  <span className="text-base font-semibold leading-none">{d.getDate()}</span>
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      hasOpen ? (selected ? "bg-[var(--accent-brand-ink)]" : "bg-emerald-400") : "bg-transparent"
                    }`}
                    aria-hidden
                  />
                  {isToday && !selected && <span className="sr-only">Today</span>}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="Next week"
            disabled={weekOffset >= maxOffset}
            onClick={() => setWeekOffset((w) => Math.min(maxOffset, w + 1))}
            className="btn btn-ghost btn-sm shrink-0 disabled:opacity-30"
          >
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Selected-day start times */}
      <div className="p-4 md:p-6 pt-4">
        <div className="text-xs text-white/40 mb-3">
          Pick a start time on <span className="text-white/70">{fmtDayLong(selectedDate.getTime())}</span> — each session
          runs 4 hours.
        </div>
        {loading ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-10 rounded-lg border border-white/10 bg-black/20 animate-pulse" />
            ))}
          </div>
        ) : selectedStarts.length === 0 ? (
          <p className="text-white/50 text-sm py-6 text-center">No start times left on this day — try another.</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {selectedStarts.map(({ t, st }) => {
              const unavailable = st === "unavailable";
              return (
                <button
                  key={t}
                  type="button"
                  disabled={unavailable || busy || capActive || !!myBooking}
                  onClick={() => setConfirm({ kind: "book", startMs: t })}
                  title={unavailable ? "Overlaps an existing reservation" : `${fmtRange(t, t + slotMs)}`}
                  className={`h-10 rounded-lg border text-sm font-medium tabular-nums transition-colors ${
                    unavailable
                      ? "border-white/10 bg-transparent text-white/40 line-through cursor-not-allowed"
                      : "border-white/15 bg-white/5 text-white/80 hover:border-[var(--accent-brand-line)] hover:bg-[var(--accent-brand-soft)] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-white/15 disabled:hover:bg-white/5"
                  }`}
                >
                  {fmtTime(t)}
                </button>
              );
            })}
          </div>
        )}
        {capActive && !myBooking && (
          <p className="text-amber-300 text-xs mt-3">
            You already have an upcoming session. Cancel it to book a different time.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={
          confirm?.kind === "cancel"
            ? myLive
              ? "End this session?"
              : "Cancel this booking?"
            : confirm?.kind === "now"
            ? "Start a session now?"
            : "Reserve this slot?"
        }
        danger={confirm?.kind === "cancel"}
        confirmLabel={
          confirm?.kind === "cancel" ? (myLive ? "End session" : "Cancel booking") : confirm?.kind === "now" ? "Start now" : "Reserve slot"
        }
        cancelLabel="Keep browsing"
        busy={busy}
        busyBody={confirm?.kind === "cancel" ? "Cancelling…" : "Reserving…"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "cancel") doCancel(confirm.id);
          else if (confirm.kind === "now") doNow();
          else doBook(confirm.startMs);
        }}
        body={
          confirm ? (
            <span>
              {confirm.kind === "cancel" ? (
                <>
                  {myLive ? "End your live session" : "Release"}{" "}
                  <strong className="text-white">
                    {fmtDayLong(confirm.startsAt)}, {fmtRange(confirm.startsAt, confirm.endsAt)}
                  </strong>
                  . The fabric will be free for others{myLive ? " right away — your lab progress is saved" : ""}.
                </>
              ) : confirm.kind === "now" ? (
                <>
                  Claim the fabric for{" "}
                  <strong className="text-white">the next 4 hours, {fmtTime(now)} to {fmtTime(now + slotMs)}</strong>. You&apos;ll get
                  a confirmation email with a calendar invite.
                </>
              ) : (
                <>
                  Reserve the fabric for{" "}
                  <strong className="text-white">
                    {fmtDayLong(confirm.startMs)}, {fmtRange(confirm.startMs, confirm.startMs + slotMs)}
                  </strong>
                  . You&apos;ll get a confirmation email with a calendar invite.
                </>
              )}
            </span>
          ) : null
        }
      />
    </section>
  );
}
