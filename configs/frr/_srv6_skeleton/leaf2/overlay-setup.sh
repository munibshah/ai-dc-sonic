#!/bin/sh
# leaf2 — Lab 3 SOLVE state: overlay primitives + worker access ports on VLAN 1000.
# See leaf1's overlay-setup.sh for rationale.
set -e

config vlan add 1000
config interface ip add Vlan1000 192.168.100.2/24
config vxlan add vtep 10.0.10.2
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

# ---- SRv6 service prefix (Lab 5): the hosts behind leaf2 ----
# fd00:100:2::1 is a concrete host (a stable source/identity address you can
# ping FROM); the local /64 makes the leaf answer every address in the range, so
# pinging fd00:100:2::1..N gives the ECMP demo many distinct inner flows.
ip -6 route replace local fd00:100:2::/64 dev lo
ip -6 addr replace fd00:100:2::1/128 dev lo
