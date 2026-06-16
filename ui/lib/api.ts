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

// Every request includes credentials so the aidc_session cookie travels
// across the UI:3000 → orchestrator:8000 origin boundary.
const FETCH_OPTS: RequestInit = { credentials: "include", cache: "no-store" };

export async function fetchDevices(): Promise<Device[]> {
  const r = await fetch(`${API_BASE}/api/devices`, FETCH_OPTS);
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
  /** Optional per-lab Grafana dashboard path (kiosk-mode URL fragment).
   *  When set, the workbench renders a TelemetryPane iframe alongside
   *  the guide + terminals. Resolved against http://<host>:3001 at runtime. */
  grafana_dashboard_path?: string;
  next_lab_id?: string;
  previous_lab_id?: string;
}

export async function fetchLabs(): Promise<Lab[]> {
  const r = await fetch(`${API_BASE}/api/labs`, FETCH_OPTS);
  if (!r.ok) throw new Error(`labs fetch failed: ${r.status}`);
  return r.json();
}

export async function fetchLab(id: string): Promise<Lab> {
  const r = await fetch(`${API_BASE}/api/labs/${id}`, FETCH_OPTS);
  if (!r.ok) throw new Error(`lab ${id} fetch failed: ${r.status}`);
  return r.json();
}

// ---- lab runs ---------------------------------------------------------------
export type LabRunState = "not_started" | "in_progress" | "passed";

export interface LabRun {
  lab_id: string;
  state: LabRunState;
  started_at: string | null;
  submitted_at: string | null;
  passed_at: string | null;
  attempts: number;
  used_solve: boolean;
  last_summary: SubmitResult | null;
}

export interface CheckResult {
  name: string;
  label: string;
  passed: boolean;
  summary: string;
  detail: string | null;
  /** UI-only: row is in the "queued, not yet run" state during a streamed submit. Server never sends this. */
  _pending?: boolean;
}

export interface SubmitResult {
  passed: boolean;
  results: CheckResult[];
  duration_ms: number;
}

export interface SubmitResponse extends SubmitResult {
  run: LabRun;
}

export interface CheckpointSpec {
  name: string;
  label: string;
  order: number;
}

async function postJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { ...FETCH_OPTS, method: "POST" });
  if (!r.ok) {
    let detail = "";
    try {
      const body = await r.json();
      detail = body?.detail ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(`POST ${path} failed: ${r.status}${detail ? ` (${detail})` : ""}`);
  }
  return r.json();
}

export async function fetchLabRun(labId: string): Promise<LabRun> {
  const r = await fetch(`${API_BASE}/api/labs/${labId}/run`, FETCH_OPTS);
  if (!r.ok) throw new Error(`lab run fetch failed: ${r.status}`);
  return r.json();
}

export async function fetchCheckpoints(labId: string): Promise<CheckpointSpec[]> {
  const r = await fetch(`${API_BASE}/api/labs/${labId}/checkpoints`, FETCH_OPTS);
  if (!r.ok) throw new Error(`checkpoints fetch failed: ${r.status}`);
  return r.json();
}

export function startLab(labId: string): Promise<LabRun> {
  return postJson<LabRun>(`/api/labs/${labId}/start`);
}

export function resetLab(labId: string): Promise<LabRun> {
  return postJson<LabRun>(`/api/labs/${labId}/reset`);
}

export function solveLab(labId: string): Promise<LabRun> {
  return postJson<LabRun>(`/api/labs/${labId}/solve`);
}

export function runCheckpoint(labId: string, name: string): Promise<CheckResult> {
  return postJson<CheckResult>(`/api/labs/${labId}/check/${name}`);
}

export function submitLab(labId: string): Promise<SubmitResponse> {
  return postJson<SubmitResponse>(`/api/labs/${labId}/submit`);
}

// ---- streaming submit (SSE) -------------------------------------------------
export interface SubmitMetaEvent {
  checkpoints: CheckpointSpec[];
  total: number;
}

export interface SubmitResultEvent extends CheckResult {
  index: number;
  total: number;
}

export interface SubmitDoneEvent {
  passed: boolean;
  duration_ms: number;
  run: LabRun;
}

export interface SubmitStreamCallbacks {
  onMeta: (e: SubmitMetaEvent) => void;
  onResult: (e: SubmitResultEvent) => void;
  onDone: (e: SubmitDoneEvent) => void;
  onError: (message: string) => void;
}

/**
 * Open an EventSource against the orchestrator's submit stream. Returns a
 * cancel function that closes the connection — call it from a useEffect
 * cleanup so navigating away mid-flight doesn't leak the connection.
 *
 * `withCredentials: true` ships the aidc_session cookie cross-origin; the
 * server's CORS middleware reflects the request Origin and sets
 * Access-Control-Allow-Credentials: true, so the cookie travels.
 */
export function submitLabStream(labId: string, cb: SubmitStreamCallbacks): () => void {
  const url = `${API_BASE}/api/labs/${labId}/submit/stream`;
  const es = new EventSource(url, { withCredentials: true });

  const close = () => {
    try { es.close(); } catch { /* ignore */ }
  };

  es.addEventListener("meta", (ev: MessageEvent) => {
    try { cb.onMeta(JSON.parse(ev.data) as SubmitMetaEvent); } catch (e) { cb.onError(String(e)); close(); }
  });
  es.addEventListener("result", (ev: MessageEvent) => {
    try { cb.onResult(JSON.parse(ev.data) as SubmitResultEvent); } catch (e) { cb.onError(String(e)); close(); }
  });
  es.addEventListener("done", (ev: MessageEvent) => {
    try { cb.onDone(JSON.parse(ev.data) as SubmitDoneEvent); } finally { close(); }
  });
  es.addEventListener("error", () => {
    // EventSource fires 'error' both for transient drops (it'll auto-reconnect)
    // and for fatal close. We treat fatal as anything after readyState=CLOSED.
    if (es.readyState === EventSource.CLOSED) {
      cb.onError("connection to orchestrator was lost");
    }
  });

  return close;
}
