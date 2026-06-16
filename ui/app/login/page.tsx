"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { requestMagicLink } from "@/lib/auth";
import { ArrowLeft, Check, Info, Spinner } from "@/components/icons";

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") || "/portal";
  const initialError = params.get("error");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    initialError === "expired"
      ? "That sign-in link expired or was already used. Request a new one below."
      : initialError === "invalid"
      ? "That sign-in link was invalid. Request a new one below."
      : null,
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestMagicLink(email.trim(), next);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md mt-16">
      <div className="rounded-2xl border border-white/12 bg-black/40 p-8 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.8)]">
        <Image src="/lion-logo.png" alt="" width={48} height={48} priority className="theme-logo-dark rounded-xl ring-1 ring-[var(--accent-brand-line)] mb-5" />
        <Image src="/lion-transparent.png" alt="" width={48} height={48} className="theme-logo-light rounded-xl ring-1 ring-[var(--accent-brand-line)] mb-5" />
        <h1 className="text-2xl font-semibold text-white">Sign in</h1>
        <p className="text-white/60 text-sm mt-2 leading-relaxed">
          We&apos;ll email you a one-time sign-in link — no password to remember.
        </p>

        {sent ? (
          <div className="mt-6 rounded-xl border border-emerald-400/40 bg-emerald-500/10 text-emerald-100 px-4 py-3.5 text-sm flex gap-3">
            <Check className="w-5 h-5 shrink-0 mt-0.5 text-emerald-300" />
            <span>Check your inbox — we sent a sign-in link to <b>{email}</b>. It expires in 15 minutes.</span>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-3">
            {error && (
              <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 text-amber-100 px-3 py-2.5 text-xs flex gap-2">
                <Info className="w-4 h-4 shrink-0 mt-px text-amber-300" />
                <span>{error}</span>
              </div>
            )}
            <label htmlFor="email" className="block text-xs font-medium text-white/50 uppercase tracking-wider">Email address</label>
            <input
              id="email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-white/15 bg-black/30 px-3.5 py-3 text-white placeholder-white/30 focus:border-[var(--accent-brand)] focus:outline-none transition-colors"
            />
            <button type="submit" disabled={busy || !email} className="btn btn-primary w-full !py-3">
              {busy ? (<><Spinner className="w-4 h-4" /> Sending…</>) : "Email me a sign-in link"}
            </button>
            <p className="text-white/40 text-xs pt-1">We never share your email. One link, one session — that&apos;s it.</p>
          </form>
        )}

        <p className="text-white/40 text-xs mt-6">
          <Link href="/" className="inline-flex items-center gap-1.5 hover:text-white/70 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<p className="text-white/60 text-center mt-12">Loading…</p>}>
      <LoginForm />
    </Suspense>
  );
}
