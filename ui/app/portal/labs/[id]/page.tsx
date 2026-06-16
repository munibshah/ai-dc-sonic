"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CheckResult,
  Device,
  Lab,
  LabRun,
  SubmitResult,
  fetchDevices,
  fetchLab,
  resetLab,
  solveLab,
  startLab,
  submitLabStream,
} from "@/lib/api";
import { useLabRun } from "@/lib/hooks";
import { useToasts } from "@/components/Toast";
import GuidePane from "@/components/GuidePane";
import LabControlBar, { LabAction } from "@/components/LabControlBar";
import CheckResultsCard from "@/components/CheckResultsCard";
import ConfirmDialog from "@/components/ConfirmDialog";
import PassedScreen from "@/components/PassedScreen";
import StatusBanner from "@/components/StatusBanner";
import FabricHoldBanner from "@/components/FabricHoldBanner";
import TabbedTerminals, { TabbedTerminalsHandle } from "@/components/TabbedTerminals";
import TelemetryPane from "@/components/TelemetryPane";
import TopologyOverlay from "@/components/TopologyOverlay";

type ConfirmKind = "reset" | "solve" | null;

const STATUS_MESSAGES: Record<LabAction, string> = {
  start: "Resetting the fabric to this lab's starting state… (~10s)",
  reset: "Resetting the fabric to this lab's starting state… (~10s)",
  solve: "Applying this lab's canonical configuration to the fabric… (~10s)",
  submit: "Running checkpoints against the live fabric…",
};

