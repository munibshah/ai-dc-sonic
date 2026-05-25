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
from typing import Dict, List, Literal, Optional, Set

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

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

# Dev: allow the Next.js dev server (3000) and any localhost origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    loop = asyncio.get_event_loop()

    # Make the master non-blocking-ish: we use run_in_executor for reads.

    async def pump_pty_to_ws():
        try:
            while True:
                data = await loop.run_in_executor(None, _safe_read, fd, 4096)
                if data is None:
                    break
                if not data:
                    await asyncio.sleep(0.01)
                    continue
                await ws.send_bytes(data)
        except Exception:
            pass

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
        # Kill the child shell + close fd.
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


def _safe_read(fd: int, n: int) -> Optional[bytes]:
    """Read up to n bytes from fd; return None on EOF/closed, b'' if would-block."""
    try:
        return os.read(fd, n)
    except OSError:
        return None
