"""
Lab 5 — SRv6 uSID Transport + ECMP. Checkpoints.

Lab 5 starts from a fabric that is already dual-stacked (BOOTSTRAP_STATE =
`_srv6_skeleton`): the IPv4 underlay + EVPN-VXLAN overlay from Labs 1-4 are
carried forward untouched, and an IPv6 underlay has been pre-provisioned on top
— IPv6 /127s on every spine<->leaf link, an IPv6 BGP session per link, and each
leaf's uSID locator /48 (`fcbb:bb00:<leaf>::/48`) advertised with ECMP via both
spines. The IPv4 fabric is the "given"; the learner builds the SRv6 layer.

The learner's hands-on work, per leaf:
  1. Define the SRv6 uSID locator in FRR
     (`segment-routing / srv6 / locators / locator MAIN ... behavior usid`).
  2. Install the kernel endpoint behaviour — an End.DT6 seg6local route on a
     real device (`srv6end`, a dummy; a lo-bound seg6local route silently
     fails to attach), so the leaf decapsulates uSID traffic addressed to it.
  3. Install the headend — H.Encaps.Red routes that steer each remote leaf's
     service prefix (`fd00:100:<leaf>::/64`) into that leaf's uSID.

The result: leaf-to-leaf traffic rides an SRv6 uSID transport, and because the
outer destination (a remote locator /48) is reachable via both spines and Linux
derives the outer flow label from the inner flow, distinct flows spread per-flow
across spine1 + spine2 — the SRv6 analog of the VXLAN ECMP from Lab 4.

SOLVE_STATE = `_srv6` lays all of that down on every leaf.

Each checkpoint is a zero-arg callable returning (passed, summary, detail).
"""

from __future__ import annotations

import json

from ..dockerlib import count_established, docker_exec, vtysh

LEAVES = ["leaf1", "leaf2", "leaf3", "leaf4"]
SPINES = ["spine1", "spine2"]
WORKERS = [f"gpu{i}" for i in range(1, 9)]

# Same overlay IP scheme as Lab 3 / Lab 4 (gpu<N> -> 192.168.100.<10+N>) — used
# only by the Submit regression mesh to prove SRv6 didn't disturb the overlay.
WORKER_OVERLAY_IP = {f"gpu{i}": f"192.168.100.{10 + i}" for i in range(1, 9)}

# Per-leaf SRv6 identities.
LEAF_IDX = {f"leaf{n}": n for n in range(1, 5)}
LEAF_LOCATOR = {f"leaf{n}": f"fcbb:bb00:{n}::/48" for n in range(1, 5)}
LEAF_USID = {f"leaf{n}": f"fcbb:bb00:{n}:fe00::" for n in range(1, 5)}      # End.DT6 SID
LEAF_SERVICE = {f"leaf{n}": f"fd00:100:{n}::" for n in range(1, 5)}          # service /64 base
LEAF_SERVICE_HOST = {f"leaf{n}": f"fd00:100:{n}::1" for n in range(1, 5)}    # concrete host

# Expected BGP session count per switch (per address family):
#   spines see 4 leaves each, leaves see 2 spines each.
EXPECTED_ESTABLISHED = {
    "spine1": 4, "spine2": 4,
    "leaf1": 2, "leaf2": 2, "leaf3": 2, "leaf4": 2,
}

BOOTSTRAP_STATE = "_srv6_skeleton"
SOLVE_STATE = "_srv6"

# Lab 5 keeps the EVPN-VXLAN overlay (workers on 192.168.100.0/24) fully intact
# and reuses Lab 4's Grafana dashboard, so it reuses Lab 4's lifecycle hooks
# verbatim: pre_* enable the SONiC telemetry feature BEFORE overlay-setup runs
# (sequencing matters — see ADR/pitfall #15), and bootstrap_extra / solve_extra
# deliver the AllReduce asset, put all 8 workers back on the overlay, and nudge
# Grafana. The worker-overlay step is load-bearing: bootstrap_lab() universally
# resets workers to the /31 underlay first, so without it the Submit regression
# mesh (56 worker pings) fails. (No import cycle: lab4 doesn't import lab5.)
from . import lab4  # noqa: E402

pre_bootstrap_extra = lab4.pre_bootstrap_extra
pre_solve_extra = lab4.pre_solve_extra
bootstrap_extra = lab4.bootstrap_extra
solve_extra = lab4.solve_extra


