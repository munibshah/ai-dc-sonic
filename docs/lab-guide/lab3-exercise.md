# Exercise — Bring the GPUs onto the overlay and run AllReduce

## Scenario

The fabric you finished Lab 2 with is up:

- Underlay: every leaf has two ECMP paths to every other leaf via the spines.
- Overlay: VLAN 1000 (VNI 10100, subnet 192.168.100.0/24) is stretched across all four leaves; leaf-to-leaf ping over `Vlan1000` works.
- Workers: still on `/31` per-leaf underlay links (`gpu1=10.2.1.1`, `gpu3=10.2.2.1`, …) — they reach each other via L3 routing, but not over the overlay.

Your job: **plug the GPUs into the overlay**. After this lab, every `gpu<N>` sits in `192.168.100.0/24` alongside every other GPU, no L3 hops between them from the workload's perspective. Then you'll run a real Gloo AllReduce to prove the data plane carries actual collective traffic.

### Why an AI fabric is shaped this way

Distributed training is full of operations that hate L3:

- **NCCL/Gloo rendezvous** uses TCP broadcast-style discovery; trivial in one subnet, fragile across L3 boundaries.
- **AllReduce** is N² flows between every GPU pair every step. If those flows take L3 hops, every step pays for routing-table lookups, possible asymmetric paths, and BGP convergence on any link drop.
- **Failure recovery** is much cheaper at L2 (ARP refresh) than L3 (BGP convergence + route recomputation).

Production AI pods solve this by putting every GPU in one stretched L2 segment, exactly like the one you built in Lab 2 — but for that pattern to actually deliver value, **the GPUs have to be in the segment, not on per-leaf /31 links to the segment's edge**. That's what this lab fixes.

---

## Step 1: Attach `leaf1`'s worker-facing ports to VLAN 1000

Click **Topology** → `leaf1`. New terminal tab.

### Look at what's there

```sh
ip -br link show | grep eth
bridge vlan show
ip -br -4 addr show | grep eth
```

Expected: `eth3` and `eth4` are `UP`, carry the Lab 1 underlay `/31` IPs (`10.2.1.0/31` on eth3, `10.2.1.2/31` on eth4), and are not yet members of any bridge. `bridge vlan show` shows only the leaf-side overlay devices (`Bridge`, `Vlan1000`, `vtep-1000`) — the worker ports aren't in it yet.

### Move the worker ports into the bridge

Run these four commands for `eth3` (to `gpu1`):

```sh
ip addr flush dev eth3
ip link set eth3 master Bridge
bridge vlan add dev eth3 vid 1000 pvid untagged
ip link set eth3 up
```

Then the same four for `eth4` (to `gpu2`):

```sh
ip addr flush dev eth4
ip link set eth4 master Bridge
bridge vlan add dev eth4 vid 1000 pvid untagged
ip link set eth4 up
```

> 💡 **What just happened, in order**:
> 1. `ip addr flush dev eth3` removes the `10.2.1.0/31` underlay IP from the interface. With no L3 address, the kernel no longer treats this as a routed port.
> 2. `ip link set eth3 master Bridge` makes the veth a slave of the SONiC-created bridge device. From now on, frames in/out of eth3 enter the bridge fdb plane, not the IP stack.
> 3. `bridge vlan add dev eth3 vid 1000 pvid untagged` says: "any frame arriving without a VLAN tag is in VLAN 1000; any frame egressing should leave untagged." That's exactly what a **switchport access vlan 1000** does on a Cisco / Arista switch — the same idea, expressed in Linux bridge primitives.
> 4. `ip link set eth3 up` ensures the link is administratively up. (It was already up, but enslaving an interface to a bridge sometimes shows transient down state on older kernels — being explicit is harmless.)

### Verify

```sh
ip link show eth3
ip link show eth4
bridge vlan show
```

Expected for `ip link show eth3`:

```
12: eth3@if38: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9000 master Bridge state UP ...
```

The key string is `master Bridge`. If you don't see it, the bridge enslavement didn't happen.

Expected for `bridge vlan show`, look for the eth3 and eth4 rows:

