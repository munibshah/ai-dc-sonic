"use client";

interface Props {
  message: string | null;
}

/**
 * Thin strip under the LabControlBar shown while a long-running action is
 * in flight (Start, Reset, Solve, Submit). Indeterminate progress bar +
 * one-line description.
 */
export default function StatusBanner({ message }: Props) {
  if (!message) return null;
  return (
    <div className="mb-3 rounded border border-sky-400/30 bg-sky-500/10 overflow-hidden">
      <div className="px-3 py-1.5 flex items-center gap-2 text-sm text-sky-100">
        <span
          className="inline-block w-3 h-3 rounded-full border-2 border-sky-200/30 border-t-sky-200 animate-spin"
          aria-hidden="true"
        />
        <span className="flex-1">{message}</span>
      </div>
      {/* indeterminate progress bar */}
      <div className="h-0.5 bg-sky-400/15 overflow-hidden">
        <div className="h-full w-1/3 bg-sky-300 animate-status-bar" />
      </div>
    </div>
  );
}
