"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import Console, { ConsoleStatus } from "@/components/Console";

export default function ConsolePage() {
  const params = useParams<{ name: string }>();
  const name = params?.name as string;
  const [status, setStatus] = useState<ConsoleStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-white/60 hover:text-white text-sm">
            ← home
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

      <Console
        name={name}
        onStatusChange={(s, e) => {
          setStatus(s);
          setLastError(e);
        }}
        className="term-host h-[75vh]"
      />
    </div>
  );
}
