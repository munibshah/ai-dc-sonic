"""
Lab 3 — GPUs on the Overlay + first AllReduce. Checkpoints.

Lab 3 starts from Lab 2's solved state (_overlay). The fabric has a full
EVPN-VXLAN overlay between the four leaves; leaf-to-leaf ping over
Vlan1000 (192.168.100.0/24) works. But the eight workers are still on
their per-leaf /31 underlay links — not part of the stretched L2 segment.

The learner's job is to bring the workers ONTO the overlay:
  - On each leaf, attach eth3 (gpuA) and eth4 (gpuB) to the kernel
    `Bridge` device as VLAN 1000 access ports. Once the L3 IPs are
    flushed, the worker veths are pure L2 access into the stretched
    overlay segment.
  - On each worker, replace eth1's /31 underlay IP with an overlay IP
    in 192.168.100.0/24. gpu<N> -> 192.168.100.<10+N>. No default route
    needed — every peer is on-link.
  - Run a Gloo AllReduce, first a 2-rank smoke test (gpu1 + gpu3 across
    two leaves) and then the full 8-rank collective.

SOLVE_STATE = `_overlay_workers`: same EVPN as Lab 2 but the leaves drop
the eth3/eth4 L3 IPs (the worker /31s are retired), and each leaf's
overlay-setup.sh additionally runs `ip link set ethN master Bridge` +
`bridge vlan add` for the worker-facing ports.

Module-level lifecycle hooks (bootstrap_extra, solve_extra) handle the
worker-side state changes the orchestrator can't get from switching FRR
states alone:
  - bootstrap_extra: deliver /opt/aidc/allreduce.py to every worker.
    Worker IPs are already reset to /31 underlay by labruns' universal
    pre-step, so this hook only needs to push the script.
  - solve_extra: deliver /opt/aidc/allreduce.py + move every worker's
    eth1 onto 192.168.100.0/24.

Each checkpoint is a zero-arg callable returning (passed, summary, detail).
"""

from __future__ import annotations

import os
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from ..dockerlib import docker_exec


LEAVES = ["leaf1", "leaf2", "leaf3", "leaf4"]
WORKERS = [f"gpu{i}" for i in range(1, 9)]

# Per-worker overlay IP — gpu<N> -> 192.168.100.<10+N>.
# Skipping 192.168.100.1..4 to leave those for the leaf Vlan1000 IPs (Lab 2).
WORKER_OVERLAY_IP = {f"gpu{i}": f"192.168.100.{10 + i}" for i in range(1, 9)}

VLAN_ID = "1000"
BRIDGE_NAME = "Bridge"
RENDEZVOUS_PORT = 29500

# Worker eth1 MTU on the overlay. The clab veth default is 9500, but the
# leaves' vtep-1000 device defaults to MTU 1500 — if the worker stays at
# 9500, Linux negotiates TCP MSS=9460 and Gloo's first real data write
# gets dropped silently at the VTEP encap. Pings work, rendezvous works,
# AllReduce hangs. Lab 3 fixes this from the worker side; see the Step 3
# callout in lab3-exercise.md for the full story.
WORKER_OVERLAY_MTU = 1500

# Lab 3 boots from Lab 2's solved overlay. Solve = workers fully on overlay.
BOOTSTRAP_STATE = "_overlay"
SOLVE_STATE = "_overlay_workers"

# allreduce.py source path: the orchestrator container bind-mounts the repo
# at /repo (see topo/aidc.clab.yml). Lab 3 adds a read-only bind for
# /repo/workers/scripts so this file is reachable here.
REPO_ROOT = Path(os.environ.get("AIDC_REPO_ROOT", "/repo"))
ALLREDUCE_SCRIPT_SRC = REPO_ROOT / "workers" / "scripts" / "allreduce.py"
ALLREDUCE_SCRIPT_DST = "/opt/aidc/allreduce.py"


