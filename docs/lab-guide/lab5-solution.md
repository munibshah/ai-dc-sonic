# Solution — Super spines: worksheet answers + reference config

This is a conceptual lab. There's nothing to type, so there's nothing to copy-paste. What this doc has is:

1. The **worksheet answers** for the radix math the exercise walks through.
2. The **reference FRR config** a real super-spine tier would use — for when you want to see the actual BGP shape, not just discuss it.
3. A **common-mistakes** table for the inspection checkpoints (the four most likely things that turn a passing check into a failing one).

---

## 1 — Radix math worksheet

The exercise asks you to plug into:

> **Max workers per pod = (leaf-facing ports per spine) × (worker-facing ports per leaf)**

For *this* lab's fabric:

| Quantity | Value | How you read it |
|---|---|---|
| Leaf-facing ports per spine | **4** | `ip -br link show` on spine1 → eth1..eth4 each go to a leaf |
| Worker-facing ports per leaf | **2** | `ip -br link show` on leaf1 → eth1=spine1, eth2=spine2, eth3=gpu1, eth4=gpu2 |
| **Max workers per pod** | **8** | 4 × 2 — your current pod is at its ceiling |

For a real commodity 32-port-radix design:

| Quantity | Value |
|---|---|
| Leaf-facing ports per spine | 32 (assuming all ports point at leaves) |
| Worker-facing ports per leaf | 32 (assuming half the ports go up to spines, the other 32 to workers, on a 64-port leaf) |
| **Max workers per pod** | **1024** |

That's the number you'll see quoted in every "this is what one pod of our AI fabric looks like" diagram. It isn't arbitrary — it falls out of the radix you bought.

For 256-port silicon (modern hyperscaler-class):

| Quantity | Value |
|---|---|
| Leaf-facing ports per spine | 256 |
| Worker-facing ports per leaf | 256 |
| **Max workers per pod** | **65,536** |

Still bounded, just by a bigger number. The super spine is what lets a fabric carry *more* than this in a single failure-isolated cluster.

---

## 2 — Reference FRR config (what a super-spine tier *would* look like)

If this platform deployed `supersp1` and `supersp2` containers above the current spines, this is the FRR config they (and the spines) would run. Every block follows patterns you already used in Labs 1 and 2 — same `peer-group` discipline, same shared-AS-tier teaching choice ([ADR-002](../../notes/decisions.md)), same numbered /31 addressing ([ADR-001](../../notes/decisions.md)).

### IP allocation

```
supersp1 lo  : 10.0.0.101/32
supersp2 lo  : 10.0.0.102/32

supersp1 ↔ spine1   10.3.1.0/31    (supersp1 .0,  spine1 .1)
supersp1 ↔ spine2   10.3.1.2/31    (supersp1 .2,  spine2 .3)
supersp2 ↔ spine1   10.3.2.0/31    (supersp2 .0,  spine1 .1)
supersp2 ↔ spine2   10.3.2.2/31    (supersp2 .2,  spine2 .3)
```

`10.3.0.0/16` is the next clean /16 — `10.0.x.x` is loopbacks, `10.1.x.x` is spine↔leaf, `10.2.x.x` is worker /31s ([`workers/entrypoint.sh`](../../workers/entrypoint.sh)), `192.168.100.0/24` is overlay.

### `supersp1/frr.conf`

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

### `supersp2/frr.conf`

```
frr defaults datacenter
hostname supersp2
log syslog informational
service integrated-vtysh-config
!
interface lo
 ip address 10.0.0.102/32
!
interface eth1
 description to_spine1
 ip address 10.3.2.0/31
!
interface eth2
 description to_spine2
 ip address 10.3.2.2/31
!
router bgp 64999
 bgp router-id 10.0.0.102
 bgp bestpath as-path multipath-relax
 no bgp default ipv4-unicast
 neighbor SPINES peer-group
 neighbor SPINES advertisement-interval 0
 neighbor SPINES timers 3 9
 neighbor 10.3.2.1 remote-as 65000
 neighbor 10.3.2.1 peer-group SPINES
 neighbor 10.3.2.1 description spine1
 neighbor 10.3.2.3 remote-as 65000
 neighbor 10.3.2.3 peer-group SPINES
 neighbor 10.3.2.3 description spine2
 !
 address-family ipv4 unicast
  network 10.0.0.102/32
  maximum-paths 64
  neighbor SPINES activate
  neighbor SPINES soft-reconfiguration inbound
 exit-address-family
!
line vty
!
```

### `spine1/frr.conf` additions

The spine config from [`configs/frr/_overlay_workers/spine1/frr.conf`](../../configs/frr/_overlay_workers/spine1/frr.conf) gains two new interface blocks and a `SUPERSPINES` peer-group — everything else (the LEAVES block, the EVPN AF) stays as-is.

