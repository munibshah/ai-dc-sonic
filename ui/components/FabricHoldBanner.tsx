"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BOOKING_BASE, holderStatus, type HolderStatus } from "@/lib/booking";
import { Check, Clock } from "@/components/icons";

function fmtUntil(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * Banner on the lab workbench that makes the booking gate legible: it tells the
 * learner whether they currently hold the shared fabric. Without it, a learner
 * outside their slot would just see Start/Reset/Solve fail with an opaque 423.
 *
 * Renders nothing when booking isn't configured on this deployment, so the
 * workbench is unchanged for the default single-user setup.
 */
export default function FabricHoldBanner() {
  const [status, setStatus] = useState<HolderStatus | null>(null);

  useEffect(() => {
    if (!BOOKING_BASE) return;
    let alive = true;
    const poll = () =>
      holderStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => {
          /* booking service down / not gated — stay silent */
        });
    poll();
    const t = setInterval(poll, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!BOOKING_BASE || !status) return null;

  if (status.you_hold) {
    return (
      <div className="rounded-lg border border-emerald-400/40 bg-emerald-500/10 text-emerald-100 px-4 py-2 text-sm flex items-center gap-2">
        <Check className="w-4 h-4 shrink-0" />
        You hold the fabric until {fmtUntil(status.ends_at)}. Start, Reset, and Solve are unlocked.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 text-amber-100 px-4 py-2 text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
      <Clock className="w-4 h-4 shrink-0" />
      {status.reserved ? (
        <>Fabric reserved by another learner until {fmtUntil(status.ends_at)} — Start/Reset/Solve are locked.</>
      ) : (
        <>You don&apos;t have an active reservation — Start/Reset/Solve are locked.</>
      )}
      <Link href="/portal" className="underline hover:text-amber-50">
        Book a slot
      </Link>
    </div>
  );
}
