#!/bin/sh
# leaf3 — Lab 3 SOLVE state: overlay primitives + worker access ports on VLAN 1000.
# See leaf1's overlay-setup.sh for rationale.
set -e

config vlan add 1000
config interface ip add Vlan1000 192.168.100.3/24
config vxlan add vtep 10.0.10.3
config vxlan evpn_nvo add nvo1 vtep
config vxlan map add vtep 1000 10100

for IFACE in eth3 eth4; do
  ip addr flush dev "$IFACE" 2>/dev/null || true
  ip link set "$IFACE" nomaster 2>/dev/null || true
  ip link set "$IFACE" master Bridge
  bridge vlan del dev "$IFACE" vid 1 2>/dev/null || true
  bridge vlan add dev "$IFACE" vid 1000 pvid untagged
  ip link set "$IFACE" up
done

# ---- SRv6 service prefix (Lab 5): the hosts behind leaf3 ----
# fd00:100:3::1 is a concrete host (a stable source/identity address you can
# ping FROM); the local /64 makes the leaf answer every address in the range, so
# pinging fd00:100:3::1..N gives the ECMP demo many distinct inner flows.
ip -6 route replace local fd00:100:3::/64 dev lo
ip -6 addr replace fd00:100:3::1/128 dev lo

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
ip -6 route replace fcbb:bb00:3:fe00:: encap seg6local action End.DT6 table 255 count dev srv6end

# Headend (H.Encaps.Red): steer traffic for each OTHER leaf's service prefix
# into that leaf's uSID. Reduced encap => the single uSID rides in the outer
# IPv6 DA (no SRH). The outer DA (remote /48) is reachable via BOTH spines, so
# per-flow flow-label entropy spreads the flows across spine1 + spine2.
ip -6 route replace fd00:100:1::/64 encap seg6 mode encap.red segs fcbb:bb00:1:fe00:: dev eth1
ip -6 route replace fd00:100:2::/64 encap seg6 mode encap.red segs fcbb:bb00:2:fe00:: dev eth1
ip -6 route replace fd00:100:4::/64 encap seg6 mode encap.red segs fcbb:bb00:4:fe00:: dev eth1
