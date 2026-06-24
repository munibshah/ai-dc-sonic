"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchProgress } from "@/lib/api";
import { cancelSlot, holderStatus, listSlots, type BookedWindow } from "@/lib/booking";
import LabJourney from "@/components/LabJourney";
import ConfirmDialog from "@/components/ConfirmDialog";
import SessionResetModal from "@/components/SessionResetModal";
import FabricExpiryWatcher from "@/components/FabricExpiryWatcher";
import { useToasts } from "@/components/Toast";
import { ArrowRight, Calendar, Clock, ShieldCheck } from "@/components/icons";

// A 1-second ticking clock so the countdown feels live.
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function fmtClock(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function LabLauncher() {
  const { push } = useToasts();
  const [slots, setSlots] = useState<BookedWindow[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // The slot the learner is ending; drives the reset modal. Captured when they
  // confirm so the modal can cancel it after the fabric is wiped clean.
  const [endingSlotId, setEndingSlotId] = useState<string | null>(null);
  const now = useNow();

  const load = useCallback(async () => {
    const res = await Promise.allSettled([listSlots(), fetchProgress(), holderStatus()]);
    if (res[0].status === "fulfilled") setSlots(res[0].value.booked);
    else setSlots([]);
    if (res[1].status === "fulfilled") setCurrent(res[1].value.current);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const mine = (slots ?? []).filter((s) => s.mine);
  const live = mine.find((s) => new Date(s.starts_at).getTime() <= now && now < new Date(s.ends_at).getTime());
  const upcoming = mine
    .filter((s) => new Date(s.starts_at).getTime() > now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  const resumeLab = current ?? "1";

  // Confirm → open the reset modal, which wipes the fabric back to Lab 1 with
  // live progress, then cancels the booking (afterReset) and reloads.
  function confirmEndSession() {
    if (!live) return;
    setEndingSlotId(live.id);
    setConfirmEnd(false);
  }

  return (
    <div className="space-y-8">
      {/* Exclusivity hero */}
      {!loaded ? (
        <div className="h-44 rounded-3xl border border-white/10 bg-black/20 animate-pulse" />
      ) : live ? (
        <section className="brand-hero rounded-3xl px-6 py-8 md:px-10 md:py-10">
          <div className="relative flex flex-col md:flex-row md:items-center gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 live-dot" aria-hidden />
                <span className="eyebrow">Live now · exclusive access</span>
              </div>
              <h1 className="text-3xl md:text-4xl font-semibold text-white tracking-tight">The fabric is yours.</h1>
              <p className="text-white/70 mt-2 max-w-xl leading-relaxed">
                You have sole control of the lab fabric for this window — no sharing, no clobbering. Pick up where
                you left off and keep building.
              </p>
              <div className="mt-5 inline-flex items-center gap-2.5 rounded-xl border border-white/12 bg-black/30 px-4 py-2.5">
                <Clock className="w-4 h-4 text-[var(--accent-positive)]" />
                <span className="text-sm text-white/70">Time remaining</span>
                <span className="font-mono text-lg font-semibold text-white tabular-nums">
                  {fmtCountdown(new Date(live.ends_at).getTime() - now)}
                </span>
              </div>
            </div>
            <div className="md:ml-auto shrink-0 flex flex-col items-stretch md:items-end gap-2">
              <Link href={`/portal/labs/${resumeLab}`} className="btn btn-primary btn-lg">
                Enter Lab {resumeLab} <ArrowRight className="w-4 h-4" />
              </Link>
              <button
                onClick={() => setConfirmEnd(true)}
                className="text-xs text-white/60 hover:text-rose-300 transition-colors"
              >
                End session early
              </button>
            </div>
          </div>
        </section>
      ) : upcoming ? (
        <section className="brand-hero rounded-3xl px-6 py-8 md:px-10 md:py-10">
          <div className="relative flex flex-col md:flex-row md:items-center gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <Calendar className="w-4 h-4 text-[var(--accent-brand)]" />
                <span className="eyebrow">Your session is reserved</span>
              </div>
              <h1 className="text-3xl md:text-4xl font-semibold text-white tracking-tight">
                The fabric is held for you.
              </h1>
              <p className="text-white/70 mt-2 leading-relaxed">
                Starts {fmtClock(upcoming.starts_at)} — it&apos;s yours for the full window. Come back then to launch.
              </p>
              <div className="mt-5 inline-flex items-center gap-2.5 rounded-xl border border-white/12 bg-black/30 px-4 py-2.5">
                <Clock className="w-4 h-4 text-[var(--accent-brand)]" />
                <span className="text-sm text-white/70">Starts in</span>
                <span className="font-mono text-lg font-semibold text-white tabular-nums">
                  {fmtCountdown(new Date(upcoming.starts_at).getTime() - now)}
                </span>
              </div>
            </div>
            <div className="md:ml-auto shrink-0">
              <Link href="/portal/book" className="btn btn-secondary">
                Manage booking
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <section className="brand-hero rounded-3xl px-6 py-8 md:px-10 md:py-10">
          <div className="relative flex flex-col md:flex-row md:items-center gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <ShieldCheck className="w-4 h-4 text-[var(--accent-brand)]" />
                <span className="eyebrow">Hands-on, exclusive</span>
              </div>
              <h1 className="text-3xl md:text-4xl font-semibold text-white tracking-tight">
                Reserve a slot to unlock the labs.
              </h1>
              <p className="text-white/70 mt-2 max-w-xl leading-relaxed">
                Book a window and the entire fabric is yours alone for the session. Lab 1 opens the moment your
                slot goes live; clear it to unlock Lab 2, and on through the journey.
              </p>
            </div>
            <div className="md:ml-auto shrink-0">
              <Link href="/portal/book" className="btn btn-primary btn-lg">
                Book a slot <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* The journey */}
      <LabJourney />

      {/* Auto-reset the moment a live window's timer lapses. */}
      <FabricExpiryWatcher />

      <ConfirmDialog
        open={confirmEnd}
        title="End your session early?"
        danger
        confirmLabel="End session"
        cancelLabel="Keep my session"
        onCancel={() => setConfirmEnd(false)}
        onConfirm={confirmEndSession}
        body={
          <span>
            This ends your window now and <strong className="text-white">resets the lab back to Lab 1&apos;s
            starting point</strong> so the next learner starts clean. You&apos;ll forfeit the
            {live ? <strong className="text-white"> {fmtCountdown(new Date(live.ends_at).getTime() - now)} </strong> : " time "}
            remaining. Your cleared-lab progress is saved — you can book again anytime.
          </span>
        }
      />

      {/* Explicit end-session reset: wipe the fabric (with progress), then free the slot. */}
      <SessionResetModal
        open={endingSlotId !== null}
        mode="end"
        afterReset={async () => {
          if (endingSlotId) await cancelSlot(endingSlotId);
        }}
        onFinished={() => {
          setEndingSlotId(null);
          push({ tone: "success", title: "Session ended — the lab is reset and the fabric is free." });
          load();
        }}
      />
    </div>
  );
}
