"use client";

import { useEffect } from "react";
import { Device } from "@/lib/api";
import TopologyDiagram from "@/components/TopologyDiagram";

interface Props {
  devices: Device[];
  onPickNode: (name: string) => void;
  onClose: () => void;
}

export default function TopologyOverlay({ devices, onPickNode, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="on-dark fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm p-6"
      role="dialog"
      aria-label="Topology"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">Pick a device</h2>
          <p className="text-white/60 text-sm">
            Click any node to open a terminal tab for it. Press <kbd className="px-1 py-0.5 rounded bg-white/10 border border-white/20 text-xs">Esc</kbd> to close.
          </p>
        </div>
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded border border-white/20 bg-white/5 hover:bg-white/10 text-sm"
        >
          Close
        </button>
      </div>

      <div className="flex-1 min-h-0 rounded-lg border border-white/10 bg-[#0b1020] p-2 overflow-auto">
        <TopologyDiagram
          devices={devices}
          onNodeClick={(name) => {
            onPickNode(name);
            onClose();
          }}
        />
      </div>
    </div>
  );
}
