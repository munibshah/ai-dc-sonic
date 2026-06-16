"""
Lab 1 — Build the BGP Underlay. Checkpoints.

Each checkpoint is a zero-arg callable returning (passed, summary, detail).
The submit suite runs all checkpoints in order; passing every one stamps
the lab Passed.
"""

from __future__ import annotations

from ..dockerlib import docker_exec, vtysh, count_established


# Bootstrap from a blank fabric — the learner builds the underlay themselves.
# Solve = apply the working underlay (no overlay).
BOOTSTRAP_STATE = "_skeleton"
SOLVE_STATE = "_canonical"


# Expected interface IPs per spec (matches configs/frr/_canonical/).
SPINE1_IFACE_IPS = {
    "lo": "10.0.0.1/32",
    "eth1": "10.1.1.0/31",
    "eth2": "10.1.1.2/31",
    "eth3": "10.1.1.4/31",
    "eth4": "10.1.1.6/31",
}

# Worker fabric IPs (gpu<N>:eth1). Indexed by worker name.
WORKER_FABRIC_IP = {
    "gpu1": "10.2.1.1", "gpu2": "10.2.1.3",
    "gpu3": "10.2.2.1", "gpu4": "10.2.2.3",
    "gpu5": "10.2.3.1", "gpu6": "10.2.3.3",
    "gpu7": "10.2.4.1", "gpu8": "10.2.4.3",
}
WORKERS = list(WORKER_FABRIC_IP.keys())


# ---- helpers ----------------------------------------------------------------
def _addrs_on(switch: str, iface: str) -> list[str]:
    """Return CIDR strings on <iface> inside <switch> (from `ip -br -4 addr`)."""
    rc, out = docker_exec(switch, ["ip", "-br", "-4", "addr", "show", iface])
    if rc != 0:
        return []
    # output like: "eth1  UP  10.1.1.0/31"
    parts = out.split()
    return [p for p in parts if "/" in p]


# ---- checkpoint runners -----------------------------------------------------
def _check_spine1_underlay():
    """spine1 has lo + eth1..eth4 with the expected /31 addresses."""
    missing: list[str] = []
    wrong: list[str] = []
    for iface, expected in SPINE1_IFACE_IPS.items():
        addrs = _addrs_on("spine1", iface)
        if not addrs:
            missing.append(f"{iface} (expected {expected})")
        elif expected not in addrs:
            wrong.append(f"{iface}: has {addrs}, expected {expected}")
    if missing or wrong:
        bits = []
        if missing:
            bits.append("missing: " + ", ".join(missing))
        if wrong:
            bits.append("wrong: " + ", ".join(wrong))
        return False, "spine1 underlay incomplete", "\n".join(bits)
    return True, "spine1 lo + eth1..4 all have the expected /31 IPs", None


def _check_leaf1_to_spine1():
    """leaf1 ↔ spine1 BGP session Established, PfxRcd ≥ 1."""
    out = vtysh("leaf1", "show bgp summary")
    if not out:
        return False, "leaf1: `show bgp summary` returned nothing", None
    # Look for the line with neighbor 10.1.1.0 (spine1 end of the leaf1↔spine1 link).
    for line in out.splitlines():
        if "10.1.1.0" not in line and "spine1" not in line.lower():
            continue
        parts = line.split()
        if len(parts) >= 10 and parts[1] == "4":
            # State/PfxRcd is column 9 (0-indexed). int = Established with
            # that many prefixes received; string ("Active"/"Idle"/"Connect")
            # = not Established. Use col 9 (not col -1) so this works across
            # FRR 7.5 (last col = PfxSnt int) and FRR 10.4 (last col = Desc string).
            try:
                pfxrcd = int(parts[9])
            except ValueError:
                return False, f"leaf1↔spine1 not Established yet (state={parts[9]})", line
            if pfxrcd >= 1:
                return True, f"leaf1↔spine1 Established, PfxRcd={pfxrcd}", line
            return False, "leaf1↔spine1 Established but PfxRcd=0 (forgot `neighbor SPINES activate`?)", line
    return False, "leaf1 has no BGP neighbor for spine1 (10.1.1.0)", out[:400]


