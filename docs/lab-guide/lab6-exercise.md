# Exercise — Super spines: when one pod isn't enough

> Read [`lab6-overview.md`](lab6-overview.md) first if you haven't.

## Scenario

You're operating a healthy AI training pod: 2 spines, 4 leaves, 8 GPUs. AllReduce runs cleanly, the Grafana dashboard fills, your boss is happy. Then product comes back: "we need to add another 1000 GPUs by Q3."

Can your current pod absorb that? Almost certainly not — and the reason is **switch radix**. This lab walks the math, then walks what you'd build instead. You won't deploy anything new; the existing fabric stays exactly where Lab 4 left it. You'll inspect it to anchor each conceptual point.

### Get to the starting line

Click **Start lab ▶** in the top bar. The orchestrator re-applies the `_overlay_workers` baseline (same as Lab 4's solved state) — workers on `192.168.100.0/24`, EVPN-VXLAN live, all BGP sessions Established. Within ~30 seconds the lab status pill flips to `In progress`.

Open consoles for **spine1** and **leaf1** via the **Topology** button — you'll alternate between them.

---

## Step 1: The radix wall

A CLOS fabric's size is bounded by the **radix** of its switches — how many ports each one has. The pod ceiling falls out of one equation:

> **Max workers per pod = (leaf-facing ports per spine) × (worker-facing ports per leaf)**

Walk it for your current fabric. On the **leaf1** console:

```sh
docker exec leaf1 ip -br link show | grep -E '^eth[1-4]' | head -10
```

You'll see four fabric/worker-facing veths:

- `eth1` → spine1 (fabric-side)
- `eth2` → spine2 (fabric-side)
- `eth3` → gpu1 (worker-side)
- `eth4` → gpu2 (worker-side)

So each leaf has **2 worker ports**. Now on **spine1**:

```sh
docker exec spine1 ip -br link show | grep -E '^eth[1-4]' | head -10
```

Same shape: `eth1..eth4` → leaf1, leaf2, leaf3, leaf4. **4 leaf-facing ports per spine.**

Plug into the equation:

> max workers per pod = 4 (leaf-facing on spine) × 2 (worker-facing on leaf) = **8 workers**

That's the size of this pod. You're already at the ceiling.

> 💡 **Why this matters in AI DCs.** Real production switches are 32-port to 128-port (with some 256-port silicon in newer designs). The same equation scales: 32-port spines × 32-port leaves = **1024 workers per pod**. Above that — and any meaningful AI training cluster is above that — you can't add another rack of GPUs without either replacing every switch (expensive, ops-painful) or adding a **third tier**. This is the moment the super spine enters the diagram.

Sanity-check that you started from a healthy 2-tier fabric:

<checkpoint name="fabric_healthy_two_tier" label="2-tier fabric healthy — starting line" />

---

## Step 2: Read the current spine fan-out

Your spine is the radix-bounded thing. Watch what it currently sees. On the **spine1** console:

```sh
vtysh -c "show bgp ipv4 unicast summary"
```

Look at the **Neighbor / V / AS / State** columns. Expected:

```
Neighbor    V    AS      ... State/PfxRcd
10.1.1.1    4    65101   ... <int>   (leaf1)
10.1.1.3    4    65102   ... <int>   (leaf2)
10.1.1.5    4    65103   ... <int>   (leaf3)
10.1.1.7    4    65104   ... <int>   (leaf4)
```

Four leaf sessions, all Established (PfxRcd is an int, not "Active" or "Idle"). spine1 has **no more fabric-facing capacity** in this image — you'd need to either (a) renumber onto a switch with more ports or (b) add another spine alongside it.

> 💡 **Why `ipv4 unicast` and not just `show bgp summary`?** Without an address-family qualifier, FRR prints *every* AF — IPv4 unicast AND L2VPN-EVPN. On this fabric every neighbor exists in both AFs, so the bare `show bgp summary` lists each neighbor twice. Scoping to `ipv4 unicast` is what makes "4 rows = 4 leaves" line up.

(a) is the "scale up" path — bigger silicon, more expensive per port, eventually hits its own ceiling. (b) is the "scale out" path — but to wire a 5th leaf into the pod, you'd need a 5th port on *every existing* spine too, and you're back to (a).

The way out is to **add a tier above the spines**. The spines stop being the top — they become the middle. Above them, a new layer of "super spines" connects multiple pods. Each pod retains its own 2-tier internal CLOS; super spines stitch pods into one fabric.

> 💡 **Why this matters in AI DCs.** Real GPU training jobs map onto pods. A small job (a few hundred GPUs) fits in one pod — its collectives ride the existing 2-tier CLOS, no cross-pod traffic. A large job (thousands of GPUs) spans pods — collectives cross the super-spine layer. The scheduler that places jobs is *acutely aware* of this distinction; the super spine is the fabric primitive that makes "multi-pod jobs" possible without making them invisible.

<checkpoint name="spine_fanout_observed" label="Spine1 fans out to 4 leaves — pod's leaf-radix ceiling today" />

---

## Step 3: ECMP today, and what a 3rd tier extends it to

Inside your current pod, leaf-to-leaf traffic ECMPs across both spines. Confirm it. On the **leaf1** console:

```sh
vtysh -c "show ip route 10.0.10.3"
```

You'll see leaf3's VTEP loopback reachable via **two** nexthops:

```
B>* 10.0.10.3/32 [20/0] via 10.1.1.0, eth1, weight 1, ...
  *                    via 10.1.2.0, eth2, weight 1, ...
```

Two ECMP paths — one through spine1, one through spine2. Per-flow load-balancing across both. This is the per-pod ECMP that Lab 4's Grafana dashboard makes visible when you ran the 8-rank AllReduce: traffic from each leaf splits across `eth1` (spine1) and `eth2` (spine2).

Now picture the 3-tier extension. In a multi-pod build:

```
                  +----- supersp1 -----+----- supersp2 -----+
                  |        |           |        |           |
              +---+--------+--+    +---+--------+--+        ...  more pods
              |  pod-1 spines |    |  pod-2 spines |
              +---------------+    +---------------+
              |  pod-1 leaves |    |  pod-2 leaves |
              +---------------+    +---------------+
              | pod-1 workers |    | pod-2 workers |
              +---------------+    +---------------+
```

Traffic from a pod-1 worker to a pod-2 worker:
- worker → leaf (in pod-1)
- leaf → spine (pod-1) — **2 ECMP paths within the pod** (this is what you just saw)
- spine → super spine — **N ECMP paths to N super spines**
- super spine → spine (pod-2)
- spine → leaf → worker (in pod-2)

The ECMP picture you have today (2 paths per source) is a **per-pod** view. The 3rd tier adds another ECMP axis on top — per-pod-pair ECMP across the super-spine layer. Same load-balancing principle, one tier up.

> 💡 **Why this matters in AI DCs.** AllReduce ring algorithms produce N² TCP flows (every rank talks to every other rank). With per-flow ECMP at both tiers, those flows spread across every available physical path — that's how a single AllReduce step can saturate dozens of links simultaneously. Without per-flow ECMP (or with broken hashing — see CLAUDE.md pitfall #18), the collective serializes onto a single path and bandwidth craters. Real AI DCs treat ECMP hashing as a tier-0 correctness concern, not a perf nice-to-have.

<checkpoint name="per_pod_ecmp_observed" label="leaf1 → leaf3 VTEP via 2 spine-ECMP paths" />

---

## Step 4: What the FRR config for a super spine would look like

If you were going to deploy `supersp1` and `supersp2` containers above the current spines, this is the BGP config they'd run. (You're not going to — this is reading, not typing. But it's worth seeing the actual shape; it's a clean extension of patterns you already used in Labs 1 and 2.)

