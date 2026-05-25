# Solution — BGP underlay configuration

Full annotated configs for every switch, applied in the order that produces the cleanest progression of `show bgp summary` output. If you only want the answer key, the six `frr.conf` blocks below are it. If you want to *understand* the answer key, the annotations explain the WHY of every block.

> **Shortcut**: `make solve` restores all 6 working configs from git in one command.

---

## Approach

- Per-switch FRR config lives at `configs/frr/<node>/frr.conf` on your laptop.
- `make sync` rsyncs the repo to the remote box.
- `make fabric-bootstrap` runs `bootstrap-switch.sh` inside every switch container, which restarts `zebra` + `bgpd` + `staticd` and runs `vtysh -b /etc/frr/frr.conf` to load the bind-mounted config.
- Order doesn't strictly matter — once both ends of a peering are configured, the session establishes. Pedagogically, going spines-first means you can watch leaves' peers transition from `Active` → `Established` as you add each one.

---

## Step 1 — `spine1` (the worked example)

Write this to `configs/frr/spine1/frr.conf`:

```
! AIDC Lab — spine1 (AS 65000)
frr defaults datacenter
hostname spine1
log syslog informational
service integrated-vtysh-config
!
interface lo
 ip address 10.0.0.1/32
!
interface eth1
 description to_leaf1
 ip address 10.1.1.0/31
!
interface eth2
 description to_leaf2
 ip address 10.1.1.2/31
!
interface eth3
 description to_leaf3
 ip address 10.1.1.4/31
!
interface eth4
 description to_leaf4
 ip address 10.1.1.6/31
!
router bgp 65000
 bgp router-id 10.0.0.1
 bgp bestpath as-path multipath-relax
 no bgp default ipv4-unicast
 neighbor LEAVES peer-group
 neighbor LEAVES advertisement-interval 0
 neighbor LEAVES timers 3 9
 neighbor 10.1.1.1 remote-as 65101
 neighbor 10.1.1.1 peer-group LEAVES
 neighbor 10.1.1.1 description leaf1
 neighbor 10.1.1.3 remote-as 65102
 neighbor 10.1.1.3 peer-group LEAVES
 neighbor 10.1.1.3 description leaf2
 neighbor 10.1.1.5 remote-as 65103
 neighbor 10.1.1.5 peer-group LEAVES
 neighbor 10.1.1.5 description leaf3
 neighbor 10.1.1.7 remote-as 65104
 neighbor 10.1.1.7 peer-group LEAVES
 neighbor 10.1.1.7 description leaf4
 !
 address-family ipv4 unicast
  network 10.0.0.1/32
  maximum-paths 64
  neighbor LEAVES activate
  neighbor LEAVES soft-reconfiguration inbound
 exit-address-family
!
line vty
!
```

### What every block does

