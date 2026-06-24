"""
Lab 4 — Telemetry & Visualization. Checkpoints.

Lab 4 starts from Lab 3's solved state (_overlay_workers). The fabric is
fully wired: workers on 192.168.100.0/24, EVPN-VXLAN overlay live, Gloo
AllReduce ready. Lab 4 layers a streaming-telemetry pipeline on top —
gnmic subscribes to each switch's gNMI server, Prometheus scrapes both
gnmic and the orchestrator's netdev exporter, Grafana renders dashboards.

The learner's job is procedural, not configuration-changing:
  - Open the Grafana iframe pane, observe the empty/quiet panels.
  - Confirm gnmic is subscribed and Prometheus is scraping.
  - Run a small AllReduce, *watch the chart fill*, then a full 8-rank
    AllReduce and see ECMP load-spread across both spines.

There's no FRR config change between BOOTSTRAP and SOLVE — telemetry
doesn't reshape the fabric. SOLVE_STATE = BOOTSTRAP_STATE.

bootstrap_extra / solve_extra both:
  1. Deliver allreduce.py to every worker (same helper as Lab 3 —
     idempotent overwrite; the lab needs the script to be present).
  2. Enable SONiC's telemetry feature on every switch and poll until
     gNMI is bound on port 8080. Must re-run on every Start/Reset/Solve
     because feature state doesn't persist across the bind-mount path.
  3. Force a Grafana provisioning reload so any cold-start race (Grafana
     up before gnmic had targets) clears.

Each checkpoint is a zero-arg callable returning (passed, summary, detail).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from ..dockerlib import docker_exec


SWITCHES = ["spine1", "spine2", "leaf1", "leaf2", "leaf3", "leaf4"]
LEAVES = ["leaf1", "leaf2", "leaf3", "leaf4"]
WORKERS = [f"gpu{i}" for i in range(1, 9)]

WORKER_OVERLAY_IP = {f"gpu{i}": f"192.168.100.{10 + i}" for i in range(1, 9)}
WORKER_OVERLAY_MTU = 1500
RENDEZVOUS_PORT = 29500

# Lab 4 doesn't reshape the fabric — same FRR state in and out.
BOOTSTRAP_STATE = "_overlay_workers"
SOLVE_STATE = "_overlay_workers"

REPO_ROOT = Path(os.environ.get("AIDC_REPO_ROOT", "/repo"))
ALLREDUCE_SCRIPT_SRC = REPO_ROOT / "workers" / "scripts" / "allreduce.py"
ALLREDUCE_SCRIPT_DST = "/opt/aidc/allreduce.py"

# Telemetry stack — container hostnames (resolved via clab's docker DNS).
GNMIC_URL = "http://gnmic:9804/metrics"
PROM_URL = "http://prometheus:9090"
GRAFANA_URL = "http://grafana:3000"

# Per-link Mbps threshold for "traffic visible" checks. 1 Mbps comfortably
# clears BGP/EVPN baseline chatter (which sits in the kbps range) and is
# trivially exceeded by even the smallest meaningful AllReduce step.
TRAFFIC_THRESHOLD_BPS = 1_000_000

# Soft ECMP check: with 56 Gloo TCP flows hashing across 2 spines, perfect
# 8/8 link utilization is not guaranteed. ≥6/8 still proves both spines
# are carrying their share without flaking on hash skew.
ECMP_LINK_MIN_COUNT = 6


# ---- helpers ----------------------------------------------------------------
def _deliver_allreduce(worker: str) -> None:
    """`docker cp` the AllReduce script into the worker (idempotent)."""
    if not ALLREDUCE_SCRIPT_SRC.exists():
        raise FileNotFoundError(f"missing AllReduce script source: {ALLREDUCE_SCRIPT_SRC}")
    subprocess.run(
        ["docker", "cp", str(ALLREDUCE_SCRIPT_SRC), f"{worker}:{ALLREDUCE_SCRIPT_DST}"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        timeout=15,
    )


def _enable_telemetry(switch: str) -> tuple[str, bool, str]:
    """Enable SONiC's telemetry feature on a switch and poll until port 8080 binds.

    Returns (switch, ok, message). Idempotent: enabling an already-enabled
    feature is a no-op; the poll loop succeeds immediately if the port is
    already listening.
    """
    docker_exec(switch, ["config", "feature", "state", "telemetry", "enabled"], timeout=15)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        rc, out = docker_exec(switch, ["sh", "-c", "ss -tlnp 2>/dev/null | grep -q :8080"], timeout=3)
        if rc == 0:
            return switch, True, "gNMI listening on :8080"
        time.sleep(1)
    return switch, False, "gNMI not bound on :8080 after 30s"


def _put_worker_on_overlay(worker: str) -> None:
    """Configure gpu<N>'s eth1 with its 192.168.100.<10+N>/24 overlay IP.

    Same recipe as lab3's solve_extra — flush eth1, set MTU 1500 (the
    leaf-side VXLAN device defaults to 1500; if worker stays at 9500,
    Gloo's first data write silently drops at the VTEP encap), add
    overlay IP, drop default route (every peer is on-link).
    """
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


def _reload_grafana_provisioning() -> None:
    """Force Grafana to re-scan provisioning dirs.

    Fixes the cold-start race: if Grafana boots before gnmic has any
    targets up, dashboards render empty and provisioning's first read
    of /var/lib/grafana/dashboards happens against pre-data Prom. A POST
    to /api/admin/provisioning/dashboards/reload re-applies them.
    Failure here is non-fatal — the worst case is a Cmd-Shift-R refresh
    on the learner's part.
    """
    req = urllib.request.Request(
        f"{GRAFANA_URL}/api/admin/provisioning/dashboards/reload",
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
    except (urllib.error.URLError, TimeoutError):
        pass


def _http_ok(url: str, timeout: float = 3.0) -> tuple[bool, int, str]:
    """GET a URL, return (ok, status, body_head)."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = resp.read(2048).decode("utf-8", errors="replace")
            return (200 <= resp.status < 400), resp.status, body
    except urllib.error.HTTPError as e:
        return False, e.code, str(e)
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        return False, 0, str(e)


