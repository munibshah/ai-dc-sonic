"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchLab, type Lab } from "@/lib/api";
import { holderStatus } from "@/lib/booking";
import GuidePane from "@/components/GuidePane";
import { ArrowLeft, ArrowRight, Check, Clock } from "@/components/icons";

// Public, read-only lab preview. Anyone can read the guide here; running it
// (consoles, Start/Solve, checkpoints) lives behind sign-in at /portal/labs/[id].
export default function LabPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const [lab, setLab] = useState<Lab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [part, setPart] = useState<"overview" | "exercise">("overview");
  const [canLaunch, setCanLaunch] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchLab(id)
      .then((l) => alive && setLab(l))
      .catch((e) => alive && setError(String(e)));
    // Signed-in slot-holders get a Launch CTA; anonymous/non-holders get Book.
    holderStatus()
      .then((h) => alive && setCanLaunch(Boolean(h.you_hold)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);

  const cta = canLaunch
    ? { href: `/portal/labs/${id}`, label: "Launch this lab", cls: "btn-success" }
    : { href: "/portal/book", label: "Book a slot to run this lab", cls: "btn-primary" };

  if (error)
    return (
      <div className="mx-auto max-w-3xl mt-10 p-6 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm">
        Couldn&apos;t load this lab: {error}
      </div>
    );
  if (!lab) return <p className="text-white/60 text-center mt-12">Loading…</p>;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 text-sm text-white/50">
        <Link href="/" className="inline-flex items-center gap-1.5 hover:text-white/80 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> All labs
        </Link>
      </div>

      <header className="brand-hero rounded-2xl p-6 md:p-9">
        <div className="relative">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-mono text-white/70 bg-white/5 border border-white/10">
              Lab {lab.id}
            </span>
            {lab.duration_min && (
              <span className="inline-flex items-center gap-1 text-[11px] text-white/45">
                <Clock className="w-3.5 h-3.5" /> ~{lab.duration_min} min
              </span>
            )}
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold text-white tracking-tight">{lab.title}</h1>
          <p className="text-white/70 mt-3 max-w-2xl leading-relaxed">{lab.summary}</p>

          {lab.learning_objectives && lab.learning_objectives.length > 0 && (
            <ul className="mt-6 grid sm:grid-cols-2 gap-x-6 gap-y-2">
              {lab.learning_objectives.map((o) => (
                <li key={o} className="text-sm text-white/70 flex gap-2.5">
                  <Check className="w-4 h-4 shrink-0 mt-0.5 text-[var(--accent-positive)]" />
                  {o}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-7 flex flex-wrap gap-3">
            {/* Plain anchor: a top-level navigation so the /portal auth check + login
                redirect happen cleanly (not a client-side RSC fetch). */}
            <a href={cta.href} className={`btn ${cta.cls} btn-lg`}>
              {cta.label} <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        </div>
      </header>

      <div className="mt-6 flex gap-2">
        {(["overview", "exercise"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPart(p)}
            className={`px-3 py-1.5 rounded-lg text-sm capitalize ${
              part === p
                ? "bg-white/15 text-white"
                : "bg-white/5 text-white/60 hover:text-white/90"
            }`}
          >
            {p === "exercise" ? "What you'll do" : "Overview"}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded-xl border border-white/10 bg-black/30">
        <GuidePane labId={lab.id} part={part} readOnly />
      </div>

      <div className="my-10 rounded-2xl border border-white/10 bg-black/20 p-8 text-center">
        <p className="text-white/80 text-lg font-medium">Ready to get hands-on with a real fabric?</p>
        <p className="text-white/50 text-sm mt-1">Book a slot and the fabric is yours for the window.</p>
        <a href="/portal/book" className="btn btn-primary btn-lg mt-5">
          Book your slot <ArrowRight className="w-4 h-4" />
        </a>
      </div>
    </div>
  );
}
