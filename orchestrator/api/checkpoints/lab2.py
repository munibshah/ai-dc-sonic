"""
Lab 2 — Build the EVPN-VXLAN Overlay. Checkpoints.

Lab 2 starts from a healthy underlay (Lab 1's canonical config). The learner
sets up an L2 segment via SONiC CLI on each leaf:
    config vlan add 1000
    config interface ip add Vlan1000 192.168.100.<N>/24
    config vxlan add vtep 10.0.10.<N>
    config vxlan evpn_nvo add nvo1 vtep
    config vxlan map add vtep 1000 10100

then activates the BGP L2VPN-EVPN address family across the fabric in vtysh.
The result: a stretched L2 segment (VNI 10100, subnet 192.168.100.0/24)
reachable from every leaf — verified by leaf-to-leaf ping over the overlay.

Workers do not participate in the overlay in this lab; that comes in Lab 3.
Each leaf's `Vlan1000` interface gets a unique test IP in 192.168.100.0/24
(.1 .. .4) used for the verification ping mesh.

Each checkpoint is a zero-arg callable returning (passed, summary, detail).
"""

from __future__ import annotations

from ..dockerlib import docker_exec, vtysh


LEAVES = ["leaf1", "leaf2", "leaf3", "leaf4"]
SPINES = ["spine1", "spine2"]

# VTEP loopback IPs per leaf (already advertised by the canonical underlay).
LEAF_VTEP_IP = {
    "leaf1": "10.0.10.1",
    "leaf2": "10.0.10.2",
    "leaf3": "10.0.10.3",
    "leaf4": "10.0.10.4",
}

# Per-leaf overlay test IP on Vlan1000 (used for the leaf-to-leaf ping mesh
# that verifies the data plane).
LEAF_OVERLAY_IP = {
    "leaf1": "192.168.100.1",
    "leaf2": "192.168.100.2",
    "leaf3": "192.168.100.3",
    "leaf4": "192.168.100.4",
}

VNI = "10100"
VLAN_ID = "1000"
VLAN_IFACE = "Vlan1000"
VXLAN_TUNNEL_NAME = "vtep"
VXLAN_KERNEL_DEV = "vtep-1000"   # SONiC auto-names this <vxlan_name>-<vlan_id>


# Bootstrap from the healthy underlay; "solve" applies underlay + EVPN-VXLAN.
BOOTSTRAP_STATE = "_canonical"
SOLVE_STATE = "_overlay"


# ---- helpers ----------------------------------------------------------------
def _link_is_up(switch: str, iface: str) -> tuple[bool, str]:
    rc, out = docker_exec(switch, ["ip", "-br", "link", "show", iface])
    if rc != 0:
        return False, out
    tokens = out.split()
    is_up = len(tokens) >= 2 and tokens[1].upper() in ("UP", "UNKNOWN")
    return is_up, out


def _evpn_peer_established(switch: str, peer_ip: str) -> tuple[bool, str]:
    """True iff `show bgp l2vpn evpn summary` on <switch> shows <peer_ip> with an int PfxRcd."""
    out = vtysh(switch, "show bgp l2vpn evpn summary")
    if not out:
        return False, ""
    for line in out.splitlines():
        if peer_ip not in line:
            continue
        parts = line.split()
        # State/PfxRcd is column 9 (0-indexed) — int when Established, string
        # like "Active"/"Idle" when not. We use col 9 (not col -1) so this
        # works across FRR 7.5 (last col = PfxSnt, also int) and FRR 10.4
        # (last col = Desc, a string).
        if len(parts) < 10:
            return False, line
        try:
            int(parts[9])
            return True, line
        except ValueError:
            return False, line
    return False, out[:400]


# ---- checkpoint runners -----------------------------------------------------
def _check_bridges_up():
    """Every leaf has Vlan1000 + vtep-1000 up, VXLAN tunnel sourced from its VTEP IP."""
    missing: list[str] = []
    for leaf in LEAVES:
        vlan_up, _ = _link_is_up(leaf, VLAN_IFACE)
        if not vlan_up:
            missing.append(f"{leaf}: {VLAN_IFACE} down/missing")
            continue
        vx_up, _ = _link_is_up(leaf, VXLAN_KERNEL_DEV)
        if not vx_up:
            missing.append(f"{leaf}: {VXLAN_KERNEL_DEV} down/missing")
            continue
        # Confirm SONiC sees the tunnel with the right source IP.
        rc, tunnel_out = docker_exec(leaf, ["show", "vxlan", "tunnel"])
        want = LEAF_VTEP_IP[leaf]
        if rc != 0 or want not in tunnel_out or VNI not in tunnel_out:
            missing.append(f"{leaf}: `show vxlan tunnel` missing src {want} or VNI {VNI}")
    if missing:
        return False, "overlay primitives not ready on every leaf", "\n".join(missing)
    return True, f"{VLAN_IFACE} + {VXLAN_KERNEL_DEV} (VNI {VNI}) up on all 4 leaves via SONiC CLI", None


def _check_evpn_neighbors_up():
    """Every leaf↔spine BGP session is Established under L2VPN-EVPN AF."""
    spine_peers_from_leaf = {
        "leaf1": ("10.1.1.0", "10.1.2.0"),
        "leaf2": ("10.1.1.2", "10.1.2.2"),
        "leaf3": ("10.1.1.4", "10.1.2.4"),
        "leaf4": ("10.1.1.6", "10.1.2.6"),
    }
    missing: list[str] = []
    for leaf in LEAVES:
        for peer_ip in spine_peers_from_leaf[leaf]:
            ok, line = _evpn_peer_established(leaf, peer_ip)
            if not ok:
                missing.append(f"{leaf} → {peer_ip}: not Established under L2VPN-EVPN ({line.strip()[:80]})")
    if missing:
        return False, "EVPN sessions not all up", "\n".join(missing)
    return True, "all 8 leaf↔spine EVPN sessions Established", None