export default function LabWorkbenchPage() {
  const params = useParams<{ id: string }>();
  const labId = params?.id as string;
  const toasts = useToasts();

  const [lab, setLab] = useState<Lab | null>(null);
  const [labError, setLabError] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [topoOpen, setTopoOpen] = useState(false);
  const [solutionOpen, setSolutionOpen] = useState(false);
  const [focusTerminal, setFocusTerminal] = useState(false);
  const [focusTelemetry, setFocusTelemetry] = useState(false);
  const [busy, setBusy] = useState<LabAction | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);
  const [showPass, setShowPass] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState<SubmitResult | null>(null);
  const prevState = useRef<LabRun["state"] | null>(null);
  const terminalsRef = useRef<TabbedTerminalsHandle>(null);
  const streamCloseRef = useRef<(() => void) | null>(null);

  const { run, setRun, refresh } = useLabRun(labId);

  useEffect(() => {
    let alive = true;
    fetchLab(labId)
      .then((l) => alive && setLab(l))
      .catch((e) => alive && setLabError(String(e)));
    return () => {
      alive = false;
    };
  }, [labId]);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetchDevices()
        .then((d) => alive && setDevices(d))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Fire the pass screen exactly once per transition into "passed".
  useEffect(() => {
    if (!run) return;
    if (prevState.current && prevState.current !== "passed" && run.state === "passed") {
      setShowPass(true);
    }
    prevState.current = run.state;
  }, [run]);

  // Close any in-flight stream on unmount.
  useEffect(() => {
    return () => {
      streamCloseRef.current?.();
    };
  }, []);

  function openNodeTerminal(name: string) {
    terminalsRef.current?.openTerminal(name);
  }

  // ---- actions ---------------------------------------------------------------
  async function runAction<T>(
    kind: LabAction,
    fn: () => Promise<T>,
    onSuccess: (r: T) => void,
    errorTitle: string,
  ) {
    setBusy(kind);
    try {
      const r = await fn();
      onSuccess(r);
    } catch (e) {
      toasts.push({ tone: "error", title: errorTitle, body: String(e) });
    } finally {
      setBusy(null);
    }
  }

  function onStart() {
    runAction(
      "start",
      () => startLab(labId),
      (r) => {
        setRun(r);
        setPendingSubmit(null);
        toasts.push({
          tone: "success",
          title: "Lab started",
          body: "Fabric reset to this lab's starting state — open Topology to pick a device.",
        });
        fetchDevices().then(setDevices).catch(() => {});
      },
      "Start failed",
    );
  }

  function onReset() {
    runAction(
      "reset",
      () => resetLab(labId),
      (r) => {
        setRun(r);
        setPendingSubmit(null);
        toasts.push({
          tone: "success",
          title: "Reset complete",
          body: `Fabric back to lab starting state — attempt ${r.attempts}.`,
        });
        fetchDevices().then(setDevices).catch(() => {});
      },
      "Reset failed",
    );
    setConfirm(null);
  }

  function onSolve() {
    runAction(
      "solve",
      () => solveLab(labId),
      (r) => {
        setRun(r);
        toasts.push({
          tone: "success",
          title: "Canonical configuration applied",
          body: "Click Submit ✓ to verify and stamp the lab complete.",
        });
        fetchDevices().then(setDevices).catch(() => {});
      },
      "Solve failed",
    );
    setConfirm(null);
  }

  function onSubmit() {
    if (busy) return;
    // Pre-fetch the checkpoint list so we can render skeleton rows the moment
    // the user clicks — the SSE `meta` event also carries them, but the
    // round-trip-zero feel is worth the duplicated render.
    setBusy("submit");
    setPendingSubmit({ passed: false, results: [], duration_ms: 0 });

    streamCloseRef.current = submitLabStream(labId, {
      onMeta: (m) => {
        setPendingSubmit({
          passed: false,
          duration_ms: 0,
          results: m.checkpoints.map<CheckResult>((c) => ({
            name: c.name,
            label: c.label,
            passed: false,
            summary: "",
            detail: null,
            _pending: true,
          })),
        });
      },
      onResult: (r) => {
        setPendingSubmit((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            results: prev.results.map((row) =>
              row.name === r.name
                ? {
                    name: r.name,
                    label: r.label,
                    passed: r.passed,
                    summary: r.summary,
                    detail: r.detail,
                  }
                : row,
            ),
          };
        });
      },
      onDone: (d) => {
        setPendingSubmit((prev) =>
          prev ? { ...prev, passed: d.passed, duration_ms: d.duration_ms } : prev,
        );
        setRun(d.run);
        setBusy(null);
        streamCloseRef.current = null;
        if (!d.passed) {
          const failed = pendingSummary(setPendingSubmit, "fail-count");
          toasts.push({
            tone: "error",
            title: "Some checks failed",
            body: `${failed} check${failed === 1 ? "" : "s"} need attention. See diagnostics below.`,
          });
        }
        // Pass-case toast is intentionally omitted — the <PassedScreen> modal handles celebration.
        fetchDevices().then(setDevices).catch(() => {});
        refresh();
      },
      onError: (msg) => {
        toasts.push({ tone: "error", title: "Submit failed", body: msg });
        setBusy(null);
        streamCloseRef.current = null;
      },
    });
  }

  if (labError)
    return (
      <div className="p-6 rounded border border-rose-500/40 bg-rose-500/10 text-rose-200">
        Lab not found: {labError}
        <div className="mt-2 text-sm">
          <Link href="/" className="underline">← back to labs</Link>
        </div>
      </div>
    );
  if (!lab) return <p className="text-white/60">Loading lab…</p>;

  if (lab.status === "coming-soon") {
    return <ComingSoonLab lab={lab} />;
  }

  const upCount = devices?.filter((d) => d.running).length;
  const totalCount = devices?.length;
  const lastSummary = pendingSubmit ?? run?.last_summary ?? null;

  // Telemetry pane is opt-in per lab (Lab 4+). When present, the workbench
  // shifts from 2/5 + 3/5 to a 3-way split; focusTelemetry collapses guide
  // and shrinks terminals to give telemetry the wide half.
  const telemetryEnabled = !!lab.grafana_dashboard_path;
  const guideVisible = !focusTerminal && !focusTelemetry;
  const telemetryVisible = telemetryEnabled && !focusTerminal;

  const guideBasis = telemetryEnabled ? "lg:basis-1/3" : "lg:basis-2/5";
  const terminalBasis = focusTerminal
    ? "flex-1"
    : telemetryEnabled
    ? focusTelemetry
      ? "lg:basis-1/4"
      : "lg:basis-1/3"
    : "lg:basis-3/5";
  const telemetryBasis = focusTelemetry ? "lg:basis-3/4 lg:grow" : "lg:basis-1/3 lg:grow lg:shrink";

  return (
    <div className="mx-auto max-w-[1800px] flex flex-col h-[calc(100vh-7.5rem)]">
      <LabControlBar
        lab={lab}
        run={run}
        devicesUp={upCount}
        devicesTotal={totalCount}
        busy={busy}
        onStart={onStart}
        onReset={() => setConfirm("reset")}
        onSolve={() => setConfirm("solve")}
        onSubmit={onSubmit}
        onOpenTopology={() => setTopoOpen(true)}
        onToggleSolution={() => setSolutionOpen((o) => !o)}
        solutionOpen={solutionOpen}
        onToggleFocus={() => {
          setFocusTerminal((f) => !f);
          setFocusTelemetry(false);
        }}
        focusTerminal={focusTerminal}
        showTelemetryToggle={telemetryEnabled}
        focusTelemetry={focusTelemetry}
        onToggleTelemetryFocus={() => {
          setFocusTelemetry((f) => !f);
          setFocusTerminal(false);
        }}
      />

      <StatusBanner message={busy ? STATUS_MESSAGES[busy] : null} />

      <div className="mb-2">
        <FabricHoldBanner />
      </div>

      <div className="flex flex-col lg:flex-row gap-3 flex-1 min-h-0">
        {guideVisible && (
          <section className={`${guideBasis} lg:grow lg:shrink min-h-0 rounded-lg border border-white/10 bg-black/30 overflow-y-auto flex flex-col`}>
            <GuidePane labId={lab.id} part={solutionOpen ? "solution" : "exercise"} />
            {lastSummary && <CheckResultsCard result={lastSummary} />}
          </section>
        )}

        <section
          className={`${terminalBasis} min-h-0 rounded-lg border border-white/10 bg-black overflow-hidden flex flex-col`}
        >
          <TabbedTerminals
            ref={terminalsRef}
            onRequestPickDevice={() => devices && setTopoOpen(true)}
            emptyMessage={
              <span>
                No terminals open yet. Click <strong className="text-white/70">Topology</strong> above (or the <strong className="text-white/70">+</strong> here) to pick a device.
              </span>
            }
          />
        </section>

        {telemetryVisible && lab.grafana_dashboard_path && (
          <section className={`${telemetryBasis} min-h-0 rounded-lg border border-white/10 bg-black/30 overflow-hidden flex flex-col`}>
            <TelemetryPane dashboardPath={lab.grafana_dashboard_path} />
          </section>
        )}
      </div>

      {topoOpen && devices && (
        <TopologyOverlay
          devices={devices}
          onPickNode={openNodeTerminal}
          onClose={() => setTopoOpen(false)}
        />
      )}

      {showPass && run && run.state === "passed" && (
        <PassedScreen lab={lab} run={run} onDismiss={() => setShowPass(false)} />
      )}

      <ConfirmDialog
        open={confirm === "reset"}
        title="Reset the fabric?"
        body={
          <>
            The orchestrator will roll the fabric back to this lab's starting state — every switch and worker is
            reconfigured to the lab's baseline. Your in-flight work is replaced; your console history stays open.
            Takes about 10 seconds.
          </>
        }
        confirmLabel="Reset"
        danger
        busy={busy === "reset"}
        busyBody="Resetting the fabric to this lab's starting state."
        onConfirm={onReset}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === "solve"}
        title="Apply the canonical configuration?"
        body={
          <>
            The orchestrator will load this lab's canonical configuration onto every switch (and any workers the
            lab touches), then reload. Your in-progress work is replaced. Your run will be flagged <em>solved</em>
            on the completion screen.
          </>
        }
        confirmLabel="Solve"
        busy={busy === "solve"}
        busyBody="Applying this lab's canonical configuration to the fabric."
        onConfirm={onSolve}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

