# Spine & Leaf CLI Reference

Practical commands for verifying and changing config on the SONiC switches in this lab. Every command in this doc runs *inside* a switch container.

> **How configs work in this lab** (read this first): each switch's FRR config lives on the Mac at `configs/frr/<node>/frr.conf`. `make sync` pushes it to the remote, and `make fabric-bootstrap` runs `vtysh -b` inside the switch to load it. **Edits done live in `vtysh` are not persistent** — a container restart wipes them. See **§5 Making changes** for the persistent workflow.

---

## Contents

- [0. Getting a shell](#0-getting-a-shell)
- [1. 30-second health check](#1-30-second-health-check)
- [2. BGP verification](#2-bgp-verification)
- [3. Routing & ECMP verification](#3-routing--ecmp-verification)
- [4. Interfaces, links, counters](#4-interfaces-links-counters)
- [5. Making changes (the persistent way)](#5-making-changes-the-persistent-way)
- [6. Making changes (live, for testing)](#6-making-changes-live-for-testing)
- [7. SONiC-specific introspection](#7-sonic-specific-introspection)
- [8. Common failure modes & fixes](#8-common-failure-modes--fixes)

---

## 0. Getting a shell

```bash
# From the Mac (any of these):
make shell-leaf1
make shell-spine1
make shell-gpu5

# Or via the UI: open http://192.168.1.26:3000 and click the device.
# Or via raw SSH: ssh aidc-remote 'docker exec -it leaf1 bash'
```

All three give you a root shell inside the container. From there, FRR's CLI is `vtysh`. The sonic-vs container also runs SONiC's own services (Redis, supervisord, etc) — see §7.

---

## 1. 30-second health check

Run these four commands on any leaf to see if the underlay is healthy. Run on a spine to see all four leaf peers.

```bash
vtysh -c "show bgp summary"        # are BGP peers established? (look for State/PfxRcd as a number, not a state word)
vtysh -c "show ip route bgp"       # did we learn the other leaves' loopbacks?
ip -br link show | grep -E '^eth'  # are the fabric veths UP?
ip -br addr show                   # do the L3 interfaces have IPs?
```

Healthy leaf output (abbreviated):

```
Neighbor         V  AS     MsgRcvd  MsgSent  ...  PfxRcd  PfxSnt
spine1(10.1.1.0) 4  65000  20       20       ...  13      18
spine2(10.1.2.0) 4  65000  20       20       ...  13      18
```

`PfxRcd=13` means: 1 spine loopback + 4 prefixes × 3 other leaves = 13. If it says `Active` or `Connect` instead of a number, the peer is **not** established — go to §8.

---

## 2. BGP verification

### Per-peer state

```bash
vtysh -c "show bgp summary"                                   # overview
vtysh -c "show bgp neighbor 10.1.1.0"                         # deep dive on one peer
vtysh -c "show bgp ipv4 unicast summary failed"               # only peers that aren't up
```

### What did we send / receive?

```bash
# Routes we LEARNED from spine1 (after policy):
vtysh -c "show bgp ipv4 unicast neighbor 10.1.1.0 routes"

# Routes spine1 ADVERTISED to us (before our policy applied):
vtysh -c "show bgp ipv4 unicast neighbor 10.1.1.0 received-routes"

# Routes WE sent OUT to spine1:
vtysh -c "show bgp ipv4 unicast neighbor 10.1.1.0 advertised-routes"
```

> `received-routes` requires `soft-reconfiguration inbound` on the peer (we already have it in all our `frr.conf` files).

### The whole BGP RIB

```bash
vtysh -c "show bgp ipv4 unicast"                              # everything BGP knows
vtysh -c "show bgp ipv4 unicast 10.0.1.3/32"                  # single prefix, all paths
vtysh -c "show bgp ipv4 unicast 10.0.1.3/32 longer-prefixes"  # this + anything more-specific
```

### Useful for an interview

```bash
# Show that we have TWO equal-cost BGP paths to a remote leaf loopback:
vtysh -c "show bgp ipv4 unicast 10.0.1.3/32"
# Look for two "Best" candidates or two paths marked with "multipath".
```

---

## 3. Routing & ECMP verification

### FRR's RIB → kernel FIB

```bash
vtysh -c "show ip route"                  # all routes FRR knows
vtysh -c "show ip route bgp"              # only BGP-learned
vtysh -c "show ip route 10.0.1.3"         # specific prefix; shows multipath next-hops
vtysh -c "show ip route summary"          # counts by source
```

### Kernel's view (this is what the dataplane actually uses)

```bash
ip route                                  # full FIB
ip route show 10.0.1.0/24                 # by prefix
ip route get 10.0.1.3                     # *which* next-hop a single packet would take
```

`ip route get` is the most useful single command for "did ECMP pick what I thought it would for this 5-tuple?". Repeat with different src/dst combinations:

```bash
# Five different 5-tuples, see which spine each lands on:
for i in 1 2 3 4 5; do
  ip route get 10.0.1.3 from 10.2.1.1 sport 1000$i dport 80 mark 0 ipproto tcp
done
```

### ECMP sanity check

For a leaf, a route to any other leaf's loopback **must have two next-hops** (one via each spine):

```bash
vtysh -c "show ip route 10.0.1.2"
# Expected:
#   B>* 10.0.1.2/32 [20/0] via 10.1.1.0, eth1, weight 1
#      *                   via 10.1.2.0, eth2, weight 1
```

If you only see one next-hop, BGP multipath isn't configured correctly — check the `maximum-paths 64` line in `address-family ipv4 unicast`.

---

## 4. Interfaces, links, counters

### Up/down + L3

```bash
ip -br link                  # admin/oper state of every interface, one line each
ip -br addr                  # IPs by interface, one line each
ip addr show eth1            # full L2/L3 detail on one interface
```

### Counters

```bash
ip -s link show eth1         # tx/rx packets, errors, drops (kernel counters)
cat /proc/net/dev            # all interfaces, kernel
ethtool -S eth1 2>/dev/null  # NIC-driver stats (limited in container veths)
```

### Sniffing traffic

```bash
tcpdump -i eth1 -nn icmp                # ICMP only
tcpdump -i eth1 -nn 'tcp port 179'      # BGP keepalives
tcpdump -i eth1 -nn -w /tmp/cap.pcap    # write to pcap, copy out later
tcpdump -i eth1 -nn vrrp                # (when we add EVPN this becomes vxlan, etc.)
```

To pull the pcap to the Mac for Wireshark:

```bash
# on the Mac:
ssh aidc-remote 'docker cp leaf1:/tmp/cap.pcap /tmp/cap.pcap'
scp aidc-remote:/tmp/cap.pcap ~/Downloads/
open ~/Downloads/cap.pcap   # opens Wireshark if installed
```

### LLDP (find your neighbors)

```bash
# sonic-vs ships lldpd:
lldpcli show neighbors                   # human-readable
lldpcli show neighbors detail            # full TLVs
lldpcli show neighbors ports eth1        # one interface
```

This is the lab equivalent of "what's on the other end of this cable?" — useful when topology drift is suspected.

---

## 5. Making changes (the persistent way)

This is the **only** change workflow that survives `make down/up`. Always use this for anything you want to keep.

### Step-by-step

```bash
# 1. On the Mac, edit the per-node config file:
$EDITOR configs/frr/leaf1/frr.conf

# 2. Push to remote:
make sync

# 3. Apply on the live switch(es):
make fabric-bootstrap        # applies on ALL switches (idempotent)
# OR for a single switch:
ssh aidc-remote 'docker exec leaf1 sh /usr/local/bin/bootstrap-switch.sh'

# 4. Verify:
make bgp-check               # all switches
# OR per-switch via the UI / make shell-leaf1
```

The bootstrap script restarts `bgpd`/`zebra`/`staticd` inside the container and runs `vtysh -b` against the new `frr.conf`. BGP sessions flap (~5 seconds) on the switches you touched.

### Recipe: add a new BGP neighbor on leaf1

Edit `configs/frr/leaf1/frr.conf`, add under the `router bgp 65101` block:

```
 neighbor 10.1.99.0 remote-as 65999
 neighbor 10.1.99.0 description new-peer
 neighbor 10.1.99.0 peer-group SPINES        ! optional: reuse the spine peer-group
```

Then `make sync && make fabric-bootstrap`.

### Recipe: advertise a new prefix

Edit `configs/frr/leaf1/frr.conf`, in `address-family ipv4 unicast`:

```
  network 10.99.0.0/24
```

`make sync && make fabric-bootstrap`. Confirm on a spine: `vtysh -c "show bgp ipv4 unicast 10.99.0.0/24"`.

### Recipe: add a route-map (filter inbound from spine1)

Edit `configs/frr/leaf1/frr.conf`:

```
route-map FROM-SPINE1 permit 10
 match ip address prefix-list TENANT-PREFIXES
!
ip prefix-list TENANT-PREFIXES seq 5 permit 10.99.0.0/16 le 32
!
router bgp 65101
 address-family ipv4 unicast
  neighbor 10.1.1.0 route-map FROM-SPINE1 in
 exit-address-family
```

`make sync && make fabric-bootstrap`.

### Recipe: enable BFD on a peer (faster failure detection)

```
router bgp 65101
 neighbor 10.1.1.0 bfd
!
bfd
 peer 10.1.1.0
  receive-interval 300
  transmit-interval 300
```

`make sync && make fabric-bootstrap`. Verify: `vtysh -c "show bfd peers"`.

### Recipe: bring an interface down on purpose (failure scenario)

This is a *temporary* operation — useful for demos.

```bash
# In leaf1's shell:
ip link set eth1 down              # kill the spine1-facing link
# Watch BGP reconverge (5-9s with default timers, faster with BFD):
vtysh -c "show bgp summary"        # spine1 peer should drop
vtysh -c "show ip route 10.0.1.3"  # ECMP collapses to single next-hop via spine2
# Restore:
ip link set eth1 up
```

If you want this to persist across a container restart, do it in `frr.conf` as `shutdown` under the interface block.

---

## 6. Making changes (live, for testing)

For exploratory work that you don't need to keep. **These will be lost** on container restart.

### Interactive

```bash
vtysh                  # drops you into FRR's CLI (cisco-ish)
# Inside vtysh:
configure terminal
router bgp 65101
 neighbor 10.1.1.0 description "trying-something"
 exit
exit
write memory           # writes /etc/frr/frr.conf — BUT our /etc/frr/frr.conf
                       # is bind-mounted from the host, so this either fails
                       # silently or persists only inside the container layer.
                       # Use the §5 workflow for anything real.
```

### One-shot, from outside vtysh

```bash
vtysh -c "configure terminal" -c "router bgp 65101" \
      -c "neighbor 10.1.1.0 shutdown" -c "end"
```

### Reload from disk

If you bind-mount-edited `frr.conf` and want to reload without restarting the daemon:

```bash
vtysh -b      # re-reads /etc/frr/frr.conf and applies via vtysh
              # (this is what `make fabric-bootstrap` does internally)
```

---

## 7. SONiC-specific introspection

The sonic-vs container has SONiC's stack running alongside FRR. Most of it isn't load-bearing in this lab (we deliberately bypassed the config_db.json path — see ADR-008), but it's worth knowing how to poke.

### Service status

```bash
supervisorctl status              # what's RUNNING / STOPPED / EXITED
supervisorctl restart bgpd        # restart one daemon
supervisorctl tail -f syslog      # logs
```

### Redis (SONiC's state store)

```bash
redis-cli ping                    # is redis up?
redis-cli -n 0 keys '*' | head    # APPL_DB (active state)
redis-cli -n 4 keys '*' | head    # CONFIG_DB (intended state)
redis-cli -n 4 hgetall "DEVICE_METADATA|localhost"
redis-cli -n 6 keys '*' | head    # STATE_DB
```

DB index reference: 0=APPL_DB, 1=ASIC_DB, 2=COUNTERS_DB, 4=CONFIG_DB, 6=STATE_DB.

### Files of interest

```bash
cat /etc/frr/frr.conf             # the bind-mounted FRR config (live truth)
cat /etc/frr/daemons              # which FRR daemons are enabled (bgpd=yes etc.)
cat /etc/sonic/config_db.json     # SONiC's intended config (currently inert)
ls /var/log/                      # SONiC + syslog
tail -f /var/log/syslog           # everything
```

### SONiC's own CLI (mostly inert in this lab)

```bash
show version                      # SONiC version
show interfaces status            # operstate / link speed (mostly DOWN here because we don't use SONiC's port layer)
show ip route                     # wraps `vtysh show ip route`
```

---

## 8. Common failure modes & fixes

### BGP peer stuck in `Active` or `Connect`

| Check | Command | Fix |
|---|---|---|
| Is the veth UP? | `ip -br link show eth1` | `ip link set eth1 up`. If still DOWN, re-run `make fabric-bootstrap`. |
| Does the interface have an IP? | `ip -br addr show eth1` | `frr.conf` is missing the `interface ethN / ip address …` block, or the peer's other end doesn't agree on the /31. |
| Can you ping the peer? | `ping <peer-ip>` | If no, look for a different broken hop or an MTU mismatch. |
| TCP 179 reachable? | `nc -zv <peer-ip> 179` | If no, the peer's `bgpd` isn't listening. SSH to it and check `supervisorctl status bgpd`. |
| BGP timers? | `vtysh -c "show bgp neighbor <ip> \| grep -i timer"` | If holdtime / keepalive don't match, peers can flap. We use `timers 3 9` everywhere. |

### "I changed `frr.conf` but nothing changed"

You forgot one of:

```bash
make sync                    # push to remote
make fabric-bootstrap        # reload via vtysh -b on every switch
```

Or you edited `/etc/frr/frr.conf` *inside* the container — that's the bind-mount and its source is on the Mac. Edit on the Mac.

### "Pings work between gpus on the same leaf but not across leaves"

Check the leaf is advertising the worker /31 in BGP:

```bash
vtysh -c "show bgp ipv4 unicast neighbor 10.1.1.0 advertised-routes" \
  | grep 10.2.
```

If missing, you don't have a `network 10.2.X.Y/31` line in `address-family ipv4 unicast` for that worker subnet.

### "ECMP shows only one next-hop"

Check `maximum-paths 64` is in `address-family ipv4 unicast` AND `bgp bestpath as-path multipath-relax` is in the `router bgp` block. The second one matters because both spines have the same AS (65000) but the AS-paths from the two paths only differ by which originating leaf they came from — without `multipath-relax`, BGP requires identical AS-paths for multipath.

### "I want a clean slate without `make down`"

```bash
ssh aidc-remote 'docker exec leaf1 sh /usr/local/bin/bootstrap-switch.sh'
```

This is idempotent — it restarts `zebra/bgpd/staticd` and reloads `frr.conf` from disk. Useful when you've drifted from "what `frr.conf` says" by live `vtysh` poking.

### "I want to wipe BGP state on one peer"

```bash
vtysh -c "clear bgp ipv4 unicast 10.1.1.0"        # hard clear (peer disconnects)
vtysh -c "clear bgp ipv4 unicast 10.1.1.0 soft"   # soft (re-evaluate policy, no flap)
```

---

## Cheat sheet (print-and-stick)

```bash
# Health
vtysh -c "show bgp summary"
vtysh -c "show ip route bgp"
ip -br addr show ; ip -br link show

# What did we learn?
vtysh -c "show bgp ipv4 unicast"
vtysh -c "show ip route 10.0.1.3"
ip route get 10.0.1.3

# What did we send?
vtysh -c "show bgp ipv4 unicast neighbor <peer> advertised-routes"

# Live change (volatile)
vtysh -c "configure terminal" -c "router bgp 65101" -c "<change>" -c "end"

# Persistent change (workflow on the Mac)
$EDITOR configs/frr/leaf1/frr.conf
make sync && make fabric-bootstrap
make bgp-check
```