def _check_evpn_routes_learned():
    """leaf1's EVPN table contains each other leaf's VTEP route.

    In this lab those are Type-3 (inclusive-multicast) routes — one per VTEP —
    which build the BUM flood list. There are deliberately NO Type-2 (MAC)
    routes: the segment has no host MACs yet (just SVIs, and the SVI MAC isn't
    advertised), so FRR originates only Type-3. Type-2 routes arrive in Lab 3
    when the GPU workers attach. Matching on the VTEP IP catches the Type-3
    route (the VTEP IP is its NLRI key and its next-hop).
    """
    out = vtysh("leaf1", "show bgp l2vpn evpn")
    if not out:
        return False, "leaf1: `show bgp l2vpn evpn` returned nothing", None
    remote_vteps = [ip for sw, ip in LEAF_VTEP_IP.items() if sw != "leaf1"]
    seen = {ip: (ip in out) for ip in remote_vteps}
    missing = [ip for ip, ok in seen.items() if not ok]
    if missing:
        return False, f"leaf1 missing EVPN routes from VTEPs: {', '.join(missing)}", out[:600]
    return True, "leaf1 sees Type-3 (IMET) routes from leaf2, leaf3, leaf4", None


def _check_remote_vteps_learned():
    """leaf1 sees the other VTEPs in `show vxlan remotevtep` (SONiC-native data-plane view)."""
    rc, out = docker_exec("leaf1", ["show", "vxlan", "remotevtep"])
    if rc != 0:
        return False, f"leaf1: `show vxlan remotevtep` failed (rc={rc})", out
    # Fall back to FRR's view if SONiC's command returns nothing (e.g. swssconfig
    # hasn't synced kernel state into APP_DB yet — FRR's view is authoritative).
    remote_vteps = [ip for sw, ip in LEAF_VTEP_IP.items() if sw != "leaf1"]
    found = [ip for ip in remote_vteps if ip in out]
    if len(found) >= len(remote_vteps):
        return True, f"leaf1 sees all {len(remote_vteps)} remote VTEPs via `show vxlan remotevtep`", None
    # Fallback: ask FRR directly.
    frr_out = vtysh("leaf1", f"show evpn vni {VNI}")
    frr_found = [ip for ip in remote_vteps if ip in frr_out]
    if len(frr_found) >= len(remote_vteps):
        return True, f"leaf1 sees all {len(remote_vteps)} remote VTEPs via `show evpn vni {VNI}` (FRR view)", frr_out[:600]
    missing = [ip for ip in remote_vteps if ip not in found and ip not in frr_found]
    return False, f"leaf1 missing remote VTEPs: {', '.join(missing)}", (out + "\n---\n" + frr_out)[:800]


def _check_overlay_ping_pair():
    """leaf1 can ping leaf3's overlay IP via Vlan1000 — proves a tunnel actually carries traffic."""
    target = LEAF_OVERLAY_IP["leaf3"]
    rc, out = docker_exec("leaf1", ["ping", "-c", "2", "-W", "2", "-I", VLAN_IFACE, target], timeout=8)
    if rc == 0:
        return True, f"leaf1 → leaf3 overlay ping ({target}) OK", None
    return False, f"leaf1 → leaf3 overlay ping ({target}) failed — overlay not carrying traffic", out


def _check_overlay_full_mesh():
    """All 12 ordered leaf-to-leaf overlay pings (4 leaves × 3 others) succeed."""
    ok = 0
    fail = 0
    fails: list[str] = []
    for src in LEAVES:
        for dst in LEAVES:
            if src == dst:
                continue
            dst_ip = LEAF_OVERLAY_IP[dst]
            rc, _ = docker_exec(src, ["ping", "-c", "1", "-W", "2", "-I", VLAN_IFACE, "-q", dst_ip], timeout=5)
            if rc == 0:
                ok += 1
            else:
                fail += 1
                if len(fails) < 6:
                    fails.append(f"{src} → {dst} ({dst_ip})")
    if fail == 0:
        return True, f"all {ok}/12 leaf-to-leaf overlay pings succeeded", None
    detail = f"{fail} failures (showing up to 6):\n  " + "\n  ".join(fails)
    return False, f"{ok}/12 overlay pings OK, {fail} failed", detail


# ---- registry ---------------------------------------------------------------
# Order matters: it's the narrative arc of the lab and drives the inline
# checkpoint-button placement in lab2-exercise.md.
CHECKPOINTS: list[tuple[str, str, callable]] = [
    ("bridges_up",             "VLAN + VXLAN tunnel up on every leaf",        _check_bridges_up),
    ("evpn_neighbors_up",      "BGP EVPN sessions Established (leaf↔spine)",  _check_evpn_neighbors_up),
    ("evpn_routes_learned",    "Leaf1 learned each leaf's EVPN (Type-3) route", _check_evpn_routes_learned),
    ("remote_vteps_learned",   "Remote VTEPs visible to leaf1",               _check_remote_vteps_learned),
    ("overlay_ping_pair",      "Leaf1 → Leaf3 overlay ping (first packet)",   _check_overlay_ping_pair),
    ("overlay_full_mesh",      "12/12 leaf-to-leaf overlay pings",            _check_overlay_full_mesh),
]