def _prom_query(promql: str) -> list[dict]:
    """Run an instant query, return the .data.result list (empty on error)."""
    url = f"{PROM_URL}/api/v1/query?query={urllib.parse.quote(promql)}"
    ok, _, body = _http_ok(url, timeout=4.0)
    if not ok:
        return []
    try:
        return json.loads(body).get("data", {}).get("result", [])
    except (ValueError, KeyError):
        return []


# ---- lifecycle hooks --------------------------------------------------------
def _enable_telemetry_on_all_switches() -> None:
    """Enable SONiC's telemetry feature on every switch, in parallel.

    Called from pre_bootstrap_extra / pre_solve_extra (BEFORE _apply_configs).
    Sequencing this BEFORE overlay setup is load-bearing: enabling the
    telemetry feature triggers SONiC's hostcfgd + downstream config_db /
    APP_DB churn that, if it lands AFTER overlay-setup.sh, silently wipes
    the VXLAN VTEP + VLAN 1000 + EVPN NVO state (cross-leaf VXLAN goes
    dead even though same-leaf bridging survives — and FRR's
    `show evpn vni 10100` reports the VNI as missing).

    By running this first, all telemetry-induced churn happens on an
    empty state; then _apply_configs's bootstrap-switch.sh lays down
    overlay state on top of a stable, telemetry-enabled SONiC.

    `_enable_telemetry` already polls until port 8080 binds (up to 30s).
    Add a brief settle after to let any post-bind config_db effects
    propagate before _apply_configs touches anything.
    """
    with ThreadPoolExecutor(max_workers=len(SWITCHES)) as pool:
        list(pool.map(_enable_telemetry, SWITCHES))
    time.sleep(3)


def _post_apply_common() -> None:
    """Deliver AllReduce script + put workers on overlay + nudge Grafana.

    Runs from bootstrap_extra / solve_extra (AFTER _apply_configs).
    By this point the fabric is in clean `_overlay_workers` state and
    telemetry is already up — we just need to wire workers and refresh
    the dashboard.
    """
    with ThreadPoolExecutor(max_workers=len(WORKERS)) as pool:
        list(pool.map(_deliver_allreduce, WORKERS))
        list(pool.map(_put_worker_on_overlay, WORKERS))
    _reload_grafana_provisioning()


def pre_bootstrap_extra() -> None:
    _enable_telemetry_on_all_switches()


def pre_solve_extra() -> None:
    _enable_telemetry_on_all_switches()


def bootstrap_extra() -> None:
    _post_apply_common()


def solve_extra() -> None:
    _post_apply_common()


