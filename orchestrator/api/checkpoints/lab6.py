"""
Lab 6 — Super Spines (conceptual). Checkpoints.

Lab 6 is a conceptual lab. The learner reads the guide, runs a few
inspection commands against the existing 2-tier fabric, and walks away
understanding *why* hyperscalers add a super-spine tier — the scale math
(radix-bounded pod ceiling), the shape of 3-tier BGP, the fault-domain
isolation story. No super-spine containers are deployed; the platform's
existing 2-spine / 4-leaf / 8-worker fabric is the surface to discuss
against. See ADR-013 for the rationale on teaching this conceptually
rather than deploying.

Fabric state in == fabric state out. BOOTSTRAP_STATE == SOLVE_STATE ==
`_overlay_workers` — the Lab-3-solved state Lab 4 also runs against. No
bootstrap_extra / solve_extra hooks are needed; everything is already up
from the prior lab's run, and `_apply_configs("_overlay_workers")` is
idempotent.

The four checkpoints are inspection-only — they verify properties of the
healthy starting fabric that anchor the guide's conceptual content. They
pass against any healthy fabric, so clicking Check ▸ is "narrative
confirmation" (the moment the guide says "you've now observed this") more
than "did the learner configure X correctly." The Submit finale is a
56-pair worker ping mesh — a regression guard that the conceptual walk
didn't perturb fabric state.

Each checkpoint is a zero-arg callable returning (passed, summary, detail).
"""

from __future__ import annotations

import json

from ..dockerlib import count_established, docker_exec, vtysh


LEAVES = ["leaf1", "leaf2", "leaf3", "leaf4"]
SPINES = ["spine1", "spine2"]
WORKERS = [f"gpu{i}" for i in range(1, 9)]

# Same overlay IP scheme as Lab 3 / Lab 4 (gpu<N> -> 192.168.100.<10+N>).
WORKER_OVERLAY_IP = {f"gpu{i}": f"192.168.100.{10 + i}" for i in range(1, 9)}

# Leaf VTEP loopbacks, already advertised by the underlay. Used to verify
# per-pod ECMP from leaf1's perspective.
LEAF_VTEP_IP = {f"leaf{n}": f"10.0.10.{n}" for n in range(1, 5)}

# Expected BGP session count per switch in `_overlay_workers` state:
#   spines see 4 leaves each, leaves see 2 spines each.
EXPECTED_ESTABLISHED = {
    "spine1": 4, "spine2": 4,
    "leaf1": 2, "leaf2": 2, "leaf3": 2, "leaf4": 2,
}

# Lab 6 doesn't reshape the fabric — same FRR state in and out.
BOOTSTRAP_STATE = "_overlay_workers"
SOLVE_STATE = "_overlay_workers"

# bootstrap_lab() universally resets the workers to their /31 underlay first, so
# reuse Lab 4's hooks to put the 8 workers back on 192.168.100.0/24. Without it,
# the Submit ping-mesh finale (56 worker pings) fails after a Start/Reset on this
# lab — it would only pass when arriving from a prior lab with workers already on
# the overlay. (No import cycle: lab4 doesn't import lab6.)
from . import lab4  # noqa: E402

bootstrap_extra = lab4.bootstrap_extra
solve_extra = lab4.solve_extra


# ---- checkpoint runners -----------------------------------------------------
def _check_fabric_healthy_two_tier():
    """Every switch shows its expected number of Established BGP sessions.

    Spines: 4 (one per leaf). Leaves: 2 (one per spine). This is the
    starting line for the conceptual lab — if anything's broken here,
    the rest of the discussion can't be anchored against the fabric.

    Queries `show bgp ipv4 unicast summary` (scoped to one AF). The
    default `show bgp summary` prints ipv4 unicast AND l2vpn evpn blocks
    on `_overlay_workers`, so `count_established` over that combined
    output double-counts every neighbor. Per-AF view yields one row per
    physical session.
    """
    failures: list[str] = []
    for sw, want in EXPECTED_ESTABLISHED.items():
        out = vtysh(sw, "show bgp ipv4 unicast summary")
        if not out:
            failures.append(f"{sw}: `show bgp ipv4 unicast summary` returned nothing")
            continue
        got = count_established(out)
        if got != want:
            failures.append(f"{sw}: {got} Established (expected {want})")
    if failures:
        return False, "fabric not in healthy 2-tier state", "\n".join(failures)
    return True, "all 6 switches show expected Established peers (spines: 4, leaves: 2)", None


