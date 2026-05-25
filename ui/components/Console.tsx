"use client";

import { useEffect, useRef, useState } from "react";
import { WS_BASE } from "@/lib/api";

export type ConsoleStatus = "connecting" | "open" | "closed" | "error";

interface Props {
  name: string;
  className?: string;
  onStatusChange?: (status: ConsoleStatus, error: string | null) => void;
  active?: boolean;
}

export default function Console({ name, className, onStatusChange, active = true }: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const [status, setStatus] = useState<ConsoleStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    onStatusChange?.(status, lastError);
  }, [status, lastError, onStatusChange]);

  useEffect(() => {
    if (!termRef.current) return;
    let cancelled = false;
    let resizeObs: ResizeObserver | null = null;

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (cancelled || !termRef.current) return;

      const term = new Terminal({
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, "JetBrains Mono", monospace',
        fontSize: 13,
        cursorBlink: true,
        convertEol: false,
        theme: {
          background: "#000000",
          foreground: "#e5e7eb",
          cursor: "#10b981",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termRef.current);
      fit.fit();
      xtermRef.current = term;
      fitRef.current = fit;

      const ws = new WebSocket(`${WS_BASE}/ws/console/${name}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("open");
        const { rows, cols } = term;
        ws.send(JSON.stringify({ type: "resize", rows, cols }));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          term.write(ev.data);
        } else {
          term.write(new Uint8Array(ev.data));
        }
      };
      ws.onclose = (ev) => {
        setStatus("closed");
        if (ev.code >= 4000) setLastError(`code ${ev.code}: ${ev.reason}`);
        term.write(`\r\n\x1b[33m[disconnected]\x1b[0m\r\n`);
      };
      ws.onerror = () => setStatus("error");

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });

      resizeObs = new ResizeObserver(() => {
        try {
          fit.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
          }
        } catch {}
      });
      resizeObs.observe(termRef.current);
    })();

    return () => {
      cancelled = true;
      resizeObs?.disconnect();
      try { wsRef.current?.close(); } catch {}
      try { xtermRef.current?.dispose(); } catch {}
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [name]);

  // When this console becomes the visible tab again, re-fit + refocus so xterm
  // picks up the now-correct container size (it's a no-op while hidden).
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
        xtermRef.current?.focus();
        const ws = wsRef.current;
        const term = xtermRef.current;
        if (ws?.readyState === WebSocket.OPEN && term) {
          ws.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
        }
      } catch {}
    }, 30);
    return () => clearTimeout(t);
  }, [active]);

  return <div ref={termRef} className={className ?? "term-host h-[75vh]"} />;
}
