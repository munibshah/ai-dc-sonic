"""
AIDC Lab runner — exercise bootstrap, checkpoint verification, submit, solve.

This is the pure-Python layer that the HTTP endpoints in main.py call into.
It shells out to the host docker daemon via the bind-mounted socket to:
  - rewrite each switch's /etc/frr/frr.conf (via the host bind-mounted file,
    truncate-in-place to preserve the inode the container reads)
  - re-bootstrap FRR inside each switch (the bootstrap-switch.sh script that
    is already bind-mounted into every sonic-vs container)
  - run `vtysh -c '<show ...>'` and `ping` to verify learner work
"""

from __future__ import annotations

import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Iterator, TypedDict

from .checkpoints import lab1, lab2, lab3, lab4, lab5
from .dockerlib import docker_exec, vtysh, count_established  # noqa: F401  (re-export)

REPO_ROOT = Path(os.environ.get("AIDC_REPO_ROOT", "/repo"))
CONFIGS_ROOT = REPO_ROOT / "configs" / "frr"

SWITCHES = ["spine1", "spine2", "leaf1", "leaf2", "leaf3", "leaf4"]

# Worker → leaf mapping (matches workers/entrypoint.sh).
# Used by _reset_workers_to_underlay to put eth1 back on its /31 baseline.
WORKERS = [f"gpu{i}" for i in range(1, 9)]
_WORKER_TO_LEAF = {1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4}


# ---- result types -----------------------------------------------------------
class CheckResult(TypedDict):
    name: str
    label: str
    passed: bool
    summary: str
    detail: str | None


class SubmitResult(TypedDict):
    passed: bool
    results: list[CheckResult]
    duration_ms: int


class CheckpointSpec(TypedDict):
    name: str
    label: str
    order: int


# ---- registry ---------------------------------------------------------------
# Each lab module exposes:
#   CHECKPOINTS:     list[(name, label, runner_callable)]
#   BOOTSTRAP_STATE: name of the configs/frr/<state>/ dir applied on Start/Reset
#                    (e.g. "_skeleton" for Lab 1, "_canonical" for Lab 2,
#                    "_overlay" for Lab 3)
#   SOLVE_STATE:     name of the configs/frr/<state>/ dir applied on Solve
#                    (e.g. "_canonical" for Lab 1, "_overlay" for Lab 2,
#                    "_overlay_workers" for Lab 3)
#   bootstrap_extra: OPTIONAL zero-arg callable invoked AFTER bootstrap config
#                    is applied. Lab 3 uses this to reset worker IPs.
#   solve_extra:     OPTIONAL zero-arg callable invoked AFTER solve config is
#                    applied. Lab 3 uses this to set worker overlay IPs.
#   pre_bootstrap_extra / pre_solve_extra:
#                    OPTIONAL zero-arg callables invoked BEFORE _apply_configs
#                    runs. Lab 4 uses these to enable SONiC's telemetry feature
#                    on every switch so its config_db side effects settle BEFORE
#                    overlay state is laid down (otherwise the telemetry-feature
#                    enable wipes the just-built VXLAN/VLAN/EVPN_NVO state).
#   ORDER:           implicit by CHECKPOINTS list order
_LAB_MODULES = {
    "1": lab1,
    "2": lab2,
    "3": lab3,
    "4": lab4,
    "5": lab5,
}
_REGISTRY: dict[str, list[tuple[str, str, Callable[[], tuple[bool, str, str | None]]]]] = {
    lab_id: mod.CHECKPOINTS for lab_id, mod in _LAB_MODULES.items()
}


def list_checkpoints(lab_id: str) -> list[CheckpointSpec]:
    cps = _REGISTRY.get(lab_id, [])
    return [{"name": n, "label": l, "order": i} for i, (n, l, _) in enumerate(cps)]


def is_container_running(name: str) -> bool:
    proc = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=5,
    )
    return proc.returncode == 0 and proc.stdout.decode().strip() == "true"


# ---- bootstrap / solve -------------------------------------------------------
def _write_inplace(src: Path, dst: Path) -> None:
    """Truncate dst in place and write src's bytes. Preserves dst's inode.

    Required because each switch container bind-mounts dst at /etc/frr/frr.conf;
    a rename-based write would orphan the inode the container still holds.
    """
    data = src.read_bytes()
    with open(dst, "r+b") as f:
        f.seek(0)
        f.truncate()
        f.write(data)


def _bootstrap_one(switch: str) -> tuple[str, int, str]:
    rc, out = docker_exec(switch, ["sh", "/usr/local/bin/bootstrap-switch.sh"], timeout=30)
    return switch, rc, out


