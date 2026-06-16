"use client";

import { useEffect, useState } from "react";
import { getMe, logout, type Me } from "@/lib/auth";

/** Header control: shows the signed-in email + Sign out, or a Sign in link. */
export default function AccountControl() {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    getMe().then((m) => {
      if (alive) {
        setMe(m);
        setLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!loaded) return null;

  if (!me) {
    return (
      <a href="/login" className="text-sm text-white/70 hover:text-white">
        Sign in
      </a>
    );
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-white/50 hidden sm:inline max-w-[180px] truncate" title={me.email}>
        {me.email}
      </span>
      <button
        onClick={async () => {
          await logout();
          window.location.href = "/";
        }}
        className="text-white/70 hover:text-white"
      >
        Sign out
      </button>
    </div>
  );
}
