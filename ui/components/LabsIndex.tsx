"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lab, fetchLabs } from "@/lib/api";

export default function LabsIndex() {
  const [labs, setLabs] = useState<Lab[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchLabs()
      .then((d) => alive && setLabs(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error)
    return (
      <div className="p-6 rounded border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm">
        Failed to reach orchestrator: {error}
      </div>
    );
  if (!labs) return <p className="text-white/60">Loading labs…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">AI Data Center Labs</h1>
        <p className="text-white/60 mt-2 max-w-2xl">
          Hands-on labs on hyperscale AI fabrics. Each lab gives you a real CLOS
          fabric of containerised switches you configure through an in-browser
          console — with a guided walkthrough that explains the <em>why</em>
          behind every design decision.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {labs.map((lab) => (
          <LabCard key={lab.id} lab={lab} />
        ))}
      </div>
    </div>
  );
}

function LabCard({ lab }: { lab: Lab }) {
  const isActive = lab.status === "active";
  const body = (
    <div
      className={`group relative h-full rounded-xl border p-5 transition-all ${
        isActive
          ? "border-white/15 bg-black/40 hover:border-emerald-400/50 hover:bg-black/60 cursor-pointer"
          : "border-white/10 bg-black/20 opacity-70 cursor-not-allowed"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-mono text-white/60 bg-white/5">
          Lab {lab.id}
        </span>
        <span
          className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${
            isActive
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
              : "bg-white/5 text-white/40 border border-white/10"
          }`}
        >
          {isActive ? "Available" : "Coming soon"}
        </span>
        {lab.duration_min && (
          <span className="text-[10px] text-white/40 ml-auto">~{lab.duration_min} min</span>
        )}
      </div>

      <h3 className="text-lg font-semibold text-white mb-2">{lab.title}</h3>
      <p className="text-sm text-white/70 leading-relaxed">{lab.summary}</p>

      {lab.learning_objectives && lab.learning_objectives.length > 0 && (
        <ul className="mt-4 space-y-1">
          {lab.learning_objectives.slice(0, 4).map((obj) => (
            <li key={obj} className="text-xs text-white/60 flex gap-2">
              <span className="text-emerald-400/70">✓</span>
              {obj}
            </li>
          ))}
        </ul>
      )}

      {isActive && (
        <div className="mt-5 text-sm text-emerald-300 group-hover:text-emerald-200">
          Enter lab →
        </div>
      )}
    </div>
  );

  return isActive ? <Link href={`/labs/${lab.id}`}>{body}</Link> : body;
}