- **`frr defaults datacenter`** — sets FRR's CLOS-friendly defaults: KEEPALIVE 3s / HOLDTIME 9s (fast convergence), maximum-paths defaults bumped, etc. The line `neighbor LEAVES timers 3 9` is redundant given this default, but it's explicit and makes the convergence time obvious to a reader.
- **`hostname spine1`** + **`log syslog informational`** — gives `vtysh` a prompt label and makes logs land in `/var/log/syslog` inside the container.
- **`interface lo / ip address 10.0.0.1/32`** — the spine's router-ID lives on the loopback. We also use it as a `network` advertisement target.
- **`interface ethN / ip address <X.Y.Z>/31`** — `/31` per-link addressing (RFC 3021). Spine end is the even address (`.0`, `.2`, `.4`, `.6`); leaf end is the odd address. See [topology §4](../topology.md#4-link-inventory-the-16-links).
- **`router bgp 65000`** — both spines share AS 65000. This is the standard CLOS pattern.
- **`bgp router-id 10.0.0.1`** — explicit instead of inheriting from the highest interface IP, so it's deterministic across reboots.
- **`bgp bestpath as-path multipath-relax`** — required for ECMP across both spines (see Task 4 in the exercise for the *why*).
- **`no bgp default ipv4-unicast`** — disables FRR's auto-activation of the ipv4-unicast AF on every new neighbor. We'll activate explicitly under the peer-group. Standard production pattern.
- **`neighbor LEAVES peer-group`** + **`neighbor 10.1.1.1 peer-group LEAVES`** — declare a peer-group, set common attributes on it once, bind each neighbor to the group. Cuts ~50% of the config.
- **`neighbor LEAVES timers 3 9`** — keepalive 3s / holddown 9s. Fast convergence (≤ 9s) on link failures.
- **`address-family ipv4 unicast`** block:
  - `network 10.0.0.1/32` — advertise our loopback.
  - `maximum-paths 64` — let the FIB hold up to 64 ECMP next-hops.
  - `neighbor LEAVES activate` — explicitly activate the ipv4-unicast AF for everyone in the group.
  - `neighbor LEAVES soft-reconfiguration inbound` — costs a little memory but lets you run `show bgp ipv4 unicast neighbor X received-routes` for debugging.

### Apply + verify after step 1

```bash
make sync && make fabric-bootstrap
make shell-spine1
vtysh -c "show bgp summary"
```

Expected: 4 leaf neighbors, all in `Active` (the leaves don't have BGP configured yet, so the sessions can't establish). That's fine — it'll go `Established` as you finish each leaf.

---

## Step 2 — `spine2`

Mirror of spine1 with these substitutions:
- hostname → `spine2`
- loopback → `10.0.0.2/32`
- router-id → `10.0.0.2`
- spine-side P2P IPs → use the `10.1.2.*` block (spine2 owns spine→leaf paths `10.1.2.0/31`, `10.1.2.2/31`, `10.1.2.4/31`, `10.1.2.6/31`)
- neighbor peer IPs → spine2 talks to leaf1@`10.1.2.1`, leaf2@`10.1.2.3`, leaf3@`10.1.2.5`, leaf4@`10.1.2.7`
- network statement advertises `10.0.0.2/32`

Full file:

```
! AIDC Lab — spine2 (AS 65000)
frr defaults datacenter
hostname spine2
log syslog informational
service integrated-vtysh-config
!
interface lo
 ip address 10.0.0.2/32
!
interface eth1
 description to_leaf1
 ip address 10.1.2.0/31
!
interface eth2
 description to_leaf2
 ip address 10.1.2.2/31
!
interface eth3
 description to_leaf3
 ip address 10.1.2.4/31
!
interface eth4
 description to_leaf4
 ip address 10.1.2.6/31
!
router bgp 65000
 bgp router-id 10.0.0.2
 bgp bestpath as-path multipath-relax
 no bgp default ipv4-unicast
 neighbor LEAVES peer-group
 neighbor LEAVES advertisement-interval 0
 neighbor LEAVES timers 3 9
 neighbor 10.1.2.1 remote-as 65101
 neighbor 10.1.2.1 peer-group LEAVES
 neighbor 10.1.2.1 description leaf1
 neighbor 10.1.2.3 remote-as 65102
 neighbor 10.1.2.3 peer-group LEAVES
 neighbor 10.1.2.3 description leaf2
 neighbor 10.1.2.5 remote-as 65103
 neighbor 10.1.2.5 peer-group LEAVES
 neighbor 10.1.2.5 description leaf3
 neighbor 10.1.2.7 remote-as 65104
 neighbor 10.1.2.7 peer-group LEAVES
 neighbor 10.1.2.7 description leaf4
 !
 address-family ipv4 unicast
  network 10.0.0.2/32
  maximum-paths 64
  neighbor LEAVES activate
  neighbor LEAVES soft-reconfiguration inbound
 exit-address-family
!
line vty
!
```

Apply + verify: same as step 1, but on `spine2`. Both spines now configured; leaves still empty.

---

## Step 3 — `leaf1` (the second worked example)

```
! AIDC Lab — leaf1 (AS 65101)
frr defaults datacenter
hostname leaf1
log syslog informational
service integrated-vtysh-config
!
interface lo
 ip address 10.0.1.1/32
 ip address 10.0.10.1/32
!
interface eth1
 description to_spine1
 ip address 10.1.1.1/31
!
interface eth2
 description to_spine2
 ip address 10.1.2.1/31
!
interface eth3
 description to_gpu1
 ip address 10.2.1.0/31
!
interface eth4
 description to_gpu2
 ip address 10.2.1.2/31
!
router bgp 65101
 bgp router-id 10.0.1.1
 bgp bestpath as-path multipath-relax
 no bgp default ipv4-unicast
 neighbor SPINES peer-group
 neighbor SPINES advertisement-interval 0
 neighbor SPINES timers 3 9
 neighbor 10.1.1.0 remote-as 65000
 neighbor 10.1.1.0 peer-group SPINES
 neighbor 10.1.1.0 description spine1
 neighbor 10.1.2.0 remote-as 65000
 neighbor 10.1.2.0 peer-group SPINES
 neighbor 10.1.2.0 description spine2
 !
 address-family ipv4 unicast
  network 10.0.1.1/32
  network 10.0.10.1/32
  network 10.2.1.0/31
  network 10.2.1.2/31
  maximum-paths 64
  neighbor SPINES activate
  neighbor SPINES soft-reconfiguration inbound
 exit-address-family
!
line vty
!
```

### What's different from a spine?

- **Per-leaf ASN** (`65101` here) — not shared like the spines.
- **Two loopbacks**: `10.0.1.1/32` is the router-ID; `10.0.10.1/32` is the reserved VTEP for the Phase 3 EVPN overlay. Advertise both now.
- **Worker `/31` `network` statements** (`10.2.1.0/31` and `10.2.1.2/31`) — workers don't run BGP, so the leaf is the one that injects their fabric subnets into BGP. Without these, gpu1 and gpu2 are unreachable from other leaves.
- **Peer-group is named `SPINES`** (not `LEAVES`), with the two spine peers bound to it.

### Apply + verify after step 3

```bash
make sync && make fabric-bootstrap
make shell-leaf1
vtysh -c "show bgp summary"
```

Expected:

```
Neighbor         V  AS     ...  PfxRcd
spine1(10.1.1.0) 4  65000  ...  1
spine2(10.1.2.0) 4  65000  ...  1
```

PfxRcd=1 right now because each spine is only advertising its own loopback. As you add more leaves (steps 4–6), this number grows. End state is **PfxRcd=13** per spine peer (1 spine loopback + 4 prefixes × 3 other leaves).

---

## Steps 4–6 — `leaf2`, `leaf3`, `leaf4`

Same template as leaf1 with these substitutions:

| Field                    | leaf2          | leaf3          | leaf4          |
|--------------------------|----------------|----------------|----------------|
| ASN                      | `65102`        | `65103`        | `65104`        |
| Loopback (router-id)     | `10.0.1.2/32`  | `10.0.1.3/32`  | `10.0.1.4/32`  |
| Loopback (VTEP)          | `10.0.10.2/32` | `10.0.10.3/32` | `10.0.10.4/32` |
| `eth1` (to spine1)       | `10.1.1.3/31`  | `10.1.1.5/31`  | `10.1.1.7/31`  |
| `eth2` (to spine2)       | `10.1.2.3/31`  | `10.1.2.5/31`  | `10.1.2.7/31`  |
| `eth3` (to first worker) | `10.2.2.0/31`  | `10.2.3.0/31`  | `10.2.4.0/31`  |
| `eth4` (to second worker)| `10.2.2.2/31`  | `10.2.3.2/31`  | `10.2.4.2/31`  |
| Worker descriptions      | `gpu3`, `gpu4` | `gpu5`, `gpu6` | `gpu7`, `gpu8` |
| Spine1 neighbor          | `10.1.1.2`     | `10.1.1.4`     | `10.1.1.6`     |
| Spine2 neighbor          | `10.1.2.2`     | `10.1.2.4`     | `10.1.2.6`     |
| `network` lines (4 each) | `10.0.1.2/32`<br>`10.0.10.2/32`<br>`10.2.2.0/31`<br>`10.2.2.2/31` | `10.0.1.3/32`<br>`10.0.10.3/32`<br>`10.2.3.0/31`<br>`10.2.3.2/31` | `10.0.1.4/32`<br>`10.0.10.4/32`<br>`10.2.4.0/31`<br>`10.2.4.2/31` |

If you'd rather just see the full files: `git show HEAD:configs/frr/leaf2/frr.conf` (and so on) once you've committed, or `make solve` to restore them.

After each leaf, `make sync && make fabric-bootstrap` and watch the PfxRcd numbers climb on the already-configured switches.

---

## Step 7 — End-to-end verification

After all 6 switches are configured:

### Interfaces

```bash
make shell-leaf1
ip -br addr show | grep -E "^(lo|eth)"
```

Expected on leaf1:
```
lo               UNKNOWN        127.0.0.1/8 ::1/128 10.0.1.1/32 10.0.10.1/32
eth0@if...       UP             172.20.20.21/24
eth1@if...       UP             10.1.1.1/31
eth2@if...       UP             10.1.2.1/31
eth3@if...       UP             10.2.1.0/31
eth4@if...       UP             10.2.1.2/31
```

### BGP peers

```bash
vtysh -c "show bgp summary"
```

Expected on a leaf:
```
Neighbor         V  AS     ...  PfxRcd  PfxSnt
spine1(10.1.1.0) 4  65000  ...  13      18
spine2(10.1.2.0) 4  65000  ...  13      18
```

Expected on a spine:
```
Neighbor        V  AS     ...  PfxRcd  PfxSnt
leaf1(10.1.1.1) 4  65101  ...  4       17
leaf2(10.1.1.3) 4  65102  ...  4       17
leaf3(10.1.1.5) 4  65103  ...  4       17
leaf4(10.1.1.7) 4  65104  ...  4       17
```

Numbers: each leaf advertises 4 prefixes (loopback + VTEP + 2 worker /31s). Each spine relays the 4 from each of 3 other leaves + its own loopback = 13 prefixes shown back to any leaf. PfxSnt is higher because of the soft-reconfiguration inbound bookkeeping.

### Routes & ECMP

```bash
vtysh -c "show ip route bgp" | head -10
vtysh -c "show ip route 10.0.1.3"
```

The route to `leaf3`'s loopback should have **two** next-hops:

```
B>* 10.0.1.3/32 [20/0] via 10.1.1.0, eth1, weight 1
   *                   via 10.1.2.0, eth2, weight 1
```

That's ECMP working. Different 5-tuples will hash to one path or the other.

### End-to-end pings

```bash
make ping-mesh
```

Expected: 56 lines all showing `OK`.

### One-shot

```bash
make lab-status
```

---

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Peer stuck in `Active` after both ends configured | Wrong neighbor IP on one side, or `eth*` interface down | Check `ip -br link` inside both containers; double-check both sides agree on which `/31` IP each end owns (table in [topology.md §4](../topology.md#4-link-inventory-the-16-links)) |
| Peer `Established` but `PfxRcd` stays 0 | Missing `neighbor X activate` (you turned off `default ipv4-unicast` but didn't re-activate per AF) | Add `neighbor SPINES activate` (or `LEAVES activate` on the spine) inside `address-family ipv4 unicast` |
| Routes received but `show ip route` shows only 1 next-hop instead of 2 | Missing `bgp bestpath as-path multipath-relax` | Add it under `router bgp <asn>` |
| Workers on the same leaf can ping each other but cross-leaf pings fail | The leaf didn't `network` its worker `/31`s, so other leaves don't learn how to reach them | Add `network 10.2.X.0/31` and `network 10.2.X.2/31` inside `address-family ipv4 unicast` on the leaf |
| `show ip route 10.0.1.3` shows 2 ECMP paths on leaf1, but only 1 path is actually used in a `traceroute` | This is normal — per-flow ECMP hashes on the 5-tuple; for any single flow, the same path is chosen every time. Vary src/dst port to see the other path. | Not a bug |

---

## Want to skip ahead?

```bash
make solve         # git checkout the working configs + apply
make lab-status    # confirm 56/56 + Established
```
