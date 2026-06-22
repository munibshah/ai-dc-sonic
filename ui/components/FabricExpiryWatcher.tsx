"use client";

import { useEffect, useRef, useState } from "react";
import { BOOKING_BASE, holderStatus } from "@/lib/booking";
import SessionResetModal from "@/components/SessionResetModal";

/**
 * Watches the caller's fabric hold and, the instant their booking window
 * lapses, wipes the fabric back to Lab 1's baseline and sends them to the
 * launcher. Mount it on any authenticated surface where a learner might be
 * sitting when their timer runs out (the launcher and the lab workbench).
 *
 * Renders nothing until expiry fires; a no-op on deployments without booking.
 */
export default function FabricExpiryWatcher() {
  const [expired, setExpired] = useState(false);
  const heldEndsRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    if (!BOOKING_BASE) return;
    let alive = true;

    // Poll the hold so we always know *our* window's end. Once captured it
    // sticks even after you_hold flips false, so the 1-second tick can detect
    // the boundary crossing and fire exactly once.
    const poll = () =>
      holderStatus()
        .then((s) => {
          if (alive && s.you_hold && s.ends_at) heldEndsRef.current = new Date(s.ends_at).getTime();
        })
        .catch(() => {});
    poll();
    const pollT = setInterval(poll, 20_000);

    const tickT = setInterval(() => {
      const ends = heldEndsRef.current;
      if (!firedRef.current && ends && Date.now() >= ends) {
        firedRef.current = true;
        setExpired(true);
      }
    }, 1000);

    return () => {
      alive = false;
      clearInterval(pollT);
      clearInterval(tickT);
    };
  }, []);

  if (!expired) return null;

  return (
    <SessionResetModal
      open
      mode="expired"
      onFinished={() => {
        // Full reload so every pane (launcher hero, workbench gate) re-reads
        // the now-ended session state.
        window.location.href = "/portal";
      }}
    />
  );
}
