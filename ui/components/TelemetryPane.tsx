"use client";

import { useEffect, useState } from "react";
import { Maximize, Minimize } from "@/components/icons";

interface Props {
  dashboardPath: string;
  /** Optional focus toggle rendered in the header — collapses guide + terminals
   *  so telemetry takes the wide half. Per-panel view control, not lab-wide. */
  onToggleFocus?: () => void;
  focused?: boolean;
}

/**
 * Iframe-embedded Grafana dashboard for the lab workbench.
 *
 * Grafana runs on the same host as the UI but a different port (3001 vs 3000).
 * We compute the src at render time from window.location so the lab works
 * whether the learner opened http://192.168.1.26:3000 or http://lab.local:3000
 * without needing a build-time env var.
 *
 * Server-rendering this would produce a wrong URL (no window), so the iframe
 * mounts only after the first client render.
 */
export default function TelemetryPane({ dashboardPath, onToggleFocus, focused }: Props) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const { protocol, hostname } = window.location;
    setSrc(`${protocol}//${hostname}:3001${dashboardPath}`);
  }, [dashboardPath]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-white/10 bg-black/40 text-xs uppercase tracking-wider text-white/50 flex items-center justify-between gap-2">
        <span>Telemetry</span>
        <div className="flex items-center gap-2">
          {src && (
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              className="text-sky-300/70 hover:text-sky-200 normal-case lowercase text-[10px]"
              title="Open the dashboard in a new tab (full Grafana UI)"
            >
              open in new tab ↗
            </a>
          )}
          {onToggleFocus && (
            <button
              onClick={onToggleFocus}
              title={focused ? "Restore all panes" : "Focus telemetry — collapse guide + terminals"}
              aria-label={focused ? "Restore layout" : "Focus telemetry"}
              className={`p-0.5 rounded ${focused ? "text-violet-300" : "text-white/40 hover:text-white hover:bg-white/10"}`}
            >
              {focused ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 bg-black">
        {src ? (
          <iframe
            src={src}
            className="w-full h-full border-0"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups"
            title="Lab telemetry dashboard"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-white/40 text-sm">
            Loading telemetry…
          </div>
        )}
      </div>
    </div>
  );
}
