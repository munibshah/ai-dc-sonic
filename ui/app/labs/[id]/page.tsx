"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchLab, type Lab } from "@/lib/api";
import { holderStatus } from "@/lib/booking";
import GuidePane from "@/components/GuidePane";

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
    ? { href: `/portal/labs/${id}`, label: "Launch this lab →", cls: "bg-emerald-500/90 hover:bg-emerald-500" }
    : { href: "/portal", label: "Book a slot to run this lab →", cls: "bg-sky-500/90 hover:bg-sky-500" };

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
        <Link href="/" className="hover:text-white/80">
          ← All labs
        </Link>
      </div>

      <header className="rounded-2xl border border-purple-500/20 bg-gradient-to-br from-[#0b0820] via-[#120a2e] to-[#1a0d3b] p-6 md:p-8">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-mono text-white/60 bg-white/5">
            Lab {lab.id}
          </span>
          {lab.duration_min && (
            <span className="text-[11px] text-white/40">~{lab.duration_min} min</span>
          )}
        </div>
        <h1 className="text-3xl font-semibold text-white">{lab.title}</h1>
        <p className="text-white/70 mt-3 max-w-2xl leading-relaxed">{lab.summary}</p>

        {lab.learning_objectives && lab.learning_objectives.length > 0 && (
          <ul className="mt-5 grid sm:grid-cols-2 gap-x-6 gap-y-1">
            {lab.learning_objectives.map((o) => (
              <li key={o} className="text-sm text-white/70 flex gap-2">
                <span className="text-emerald-400/70">✓</span>
                {o}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          {/* Plain anchor: a top-level navigation so the /portal auth check + login
              redirect happen cleanly (not a client-side RSC fetch). */}
          <a href={cta.href} className={`rounded-lg ${cta.cls} px-5 py-2.5 text-sm font-semibold text-white`}>
            {cta.label}
          </a>
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

      <div className="my-8 rounded-xl border border-white/10 bg-black/20 p-6 text-center">
        <p className="text-white/70">Ready to get hands-on with a real fabric?</p>
        <a
          href="/portal"
          className="inline-block mt-3 rounded-lg bg-purple-500/80 hover:bg-purple-500 px-5 py-2.5 text-sm font-semibold text-white"
        >
          Book your slot →
        </a>
      </div>
    </div>
  );
}
