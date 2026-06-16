"use client";

import { useEffect, useRef } from "react";

interface Props {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  busyBody?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  busyBody,
  onConfirm,
  onCancel,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // ESC closes (unless busy — don't let the user dismiss mid-op).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  // Focus the confirm button when the dialog opens.
  useEffect(() => {
    if (open && !busy) confirmRef.current?.focus();
  }, [open, busy]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="max-w-md w-full rounded-xl border border-white/15 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <h2 id="confirm-title" className="text-lg font-semibold text-white mb-2">
          {title}
        </h2>
        <div className="text-sm text-white/80 leading-relaxed mb-5">
          {busy ? (
            <div className="flex items-center gap-2">
              <Spinner /> {busyBody ?? "Working…"}
            </div>
          ) : (
            body
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded border border-white/20 bg-white/5 hover:bg-white/10 text-sm disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={busy}
            className={`px-4 py-1.5 rounded border text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${
              danger
                ? "border-rose-400/60 bg-rose-500/20 hover:bg-rose-500/30 text-rose-100"
                : "border-sky-400/60 bg-sky-500/20 hover:bg-sky-500/30 text-sky-100"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin"
      aria-hidden="true"
    />
  );
}