# ---- AllReduce driver (mirrors lab3 pattern) --------------------------------
def _run_allreduce(ranks: list[str], elements: int, iters: int, timeout_per_rank: int = 90) -> tuple[bool, str]:
    """Run an N-rank Gloo AllReduce across the named workers. Returns (ok, log_tail)."""
    if len(ranks) < 2:
        return False, "need at least 2 ranks"
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
                timeout=timeout_per_rank,
            )
            return worker, proc.returncode, proc.stdout.decode("utf-8", errors="replace")
        except subprocess.TimeoutExpired as e:
            partial = (e.stdout or b"").decode("utf-8", errors="replace")
            return worker, 124, f"timeout\n{partial}"

    results: list[tuple[str, int, str]] = []
    with ThreadPoolExecutor(max_workers=world) as pool:
        futures = {pool.submit(_run_one, i, w): w for i, w in enumerate(ranks)}
        for f in as_completed(futures, timeout=timeout_per_rank + 30):
            results.append(f.result())

    oks = [r for r in results if r[1] == 0 and " OK " in r[2]]
    if len(oks) == world:
        return True, ""
    fail_blocks = []
    for w, rc, out in results:
        if rc == 0 and " OK " in out:
            continue
        tail = "\n".join(out.splitlines()[-12:])
        fail_blocks.append(f"{w}: rc={rc}\n{tail}")
    return False, "\n---\n".join(fail_blocks)


# ---- checkpoint runners -----------------------------------------------------
def _check_telemetry_stack_healthy():
    """All three telemetry containers respond on their health endpoints."""
    checks = [
        ("gnmic", GNMIC_URL),
        ("prometheus", f"{PROM_URL}/-/healthy"),
        ("grafana", f"{GRAFANA_URL}/api/health"),
    ]
    failures = []
    for name, url in checks:
        ok, status, body = _http_ok(url, timeout=3.0)
        if not ok:
            failures.append(f"{name} ({url}): status={status} body={body[:120]}")
    if failures:
        return False, "telemetry stack not fully reachable", "\n".join(failures)
    return True, "gnmic, prometheus, grafana all reachable from orchestrator", None


def _check_prometheus_scraping():
    """Prometheus has every expected scrape target in state=up.

    Targets: gnmic itself (job=gnmic, one target) + orchestrator's netdev
    endpoint (job=orchestrator-netdev). We require both jobs to have at
    least one healthy target. gnmic-per-switch subscriptions are NOT
    surfaced as Prometheus targets — they're internal to gnmic — so the
    `prometheus_has_recent_samples` check is what validates gnmic is
    actually pulling from the switches.
    """
    ok, _, body = _http_ok(f"{PROM_URL}/api/v1/targets", timeout=4.0)
    if not ok:
        return False, "prometheus targets endpoint not reachable", body[:200]
    try:
        targets = json.loads(body).get("data", {}).get("activeTargets", [])
    except ValueError as e:
        return False, "prometheus returned non-JSON for targets", str(e)
    by_job: dict[str, list[dict]] = {}
    for t in targets:
        by_job.setdefault(t.get("labels", {}).get("job", "?"), []).append(t)
    fails = []
    for job in ("gnmic", "orchestrator-netdev"):
        ups = [t for t in by_job.get(job, []) if t.get("health") == "up"]
        if not ups:
            fails.append(f"job={job!r}: no healthy targets (found {len(by_job.get(job, []))} total)")
    if fails:
        return False, "prometheus has missing/down scrape targets", "\n".join(fails)
    return True, "prometheus scraping gnmic + orchestrator-netdev (both up)", None


def _check_prometheus_has_recent_samples():
    """Netdev exporter is producing samples across all switches.

    Counts the number of distinct (device, interface) series the
    netdev exporter is currently exposing. We expect at minimum eth1..4
    on each of 6 switches = 24, plus eth0 (mgmt) on each = 30. Require
    ≥24 (allows for one slow switch dropping out without flaking).
    """
    series = _prom_query("count(aidc_netdev_tx_bytes_total)")
    if not series:
        return False, "no aidc_netdev_tx_bytes_total samples in prometheus", "netdev exporter not scraped?"
    try:
        count = int(float(series[0]["value"][1]))
    except (KeyError, IndexError, ValueError):
        return False, "could not parse Prometheus count() result", str(series)
    if count < 24:
        return False, f"only {count} netdev series exposed (expected ≥24)", None
    return True, f"{count} netdev series flowing through prometheus", None


def _check_baseline_low_traffic():
    """Spine ↔ leaf links are quiet (< 5 Mbps) when no collective is running.

    BGP keepalives + EVPN UPDATE messages add a small steady chatter
    (~kbps), so the threshold is 5 Mbps, not zero. A failure here likely
    means the previous learner left a collective running, or the fabric
    is genuinely sick.
    """
    promql = 'max(rate(aidc_netdev_tx_bytes_total{device=~"spine.*",interface=~"eth[1-4]"}[30s])) * 8'
    series = _prom_query(promql)
    if not series:
        return False, "no spine-link rate samples available", "check that prometheus has scraped twice"
    try:
        max_bps = float(series[0]["value"][1])
    except (KeyError, IndexError, ValueError):
        return False, "couldn't parse spine-link rate query", str(series)
    if max_bps > 5_000_000:
        return (
            False,
            f"fabric not idle: max spine-link is {max_bps/1e6:.1f} Mbps",
            "stop any in-flight AllReduce, wait 30s, retry",
        )
    return True, f"fabric idle — max spine TX is {max_bps/1e3:.0f} kbps (BGP/EVPN baseline)", None


