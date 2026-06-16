"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { fetchLabs, type Lab } from "@/lib/api";
import { publicAvailability, publicNextTraining, type PublicTraining } from "@/lib/booking";
import { LabCard } from "@/components/LabsIndex";
import {
  ArrowRight,
  Layers,
  Bolt,
  ShieldCheck,
  Terminal,
  Calendar,
  Check,
} from "@/components/icons";

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
  { Icon: Terminal, t: "A real fabric, not a simulator", d: "Every lab boots actual SONiC/FRR switches in a CLOS topology — you configure them through in-browser consoles, just like production." },
  { Icon: Layers, t: "Guided, with the why", d: "Each step explains the design decision behind it — BGP underlay, EVPN-VXLAN overlay, GPU collectives, telemetry, failure recovery." },
  { Icon: Check, t: "Checked, not guessed", d: "Click Check on any step for instant pass/fail. Submit runs the full suite and stamps the lab complete." },
  { Icon: ShieldCheck, t: "Exclusive hands-on time", d: "Book a slot and the fabric is yours for the window — no sharing, no clobbering, no setup." },
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
            Self-paced labs on a real SONiC/FRR CLOS fabric: BGP underlay, EVPN-VXLAN overlay, GPU
            collective traffic, streaming telemetry, and failure recovery. Read the guides free; book a
            slot to go hands-on.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <a href="/portal" className="btn btn-primary btn-lg">
              Book a lab slot <ArrowRight className="w-4 h-4" />
            </a>
            <a href="#curriculum" className="btn btn-secondary btn-lg">
              Explore the labs
            </a>
          </div>

          {/* Proof row */}
          <dl className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
            {open != null && open > 0 && (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 live-dot" aria-hidden />
                <dt className="sr-only">Open slots</dt>
                <dd className="text-white/80">
                  <span className="font-semibold text-white">{open}</span> open slot{open === 1 ? "" : "s"} right now
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

      {/* Live training teaser */}
      {training && (
        <section className="rounded-2xl border border-white/12 bg-black/30 p-6 md:p-8 flex flex-col md:flex-row md:items-center gap-5">
          <div className="w-11 h-11 rounded-xl bg-[var(--accent-brand-soft)] text-[var(--accent-brand)] flex items-center justify-center shrink-0">
            <Calendar className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot" aria-hidden />
              <span className="eyebrow">Next live training</span>
            </div>
            <div className="text-xl font-semibold text-white">{training.title}</div>
            <div className="text-sm text-white/70 mt-1">
              {fmtDate(training.starts_at)}
              {training.seats_left != null ? ` · ${training.seats_left} seats left` : ""}
            </div>
          </div>
          <a href="/portal" className="btn btn-primary md:ml-auto shrink-0">
            Reserve your seat <ArrowRight className="w-4 h-4" />
          </a>
        </section>
      )}

      {/* Curriculum */}
      <section id="curriculum" className="scroll-mt-24">
        <div className="eyebrow mb-2">The curriculum</div>
        <h2 className="text-2xl md:text-3xl font-semibold text-white">Five labs, one fabric story</h2>
        <p className="text-white/60 text-sm mt-2 mb-6 max-w-2xl">Each lab builds on the last — the path you&apos;d actually walk to stand up an AI training fabric.</p>
        {!labs ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-40 rounded-xl border border-white/10 bg-black/20 animate-pulse" />
            ))}
          </div>
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
        <div className="eyebrow mb-2">How it works</div>
        <h2 className="text-2xl md:text-3xl font-semibold text-white mb-6">From curious to hands-on in four steps</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {STEPS.map((s, i) => (
            <div key={s.n} className="relative rounded-2xl border border-white/10 bg-black/30 p-6">
              <div className="w-9 h-9 rounded-full bg-[var(--accent-brand-soft)] text-[var(--accent-brand)] flex items-center justify-center font-semibold mb-4">{s.n}</div>
              <div className="text-white font-semibold">{s.t}</div>
              <p className="text-white/60 text-sm mt-1.5 leading-relaxed">{s.d}</p>
              {i < STEPS.length - 1 && (
                <ArrowRight className="hidden lg:block absolute top-7 -right-2.5 w-4 h-4 text-white/20" />
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
          <a href="/portal" className="btn btn-primary btn-lg mt-7">
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
        <a href="/portal" className="hover:text-white/80 transition-colors">Book</a>
        <span className="ml-auto text-white/30">Terms · Privacy (coming soon)</span>
      </footer>
    </div>
  );
}