**`supersp1` (proposed AS 64999):**

```
frr defaults datacenter
hostname supersp1
log syslog informational
service integrated-vtysh-config
!
interface lo
 ip address 10.0.0.101/32
!
interface eth1
 description to_spine1
 ip address 10.3.1.0/31
!
interface eth2
 description to_spine2
 ip address 10.3.1.2/31
!
router bgp 64999
 bgp router-id 10.0.0.101
 bgp bestpath as-path multipath-relax
 no bgp default ipv4-unicast
 neighbor SPINES peer-group
 neighbor SPINES advertisement-interval 0
 neighbor SPINES timers 3 9
 neighbor 10.3.1.1 remote-as 65000
 neighbor 10.3.1.1 peer-group SPINES
 neighbor 10.3.1.1 description spine1
 neighbor 10.3.1.3 remote-as 65000
 neighbor 10.3.1.3 peer-group SPINES
 neighbor 10.3.1.3 description spine2
 !
 address-family ipv4 unicast
  network 10.0.0.101/32
  maximum-paths 64
  neighbor SPINES activate
  neighbor SPINES soft-reconfiguration inbound
 exit-address-family
!
line vty
!
```

Spine1 would gain a matching block — two more interface stanzas (eth5, eth6) and a `SUPERSPINES` peer-group with the two super-spine neighbors.

