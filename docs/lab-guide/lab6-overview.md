# Lab Guide 5 — Super Spines: beyond a single-pod CLOS

In [Lab 1](00-overview.md) you built a 2-tier CLOS. In [Labs 2–3](lab2-overview.md) you stretched a single L2 segment across it and ran a real AllReduce on top. In [Lab 4](lab4-overview.md) you watched the per-link Mbps fill in as the collective ran.

Everything you've built so far fits inside a single **pod**. Two spines, four leaves, eight workers — one rectangle of bandwidth. That rectangle has a hard ceiling: the **radix** of the switches it's built from. Once you run out of leaf-facing ports on the spines, the only way to grow is **up** — add a third tier above the spines.

That third tier is the **super spine**. This lab walks through what it is, when hyperscalers actually reach for it, what its BGP plane looks like, and why it matters for AI training fabrics specifically. Then you'll inspect your existing 2-tier fabric to ground the math.

> **What this lab is — and isn't.** Lab 6 is a **conceptual lab**. There are no super-spine containers deployed in this platform; the existing 2-spine / 4-leaf / 8-worker pod is the surface you'll discuss against. You'll read, run a few `show` commands to anchor the math, and click through three inspection checkpoints. There's nothing to type and break. The "Solve ✓" button is a no-op re-apply of the same baseline. See [`notes/decisions.md`](../../notes/decisions.md) ADR-013 for the rationale.

By the end of this lab you'll be able to answer, on a whiteboard:

1. Why does any AI fabric ever need more than a 2-tier CLOS?
2. At what scale does a 2-tier CLOS stop being enough?
3. What does the third tier look like — physically, in BGP, and in failure semantics?
4. What changes for the workload (NCCL/Gloo collectives) when traffic crosses pods vs. stays inside one?

---

## What you'll learn

Concepts, not CLI flags:

- **Radix and the pod ceiling.** Why "32-port switches → ~1024 GPUs/pod" isn't a coincidence — it's the arithmetic of CLOS.
- **Why a 3rd tier exists.** Multi-pod scaling, fault-domain isolation, blast-radius reduction, multi-tenant separation.
- **The shape of 3-tier BGP.** Adding another eBGP hop, what the AS numbering pattern looks like, why super spines are usually a shared-AS tier (same teaching choice as your spines today — [ADR-002](../../notes/decisions.md)).
- **Why super spines transit underlay-only by default.** The EVPN routes still flow end-to-end, but the super-spine tier doesn't need to *participate* in EVPN signaling for a pure cross-pod underlay design — it's a routing-only relay.
- **What it means for collectives.** When does an AllReduce stay in-pod and when does it cross the super spine? Why hyperscalers schedule training jobs to minimize cross-pod traffic.
- **What failure looks like at this scale.** A spine failure inside a pod converges over the pod's leaves; a super-spine failure spans pods. The blast radius is *deliberately* layered.

> 💡 **Why this matters in AI DCs.** Every public AI fabric paper (Meta RSC, Microsoft GPU pods, Google's TPU networks, AWS HyperPod) eventually shows the same shape: tier-1 leaves, tier-2 spines, tier-3 super spines (sometimes called *aggregation* or *core*). The first time you see a 3-tier diagram you should be asking "at what scale did they need this?" — that's the question this lab answers.

---

## Teaching philosophy

Labs 1–3 were *build* labs — you typed config, the fabric came up, ping worked. Lab 4 was an *observe* lab — you watched the dashboard fill. Lab 6 is a *reason* lab — most of your time is reading and thinking, not typing. Where you do open a console, you're inspecting state that already exists to anchor a concept (`show bgp summary` to count the current spine fan-out; `show ip route ... json` to count today's ECMP paths). Each inline **Check ▸** widget passes against the healthy fabric — clicking it is the moment the guide says "you've now observed the thing I just explained."

This is deliberate. Network design at hyperscale is *mostly* whiteboarding — the actual `vtysh` commands are the small last step. A lab that's all typing would mis-teach the topic.

---

## Prerequisites

- **Labs 1–4 complete (or at least Lab 4's fabric state).** Lab 6 leaves the fabric exactly where Lab 4 did: workers on `192.168.100.0/24`, EVPN-VXLAN overlay live, all 8 BGP sessions Established. If anything is sick, click **Start ▶** to re-apply `_overlay_workers`.
- Open the [Lab 4 dashboard](http://localhost:3001/d/aidc-lab4/) in another tab — when we talk about "per-pod ECMP" it'll be useful to flip over and look at real link rates.
- Keep [`../topology.md`](../topology.md) handy for the existing IP / link / ASN scheme.

---

## The current 2-tier addressing scheme (what the math is anchored to)

Before we walk into a 3rd tier, anchor on what you already have:

| Tier | Devices | ASN(s) | Loopbacks | Links |
|---|---|---|---|---|
| **Spines** | spine1, spine2 | `65000` (shared, per ADR-002) | `10.0.0.1/32`, `10.0.0.2/32` | 4 per spine: eth1..eth4 → leaf1..leaf4 |
| **Leaves** | leaf1..leaf4 | `65101..65104` (per-leaf) | rid `10.0.1.X/32`, VTEP `10.0.10.X/32` | 2 per leaf: eth1 → spine1, eth2 → spine2 |
| **Workers** | gpu1..gpu8 | n/a | overlay `192.168.100.11..18/24` | 1 per worker: eth1 → leaf eth3/eth4 |
| **Spine ↔ leaf** | 8 links | numbered /31 `10.1.{spine}.{leaf*2}/31` | — | full bipartite |

This is **1 pod**. Spine1 burns all 4 fabric-facing ports on leaves; the pod can't grow without bigger spines or another tier. That's the constraint Lab 6 unpacks.

---

## The workflow loop

For each section of the exercise:

1. **Read** the conceptual content. The scale math is the load-bearing part.
2. **Run** the indicated inspection command on the indicated console (spine1 or leaf1). Confirm what the guide claimed.
3. Click **Check ▸** to record the observation.

At the end, **Submit ✓** runs all the inspection checks plus the 56-pair worker ping mesh — a regression guard that the conceptual walk didn't perturb anything.

---

## Persistence note

This lab doesn't change fabric state. There's nothing to persist or roll back. **Start ▶** and **Solve ✓** both re-apply the same `_overlay_workers` baseline; **Reset ↺** is identical. You can click any of them at any time without losing anything.

---

## Where to go

- **[`lab6-exercise.md`](lab6-exercise.md)** — the guided walkthrough. Start here.
- **[`lab6-solution.md`](lab6-solution.md)** — radix-math worksheet answers + reference FRR config blocks a real super-spine tier would use (for when you want to see the actual BGP shape, not just discuss it).

Reference material to keep open in another tab:

- **[`../topology.md`](../topology.md)** — current 2-tier IP / link / ASN scheme.
- **[`../../notes/decisions.md`](../../notes/decisions.md)** — ADR-002 (shared-AS spines, why the same choice would apply at the super-spine tier), ADR-013 (why this lab is conceptual, not deployed).
- **[Lab 4 Grafana](http://localhost:3001/d/aidc-lab4/)** — useful for "per-pod ECMP" discussion.
