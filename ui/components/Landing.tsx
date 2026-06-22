"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { fetchLabs, type Lab } from "@/lib/api";
import { publicAvailability } from "@/lib/booking";
import FabricTopology from "@/components/FabricTopology";
import {
  ArrowRight,
  Layers,
  Bolt,
  ShieldCheck,
  Terminal,
  Check,
} from "@/components/icons";

const VALUE_PROPS = [
  { Icon: Terminal, t: "Real SONiC", d: "Every lab boots actual SONiC/FRR switches in a CLOS topology. You configure them through in-browser consoles." },
  { Icon: Layers, t: "Guided, with the why", d: "Each step explains the design decision behind it. BGP underlay, EVPN-VXLAN overlay, GPU collectives, telemetry, failure recovery." },
  { Icon: Check, t: "Submit and Check", d: "Click Check on any step for instant pass/fail. Submit runs the full suite and stamps the lab complete." },
  { Icon: ShieldCheck, t: "Exclusive hands-on time", d: "Book a slot and the fabric is yours for the window. No setup required." },
];

const STEPS = [
  { n: "1", t: "Pick a lab", d: "Browse the curriculum and read the guide. Free with no sign-up required." },
  { n: "2", t: "Book a slot", d: "Reserve a time window. You'll get a confirmation email + calendar invite." },
  { n: "3", t: "Sign in", d: "One-time email link." },
  { n: "4", t: "Go hands-on", d: "Open the consoles, configure the fabric, pass the checkpoints." },
];

const FAQ = [
  { q: "Do I need my own hardware?", a: "No. Everything runs in the browser against a live virtual fabric we host." },
  { q: "What background do I need?", a: "Comfort with the Linux CLI and basic networking. The guides explain the AI-DC-specific parts." },
  { q: "What happens during my slot?", a: "You get exclusive control of the fabric for the window — start labs, break things, reconverge, and re-run as much as you like." },
  { q: "Can I redo a lab?", a: "Yes. Cleared labs stay open for the rest of your session — replay any of them, and reset the fabric to that lab's starting point whenever you want." },
];

