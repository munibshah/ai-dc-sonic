#!/bin/sh
#
# AIDC Lab — switch bootstrap
# Runs inside each sonic-vs container after deploy. Idempotent.
#
# What it does:
#   1. Brings up the data-plane veths (eth1..eth4) that containerlab attached.
#   2. (Re)starts zebra, staticd, bgpd via supervisord.
#   3. Pushes the unified /etc/frr/frr.conf into the running daemons via
#      `vtysh -b`. FRR 7.5 (this sonic-vs image) does NOT auto-read frr.conf
#      from each daemon — they look at zebra.conf/bgpd.conf — so we have to
#      explicitly boot the integrated config.
#
# Note: we deliberately do NOT chown the bind-mounted files. Inside the
# container they appear owned by the host user (UID 1000), mode 644 from
# rsync. FRR daemons read them fine via world-read. A previous version of
# this script chown'd them to frr:frr 0640 — which propagated back to the
# host via the bind mount and locked `eveng` out of subsequent `make sync`
# operations. Don't bring back the chown.
#
# After this runs on every switch, BGP should converge within ~30s.

set -e

# 1. Bring up fabric veths.
for i in 1 2 3 4; do
  ip link set "eth${i}" up 2>/dev/null || true
done

# 1b. Per-flow ECMP for VXLAN underlay. Linux default
#     `net.ipv4.fib_multipath_hash_policy=0` hashes only outer src/dst IP, so
#     all 56 Gloo flows between leafA and leafB ride the SAME spine — visible
#     in Lab 4's telemetry dashboard as ECMP skew (e.g. leaf1+leaf2 inbound
#     all on spine1, leaf3+leaf4 inbound all on spine2). Policy=1 includes
#     L4 (UDP src port), and Linux VXLAN derives outer UDP src from the
#     INNER flow hash — so each inner TCP flow gets a distinct outer src
#     port and the kernel can ECMP per-flow. Real AI DCs always set this;
#     it's the difference between a fabric that load-spreads and one that
#     looks like it works in basic tests but pins per-pair.
sysctl -w net.ipv4.fib_multipath_hash_policy=1 >/dev/null 2>&1 || true

# 2. Overlay teardown (always runs). Removes any prior Lab 2 / Lab 3 SONiC
#    overlay state so the next step starts from a clean slate. `|| true`
#    makes each line a no-op when the resource doesn't exist.
#    Note: `config interface ip remove Vlan1000 <ip>` is BROKEN in this image
#    (aidc/sonic-vs:202511) — it runs a BGP-impact check that crashes with
#    "Unable to get summary from bgp []", so the IP is never removed and
#    `config vlan del 1000` then refuses ("First remove IP addresses"), leaving
#    Vlan1000 to leak into the next lab / next learner. We delete the
#    VLAN_INTERFACE / VLAN_MEMBER rows from CONFIG_DB directly (redis db 4)
#    instead; intfmgrd/vlanmgrd reconcile the kernel. Future labs that introduce
#    new SONiC constructs should extend this teardown.
#
#    Lab 3 additionally adds eth3/eth4 to the kernel bridge `Bridge` (so
#    the worker veths become VLAN 1000 access ports). Detach them here
#    before VLAN/bridge teardown so a Lab 3 → Lab 1/2 switch leaves them
#    cleanly L3-capable again.
for IFACE in eth3 eth4; do
  ip link set "$IFACE" nomaster 2>/dev/null || true
done
config vxlan map del vtep 1000 10100 2>/dev/null || true
config vxlan evpn_nvo del nvo1 2>/dev/null || true
config vxlan del vtep 2>/dev/null || true
# Drop Vlan1000's members + L3 addresses straight from CONFIG_DB (the SONiC
# `config interface ip remove` CLI is broken here — see note above), then delete
# the VLAN. `config vlan del` may print a FileNotFoundError for a cosmetic
# post-step that execs `docker` (absent in-container) AFTER the VLAN is already
# removed — harmless. `ip link del` is a final kernel-side backstop.
for k in $(redis-cli -n 4 keys 'VLAN_MEMBER|Vlan1000|*' 2>/dev/null); do
  redis-cli -n 4 del "$k" >/dev/null 2>&1 || true
done
for k in $(redis-cli -n 4 keys 'VLAN_INTERFACE|Vlan1000|*' 2>/dev/null); do
  redis-cli -n 4 del "$k" >/dev/null 2>&1 || true
done
redis-cli -n 4 del 'VLAN_INTERFACE|Vlan1000' >/dev/null 2>&1 || true
sleep 1
config vlan del 1000 2>/dev/null || true
ip link del Vlan1000 2>/dev/null || true

# 3. Overlay setup (Lab 2+). If /etc/frr/overlay-setup.sh is non-empty, run
#    it to create the SONiC VLAN + VXLAN + EVPN NVO this switch needs before
#    FRR comes up — `advertise-all-vni` in frr.conf discovers the resulting
#    kernel devs at boot. Empty file = underlay-only lab state.
if [ -s /etc/frr/overlay-setup.sh ]; then
  sh /etc/frr/overlay-setup.sh
fi

# 4. (Re)start FRR daemons.
supervisorctl stop bgpd zebra staticd 2>/dev/null || true
sleep 1
supervisorctl start zebra
sleep 2
supervisorctl start staticd
supervisorctl start bgpd
sleep 1

# 5. Push our unified config into the daemons via vtysh.
#    "-b" = boot: reads /etc/frr/frr.conf and applies it through vtysh,
#    which fans the commands out to zebra (interface IPs), bgpd (BGP), etc.
vtysh -b

echo "bootstrap done: $(hostname)"
