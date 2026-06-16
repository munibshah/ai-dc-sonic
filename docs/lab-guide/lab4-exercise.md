# Exercise — Bring up streaming telemetry and visualize AllReduce traffic

> Read [`lab4-overview.md`](lab4-overview.md) first if you haven't.

## Scenario

The fabric you finished Lab 3 with is up:

- Underlay + EVPN-VXLAN overlay running across all 4 leaves + 2 spines.
- Eight workers on the overlay (`gpu1`..`gpu8` on `192.168.100.11`..`.18/24`).
- A 56/56 worker ping mesh works. AllReduces run end-to-end via `/opt/aidc/allreduce.py`.

But you have **no visibility** into what the fabric is doing while a collective runs. The 8-rank AllReduce reports a single average-bandwidth number when it's done, and that's it. You can't see whether ECMP is balancing across both spines. You can't see whether one link is saturating before the others. If a link were lossy or congested, you'd find out by collectives slowing down — not by reading a chart.

Your job in this lab: **bring up a streaming-telemetry pipeline, then read the chart while the collective runs.**

### Get to the starting line

Click **Start lab ▶** in the top bar. The orchestrator:

1. Applies Lab 3's solved configuration to every switch (`_overlay_workers` — workers attached to VLAN 1000, full overlay live).
2. Re-delivers `/opt/aidc/allreduce.py` onto every worker.
3. Runs `config feature state telemetry enabled` on every switch and waits for gNMI to bind on port `8080`.
4. POSTs `/api/admin/provisioning/dashboards/reload` to Grafana so the dashboard refreshes against the just-started telemetry stream.

Within ~30 seconds, the **Telemetry** pane on the right should populate. Open the **Topology** button to launch a worker console when you're ready.

---

## Step 1: Look at your telemetry stack

The right-hand pane is **Grafana**, anonymously embedded from `http://<your-lab-host>:3001`. Three panels are visible at idle:

- **Aggregate fabric egress** — the sum of all TX bytes across every spine port. At idle, this should be a flat line at zero (or very close — BGP keepalives + EVPN updates make a few kbps of background chatter).
- **Spine ↔ leaf links** — per-port TX Mbps on each spine. Each line is one `spine{1,2}:eth{1..4}` link. Eight lines total.
- **Leaf ↔ worker links** — per-port TX Mbps on each leaf's `eth3`/`eth4` (the worker-facing ports). Eight lines total.

> 💡 **Why this matters in AI DCs:** Three panels is the minimum you'd ever want, and a real operator dashboard is 10-20 panels — receive bytes, queue depth, drop counters, ECN marks, BGP sessions up, route count, link-layer errors. The "Aggregate fabric egress" panel is the canary: if it suddenly drops while a training job is running, you have a fabric-level outage. The per-port view tells you where.

Click the **telemetry_stack_healthy** check below this step. It pings the orchestrator → gnmic, Prometheus, and Grafana, confirming all three containers responded.

<checkpoint name="telemetry_stack_healthy" label="gnmic + Prometheus + Grafana all reachable" />

---

## Step 2: Confirm Prometheus is scraping