```
port              vlan-id
eth3              1000 PVID Egress Untagged
eth4              1000 PVID Egress Untagged
Bridge            1000
Vlan1000          1000
vtep-1000         1000
```

`PVID Egress Untagged` is what makes this an access port.

> 💡 **Don't run the checkpoint yet** — `leaf_bridge_members` checks *all four leaves*, and only leaf1 has its worker ports attached so far. Click it after Step 2.

> 💡 **The leaves' frr.conf still has `ip address 10.2.1.0/31` on `eth3`** even though you flushed it at the kernel level. FRR will not re-add it to a bridge slave (zebra is smart about this), so the line in the boot-time config is now stale and can be ignored. The lab's canonical Lab 3 frr.conf — the one **Solve** applies — deletes those `ip address` lines entirely; that's exactly what you'd commit in a production change.

---

## Step 2: Repeat on `leaf2`, `leaf3`, `leaf4`

Exactly the same four commands per worker port. Open each leaf's console and run:

```sh
# For eth3 and then eth4 on each leaf:
ip addr flush dev eth3
ip link set eth3 master Bridge
bridge vlan add dev eth3 vid 1000 pvid untagged
ip link set eth3 up

ip addr flush dev eth4
ip link set eth4 master Bridge
bridge vlan add dev eth4 vid 1000 pvid untagged
ip link set eth4 up
```

After all four leaves are done:

<checkpoint name="leaf_bridge_members" label="Leaves attach worker ports (eth3+eth4) to VLAN 1000 bridge" />


---

## Step 3: Move every worker onto the overlay subnet

The leaves are ready. Now do the same on the workers — each one needs to drop its `/31` underlay IP and pick up its overlay IP. The mapping is:

| Worker | Overlay IP |
|---|---|
| gpu1 | 192.168.100.11/24 |
| gpu2 | 192.168.100.12/24 |
| gpu3 | 192.168.100.13/24 |
| gpu4 | 192.168.100.14/24 |
| gpu5 | 192.168.100.15/24 |
| gpu6 | 192.168.100.16/24 |
| gpu7 | 192.168.100.17/24 |
| gpu8 | 192.168.100.18/24 |

For each worker, open its console and look at what's there

```sh
ip -br link show | grep eth
ip -br -4 addr show | grep eth
```

Run four commands. Example for `gpu1`:

```sh
ip addr flush dev eth1
ip link set dev eth1 mtu 1500
ip addr add 192.168.100.11/24 dev eth1
ip route del default 2>/dev/null
```

Repeat for `gpu2`..`gpu8`, substituting the right IP each time.

> 💡 **No default route needed**: with a `/24` on `eth1`, the kernel auto-installs an on-link route for `192.168.100.0/24`. Every peer GPU and every leaf's `Vlan1000` IP is in that subnet, so there's nothing left for the default route to point at. The old `default via 10.2.1.0` is now both pointing at a dead next-hop (the leaf flushed it) and unnecessary (every workload destination is on-link).

> 💡 **Why a `/24` and not a `/31`?** AllReduce is N²: every GPU pair needs to address every other GPU. With `/31` P2P we'd need every worker to have a route table entry for every other worker. The `/24` is the L2 segment's natural mask — every peer is on-link, no routing required.

> 💡 **Why drop the MTU to 1500?** The worker veth defaults to MTU 9500 (a clab quirk), but the leaf's VXLAN tunnel device (`vtep-1000`) defaults to MTU 1500. With that mismatch the worker negotiates TCP MSS=9460 on the rendezvous handshake and then tries to push ~9.5 KB segments, which exceed the VTEP and get **silently dropped at encap**. Pings still work (small frames fit), and the AllReduce rendezvous on port 29500 still works (tiny messages), but the moment Gloo opens a pair socket and writes a real chunk, every packet vanishes and the collective hangs. Forcing the worker to 1500 makes its MSS=1460 — every TCP segment now fits cleanly through the VTEP. **In a production AI fabric you'd do the opposite**: bump the VTEPs *and* the underlay to jumbo (9000+) end-to-end so collectives can ship 9 KB per segment and saturate the wire. Lab 3 takes the cheap-and-correct path so we keep the focus on the overlay learning, not the MTU yak-shave.

