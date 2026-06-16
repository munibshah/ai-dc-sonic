# Solution — GPUs on the overlay + AllReduce: every command you need

Just the commands. The *why* behind each one lives in [`lab3-exercise.md`](lab3-exercise.md); this doc is the answer key.

> **Shortcut**: if you'd rather skip the exercise, click **Solve** in the top bar — the orchestrator drops the Lab 3 canonical FRR config + `overlay-setup.sh` onto every leaf (which retires the worker `/31` IPs and attaches `eth3`/`eth4` to the VLAN 1000 bridge), reconfigures every worker's `eth1` onto `192.168.100.X/24`, and delivers `/opt/aidc/allreduce.py`. Your run gets flagged "solved" on the completion screen.

---

## 1 — Attach worker ports to the VLAN 1000 bridge on every leaf

Open each leaf's console and run **four commands per worker port** (`eth3` and `eth4`):

**leaf1, leaf2, leaf3, leaf4 — same eight commands on each:**

```sh
ip addr flush dev eth3
ip link set eth3 master Bridge
bridge vlan add dev eth3 vid 1000 pvid untagged
ip link set eth3 up

ip addr flush dev eth4
ip link set eth4 master Bridge
bridge vlan add dev eth4 vid 1000 pvid untagged
ip link set eth4 up
```

Verify per leaf:

```sh
ip link show eth3 | grep -o "master Bridge"      # expect: master Bridge
ip link show eth4 | grep -o "master Bridge"      # expect: master Bridge
bridge vlan show dev eth3 | grep 1000            # expect: 1000 PVID Egress Untagged
bridge vlan show dev eth4 | grep 1000            # expect: 1000 PVID Egress Untagged
```

---

## 2 — Move every worker onto the overlay subnet

Open each worker's console. Same four commands, only the IP differs:

| Worker | Commands |
|---|---|
| gpu1 | `ip addr flush dev eth1; ip link set dev eth1 mtu 1500; ip addr add 192.168.100.11/24 dev eth1; ip route del default 2>/dev/null` |
| gpu2 | `ip addr flush dev eth1; ip link set dev eth1 mtu 1500; ip addr add 192.168.100.12/24 dev eth1; ip route del default 2>/dev/null` |
| gpu3 | `ip addr flush dev eth1; ip link set dev eth1 mtu 1500; ip addr add 192.168.100.13/24 dev eth1; ip route del default 2>/dev/null` |
| gpu4 | `ip addr flush dev eth1; ip link set dev eth1 mtu 1500; ip addr add 192.168.100.14/24 dev eth1; ip route del default 2>/dev/null` |
| gpu5 | `ip addr flush dev eth1; ip link set dev eth1 mtu 1500; ip addr add 192.168.100.15/24 dev eth1; ip route del default 2>/dev/null` |
| gpu6 | `ip addr flush dev eth1; ip link set dev eth1 mtu 1500; ip addr add 192.168.100.16/24 dev eth1; ip route del default 2>/dev/null` |
| gpu7 | `ip addr flush dev eth1; ip link set dev eth1 mtu 1500; ip addr add 192.168.100.17/24 dev eth1; ip route del default 2>/dev/null` |
| gpu8 | `ip addr flush dev eth1; ip link set dev eth1 mtu 1500; ip addr add 192.168.100.18/24 dev eth1; ip route del default 2>/dev/null` |

Verify per worker:

```sh
ip -br -4 addr show eth1                                 # expect: eth1  UP  192.168.100.<10+id>/24
ip link show eth1 | head -1 | grep -o "mtu [0-9]*"       # expect: mtu 1500
```

---

## 3 — Verify reachability

From `gpu1` (or any worker):

```sh
ping -c 2 192.168.100.13                                       # gpu3, cross-leaf
for i in 11 12 13 14 15 16 17 18; do
  ping -c 1 -W 1 -q 192.168.100.$i >/dev/null && echo OK $i || echo FAIL $i
done
```

Expected: every ping succeeds. The full mesh check ignores its own IP, so you'll see one OK with `time=0.0ms` (the local loopback case) and seven proper round-trips.

---

## 4 — Run a 2-rank Gloo AllReduce by hand

On **`gpu3`** first (rank 1, starts in background):

```sh
python3 /opt/aidc/allreduce.py --rank 1 --world-size 2 --master 192.168.100.11 --elements 50000 --iters 3 &
```

Then on **`gpu1`** (rank 0, foreground):