Notable design choices in that block:

- **AS 64999 is shared** between supersp1 and supersp2 — same teaching choice as your two spines today ([ADR-002](../../notes/decisions.md)). Loops are still prevented by standard own-AS rejection.
- **No `address-family l2vpn evpn`** on the super spines. The super spine is a *routing-only* relay between pods. EVPN routes can still ride through it (the underlay carries them as IPv4 unicast next-hops), but the super spine doesn't participate in EVPN signaling. Production designs differ — some put route reflectors at this tier — but for our "scale out the underlay" thesis, EVPN-off is the simpler, more honest shape.
- **`10.3.0.0/16` /31 block** for supersp↔spine links. The lab's `10.2.x.x` block is taken by worker /31s ([`workers/entrypoint.sh`](../../workers/entrypoint.sh) and [`orchestrator/api/labruns.py`](../../orchestrator/api/labruns.py)); `10.3` is the next clean choice.

The full set of config blocks (spine1, spine2, supersp1, supersp2) lives in [`lab6-solution.md`](lab6-solution.md) Appendix A as reference material.

> 💡 **Why this matters in AI DCs.** A real super-spine deployment is not architecturally interesting — the BGP shape is just "another tier of the same pattern you already understand." What's interesting is the **operational** story: bringing a new tier up without disrupting in-pod traffic, planning the failure modes (a super-spine outage is multi-pod; an in-pod-spine outage is single-pod), and scheduling jobs to land on pods rather than spanning them. Most of those concerns aren't in the BGP config — they're in the orchestrator above it.

---

## Step 5: Submit ✓

Click **Submit ✓** in the top bar. The orchestrator runs:

1. The three inspection checks you've already clicked through, all over again (they should still pass — the fabric hasn't changed).
2. The full **56-pair worker ping mesh** across the overlay (8 sources × 7 destinations). This is the regression guard: a conceptual lab shouldn't perturb fabric state. If the mesh still pings 56/56, you've completed Lab 6 with zero collateral damage.

If everything passes, the lab stamps as **Passed**, the completion screen appears, and the CTA for Lab 7 ("Inject Failure During AllReduce") lights up — though Lab 7 itself is `coming-soon` for now.

---

## Stuck?

| You want to… | Click |
|---|---|
| See the worksheet answers + reference FRR configs | **Reveal solution** in the top bar (or open [`lab6-solution.md`](lab6-solution.md)) |
| Re-apply the baseline (no-op on a conceptual lab; identical to Reset) | **Solve** in the top bar |
| Wipe back to the healthy `_overlay_workers` baseline | **Reset** in the top bar |
| Re-run every inspection check + the ping mesh | **Submit ✓** in the top bar |

> Because this lab doesn't change fabric state, all four buttons are mostly equivalent here. **Start**, **Reset**, and **Solve** all re-apply `_overlay_workers`. **Submit** runs the checks but changes nothing.

---

## Where to go next

- [`lab6-solution.md`](lab6-solution.md) — radix-math worksheet answers + reference FRR config blocks (the full would-be `_super_spine/` state)
- [`../topology.md`](../topology.md) — current 2-tier IP / link / ASN reference
- [`../../notes/decisions.md`](../../notes/decisions.md) — **ADR-002** (why the super-spine tier would also be shared-AS), **ADR-013** (why Lab 6 teaches super spines conceptually rather than deploying them)
- **Lab 7 — Inject Failure During AllReduce** — `coming-soon`. Failure injection at the spine tier is the natural follow-on to "what does each tier of the CLOS protect against?"
