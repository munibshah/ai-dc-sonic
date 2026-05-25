"use client";

import { useState } from "react";
import { Device, DeviceGroup } from "@/lib/api";
import {
  LINKS,
  Link as LinkData,
  NODE_H,
  NODE_W,
  POS,
  VIEW_H,
  VIEW_W,
} from "@/lib/topology";

export const GROUP_STROKE: Record<DeviceGroup, string> = {
  spine: "#7c3aed",
  leaf: "#2563eb",
  worker: "#059669",
};
export const GROUP_FILL: Record<DeviceGroup, string> = {
  spine: "rgba(124,58,237,0.18)",
  leaf: "rgba(37,99,235,0.18)",
  worker: "rgba(5,150,105,0.18)",
};
export const GROUP_LABEL: Record<DeviceGroup, string> = {
  spine: "spine",
  leaf: "leaf",
  worker: "worker",
};

export const NODE_HOVER_COLOR = "#f59e0b"; // amber
export const LINK_HOVER_COLOR = "#fb923c"; // orange (unused; kept for parity)

interface Props {
  devices: Device[];
  onNodeClick?: (name: string) => void;
  onHoverDevice?: (device: Device | null) => void;
  onHoverLink?: (link: LinkData | null) => void;
  className?: string;
}

export default function TopologyDiagram({
  devices,
  onNodeClick,
  onHoverDevice,
  onHoverLink,
  className,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredLink, setHoveredLink] = useState<number | null>(null);

  function emitHoveredDev(name: string | null) {
    setHovered(name);
    if (onHoverDevice) {
      const dev = name ? devices.find((d) => d.name === name) ?? null : null;
      onHoverDevice(dev);
    }
  }

  function emitHoveredLink(idx: number | null) {
    setHoveredLink(idx);
    if (onHoverLink) {
      onHoverLink(idx !== null ? LINKS[idx] : null);
    }
  }

  function isLit(link: LinkData, idx: number): boolean {
    if (hoveredLink === idx) return true;
    if (hovered && (link.a === hovered || link.b === hovered)) return true;
    return false;
  }

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className={className ?? "w-full h-auto"}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Lab topology diagram"
    >
      <g fill="#94a3b8" fontSize="10" opacity="0.5">
        <text x="10" y="22">SPINES · AS 65000</text>
        <text x="10" y="252">LEAVES · AS 65101–65104</text>
        <text x="10" y="482">GPU WORKERS · Linux + PyTorch+Gloo</text>
      </g>

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
            onMouseEnter={() => emitHoveredLink(i)}
            onMouseLeave={() =>
              setHoveredLink((cur) => {
                const next = cur === i ? null : cur;
                if (next === null && onHoverLink) onHoverLink(null);
                return next;
              })
            }
          />
        );
      })}

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

      {devices.map((d) => {
        const pos = POS[d.name];
        if (!pos) return null;
        const [cx, cy] = pos;
        const stroke = GROUP_STROKE[d.group];
        const fill = d.running ? GROUP_FILL[d.group] : "rgba(31,41,55,0.6)";
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
            onClick={() => onNodeClick?.(d.name)}
            onMouseEnter={() => emitHoveredDev(d.name)}
            onMouseLeave={() => {
              setHovered((h) => {
                const next = h === d.name ? null : h;
                if (next === null && onHoverDevice) onHoverDevice(null);
                return next;
              });
            }}
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
  );
}

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