# ---- helpers ----------------------------------------------------------------
def _established(sw: str, af: str) -> int:
    """Established peer count for one address family ('ipv4' or 'ipv6')."""
    return count_established(vtysh(sw, f"show bgp {af} unicast summary"))


def _route_active_nexthops(sw: str, prefix: str) -> list[str]:
    """Active nexthop IPs for `prefix` in <sw>'s IPv6 RIB, via JSON (no text parsing)."""
    out = vtysh(sw, f"show ipv6 route {prefix} json")
    if not out:
        return []
    try:
        routes = json.loads(out)
    except ValueError:
        return []
    entries: list[dict] = []
    for _prefix, recs in routes.items():
        if isinstance(recs, list):
            entries.extend(recs)
    if not entries:
        return []
    entry = next((e for e in entries if e.get("protocol") == "bgp"), entries[0])
    return [nh.get("ip", "?") for nh in entry.get("nexthops", []) if nh.get("active")]


def _ip6_route_show(sw: str, prefix: str) -> str:
    rc, out = docker_exec(sw, ["ip", "-6", "route", "show", prefix])
    return out if rc == 0 else ""


# ---- checkpoint runners -----------------------------------------------------
def _check_dualstack_underlay_healthy():
    """IPv4 and IPv6 underlay BGP are both healthy, and leaf1 reaches the other
    leaves' uSID locator /48s with 2 ECMP nexthops.

    This is the pre-provisioned starting line — the dual-stack underlay Labs 1-4
    plus the IPv6 plumbing this lab adds. If it's red, the SRv6 work can't be
    anchored, so fix the fabric (Reset) first.
    """
    failures: list[str] = []
    for sw, want in EXPECTED_ESTABLISHED.items():
        v4 = _established(sw, "ipv4")
        v6 = _established(sw, "ipv6")
        if v4 != want:
            failures.append(f"{sw}: {v4} IPv4 BGP Established (expected {want})")
        if v6 != want:
            failures.append(f"{sw}: {v6} IPv6 BGP Established (expected {want})")
    # ECMP reachability of remote locators from leaf1.
    for leaf in ("leaf2", "leaf3", "leaf4"):
        nh = _route_active_nexthops("leaf1", LEAF_LOCATOR[leaf])
        if len(nh) < 2:
            failures.append(
                f"leaf1 -> {LEAF_LOCATOR[leaf]} has {len(nh)} active nexthop(s) (expected 2 — one per spine)"
            )
    if failures:
        return False, "dual-stack underlay not healthy", "\n".join(failures)
    return True, "IPv4 + IPv6 BGP up on all 6 switches; leaf1 sees remote locators via 2-way ECMP", None


def _check_srv6_locators_configured():
    """Every leaf has defined its uSID locator MAIN in FRR (the SRv6 control
    plane). Verifies `show segment-routing srv6 locator` lists MAIN with the
    leaf's own /48 prefix.
    """
    missing: list[str] = []
    for leaf in LEAVES:
        out = vtysh(leaf, "show segment-routing srv6 locator")
        prefix = LEAF_LOCATOR[leaf]
        if "MAIN" not in out or prefix not in out:
            missing.append(f"{leaf}: locator MAIN ({prefix}) not present")
    if missing:
        return False, "uSID locators not defined on every leaf", "\n".join(missing)
    return True, "all 4 leaves expose locator MAIN (behavior uSID) with their /48", None


def _check_endpoint_sids_installed():
    """Every leaf has its End.DT6 endpoint programmed in the kernel — an
    `encap seg6local action End.DT6` route for its uSID, bound to a real device
    (not lo). This is what lets the leaf decapsulate uSID traffic addressed to
    it.
    """
    missing: list[str] = []
    for leaf in LEAVES:
        out = _ip6_route_show(leaf, LEAF_USID[leaf])
        if "encap seg6local" not in out or "End.DT6" not in out:
            missing.append(f"{leaf}: no End.DT6 seg6local route for {LEAF_USID[leaf]} (got: {out.strip()[:80] or 'nothing'})")
        elif " dev lo " in f" {out} ":
            missing.append(f"{leaf}: endpoint bound to lo — seg6local won't attach; use a real device (srv6end)")
    if missing:
        return False, "End.DT6 endpoints not installed on every leaf", "\n".join(missing)
    return True, "all 4 leaves decapsulate their uSID via End.DT6 on srv6end", None


