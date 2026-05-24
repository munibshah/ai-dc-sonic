# Scenario 00 — Bring up the fabric

**Objective:** Boot the 2-spine / 4-leaf / 8-worker CLOS, confirm BGP underlay is up everywhere, and demonstrate ECMP between leaves.

**Maps to concepts:** hyperscale CLOS architecture, eBGP underlay, ECMP, oversubscription math.

**Prereqs:** OrbStack installed, `orb create ubuntu aidc` done, `make pull` completed once (downloads ~270 MB sonic-vs image + builds the arm64 worker image).

---

## 1. Boot

```bash
make warm
```

`warm` does `up` → sleep 30s → `fabric-bootstrap` → sleep 30s → `bgp-check` → `ping-mesh`.
The `fabric-bootstrap` step is needed because the older `netreplica/docker-sonic-vs:latest` image doesn't auto-enable `bgpd` from our config — see [notes/decisions.md ADR-008](../notes/decisions.md) for the full reasoning. Bootstrap brings up the fabric veths, fixes FRR file perms, restarts `zebra`/`bgpd`/`staticd`, and runs `vtysh -b` to load the bind-mounted `frr.conf` into each switch.

First boot takes **2-5 min** because sonic-vs runs under Rosetta on Apple Silicon. Subsequent boots are faster (~90s).

Expected tail of output:

```
=== leaf1 ===
IPv4 Unicast Summary:
BGP router identifier 10.0.1.1, local AS number 65101 vrf-id 0
...
Neighbor         V  AS     MsgRcvd  MsgSent  ...  PfxRcd  PfxSnt
spine1(10.1.1.0) 4  65000  20       20       ...  13      18
spine2(10.1.2.0) 4  65000  20       20       ...  13      18
=== leaf2 ===
...
  gpu1 -> gpu2 (10.2.1.3)  OK
  gpu1 -> gpu3 (10.2.2.1)  OK
  ...  (56 pairs total)
```

Each leaf should show **2 spine neighbors with PfxRcd=13** (1 spine loopback + 4 prefixes × 3 other leaves), and each spine should show **4 leaf neighbors with PfxRcd=4** (loopback + VTEP /32 + 2 worker /31s per leaf).

If a `gpu_X -> gpu_Y FAIL` appears, see **Troubleshooting** at the bottom.

---

## 2. Walk the underlay BGP

```bash
make shell-leaf1
```

You're now in the SONiC management container. From here:

```bash
# Show BGP neighbors (FRR/vtysh)
vtysh -c "show bgp summary"

# Show all IPv4 routes learned via BGP — you should see ECMP next-hops
# for the other 3 leaves' loopbacks (10.0.1.2, .3, .4)
vtysh -c "show ip route bgp"

# Confirm ECMP: route to leaf3's loopback should have TWO next-hops
# (one via spine1, one via spine2)
vtysh -c "show ip route 10.0.1.3"
```

Expected for the third command:
```
B>* 10.0.1.3/32 [20/0] via 10.1.1.0, Ethernet0, weight 1
   *                   via 10.1.2.0, Ethernet4, weight 1
```

That `weight 1` on two next-hops is the ECMP working — every IP packet to leaf3 will hash to one of the two spines based on its 5-tuple. This is *the* foundational property of a CLOS fabric.

---

## 3. Demonstrate ECMP from a worker

```bash
make shell-gpu1
```

Inside gpu1:

```bash
# Where does traffic to gpu5 actually go? Trace the path.
traceroute -n 10.2.3.1     # gpu5's fabric IP

# Run several traces to different destinations — they will hash differently
# across the two spines.
traceroute -n -q 1 10.2.2.3   # gpu4
traceroute -n -q 1 10.2.3.1   # gpu5
traceroute -n -q 1 10.2.4.3   # gpu8
```

Observed in this lab:
- `10.2.2.3` (gpu4) → via 10.1.1.0 (spine1)
- `10.2.3.1` (gpu5) → via 10.1.2.0 (spine2)
- `10.2.4.3` (gpu8) → via 10.1.2.0 (spine2)

Different destinations hash to different spines (ECMP working). Return paths can pick a different spine at each hop, so traceroute may show asymmetric forward/return — that's the 5-tuple hash on each hop independently.

To watch it live, in another terminal:

```bash
make shell-leaf1
tcpdump -i eth1 -nn icmp &   # spine1 path
tcpdump -i eth2 -nn icmp &   # spine2 path
```

Then in gpu1 run pings to different destinations. (Note we use `eth1/eth2` not `Ethernet0/Ethernet4` because the lab uses the kernel veths directly — see ADR-008.)

**Important caveat:** a single TCP flow with a fixed 5-tuple will *always* pick the same spine. This is per-flow ECMP — every datacenter switch does it this way — and it's exactly why one giant elephant AllReduce flow can hot-spot a single spine. Foreshadowing for scenario 03.

---

## 4. The oversubscription conversation (for interviews)

The current build is **non-blocking** at the leaf:
- 2 worker ports × 100G = 200G south-facing
- 2 spine ports × 100G = 200G north-facing
- Ratio: 1:1

In a real AI pod, leaves are often 4:1 or 6:1 oversubscribed (a leaf might have 32 GPU links southward and only 8 fabric links northward). The math is the same one your interviewer wants you to do on a whiteboard. Edit `topo/aidc.clab.yml` to add a third worker per leaf, and you've broken non-blocking — a useful demo of why AI fabrics aggressively avoid oversubscription at the rail-level.

---

## 5. Tear down

```bash
make down
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `clab deploy` hangs at "creating containers" | First-time Rosetta download | Wait 5 min on first run. Subsequent runs are fast. |
| Some `gpu_X -> gpu_Y FAIL` | BGP hasn't converged yet | `sleep 30 && make ping-mesh` again. |
| `vtysh: command not found` in leaf shell | Wrong container | `docker exec -it leaf1 bash` (the Makefile does this) |
| All BGP neighbors stuck in `Active` | `fabric-bootstrap` hasn't been run yet | `make fabric-bootstrap` then wait ~30s and `make bgp-check`. |
| `bgpd: ERROR (not running)` during bootstrap | First call to `supervisorctl stop bgpd` ran when bgpd was already stopped | Harmless — bootstrap continues. The subsequent `start bgpd` is what matters. |
| Worker has no IP on eth1 | `entrypoint.sh` ran before veth attached | `docker restart gpu1` — entrypoint retries 5× already, but a flaky boot can miss. |
| `vtysh` shows empty config after `vtysh -b` | `frr.conf` perms wrong; FRR user can't read it | `make fabric-bootstrap` (it re-chowns and re-applies). |

## What just happened (the 30-second version)

You stood up an eBGP-numbered CLOS with shared-AS spines and per-leaf ASNs. The spines redistribute leaf loopbacks across the fabric. Every leaf has two equal-cost paths to every other leaf, and the data plane (Linux kernel inside sonic-vs) installs both into FIB. This is the underlay that, in Phase 2, we'll layer an EVPN-VXLAN overlay on top of — putting all 8 "GPUs" into one L2 segment so that PyTorch+Gloo collectives see a flat L2 fabric while the underlay quietly does the heavy lifting via ECMP.
