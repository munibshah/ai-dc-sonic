"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { fetchProgress, type LabProgress } from "@/lib/api";
import { Check, Lock, ArrowRight } from "@/components/icons";

type StepState = "passed" | "active" | "available" | "locked";

function stepState(lab: LabProgress, activeId: string | undefined, current: string | null): StepState {
  if (lab.id === activeId) return "active";
  if (lab.passed) return "passed";
  if (!lab.unlocked) return "locked";
  if (lab.id === current) return "active";
  return "available";
}

/**
 * The learner's lab journey. Two layouts:
 *  - compact (rail): a numbered stepper for the workbench header — quick nav
 *    between unlocked labs.
 *  - board (default): a roadmap card for the portal dashboard.
 * States are conveyed with icon + shape + label, never colour alone (a11y).
 */
export default function LabJourney({
  activeId,
  compact = false,
}: {
  activeId?: string;
  compact?: boolean;
}) {
  const [labs, setLabs] = useState<LabProgress[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchProgress()
      .then((p) => {
        if (alive) {
          setLabs(p.labs);
          setCurrent(p.current);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!labs || labs.length === 0) return null;

  if (compact) {
    return (
      <nav aria-label="Lab journey" className="flex items-center gap-1 overflow-x-auto py-1">
        {labs.map((lab, i) => {
          const st = stepState(lab, activeId, current);
          return (
            <Fragment key={lab.id}>
              {i > 0 && <span className={`h-px w-3 shrink-0 ${lab.unlocked ? "bg-white/25" : "bg-white/10"}`} aria-hidden />}
              <StepDot lab={lab} state={st} />
            </Fragment>
          );
        })}
      </nav>
    );
  }

  const passedCount = labs.filter((l) => l.passed).length;
  return (
    <section className="rounded-2xl border border-white/12 bg-black/30 overflow-hidden">
      <div className="p-6 md:p-7 border-b border-white/10 flex items-center gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-white">Your lab journey</h2>
          <p className="text-white/60 text-sm mt-1">
            Clear each lab to unlock the next. Your progress lasts for this session.
          </p>
        </div>
        <span className="ml-auto shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-white/70">
          <Check className="w-3.5 h-3.5 text-[var(--accent-positive)]" />
          {passedCount} of {labs.length} cleared
        </span>
      </div>
      <ol className="py-2">
        {labs.map((lab, i) => {
          const st = stepState(lab, activeId, current);
          return (
            <StepRow
              key={lab.id}
              lab={lab}
              state={st}
              isFirst={i === 0}
              isLast={i === labs.length - 1}
              prevPassed={i > 0 && labs[i - 1].passed}
            />
          );
        })}
      </ol>
    </section>
  );
}

function dotClasses(state: StepState): string {
  switch (state) {
    case "passed":
      return "bg-emerald-500/25 text-emerald-200 border-emerald-400/50";
    case "active":
      return "bg-[var(--accent-brand-soft)] text-[var(--accent-brand)] border-[var(--accent-brand-line)] ring-2 ring-[var(--accent-brand-line)]";
    case "available":
      return "bg-white/8 text-white/80 border-white/20";
    case "locked":
      // Kept legible in both themes (the Vesper override maps these alphas to
      // warm neutrals) — a too-faint locked state vanishes on the cream ground.
      return "bg-white/5 text-white/50 border-white/15";
  }
}

function DotInner({ lab, state }: { lab: LabProgress; state: StepState }) {
  if (state === "passed") return <Check className="w-4 h-4" />;
  if (state === "locked") return <Lock className="w-3.5 h-3.5" />;
  return <span className="text-sm font-semibold">{lab.id}</span>;
}

function StepDot({ lab, state }: { lab: LabProgress; state: StepState }) {
  const dot = (
    <span
      className={`inline-flex items-center justify-center w-8 h-8 rounded-full border shrink-0 ${dotClasses(state)}`}
    >
      <DotInner lab={lab} state={state} />
    </span>
  );
  const labelCls = state === "locked" ? "text-white/50" : "text-white/70";
  const inner = (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      {dot}
      <span className={`text-xs ${labelCls} hidden sm:inline`}>Lab {lab.id}</span>
    </span>
  );
  if (state === "locked") {
    return (
      <span title={`Clear Lab ${Number(lab.id) - 1} to unlock`} aria-disabled className="px-1">
        {inner}
      </span>
    );
  }
  return (
    <Link href={`/portal/labs/${lab.id}`} className="px-1 rounded-lg hover:bg-white/5 transition-colors" title={lab.title}>
      {inner}
    </Link>
  );
}

function StepRow({
  lab,
  state,
  isFirst,
  isLast,
  prevPassed,
}: {
  lab: LabProgress;
  state: StepState;
  isFirst: boolean;
  isLast: boolean;
  prevPassed: boolean;
}) {
  const badge =
    state === "passed"
      ? { label: "Cleared", cls: "text-emerald-300" }
      : state === "active"
      ? { label: "Current", cls: "text-[var(--accent-brand)]" }
      : state === "available"
      ? { label: "Unlocked", cls: "text-white/60" }
      : { label: "Locked", cls: "text-white/55" };

  // Connector segments form the chain; a completed segment glows so the
  // "path so far" reads at a glance.
  const topSeg = isFirst ? "bg-transparent" : prevPassed ? "bg-emerald-400/40" : "bg-white/12";
  const botSeg = isLast ? "bg-transparent" : lab.passed ? "bg-emerald-400/40" : "bg-white/12";
  const isCurrent = state === "active";

  return (
    <li className={`flex gap-4 px-6 ${isCurrent ? "bg-[var(--accent-brand-soft)]" : ""}`}>
      {/* Chain rail */}
      <div className="relative flex flex-col items-center w-9 shrink-0" aria-hidden>
        <span className={`w-0.5 flex-1 ${topSeg}`} />
        <span className={`inline-flex items-center justify-center w-9 h-9 rounded-full border shrink-0 ${dotClasses(state)}`}>
          <DotInner lab={lab} state={state} />
        </span>
        <span className={`w-0.5 flex-1 ${botSeg}`} />
      </div>

      <div className="flex-1 flex items-center gap-4 py-4 min-w-0">
        <div className="min-w-0">
          <div className={`text-sm font-medium ${state === "locked" ? "text-white/60" : "text-white"}`}>{lab.title}</div>
          <div className={`text-xs mt-0.5 ${badge.cls}`}>
            {badge.label}
            {state === "locked" && <span className="text-white/45"> · clear Lab {Number(lab.id) - 1} first</span>}
          </div>
        </div>
        <div className="ml-auto shrink-0">
          {state === "locked" ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-white/40">
              <Lock className="w-3.5 h-3.5" /> Locked
            </span>
          ) : (
            <Link href={`/portal/labs/${lab.id}`} className={`btn btn-sm ${isCurrent ? "btn-primary" : "btn-secondary"}`}>
              {state === "passed" ? "Revisit" : state === "active" ? "Enter" : "Enter"}
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}
