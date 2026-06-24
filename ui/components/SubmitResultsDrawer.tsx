"use client";

import type { SubmitResult } from "@/lib/api";
import CheckResultsCard from "./CheckResultsCard";
import { X } from "./icons";

interface Props {
  result: SubmitResult;
  onClose: () => void;
  onRerun: () => void;
}

/**
 * Floating, dismissible submit-results surface anchored bottom-right. Rendered
 * at the page top level (NOT inside the guide pane) so it stays visible
 * regardless of scroll position or which panel has focus — the old inline card
 * was appended below the entire guide and hidden in focus modes, so a failed
 * Submit showed nothing. Shows live progress while running, then a clear
 * verdict with per-check reasons and recovery actions on failure. Success is
 * handled by the full-screen PassedScreen, so the parent dismisses this on pass.
 */
export default function SubmitResultsDrawer({ result, onClose, onRerun }: Props) {
  const total = result.results.length;
  const completed = result.results.filter((r) => !r._pending).length;
  const running = total === 0 || completed < total;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-40 w-[min(440px,calc(100vw-2rem))] rounded-xl border border-white/15 bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur overflow-hidden"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss results"
        className="absolute top-2.5 right-2.5 z-10 inline-flex items-center justify-center w-7 h-7 rounded-md text-white/50 hover:text-white hover:bg-white/10"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="max-h-[55vh] overflow-y-auto">
        <CheckResultsCard result={result} embedded />
      </div>

      {!running && (
        <div className="flex items-center gap-2 px-3 py-2.5 border-t border-white/10 bg-black/30">
          <button
            type="button"
            onClick={onRerun}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-sky-500/20 text-sky-100 hover:bg-sky-500/30 border border-sky-400/30"
          >
            Re-run checks
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-3 py-1.5 rounded-md text-sm text-white/60 hover:text-white hover:bg-white/10"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
