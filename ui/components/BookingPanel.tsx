"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  BookingError,
  joinTraining,
  leaveTraining,
  nextTraining,
  type TrainingSession,
} from "@/lib/booking";
import { useToasts } from "@/components/Toast";
import BookingCalendar from "@/components/BookingCalendar";
import { ArrowRight, Calendar, ShieldCheck } from "@/components/icons";

// Instructor credibility — the Cisco certs that make this session worth a slot.
// Files live in ui/public/badges/ (official badge art, used at small size).
const INSTRUCTOR_BADGES = [
  { src: "/badges/ccie-security.png", label: "CCIE Security" },
  { src: "/badges/ccie-datacenter.png", label: "CCIE Data Center" },
  { src: "/badges/ccie-enterprise.png", label: "CCIE Enterprise" },
  { src: "/badges/ccna-automation.png", label: "CCNA Automation" },
];

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

export default function BookingPanel() {
  const { push } = useToasts();
  const [session, setSession] = useState<TrainingSession | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const t = await nextTraining();
      setSession(t.session);
    } catch {
      setSession(null);
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

  return (
    <div className="space-y-8">
      {/* ---- Self-serve lab slots (calendar) ---------------------------- */}
      <BookingCalendar />

      {/* ---- Instructor-led training ------------------------------------ */}
      <section className="brand-hero rounded-2xl p-6 md:p-7">
        <div className="relative">
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="w-4 h-4 text-[var(--accent-brand)]" />
            <span className="eyebrow">Instructor-led</span>
          </div>
          <h2 className="text-2xl font-semibold text-white">Book SONiC training</h2>
          <p className="text-sm text-white/70 mt-2 max-w-prose">
            Live, hands-on sessions on SONiC and AI-fabric networking — taught personally by a
            quadruple-certified Cisco expert.
          </p>

          {/* ---- Instructor credibility ---- */}
          <div className="mt-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <Image
              src="/instructor/munib-shah.png"
              alt="Munib Shah, instructor"
              width={96}
              height={96}
              className="w-20 h-20 sm:w-24 sm:h-24 shrink-0 rounded-2xl object-cover object-top ring-1 ring-[var(--accent-brand-line)] shadow-lg shadow-black/30"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-base font-semibold text-white">Munib Shah</span>
                <ShieldCheck className="w-4 h-4 text-[var(--accent-brand)]" />
              </div>
              <div className="text-xs uppercase tracking-[0.14em] text-white/45 mt-0.5">
                Your instructor
              </div>
              <div className="text-sm text-white/70 mt-1.5">
                Triple CCIE — Security, Data Center &amp; Enterprise — plus CCNA Automation.
              </div>
            </div>
          </div>

          {/* ---- Certification badges ----
              Source art is inconsistent: the CCIE Security / Data Center PNGs
              ship on an opaque white square, the Enterprise / CCNA ones are
              transparent. Seating every badge on an identical white circular
              tile (object-contain + inner padding) normalises them — the white
              squares melt into the tile, the transparent ones read cleanly, and
              the hard square edges against the dark card disappear. */}
          <ul className="mt-4 flex flex-wrap items-start gap-4 sm:gap-5" aria-label="Instructor certifications">
            {INSTRUCTOR_BADGES.map((b) => (
              <li key={b.label} className="flex flex-col items-center gap-2 w-[68px] text-center">
                <span className="grid place-items-center w-16 h-16 rounded-full bg-white ring-1 ring-black/10 shadow-md shadow-black/30 overflow-hidden transition-transform duration-200 hover:scale-105">
                  <Image
                    src={b.src}
                    alt={b.label}
                    width={56}
                    height={56}
                    className="w-12 h-12 object-contain"
                  />
                </span>
                <span className="text-[10px] leading-tight text-white/60">{b.label}</span>
              </li>
            ))}
          </ul>

          <div className="my-5 border-t border-[var(--line)]" />

          {session === undefined ? (
            <p className="text-white/60 mt-3 text-sm">Loading…</p>
          ) : session === null ? (
            <p className="text-white/70 mt-3 text-sm">
              No training session is scheduled right now. Check back soon — the next cohort will appear here.
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
                    onClick={() => guard("training", () => leaveTraining(session.id), "Removed from the roster")}
                    className="btn btn-secondary"
                  >
                    You&apos;re in — remove my name
                  </button>
                ) : (
                  <button
                    disabled={busy === "training"}
                    onClick={() => guard("training", () => joinTraining(session.id), "Added to the roster")}
                    className="btn btn-primary"
                  >
                    Add my name <ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