def _stage_configs(source_dir_name: str) -> None:
    """Write each switch's frr.conf (and optional overlay-setup.sh) from
    configs/frr/<source>/<sw>/ into the live configs/frr/<sw>/, in place.

    This is the file-staging half of a bootstrap; it does NOT re-run
    bootstrap-switch.sh. Callers either follow with the parallel bootstrap
    loop (see _apply_configs) or drive the switches themselves to surface
    per-switch progress (see iter_reset_to_baseline).

    The optional overlay-setup.sh is what brings up Lab 2's bridge + VXLAN
    device on each leaf. When a source dir has no overlay-setup.sh for a
    switch, the destination is truncated to an empty no-op so the bootstrap
    script tears down any leftover overlay devices.
    """
    src_root = CONFIGS_ROOT / source_dir_name
    for sw in SWITCHES:
        src = src_root / sw / "frr.conf"
        dst = CONFIGS_ROOT / sw / "frr.conf"
        if not src.exists():
            raise FileNotFoundError(f"missing source config: {src}")
        if not dst.exists():
            # First-time create; bind-mount target should already exist, but
            # be defensive.
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(b"")
        _write_inplace(src, dst)

        # overlay-setup.sh: optional per-switch script. The bind-mount target
        # in configs/frr/<sw>/overlay-setup.sh must exist (created on first
        # install / checked into git as an empty +x stub). Source presence
        # is what toggles overlay on/off.
        ov_src = src_root / sw / "overlay-setup.sh"
        ov_dst = CONFIGS_ROOT / sw / "overlay-setup.sh"
        if ov_dst.exists():
            if ov_src.exists():
                _write_inplace(ov_src, ov_dst)
            else:
                # No overlay in this state — empty stub so bootstrap tears down.
                with open(ov_dst, "r+b") as f:
                    f.truncate(0)


def _apply_configs(source_dir_name: str) -> None:
    """Stage each switch's config (see _stage_configs) then re-run
    bootstrap-switch.sh in every switch container in parallel."""
    _stage_configs(source_dir_name)
    with ThreadPoolExecutor(max_workers=len(SWITCHES)) as pool:
        list(pool.map(_bootstrap_one, SWITCHES))


def _reset_one_worker_to_underlay(worker: str) -> None:
    """Put one gpu<N>'s eth1 back on its /31 underlay link with default route.

    Matches workers/entrypoint.sh's initial configuration. We can't just
    re-run /entrypoint.sh because it ends with `/usr/sbin/sshd` which
    fails if sshd is already bound, so we replay the IP setup directly.
    """
    wid = int(worker[3:])
    leaf = _WORKER_TO_LEAF[wid]
    lidx = (wid - 1) % 2
    leaf_ip = f"10.2.{leaf}.{lidx * 2}"
    my_ip = f"10.2.{leaf}.{lidx * 2 + 1}"
    script = (
        f"ip addr flush dev eth1 2>/dev/null || true; "
        f"ip addr add {my_ip}/31 dev eth1; "
        f"ip link set eth1 up; "
        f"ip route replace default via {leaf_ip} dev eth1"
    )
    docker_exec(worker, ["sh", "-c", script], timeout=10)


def _reset_workers_to_underlay() -> None:
    """Run _reset_one_worker_to_underlay across all 8 workers in parallel.

    Universal pre-step in bootstrap_lab: every lab's starting state
    assumes workers carry their /31 underlay IPs. Without this, a
    learner who jumps from Lab 3 (workers on 192.168.100.X) back to
    Lab 1 or Lab 2 would silently see broken worker mesh pings.
    """
    with ThreadPoolExecutor(max_workers=len(WORKERS)) as pool:
        list(pool.map(_reset_one_worker_to_underlay, WORKERS))


def bootstrap_lab(lab_id: str) -> None:
    """Reset the fabric to this lab's starting state.

    Lab 1 starts from `_skeleton` (bare fabric — the learner builds the
    underlay). Lab 2 starts from `_canonical` (healthy underlay — the
    learner adds the EVPN-VXLAN overlay on top). Lab 3 starts from
    `_overlay` (Lab 2 solved — the learner moves workers onto the
    overlay). Each lab module declares which state it wants via its
    `BOOTSTRAP_STATE` attribute, and may declare a `bootstrap_extra`
    callable that runs after switch configs are applied (Lab 3 uses
    this to deliver AllReduce assets to workers).

    Workers are always reset to their /31 underlay baseline first; that
    keeps the bootstrap state of the workers consistent regardless of
    which lab the learner came from.
    """
    if lab_id not in _REGISTRY:
        raise ValueError(f"unknown lab_id {lab_id!r}")
    mod = _LAB_MODULES[lab_id]
    state = getattr(mod, "BOOTSTRAP_STATE", "_skeleton")
    pre_extra = getattr(mod, "pre_bootstrap_extra", None)
    if callable(pre_extra):
        pre_extra()
    _apply_configs(state)
    _reset_workers_to_underlay()
    extra = getattr(mod, "bootstrap_extra", None)
    if callable(extra):
        extra()


