#!/bin/sh
#
# AIDC Lab — switch bootstrap
# Runs inside each sonic-vs container after deploy. Idempotent.
#
# What it does:
#   1. Brings up the data-plane veths (eth1..eth4) that containerlab attached.
#   2. Fixes ownership/perms on the bind-mounted FRR files (containerlab mounts
#      them as root, but FRR daemons run as user "frr").
#   3. (Re)starts zebra, staticd, bgpd via supervisord.
#   4. Pushes the unified /etc/frr/frr.conf into the running daemons via
#      `vtysh -b`. FRR 7.5 (this sonic-vs image) does NOT auto-read frr.conf
#      from each daemon — they look at zebra.conf/bgpd.conf — so we have to
#      explicitly boot the integrated config.
#
# After this runs on every switch, BGP should converge within ~30s.

set -e

# 1. Bring up fabric veths.
for i in 1 2 3 4; do
  ip link set "eth${i}" up 2>/dev/null || true
done

# 2. Fix FRR file ownership/perms.
chown -R frr:frr /etc/frr/ 2>/dev/null || true
chmod 640 /etc/frr/daemons /etc/frr/frr.conf 2>/dev/null || true
chmod 644 /etc/frr/vtysh.conf 2>/dev/null || true
chmod 750 /etc/frr 2>/dev/null || true

# 3. (Re)start FRR daemons.
supervisorctl stop bgpd zebra staticd 2>/dev/null || true
sleep 1
supervisorctl start zebra
sleep 2
supervisorctl start staticd
supervisorctl start bgpd
sleep 1

# 4. Push our unified config into the daemons via vtysh.
#    "-b" = boot: reads /etc/frr/frr.conf and applies it through vtysh,
#    which fans the commands out to zebra (interface IPs), bgpd (BGP), etc.
vtysh -b

echo "bootstrap done: $(hostname)"
