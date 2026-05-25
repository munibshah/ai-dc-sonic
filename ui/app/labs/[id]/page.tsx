"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Device, Lab, fetchDevices, fetchLab } from "@/lib/api";
import GuidePane from "@/components/GuidePane";
import TabbedTerminals, { TabbedTerminalsHandle } from "@/components/TabbedTerminals";
import TopologyOverlay from "@/components/TopologyOverlay";

export default function LabWorkbenchPage() {
  const params = useParams<{ id: string }>();
  const labId = params?.id as string;

  const [lab, setLab] = useState<Lab | null>(null);
  const [labError, setLabError] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [topoOpen, setTopoOpen] = useState(false);
  const terminalsRef = useRef<TabbedTerminalsHandle>(null);

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

  function openNodeTerminal(name: string) {
    terminalsRef.current?.openTerminal(name);
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

  const upCount = devices?.filter((d) => d.running).length ?? 0;
  const totalCount = devices?.length ?? 0;

  return (
    <div className="flex flex-col h-[calc(100vh-7.5rem)]">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-white/60 hover:text-white text-sm">
            ← labs
          </Link>
          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-mono text-white/60 bg-white/5">
            Lab {lab.id}
          </span>
          <h1 className="text-xl font-semibold text-white">{lab.title}</h1>
          {devices && (
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                upCount === totalCount
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "bg-amber-500/20 text-amber-300"
              }`}
              title="containers running"
            >
              {upCount}/{totalCount} up
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setTopoOpen(true)}
            disabled={!devices}
            className="px-3 py-1.5 rounded border border-white/20 bg-white/5 hover:bg-white/10 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Topology
          </button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-3 flex-1 min-h-0">
        <section className="flex-1 min-h-0 lg:basis-0 rounded-lg border border-white/10 bg-black/30 overflow-y-auto">
          <GuidePane labId={lab.id} part="exercise" />
        </section>

        <section className="flex-1 min-h-0 lg:basis-0 rounded-lg border border-white/10 bg-black overflow-hidden flex flex-col">
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
      </div>

      {topoOpen && devices && (
        <TopologyOverlay
          devices={devices}
          onPickNode={openNodeTerminal}
          onClose={() => setTopoOpen(false)}
        />
      )}
    </div>
  );
}
