"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Lab, LabRun } from "@/lib/api";
import { ArrowLeft, Bolt, Check } from "@/components/icons";

export type LabAction = "start" | "reset" | "solve" | "submit";

interface Props {
  lab: Lab;
  run: LabRun | null;
  devicesUp?: number;
  devicesTotal?: number;
  /** Which action is currently in-flight, if any. Drives the spinner + active label. */
  busy: LabAction | null;
  onStart: () => void;
  onReset: () => void;
  onSolve: () => void;
  onSubmit: () => void;
  onOpenTopology: () => void;
  onToggleSolution: () => void;
  solutionOpen: boolean;
  /** Collapses the guide pane so the terminal can go full-width. */
  onToggleFocus: () => void;
  focusTerminal: boolean;
  /** Lab 4+: collapses guide + terminals so telemetry has the wide half. */
  onToggleTelemetryFocus?: () => void;
  focusTelemetry?: boolean;
  /** Whether the workbench is rendering a telemetry pane at all. */
  showTelemetryToggle?: boolean;
}

export default function LabControlBar({
  lab,
  run,
  devicesUp,
  devicesTotal,
  busy,
  onStart,
  onReset,
  onSolve,
  onSubmit,
  onOpenTopology,
  onToggleSolution,
  solutionOpen,
  onToggleFocus,
  focusTerminal,
  onToggleTelemetryFocus,
  focusTelemetry,
  showTelemetryToggle,
}: Props) {
  const state = run?.state ?? "not_started";
  const anyBusy = busy !== null;

  return (
    <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/" className="inline-flex items-center gap-1.5 text-white/60 hover:text-white text-sm transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> labs
        </Link>
        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-mono text-white/60 bg-white/5">
          Lab {lab.id}
        </span>
        <h1 className="text-xl font-semibold text-white">{lab.title}</h1>

        <StatePill state={state} run={run} />

        {devicesTotal !== undefined && (
          <span
            className={`text-xs px-2 py-0.5 rounded ${
              devicesUp === devicesTotal
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-amber-500/20 text-amber-300"
            }`}
            title="containers running"
          >
            {devicesUp ?? 0}/{devicesTotal} up
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onOpenTopology}
          className="px-3 py-1.5 rounded border border-white/20 bg-white/5 hover:bg-white/10 text-sm"
        >
          Topology
        </button>
        <button
          onClick={onToggleSolution}
          className={`px-3 py-1.5 rounded border text-sm ${
            solutionOpen
              ? "border-amber-400/50 bg-amber-500/15 text-amber-200"
              : "border-white/20 bg-white/5 hover:bg-white/10"
          }`}
        >
          {solutionOpen ? "Hide solution" : "Reveal solution"}
        </button>
        <button
          onClick={onToggleFocus}
          className={`px-3 py-1.5 rounded border text-sm ${
            focusTerminal
              ? "border-sky-400/50 bg-sky-500/15 text-sky-200"
              : "border-white/20 bg-white/5 hover:bg-white/10"
          }`}
          title={
            focusTerminal
              ? "Show the guide pane again"
              : "Collapse the guide pane to give the terminal full width"
          }
        >
          {focusTerminal ? "Show guide" : "Focus terminal"}
        </button>
        {showTelemetryToggle && onToggleTelemetryFocus && (
          <button
            onClick={onToggleTelemetryFocus}
            className={`px-3 py-1.5 rounded border text-sm ${
              focusTelemetry
                ? "border-violet-400/50 bg-violet-500/15 text-violet-200"
                : "border-white/20 bg-white/5 hover:bg-white/10"
            }`}
            title={
              focusTelemetry
                ? "Show all three panes again"
                : "Collapse guide + terminals to give telemetry the wide half"
            }
          >
            {focusTelemetry ? "Show all panes" : "Focus telemetry"}
          </button>
        )}

        {state !== "not_started" && (
          <ActionButton
            onClick={onReset}
            disabled={anyBusy}
            active={busy === "reset"}
            idleLabel="Reset"
            activeLabel="Resetting…"
            title="Wipe fabric back to exercise state"
            variant="ghost"
          />
        )}

        {state !== "not_started" && (
          <ActionButton
            onClick={onSolve}
            disabled={anyBusy}
            active={busy === "solve"}
            idleLabel="Solve"
            activeLabel="Solving…"
            title="Apply the canonical configuration to all switches"
            variant="amber"
          />
        )}

        {state === "not_started" ? (
          <ActionButton
            onClick={onStart}
            disabled={anyBusy}
            active={busy === "start"}
            icon={<Bolt className="w-3.5 h-3.5" />}
            idleLabel="Start lab"
            activeLabel="Starting lab…"
            variant="sky-primary"
          />
        ) : (
          <ActionButton
            onClick={onSubmit}
            disabled={anyBusy}
            active={busy === "submit"}
            icon={state === "in_progress" ? <Check className="w-3.5 h-3.5" /> : undefined}
            idleLabel={state === "in_progress" ? "Submit" : "Re-run checks"}
            activeLabel="Running checks…"
            variant="emerald-primary"
          />
        )}
      </div>
    </div>
  );
}

type Variant = "ghost" | "amber" | "sky-primary" | "emerald-primary";

function ActionButton({
  onClick,
  disabled,
  active,
  icon,
  idleLabel,
  activeLabel,
  title,
  variant,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  icon?: React.ReactNode;
  idleLabel: string;
  activeLabel: string;
  title?: string;
  variant: Variant;
}) {
  const colors: Record<Variant, string> = {
    ghost: "border-white/20 bg-white/5 hover:bg-white/10 text-white",
    amber: "border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20",
    "sky-primary":
      "border-sky-400/60 bg-sky-500/20 hover:bg-sky-500/30 text-sky-100 font-semibold px-4",
    "emerald-primary":
      "border-emerald-400/60 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 font-semibold px-4",
  };
  const base = "rounded border text-sm transition-colors px-3 py-1.5";
  return (
    <button
      onClick={onClick}
      disabled={disabled && !active}
      title={title}
      className={`${base} ${colors[variant]} ${
        disabled && !active ? "opacity-40 cursor-not-allowed" : ""
      } ${active ? "cursor-wait" : ""}`}
    >
      <span className="inline-flex items-center gap-1.5">
        {active ? <Spinner /> : icon}
        <span>{active ? activeLabel : idleLabel}</span>
      </span>
    </button>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3 h-3 rounded-full border-2 border-current border-r-transparent animate-spin"
      aria-hidden="true"
    />
  );
}

function StatePill({ state, run }: { state: LabRun["state"] | "not_started"; run: LabRun | null }) {
  // Re-apply the flash animation on every state change. We mount a div with
  // a key tied to the state so React remounts it and the CSS animation re-runs.
  const [flashKey, setFlashKey] = useState(0);
  const prev = useRef(state);
  useEffect(() => {
    if (prev.current !== state) {
      setFlashKey((k) => k + 1);
      prev.current = state;
    }
  }, [state]);

  let inner: React.ReactNode;
  let colors: string;
  if (state === "not_started") {
    colors = "bg-white/5 text-white/60";
    inner = (
      <>
        <span className="w-1.5 h-1.5 rounded-full bg-white/40" /> Not started
      </>
    );
  } else if (state === "in_progress") {
    colors = "bg-sky-500/15 text-sky-200";
    inner = (
      <>
        <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" /> In progress
        {run?.attempts ? <span className="opacity-60">· attempt {run.attempts}</span> : null}
      </>
    );
  } else {
    colors = "bg-emerald-500/20 text-emerald-200";
    inner = (
      <>
        <Check className="w-3 h-3" /> Passed
        {run?.used_solve ? <span className="opacity-70">(solved)</span> : null}
      </>
    );
  }
  return (
    <span
      key={flashKey}
      className={`pill-flash inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded ${colors}`}
    >
      {inner}
    </span>
  );
}
