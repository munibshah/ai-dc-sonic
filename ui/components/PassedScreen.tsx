"use client";

import Link from "next/link";
import type { Lab, LabRun } from "@/lib/api";

interface Props {
  lab: Lab;
  run: LabRun;
  onDismiss: () => void;
}

export default function PassedScreen({ lab, run, onDismiss }: Props) {
  const duration = formatDuration(run.started_at, run.passed_at);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onDismiss}
    >
      <div
        className="max-w-lg w-full rounded-2xl border border-emerald-400/40 bg-gradient-to-b from-emerald-950 to-slate-950 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-300 text-3xl mb-3 border border-emerald-400/40">
            ✓
          </div>
          <h2 className="text-2xl font-semibold text-white">Lab complete</h2>
          <p className="mt-1 text-emerald-200/90">You finished <strong>{lab.title}</strong>.</p>
        </div>

        <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
          <Stat label="Time" value={duration ?? "—"} />
          <Stat label="Attempts" value={String(run.attempts)} />
          <Stat label="Method" value={run.used_solve ? "Solved" : "Solo"} />
        </dl>

        <div className="mt-6 flex flex-col gap-2">
          <Link
            href={`/portal/labs/${nextLabId(lab.id)}`}
            className="block text-center px-4 py-2 rounded-lg border border-emerald-400/60 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 font-semibold"
            onClick={onDismiss}
          >
            Continue to Lab {nextLabId(lab.id)} →
          </Link>
          <button
            onClick={onDismiss}
            className="block text-center px-4 py-2 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-white/80 text-sm"
          >
            Stay on this lab
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-black/30 border border-white/10 px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-white/50">{label}</div>
      <div className="text-base font-semibold text-white">{value}</div>
    </div>
  );
}

function formatDuration(startIso: string | null, endIso: string | null): string | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function nextLabId(current: string): string {
  const n = Number(current);
  return Number.isFinite(n) && n > 0 ? String(n + 1) : "2";
}