Click **Topology → gnmic** (or **+** → `gnmic`) to open a console into the collector container. (If `gnmic` isn't in the device list yet, give it 5-10 s; the control-plane group is loaded after the switches.)

Actually — gnmic is a daemon, not interactive. Easier path: open `prometheus`'s built-in `/targets` page in a new browser tab. Click the **open in new tab ↗** link at the top of the Telemetry pane to get the host:port, then change the URL path from `/d/aidc-lab4/...` to `/targets` after swapping `3001` for `9090`:

```
http://<your-lab-host>:9090/targets
```

You should see two scrape jobs, both **UP**:

- `gnmic` — one target, `gnmic:9804`. This is gnmic exposing its in-process Prom registry.
- `orchestrator-netdev` — one target, `orchestrator:8000`. This is the orchestrator's `/metrics/netdev` endpoint feeding kernel veth counters (see the overlay note in [lab4-overview.md](lab4-overview.md)).

> 💡 **Why this matters in AI DCs:** Two scrape jobs may look like a quirk of this lab, but the architecture generalizes: hyperscalers always run multiple collectors against the same fabric, each specialized for a different data source. Streaming telemetry from the NOS (gNMI), kernel-side metrics from the operating system, BMC out-of-band metrics, optical-layer DDM, app-layer NCCL probe traces. One TSDB; many feeders.

<checkpoint name="prometheus_scraping" label="Prometheus has gnmic + orchestrator-netdev targets up" />

---

## Step 3: Confirm samples are flowing

A target showing **UP** in Prometheus only means the HTTP scrape succeeded. It doesn't mean the underlying gNMI subscription is delivering anything, and it doesn't mean the kernel counters are nonzero. The next check runs an actual `count()` query.

Try it yourself first. In the same Prometheus tab, go to `/graph` and run:

```promql
count(aidc_netdev_tx_bytes_total)
```

You should see something ≥ 24. (We expect 4 leaves × 4 active eth ports + 2 spines × 4 spine ports = 24 series at minimum, plus the eth0 mgmt port on each, plus loopbacks — usually 30+ in practice.)

> 💡 **Why this matters in AI DCs:** "Targets are up but no data is flowing" is one of the most common telemetry failure modes in production. A misconfigured gnmic subscription, a switch that authenticated but didn't actually subscribe, a YANG schema mismatch — all manifest as `up == 1` with zero useful series. The fix is always to assert on the *data*, not on the *handshake*.

<checkpoint name="prometheus_has_recent_samples" label="Netdev exporter is feeding ≥24 series into Prometheus" />

---

## Step 4: Read the quiet fabric

Look at the **Aggregate fabric egress** panel. With no AllReduce running, it should be a very low flat line — typically a few hundred kbps of BGP keepalive / EVPN UPDATE / management chatter. The **Spine ↔ leaf links** panel should show all 8 lines hugging the bottom.

This is the **idle fingerprint** of your fabric. Memorize what it looks like. When you run AllReduces in the next steps, you'll see it transform — and after the lab, every time you look at this dashboard, your eyes will go to "is this idle or is this loaded."

> 💡 **Why this matters in AI DCs:** Real operators carry around a mental library of fabric fingerprints — "rest," "training step's allgather phase," "training step's allreduce phase," "checkpoint write to object store," "shard rebalance after a node failure." Each one has a recognizable shape on the dashboard. Pattern recognition is what makes a senior operator faster than a junior one — not knowing more commands, but knowing what *normal* looks like and feeling when it isn't.

<checkpoint name="baseline_low_traffic" label="Fabric is idle (no collective in flight)" />

---

## Step 5: Run a 2-rank AllReduce and watch the chart

Open a `gpu1` terminal — **Topology → gpu1**.

Then in a second terminal tab, open `gpu3`.

> Order matters: the first rank to start is the rendezvous master. In the commands below, rank 0 (the master) is on `gpu1` (`192.168.100.11`).

On `gpu1` (rank 0):

```sh
python3 /opt/aidc/allreduce.py --rank 0 --world-size 2 --master 192.168.100.11 --port 29500 --elements 500000 --iters 30
```

On `gpu3` (rank 1):

```sh
python3 /opt/aidc/allreduce.py --rank 1 --world-size 2 --master 192.168.100.11 --port 29500 --elements 500000 --iters 30
```

(Have both commands typed and ready, then hit Enter on `gpu3` immediately after `gpu1` — the rendezvous master needs to be listening before the worker connects.)

**Now watch the Telemetry pane.** Over the next ~10 seconds, you should see:

- The `Spine ↔ leaf links` panel light up on **two** spine ports — one going to `leaf1` (where `gpu1` is), one going to `leaf2` (where `gpu3` is). Each crests at a few Mbps then settles into a steady pattern as the iterations run.
- The `Aggregate fabric egress` panel show the same total — the sum of those two link rates.
- The `Leaf ↔ worker links` panel show traffic on `leaf1:eth3` (to gpu1) and `leaf2:eth3` (to gpu3).

You're seeing the **VXLAN-encapsulated AllReduce traffic** ride the fabric. Each tick on the chart is 5 s of accumulated TX bytes converted to bps by Prometheus's `rate()`.

> 💡 **Why this matters in AI DCs:** A 2-rank AllReduce produces 2 TCP flows (one in each direction). With only 2 flows, ECMP hashing puts both flows on whichever spine the 5-tuple hash picks — so you'll typically see traffic on ONE spine, not both. This is expected at small flow counts. The 8-rank version below produces 56 flows, and that's when ECMP gets to do its job.

When both ranks print `OK` and exit, click the checkpoint. It re-runs the same 2-rank collective and asserts that Prometheus recorded > 1 Mbps on at least one spine link during the run.

<checkpoint name="traffic_visible_2rank" label="2-rank AllReduce shows traffic on the spines" />

---

## Step 6: Run the full 8-rank AllReduce — watch ECMP spread

This is the headline of the lab. Open eight worker terminals (`gpu1`..`gpu8`) — open `gpu1` first, then the others.

Or, easier: skip the by-hand version and just click the **traffic_visible_8rank_ecmp** checkpoint below. The orchestrator runs the 8-rank collective for you, then queries Prometheus.

**Either way, watch the Telemetry pane while it runs:**

- `Aggregate fabric egress` should jump to **tens of Mbps** during the reduce phase.
- `Spine ↔ leaf links` should light up on **most or all** of the 8 spine-leaf ports. The exact split between spine1 and spine2 depends on the 5-tuple hash of the 56 TCP flows — typical splits are 60/40 to 50/50, with all-or-nothing being rare.
- `Leaf ↔ worker links` should show traffic on every leaf's `eth3` and `eth4` — all 8 worker ports active.

> 💡 **Why this matters in AI DCs:** This is the **ECMP balance** chart, and it's the first one a hyperscaler operator looks at when fabric-side throughput is below expectations. Imbalanced ECMP is a real problem at scale — a few "elephant flows" hashing to the same path cause head-of-line blocking that the rest of the fabric can't compensate for. Production fabrics often use *adaptive* routing (dynamic load-aware path selection) instead of static ECMP for exactly this reason. But ECMP is the baseline; this is what its limits look like.

The checkpoint passes when **≥6 of the 8 spine-leaf links** carry > 1 Mbps simultaneously. (Six, not eight, on purpose — perfect 8/8 balance is unlikely with only 56 flows.)

<checkpoint name="traffic_visible_8rank_ecmp" label="8-rank AllReduce spreads across ≥6 of 8 spine-leaf links" />

---

## Step 7: the sysctl that makes per-flow ECMP work (and breaks if you forget it)

The clean ECMP spread you just saw in Step 6 hides a Linux default that, in production, has cost more than one AI team a week of "why is our fabric underperforming." Let's expose it.

Open a `leaf1` console. Check the current multipath hash policy:

```sh
sysctl net.ipv4.fib_multipath_hash_policy
```

It should read `1`. The lab's bootstrap script set it. **Now break it on purpose** — flip every leaf to the Linux default of `0`:

On each of `leaf1`, `leaf2`, `leaf3`, `leaf4` (open all four consoles):

```sh
sysctl -w net.ipv4.fib_multipath_hash_policy=0
```

Now re-click the **traffic_visible_8rank_ecmp** checkpoint above and watch the **Spine ↔ leaf links** panel as the 8-rank collective runs.

You'll see a very different shape from Step 6:

- One spine ↔ leaf pair lit for each of the four destinations, the other dark
- A systematic pattern like `spine1:eth1` + `spine1:eth2` carrying everything to leaf1 + leaf2, while `spine2:eth1` + `spine2:eth2` sit at zero (or the mirror image)
- The "ECMP balance" stat panel goes lopsided — one spine handles most of the traffic
- The checkpoint may now **fail** with "only 4/8 links carried traffic"

> 💡 **What just happened.** Linux's default `fib_multipath_hash_policy=0` hashes only the outer L3 header — outer src IP + outer dst IP. For VXLAN-encapsulated traffic, both of those are the source and destination VTEP loopbacks (e.g. `10.0.10.1 → 10.0.10.3`). They're identical for every packet between any two given leaves. So the kernel's ECMP decision is fully determined by *which leaf pair* this packet is for — not by *which inner flow* it carries. All 56 Gloo TCP flows between leaf1's workers and leaf3's workers ride the same spine. The routing table looks ECMP-correct (`B>q ... via spine1 ... via spine2`) but the dataplane only ever picks one path per VTEP pair.

Restore per-flow ECMP on every leaf:

```sh
sysctl -w net.ipv4.fib_multipath_hash_policy=1
```

Re-run the checkpoint. Load-spread is back. The chart fills evenly across all (or most) 8 spine-leaf links.

> 💡 **Why this matters in AI DCs.** Policy=1 includes L4 (UDP src+dst port) in the hash. Linux VXLAN computes the *outer* UDP source port by hashing the *inner* flow's 5-tuple — so each inner TCP flow gets a distinct outer src port, and the underlay's ECMP can finally distinguish them. NCCL and Gloo both assume per-flow ECMP works: a 1024-GPU collective produces ~1M concurrent flows, and a fabric that pins per-VTEP-pair turns that into ~512 fat tunnels with massive head-of-line blocking. Production hyperscalers always set this sysctl. It's the kind of one-line config that doesn't appear in any tuning guide because everyone who's deployed an AI fabric has it burned into their memory — and everyone who hasn't, learns the hard way when their training throughput sits at 30% of theoretical.

Leave policy=1 on all four leaves before moving on.

---

## Wrap-up

You now have a working streaming-telemetry pipeline over a live AI fabric, and you've seen what AllReduce traffic actually looks like on the wire. The dashboard you're looking at is the foundation for everything that comes next — **Lab 5 (failure injection)** will use this same dashboard to show BGP/EVPN reconvergence in real time while AllReduce keeps running.

Click **Submit ✓** to run all six checks in sequence. The 2-rank and 8-rank traffic checks each take ~30-45 s because they have to actually run a collective.

If any check fails, see [`lab4-solution.md`](lab4-solution.md) for the common-mistakes table.