```sh
python3 /opt/aidc/allreduce.py --rank 0 --world-size 2 --master 192.168.100.11 --elements 50000 --iters 3
```

Expected output on gpu1 (within ~5 seconds):

```
[rank 0 @ gpu1] init_process_group master=192.168.100.11:29500 ...
[rank 0 @ gpu1] joined world of 2
[rank 0 @ gpu1] OK avg=12.3ms min=10.1ms max=15.4ms elements=50000 world=2 effective_bw=130Mbps
```

(Bandwidth + timing numbers will vary; the important part is the `OK` line — it means the collective completed and every rank's tensor summed to `sum(0..1) = 1`.)

---

## 5 — 8-rank AllReduce + final verification

Click **Submit ✓** in the top bar. The orchestrator re-runs every checkpoint plus the 8-rank AllReduce as the headline check.

Expected: all 6 checkpoints green, lab stamps as **Passed**, completion screen appears.

---

## Appendix A — Common mistakes

The most likely things to go wrong with this lab, in priority order (start at the top when something's broken):

| Symptom | Cause | Fix |
|---|---|---|
| AllReduce hangs at the warmup `all_reduce` call: rendezvous prints `joined world of N`, then both ranks time out 60 s later with `Read error ... Connection timed out` on a random high port — **even though `ping` between the same workers succeeds** | Forgot `ip link set dev eth1 mtu 1500` on at least one worker. The clab veth default is MTU 9500, but the leaves' `vtep-1000` device defaults to MTU 1500. The kernel negotiates TCP MSS=9460 and Gloo's first real data write exceeds the VTEP, so every full-size segment is silently dropped at encap. Pings work (tiny) and the rendezvous on port 29500 works (tiny), but the actual collective dies. | On every worker: `ip link show eth1 \| head -1 \| grep -o "mtu [0-9]*"`. The one showing `mtu 9500` is the culprit. Run `ip link set dev eth1 mtu 1500` on it (or all of them if unsure — idempotent), then re-run the AllReduce. |
| `worker_overlay_ping` fails: gpu1 can't reach gpu3 (or any cross-leaf peer) | Forgot `bridge vlan add dev ethN vid 1000 pvid untagged` on one of the leaves. The veth is enslaved to the bridge but only in VLAN 1 (the default), so frames go into a different broadcast domain than the rest of VLAN 1000. | On the broken leaf: `bridge vlan show dev eth3` (and eth4). If you don't see `1000 PVID Egress Untagged`, run `bridge vlan add dev eth3 vid 1000 pvid untagged` (and the same for eth4). |
| `worker_overlay_ping` fails: gpu1 can't even reach gpu2 (same leaf) | Forgot `ip addr flush dev eth1` on a worker, so it still carries the `/31` underlay IP and the kernel sends out the wrong source IP for 192.168.100.X destinations. | On the broken worker: `ip addr show eth1` — if you see both addresses, `ip addr flush dev eth1`, then re-add `192.168.100.<10+id>/24`. |
| AllReduce hangs forever (no OK line, no error) | Rendezvous can't complete because rank 0's IP isn't reachable from all other ranks. Almost always means one worker hasn't completed the overlay setup yet. | From every gpuN, try `ping -c 1 192.168.100.11`. The one that fails is the one whose overlay setup is incomplete. Re-check its `ip -br -4 addr show eth1`. |
| AllReduce fails immediately with a `socket.error` / `connection refused` | Tried to use a different master IP than `192.168.100.11` (gpu1's IP), but gpu1 isn't rank 0. The script binds rank 0's TCP store on whatever `--master` you pass; non-rank-0 workers then dial that IP expecting rank 0 to be there. | Use `--master 192.168.100.<10+rank0_id>` consistently across all ranks. If rank 0 is gpu1, master is `192.168.100.11`. |
| `leaf_bridge_members` fails: leaf eth3 shows as not enslaved to Bridge | Either the `ip link set eth3 master Bridge` command didn't run, or it ran *before* SONiC's `Bridge` device existed (e.g. before the overlay-setup primitives from Lab 2 were re-applied on Start). | On the broken leaf: `ip link show Bridge` — if it doesn't exist, something is wrong with the Lab 2 overlay state, click Reset and try Lab 3 again. Otherwise, re-run the four commands for eth3 and eth4. |
| `worker_full_mesh_overlay` fails on a specific pair (e.g. gpu2 ↔ gpu5) | One worker on each end is OK individually but the bridge fdb on a leaf doesn't have the remote MAC yet — usually a transient warm-up issue. | Just wait 5 seconds and try again, or send one extra ping. EVPN Type-2 routes converge in ~1-2s; the first cross-leaf packet pair always has a small warmup penalty. |
| AllReduce completes on 2 ranks but fails on 8 with a timeout | Some workers' overlay setup is incomplete OR the leaf bridge for one leaf isn't right — 2-rank only needs the gpu1↔gpu3 path; 8-rank needs every pair. | Run the full mesh ping (Step 5) first. If it passes 56/56, the AllReduce will work. If not, fix whatever the mesh exposed before retrying. |
| `ip route del default` says "Cannot find device" or similar harmless error | Default route was already removed (e.g. from a previous attempt). The `2>/dev/null` redirects the noise. | Ignore — it's idempotent. |
| Started rank 0 before rank 1 in the manual 2-rank run; rank 0 just hangs | Gloo's rendezvous waits forever for all ranks to join. Rank 0 isn't crashed, it's waiting for rank 1 to dial in. | Either start rank 1 in another terminal (it'll join, the collective will run, both will exit), or Ctrl-C rank 0 and start over in the documented order (rank 1 in background first). |

---

## Appendix B — What the Lab 3 canonical FRR config looks like (for reference)

Compared to Lab 2's `_overlay/leaf1/frr.conf`, the Lab 3 `_overlay_workers/leaf1/frr.conf` differs in two places:

```diff
 interface eth2
  description to_spine2
  ip address 10.1.2.1/31
 !
-interface eth3
- description to_gpu1
- ip address 10.2.1.0/31
-!
-interface eth4
- description to_gpu2
- ip address 10.2.1.2/31
-!
 router bgp 65101
  ...
  address-family ipv4 unicast
   network 10.0.1.1/32
   network 10.0.10.1/32
-  network 10.2.1.0/31
-  network 10.2.1.2/31
   maximum-paths 64
   ...
```

The worker `/31`s are gone — they no longer exist at the L3 layer, so there's nothing to advertise and nothing for the interface stanzas to configure. The corresponding overlay-setup.sh additionally runs:

```sh
for IFACE in eth3 eth4; do
  ip addr flush dev "$IFACE" 2>/dev/null || true
  ip link set "$IFACE" nomaster 2>/dev/null || true
  ip link set "$IFACE" master Bridge
  bridge vlan del dev "$IFACE" vid 1 2>/dev/null || true
  bridge vlan add dev "$IFACE" vid 1000 pvid untagged
  ip link set "$IFACE" up
done
```

That's exactly what you typed during the exercise, except idempotent (with `|| true` guards) so it survives re-application during Reset / Solve.

---

## Appendix C — The AllReduce script in five sentences

`/opt/aidc/allreduce.py` lives in [`workers/scripts/allreduce.py`](../../workers/scripts/allreduce.py) and is delivered onto every worker by the orchestrator on Start / Solve. Each invocation specifies its rank (0..world-1), the world size, the master IP (rank 0's overlay IP), tensor size, and iteration count. The script creates a 1D float32 tensor filled with its rank value, AllReduce-sums it across the world, and asserts every element equals `sum(0..world-1)`. After a warmup pass it times `iters` clean runs and reports average, min, max latency plus an effective bandwidth (using the ring-AllReduce ideal `2*(n-1)/n * tensor_bytes / time`). The lab's checkpoint code (`orchestrator/api/checkpoints/lab3.py`) launches one process per worker via `docker exec` in parallel and waits for all to complete.

---

## Appendix D — Want to revert?

Click **Solve** to fully wire Lab 3 end-to-end, or click **Reset** to wipe the worker-on-overlay state and restore Lab 2's baseline (workers back on `/31` underlay, worker ports back to L3, leaf-to-leaf overlay still working). Both buttons are idempotent.

If you want to verify the reset worked (workers are back on underlay):

```sh
docker exec gpu1 ip -br -4 addr show eth1            # expect: eth1  UP  10.2.1.1/31
docker exec leaf1 ip link show eth3 | head -1        # expect: NO "master Bridge"
docker exec leaf1 bridge vlan show dev eth3 2>&1     # expect: empty or "not a bridge port"
docker exec gpu1 ip route show default               # expect: default via 10.2.1.0 dev eth1
```

Then click **Start lab ▶** to re-apply the Lab 2 canonical overlay and begin again.
