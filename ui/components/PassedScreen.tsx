"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { beginLab, fetchProgress, type Lab, type LabRun } from "@/lib/api";
import { Check, ArrowRight } from "@/components/icons";

interface Props {
  lab: Lab;
  run: LabRun;
  onDismiss: () => void;
}

export default function PassedScreen({ lab, run, onDismiss }: Props) {
  const duration = formatDuration(run.started_at, run.passed_at);
  const router = useRouter();
  // The next active lab in the journey (null = this was the last one).
  const [nextId, setNextId] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchProgress()
      .then((p) => {
        if (!alive) return;
        const idx = p.labs.findIndex((l) => l.id === lab.id);
        setNextId(idx >= 0 && idx < p.labs.length - 1 ? p.labs[idx + 1].id : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [lab.id]);

  // Continue: begin the next lab (no bootstrap — carry the fabric forward), then go.
  async function onContinue() {
    if (!nextId || advancing) return;
    setAdvancing(true);
    try {
      await beginLab(nextId);
    } catch {
      /* the workbench will surface any issue; navigate regardless */
    }
    onDismiss();
    router.push(`/portal/labs/${nextId}`);
  }

  const complete = nextId === null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onDismiss}
    >
      <div
        className="on-dark max-w-lg w-full rounded-2xl border border-emerald-400/40 bg-gradient-to-b from-emerald-950 to-slate-950 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-300 mb-3 border border-emerald-400/40">
            <Check className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-semibold text-white">{complete ? "Journey complete" : "Lab complete"}</h2>
          <p className="mt-1 text-emerald-200/90">
            {complete ? (
              <>You finished <strong>{lab.title}</strong> — and the whole journey. 🎉</>
            ) : (
              <>You finished <strong>{lab.title}</strong>. Lab {nextId} is now unlocked.</>
            )}
          </p>
        </div>

        <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
          <Stat label="Time" value={duration ?? "—"} />
          <Stat label="Attempts" value={String(run.attempts)} />
          <Stat label="Method" value={run.used_solve ? "Solved" : "Solo"} />
        </dl>

        <div className="mt-6 flex flex-col gap-2">
          {complete ? (
            <Link
              href="/portal"
              onClick={onDismiss}
              className="flex items-center justify-center gap-2 text-center px-4 py-2 rounded-lg border border-emerald-400/60 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 font-semibold transition-colors"
            >
              Back to your journey <ArrowRight className="w-4 h-4" />
            </Link>
          ) : (
            <button
              onClick={onContinue}
              disabled={advancing}
              className="flex items-center justify-center gap-2 text-center px-4 py-2 rounded-lg border border-emerald-400/60 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 font-semibold transition-colors disabled:opacity-50"
            >
              {advancing ? "Setting up…" : <>Continue to Lab {nextId} <ArrowRight className="w-4 h-4" /></>}
            </button>
          )}
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
