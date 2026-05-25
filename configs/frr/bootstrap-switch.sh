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

# 2. (Re)start FRR daemons.
supervisorctl stop bgpd zebra staticd 2>/dev/null || true
sleep 1
supervisorctl start zebra
sleep 2
supervisorctl start staticd
supervisorctl start bgpd
sleep 1

# 3. Push our unified config into the daemons via vtysh.
#    "-b" = boot: reads /etc/frr/frr.conf and applies it through vtysh,
#    which fans the commands out to zebra (interface IPs), bgpd (BGP), etc.
vtysh -b

echo "bootstrap done: $(hostname)"
