"use client";

import { useState } from "react";
import { runCheckpoint, type CheckResult } from "@/lib/api";

interface Props {
  labId: string;
  name: string;
  label: string;
}

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "pass"; result: CheckResult }
  | { kind: "fail"; result: CheckResult }
  | { kind: "error"; message: string };

export default function CheckpointButton({ labId, name, label }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [open, setOpen] = useState(false);

  async function run() {
    setState({ kind: "running" });
    setOpen(false);
    try {
      const r = await runCheckpoint(labId, name);
      setState(r.passed ? { kind: "pass", result: r } : { kind: "fail", result: r });
      setOpen(true);
    } catch (e) {
      setState({ kind: "error", message: String(e) });
      setOpen(true);
    }
  }

  return (
    <div className="my-3 not-prose">
      <button
        type="button"
        onClick={run}
        disabled={state.kind === "running"}
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${
          state.kind === "pass"
            ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
            : state.kind === "fail" || state.kind === "error"
            ? "border-rose-400/50 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25"
            : state.kind === "running"
            ? "border-amber-400/40 bg-amber-500/10 text-amber-200 cursor-wait"
            : "border-sky-400/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20"
        }`}
      >
        <Icon state={state.kind} />
        <span>
          Check <span className="opacity-70">▸</span> {label}
        </span>
      </button>
      {open && (state.kind === "pass" || state.kind === "fail" || state.kind === "error") && (
        <ResultBox state={state} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function Icon({ state }: { state: State["kind"] }) {
  if (state === "running") {
    return (
      <span className="inline-block w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
    );
  }
  if (state === "pass") {
    return <span className="text-base leading-none">✓</span>;
  }
  if (state === "fail" || state === "error") {
    return <span className="text-base leading-none">✗</span>;
  }
  return <span className="text-base leading-none">▶</span>;
}

type ResultState = Extract<State, { kind: "pass" | "fail" | "error" }>;

function ResultBox({ state, onClose }: { state: ResultState; onClose: () => void }) {
  if (state.kind === "error") {
    return (
      <div className="mt-2 p-3 rounded border border-rose-400/40 bg-rose-500/10 text-rose-100 text-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold mb-1">Check failed to run</div>
            <div className="font-mono text-xs whitespace-pre-wrap">{state.message}</div>
          </div>
          <button
            onClick={onClose}
            className="text-rose-200/70 hover:text-rose-100 text-xs"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }
  const ok = state.kind === "pass";
  const r = state.result;
  return (
    <div
      className={`mt-2 p-3 rounded border text-sm ${
        ok
          ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-100"
          : "border-rose-400/40 bg-rose-500/10 text-rose-100"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold mb-1">{r.summary}</div>
          {r.detail && (
            <pre className="mt-1 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-white/80 bg-black/30 p-2 rounded">
              {r.detail}
            </pre>
          )}
        </div>
        <button
          onClick={onClose}
          className="opacity-70 hover:opacity-100 text-xs"
          aria-label="dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