// Small helper so we can compute the fail count without snapshotting state into
// the onDone closure (React would otherwise close over a stale value).
function pendingSummary(
  setPendingSubmit: React.Dispatch<React.SetStateAction<SubmitResult | null>>,
  _kind: "fail-count",
): number {
  let count = 0;
  setPendingSubmit((cur) => {
    if (cur) count = cur.results.filter((r) => !r._pending && !r.passed).length;
    return cur;
  });
  return count;
}

function ComingSoonLab({ lab }: { lab: Lab }) {
  return (
    <div className="max-w-2xl mx-auto mt-12 p-8 rounded-2xl border border-white/10 bg-black/30 text-center">
      <div className="text-xs uppercase tracking-wider text-amber-300/80 mb-2">Coming soon</div>
      <h1 className="text-3xl font-semibold text-white mb-3">Lab {lab.id} · {lab.title}</h1>
      <p className="text-white/70 leading-relaxed">{lab.summary}</p>
      {lab.duration_min !== undefined && (
        <p className="text-white/40 text-sm mt-2">Expected duration: {lab.duration_min} min.</p>
      )}
      <div className="mt-6 text-sm">
        <Link href="/" className="text-sky-300 hover:text-sky-200 underline">
          ← back to all labs
        </Link>
      </div>
    </div>
  );
}
