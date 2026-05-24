"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Device, DeviceGroup, fetchDevices } from "@/lib/api";
import {
  LINKS,
  Link as LinkData,
  NODE_H,
  NODE_W,
  POS,
  VIEW_H,
  VIEW_W,
} from "@/lib/topology";

const GROUP_STROKE: Record<DeviceGroup, string> = {
  spine: "#7c3aed",
  leaf: "#2563eb",
  worker: "#059669",
};
const GROUP_FILL: Record<DeviceGroup, string> = {
  spine: "rgba(124,58,237,0.18)",
  leaf: "rgba(37,99,235,0.18)",
  worker: "rgba(5,150,105,0.18)",
};
const GROUP_LABEL: Record<DeviceGroup, string> = {
  spine: "spine",
  leaf: "leaf",
  worker: "worker",
};

// Highlight colours — both same family but distinguishable.
const NODE_HOVER_COLOR = "#f59e0b"; // amber (whole device's links)
const LINK_HOVER_COLOR = "#fb923c"; // orange (specific link hovered)

export default function TopologyPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);          // node name
  const [hoveredLink, setHoveredLink] = useState<number | null>(null);  // link index

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

  const byName = useMemo(
    () => Object.fromEntries((devices ?? []).map((d) => [d.name, d])),
    [devices]
  );

  if (error)
    return (
      <div className="p-6 rounded border border-red-500/40 bg-red-500/10 text-red-200">
        Failed to reach orchestrator: {error}
      </div>
    );
  if (!devices) return <p className="text-white/60">Loading topology…</p>;

  const hoveredDev = hovered ? byName[hovered] : null;
  const hoveredLinkData = hoveredLink !== null ? LINKS[hoveredLink] : null;
  const upCount = devices.filter((d) => d.running).length;

  // Decide which links are "lit" (and therefore show IP labels):
  //   - Every link that touches the hovered node, OR
  //   - The single link the user is hovering directly.
  function isLit(link: LinkData, idx: number): boolean {
    if (hoveredLink === idx) return true;
    if (hovered && (link.a === hovered || link.b === hovered)) return true;
    return false;
  }

  return (
    <div className="space-y-4">
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
        <div className="rounded-lg border border-white/10 bg-black/40 p-2 overflow-hidden">
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            className="w-full h-auto"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label="Lab topology diagram"
          >
            {/* row separators / labels */}
            <g fill="#94a3b8" fontSize="10" opacity="0.5">
              <text x="10" y="22">SPINES · AS 65000</text>
              <text x="10" y="252">LEAVES · AS 65101–65104</text>
              <text x="10" y="482">GPU WORKERS · Linux + PyTorch+Gloo</text>
            </g>

            {/* visible link lines — drawn first so nodes overlay */}
            {LINKS.map((link, i) => {
              const [ax, ay] = POS[link.a];
              const [bx, by] = POS[link.b];
              const lit = isLit(link, i);
              return (
                <line
                  key={`l-${i}`}
                  x1={ax}
                  y1={ay + NODE_H / 2}
                  x2={bx}
                  y2={by - NODE_H / 2}
                  stroke={lit ? NODE_HOVER_COLOR : "#475569"}
                  strokeWidth={lit ? 2.5 : 1.5}
                  opacity={lit ? 1 : 0.55}
                />
              );
            })}

            {/* invisible thick hover-catchers ON TOP of the visible lines so
                thin diagonals are easy to grab with the cursor */}
            {LINKS.map((link, i) => {
              const [ax, ay] = POS[link.a];
              const [bx, by] = POS[link.b];
              return (
                <line
                  key={`h-${i}`}
                  x1={ax}
                  y1={ay + NODE_H / 2}
                  x2={bx}
                  y2={by - NODE_H / 2}
                  stroke="transparent"
                  strokeWidth={14}
                  className="cursor-help"
                  onMouseEnter={() => setHoveredLink(i)}
                  onMouseLeave={() =>
                    setHoveredLink((cur) => (cur === i ? null : cur))
                  }
                />
              );
            })}

            {/* IP labels on lit links — render LAST so they're on top */}
            {LINKS.map((link, i) => {
              if (!isLit(link, i)) return null;
              const [ax, ay] = POS[link.a];
              const [bx, by] = POS[link.b];
              const x1 = ax;
              const y1 = ay + NODE_H / 2;
              const x2 = bx;
              const y2 = by - NODE_H / 2;
              const aPt = lerp(x1, y1, x2, y2, 0.22);
              const bPt = lerp(x1, y1, x2, y2, 0.78);
              return (
                <g key={`ip-${i}`} pointerEvents="none">
                  <IpLabel x={aPt[0]} y={aPt[1]} text={link.aIp} />
                  <IpLabel x={bPt[0]} y={bPt[1]} text={link.bIp} />
                </g>
              );
            })}

            {/* nodes — rendered after links so they sit on top */}
            {devices.map((d) => {
              const pos = POS[d.name];
              if (!pos) return null;
              const [cx, cy] = pos;
              const stroke = GROUP_STROKE[d.group];
              const fill = d.running
                ? GROUP_FILL[d.group]
                : "rgba(31,41,55,0.6)";
              const x = cx - NODE_W / 2;
              const y = cy - NODE_H / 2;
              const isHover = hovered === d.name;
              const subline = d.extra?.asn
                ? `AS ${d.extra.asn}`
                : d.extra?.fabric_ip
                ? String(d.extra.fabric_ip)
                : "";

              return (
                <g
                  key={d.name}
                  className="cursor-pointer"
                  onClick={() => router.push(`/console/${d.name}`)}
                  onMouseEnter={() => setHovered(d.name)}
                  onMouseLeave={() =>
                    setHovered((h) => (h === d.name ? null : h))
                  }
                >
                  <rect
                    x={x}
                    y={y}
                    width={NODE_W}
                    height={NODE_H}
                    rx={9}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isHover ? 3 : d.running ? 2 : 1}
                    opacity={d.running ? 1 : 0.55}
                  />
                  <text
                    x={cx}
                    y={cy - 4}
                    textAnchor="middle"
                    fill="#f3f4f6"
                    fontSize={14}
                    fontFamily="ui-monospace, Menlo, monospace"
                    fontWeight={700}
                  >
                    {d.name}
                  </text>
                  <text
                    x={cx}
                    y={cy + 14}
                    textAnchor="middle"
                    fill="#cbd5e1"
                    fontSize={10}
                  >
                    {subline}
                  </text>
                  <circle
                    cx={x + 10}
                    cy={y + 10}
                    r={4}
                    fill={d.running ? "#10b981" : "#ef4444"}
                  />
                </g>
              );
            })}
          </svg>
        </div>

        {/* details side panel */}
        <DetailsPanel device={hoveredDev} link={hoveredLinkData} />
      </div>
    </div>
  );
}

// ---------- helpers ----------

function lerp(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  t: number
): [number, number] {
  return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
}

function IpLabel({ x, y, text }: { x: number; y: number; text: string }) {
  // Sized for IPs like 10.255.255.255 (max width). Wide enough not to clip.
  const w = 76;
  const h = 16;
  return (
    <g>
      <rect
        x={x - w / 2}
        y={y - h / 2}
        width={w}
        height={h}
        rx={3}
        fill="rgba(15,23,42,0.95)"
        stroke={NODE_HOVER_COLOR}
        strokeWidth={0.75}
      />
      <text
        x={x}
        y={y + 1}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={11}
        fontFamily="ui-monospace, Menlo, monospace"
        fill="#fde68a"
      >
        {text}
      </text>
    </g>
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
  // If hovering a link, prefer that detail — it's more specific than node hover.
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
            href={`/console/${link.a}`}
            className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 border border-white/20"
          >
            {link.a} console →
          </Link>
          <Link
            href={`/console/${link.b}`}
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
            href={`/console/${device.name}`}
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
