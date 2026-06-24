# Lab Guide 3 — Put the GPUs on the overlay and run a real AllReduce

In [Lab 2](lab2-overview.md) you built an EVPN-VXLAN overlay between the four leaves: VLAN 1000 / VNI 10100 / subnet 192.168.100.0/24, stretched leaf-to-leaf. You proved it worked by pinging from one leaf's `Vlan1000` IP to another's, watching a packet ride a real VXLAN tunnel through the underlay.

But the eight "GPU" workers (`gpu1`..`gpu8`) are still on the **underlay** — each one with a `/31` P2P link to its leaf, routed hop-by-hop through the fabric. They can already reach each other (that's what Lab 1's 56/56 ping mesh checks), but they take L3 hops to do it. That's exactly the shape AllReduce hates.

This lab moves the workers onto the **overlay** — the same VLAN 1000 segment the leaves already share — and then runs a real Gloo AllReduce across all eight ranks. That's the rail-optimized AI fabric pattern from [ADR-005](../../notes/decisions.md): every GPU on one flat L2 segment, the fabric handles the stretch under the covers.

By the end of this lab:

- Every leaf's worker-facing ports (`eth3`, `eth4`) are L2 access ports on VLAN 1000 — no L3 IPs on those interfaces anymore.
- Every worker's `eth1` carries a `192.168.100.<10+id>/24` overlay IP (gpu1 = .11, gpu2 = .12, …, gpu8 = .18).
- A 2-rank Gloo AllReduce between gpu1 and gpu3 completes — first east-west collective traffic over the VXLAN data plane.
- A full 8-rank Gloo AllReduce across every GPU completes, and you see effective bandwidth reported.

---

## What changes at the L2/L3 boundary

You're moving the "where does L2 stop and L3 start" line. The Lab 1+2 fabric had:

```
gpu1 <-- L3 (10.2.1.0/31) --> leaf1 <-- L3 (10.1.1.0/31) --> spine1 <-- L3 --> leaf3 <-- L3 (10.2.3.0/31) --> gpu5
```

Five L3 hops between any two GPUs on different leaves. The Lab 3 fabric does this:

```
gpu1 <-- L2 (VLAN 1000) --> leaf1 ===VXLAN tunnel=== leaf3 <-- L2 (VLAN 1000) --> gpu5
                                  (encap rides L3 underlay)
```

