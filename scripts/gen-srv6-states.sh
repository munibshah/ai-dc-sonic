#!/usr/bin/env bash
# One-shot generator for Lab 5 (SRv6 uSID) FRR state directories.
#
#   configs/frr/_srv6_skeleton/  — BOOTSTRAP state: _overlay_workers + IPv6
#                                  dual-stack underlay + IPv6 BGP advertising
#                                  per-leaf uSID locator /48s (ECMP via both
#                                  spines). NO SRv6 dataplane yet — the learner
#                                  builds locators + endpoints + headend.
#   configs/frr/_srv6/           — SOLVE state: skeleton + FRR uSID locator
#                                  blocks + kernel End.DT6 endpoints + headend
#                                  steering. The full worked answer.
#
# IPv4 underlay + EVPN-VXLAN are carried forward verbatim from _overlay_workers;
# everything SRv6 is strictly additive (dual-stack). Re-runnable / idempotent:
# it overwrites the two target dirs from scratch each time.
#
# Addressing (see docs/lab-guide/lab5-overview.md):
#   v6 link /127s : fc00:<spine>:<leaf>::/127   spine=::0  leaf=::1
#   uSID locator  : fcbb:bb00:<leaf>::/48       (block-len 32, node-len 16)
#   End.DT6 SID   : fcbb:bb00:<leaf>:fe00::     (bound to the srv6end dummy)
#   service dest  : fd00:100::<leaf>/128        (the "host behind the leaf")
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/configs/frr/_overlay_workers"
SKEL="$ROOT/configs/frr/_srv6_skeleton"
SOLVE="$ROOT/configs/frr/_srv6"

rm -rf "$SKEL" "$SOLVE"
for sw in spine1 spine2 leaf1 leaf2 leaf3 leaf4; do
  mkdir -p "$SKEL/$sw" "$SOLVE/$sw"
done

# ---- spine IPv6 block (transit only; relays leaf locators, no /48 of its own)
spine_v6_iface() {  # $1=spine_idx
  local s="$1"
  cat <<EOF
!
! ---- SRv6 dual-stack: IPv6 underlay on the leaf-facing links (Lab 5) ----
interface eth1
 ipv6 address fc00:${s}:1::/127
!
interface eth2
 ipv6 address fc00:${s}:2::/127
!
interface eth3
 ipv6 address fc00:${s}:3::/127
!
interface eth4
 ipv6 address fc00:${s}:4::/127
EOF
}

spine_v6_bgp() {  # $1=spine_idx
  local s="$1"
  cat <<EOF
 !
 ! ---- IPv6 underlay BGP: relay the leaves' uSID locator /48s (Lab 5) ----
 neighbor LEAVES6 peer-group
 neighbor LEAVES6 advertisement-interval 0
 neighbor LEAVES6 timers 3 9
 neighbor fc00:${s}:1::1 remote-as 65101
 neighbor fc00:${s}:1::1 peer-group LEAVES6
 neighbor fc00:${s}:1::1 description leaf1-v6
 neighbor fc00:${s}:2::1 remote-as 65102
 neighbor fc00:${s}:2::1 peer-group LEAVES6
 neighbor fc00:${s}:2::1 description leaf2-v6
 neighbor fc00:${s}:3::1 remote-as 65103
 neighbor fc00:${s}:3::1 peer-group LEAVES6
 neighbor fc00:${s}:3::1 description leaf3-v6
 neighbor fc00:${s}:4::1 remote-as 65104
 neighbor fc00:${s}:4::1 peer-group LEAVES6
 neighbor fc00:${s}:4::1 description leaf4-v6
 !
 address-family ipv6 unicast
  maximum-paths 64
  neighbor LEAVES6 activate
  neighbor LEAVES6 soft-reconfiguration inbound
 exit-address-family
EOF
}

# ---- leaf IPv6 blocks
leaf_v6_iface() {  # $1=leaf_idx
  local l="$1"
  cat <<EOF
!
! ---- SRv6 dual-stack: IPv6 on the spine uplinks (Lab 5) ----
! The per-leaf "service" prefix fd00:100:${l}::/64 (the hosts behind this leaf)
! is installed as a local route by overlay-setup.sh, not here.
interface eth1
 ipv6 address fc00:1:${l}::1/127
!
interface eth2
 ipv6 address fc00:2:${l}::1/127
EOF
}

