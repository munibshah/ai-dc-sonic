"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLabRun, type LabRun } from "@/lib/api";

/**
 * Tracks the current LabRun for a given lab id. Polls every 8s so state
 * driven by the orchestrator (e.g. a Submit-induced transition to "passed")
 * shows up in the UI without a manual refresh. Returns a `refresh()` so
 * callers can force-pull after mutating actions like start / submit.
 */
export function useLabRun(labId: string) {
  const [run, setRun] = useState<LabRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetchLabRun(labId);
      if (alive.current) {
        setRun(r);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(String(e));
    }
  }, [labId]);

  useEffect(() => {
    alive.current = true;
    refresh();
    const t = setInterval(refresh, 8000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  return { run, setRun, error, refresh };
}