```
! Existing _overlay_workers config unchanged above.

interface eth5
 description to_supersp1
 ip address 10.3.1.1/31
!
interface eth6
 description to_supersp2
 ip address 10.3.2.1/31
!
router bgp 65000
 ! ... existing LEAVES peer-group block unchanged ...
 neighbor SUPERSPINES peer-group
 neighbor SUPERSPINES advertisement-interval 0
 neighbor SUPERSPINES timers 3 9
 neighbor 10.3.1.0 remote-as 64999
 neighbor 10.3.1.0 peer-group SUPERSPINES
 neighbor 10.3.1.0 description supersp1
 neighbor 10.3.2.0 remote-as 64999
 neighbor 10.3.2.0 peer-group SUPERSPINES
 neighbor 10.3.2.0 description supersp2
 !
 address-family ipv4 unicast
  ! ... existing LEAVES activate / network blocks unchanged ...
  neighbor SUPERSPINES activate
  neighbor SUPERSPINES soft-reconfiguration inbound
 exit-address-family
 ! Note: SUPERSPINES are NOT activated under address-family l2vpn evpn.
 ! Super spines transit the underlay; EVPN signaling stays inside the pod.
```

Spine2's additions are symmetric — eth5: `10.3.1.3/31` to supersp1, eth6: `10.3.2.3/31` to supersp2; SUPERSPINES neighbors `10.3.1.2` and `10.3.2.2`.

### Notable design choices

- **Shared AS 64999** for both super spines. Same teaching choice as your two spines today (ADR-002). Standard eBGP own-AS rejection prevents loops; no `allowas-in` needed. Production designs sometimes use per-super-spine ASNs for traffic engineering — out of scope here.
- **EVPN AF deliberately off** on the super-spine tier. The thesis is underlay scaling. A multi-pod EVPN design adds route-reflector and RT-filtering questions that don't fit this lab. The underlay still carries the next-hop reachability EVPN needs end-to-end.
- **`maximum-paths 64`** on both tiers — same as your existing fabric (per ADR-001 / the existing canonical configs). Enables the ECMP picture you'd want.

---

## 3 — Common mistakes for the inspection checkpoints

The Lab 5 checkpoints inspect the existing healthy fabric, so they should pass against any Lab-4-solved state. When they don't, the failure is almost never about Lab 5 itself — it's about the fabric being in a non-healthy state. Top causes, in priority order:

| Symptom | Cause | Fix |
|---|---|---|
| Checkpoint 1 (`fabric_healthy_two_tier`) fails — one or more switches missing Established peers | A BGP session dropped (most often: someone in a previous lab session left a switch with a half-applied config; less often: SONiC's gNMI-feature toggle wiped overlay state per CLAUDE.md pitfall #15) | **Reset ↺** to re-apply `_overlay_workers`. If still broken, run `make fabric-bootstrap` from the host. |
| Checkpoint 3 (`per_pod_ecmp_observed`) fails with "1 active nexthop" instead of 2 | One of leaf1's spine sessions is down. Failing-but-Established sessions are rare; usually one whole session has dropped — Checkpoint 1 will have caught it. If both spine sessions look Established but ECMP still reports 1 path, it's likely a transient BGP table churn — wait ~10s and re-check | Re-click Check. If persistent, **Reset ↺**. |
| Checkpoint 3 fails with "leaf1 has no route to 10.0.10.3" | leaf3 dropped its loopback advertisement — almost always means leaf3's BGP session to one (or both) spines is down | **Reset ↺**, wait 30s, re-check |
| Submit ✓ runs but the ping mesh reports <56 OK | Worker eth1 IPs are not on `192.168.100.0/24` — usually means a previous Lab-1 session reset workers to /31 underlay and the orchestrator hasn't re-applied Lab-4's `solve_extra` since. (Lab 5 BOOTSTRAP doesn't run Lab 4's worker-overlay setup, so if Lab 4 wasn't the last-solved lab, workers are in the wrong state.) | Click into **Lab 4**, click **Solve**, then come back to Lab 5 |
| One worker (e.g. gpu7) is the only one failing pings in the mesh | That worker's eth1 lost its overlay IP (manual edit in a console session is the usual culprit) | Open the gpu's console, run `ip addr add 192.168.100.<10+id>/24 dev eth1 && ip link set eth1 up` — or just click **Lab 4 → Solve** to re-apply all 8 worker IPs |
| `vtysh -c "show ip route 10.0.10.3 json"` returns no output | FRR-on-SONiC sometimes takes a moment to populate the JSON view after a fresh `vtysh -b`. If the non-JSON form (`show ip route 10.0.10.3`) returns a B>* line, the route is there — just retry the JSON form after a few seconds | Retry, or use the non-JSON form to confirm by eye |

---

## 4 — Want to revert?

Click **Solve** or **Reset** — both re-apply the `_overlay_workers` baseline. No-op on a conceptual lab.

Confirm:

```sh
docker exec leaf1 vtysh -c "show bgp ipv4 unicast summary" | grep '^10\.' | wc -l   # expect 2
docker exec spine1 vtysh -c "show bgp ipv4 unicast summary" | grep '^10\.' | wc -l  # expect 4
docker exec gpu1 ping -c1 -W2 192.168.100.13                                         # expect OK
```

(Without the `ipv4 unicast` AF qualifier, FRR prints both the IPv4 unicast and L2VPN-EVPN summary blocks and the count doubles.)

Then click **Start ▶** to begin Lab 5 again, or move forward to **Lab 6** when it ships.