leaf_v6_bgp() {  # $1=leaf_idx
  local l="$1"
  cat <<EOF
 !
 ! ---- IPv6 underlay BGP: advertise this leaf's uSID locator /48 (Lab 5) ----
 ! maximum-paths 64 installs BOTH spine paths => uSID traffic ECMPs per-flow.
 ! no network import-check: the locator /48 is anchored by a blackhole static
 ! (unreachable next-hop), so without this FRR marks the network-originated
 ! prefix "invalid" and never advertises it. This is the standard knob for
 ! originating an aggregate/anchor prefix.
 no bgp network import-check
 neighbor SPINES6 peer-group
 neighbor SPINES6 remote-as 65000
 neighbor SPINES6 advertisement-interval 0
 neighbor SPINES6 timers 3 9
 neighbor fc00:1:${l}::0 peer-group SPINES6
 neighbor fc00:1:${l}::0 description spine1-v6
 neighbor fc00:2:${l}::0 peer-group SPINES6
 neighbor fc00:2:${l}::0 description spine2-v6
 !
 address-family ipv6 unicast
  network fcbb:bb00:${l}::/48
  maximum-paths 64
  neighbor SPINES6 activate
  neighbor SPINES6 soft-reconfiguration inbound
 exit-address-family
EOF
}

# The `network fcbb:bb00:L::/48` statement needs a matching RIB route to
# advertise. A blackhole static provides it deterministically (the more-specific
# End.DT6 SID /128 the learner installs overrides the blackhole for real
# traffic). This keeps locator REACHABILITY pre-provisioned (Lab-1 style) so the
# learner's focus is the SRv6 layer, not IPv6 plumbing.
leaf_v6_blackhole() {  # $1=leaf_idx
  local l="$1"
  cat <<EOF
!
ipv6 route fcbb:bb00:${l}::/48 blackhole
EOF
}

# ---- FRR SRv6 locator block (SOLVE only) ----
leaf_srv6_locator() {  # $1=leaf_idx
  local l="$1"
  cat <<EOF
!
! ---- SRv6 uSID locator (Lab 5 SOLVE) ----
! behavior usid => compressed micro-SIDs. block-len 32 + node-len 16 = a /48
! locator; shown under: show segment-routing srv6 locator
segment-routing
 srv6
  locators
   locator MAIN
    prefix fcbb:bb00:${l}::/48 block-len 32 node-len 16
    behavior usid
   exit
   !
  exit
  !
 exit
 !
exit
EOF
}

# Build one frr.conf: base (minus trailing "line vty"/EOF marker) + v6 iface +
# [locator] + base bgp gets the v6 bgp spliced in before its closing.
build_frr() {  # $1=sw  $2=skel|solve
  local sw="$1" mode="$2"
  local idx kind
  case "$sw" in
    spine1) kind=spine; idx=1;;
    spine2) kind=spine; idx=2;;
    leaf1) kind=leaf; idx=1;;
    leaf2) kind=leaf; idx=2;;
    leaf3) kind=leaf; idx=3;;
    leaf4) kind=leaf; idx=4;;
  esac

  local base="$SRC/$sw/frr.conf"
  # Everything up to and including the EVPN exit-address-family / the router bgp
  # block: we append the v6 BGP just before the final "!\nline vty". Strategy:
  # take the base file, drop its trailing "line vty\n!" footer, append v6 bgp
  # inside router bgp is messy with text tools, so instead we put the v6 BGP as
  # ADDITIONAL statements in a second `router bgp <asn>` stanza — FRR merges
  # stanzas of the same ASN. That keeps generation simple and the merge is
  # exactly how vtysh -b assembles it.
  local asn
  asn=$(grep -m1 '^router bgp' "$base" | awk '{print $3}')

  {
    cat "$base"
    echo "!"
    echo "! ============ Lab 5: SRv6 uSID dual-stack additions ============"
    if [ "$kind" = spine ]; then
      spine_v6_iface "$idx"
    else
      leaf_v6_iface "$idx"
      leaf_v6_blackhole "$idx"
      if [ "$mode" = solve ]; then
        leaf_srv6_locator "$idx"
      fi
    fi
    echo "!"
    echo "router bgp $asn"
    if [ "$kind" = spine ]; then
      spine_v6_bgp "$idx"
    else
      leaf_v6_bgp "$idx"
    fi
    echo "!"
  } > "$1tmp"
  mv "$1tmp" "$( [ "$mode" = skel ] && echo "$SKEL/$sw/frr.conf" || echo "$SOLVE/$sw/frr.conf" )"
}

