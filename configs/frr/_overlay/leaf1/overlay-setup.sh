#!/bin/sh
# leaf1 overlay primitives via SONiC CLI:
#   VLAN 1000 (L2 segment surface), bridge IP 192.168.100.1/24,
#   VXLAN tunnel 'vtep' sourced from 10.0.10.1, EVPN NVO 'nvo1',
#   VLAN↔VNI map 1000 <-> 10100.
#
# Sourced by bootstrap-switch.sh AFTER the always-teardown block, so we can
# assume the kernel + SONiC config_db are clean when we run.
#
# `config vxlan add` writes to config_db; swssconfig programs the kernel
# objects (Vlan1000@Bridge + vtep-1000). FRR's `advertise-all-vni` in frr.conf
# then discovers them at boot and originates Type-2/Type-3 EVPN routes.
set -e

config vlan add 1000
config interface ip add Vlan1000 192.168.100.1/24
config vxlan add vtep 10.0.10.1
config vxlan evpn_nvo add nvo1 vtep
config vxlan map add vtep 1000 10100
