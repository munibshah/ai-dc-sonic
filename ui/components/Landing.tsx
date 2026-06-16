"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { fetchLabs, type Lab } from "@/lib/api";
import { publicAvailability, publicNextTraining, type PublicTraining } from "@/lib/booking";
import { LabCard } from "@/components/LabsIndex";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const VALUE_PROPS = [
  { t: "A real fabric, not a simulator", d: "Every lab boots actual SONiC/FRR switches in a CLOS topology — you configure them through in-browser consoles, just like production." },
  { t: "Guided, with the why", d: "Each step explains the design decision behind it — BGP underlay, EVPN-VXLAN overlay, GPU collectives, telemetry, failure recovery." },
  { t: "Checked, not guessed", d: "Click Check on any step for instant pass/fail. Submit runs the full suite and stamps the lab complete." },
  { t: "Exclusive hands-on time", d: "Book a slot and the fabric is yours for the window — no sharing, no clobbering, no setup." },
];

const STEPS = [
  { n: "1", t: "Pick a lab", d: "Browse the curriculum and read the guide — free, no sign-up." },
  { n: "2", t: "Book a slot", d: "Reserve a time window. You'll get a confirmation email + calendar invite." },
  { n: "3", t: "Sign in", d: "One-time email link — no passwords." },
  { n: "4", t: "Go hands-on", d: "Open the consoles, configure the fabric, pass the checkpoints." },
];

const FAQ = [
  { q: "Do I need my own hardware?", a: "No. Everything runs in the browser against a live virtual fabric we host." },
  { q: "What background do I need?", a: "Comfort with the Linux CLI and basic networking. The guides explain the AI-DC-specific parts." },
  { q: "What happens during my slot?", a: "You get exclusive control of the fabric for the window — start labs, break things, reconverge, and re-run as much as you like." },
  { q: "Is it really free?", a: "Yes, during the beta. We'll introduce paid plans later; anything you book now stays free." },
];

