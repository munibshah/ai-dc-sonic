"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getMe } from "@/lib/auth";

/**
 * Client-side gate for /portal/* pages. Real enforcement lives at the API layer
 * (the orchestrator gate + the Worker both verify the cookie); this is purely
 * UX — it redirects an unauthenticated visitor to /login?next=<here> instead of
 * letting them hit a wall of 401/423s.
 */
export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<"checking" | "ok">("checking");

  useEffect(() => {
    let alive = true;
    getMe().then((me) => {
      if (!alive) return;
      if (me) {
        setState("ok");
      } else {
        const next = encodeURIComponent(pathname || "/portal");
        window.location.href = `/login?next=${next}`;
      }
    });
    return () => {
      alive = false;
    };
  }, [pathname]);

  if (state === "checking") {
    return <p className="text-white/50 text-center mt-12 text-sm">Checking your session…</p>;
  }
  return <>{children}</>;
}