export default function Landing() {
  const [labs, setLabs] = useState<Lab[] | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    fetchLabs().then((d) => alive && setLabs(d)).catch(() => {});
    publicAvailability().then((r) => alive && setOpen(r.open)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const activeCount = labs?.filter((l) => l.status === "active").length ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-20 md:space-y-28 pb-12">
      {/* Hero */}
      <header className="brand-hero rounded-3xl px-6 py-14 md:px-14 md:py-20">
        <div className="relative max-w-3xl">
          <Image src="/lion-logo.png" alt="" width={64} height={64} priority className="theme-logo-dark rounded-2xl ring-1 ring-[var(--accent-brand-line)] mb-7" />
          <Image src="/lion-transparent.png" alt="" width={64} height={64} className="theme-logo-light rounded-2xl ring-1 ring-[var(--accent-brand-line)] mb-7" />
          <div className="eyebrow mb-4">AI Data Center networking · hands-on</div>
          <h1 className="text-4xl md:text-6xl font-semibold text-white leading-[1.05] tracking-tight">
            Learn how hyperscale AI fabrics actually work — by building one.
          </h1>
          <p className="text-white/70 mt-6 text-lg leading-relaxed max-w-2xl">
            Self-paced labs on a SONiC CLOS fabric: BGP underlay, EVPN-VXLAN overlay, GPU collective
            traffic, streaming telemetry. Read the guides for free. Book a slot to go hands-on.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <a href="/portal/book" className="btn btn-primary btn-lg">
              Book a lab slot <ArrowRight className="w-4 h-4" />
            </a>
            <a href="#curriculum" className="btn btn-secondary btn-lg">
              Explore the labs
            </a>
          </div>

          {/* Proof row */}
          <dl className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
            {open === true && (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 live-dot" aria-hidden />
                <dt className="sr-only">Fabric availability</dt>
                <dd className="text-white/80">
                  <span className="font-semibold text-white">Fabric open</span> — start a session now
                </dd>
              </div>
            )}
            {activeCount != null && (
              <div className="flex items-center gap-2">
                <dt className="sr-only">Labs available</dt>
                <dd className="text-white/70">
                  <span className="font-semibold text-white">{activeCount}</span> hands-on lab{activeCount === 1 ? "" : "s"} live
                </dd>
              </div>
            )}
            <div className="flex items-center gap-2">
              <dt className="sr-only">Pricing</dt>
              <dd className="text-white/70">Free during beta · no card</dd>
            </div>
          </dl>
        </div>
      </header>

      {/* The fabric — show the thing they'll build right after the pitch. */}
      <section>
        <div className="eyebrow mb-2">The fabric</div>
        <h2 className="text-2xl md:text-3xl font-semibold text-white">The exact topology you&apos;ll build</h2>
        <p className="text-white/60 text-sm mt-2 mb-6 max-w-2xl">
          A two-tier CLOS: 2 spines, 4 leaves, 8 GPU workers. Every link is routed point-to-point.
          You wire up the BGP underlay, the EVPN-VXLAN overlay, and watch real collective traffic
          flow across the fabric.
        </p>
        {/* Pinned to an explicit dark surface in both themes (like a terminal):
            the diagram's light node labels need a dark ground, and it matches
            the in-app workbench topology learners see later. */}
        <div className="rounded-2xl border border-[#1e2a44] bg-[#0b1020] p-4 md:p-7">
          <FabricTopology className="w-full h-auto" />
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-white/55">
          <span className="inline-flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#a78bfa" }} aria-hidden /> Spine · underlay
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#60a5fa" }} aria-hidden /> Leaf · VTEP / overlay
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#34d399" }} aria-hidden /> GPU worker · collectives
          </span>
        </div>
      </section>

      {/* Value props */}
      <section className="grid sm:grid-cols-2 gap-4">
        {VALUE_PROPS.map(({ Icon, t, d }) => (
          <div key={t} className="rounded-2xl border border-white/10 bg-black/30 p-6 transition-colors hover:border-white/20">
            <div className="w-10 h-10 rounded-xl bg-[var(--accent-brand-soft)] text-[var(--accent-brand)] flex items-center justify-center mb-4">
              <Icon className="w-5 h-5" />
            </div>
            <h3 className="text-white font-semibold">{t}</h3>
            <p className="text-white/65 text-sm mt-2 leading-relaxed">{d}</p>
          </div>
        ))}
      </section>

      {/* Curriculum — slim teaser linking to the free previews */}
      <section id="curriculum" className="scroll-mt-24">
        <div className="eyebrow mb-2">The curriculum</div>
        <h2 className="text-2xl md:text-3xl font-semibold text-white">One SONiC fabric</h2>
        <p className="text-white/60 text-sm mt-2 mb-6 max-w-2xl">
          Each lab builds on the last. Build a real-world virtual AI training fabric. Read the guides
          for free.
        </p>
        {!labs ? (
          <div className="border-t border-white/10">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-14 border-b border-white/10 animate-pulse" />
            ))}
          </div>
        ) : (
          <ol className="border-t border-white/10">
            {labs.map((lab) => (
              <li key={lab.id}>
                <Link
                  href={`/labs/${lab.id}`}
                  className="group flex items-center gap-5 border-b border-white/10 py-4 hover:bg-white/[0.02] transition-colors"
                >
                  <span className="font-mono text-sm text-white/40 tabular-nums shrink-0">
                    {String(lab.id).padStart(2, "0")}
                  </span>
                  <span className="text-white/80 truncate">
                    {lab.title}
                  </span>
                  <ArrowRight className="ml-auto w-4 h-4 text-transparent group-hover:text-[var(--accent-brand)] shrink-0 transition-colors" />
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* How it works */}
      <section>
        <div className="eyebrow mb-2">How it works</div>
        <h2 className="text-2xl md:text-3xl font-semibold text-white mb-6">Hands-on, guide-driven training</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {STEPS.map((s, i) => (
            <div key={s.n} className="relative rounded-2xl border border-white/10 bg-black/30 p-6">
              <div className="w-9 h-9 rounded-full bg-[var(--accent-brand-soft)] text-[var(--accent-brand)] flex items-center justify-center font-semibold mb-4">{s.n}</div>
              <div className="text-white font-semibold">{s.t}</div>
              <p className="text-white/60 text-sm mt-1.5 leading-relaxed">{s.d}</p>
              {/* Arrow sits centered in the gutter between cards — never over a box. */}
              {i < STEPS.length - 1 && (
                <ArrowRight className="hidden lg:block absolute top-1/2 -translate-y-1/2 -right-5 w-4 h-4 text-white/25" />
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="brand-hero rounded-3xl p-10 md:p-14 text-center">
        <div className="relative">
          <div className="eyebrow mb-3">Pricing</div>
          <h2 className="text-3xl md:text-4xl font-semibold text-white">Free during beta</h2>
          <p className="text-white/65 mt-3 max-w-xl mx-auto leading-relaxed">
            Book lab slots and join live training at no cost while we&apos;re in beta. Paid plans come later —
            anything you book now stays free.
          </p>
          <a href="/portal/book" className="btn btn-primary btn-lg mt-7">
            Get started free <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </section>

      {/* FAQ */}
      <section>
        <div className="eyebrow mb-2">FAQ</div>
        <h2 className="text-2xl md:text-3xl font-semibold text-white mb-6">Questions</h2>
        <div className="grid md:grid-cols-2 gap-4">
          {FAQ.map((f) => (
            <div key={f.q} className="rounded-2xl border border-white/10 bg-black/30 p-6">
              <div className="text-white font-medium">{f.q}</div>
              <p className="text-white/60 text-sm mt-2 leading-relaxed">{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 pt-8 text-sm text-white/40 flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="text-white/55 font-medium">AIDC Labs</span>
        <a href="/" className="hover:text-white/80 transition-colors">Labs</a>
        <a href="/portal/book" className="hover:text-white/80 transition-colors">Book</a>
        <a href="/terms" className="ml-auto hover:text-white/80 transition-colors">Terms</a>
        <a href="/privacy" className="hover:text-white/80 transition-colors">Privacy</a>
      </footer>
    </div>
  );
}