export default function Landing() {
  const [labs, setLabs] = useState<Lab[] | null>(null);
  const [training, setTraining] = useState<PublicTraining | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetchLabs().then((d) => alive && setLabs(d)).catch(() => {});
    publicNextTraining().then((r) => alive && setTraining(r.session)).catch(() => {});
    publicAvailability().then((r) => alive && setOpen(r.open)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-16">
      {/* Hero */}
      <header className="relative overflow-hidden rounded-3xl border border-purple-500/20 bg-gradient-to-br from-[#0b0820] via-[#120a2e] to-[#1a0d3b] px-6 py-12 md:px-12 md:py-16">
        <div
          className="absolute inset-y-0 right-0 w-2/3 opacity-20 pointer-events-none bg-[radial-gradient(ellipse_at_right,_rgba(168,85,247,0.55),_transparent_60%)]"
          aria-hidden
        />
        <div className="relative max-w-3xl">
          <Image src="/lion-logo.png" alt="" width={72} height={72} priority className="theme-logo-dark rounded-xl ring-1 ring-purple-400/30 mb-6" />
          <Image src="/lion-transparent.png" alt="" width={72} height={72} className="theme-logo-light rounded-xl ring-1 ring-purple-400/30 mb-6" />
          <div className="text-[11px] uppercase tracking-[0.22em] text-purple-300/80 mb-3">AI Data Center networking · hands-on</div>
          <h1 className="text-4xl md:text-5xl font-semibold text-white leading-tight">
            Learn how hyperscale AI fabrics actually work — by building one.
          </h1>
          <p className="text-white/70 mt-5 text-lg leading-relaxed">
            Self-paced labs on a real SONiC/FRR CLOS fabric: BGP underlay, EVPN-VXLAN overlay, GPU
            collective traffic, streaming telemetry, and failure recovery. Read the guides free; book a
            slot to go hands-on.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="/portal" className="rounded-lg bg-purple-500/90 hover:bg-purple-500 px-6 py-3 text-sm font-semibold text-white">
              Book a lab slot →
            </a>
            <a href="#curriculum" className="rounded-lg border border-white/20 hover:bg-white/10 px-6 py-3 text-sm font-semibold text-white/90">
              Explore the labs
            </a>
          </div>
          {open != null && open > 0 && (
            <p className="text-xs text-emerald-300/80 mt-4">{open} open lab slot{open === 1 ? "" : "s"} available now</p>
          )}
        </div>
      </header>

      {/* Value props */}
      <section className="grid sm:grid-cols-2 gap-4">
        {VALUE_PROPS.map((v) => (
          <div key={v.t} className="rounded-xl border border-white/10 bg-black/30 p-5">
            <h3 className="text-white font-semibold">{v.t}</h3>
            <p className="text-white/65 text-sm mt-2 leading-relaxed">{v.d}</p>
          </div>
        ))}
      </section>

      {/* Live training teaser */}
      {training && (
        <section className="rounded-2xl border border-amber-400/30 bg-amber-500/5 p-6 md:p-8 flex flex-col md:flex-row md:items-center gap-4">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.2em] text-amber-300/80 mb-1">Next live training</div>
            <div className="text-xl font-semibold text-white">{training.title}</div>
            <div className="text-sm text-white/70 mt-1">
              {fmtDate(training.starts_at)}
              {training.seats_left != null ? ` · ${training.seats_left} seats left` : ""}
            </div>
          </div>
          <a href="/portal" className="md:ml-auto shrink-0 rounded-lg bg-amber-500/90 hover:bg-amber-500 px-5 py-2.5 text-sm font-semibold text-[#1a1206]">
            Reserve your seat →
          </a>
        </section>
      )}

      {/* Curriculum */}
      <section id="curriculum" className="scroll-mt-20">
        <h2 className="text-2xl font-semibold text-white mb-1">The curriculum</h2>
        <p className="text-white/60 text-sm mb-5">Each lab builds on the last — the path you&apos;d actually walk to stand up an AI training fabric.</p>
        {!labs ? (
          <p className="text-white/50 text-sm">Loading labs…</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {labs.map((lab) => (
              <LabCard key={lab.id} lab={lab} />
            ))}
          </div>
        )}
      </section>

      {/* How it works */}
      <section>
        <h2 className="text-2xl font-semibold text-white mb-5">How it works</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-xl border border-white/10 bg-black/30 p-5">
              <div className="w-8 h-8 rounded-full bg-purple-500/30 text-purple-200 flex items-center justify-center font-semibold mb-3">{s.n}</div>
              <div className="text-white font-semibold">{s.t}</div>
              <p className="text-white/60 text-sm mt-1.5 leading-relaxed">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="rounded-2xl border border-emerald-400/30 bg-emerald-500/5 p-8 text-center">
        <div className="text-[11px] uppercase tracking-[0.2em] text-emerald-300/80 mb-2">Pricing</div>
        <h2 className="text-3xl font-semibold text-white">Free during beta</h2>
        <p className="text-white/65 mt-2 max-w-xl mx-auto">
          Book lab slots and join live training at no cost while we&apos;re in beta. Paid plans come later —
          anything you book now stays free.
        </p>
        <a href="/portal" className="inline-block mt-5 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 px-6 py-3 text-sm font-semibold text-[#06140d]">
          Get started free →
        </a>
      </section>

      {/* FAQ */}
      <section>
        <h2 className="text-2xl font-semibold text-white mb-5">Questions</h2>
        <div className="space-y-3">
          {FAQ.map((f) => (
            <div key={f.q} className="rounded-xl border border-white/10 bg-black/30 p-5">
              <div className="text-white font-medium">{f.q}</div>
              <p className="text-white/60 text-sm mt-1.5 leading-relaxed">{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 pt-6 pb-10 text-sm text-white/40 flex flex-wrap gap-x-6 gap-y-2">
        <span>© AIDC Labs</span>
        <a href="/" className="hover:text-white/70">Labs</a>
        <a href="/portal" className="hover:text-white/70">Book</a>
        <span className="text-white/25">Terms · Privacy (coming soon)</span>
      </footer>
    </div>
  );
}