# ---- helpers ----------------------------------------------------------------
def _deliver_allreduce(worker: str) -> None:
    """`docker cp` the AllReduce script into the worker (idempotent overwrite).

    The orchestrator's published worker image (munibshah/aidc-worker:latest)
    pre-dates Lab 3 so /opt/aidc/allreduce.py is not in the image. We push
    the current copy on every Start/Solve so the lab works regardless of
    which worker image is pulled.
    """
    if not ALLREDUCE_SCRIPT_SRC.exists():
        raise FileNotFoundError(
            f"missing AllReduce script source: {ALLREDUCE_SCRIPT_SRC} "
            f"(is workers/scripts bind-mounted into the orchestrator?)"
        )
    subprocess.run(
        ["docker", "cp", str(ALLREDUCE_SCRIPT_SRC), f"{worker}:{ALLREDUCE_SCRIPT_DST}"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        timeout=15,
    )


def _put_worker_on_overlay(worker: str) -> None:
    """Configure gpu<N>'s eth1 with its 192.168.100.<10+N>/24 overlay IP."""
    overlay_ip = WORKER_OVERLAY_IP[worker]
    script = (
        f"ip addr flush dev eth1 2>/dev/null || true; "
        f"ip link set dev eth1 mtu {WORKER_OVERLAY_MTU}; "
        f"ip addr add {overlay_ip}/24 dev eth1; "
        f"ip link set eth1 up; "
        f"ip route del default 2>/dev/null || true"
    )
    rc, out = docker_exec(worker, ["sh", "-c", script], timeout=10)
    if rc != 0:
        raise RuntimeError(f"{worker}: overlay config failed (rc={rc}): {out[:200]}")


# ---- lifecycle hooks --------------------------------------------------------
def bootstrap_extra() -> None:
    """Lab 3 Start ▶: deliver /opt/aidc/allreduce.py to every worker.

    Worker IPs are reset to /31 underlay by labruns._reset_workers_to_underlay
    (which runs unconditionally for every lab's bootstrap), so this hook
    only needs to push the AllReduce script the lab's checkpoints invoke.
    """
    with ThreadPoolExecutor(max_workers=len(WORKERS)) as pool:
        list(pool.map(_deliver_allreduce, WORKERS))


def solve_extra() -> None:
    """Lab 3 Solve ✓: deliver allreduce.py + put every worker on 192.168.100.0/24.

    Switch state at this point is `_overlay_workers` — leaves have already
    attached eth3/eth4 to the bridge via overlay-setup.sh. Moving the
    workers onto the overlay completes the picture.
    """
    with ThreadPoolExecutor(max_workers=len(WORKERS)) as pool:
        list(pool.map(_deliver_allreduce, WORKERS))
        list(pool.map(_put_worker_on_overlay, WORKERS))


# ---- checkpoint runners -----------------------------------------------------
def _check_leaf_bridge_members():
    """Every leaf has eth3+eth4 attached to `Bridge` with VLAN 1000 PVID."""
    missing: list[str] = []
    for leaf in LEAVES:
        for iface in ("eth3", "eth4"):
            rc, out = docker_exec(leaf, ["ip", "link", "show", iface])
            if rc != 0:
                missing.append(f"{leaf}/{iface}: ip link failed")
                continue
            if f"master {BRIDGE_NAME}" not in out:
                head = (out.splitlines() or [""])[0][:90]
                missing.append(f"{leaf}/{iface}: not enslaved to {BRIDGE_NAME} ({head})")
                continue
            rc2, vout = docker_exec(leaf, ["bridge", "vlan", "show", "dev", iface])
            if rc2 != 0 or VLAN_ID not in vout:
                missing.append(f"{leaf}/{iface}: VLAN {VLAN_ID} missing in bridge vlan show")
                continue
            if "PVID" not in vout:
                missing.append(f"{leaf}/{iface}: in VLAN {VLAN_ID} but no PVID flag (will tag egress)")
    if missing:
        return False, "worker access ports not attached to VLAN 1000 on every leaf", "\n".join(missing)
    return True, "all 8 leaf worker ports (eth3+eth4 × 4 leaves) on VLAN 1000 bridge", None


def _check_worker_overlay_ips():
    """Every worker has 192.168.100.<10+id>/24 on eth1 at MTU 1500.

    MTU is part of this check (not a separate one) because a wrong MTU is
    silently fine for pings and rendezvous — it only manifests as a hang
    once Step 6 fires the first real AllReduce. Catching it here turns
    "AllReduce mysteriously hangs" into "Step 3 checkpoint fails with a
    clear pointer at the MTU line."
    """
    missing: list[str] = []
    for w in WORKERS:
        want = WORKER_OVERLAY_IP[w]
        rc, out = docker_exec(w, ["ip", "-br", "-4", "addr", "show", "eth1"])
        if rc != 0 or f"{want}/24" not in out:
            missing.append(f"{w}: expected {want}/24, got {out.strip()[:90]}")
            continue
        rc2, link_out = docker_exec(w, ["ip", "link", "show", "eth1"])
        if rc2 != 0:
            missing.append(f"{w}: ip link show eth1 failed: {link_out.strip()[:90]}")
            continue
        if f"mtu {WORKER_OVERLAY_MTU}" not in link_out:
            head = (link_out.splitlines() or [""])[0][:140]
            missing.append(
                f"{w}: eth1 MTU != {WORKER_OVERLAY_MTU} "
                f"(run `ip link set dev eth1 mtu {WORKER_OVERLAY_MTU}`) — got: {head}"
            )
    if missing:
        return False, "workers not fully on overlay (IP and/or MTU wrong)", "\n".join(missing)
    return True, f"all 8 workers carry 192.168.100.11..18/24 on eth1 at MTU {WORKER_OVERLAY_MTU}", None


def _check_worker_overlay_ping():
    """gpu1 (192.168.100.11) → gpu3 (192.168.100.13): cross-leaf overlay ping."""
    target = WORKER_OVERLAY_IP["gpu3"]
    rc, out = docker_exec("gpu1", ["ping", "-c", "2", "-W", "2", target], timeout=8)
    if rc == 0:
        return True, f"gpu1 → gpu3 overlay ping ({target}) OK — first east-west VXLAN packet", None
    return False, f"gpu1 → gpu3 overlay ping ({target}) failed", out


def _check_worker_full_mesh_overlay():
    """All 56 ordered worker-to-worker overlay pings (8 sources × 7 destinations)."""
    ok = 0
    fail = 0
    fails: list[str] = []
    for src in WORKERS:
        for dst in WORKERS:
            if src == dst:
                continue
            dst_ip = WORKER_OVERLAY_IP[dst]
            rc, _ = docker_exec(src, ["ping", "-c", "1", "-W", "2", "-q", dst_ip], timeout=5)
            if rc == 0:
                ok += 1
            else:
                fail += 1
                if len(fails) < 6:
                    fails.append(f"{src} -> {dst} ({dst_ip})")
    if fail == 0:
        return True, f"all {ok}/56 worker-to-worker overlay pings succeeded", None
    detail = f"{fail} failures (showing up to 6):\n  " + "\n  ".join(fails)
    return False, f"{ok}/56 overlay pings OK, {fail} failed", detail


def _run_allreduce(ranks: list[str], elements: int, iters: int) -> tuple[bool, str, str | None]:
    """Run an N-rank Gloo AllReduce across the named workers.

    ranks[0] is rank 0 (the rendezvous master at 192.168.100.<10+id>).
    Each rank is launched in parallel via `docker exec`; we wait for all
    to complete and verify every rank exited zero with the OK marker in
    its stdout.
    """
    if len(ranks) < 2:
        return False, "need at least 2 ranks for AllReduce", None
    master_ip = WORKER_OVERLAY_IP[ranks[0]]
    world = len(ranks)

    def _run_one(rank_idx: int, worker: str) -> tuple[str, int, str]:
        cmd = [
            "docker", "exec", worker,
            "python3", ALLREDUCE_SCRIPT_DST,
            "--rank", str(rank_idx),
            "--world-size", str(world),
            "--master", master_ip,
            "--port", str(RENDEZVOUS_PORT),
            "--elements", str(elements),
            "--iters", str(iters),
        ]
        try:
            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=120,
            )
            return worker, proc.returncode, proc.stdout.decode("utf-8", errors="replace")
        except subprocess.TimeoutExpired as e:
            partial = (e.stdout or b"").decode("utf-8", errors="replace")
            return worker, 124, f"timeout after 120s\n{partial}"

    results: list[tuple[str, int, str]] = []
    with ThreadPoolExecutor(max_workers=world) as pool:
        futures = {pool.submit(_run_one, i, w): w for i, w in enumerate(ranks)}
        for f in as_completed(futures, timeout=180):
            results.append(f.result())

    oks = [r for r in results if r[1] == 0 and " OK " in r[2]]
    if len(oks) == world:
        rank0_out = next((out for w, rc, out in results if w == ranks[0]), "")
        avg_line = next(
            (ln for ln in rank0_out.splitlines() if "OK" in ln and "avg=" in ln),
            "",
        )
        summary = f"{world}-rank AllReduce across {','.join(ranks)} OK"
        if avg_line:
            summary += f" — {avg_line.split('OK', 1)[1].strip()[:140]}"
        return True, summary, rank0_out[-1200:] or None

    fail_blocks = []
    for w, rc, out in results:
        if rc == 0 and " OK " in out:
            continue
        tail = "\n".join(out.splitlines()[-12:])
        fail_blocks.append(f"{w}: rc={rc}\n{tail}")
    return False, f"{world}-rank AllReduce failed ({len(oks)}/{world} ranks OK)", "\n---\n".join(fail_blocks)


