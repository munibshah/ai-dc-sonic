"use client";

import { useEffect, useRef, useState } from "react";
import { endSessionStream } from "@/lib/api";
import { Check } from "@/components/icons";

// The six fabric switches, in the order we want the chips to read. They light
// up green as each one reports back during the reset.
const SWITCHES = ["spine1", "spine2", "leaf1", "leaf2", "leaf3", "leaf4"];

interface Props {
  open: boolean;
  /** 'end'   — learner clicked "End session" (we cancel the booking after the
   *            fabric is wiped, via afterReset).
   *  'expired' — the booking timer lapsed; nothing to cancel. */
  mode: "end" | "expired";
  /** Optional cleanup run AFTER the fabric reset completes and BEFORE
   *  onFinished — e.g. cancel the now-freed booking slot. */
  afterReset?: () => Promise<void>;
  /** Called once the whole flow (reset + afterReset) succeeds. Reload/redirect here. */
  onFinished: () => void;
}

/**
 * Full-screen progress modal shown while the orchestrator wipes the shared
 * fabric back to Lab 1's bare starting state. Drives the SSE reset stream and
 * renders a live progress bar + per-switch chips so the learner can see the
 * lab being reset rather than staring at an opaque spinner.
 */
export default function SessionResetModal({ open, mode, afterReset, onFinished }: Props) {
  const [pct, setPct] = useState(0);
  const [label, setLabel] = useState("Starting…");
  const [reset, setReset] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const startedRef = useRef(false);

  // Reset internal state when the modal closes, so a later re-open (e.g. ending
  // a second session in the same visit) starts the stream fresh.
  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      setPct(0);
      setLabel("Starting…");
      setReset([]);
      setError(null);
      setFinishing(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;

    const close = endSessionStream({
      onProgress: (e) => {
        setPct(e.total > 0 ? Math.round((e.done / e.total) * 100) : 0);
        setLabel(e.label);
        if (e.switch) setReset((prev) => (prev.includes(e.switch!) ? prev : [...prev, e.switch!]));
      },
      onDone: async () => {
        setPct(100);
        setLabel("Fabric reset to Lab 1.");
        setFinishing(true);
        try {
          await afterReset?.();
        } catch {
          /* the fabric is already clean; a failed slot-cancel shouldn't block exit */
        }
        // Brief beat so the learner sees the 100% / green state before we move on.
        setTimeout(onFinished, 900);
      },
      onError: (m) => setError(m),
    });
    return close;
    // afterReset / onFinished are captured once on open; we deliberately gate
    // re-runs with startedRef so the stream opens exactly one time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const title = mode === "expired" ? "Your session has ended" : "Ending your session";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/12 bg-[var(--surface-canvas-deep)] p-6 shadow-2xl">
        <div className="flex items-center gap-2 mb-1">
          <span className="eyebrow">{mode === "expired" ? "Time's up" : "Wrapping up"}</span>
        </div>
        <h2 className="text-xl font-semibold text-white">{title}</h2>

        {error ? (
          <>
            <p className="text-sm text-rose-200 mt-3">
              The fabric reset hit a problem: {error}
            </p>
            <p className="text-xs text-white/50 mt-2">
              The next learner&apos;s Start will re-lay the baseline regardless. You can close this.
            </p>
            <div className="mt-5 flex justify-end">
              <button onClick={onFinished} className="btn btn-secondary">
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-white/70 mt-2 leading-relaxed">
              Resetting the lab back to Lab 1&apos;s starting point so the next session starts from a
              clean slate. This takes a few seconds — hang tight.
            </p>

            {/* Progress bar */}
            <div className="mt-5">
              <div className="flex items-center justify-between text-xs text-white/55 mb-1.5">
                <span className="truncate pr-2">{label}</span>
                <span className="tabular-nums shrink-0">{pct}%</span>
              </div>
              <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--accent-brand)] transition-[width] duration-500 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            {/* Per-switch chips */}
            <div className="mt-4 flex flex-wrap gap-2">
              {SWITCHES.map((sw) => {
                const done = reset.includes(sw);
                return (
                  <span
                    key={sw}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-mono transition-colors ${
                      done
                        ? "bg-emerald-500/15 text-emerald-200 border border-emerald-400/30"
                        : "bg-white/5 text-white/40 border border-white/10"
                    }`}
                  >
                    {done ? <Check className="w-3 h-3" /> : <span className="w-3 h-3 inline-block rounded-full border border-current border-r-transparent animate-spin" />}
                    {sw}
                  </span>
                );
              })}
            </div>

            <p className="mt-5 text-xs text-white/45">
              {finishing
                ? "Done — taking you back to your launcher…"
                : "Your cleared-lab progress is saved. You can book again anytime."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
