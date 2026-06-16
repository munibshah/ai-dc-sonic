"""
AIDC Lab — FastAPI orchestrator.

Runs inside the aidc OrbStack VM so it can `docker exec -it` directly with a
real PTY. Browser on the Mac hits us at http://aidc.orb.local:8000 via
OrbStack's automatic DNS.

Endpoints:
  GET  /api/health                       liveness
  GET  /api/devices                      list lab containers (by group)
  GET  /api/labs                         list available labs (active + coming-soon)
  GET  /api/labs/{id}                    single lab metadata
  GET  /api/labs/{id}/content/{part}     markdown body (part: exercise|solution|overview)
  WS   /ws/console/{name}                PTY-backed shell into the container
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import pty
import shutil
import signal
import struct
import subprocess
import termios
from pathlib import Path
from typing import Dict, List, Literal, Set

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from . import booking_gate, db, labruns, netdev_exporter
from .booking_gate import require_fabric_holder

# ---- topology truth ---------------------------------------------------------
# Hand-coded so we don't depend on `containerlab inspect` being installed in
# the same process; it also gives us friendly grouping for the UI.
DEVICE_GROUPS: Dict[str, List[dict]] = {
    "spine": [
        {"name": "spine1", "kind": "sonic-vs", "asn": 65000, "loopback": "10.0.0.1"},
        {"name": "spine2", "kind": "sonic-vs", "asn": 65000, "loopback": "10.0.0.2"},
    ],
    "leaf": [
        {"name": "leaf1", "kind": "sonic-vs", "asn": 65101, "loopback": "10.0.1.1", "vtep": "10.0.10.1"},
        {"name": "leaf2", "kind": "sonic-vs", "asn": 65102, "loopback": "10.0.1.2", "vtep": "10.0.10.2"},
        {"name": "leaf3", "kind": "sonic-vs", "asn": 65103, "loopback": "10.0.1.3", "vtep": "10.0.10.3"},
        {"name": "leaf4", "kind": "sonic-vs", "asn": 65104, "loopback": "10.0.1.4", "vtep": "10.0.10.4"},
    ],
    "worker": [
        {"name": "gpu1", "kind": "linux", "leaf": "leaf1", "fabric_ip": "10.2.1.1"},
        {"name": "gpu2", "kind": "linux", "leaf": "leaf1", "fabric_ip": "10.2.1.3"},
        {"name": "gpu3", "kind": "linux", "leaf": "leaf2", "fabric_ip": "10.2.2.1"},
        {"name": "gpu4", "kind": "linux", "leaf": "leaf2", "fabric_ip": "10.2.2.3"},
        {"name": "gpu5", "kind": "linux", "leaf": "leaf3", "fabric_ip": "10.2.3.1"},
        {"name": "gpu6", "kind": "linux", "leaf": "leaf3", "fabric_ip": "10.2.3.3"},
        {"name": "gpu7", "kind": "linux", "leaf": "leaf4", "fabric_ip": "10.2.4.1"},
        {"name": "gpu8", "kind": "linux", "leaf": "leaf4", "fabric_ip": "10.2.4.3"},
    ],
}

VALID_NAMES = {d["name"] for group in DEVICE_GROUPS.values() for d in group}

# ---- app --------------------------------------------------------------------
app = FastAPI(title="AIDC Lab Orchestrator", version="0.1.0")

# The UI runs on a different port than the orchestrator (3000 vs 8000), so the
# browser sees them as different origins. We need credentials to flow (the
# aidc_session cookie) — so allow_origins cannot be "*" once allow_credentials
# is True. We mirror the request's Origin (the lab is single-tenant; this isn't
# a real cross-origin trust boundary).
@app.middleware("http")
async def reflect_origin(request: Request, call_next):
    response = await call_next(request)
    origin = request.headers.get("origin")
    if origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Vary"] = "Origin"
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- session ---------------------------------------------------------------
SESSION_COOKIE = "aidc_session"


def session_id(request: Request, response: Response) -> str:
    """FastAPI dependency: resolves (or mints) the caller's session id and
    ensures the cookie is set on the response."""
    incoming = request.cookies.get(SESSION_COOKIE)
    sid = db.get_or_create_session(incoming)
    # When fronted by Cloudflare Access, attribute the session to the
    # authenticated email so the audit log records who did what.
    email = booking_gate.caller_email(request)
    if email:
        db.set_display_name(sid, email)
    if sid != incoming:
        # New session — set cookie. SameSite=Lax + no Secure (lab is http-only).
        response.set_cookie(
            key=SESSION_COOKIE,
            value=sid,
            max_age=60 * 60 * 24 * 365,  # 1 year
            httponly=True,
            samesite="lax",
            path="/",
        )
    return sid

# ---- models -----------------------------------------------------------------
class Device(BaseModel):
    name: str
    group: Literal["spine", "leaf", "worker"]
    kind: str
    running: bool
    extra: dict

# ---- helpers ----------------------------------------------------------------
def _docker_running_names() -> Set[str]:
    """Return the set of currently-running container names docker knows about."""
    try:
        out = subprocess.check_output(
            ["docker", "ps", "--format", "{{.Names}}"],
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return set(out.decode().split())
    except Exception:
        return set()


# ---- HTTP endpoints ---------------------------------------------------------
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/metrics/netdev", response_class=PlainTextResponse)
def metrics_netdev():
    """Prometheus scrape endpoint — per-switch /proc/net/dev counters.

    Exists because sonic-vs's OpenConfig surface does not include the
    clab veths that actually carry fabric traffic. See netdev_exporter.py.
    """
    return Response(
        content=netdev_exporter.scrape(),
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )


@app.get("/api/devices", response_model=List[Device])
def list_devices():
    running = _docker_running_names()
    devices: List[Device] = []
    for group, items in DEVICE_GROUPS.items():
        for d in items:
            devices.append(
                Device(
                    name=d["name"],
                    group=group,  # type: ignore[arg-type]
                    kind=d["kind"],
                    running=d["name"] in running,
                    extra={k: v for k, v in d.items() if k not in ("name", "kind")},
                )
            )
    return devices


# ---- labs registry ----------------------------------------------------------
# Lab content lives under <repo>/docs/lab-guide/*.md and is referenced from the
# registry by paths relative to the repo root.
#
# Two deployment modes:
#   1. Container (default in production): the host repo is bind-mounted at /repo
#      and AIDC_REPO_ROOT=/repo is set in the container env.
#   2. Host process (legacy / tests): no env var; fall back to walking up from
#      this file (orchestrator/api/main.py -> orchestrator/api -> orchestrator
#      -> repo).
REPO_ROOT = Path(
    os.environ.get(
        "AIDC_REPO_ROOT",
        str(Path(__file__).resolve().parent.parent.parent),
    )
)
LABS_REGISTRY_PATH = Path(__file__).resolve().parent / "labs.json"
LAB_CONTENT_PARTS = {"exercise", "solution", "overview"}


def _load_labs_registry() -> List[dict]:
    if not LABS_REGISTRY_PATH.exists():
        return []
    with LABS_REGISTRY_PATH.open() as f:
        return json.load(f)


def _public_lab(entry: dict) -> dict:
    """Strip server-side path fields before returning over the API."""
    return {k: v for k, v in entry.items() if not k.endswith("_path")}


@app.get("/api/labs")
def list_labs():
    return [_public_lab(e) for e in _load_labs_registry()]


@app.get("/api/labs/{lab_id}")
def get_lab(lab_id: str):
    for entry in _load_labs_registry():
        if entry.get("id") == lab_id:
            return _public_lab(entry)
    raise HTTPException(status_code=404, detail=f"lab {lab_id!r} not found")


@app.get("/api/labs/{lab_id}/content/{part}", response_class=PlainTextResponse)
def get_lab_content(lab_id: str, part: str):
    if part not in LAB_CONTENT_PARTS:
        raise HTTPException(status_code=404, detail=f"unknown lab part {part!r}")
    for entry in _load_labs_registry():
        if entry.get("id") != lab_id:
            continue
        rel = entry.get(f"{part}_path")
        if not rel:
            raise HTTPException(status_code=404, detail=f"lab {lab_id} has no {part}")
        path = (REPO_ROOT / rel).resolve()
        # Don't follow paths outside the repo (defense against a malformed registry).
        if REPO_ROOT not in path.parents and path != REPO_ROOT:
            raise HTTPException(status_code=500, detail="lab content path escapes repo")
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"lab content file missing: {rel}")
        return path.read_text()
    raise HTTPException(status_code=404, detail=f"lab {lab_id!r} not found")


# ---- lab run state machine --------------------------------------------------
def _require_lab(lab_id: str) -> dict:
    for entry in _load_labs_registry():
        if entry.get("id") == lab_id:
            if entry.get("status") != "active":
                raise HTTPException(status_code=409, detail=f"lab {lab_id} is not active")
            return entry
    raise HTTPException(status_code=404, detail=f"lab {lab_id!r} not found")


@app.get("/api/labs/{lab_id}/checkpoints")
def get_checkpoints(lab_id: str):
    _require_lab(lab_id)
    return labruns.list_checkpoints(lab_id)


@app.get("/api/labs/{lab_id}/run")
def get_run(lab_id: str, sid: str = Depends(session_id)):
    _require_lab(lab_id)
    return db.get_lab_run(sid, lab_id)


@app.post("/api/labs/{lab_id}/start")
def post_start(
    lab_id: str,
    sid: str = Depends(session_id),
    _holder: str | None = Depends(require_fabric_holder),
):
    _require_lab(lab_id)
    try:
        labruns.bootstrap_lab(lab_id)
    except Exception as e:
        db.log_event(sid, lab_id, "start", passed=False, detail={"error": str(e)})
        raise HTTPException(status_code=500, detail=f"bootstrap failed: {e}")
    run = db.start_lab_run(sid, lab_id)
    db.log_event(sid, lab_id, "start", passed=True)
    return run


@app.post("/api/labs/{lab_id}/reset")
def post_reset(
    lab_id: str,
    sid: str = Depends(session_id),
    _holder: str | None = Depends(require_fabric_holder),
):
    # Same effect as start; separate endpoint for UI clarity. The gate already
    # ran via this route's own dependency, so call the inner helper directly.
    return post_start(lab_id, sid=sid, _holder=_holder)


@app.post("/api/labs/{lab_id}/solve")
def post_solve(
    lab_id: str,
    sid: str = Depends(session_id),
    _holder: str | None = Depends(require_fabric_holder),
):
    _require_lab(lab_id)
    try:
        labruns.solve_lab(lab_id)
    except Exception as e:
        db.log_event(sid, lab_id, "solve", passed=False, detail={"error": str(e)})
        raise HTTPException(status_code=500, detail=f"solve failed: {e}")
    run = db.mark_used_solve(sid, lab_id)
    db.log_event(sid, lab_id, "solve", passed=True)
    return run


@app.post("/api/labs/{lab_id}/check/{checkpoint}")
def post_check(lab_id: str, checkpoint: str, sid: str = Depends(session_id)):
    _require_lab(lab_id)
    try:
        result = labruns.run_checkpoint(lab_id, checkpoint)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    db.log_event(sid, lab_id, checkpoint, passed=result["passed"], detail=result)
    return result


@app.post("/api/labs/{lab_id}/submit")
def post_submit(lab_id: str, sid: str = Depends(session_id)):
    _require_lab(lab_id)
    try:
        result = labruns.run_submit(lab_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    db.record_submit(sid, lab_id, result, all_passed=result["passed"])
    db.log_event(sid, lab_id, "submit", passed=result["passed"], detail=result)
    return {**result, "run": db.get_lab_run(sid, lab_id)}


def _sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")


@app.get("/api/labs/{lab_id}/submit/stream")
def get_submit_stream(lab_id: str, sid: str = Depends(session_id)):
    """Submit the lab and stream per-checkpoint results live via SSE.

    The browser drives this with EventSource (GET-only, so no POST). The
    cookie travels because the CORS middleware sets
    Access-Control-Allow-Credentials and EventSource is called with
    withCredentials=true on the client.

    Events:
      - meta:   {checkpoints, total}                        once at the start
      - result: {name,label,passed,summary,detail,index,total}   per checkpoint
      - done:   {passed, duration_ms, run}                  once at the end
    """
    _require_lab(lab_id)
    checkpoints = labruns.list_checkpoints(lab_id)
    total = len(checkpoints)
    import time as _time

    def event_stream():
        # 1. Meta first so the UI can pre-render skeleton rows.
        yield _sse("meta", {"checkpoints": checkpoints, "total": total})

        # 2. Per-checkpoint results as they land.
        start = _time.monotonic()
        results: list[dict] = []
        all_passed = True
        try:
            for i, r in enumerate(labruns.iter_submit(lab_id)):
                results.append(r)
                if not r["passed"]:
                    all_passed = False
                yield _sse("result", {**r, "index": i, "total": total})
        except ValueError as e:
            yield _sse("error", {"message": str(e)})
            return

        # 3. Persist + emit done.
        duration_ms = int((_time.monotonic() - start) * 1000)
        summary = {"passed": all_passed, "results": results, "duration_ms": duration_ms}
        db.record_submit(sid, lab_id, summary, all_passed=all_passed)
        db.log_event(sid, lab_id, "submit", passed=all_passed, detail=summary)
        yield _sse(
            "done",
            {
                "passed": all_passed,
                "duration_ms": duration_ms,
                "run": db.get_lab_run(sid, lab_id),
            },
        )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---- console WebSocket ------------------------------------------------------
def _set_pty_size(fd: int, rows: int, cols: int) -> None:
    """Tell the kernel the new TTY window size."""
    size = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, size)


@app.websocket("/ws/console/{name}")
async def console(ws: WebSocket, name: str):
    """
    PTY-backed shell into a container.

    Wire protocol (UTF-8 over text frames + raw bytes over binary frames):
      client -> server:
        text "{...json...}"  control message: {"type":"resize","rows":N,"cols":N}
        binary <bytes>       stdin
      server -> client:
        binary <bytes>       stdout
    """
    await ws.accept()
    if name not in VALID_NAMES:
        await ws.close(code=4404, reason=f"unknown device {name!r}")
        return

    # Gate the shell behind the current fabric reservation (no-op when booking
    # enforcement is off). 4423 mirrors the HTTP 423 Locked used by the gate.
    denial = booking_gate.ws_denial(ws)
    if denial:
        await ws.close(code=4423, reason=denial)
        return

    if not shutil.which("docker"):
        await ws.close(code=4500, reason="docker binary not on backend $PATH")
        return

    # Spawn `docker exec -it <name> <shell>` under a PTY.
    # The container has /bin/bash; fall back to sh if not.
    shell_cmd = ["docker", "exec", "-it", name, "bash"]

    pid, fd = pty.fork()
    if pid == 0:
        # ---- child ----
        # Reasonable default size; client will resize on connect.
        try:
            _set_pty_size(0, 24, 80)
        except Exception:
            pass
        os.execvp(shell_cmd[0], shell_cmd)
        os._exit(127)
    # ---- parent ----
    # Non-blocking master fd + selector-driven reads. We deliberately avoid
    # run_in_executor here: under a stuck `pty.read` (e.g. when a previous
    # session left the fd half-open), threads in the default pool wedge and
    # eventually starve the pool, which manifests as new WebSocket connections
    # accepting but never streaming output. With add_reader, the event loop's
    # selector wakes us only when bytes are actually available, so there is
    # nothing to leak.
    fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
    loop = asyncio.get_event_loop()
    out_queue: asyncio.Queue = asyncio.Queue()

    def on_readable():
        try:
            data = os.read(fd, 4096)
        except BlockingIOError:
            return
        except OSError:
            data = b""  # treat as EOF
        if not data:
            try:
                loop.remove_reader(fd)
            except (ValueError, OSError):
                pass
            out_queue.put_nowait(None)
            return
        out_queue.put_nowait(data)

    try:
        loop.add_reader(fd, on_readable)
    except (ValueError, OSError):
        os.close(fd)
        await ws.close(code=4500, reason="failed to register pty reader")
        return

    async def pump_pty_to_ws():
        while True:
            chunk = await out_queue.get()
            if chunk is None:
                break
            try:
                await ws.send_bytes(chunk)
            except Exception:
                break

    async def pump_ws_to_pty():
        try:
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                if "bytes" in msg and msg["bytes"] is not None:
                    os.write(fd, msg["bytes"])
                elif "text" in msg and msg["text"] is not None:
                    text = msg["text"]
                    # try parse as JSON control message
                    try:
                        obj = json.loads(text)
                        if isinstance(obj, dict) and obj.get("type") == "resize":
                            rows = int(obj.get("rows", 24))
                            cols = int(obj.get("cols", 80))
                            _set_pty_size(fd, rows, cols)
                            continue
                    except (json.JSONDecodeError, ValueError, TypeError):
                        pass
                    # not a control message — treat as stdin
                    os.write(fd, text.encode())
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    try:
        await asyncio.gather(pump_pty_to_ws(), pump_ws_to_pty())
    finally:
        try:
            loop.remove_reader(fd)
        except (ValueError, OSError):
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            await ws.close()
        except Exception:
            pass
