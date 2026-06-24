"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Device, fetchDevices } from "@/lib/api";
import { Link as LinkData } from "@/lib/topology";
import TopologyDiagram, {
  GROUP_FILL,
  GROUP_LABEL,
  GROUP_STROKE,
  NODE_HOVER_COLOR,
} from "@/components/TopologyDiagram";

export default function TopologyPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoveredDev, setHoveredDev] = useState<Device | null>(null);
  const [hoveredLink, setHoveredLink] = useState<LinkData | null>(null);

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
      </div>
    );
  if (!devices) return <p className="text-white/60">Loading topology…</p>;

  const upCount = devices.filter((d) => d.running).length;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Topology</h1>
          <p className="text-white/60 text-sm mt-1">
            2 spines · 4 leaves · 8 GPU workers · 16 links · {upCount}/
            {devices.length} up. Hover a device or link to see IPs · click a
            device for its console.
          </p>
        </div>
        <Legend />
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_18rem] gap-3">
        <div className="rounded-lg border border-white/10 bg-[#0b1020] p-2 overflow-hidden">
          <TopologyDiagram
            devices={devices}
            onNodeClick={(name) => router.push(`/portal/console/${name}`)}
            onHoverDevice={setHoveredDev}
            onHoverLink={setHoveredLink}
          />
        </div>

        <DetailsPanel device={hoveredDev} link={hoveredLink} />
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-xs text-white/70 flex-wrap">
      <LegendItem color="#7c3aed" label="spine" />
      <LegendItem color="#2563eb" label="leaf" />
      <LegendItem color="#059669" label="worker" />
      <span className="text-white/30">|</span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
        up
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-rose-500" />
        down
      </span>
      <span className="text-white/30">|</span>
      <span className="flex items-center gap-1">
        <span
          className="inline-block w-3 h-0.5"
          style={{ background: NODE_HOVER_COLOR }}
        />
        highlighted link
      </span>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-block w-3 h-3 rounded"
        style={{ background: color, opacity: 0.4, border: `1.5px solid ${color}` }}
      />
      {label}
    </span>
  );
}

function DetailsPanel({
  device,
  link,
}: {
  device: Device | null;
  link: LinkData | null;
}) {
  if (link) return <LinkDetails link={link} />;
  return <DeviceDetails device={device} />;
}

function LinkDetails({ link }: { link: LinkData }) {
  return (
    <aside className="rounded-lg border border-white/10 bg-black/30 p-4 min-h-[14rem]">
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: NODE_HOVER_COLOR }}
          />
          <span className="font-mono text-lg font-semibold">link</span>
          <span
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-mono"
            style={{
              background: "rgba(245,158,11,0.15)",
              color: NODE_HOVER_COLOR,
              border: `1px solid ${NODE_HOVER_COLOR}`,
            }}
          >
            {link.subnet}
          </span>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-white/50">A end</dt>
          <dd className="font-mono text-white/90">
            {link.a} · {link.aIp}
          </dd>
          <dt className="text-white/50">B end</dt>
          <dd className="font-mono text-white/90">
            {link.b} · {link.bIp}
          </dd>
          <dt className="text-white/50">subnet</dt>
          <dd className="font-mono text-white/90">{link.subnet}</dd>
        </dl>

        <div className="flex gap-2 mt-2">
          <Link
            href={`/portal/console/${link.a}`}
            className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 border border-white/20"
          >
            {link.a} console →
          </Link>
          <Link
            href={`/portal/console/${link.b}`}
            className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 border border-white/20"
          >
            {link.b} console →
          </Link>
        </div>
      </div>
    </aside>
  );
}

function DeviceDetails({ device }: { device: Device | null }) {
  return (
    <aside className="rounded-lg border border-white/10 bg-black/30 p-4 min-h-[14rem]">
      {!device ? (
        <div className="text-white/40 text-sm">
          Hover a device or a link to see details. Click a device for its
          console.
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${
                device.running ? "bg-emerald-400" : "bg-rose-400"
              }`}
            />
            <span className="font-mono text-lg font-semibold">{device.name}</span>
            <span
              className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded"
              style={{
                background: GROUP_FILL[device.group],
                color: GROUP_STROKE[device.group],
                border: `1px solid ${GROUP_STROKE[device.group]}`,
              }}
            >
              {GROUP_LABEL[device.group]}
            </span>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-white/50">image</dt>
            <dd className="font-mono text-white/90">{device.kind}</dd>
            <dt className="text-white/50">running</dt>
            <dd className="font-mono">{String(device.running)}</dd>
            {Object.entries(device.extra).map(([k, v]) => (
              <FactRow key={k} k={k} v={String(v)} />
            ))}
          </dl>

          <Link
            href={`/portal/console/${device.name}`}
            className="inline-block mt-2 text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 border border-white/20"
          >
            Open console →
          </Link>
        </div>
      )}
    </aside>
  );
}

function FactRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-white/50">{k}</dt>
      <dd className="font-mono text-white/90 break-all">{v}</dd>
    </>
  );
}
