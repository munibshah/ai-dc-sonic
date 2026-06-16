"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { requestMagicLink } from "@/lib/auth";

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
    <div className="mx-auto max-w-md mt-12">
      <div className="rounded-2xl border border-white/15 bg-black/40 p-8">
        <h1 className="text-2xl font-semibold text-white">Sign in</h1>
        <p className="text-white/60 text-sm mt-2">
          We&apos;ll email you a one-time sign-in link — no password to remember.
        </p>

        {sent ? (
          <div className="mt-6 rounded-lg border border-emerald-400/40 bg-emerald-500/10 text-emerald-100 px-4 py-3 text-sm">
            Check your inbox — we sent a sign-in link to <b>{email}</b>. It expires in 15 minutes.
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-3">
            {error && (
              <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 text-amber-100 px-3 py-2 text-xs">
                {error}
              </div>
            )}
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2.5 text-white placeholder-white/30 focus:border-purple-400/60 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !email}
              className="w-full rounded-lg bg-purple-500/80 hover:bg-purple-500 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        )}

        <p className="text-white/40 text-xs mt-6">
          <Link href="/" className="hover:text-white/70">
            ← Back to home
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