### Verify each worker's overlay IP and MTU

```sh
ip -br -4 addr show eth1
ip link show eth1 | head -1
```

Expected for gpu1:

```
eth1  UP  192.168.100.11/24
<id>: eth1@<peer>: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ...
```

(If `mtu` still shows `9500`, you skipped the `ip link set dev eth1 mtu 1500` line — the AllReduce in Step 7 will hang. If you see a `secondary` IP line, `ip addr flush` was skipped; re-flush and re-add.)

After all eight workers are on the overlay:

<checkpoint name="worker_overlay_ips" label="Workers carry 192.168.100.11..18/24 on eth1"/>

---

## Step 4: First east-west packet

The moment of truth — same as Lab 2's "first overlay packet," but now between actual workloads (workers) rather than between leaves.

Open `gpu1`'s console:

```sh
ping -c 2 192.168.100.13
```

Expected: success.

```
PING 192.168.100.13 (192.168.100.13) 56(84) bytes of data.
64 bytes from 192.168.100.13: icmp_seq=1 ttl=64 time=1.42 ms
64 bytes from 192.168.100.13: icmp_seq=2 ttl=64 time=0.53 ms
```

<checkpoint name="worker_overlay_ping" label="gpu1 → gpu3 overlay ping (first east-west VXLAN packet)" />

> 💡 **What just happened, frame by frame**:
> 1. gpu1's kernel matches `192.168.100.13` as on-link via eth1.
> 2. gpu1 ARPs for `192.168.100.13`'s MAC. ARP request is L2-broadcast.
> 3. leaf1's `Bridge` receives the broadcast on eth3 (gpu1's port), forwards to: VLAN 1000's flood list = (eth4 / gpu2) + (Vlan1000@Bridge / leaf1's local IP) + (vtep-1000 / VXLAN encap to remote VTEPs).
> 4. vtep-1000 encaps the ARP request into a VXLAN packet for each of leaf2/3/4's VTEPs (head-end replication from the Lab 2 EVPN Type-3 routes).
> 5. The underlay routes each VXLAN packet. leaf2 decaps, its Bridge floods VLAN 1000 to eth3 (gpu3) and eth4 (gpu4) and Vlan1000.
> 6. gpu3 sees the ARP for its own IP and replies. Reply rides back to gpu1 over the same path, this time unicast (the bridges learned the MAC on the way out).
> 7. gpu1 sends the actual ICMP echo to gpu3's MAC; leaf1 bridges it to vtep-1000 which encaps for leaf2's VTEP only (unicast — no flooding).
>
> **One ping = first time a workload-originated packet rides your VXLAN tunnel.** Every NCCL/Gloo collective from here on follows the same path.

---

## Step 5: Verify the full 56-pair mesh

Lab 1 ended with the same check, but over `/31` underlay. Now that's all gone — the same mesh ride VXLAN tunnels through the overlay.

From any worker:

```sh
for i in 11 12 13 14 15 16 17 18; do
  ping -c 1 -W 1 -q 192.168.100.$i >/dev/null && echo OK 192.168.100.$i || echo FAIL 192.168.100.$i
done
```

(Skip the line for your own IP.)

Expected: 7 OKs, no FAILs.

You can run the full 56-pair mesh as a checkpoint:

<checkpoint name="worker_full_mesh_overlay" label="Full 56/56 worker ping mesh over overlay" />

---

## Step 6: Look back at EVPN — the Type-2 routes have arrived

Remember Lab 2? Back then `show bgp l2vpn evpn` on a leaf showed **only Type-3** (inclusive-multicast) routes — one per VTEP — because the segment had no hosts on it, just the leaf SVIs. We promised the **Type-2 (MAC) routes** would show up "once real hosts put MACs on the segment." That just happened: the eight GPU workers are now bridged into VLAN 1000, the mesh ping made every leaf learn every worker's MAC, and EVPN advertised each one fabric-wide.

Open `leaf1`'s console (drop out of any worker shell) and look again:

```sh
show bgp l2vpn evpn route type macip      # Type-2 (MAC) routes
show bgp l2vpn evpn route type multicast  # Type-3 (IMET) routes
```

