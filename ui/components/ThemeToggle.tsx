"use client";

import { useEffect, useState } from "react";
import { Sun, Moon } from "@/components/icons";

type Theme = "default" | "light" | "vesper";

const STORAGE_KEY = "aidc-theme";

// Cycle order for the toggle: Dark -> Light -> Vesper -> Dark.
const ORDER: Theme[] = ["default", "light", "vesper"];

const META: Record<Theme, { label: string; next: Theme; title: string }> = {
  default: { label: "Dark", next: "light", title: "Switch to the Light theme" },
  light: { label: "Light", next: "vesper", title: "Switch to the Vesper warm-cream theme" },
  vesper: { label: "Vesper", next: "default", title: "Switch to the original Dark theme" },
};

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "default";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return (ORDER as string[]).includes(stored ?? "") ? (stored as Theme) : "default";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * Three-state theme cycle: the original dark, a clean cool Light mode, or the
 * Vesper warm-cream coaching palette. Persists via localStorage. The no-flash
 * inline script in layout.tsx applies the stored value to <html data-theme>
 * before paint; this component only handles the user-driven flip and keeps its
 * label synced with the actual attribute.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("default");

  // Sync local state with the stored preference, and RE-APPLY it to <html>:
  // React hydration of the root element can drop the attribute the inline
  // no-flash script set before paint, so we re-assert it here.
  useEffect(() => {
    const t = readStoredTheme();
    applyTheme(t);
    setTheme(t);
  }, []);

  const cycle = () => {
    const next = META[theme].next;
    applyTheme(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    setTheme(next);
  };

  const meta = META[theme];
  // Dark shows a moon (you're in the dark); the two light palettes show a sun.
  const Icon = theme === "default" ? Moon : Sun;
  return (
    <button
      type="button"
      onClick={cycle}
      title={meta.title}
      className="text-xs px-2.5 py-1 rounded-full border border-white/20 bg-white/5 hover:bg-white/10 text-white/80 inline-flex items-center gap-1.5 transition-colors"
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{meta.label}</span>
    </button>
  );
}
