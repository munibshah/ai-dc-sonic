# Lab Guide 4 — Telemetry & Visualization with gNMI + Grafana

In [Lab 3](lab3-overview.md) you ran a real Gloo AllReduce across eight workers over an EVPN-VXLAN overlay. The lab printed one number at the end — "rank 0 reports X Gbps avg" — and that was it. In production, that's nobody's idea of operating an AI training fabric. Real AI-DC operators live in dashboards. They watch per-link Mbps tick up as the reduce phase starts. They watch ECMP load-spread across both spines. They watch one link go red when it can't keep up with the rest. They reach for telemetry the way pilots reach for an artificial horizon — every decision is calibrated against what the dashboards are showing right now.

This lab closes that gap. You bring up a streaming-telemetry pipeline — **gnmic** subscribes to each switch's gNMI server, **Prometheus** scrapes the samples, **Grafana** renders the dashboards — and then you run the Lab 3 AllReduces again, this time watching the chart fill in real time.

By the end of this lab:

- You understand the gNMI streaming-telemetry model (push, not poll) and why hyperscalers default to it for AI fabrics.
- You can read OpenConfig interface counters and convert them to wire-rate Mbps via PromQL.
- You see, with your own eyes, the difference between a quiet fabric and one carrying an 8-rank AllReduce — including ECMP load-spread across both spines.
- You have a stable mental link between **"AllReduce phase"** and **"link saturation pattern,"** which is the muscle memory every fabric operator needs.

---

## The telemetry stack

Three new containers were started by `make warm` alongside the fabric:

| Container | Role | Port (host) |
|---|---|---|
| `gnmic` | gNMI subscriber. Connects to each switch's gNMI server, streams OpenConfig interface counters every 5 s, re-publishes as a Prometheus scrape endpoint. | (internal only) |
| `prometheus` | Time-series database. Scrapes gnmic and the orchestrator's netdev exporter every 5 s; retains 15 minutes of data. | `9090` |
| `grafana` | Dashboards. Pre-provisioned with the **AIDC Lab 4 — Fabric Traffic** dashboard, anonymous viewer access enabled so it embeds cleanly in this UI. | `3001` |

The dashboard is embedded in the **right pane** of this workbench (the **Telemetry** pane). Click **Focus telemetry** in the control bar to give it more screen real estate; **Show all panes** brings the three-way split back.

> 💡 **Why this matters in AI DCs:** Real switching ASICs expose hundreds of counters per port — RX/TX bytes, per-queue depth, per-class ECN marks, drops, PFC pause frames. A 4096-GPU training cluster produces millions of samples a second across the fabric. The only way operators stay sane is by streaming everything to a TSDB the moment it changes, then querying *patterns* (PromQL) instead of individual values. The shape of this stack — gNMI subscriber → TSDB → Grafana — is what NVIDIA, Meta, and the SONiC project all converge on.

---

## A small but important honesty note

The virtual SONiC image in this lab (`aidc/sonic-vs:202511`) speaks gNMI fluently for **control-plane state** (BGP peer status, VXLAN configuration, FRR neighbors), but its OpenConfig interface counters do **not** see the containerlab veths (`eth1`..`eth4`) that actually carry your fabric traffic — see [ADR-008](../../notes/decisions.md). On real SONiC hardware the OpenConfig path covers every physical port; on this virtualized image it covers the synthetic SONiC ports (`Ethernet0/4/8/12`) which sit unbridged from the clab side.

To make the dashboards actually work, the orchestrator runs a small **netdev exporter** on the side. It `docker exec`s into each switch every few seconds, reads `/proc/net/dev`, and exposes those counters at `/metrics/netdev` for Prometheus to scrape. On real hardware this side channel goes away — gNMI alone covers every counter. But here it's load-bearing, and the dashboards use those metrics for the per-link Mbps panels.

This is exactly the kind of trade you make in real virtualized lab environments. Worth seeing once.

---

## Teaching philosophy

Lab 1 built the routing protocol. Lab 2 built the service. Lab 3 ran the workload across the service. **Lab 4 is the operator surface that lets you actually run the lab.** Every later lab — failure injection, multi-tenant overlays, ECN/incast — depends on you being able to *see* what the fabric is doing without parsing CLI output by hand.

For each step you'll:

1. **Look** at the telemetry stack you didn't have to build. Read its config files; understand what it's subscribing to.
2. **Confirm** the pipeline is healthy: targets up, samples arriving, baseline quiet.
3. **Move traffic** by running AllReduces from the worker consoles. The chart fills *while you watch.*
4. **Read the chart** for ECMP spread, link asymmetry, and reduce-phase shape — the patterns you'll see again in every real-world AI DC.

Each step has a 💡 **Why this matters in AI DCs** callout connecting it to production practice.

---

## Prerequisites

- **Lab 3 is complete (or solvable).** Lab 4 starts from Lab 3's solved state — workers are on the overlay, AllReduce is ready. When you click **Start lab ▶** for Lab 4, the orchestrator applies Lab 3's canonical configuration (`_overlay_workers`), re-delivers `allreduce.py` to every worker, and enables the SONiC `telemetry` feature on every switch.
- Keep the **Telemetry pane** open. The whole point of this lab is watching it.
- You won't type any switch config in Lab 4. The "work" is procedural — run AllReduces, read patterns, click checkpoints. This is unusual for a networking lab, but it mirrors what telemetry work actually looks like in production.

---

## What you'll learn (deeper)

- **gNMI streaming model.** Unlike SNMP polling, gNMI subscriptions are server-push: you tell the switch "send me /interfaces/.../counters every 5 s," and it does, without you asking again. Lower overhead at high cadence; predictable load on the switch CPU.
- **OpenConfig interface counters.** YANG paths like `/interfaces/interface/state/counters/in-octets` are the vendor-neutral schema. Same path on SONiC, Arista, Cisco IOS-XR, Junos — you write one dashboard and it works against every device.
- **PromQL `rate()`.** Interface byte counters are monotonically increasing. To get bps, you take the rate over a window: `rate(aidc_netdev_tx_bytes_total[30s]) * 8`. Multiply by 8 because bytes → bits.
- **ECMP visibility.** A healthy 8-rank AllReduce produces 56 TCP flows. With 2 spines, you'd hope for ~28 flows per spine, ~7 flows per spine-leaf link. In practice flows hash unevenly, especially at low flow counts. The Lab 4 final checkpoint is intentionally tolerant — "≥6 of 8 spine-leaf links carry traffic" — because the goal is to confirm ECMP *works,* not to claim it's perfectly balanced.
- **The sysctl that decides whether ECMP actually works.** Linux's default multipath hash is L3-only (outer src+dst IP). For VXLAN that means ECMP is per-tunnel — every flow between two given leaves rides the same spine, no matter how many inner TCP flows you stack on it. `net.ipv4.fib_multipath_hash_policy=1` adds L4 hashing, and VXLAN's outer UDP source port is derived from the inner flow's 5-tuple — so each inner flow gets its own spine pick. Step 7 has you toggle this knob and watch the dashboard flip between per-flow and per-tunnel ECMP. It's the kind of one-line config that production AI DCs always set and that's easy to miss until your training run sits at 30% of expected throughput.

---

## Where this fits in the phase roadmap

This lab is the foundation for **Lab 7 — Inject Failure During AllReduce** (coming soon). You can't usefully run failure injection without dashboards: the lesson is "watch BGP reconverge in 3 s while AllReduce keeps going," and that lesson only lands if you can *see* the reconvergence happen. Lab 4 is what makes that possible.
