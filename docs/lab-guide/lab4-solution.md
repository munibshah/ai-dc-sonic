# Solution — Lab 4

> Look at this **after** you've tried [`lab4-exercise.md`](lab4-exercise.md). Lab 4 has no FRR/SONiC config to "solve" — the fabric you start with is the fabric you end with. The "solution" is the procedural script for generating traffic that satisfies the checkpoints, plus the common-mistakes table for when something's off.

---

## What "Solve ✓" does for Lab 4

Clicking **Solve** does **not** change any switch config (`SOLVE_STATE == BOOTSTRAP_STATE == _overlay_workers`). It re-runs the same lifecycle hook that `Start ▶` runs:

1. Re-delivers `/opt/aidc/allreduce.py` to every worker.
2. Re-enables the `telemetry` feature on every switch.
3. POSTs `/api/admin/provisioning/dashboards/reload` to Grafana.

This is intentional. Lab 4's pedagogical core is the **learner** running AllReduce while watching the chart — having Solve do it for you would rob the moment. The checkpoints (5 and 6) run their own AllReduces internally; that's enough.

---

## The full set of commands the lab expects

### Step 5 — 2-rank AllReduce (gpu1 + gpu3)

Open `gpu1` and `gpu3` consoles. On `gpu1`:

```sh
python3 /opt/aidc/allreduce.py --rank 0 --world-size 2 --master 192.168.100.11 --port 29500 --elements 500000 --iters 30
```

On `gpu3` (immediately after starting rank 0):

```sh
python3 /opt/aidc/allreduce.py --rank 1 --world-size 2 --master 192.168.100.11 --port 29500 --elements 500000 --iters 30
```

The rendezvous master (rank 0) must be listening before any other rank attempts to connect. If `gpu3` errors out with a connection refused on `192.168.100.11:29500`, restart with `gpu1` first.

### Step 6 — 8-rank AllReduce (gpu1..gpu8)

Easiest: just click the **traffic_visible_8rank_ecmp** checkpoint. It runs the collective and asserts the dashboard pattern.

If you want to run it by hand for the visual: open all 8 worker consoles. On `gpu1`:

```sh
python3 /opt/aidc/allreduce.py --rank 0 --world-size 8 --master 192.168.100.11 --port 29500 --elements 1000000 --iters 20
```

Then on `gpu2`..`gpu8`, the same command with `--rank` set to 1..7 respectively.

---

## Reading the dashboard like an operator