L2 on both ends, L3 only in the underlay-traversal middle (and VXLAN is transparent to the workers — they think they're on one wire). This is why **the leaf-side `/31` IPs on `eth3`/`eth4` have to go**: those interfaces become switchports, not L3 endpoints.

---

## Why an AI Data Center actually wants this

The reason hyperscalers pay the EVPN-VXLAN complexity tax for the GPU plane:

- **NCCL / Gloo bootstrap**: rendezvous protocols use raw broadcasts and TCP `SO_BROADCAST`. Cheap in a single subnet, very expensive across L3.
- **ARP scaling**: every GPU pair caches every other GPU's MAC. One stretched segment means one bridge fdb table; per-leaf /31 means N² routing entries to maintain.
- **Failure recovery**: when a link drops, BGP convergence takes ~3s with the timers we tuned in Lab 1. ARP refresh is sub-second. In the middle of a training step, that gap matters.
- **No per-host plumbing**: the GPU thinks it's on `192.168.100.0/24`. Same on every host. No routing tables, no default-gateway juggling per rack.

You're emulating the production rail-optimized pattern at small scale. The control plane (BGP-EVPN) and data plane (VXLAN) are the same; the only difference vs. a real hyperscaler is the box count and that we're on the CPU instead of GPU/RDMA.

---

## Teaching philosophy

Lab 1 was "build the protocol." Lab 2 was "build the service." Lab 3 is "**move the traffic** onto the service you built" — and then **make the traffic** with a real collective workload.

For each step you'll:

1. **Set up the L2/L3 boundary on each leaf** — `ip link set eth3 master Bridge` + `bridge vlan add` puts the worker veths into VLAN 1000. The Lab 2 overlay was leaf-only; now the worker ports join it.
2. **Move the worker eth1 onto the overlay subnet** — `ip addr add 192.168.100.<10+id>/24 dev eth1`. Drop the default route — every peer is on-link.
3. **Verify reachability** — ping gpu1→gpu3 over the overlay. First east-west VXLAN packet between actual workloads.
4. **Verify the full mesh** — same 56/56 ping mesh from Lab 1, but now every packet rides a VXLAN tunnel.
5. **Run the collective** — a hand-launched 2-rank Gloo AllReduce between gpu1 and gpu3, then the 8-rank version via the Submit ✓ checkpoint.

Each step has a 💡 **Why this matters in AI DCs** callout connecting it to real production behavior.

---

## Prerequisites

- **Lab 2 is complete** (or at least understood). Lab 3 *starts from* Lab 2's solved state — the overlay is already there. You're extending it to the workers.
- When you click **Start lab ▶** for Lab 3, the orchestrator applies the Lab 2 canonical overlay config to every switch and resets every worker to its Lab 1 `/31` baseline. You always start from "Lab 2 finished, workers still on underlay."
- Keep [`../topology.md`](../topology.md) open in another tab — section 3 has the IP map you'll work from.

---

## The addressing scheme

| Thing | Value | Notes |
|---|---|---|
| L2 segment | VLAN 1000 | Same VLAN you set up in Lab 2 |
| L2VNI | 10100 | Same VNI |
| Overlay subnet | 192.168.100.0/24 | Stretched across all four leaves + every GPU |
| Leaf overlay IPs (Vlan1000) | `192.168.100.1`..`192.168.100.4` | One per leaf (from Lab 2) |
| **Worker overlay IPs (eth1)** | **`192.168.100.11`..`192.168.100.18`** | `gpu<N>` → `192.168.100.<10+N>` |
| Worker-facing leaf ports | `leaf<L>:eth3` (gpuA), `leaf<L>:eth4` (gpuB) | Become L2 access ports on VLAN 1000 |
| Old `/31` underlay links | retired on solve | The leaves drop `10.2.<L>.X/31` from `eth3`/`eth4` in the Lab 3 canonical config |

The `+10` offset on the worker IPs keeps them out of the way of the leaves' own VLAN 1000 IPs (1..4) and leaves room for the orchestrator's `192.168.100.5`, `.6` and future test endpoints.

---

## Why kernel commands and not `config vlan member add`?

You used SONiC's native CLI for the VLAN, VXLAN tunnel, and EVPN NVO in Lab 2 — and you'll do the same here for the overlay primitives. But for **adding the worker-facing veths to the bridge** you'll drop to the Linux kernel via `ip link` and `bridge vlan`.

Why? In this `aidc/sonic-vs:202511` image, containerlab attaches the worker veths as plain Linux interfaces (`eth3`, `eth4`) — they are *not* the SONiC-native `Ethernet0/4/8/12` ports SONiC's `INTERFACE`/`VLAN_MEMBER` tables target ([ADR-008](../../notes/decisions.md)). SONiC's `config vlan member add Vlan1000 Ethernet0` would have no effect on the actual veth carrying packets to/from a worker.

The kernel commands attach the veths to the bridge SONiC already created (`Bridge`, with `Vlan1000@Bridge` and `vtep-1000` glued to it via the Lab 2 setup). It's the right tool for this image; on production hardware running on real `EthernetN` ports you'd use the SONiC CLI.

---

## The workflow loop

For each leaf:

1. Open the leaf's console from the **Topology** button.
2. Run the four kernel commands per worker port (eight commands total — eth3 and eth4):
   ```sh
   ip addr flush dev eth3
   ip link set eth3 master Bridge
   bridge vlan add dev eth3 vid 1000 pvid untagged
   ip link set eth3 up
   ```
3. Verify with `ip -d link show eth3` and `bridge vlan show dev eth3`.

For each worker:

4. Open the worker's console.
5. Run three commands:
   ```sh
   ip addr flush dev eth1
   ip addr add 192.168.100.<10+id>/24 dev eth1
   ip route del default 2>/dev/null
   ```
6. Verify with `ip -br -4 addr show eth1` and `ping <peer>`.

Then verify and submit:

7. **First east-west packet**: from gpu1, `ping -c 2 192.168.100.13` (gpu3). Success means the overlay carries actual workload traffic.
8. **First collective**: hand-launch a 2-rank Gloo AllReduce between gpu1 (rank 0) and gpu3 (rank 1).
9. **Submit ✓** to run the full 56/56 overlay ping mesh + the 8-rank AllReduce as the lab's headline check.

---

## Persistence note

Same as Labs 1 + 2. Kernel-level `ip` / `bridge` commands are runtime-only; they don't survive a switch container restart. SONiC's `config save` would write the bridge VLAN membership to disk on real hardware, but in this lab we re-apply state via Start / Reset / Solve — switch containers are never restarted by the orchestrator, so you can walk away.

For controlled state changes:

- **Reset** — re-applies Lab 2's `_overlay` canonical (the lab's starting state), tears down any worker-port bridge memberships, and resets every worker's `eth1` back to its `/31` underlay baseline. Use when you've made a mess and want to start fresh.
- **Solve** — applies the full Lab 3 answer: the `_overlay_workers` switch state (which drops the leaf-side L3 IPs on worker ports and attaches them to the bridge) plus reconfigures every worker's `eth1` onto 192.168.100.0/24. Your run is flagged "solved" on the completion screen.

---

## Where to go

- **[`lab3-exercise.md`](lab3-exercise.md)** — the guided walkthrough. Start here.
- **[`lab3-solution.md`](lab3-solution.md)** — copy-pasteable answer key + a common-mistakes troubleshooter.

Reference material to keep open in another tab:

- **[`../topology.md`](../topology.md)** — full IP / link reference.
- **[`../switch-cli-reference.md`](../switch-cli-reference.md)** — SONiC `config`/`show` + `bridge` / `ip` cheat sheet.
- **[`../../notes/decisions.md`](../../notes/decisions.md)** — ADR-004 (Gloo as the CPU collective backend), ADR-005 (why one stretched L2 segment), ADR-008 (why `eth3`/`eth4` are veths and not SONiC ports).