for sw in spine1 spine2 leaf1 leaf2 leaf3 leaf4; do
  build_frr "$sw" skel
  build_frr "$sw" solve
done

# ---- overlay-setup.sh: leaves keep the VXLAN setup verbatim; SOLVE leaves also
#      build the SRv6 dataplane (endpoint + headend). Spines: no overlay-setup.
# Service-prefix block, pre-provisioned in BOTH states (the "hosts behind this
# leaf"): a local /64 so the leaf answers any address in it — giving the ECMP
# demo many distinct inner flows (each a different flow label => spreads across
# spines). It's a `local` route (table 255 is always consulted on input, so the
# End.DT6-decapsulated inner packet is delivered).
leaf_service_block() {  # $1=leaf_idx
  local l="$1"
  cat <<EOF

# ---- SRv6 service prefix (Lab 5): the hosts behind leaf${l} ----
# fd00:100:${l}::1 is a concrete host (a stable source/identity address you can
# ping FROM); the local /64 makes the leaf answer every address in the range, so
# pinging fd00:100:${l}::1..N gives the ECMP demo many distinct inner flows.
ip -6 route replace local fd00:100:${l}::/64 dev lo
ip -6 addr replace fd00:100:${l}::1/128 dev lo
EOF
}

for l in 1 2 3 4; do
  sw="leaf$l"
  # SKELETON = VXLAN block (verbatim) + the local service prefix.
  { cat "$SRC/$sw/overlay-setup.sh"; leaf_service_block "$l"; } > "$SKEL/$sw/overlay-setup.sh"
  # SOLVE = skeleton + SRv6 dataplane (endpoint + headend).
  {
    cat "$SRC/$sw/overlay-setup.sh"
    leaf_service_block "$l"
    cat <<EOF

# ---- SRv6 uSID dataplane (Lab 5 SOLVE) ----
# Endpoint behaviour MUST bind to a real device, never lo (a lo-bound
# seg6local route silently fails to attach). We use a dedicated dummy.
ip link add srv6end type dummy 2>/dev/null || true
ip link set srv6end up
sysctl -w net.ipv6.conf.srv6end.seg6_enabled=1 >/dev/null 2>&1 || true

# uN/End.DT6 endpoint: decapsulate uSID traffic addressed to this leaf and
# look the inner packet up in the LOCAL table (255). The service prefix lives
# there as an RTN_LOCAL route (see leaf_service_block), so the decapsulated
# inner is delivered locally. (Table 254/main holds only a dev-lo connected
# route, which End.DT6 would try to forward to lo -> Ip6InNoRoutes -> drop.)
ip -6 route replace fcbb:bb00:${l}:fe00:: encap seg6local action End.DT6 table 255 count dev srv6end

# Headend (H.Encaps.Red): steer traffic for each OTHER leaf's service prefix
# into that leaf's uSID. Reduced encap => the single uSID rides in the outer
# IPv6 DA (no SRH). The outer DA (remote /48) is reachable via BOTH spines, so
# per-flow flow-label entropy spreads the flows across spine1 + spine2.
EOF
    for m in 1 2 3 4; do
      [ "$m" = "$l" ] && continue
      echo "ip -6 route replace fd00:100:${m}::/64 encap seg6 mode encap.red segs fcbb:bb00:${m}:fe00:: dev eth1"
    done
  } > "$SOLVE/$sw/overlay-setup.sh"
  chmod +x "$SKEL/$sw/overlay-setup.sh" "$SOLVE/$sw/overlay-setup.sh"
done

echo "generated:"
echo "  $SKEL"
echo "  $SOLVE"
find "$SKEL" "$SOLVE" -type f | sort
