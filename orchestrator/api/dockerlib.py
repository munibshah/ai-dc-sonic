"""Tiny helpers around `docker exec` for the lab runner and checkpoint code."""

from __future__ import annotations

import re
import subprocess


def docker_exec(container: str, cmd: list[str], timeout: int = 10) -> tuple[int, str]:
    """Run `docker exec <container> <cmd>`. Returns (rc, combined_output)."""
    try:
        proc = subprocess.run(
            ["docker", "exec", container, *cmd],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return 124, f"timeout after {timeout}s"
    except FileNotFoundError:
        return 127, "docker binary not found"


def vtysh(container: str, cmd: str, timeout: int = 10) -> str:
    """Run `vtysh -c <cmd>` inside <container>. Returns stdout (empty on error)."""
    rc, out = docker_exec(container, ["vtysh", "-c", cmd], timeout=timeout)
    return out if rc == 0 else ""


def count_established(bgp_summary_output: str) -> int:
    """Count BGP peers in Established state from `show bgp summary` output.

    On FRR, an Established peer renders with its PfxRcd count in the
    State/PfxRcd column; non-Established peers render a state word
    (Active/Idle/Connect) in that spot. We detect Established by:
    row has ≥10 cols, col 1 == "4" (AFI version), and col 9
    (State/PfxRcd) parses as int.

    Col 9 (not col -1) is used so this works across FRR 7.5 (where the
    last col is PfxSnt, also int) and FRR 10.4 (which adds a trailing
    Desc col that is a string).
    """
    count = 0
    for line in bgp_summary_output.splitlines():
        if not line or line.startswith(("Neighbor", "Total", "BGP")):
            continue
        parts = line.split()
        if len(parts) < 10 or parts[1] != "4":
            continue
        try:
            int(parts[9])
            count += 1
        except ValueError:
            pass
    return count
