"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Device, DeviceGroup, fetchDevices } from "@/lib/api";

const GROUP_ORDER: DeviceGroup[] = ["spine", "leaf", "worker"];
const GROUP_LABEL: Record<DeviceGroup, string> = {
  spine: "Spines",
  leaf: "Leaves",
  worker: "GPU Workers",
};
const GROUP_CLR: Record<DeviceGroup, string> = {
  spine: "border-spine bg-spine/10",
  leaf: "border-leaf bg-leaf/10",
  worker: "border-worker bg-worker/10",
};

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetchDevices()
        .then((d) => alive && setDevices(d))
        .catch((e) => alive && setError(String(e)));
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (error)
    return (
      <div className="p-6 rounded border border-red-500/40 bg-red-500/10 text-red-200">
        Failed to reach orchestrator: {error}
        <div className="text-sm text-red-200/70 mt-2">
          Make sure the backend is running: <code className="bg-black/30 px-1 rounded">make ui-backend</code>
        </div>
      </div>
    );

  if (!devices) return <p className="text-white/60">Loading devices…</p>;

  const byGroup: Record<DeviceGroup, Device[]> = {
    spine: [],
    leaf: [],
    worker: [],
  };
  devices.forEach((d) => byGroup[d.group].push(d));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Lab devices</h1>
        <p className="text-white/60 text-sm mt-1">
          Click a device to open a console. {devices.filter((d) => d.running).length}/
          {devices.length} running.
        </p>
      </div>

      {GROUP_ORDER.map((g) => (
        <section key={g}>
          <h2 className="text-sm uppercase tracking-wider text-white/50 mb-3">
            {GROUP_LABEL[g]}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {byGroup[g].map((d) => (
              <Link
                key={d.name}
                href={`/console/${d.name}`}
                className={`block rounded-lg border-2 p-3 transition ${GROUP_CLR[g]} hover:brightness-125`}
              >
                <div className="flex items-center justify-between">
                  <div className="font-mono font-semibold">{d.name}</div>
                  <span
                    className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${
                      d.running
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-rose-500/20 text-rose-300"
                    }`}
                  >
                    {d.running ? "up" : "down"}
                  </span>
                </div>
                <div className="text-xs text-white/60 mt-1">{d.kind}</div>
                <div className="text-[11px] text-white/50 mt-2 font-mono">
                  {Object.entries(d.extra).map(([k, v]) => (
                    <div key={k}>
                      {k}: <span className="text-white/80">{String(v)}</span>
                    </div>
                  ))}
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
