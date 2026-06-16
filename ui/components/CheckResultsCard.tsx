"use client";

import { useState } from "react";
import type { CheckResult, SubmitResult } from "@/lib/api";
import { Check, X } from "@/components/icons";

interface Props {
  result: SubmitResult;
}

export default function CheckResultsCard({ result }: Props) {
  const total = result.results.length;
  const completed = result.results.filter((r) => !r._pending).length;
  const pass = result.results.filter((r) => !r._pending && r.passed).length;
  const fail = result.results.filter((r) => !r._pending && !r.passed).length;
  const running = completed < total;
  const ok = !running && result.passed;

  // While the stream is in flight, show progress instead of the final verdict.
  let header: React.ReactNode;
  let headerClasses: string;
  if (running) {
    headerClasses = "bg-sky-500/10 border-sky-400/30 text-sky-100";
    header = (
      <>
        <div className="font-semibold inline-flex items-center gap-2">
          <span
            className="inline-block w-3.5 h-3.5 rounded-full border-2 border-sky-200/30 border-t-sky-200 animate-spin"
            aria-hidden="true"
          />
          Running checks… {completed}/{total} complete
        </div>
        <div className="text-xs opacity-75">
          {pass} passing{fail ? ` · ${fail} failed so far` : ""}
        </div>
      </>
    );
  } else if (ok) {
    headerClasses = "bg-emerald-500/10 border-emerald-400/30 text-emerald-100";
    header = (
      <>
        <div className="font-semibold inline-flex items-center gap-2"><Check className="w-4 h-4" /> All checks passed</div>
        <div className="text-xs opacity-70">
          Submit · {(result.duration_ms / 1000).toFixed(1)}s · {pass}/{total} OK
        </div>
      </>
    );
  } else {
    headerClasses = "bg-rose-500/10 border-rose-400/30 text-rose-100";
    header = (
      <>
        <div className="font-semibold inline-flex items-center gap-2">
          <X className="w-4 h-4" /> {fail} of {total} check{total === 1 ? "" : "s"} failed
        </div>
        <div className="text-xs opacity-70">
          Submit · {(result.duration_ms / 1000).toFixed(1)}s · {pass}/{total} OK
        </div>
      </>
    );
  }

  return (
    <div className="mx-6 my-4 rounded-lg border border-white/10 bg-black/40 overflow-hidden">
      <div className={`px-4 py-3 flex items-center justify-between gap-3 border-b ${headerClasses}`}>
        <div>{header}</div>
      </div>
      <ul className="divide-y divide-white/5">
        {result.results.map((r) => (
          <CheckRow key={r.name} result={r} />
        ))}
      </ul>
    </div>
  );
}

function CheckRow({ result }: { result: CheckResult }) {
  const [open, setOpen] = useState(false);
  if (result._pending) {
    return (
      <li>
        <div className="w-full px-4 py-2 flex items-start gap-3 text-left">
          <span
            className="mt-0.5 inline-block w-4 h-4 flex-none rounded-full bg-white/10 border border-white/20 animate-pulse"
            aria-hidden="true"
          />
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-white/70 font-medium">{result.label}</span>
            <span className="block text-xs text-white/40 italic">queued…</span>
          </span>
        </div>
      </li>
    );
  }
  const ok = result.passed;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="check-row-tint w-full px-4 py-2 flex items-start gap-3 text-left hover:bg-white/5"
      >
        <span
          className={`mt-0.5 inline-flex items-center justify-center w-4 h-4 flex-none rounded-full check-row-tint ${
            ok ? "bg-emerald-500/30 text-emerald-200" : "bg-rose-500/30 text-rose-200"
          }`}
        >
          {ok ? <Check className="w-2.5 h-2.5" /> : <X className="w-2.5 h-2.5" />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-white/90 font-medium">{result.label}</span>
          <span className="block text-xs text-white/60 truncate">{result.summary}</span>
        </span>
        {result.detail && (
          <span className="text-xs text-white/40 mt-0.5">{open ? "▾" : "▸"}</span>
        )}
      </button>
      {open && result.detail && (
        <pre className="mx-4 mb-2 mt-0 p-2 bg-black/40 rounded text-xs text-white/70 font-mono whitespace-pre-wrap max-h-48 overflow-auto">
          {result.detail}
        </pre>
      )}
    </li>
  );
}
