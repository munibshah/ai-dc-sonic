#!/usr/bin/env bash
#
# AI DC Lab — worker entrypoint
#
# Containerlab passes us WORKER_ID (1..8) and LEAF_ID (1..4) via env.
# We configure the worker's primary fabric interface with a /31 to its leaf
# and install a default route via the leaf side of the /31.
#
# Addressing scheme (matches notes/decisions.md):
#   leaf <-> worker P2P:  10.2.<leaf_id>.<local_idx*2>/31
#     worker side: .1 of the /31
#     leaf side  : .0 of the /31
#   local_idx is 0 or 1 (each leaf has 2 workers)
#   Loopback (used as a "host IP"): 10.0.2.<worker_id>/32 on lo
#
# We do NOT manage the overlay (192.168.100.0/24) here — that comes in Phase 2
# once the EVPN-VXLAN segment is up; workers will pick up that IP via DHCP or
# static config layered in later.

set -euo pipefail

: "${WORKER_ID:?WORKER_ID env not set}"
: "${LEAF_ID:?LEAF_ID env not set}"

# Which of the leaf's two worker ports am I on? gpu1,gpu3,gpu5,gpu7 -> 0; gpu2,gpu4,gpu6,gpu8 -> 1
LOCAL_IDX=$(( (WORKER_ID - 1) % 2 ))

LEAF_IP="10.2.${LEAF_ID}.$(( LOCAL_IDX * 2 ))"
MY_IP="10.2.${LEAF_ID}.$(( LOCAL_IDX * 2 + 1 ))"
LOOPBACK="10.0.2.${WORKER_ID}"

IFACE="eth1"  # containerlab gives us eth0=mgmt, eth1=first fabric link

echo "[entrypoint] worker=$WORKER_ID leaf=$LEAF_ID iface=$IFACE my=$MY_IP/31 leaf=$LEAF_IP loopback=$LOOPBACK"

# Wait briefly for eth1 to exist (containerlab veth attach is async-ish)
for i in 1 2 3 4 5; do
    ip link show "$IFACE" >/dev/null 2>&1 && break
    sleep 1
done

# Configure fabric link
ip addr flush dev "$IFACE" || true
ip addr add "${MY_IP}/31" dev "$IFACE"
ip link set "$IFACE" up

# Loopback (acts as the worker's "real" identity)
ip addr add "${LOOPBACK}/32" dev lo 2>/dev/null || true

# Default route via the leaf
ip route replace default via "$LEAF_IP" dev "$IFACE"

# Disable rp_filter so asymmetric ECMP paths don't get dropped (Phase 2+)
sysctl -w net.ipv4.conf.all.rp_filter=0 >/dev/null
sysctl -w net.ipv4.conf.default.rp_filter=0 >/dev/null
sysctl -w net.ipv4.conf."$IFACE".rp_filter=0 >/dev/null
sysctl -w net.ipv4.ip_forward=1 >/dev/null

# Start sshd in background for orchestrator-driven exec
/usr/sbin/sshd

echo "[entrypoint] ready. handing off to: $*"
exec "$@"
