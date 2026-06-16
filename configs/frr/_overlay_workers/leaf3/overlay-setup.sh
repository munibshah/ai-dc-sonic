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
