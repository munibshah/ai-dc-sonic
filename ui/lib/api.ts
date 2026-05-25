// Shared API helpers.
// Resolution order for the backend URL:
//   1. NEXT_PUBLIC_AIDC_API_BASE — set at build/runtime when known (preferred).
//   2. window.location.origin with port 8000 — picks up whichever host the
//      page was served from. Works whether the user opens
//      http://192.168.1.26:3000 or http://lab.local:3000 without rebuilds.
//   3. http://localhost:8000 fallback for SSR contexts where window is undef.

function resolveApiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_AIDC_API_BASE;
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") {
    const proto = window.location.protocol; // http: / https:
    const host  = window.location.hostname; // 192.168.1.26 / localhost / ...
    return `${proto}//${host}:8000`;
  }
  return "http://localhost:8000";
}

export const API_BASE = resolveApiBase();

export const WS_BASE =
  process.env.NEXT_PUBLIC_AIDC_WS_BASE ??
  API_BASE.replace(/^http/, "ws");

export type DeviceGroup = "spine" | "leaf" | "worker";

export interface Device {
  name: string;
  group: DeviceGroup;
  kind: string;
  running: boolean;
  extra: Record<string, string | number>;
}

export async function fetchDevices(): Promise<Device[]> {
  const r = await fetch(`${API_BASE}/api/devices`, { cache: "no-store" });
  if (!r.ok) throw new Error(`devices fetch failed: ${r.status}`);
  return r.json();
}

export type LabStatus = "active" | "coming-soon";

export interface Lab {
  id: string;
  title: string;
  summary: string;
  status: LabStatus;
  duration_min?: number;
  learning_objectives?: string[];
}

export async function fetchLabs(): Promise<Lab[]> {
  const r = await fetch(`${API_BASE}/api/labs`, { cache: "no-store" });
  if (!r.ok) throw new Error(`labs fetch failed: ${r.status}`);
  return r.json();
}

export async function fetchLab(id: string): Promise<Lab> {
  const r = await fetch(`${API_BASE}/api/labs/${id}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`lab ${id} fetch failed: ${r.status}`);
  return r.json();
}