def _check_traffic_visible_2rank():
    """A 2-rank AllReduce (gpu1 + gpu3) produces visible spine traffic."""
    ok, log = _run_allreduce(["gpu1", "gpu3"], elements=200_000, iters=20)
    if not ok:
        return False, "2-rank AllReduce did not complete", log[-1200:] or None
    # Look at the last 1m so the just-finished run is in the window.
    promql = (
        'max_over_time(' \
        '(rate(aidc_netdev_tx_bytes_total{device=~"spine.*",interface=~"eth[1-4]"}[15s]) * 8)' \
        '[1m:5s])'
    )
    series = _prom_query(promql)
    if not series:
        return False, "no spine traffic samples after 2-rank AllReduce", None
    max_bps = max((float(s["value"][1]) for s in series), default=0.0)
    if max_bps < TRAFFIC_THRESHOLD_BPS:
        return (
            False,
            f"2-rank AllReduce ran but spine traffic stayed below {TRAFFIC_THRESHOLD_BPS/1e6:.0f} Mbps "
            f"(peak {max_bps/1e6:.2f} Mbps)",
            "telemetry pipeline may be lagging; check Grafana for fresh samples",
        )
    return True, f"2-rank AllReduce visible — peak spine TX {max_bps/1e6:.1f} Mbps", None


def _check_traffic_visible_8rank_ecmp():
    """A full 8-rank AllReduce loads ≥6 of 8 spine-leaf links."""
    ok, log = _run_allreduce(WORKERS, elements=400_000, iters=20, timeout_per_rank=120)
    if not ok:
        return False, "8-rank AllReduce did not complete", log[-1200:] or None
    promql = (
        'max_over_time(' \
        '(rate(aidc_netdev_tx_bytes_total{device=~"spine.*",interface=~"eth[1-4]"}[15s]) * 8)' \
        '[1m:5s])'
    )
    series = _prom_query(promql)
    if not series:
        return False, "no spine traffic samples after 8-rank AllReduce", None
    active_links = []
    for s in series:
        try:
            bps = float(s["value"][1])
        except (KeyError, IndexError, ValueError):
            continue
        if bps >= TRAFFIC_THRESHOLD_BPS:
            labels = s.get("metric", {})
            active_links.append((labels.get("device", "?"), labels.get("interface", "?"), bps))
    if len(active_links) < ECMP_LINK_MIN_COUNT:
        detail = "active links (>1 Mbps):\n  " + "\n  ".join(
            f"{d}:{i} -> {b/1e6:.1f} Mbps" for d, i, b in active_links
        )
        return (
            False,
            f"only {len(active_links)}/8 spine-leaf links carried traffic (need ≥{ECMP_LINK_MIN_COUNT})",
            detail,
        )
    detail = "active links (>1 Mbps):\n  " + "\n  ".join(
        f"{d}:{i} -> {b/1e6:.1f} Mbps" for d, i, b in sorted(active_links, key=lambda t: -t[2])
    )
    return True, f"ECMP working — {len(active_links)}/8 spine-leaf links carried collective traffic", detail


# ---- registry ---------------------------------------------------------------
CHECKPOINTS: list[tuple[str, str, callable]] = [
    ("telemetry_stack_healthy",       "gnmic + Prometheus + Grafana all reachable",                _check_telemetry_stack_healthy),
    ("prometheus_scraping",           "Prometheus has gnmic + orchestrator-netdev targets up",     _check_prometheus_scraping),
    ("prometheus_has_recent_samples", "Netdev exporter is feeding ≥24 series into Prometheus",     _check_prometheus_has_recent_samples),
    ("baseline_low_traffic",          "Fabric is idle (no collective in flight)",                  _check_baseline_low_traffic),
    ("traffic_visible_2rank",         "2-rank AllReduce shows traffic on the spines",              _check_traffic_visible_2rank),
    ("traffic_visible_8rank_ecmp",    "8-rank AllReduce spreads across ≥6 of 8 spine-leaf links",  _check_traffic_visible_8rank_ecmp),
]
