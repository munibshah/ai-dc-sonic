"use client";

import { LINKS, POS, VIEW_W, VIEW_H, NODE_W, NODE_H } from "@/lib/topology";

// Static, decorative-but-accurate render of the lab fabric for the marketing
// frontpage. Unlike the interactive <TopologyDiagram/> (which needs live
// Device[] data, hover, IP labels), this one is self-contained: it draws the
// real CLOS shape straight from lib/topology so the picture always matches the
// fabric learners actually configure. No data fetch, no interactivity.

type Tier = "spine" | "leaf" | "worker";

const TIER_OF = (name: string): Tier =>
  name.startsWith("spine") ? "spine" : name.startsWith("leaf") ? "leaf" : "worker";

// Matches the in-app diagram's palette so the picture is recognizable once
// learners reach the real workbench.
const STROKE: Record<Tier, string> = {
  spine: "#a78bfa",
  leaf: "#60a5fa",
  worker: "#34d399",
};
const FILL: Record<Tier, string> = {
  spine: "rgba(124,58,237,0.16)",
  leaf: "rgba(37,99,235,0.16)",
  worker: "rgba(5,150,105,0.16)",
};

// One worker label per node would be noisy at 8 GPUs; show a compact "gpuN".
const shortLabel = (name: string) => name.replace("spine", "spine").replace("leaf", "leaf");

export default function FabricTopology({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className={className ?? "w-full h-auto"}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="The lab fabric: two spine switches, four leaf switches, and eight GPU workers wired in a CLOS topology"
    >
      {/* Tier captions tie each row to the AI-DC story. */}
      <g fontSize="12" fontFamily="ui-monospace, Menlo, monospace" fontWeight={600}>
        <text x="16" y="40" fill={STROKE.spine}>SPINES</text>
        <text x="92" y="40" fill="#94a3b8" fontWeight={400} fontSize="11">· BGP underlay · AS 65000</text>

        <text x="16" y="270" fill={STROKE.leaf}>LEAVES</text>
        <text x="92" y="270" fill="#94a3b8" fontWeight={400} fontSize="11">· EVPN-VXLAN VTEPs · AS 65101–65104</text>

        <text x="16" y="500" fill={STROKE.worker}>GPU WORKERS</text>
        <text x="150" y="500" fill="#94a3b8" fontWeight={400} fontSize="11">· collective traffic (AllReduce)</text>
      </g>

      {/* Links — the CLOS wiring. Static. */}
      {LINKS.map((link, i) => {
        const [ax, ay] = POS[link.a];
        const [bx, by] = POS[link.b];
        return (
          <line
            key={`l-${i}`}
            x1={ax}
            y1={ay + NODE_H / 2}
            x2={bx}
            y2={by - NODE_H / 2}
            stroke="#475569"
            strokeWidth={1.5}
            opacity={0.5}
          />
        );
      })}

      {/* Nodes */}
      {Object.entries(POS).map(([name, [cx, cy]]) => {
        const tier = TIER_OF(name);
        const x = cx - NODE_W / 2;
        const y = cy - NODE_H / 2;
        return (
          <g key={name}>
            <rect
              x={x}
              y={y}
              width={NODE_W}
              height={NODE_H}
              rx={10}
              fill={FILL[tier]}
              stroke={STROKE[tier]}
              strokeWidth={2}
            />
            <text
              x={cx}
              y={cy + 5}
              textAnchor="middle"
              fill="#f3f4f6"
              fontSize={15}
              fontFamily="ui-monospace, Menlo, monospace"
              fontWeight={700}
            >
              {shortLabel(name)}
            </text>
            <circle cx={x + 11} cy={y + 11} r={3.5} fill="#10b981" />
          </g>
        );
      })}
    </svg>
  );
}
