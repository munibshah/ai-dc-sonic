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
  beginLab,
  fetchDevices,
  fetchLab,
  fetchProgress,
  resetLab,
  startLab,
  submitLabStream,
} from "@/lib/api";
import { useLabRun } from "@/lib/hooks";
import { useToasts } from "@/components/Toast";
import GuidePane from "@/components/GuidePane";
import LabControlBar, { LabAction } from "@/components/LabControlBar";
import { ArrowRight, Lock } from "@/components/icons";
import CheckResultsCard from "@/components/CheckResultsCard";
import ConfirmDialog from "@/components/ConfirmDialog";
import PassedScreen from "@/components/PassedScreen";
import StatusBanner from "@/components/StatusBanner";
import FabricHoldBanner from "@/components/FabricHoldBanner";
import FabricExpiryWatcher from "@/components/FabricExpiryWatcher";
import TabbedTerminals, { TabbedTerminalsHandle } from "@/components/TabbedTerminals";
import TelemetryPane from "@/components/TelemetryPane";
import TopologyOverlay from "@/components/TopologyOverlay";

type ConfirmKind = "reset" | null;

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
  const [unlocked, setUnlocked] = useState<boolean | null>(null); // null until known
  const [prevLabId, setPrevLabId] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [topoOpen, setTopoOpen] = useState(false);
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
    // Journey gating: is this lab unlocked for the learner yet?
    fetchProgress()
      .then((p) => {
        if (!alive) return;
        const me = p.labs.find((l) => l.id === labId);
        setUnlocked(me ? me.unlocked : true); // unknown lab → don't block
        const idx = p.labs.findIndex((l) => l.id === labId);
        setPrevLabId(idx > 0 ? p.labs[idx - 1].id : null);
      })
      .catch(() => alive && setUnlocked(true)); // progress unavailable → fail open
    return () => {
      alive = false;
    };
  }, [labId]);

  // First lab boots the bare fabric; later labs carry the fabric forward (no
  // bootstrap) because the labs build on each other.
  const isFirstLab = !!lab && !lab.previous_lab_id;

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
    // Lab 1 bootstraps the bare fabric; later labs just begin (no bootstrap) —
    // the fabric carries forward from the lab you just cleared.
    runAction(
      "start",
      () => (isFirstLab ? startLab(labId) : beginLab(labId)),
      (r) => {
        setRun(r);
        setPendingSubmit(null);
        toasts.push({
          tone: "success",
          title: isFirstLab ? "Lab started" : "Lab ready",
          body: isFirstLab
            ? "Fabric set to the starting state — open Topology to pick a device."
            : "Continuing from where the last lab left off — your devices and config carry forward.",
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
          body: "Fabric re-applied to this lab's starting configuration.",
        });
        fetchDevices().then(setDevices).catch(() => {});
      },
      "Reset failed",
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
        setPendingSubmit((prev) => {
          // A dropped SSE connection makes EventSource reconnect, which
          // re-delivers `meta`. Don't flash the skeleton back over rows we've
          // already filled — keep showing partial results.
          if (prev && prev.results.some((r) => !r._pending)) return prev;
          return {
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
          };
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
          <Link href="/portal" className="underline">← back to My labs</Link>
        </div>
      </div>
    );
  if (!lab) return <p className="text-white/60">Loading lab…</p>;

  if (lab.status === "coming-soon") {
    return <ComingSoonLab lab={lab} />;
  }

  if (unlocked === false) {
    return <LockedLab lab={lab} prevLabId={prevLabId} />;
  }

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
      <FabricExpiryWatcher />
      <LabControlBar
        lab={lab}
        run={run}
        busy={busy}
        onStart={onStart}
        onReset={() => setConfirm("reset")}
        onSubmit={onSubmit}
        onOpenTopology={() => setTopoOpen(true)}
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
        isFirstLab={isFirstLab}
      />

      <StatusBanner message={busy ? STATUS_MESSAGES[busy] : null} />

      <div className="mb-2">
        <FabricHoldBanner />
      </div>

      <div className="flex flex-col lg:flex-row gap-3 flex-1 min-h-0">
        {guideVisible && (
          <section className={`${guideBasis} lg:grow lg:shrink min-h-0 rounded-lg border border-white/10 bg-black/30 overflow-y-auto flex flex-col`}>
            <GuidePane labId={lab.id} part="exercise" />
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
        title={`Reset to Lab ${lab.id}'s starting point?`}
        body={
          <>
            The orchestrator will re-apply <strong>Lab {lab.id}</strong>&apos;s starting configuration to every
            switch and worker, so you can build this lab from scratch. Any current fabric state is replaced; your
            console history stays open. Takes about 10 seconds. (Your cleared-lab progress is unaffected.)
          </>
        }
        confirmLabel="Reset to starting point"
        danger
        busy={busy === "reset"}
        busyBody={`Re-applying Lab ${lab.id}'s starting configuration.`}
        onConfirm={onReset}
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

function LockedLab({ lab, prevLabId }: { lab: Lab; prevLabId: string | null }) {
  const prev = prevLabId ?? String(Math.max(1, Number(lab.id) - 1));
  return (
    <div className="max-w-2xl mx-auto mt-12 p-8 rounded-2xl border border-white/10 bg-black/30 text-center">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-white/5 border border-white/15 text-white/50 mb-4">
        <Lock className="w-6 h-6" />
      </div>
      <h1 className="text-3xl font-semibold text-white mb-2">Lab {lab.id} is locked</h1>
      <p className="text-white/70 leading-relaxed">
        The labs are a guided journey — clear <strong>Lab {prev}</strong> first and Lab {lab.id} unlocks
        automatically.
      </p>
      <div className="mt-6 flex flex-wrap gap-3 justify-center">
        <Link href={`/portal/labs/${prev}`} className="btn btn-primary">
          Go to Lab {prev} <ArrowRight className="w-4 h-4" />
        </Link>
        <Link href="/portal" className="btn btn-secondary">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
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
        <Link href="/portal" className="text-sky-300 hover:text-sky-200 underline">
          ← back to My labs
        </Link>
      </div>
    </div>
  );
}