def _check_headend_steering_installed():
    """Leaf1 has H.Encaps headend routes that steer the other leaves' service
    prefixes into uSID. Verifies the `encap seg6` routes for leaf2/3/4's
    fd00:100:<n>::/64 exist on leaf1.
    """
    missing: list[str] = []
    for leaf in ("leaf2", "leaf3", "leaf4"):
        prefix = f"{LEAF_SERVICE[leaf]}/64"
        out = _ip6_route_show("leaf1", prefix)
        if "encap seg6" not in out:
            missing.append(f"leaf1: no seg6 headend route for {prefix} (got: {out.strip()[:80] or 'nothing'})")
    if missing:
        return False, "headend steering not installed on leaf1", "\n".join(missing)
    return True, "leaf1 steers leaf2/leaf3/leaf4 service prefixes into uSID (H.Encaps.Red)", None


def _check_srv6_path_works():
    """leaf1 reaches a host behind leaf3 over the SRv6 uSID transport — proves
    headend (leaf1) + transit (spine) + End.DT6 decap (leaf3) + the symmetric
    return path all work end-to-end.

    Sourced from leaf1's own service host so leaf3's reply rides SRv6 back.
    """
    rc, out = docker_exec(
        "leaf1",
        ["ping6", "-c", "2", "-W", "2", "-I", LEAF_SERVICE_HOST["leaf1"], LEAF_SERVICE_HOST["leaf3"]],
        timeout=8,
    )
    if rc == 0:
        return True, f"leaf1 -> leaf3 over SRv6 uSID OK ({LEAF_SERVICE_HOST['leaf3']} via fcbb:bb00:3:fe00::)", None
    return False, "leaf1 -> leaf3 over SRv6 uSID failed — encap/transit/decap path not complete", out


def _check_submit_finale():
    """Submit finale: SRv6 uSID transport is up AND load-spreads, and the IPv4 /
    EVPN-VXLAN fabric is untouched.

    (a) ECMP capability: leaf1 reaches leaf3's locator via 2 nexthops.
    (b) Functional SRv6: leaf1 -> leaf3 over uSID pings.
    (c) Regression: the 56-pair worker overlay mesh still pings — the additive
        SRv6 layer didn't perturb VXLAN.
    """
    # (a) ECMP capability.
    nh = _route_active_nexthops("leaf1", LEAF_LOCATOR["leaf3"])
    if len(nh) < 2:
        return (
            False,
            f"leaf1 -> leaf3 locator has {len(nh)} ECMP nexthop(s) (expected 2)",
            "uSID traffic can't spread across both spines — check IPv6 BGP / maximum-paths",
        )

    # (b) Functional SRv6 path.
    path_ok, path_summary, path_detail = _check_srv6_path_works()
    if not path_ok:
        return False, f"SRv6 path broke: {path_summary}", path_detail

    # (c) Regression: worker overlay mesh.
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
        return False, f"SRv6 up but VXLAN regressed: {ok}/56 worker pings OK, {fail} failed", detail
    return True, f"SRv6 uSID ECMP up (2 spine paths) + {ok}/56 worker overlay mesh intact", None


# ---- registry ---------------------------------------------------------------
# Order matters: it's the narrative arc of the lab and drives the inline
# checkpoint-button placement in lab5-exercise.md.
CHECKPOINTS: list[tuple[str, str, callable]] = [
    ("dualstack_underlay_healthy", "Dual-stack underlay healthy — IPv4+IPv6 BGP, locators reachable via ECMP", _check_dualstack_underlay_healthy),
    ("srv6_locators_configured",   "uSID locators defined on all 4 leaves",                                     _check_srv6_locators_configured),
    ("endpoint_sids_installed",    "End.DT6 endpoints decapsulating on every leaf",                             _check_endpoint_sids_installed),
    ("headend_steering_installed", "Leaf1 steers remote service prefixes into uSID (headend)",                  _check_headend_steering_installed),
    ("srv6_path_works",            "Leaf1 → Leaf3 over the SRv6 uSID transport",                                _check_srv6_path_works),
    ("submit_finale",              "uSID ECMP across both spines + VXLAN mesh intact",                          _check_submit_finale),
]
