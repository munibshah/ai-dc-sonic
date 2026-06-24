#!/bin/sh
# leaf4 overlay primitives via SONiC CLI: VLAN 1000, bridge IP
# 192.168.100.4/24, VTEP src 10.0.10.4, VNI 10100.
set -e

config vlan add 1000
config interface ip add Vlan1000 192.168.100.4/24
config vxlan add vtep 10.0.10.4
config vxlan evpn_nvo add nvo1 vtep
config vxlan map add vtep 1000 10100
