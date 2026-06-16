"""Kernel netdev counter exporter for Prometheus.

Why this exists: sonic-vs's OpenConfig surface does not bridge the clab
veths (eth1..eth4) to the synthetic SONiC Ethernet ports (Ethernet0/4/8/12)
— see ADR-008. gnmic-via-gNMI is still the streaming-telemetry teaching
surface for Lab 4, but it cannot give us per-link wire rates for the
links that traffic actually flows through. To make Grafana dashboards
fill with real data during AllReduce, the orchestrator polls
`/proc/net/dev` from each switch via `docker exec` on a tight loop and
exposes the result as Prometheus text-format counters.

Metric schema (counters, intentionally raw — Prom does rate()):
    aidc_netdev_rx_bytes_total{device, interface}
    aidc_netdev_tx_bytes_total{device, interface}
    aidc_netdev_rx_packets_total{device, interface}
    aidc_netdev_tx_packets_total{device, interface}

Only switches are scraped (eth1..eth4 carry fabric traffic). Workers are
omitted — Lab 4's headline is fabric-side visibility; if a future lab
needs worker-side flow data, sFlow is the right tool per ADR-007.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

from .dockerlib import docker_exec

SWITCHES = ["spine1", "spine2", "leaf1", "leaf2", "leaf3", "leaf4"]

# Cache the most recent scrape briefly so Prometheus's 5s scrape doesn't
# fan out 6 docker execs every 5s when nothing has changed in between
# (and so two near-simultaneous scrapes don't double-tax the daemon).
_CACHE_TTL_SECONDS = 3.0
_cache: dict[str, object] = {"ts": 0.0, "text": ""}


def _scrape_one(switch: str) -> list[tuple[str, str, int, int, int, int]]:
    """Return [(device, interface, rx_bytes, rx_pkts, tx_bytes, tx_pkts), ...].

    Empty list on failure — the exporter degrades gracefully (one wedged
    switch shouldn't take down all metrics).
    """
    rc, out = docker_exec(switch, ["cat", "/proc/net/dev"], timeout=3)
    if rc != 0:
        return []
    rows: list[tuple[str, str, int, int, int, int]] = []
    for line in out.splitlines()[2:]:
        parts = line.split()
        if len(parts) < 10 or not parts[0].endswith(":"):
            continue
        iface = parts[0].rstrip(":")
        if iface == "lo":
            continue
        try:
            rx_bytes = int(parts[1])
            rx_pkts = int(parts[2])
            tx_bytes = int(parts[9])
            tx_pkts = int(parts[10])
        except (IndexError, ValueError):
            continue
        rows.append((switch, iface, rx_bytes, rx_pkts, tx_bytes, tx_pkts))
    return rows


def _render(rows_per_switch: list[list[tuple[str, str, int, int, int, int]]]) -> str:
    lines: list[str] = []
    lines.append("# HELP aidc_netdev_rx_bytes_total Receive bytes from /proc/net/dev")
    lines.append("# TYPE aidc_netdev_rx_bytes_total counter")
    for rows in rows_per_switch:
        for dev, iface, rx_b, _, _, _ in rows:
            lines.append(f'aidc_netdev_rx_bytes_total{{device="{dev}",interface="{iface}"}} {rx_b}')
    lines.append("# HELP aidc_netdev_tx_bytes_total Transmit bytes from /proc/net/dev")
    lines.append("# TYPE aidc_netdev_tx_bytes_total counter")
    for rows in rows_per_switch:
        for dev, iface, _, _, tx_b, _ in rows:
            lines.append(f'aidc_netdev_tx_bytes_total{{device="{dev}",interface="{iface}"}} {tx_b}')
    lines.append("# HELP aidc_netdev_rx_packets_total Receive packets from /proc/net/dev")
    lines.append("# TYPE aidc_netdev_rx_packets_total counter")
    for rows in rows_per_switch:
        for dev, iface, _, rx_p, _, _ in rows:
            lines.append(f'aidc_netdev_rx_packets_total{{device="{dev}",interface="{iface}"}} {rx_p}')
    lines.append("# HELP aidc_netdev_tx_packets_total Transmit packets from /proc/net/dev")
    lines.append("# TYPE aidc_netdev_tx_packets_total counter")
    for rows in rows_per_switch:
        for dev, iface, _, _, _, tx_p in rows:
            lines.append(f'aidc_netdev_tx_packets_total{{device="{dev}",interface="{iface}"}} {tx_p}')
    return "\n".join(lines) + "\n"


def scrape() -> str:
    """Return Prometheus text-format metrics for all switch netdev counters."""
    now = time.monotonic()
    if isinstance(_cache["text"], str) and _cache["text"] and (now - float(_cache["ts"])) < _CACHE_TTL_SECONDS:
        return _cache["text"]  # type: ignore[return-value]
    with ThreadPoolExecutor(max_workers=len(SWITCHES)) as pool:
        rows_per_switch = list(pool.map(_scrape_one, SWITCHES))
    text = _render(rows_per_switch)
    _cache["ts"] = now
    _cache["text"] = text
    return text