You now have **both** route types — here's the tally:

| Route type | Count | What each one is |
|---|---|---|
| **Type-2 (MAC)** | **8** | one per GPU worker MAC (2 workers per leaf × 4 leaves) |
| **Type-3 (IMET)** | **4** | one per leaf VTEP — the flood list, unchanged since Lab 2 |

(The MAC values are assigned by containerlab and differ per deployment — `aa:c1:ab:…` here — but you'll always see exactly 8 Type-2 routes once all workers are up and have been pinged.)

### Read a Type-2 route

```
Route Distinguisher: 10.0.1.2:2
 *>  [2]:[0]:[48]:[aa:c1:ab:54:28:cd]
                    10.0.10.2(spine1)                 0 65000 65102 i
 *=  [2]:[0]:[48]:[aa:c1:ab:54:28:cd]
                    10.0.10.2(spine2)                 0 65000 65102 i
                    RT:65102:10100 ET:8
```

- `[2]:[0]:[48]:[aa:c1:ab:54:28:cd]` reads as `<RouteType>:<EthTag>:<MAC-len-bits>:<MAC>` — leaf2 announcing "MAC `aa:c1:ab:54:28:cd` lives behind my VTEP." (`MAClen 48`, and **no trailing IP** — we're not doing ARP suppression here, so it's a pure MAC route, not a MAC+IP one.)
- **Next-hop `10.0.10.2`** is leaf2's VTEP, *not* the spine's router-id — the same next-hop preservation you relied on in Lab 2, now carrying MACs. And you learn it via **both** spines (`*>` best + `*=` equal) — ECMP.
- The locally-originated ones (under your own RD `10.0.1.1:2`) show next-hop `10.0.10.1(leaf1)` and weight `32768` — those are leaf1's own two workers' MACs (gpu1, gpu2).

### What changed in the data plane

In Lab 2, with zero MAC routes, every frame BUM-flooded to all VTEPs. Now look at the fdb:

```sh
bridge fdb show dev vtep-1000
```

```
aa:c1:ab:54:28:cd dst 10.0.10.2 self extern_learn    <- unicast: this MAC -> leaf2's VTEP
aa:c1:ab:87:24:de dst 10.0.10.3 self extern_learn
 ...
00:00:00:00:00:00 dst 10.0.10.2 self permanent       <- the old flood entries, still here for true BUM
```

Each remote worker MAC now has a precise **unicast** `dst <VTEP>` entry, flagged `extern_learn` — installed by the **EVPN Type-2 control plane**, not by data-plane learning (`vtep-1000` is still `nolearning`). So a frame to a known GPU is encap'd straight to the one leaf that owns it; only genuine broadcast/unknown-unicast traffic still rides the `00:00:..` flood list. FRR's matching view:

```sh
show evpn mac vni 10100
```

Eight MACs — two `local` (leaf1's own gpu1/gpu2, on `eth3`/`eth4`) and six `remote` (each pointing at another leaf's VTEP).

> 💡 **Why this matters in AI DCs**: Type-2 routes are how an AI fabric scales past flooding. With thousands of GPUs, BUM-flooding every gradient packet to every leaf would melt the fabric. Type-2 gives each leaf an exact MAC→VTEP map, so a NCCL/Gloo flow between two specific GPUs is unicast across exactly one spine→leaf path — the precise, non-wasteful forwarding that collective performance depends on. The Type-3 routes from Lab 2 didn't go away; they're the safety net for the rare genuine broadcast (ARP, rendezvous discovery), while Type-2 now carries the bulk of the east-west traffic. That handoff — flood to learn, then unicast forever after — is the whole point of EVPN.

---

## Step 7: First AllReduce — 2-rank, by hand

You're going to run a real Gloo AllReduce between **gpu1 (rank 0)** and **gpu3 (rank 1)**. They're on different leaves — leaf1 and leaf2 — so every byte of the collective rides a VXLAN tunnel through your underlay.

On GPU1:

```sh
python3 /opt/aidc/allreduce.py --help
```

### Run it

The Gloo rendezvous needs both ranks running at the same time. Pattern: start rank 1 in the background first, then start rank 0 in the foreground.

Open `gpu3`'s console. Start rank 1:

```sh
python3 /opt/aidc/allreduce.py --rank 1 --world-size 2 --master 192.168.100.11 --elements 50000 --iters 3 &
```

The `&` runs it in the background. You'll see `[rank 1 @ gpu3] init_process_group master=192.168.100.11:29500 ...` — it's waiting for rank 0.

Now open `gpu1`'s console and start rank 0:

```sh
python3 /opt/aidc/allreduce.py --rank 0 --world-size 2 --master 192.168.100.11 --elements 50000 --iters 3
```

Expected output on gpu1 within ~5 seconds:

```
[rank 0 @ gpu1] init_process_group master=192.168.100.11:29500 ...
[rank 0 @ gpu1] joined world of 2
[rank 0 @ gpu1] OK avg=39.1ms min=31.2ms max=44.0ms elements=50000 world=2 effective_bw=41Mbps
```

Switch back to gpu3's console — you should see rank 1's `OK` line too.

<checkpoint name="allreduce_2rank" label="Gloo AllReduce across 2 ranks (gpu1 + gpu3)" />

> 💡 **What's happening underneath**: Gloo's CPU AllReduce uses a ring algorithm. With 2 ranks the "ring" is trivial — they swap halves, sum, swap back. Each swap is a TCP send/recv. Both TCP flows ride VXLAN tunnels through your underlay (gpu1 → vtep-1000 on leaf1 → underlay → vtep-1000 on leaf2 → gpu3, and the reverse). The Gloo rendezvous itself — discovering each rank's address — runs over the same overlay path; the `MASTER_ADDR` we passed is `192.168.100.11`, an overlay IP.

> 💡 **About the bandwidth number**: a few tens of Mbps is normal for CPU Gloo + software VXLAN (we measured ~40 Mbps on this fabric; expect anywhere from ~10 to ~100 Mbps depending on host load and the MTU path). The point isn't the absolute throughput — it's that the collective completes, the result is mathematically correct (every rank's sum-tensor matches `sum(0..world-1)`), and you can see effective bandwidth fluctuate with link conditions later. In a real AI fabric this number would be 100-400 Gbps with RDMA + NCCL on real GPUs.

---

## Step 8: 8-rank AllReduce — the lab's finale

The 2-rank case is interesting; the 8-rank case is what real training jobs do. Eight ranks means the ring algorithm has 14 steps (2×(n-1)), every step touches every rank, and the rendezvous handshake is more complex.

Running 8 ranks by hand is messy — you'd need to open 8 terminals and start them in a tight window. That's where **Submit ✓** comes in. The lab's final checkpoint runs the full 8-rank collective for you across all gpus in parallel.

Click **Submit ✓** in the top bar. The orchestrator will:

1. Re-run every step-level checkpoint above.
2. Launch `python3 /opt/aidc/allreduce.py --rank N --world-size 8 --master 192.168.100.11 ...` on each of the 8 workers simultaneously.
3. Wait for all 8 to complete, verify every rank got `sum(0..7) = 28.0` in every iteration.
4. Show you the per-check pass/fail card with timing + effective bandwidth.

Expected: all 6 checkpoints pass within ~30-60 seconds, the lab stamps as **Passed**, and the completion screen appears.

If something fails, here are the four most common gotchas, in priority order:

1. Forgot to flush eth1 / eth3 / eth4 IPs before re-IPing — old IPs persist and create a second secondary that confuses traffic.
2. `bridge vlan add` without `pvid untagged` — frames egress tagged, the other end drops them.
3. Workers ran AllReduce before all overlay reachability worked — Gloo's rendezvous TCP store hangs waiting for ranks that can't reach the master.
4. `ip link set eth3 master Bridge` but forgot `ip link set eth3 up` afterwards — interface goes down briefly during enslavement on some kernels.

---

## Stuck? Want to restart?

| You want to… | Click |
|---|---|
| See the canonical answer for any step |
| Wire the whole overlay end-to-end without typing |
| **Reset** in the top bar |
|**Submit ✓** in the top bar |

