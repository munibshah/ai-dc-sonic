"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Lab, fetchLabs } from "@/lib/api";
import { ArrowRight, Check } from "@/components/icons";

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
    <div className="space-y-8">
      <header className="brand-hero rounded-2xl px-6 py-8 md:px-10 md:py-10">
        <div className="relative flex flex-col md:flex-row items-start md:items-center gap-6 md:gap-8">
          <Image
            src="/lion-logo.png"
            alt="AI DC Training Course"
            width={140}
            height={140}
            priority
            className="theme-logo-dark rounded-xl ring-1 ring-purple-400/30 shadow-[0_0_40px_rgba(168,85,247,0.25)] shrink-0"
          />
          <Image
            src="/lion-transparent.png"
            alt="AI DC Training Course"
            width={140}
            height={140}
            className="theme-logo-light rounded-xl ring-1 ring-purple-400/30 shadow-[0_0_40px_rgba(168,85,247,0.25)] shrink-0"
          />
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.22em] text-purple-300/80 mb-2">
              AI DC Training Course
            </div>
            <h1 className="text-3xl md:text-4xl font-semibold text-white">
              AI Data Center Labs
            </h1>
            <p className="text-white/70 mt-3 max-w-2xl leading-relaxed">
              Hands-on labs on hyperscale AI fabrics. Each lab gives you a real
              CLOS fabric of containerised switches you configure through an
              in-browser console — with a guided walkthrough that explains the
              <em> why</em> behind every design decision.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <a href="/portal" className="btn btn-primary">
                Book a slot or instructor-led training <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {labs.map((lab) => (
          <LabCard key={lab.id} lab={lab} />
        ))}
      </div>
    </div>
  );
}

// Each lab gets a geometric illustration from the Vesper design system, chosen
// to reinforce the lab's central concept. Reuse is intentional where the
// metaphor fits — `horizons` reads as "layers above the baseline" for both
// the overlay and super-spine labs; `sun` as "radiating outward" for both
// the AllReduce and telemetry-streaming labs. Illustrations only paint in
// Vesper mode (see `.vesper-only` in globals.css) since they're designed
// for a cream ground.
const LAB_ILLUSTRATION: Record<string, string> = {
  "1": "/illustrations/network.svg",   // BGP underlay — spine+leaf graph
  "2": "/illustrations/horizons.svg",  // overlay rides on underlay
  "3": "/illustrations/sun.svg",       // collective ops radiating from every rank
  "4": "/illustrations/sun.svg",       // telemetry streaming outward
  "5": "/illustrations/horizons.svg",  // super spines — the layer above the pod
  "6": "/illustrations/shield.svg",    // resilience under failure
};

export function LabCard({ lab }: { lab: Lab }) {
  const isActive = lab.status === "active";
  const illustration = LAB_ILLUSTRATION[lab.id];
  const body = (
    <div
      className={`group relative h-full rounded-xl border p-5 transition-all ${
        isActive
          ? "border-white/15 bg-black/40 hover:border-emerald-400/50 hover:bg-black/60 cursor-pointer"
          : "border-white/10 bg-black/20 opacity-70 cursor-not-allowed"
      }`}
    >
      {illustration && (
        // Small corner accent — sits absolutely in the top-right of the
        // card so it doesn't push text content down. Vesper-only because
        // the SVGs are flat geometric on warm colors and would clash with
        // the dark theme. `pointer-events-none` keeps the click target
        // for the whole card unchanged.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={illustration}
          alt=""
          aria-hidden="true"
          className="vesper-only absolute top-4 right-4 pointer-events-none"
          style={{ height: 52, width: "auto", opacity: 0.85 }}
        />
      )}

      <div className="flex items-center gap-2 mb-2 lab-card-clear-corner">
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

      <h3 className="text-lg font-semibold text-white mb-2 lab-card-clear-corner">{lab.title}</h3>
      <p className="text-sm text-white/70 leading-relaxed">{lab.summary}</p>

      {lab.learning_objectives && lab.learning_objectives.length > 0 && (
        <ul className="mt-4 space-y-1">
          {lab.learning_objectives.slice(0, 4).map((obj) => (
            <li key={obj} className="text-xs text-white/60 flex gap-2">
              <Check className="w-3.5 h-3.5 shrink-0 mt-px text-[var(--accent-positive)]" />
              {obj}
            </li>
          ))}
        </ul>
      )}

      {isActive && (
        <div className="mt-5 text-sm text-emerald-300 group-hover:text-emerald-200 inline-flex items-center gap-1.5">
          Enter lab <ArrowRight className="w-3.5 h-3.5" />
        </div>
      )}
    </div>
  );

  return isActive ? <Link href={`/labs/${lab.id}`}>{body}</Link> : body;
}
