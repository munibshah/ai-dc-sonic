"use client";

import { useEffect, useState } from "react";

type Theme = "default" | "vesper";

const STORAGE_KEY = "aidc-theme";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "default";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "vesper" ? "vesper" : "default";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * Two-state theme toggle: original dark or the Vesper warm-cream coaching
 * palette. Persists via localStorage. The no-flash inline script in
 * layout.tsx applies the stored value to <html data-theme> before paint;
 * this component only handles the user-driven flip and keeps its label
 * synced with the actual attribute.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("default");

  // Sync local state with whatever the inline script (or a previous render)
  // already wrote to <html>, so the first render matches.
  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  const toggle = () => {
    const next: Theme = theme === "vesper" ? "default" : "vesper";
    applyTheme(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    setTheme(next);
  };

  const isVesper = theme === "vesper";
  return (
    <button
      type="button"
      onClick={toggle}
      title={
        isVesper
          ? "Switch to the original dark theme"
          : "Switch to the Vesper warm-cream theme"
      }
      className="text-xs px-2.5 py-1 rounded-full border border-white/20 bg-white/5 hover:bg-white/10 text-white/80 inline-flex items-center gap-1.5 transition-colors"
    >
      <span aria-hidden>{isVesper ? "☀" : "◐"}</span>
      <span>{isVesper ? "Vesper" : "Dark"}</span>
    </button>
  );
}
