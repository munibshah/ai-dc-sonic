"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { WS_BASE } from "@/lib/api";

export default function ConsolePage() {
  const params = useParams<{ name: string }>();
  const name = params?.name as string;
  const termRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    if (!termRef.current) return;
    let cancelled = false;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;
    let resizeObs: ResizeObserver | null = null;

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (cancelled || !termRef.current) return;

      term = new Terminal({
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
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termRef.current);
      fit.fit();

      const ws = new WebSocket(`${WS_BASE}/ws/console/${name}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("open");
        const { rows, cols } = term!;
        ws.send(JSON.stringify({ type: "resize", rows, cols }));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          term!.write(ev.data);
        } else {
          term!.write(new Uint8Array(ev.data));
        }
      };
      ws.onclose = (ev) => {
        setStatus("closed");
        if (ev.code >= 4000) setLastError(`code ${ev.code}: ${ev.reason}`);
        term!.write(`\r\n\x1b[33m[disconnected]\x1b[0m\r\n`);
      };
      ws.onerror = () => {
        setStatus("error");
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });

      resizeObs = new ResizeObserver(() => {
        try {
          fit?.fit();
          if (ws.readyState === WebSocket.OPEN && term) {
            ws.send(
              JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols })
            );
          }
        } catch {}
      });
      resizeObs.observe(termRef.current);
    })();

    return () => {
      cancelled = true;
      resizeObs?.disconnect();
      try { wsRef.current?.close(); } catch {}
      try { term?.dispose(); } catch {}
    };
  }, [name]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-white/60 hover:text-white text-sm">
            ← devices
          </Link>
          <h1 className="text-xl font-mono">{name}</h1>
          <span
            className={`text-xs px-2 py-0.5 rounded ${
              status === "open"
                ? "bg-emerald-500/20 text-emerald-300"
                : status === "connecting"
                ? "bg-amber-500/20 text-amber-300"
                : "bg-rose-500/20 text-rose-300"
            }`}
          >
            {status}
          </span>
        </div>
        <div className="text-white/40 text-xs">
          PTY via backend → docker exec -it {name} bash
        </div>
      </div>

      {lastError && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-rose-200 text-xs">
          {lastError}
        </div>
      )}

      <div className="term-host h-[75vh]" ref={termRef} />
    </div>
  );
}
