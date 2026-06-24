#!/bin/sh
# leaf1 — Lab 3 SOLVE state: overlay primitives (same as Lab 2) + bring the
# worker-facing veths (eth3 to gpu1, eth4 to gpu2) into VLAN 1000 as L2
# access ports, so once gpu1/gpu2 put 192.168.100.X/24 on their own eth1
# they're on the stretched overlay segment alongside the other leaves'
# workers — no L3 hops, no per-host routing.
#
# Why kernel `ip link set master Bridge` instead of `config vlan member add`?
# eth3/eth4 are containerlab veths, not SONiC's native Ethernet0..12 ports
# (per ADR-008 the bridging from `Ethernet*` to the veths isn't wired in
# this image). SONiC's `config vlan member` targets the Ethernet* surface
# and is a no-op for veth names. The kernel-side `ip link` + `bridge vlan`
# path is what actually attaches them to the bridge `swssconfig` already
# created for VLAN 1000.
set -e

# 1. Overlay primitives (identical to _overlay/leaf1/overlay-setup.sh).
config vlan add 1000
config interface ip add Vlan1000 192.168.100.1/24
config vxlan add vtep 10.0.10.1
config vxlan evpn_nvo add nvo1 vtep
config vxlan map add vtep 1000 10100

# 2. Worker access ports — bring eth3 (gpu1) and eth4 (gpu2) into VLAN 1000.
#    `ip addr flush` clears any leftover underlay /31 IPs (the canonical
#    _overlay state had 10.2.1.0/31 on eth3 and 10.2.1.2/31 on eth4; those
#    don't make sense on an access port).
for IFACE in eth3 eth4; do
  ip addr flush dev "$IFACE" 2>/dev/null || true
  ip link set "$IFACE" nomaster 2>/dev/null || true
  ip link set "$IFACE" master Bridge
  bridge vlan del dev "$IFACE" vid 1 2>/dev/null || true
  bridge vlan add dev "$IFACE" vid 1000 pvid untagged
  ip link set "$IFACE" up
done

# ---- SRv6 service prefix (Lab 5): the hosts behind leaf1 ----
# fd00:100:1::1 is a concrete host (a stable source/identity address you can
# ping FROM); the local /64 makes the leaf answer every address in the range, so
# pinging fd00:100:1::1..N gives the ECMP demo many distinct inner flows.
ip -6 route replace local fd00:100:1::/64 dev lo
ip -6 addr replace fd00:100:1::1/128 dev lo

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
ip -6 route replace fcbb:bb00:1:fe00:: encap seg6local action End.DT6 table 255 count dev srv6end

# Headend (H.Encaps.Red): steer traffic for each OTHER leaf's service prefix
# into that leaf's uSID. Reduced encap => the single uSID rides in the outer
# IPv6 DA (no SRH). The outer DA (remote /48) is reachable via BOTH spines, so
# per-flow flow-label entropy spreads the flows across spine1 + spine2.
ip -6 route replace fd00:100:2::/64 encap seg6 mode encap.red segs fcbb:bb00:2:fe00:: dev eth1
ip -6 route replace fd00:100:3::/64 encap seg6 mode encap.red segs fcbb:bb00:3:fe00:: dev eth1
ip -6 route replace fd00:100:4::/64 encap seg6 mode encap.red segs fcbb:bb00:4:fe00:: dev eth1
