"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, X, Info } from "@/components/icons";

export type ToastTone = "success" | "info" | "error";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  ttl_ms: number;
}

interface ToastsCtx {
  push: (t: Omit<Toast, "id" | "ttl_ms"> & { ttl_ms?: number }) => void;
}

const Ctx = createContext<ToastsCtx | null>(null);

export function useToasts() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToasts must be inside <ToastsProvider>");
  return ctx;
}

export function ToastsProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastsCtx["push"]>((t) => {
    const id = nextId.current++;
    const full: Toast = { id, ttl_ms: 4000, ...t };
    setToasts((ts) => [...ts, full]);
    if (full.ttl_ms > 0) {
      window.setTimeout(() => remove(id), full.ttl_ms);
    }
  }, [remove]);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-sm w-[90vw] sm:w-auto">
        {toasts.map((t) => (
          <ToastBubble key={t.id} toast={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastBubble({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const colors =
    toast.tone === "success"
      ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-100"
      : toast.tone === "error"
      ? "border-rose-400/40 bg-rose-500/15 text-rose-100"
      : "border-sky-400/40 bg-sky-500/15 text-sky-100";
  const Icon = toast.tone === "success" ? Check : toast.tone === "error" ? X : Info;
  // CSS-driven enter animation (uses globals.css `@keyframes toast-in`).
  return (
    <div
      role="status"
      className={`rounded-lg border ${colors} shadow-lg backdrop-blur-sm px-3 py-2.5 flex items-start gap-2.5 toast-enter`}
    >
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{toast.title}</div>
        {toast.body && <div className="text-xs opacity-85 mt-0.5 whitespace-pre-wrap">{toast.body}</div>}
      </div>
      <button
        onClick={onClose}
        aria-label="Dismiss notification"
        className="opacity-60 hover:opacity-100 transition-opacity ml-1 mt-0.5"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