def iter_reset_to_baseline() -> Iterator[dict]:
    """Reset the fabric to Lab 1's bootstrap state (`_skeleton`), yielding a
    progress dict per step so the UI can show a live reset.

    This is the "wipe back to the very beginning" used when a booking session
    ends or its timer expires: the next learner inherits a clean bare fabric,
    exactly as if they'd just clicked Start on Lab 1. Functionally equivalent
    to `bootstrap_lab("1")`, but it drives the switches itself (with
    as_completed) instead of fire-and-forget so each switch reports as it lands.

    Yields: {"label": str, "switch": str | None, "done": int, "total": int}.
    """
    mod = _LAB_MODULES["1"]
    state = getattr(mod, "BOOTSTRAP_STATE", "_skeleton")
    total = len(SWITCHES) + 2  # stage step + per-switch + workers step
    done = 0
    yield {"label": "Staging the Lab 1 baseline", "switch": None, "done": done, "total": total}

    pre_extra = getattr(mod, "pre_bootstrap_extra", None)
    if callable(pre_extra):
        pre_extra()
    _stage_configs(state)
    done += 1
    yield {"label": "Re-bootstrapping switches", "switch": None, "done": done, "total": total}

    with ThreadPoolExecutor(max_workers=len(SWITCHES)) as pool:
        futures = {pool.submit(_bootstrap_one, sw): sw for sw in SWITCHES}
        for fut in as_completed(futures):
            sw, _rc, _out = fut.result()
            done += 1
            yield {"label": f"Reset {sw}", "switch": sw, "done": done, "total": total}

    _reset_workers_to_underlay()
    done += 1
    yield {"label": "Workers reset to the underlay baseline", "switch": None, "done": done, "total": total}

    extra = getattr(mod, "bootstrap_extra", None)
    if callable(extra):
        extra()


def solve_lab(lab_id: str) -> None:
    """Apply this lab's "solved" config state to every switch.

    Lab 1's solve = `_canonical` (working underlay). Lab 2's solve =
    `_overlay` (underlay + EVPN-VXLAN). Lab 3's solve =
    `_overlay_workers` (the leaves additionally attach worker ports to
    the VLAN 1000 bridge). Each lab module declares which state it wants
    via its `SOLVE_STATE` attribute, and may declare a `solve_extra`
    callable that runs after switch configs are applied (Lab 3 uses this
    to move worker eth1 onto 192.168.100.0/24 and deliver AllReduce assets).
    """
    if lab_id not in _REGISTRY:
        raise ValueError(f"unknown lab_id {lab_id!r}")
    mod = _LAB_MODULES[lab_id]
    state = getattr(mod, "SOLVE_STATE", "_canonical")
    pre_extra = getattr(mod, "pre_solve_extra", None)
    if callable(pre_extra):
        pre_extra()
    _apply_configs(state)
    extra = getattr(mod, "solve_extra", None)
    if callable(extra):
        extra()


# ---- checkpoints -------------------------------------------------------------
def run_checkpoint(lab_id: str, name: str) -> CheckResult:
    cps = _REGISTRY.get(lab_id)
    if cps is None:
        raise ValueError(f"unknown lab_id {lab_id!r}")
    for cp_name, label, runner in cps:
        if cp_name == name:
            try:
                passed, summary, detail = runner()
            except Exception as e:  # never let the runner crash the API
                passed, summary, detail = False, "check raised an exception", str(e)
            return {
                "name": cp_name,
                "label": label,
                "passed": passed,
                "summary": summary,
                "detail": detail,
            }
    raise ValueError(f"unknown checkpoint {name!r} for lab {lab_id!r}")


def iter_submit(lab_id: str) -> Iterator[CheckResult]:
    """Yield each checkpoint's CheckResult as it completes.

    Runs sequentially so the ping-mesh-style checks don't fight each other for
    the docker daemon, and so any earlier failure surfaces first. Generator
    callers (the SSE endpoint) get incremental progress; collect into a list
    for the legacy one-shot call.
    """
    cps = _REGISTRY.get(lab_id)
    if cps is None:
        raise ValueError(f"unknown lab_id {lab_id!r}")
    for cp_name, label, runner in cps:
        try:
            passed, summary, detail = runner()
        except Exception as e:  # never let the runner crash the API
            passed, summary, detail = False, "check raised an exception", str(e)
        yield {
            "name": cp_name,
            "label": label,
            "passed": passed,
            "summary": summary,
            "detail": detail,
        }


def run_submit(lab_id: str) -> SubmitResult:
    start = time.monotonic()
    results = list(iter_submit(lab_id))
    duration_ms = int((time.monotonic() - start) * 1000)
    return {
        "passed": all(r["passed"] for r in results),
        "results": results,
        "duration_ms": duration_ms,
    }