def _check_allreduce_2rank():
    """Smallest collective spanning two leaves — gpu1 (leaf1) + gpu3 (leaf2)."""
    return _run_allreduce(["gpu1", "gpu3"], elements=50_000, iters=3)


def _check_allreduce_8rank():
    """Full 8-rank Gloo AllReduce across every GPU — the lab's headline result."""
    return _run_allreduce(WORKERS, elements=100_000, iters=3)


# ---- registry ---------------------------------------------------------------
CHECKPOINTS: list[tuple[str, str, callable]] = [
    ("leaf_bridge_members",      "Leaves attach worker ports (eth3+eth4) to VLAN 1000 bridge", _check_leaf_bridge_members),
    ("worker_overlay_ips",       "Workers carry 192.168.100.11..18/24 on eth1",                _check_worker_overlay_ips),
    ("worker_overlay_ping",      "gpu1 → gpu3 overlay ping (first east-west VXLAN packet)",    _check_worker_overlay_ping),
    ("worker_full_mesh_overlay", "Full 56/56 worker ping mesh over overlay",                   _check_worker_full_mesh_overlay),
    ("allreduce_2rank",          "Gloo AllReduce across 2 ranks (gpu1 + gpu3)",                _check_allreduce_2rank),
    ("allreduce_8rank",          "Gloo AllReduce across all 8 ranks",                          _check_allreduce_8rank),
]