def _check_cross_leaf_via_spine1():
    """gpu1 can ping gpu3 (cross-leaf reachability proves leaf1+leaf2 BGP works)."""
    target = WORKER_FABRIC_IP["gpu3"]
    rc, out = docker_exec("gpu1", ["ping", "-c", "2", "-W", "2", target], timeout=8)
    if rc == 0:
        return True, f"gpu1 → gpu3 ({target}) OK", None
    return False, f"gpu1 cannot reach gpu3 ({target}) — leaf2 BGP not Established?", out


def _check_spine2_ecmp():
    """leaf1 has 2 next-hops to leaf2's loopback (10.0.1.2/32)."""
    out = vtysh("leaf1", "show ip route 10.0.1.2")
    if not out:
        return False, "leaf1: route lookup returned nothing", None
    # Count next-hop lines marked with '*' (active). They look like:
    #   * 10.1.1.0, via eth1, weight 1
    star_lines = [ln for ln in out.splitlines() if ln.strip().startswith("*")]
    if len(star_lines) >= 2:
        return True, f"leaf1 has {len(star_lines)} ECMP paths to leaf2 loopback", "\n".join(star_lines)
    if len(star_lines) == 1:
        return False, "only 1 path to leaf2 (no ECMP yet — spine2 down?)", "\n".join(star_lines) or out[:400]
    return False, "no route to 10.0.1.2 on leaf1", out[:400]


def _check_all_leaves_established():
    """leaf3 and leaf4 each have 2 BGP peers in Established state."""
    missing: list[str] = []
    for leaf in ("leaf3", "leaf4"):
        out = vtysh(leaf, "show bgp summary")
        est = count_established(out)
        if est < 2:
            missing.append(f"{leaf}: {est}/2 Established")
    if missing:
        return False, "remaining leaves not fully peered: " + "; ".join(missing), None
    return True, "leaf3 and leaf4 both have 2 spine peers Established", None


def _check_ping_mesh():
    """Pairwise ping across all 8 workers — expect 56/56 OK."""
    ok = 0
    fail = 0
    fails: list[str] = []
    for src in WORKERS:
        for dst in WORKERS:
            if src == dst:
                continue
            dst_ip = WORKER_FABRIC_IP[dst]
            rc, _ = docker_exec(src, ["ping", "-c", "1", "-W", "2", "-q", dst_ip], timeout=5)
            if rc == 0:
                ok += 1
            else:
                fail += 1
                if len(fails) < 6:
                    fails.append(f"{src} -> {dst} ({dst_ip})")
    if fail == 0:
        return True, f"all {ok}/56 worker-to-worker pings succeeded", None
    detail = f"{fail} failures (showing up to 6):\n  " + "\n  ".join(fails)
    return False, f"{ok}/56 pings OK, {fail} failed", detail


# ---- registry ---------------------------------------------------------------
# Order matters: it's the natural lab-guide progression and also drives the
# inline checkpoint-button placement in 01-exercise.md.
CHECKPOINTS: list[tuple[str, str, callable]] = [
    ("spine1_underlay",        "Spine 1 underlay (lo + ethN IPs)",                _check_spine1_underlay),
    ("leaf1_to_spine1",        "Leaf 1 ↔ Spine 1 BGP session",                    _check_leaf1_to_spine1),
    ("cross_leaf_via_spine1",  "Cross-leaf reachability via Spine 1 (gpu1↔gpu3)", _check_cross_leaf_via_spine1),
    ("spine2_ecmp",            "ECMP — Leaf 1 has 2 paths to Leaf 2",             _check_spine2_ecmp),
    ("all_leaves_established", "Leaf 3 and Leaf 4 fully peered",                  _check_all_leaves_established),
    ("ping_mesh",              "Full 56/56 worker ping mesh",                      _check_ping_mesh),
]