def _check_spine_fanout_observed():
    """spine1 has 4 Established leaf sessions — the pod's spine fan-out today.

    This is what the guide's "scale math" section is anchored to: spine1's
    physical-port count caps how many leaves a single pod can hold. With
    4 leaves wired and (in this image) 4 fabric-facing ports, the pod is
    at its leaf-radix limit — adding a 5th leaf needs either bigger spines
    or a super-spine tier.

    Same per-AF scoping as `_check_fabric_healthy_two_tier`.
    """
    out = vtysh("spine1", "show bgp ipv4 unicast summary")
    if not out:
        return False, "spine1: `show bgp ipv4 unicast summary` returned nothing", None
    n = count_established(out)
    if n != 4:
        return (
            False,
            f"spine1 sees {n} Established peers (expected 4 leaves)",
            "leaf↔spine session(s) may have dropped; run Reset and re-check",
        )
    return True, "spine1 fans out to 4 leaves — pod's current leaf-radix limit", None


def _check_per_pod_ecmp_observed():
    """leaf1 reaches leaf3's VTEP via 2 ECMP nexthops (one per spine).

    The guide's "ECMP today, and what a 3rd tier extends it to" point.
    `show ip route ... json` is the cleanest way to count nexthops without
    text-parsing — the route entry's `nexthops` array has one element per
    ECMP path.
    """
    out = vtysh("leaf1", f"show ip route {LEAF_VTEP_IP['leaf3']} json")
    if not out:
        return False, f"leaf1: `show ip route {LEAF_VTEP_IP['leaf3']} json` returned nothing", None
    try:
        routes = json.loads(out)
    except ValueError as e:
        return False, "leaf1: route JSON did not parse", f"{e}\n{out[:400]}"
    # FRR's JSON shape: { "<prefix>": [ { "nexthops": [ {...}, {...} ], ... } ] }
    entries = []
    for prefix, recs in routes.items():
        if isinstance(recs, list):
            entries.extend(recs)
    if not entries:
        return False, f"leaf1 has no route to {LEAF_VTEP_IP['leaf3']}", out[:400]
    # Pick the BGP-installed entry if multiple sources exist; fall back to first.
    bgp_entry = next((e for e in entries if e.get("protocol") == "bgp"), entries[0])
    nexthops = [nh for nh in bgp_entry.get("nexthops", []) if nh.get("active")]
    if len(nexthops) < 2:
        ips = ", ".join(nh.get("ip", "?") for nh in nexthops) or "<none>"
        return (
            False,
            f"leaf1 → leaf3 VTEP has {len(nexthops)} active nexthop(s) — expected 2",
            f"active nexthops: {ips}\n(if 1, check both spine sessions are Established)",
        )
    via = ", ".join(nh.get("ip", "?") for nh in nexthops[:2])
    return True, f"leaf1 → {LEAF_VTEP_IP['leaf3']} via 2 ECMP nexthops ({via})", None


def _check_submit_finale_ping_mesh_intact():
    """The 56-pair worker mesh still pings — Lab 6 didn't disturb anything.

    Conceptual lab regression guard. If this fails, something else broke
    the overlay between Lab 5 and Lab 6 (it can't be us — we don't touch
    fabric state). Also re-runs checkpoints 1-3 so a Submit ✓ captures
    every observable in one place.
    """
    base_passed, base_summary, base_detail = _check_fabric_healthy_two_tier()
    if not base_passed:
        return False, f"baseline broke: {base_summary}", base_detail

    fanout_passed, fanout_summary, fanout_detail = _check_spine_fanout_observed()
    if not fanout_passed:
        return False, f"spine fan-out broke: {fanout_summary}", fanout_detail

    ecmp_passed, ecmp_summary, ecmp_detail = _check_per_pod_ecmp_observed()
    if not ecmp_passed:
        return False, f"per-pod ECMP broke: {ecmp_summary}", ecmp_detail

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
    if fail:
        detail = f"{fail} failures (showing up to 6):\n  " + "\n  ".join(fails)
        return False, f"{ok}/56 worker mesh pings OK, {fail} failed", detail
    return True, f"{ok}/56 worker mesh pings OK — fabric unchanged by the conceptual walk", None


# ---- registry ---------------------------------------------------------------
CHECKPOINTS: list[tuple[str, str, callable]] = [
    ("fabric_healthy_two_tier",        "2-tier fabric healthy — starting line for conceptual exploration", _check_fabric_healthy_two_tier),
    ("spine_fanout_observed",          "Spine1 fans out to 4 leaves — the pod's leaf-radix ceiling today", _check_spine_fanout_observed),
    ("per_pod_ecmp_observed",          "leaf1 → leaf3 VTEP via 2 spine-ECMP paths",                        _check_per_pod_ecmp_observed),
    ("submit_finale_ping_mesh_intact", "56-pair worker mesh still healthy — Lab 6 didn't disturb fabric",  _check_submit_finale_ping_mesh_intact),
]