| What you see | What it means |
|---|---|
| All 8 lines on **Spine ↔ leaf links** flat at zero | Fabric is idle (no AllReduce, or AllReduce hasn't started yet) |
| 2 lines on **Spine ↔ leaf links** spike, the rest flat | 2-rank AllReduce in progress; ECMP picked one spine path for each direction |
| All 8 lines on **Spine ↔ leaf links** active, ≈ proportional | 8-rank AllReduce in healthy ECMP-balanced state — what you want |
| 4 lines on `spine1` lit, 4 on `spine2` dark (or vice versa) | All 56 flows hashed to one spine — possible at low flow counts; rerun the collective to get a different hash |
| Systematic pattern: leaf1+leaf2 inbound on spine1, leaf3+leaf4 inbound on spine2 (or any per-leaf-pair pin) | **Per-tunnel ECMP, not per-flow.** Linux default `fib_multipath_hash_policy=0` hashes only outer src/dst IP, so every flow between leafA→leafB rides the same spine. Fixed by `sysctl -w net.ipv4.fib_multipath_hash_policy=1` on every leaf (bootstrap-switch.sh sets this automatically now). |
| One link saturated at line rate, others mid-range | Hot link — could be a slow worker, an elephant flow, or hash skew; in production you'd switch to adaptive routing |
| `Aggregate fabric egress` drops to zero during a run | Fabric outage mid-collective — check BGP sessions on `make bgp-check` |

### Why `fib_multipath_hash_policy=1` matters in AI DCs

This is one of the most important sysctls in a hyperscale GPU fabric and it's easy to miss. Linux's IPv4 multipath default is L3-only: outer src+dst IP. For VXLAN-encapsulated traffic, the outer src+dst are the source and destination VTEP loopbacks — constant for every packet between two given leaves. ECMP becomes per-VTEP-pair, not per-flow.

Policy=1 adds L4 (UDP src+dst ports). Linux VXLAN computes the outer UDP source port by hashing the *inner* flow's 5-tuple, so each inner TCP flow gets a distinct outer src port. The underlay's ECMP hash now picks a different spine per inner flow — exactly what you want for an AllReduce's N² mesh.

NCCL on production AI DCs assumes per-flow ECMP. Without it, a 1024-GPU training cluster looks like ~32 fat per-pair tunnels instead of ~1M per-flow paths, and effective bandwidth craters.

---

## gnmic config → PromQL mapping

The dashboard queries are deliberately keyed off **`aidc_netdev_*`** metrics from the orchestrator's netdev exporter, not raw OpenConfig paths from gnmic. Reason: sonic-vs's gNMI doesn't see the clab veths that actually carry fabric traffic — only the synthetic SONiC ports — so the OpenConfig counters stay at zero. See [ADR](../../notes/decisions.md) on the dual-collector setup.

When you graduate this dashboard to real hardware, swap the per-port queries from:

```promql
rate(aidc_netdev_tx_bytes_total{device=~"spine.*",interface=~"eth[1-4]"}[30s]) * 8 / 1e6
```

to:

```promql
rate(aidc_interfaces_interface_state_counters_out_octets{source=~"spine.*"}[30s]) * 8 / 1e6
```

The `source` label is gnmic's name for the target; the metric name is what gnmic produces from `/interfaces/interface/state/counters/out-octets` with hyphen→underscore translation.

---

## Common mistakes

| Symptom | Likely cause | Fix |
|---|---|---|
| Telemetry pane shows "Loading telemetry…" forever, browser console shows a CORS / X-Frame-Options error | Grafana's `GF_SECURITY_ALLOW_EMBEDDING` not set in `topo/aidc.clab.yml`, or container restarted with stale env | Verify the env block on the `grafana` node in `topo/aidc.clab.yml`; redeploy with `make redeploy-ui` is **not** enough — telemetry containers are part of the clab topo, so `make down && make warm`. |
| All Prometheus targets up but `count(aidc_netdev_tx_bytes_total)` returns 0 | Orchestrator's `/metrics/netdev` endpoint isn't responding, or `docker exec` into switches is failing | From the host: `curl http://localhost:8000/metrics/netdev` and confirm the output has `aidc_netdev_*` lines. If empty, check orchestrator logs (`docker logs orchestrator`); a likely cause is the docker.sock bind not working. |
| 2-rank AllReduce hangs forever on `gpu3` with "connection refused" | Rendezvous master (`gpu1`) not running yet, or got killed earlier and port `29500` is in TIME_WAIT | Cancel both ranks with Ctrl-C, then start `gpu1` (rank 0) first, wait 1 s, then start `gpu3` (rank 1). |
| 8-rank AllReduce passes but only 4 of 8 spine-leaf links carry traffic | All flows hashed to one spine (extreme ECMP skew) | This is allowed by the checkpoint as long as ≥6 of 8 links carry traffic; if you see only 4, retry — different process startup ordering produces different 5-tuple hashes and usually re-balances. |
| `baseline_low_traffic` fails with "fabric not idle: max spine-link is X.X Mbps" | A previous AllReduce is still running, or a leftover test process is generating traffic | Wait 30 s and click the check again. If still failing: `make ping-mesh` to confirm fabric still works, then `docker exec gpu1 pkill -f allreduce.py` (and similarly on other workers) to clean up any stragglers. |
| Grafana panels show "No data" even though Prometheus has data | Grafana datasource UID mismatch (provisioning JSON references `Prometheus` but Grafana auto-generated a different UID) | Open the panel → Edit → pick the Prometheus datasource manually from the dropdown to confirm. If the dashboard JSON references the wrong UID, fix `telemetry/grafana/dashboards/aidc-lab4-fabric.json` to use `${datasource}` or the literal name `Prometheus`. |

---

## What this lab did *not* teach (and where it goes)

- **Queue depth + ECN marks.** Real production telemetry includes per-queue depth on every port plus ECN-marked-packets counters. Required for understanding incast and PFC. The virtualized SONiC image doesn't expose these in any usable form; on hardware, gNMI's `/qos/...` subtree covers it. A future lab could pair this with sFlow on the workers for flow-level visibility (see [ADR-007](../../notes/decisions.md)).
- **gNMI to multiple receivers.** Production fabrics often have several collectors (one for monitoring, one for analytics, one for compliance). gnmic supports multiple outputs in parallel — InfluxDB, Kafka, NATS, file — but Lab 4 keeps it to one (Prometheus) for clarity.
- **Alerting.** Prometheus has an alertmanager companion that fires on PromQL conditions; Grafana has its own alerts subsystem. Both are skipped here — a single learner clicking through a dashboard doesn't need 3 AM pages.
- **Network-wide event correlation.** When a link drops, a real telemetry pipeline correlates the BGP state change, the FRR log, the interface-down event, the dropped-packet counter spike, and the AllReduce error all in one timeline. That's what **Lab 5 (failure injection)** will build on top of this stack.
