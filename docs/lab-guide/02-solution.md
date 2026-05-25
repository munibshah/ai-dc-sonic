# Solution — vtysh command sequences for every switch

Just the commands, in build order. Open each switch's console in the UI, paste the block, verify. The *why* behind every line lives in [`01-exercise.md`](01-exercise.md) — this doc is the answer key.

> **Shortcut**: if you just want to skip the exercise and get back to a working lab, run `make solve`. That `git checkout`s the committed `configs/frr/<node>/frr.conf` files (which already contain the working configuration) and reloads.

---

## 1 — `spine1`

Open the `spine1` console in the UI, then:

```sh
vtysh
```

Paste the entire block at the FRR prompt (which may render as `will-be-overridden#` — a cosmetic sonic-vs quirk):

```
configure terminal
interface lo
 ip address 10.0.0.1/32
exit
interface eth1
 description to_leaf1
 ip address 10.1.1.0/31
exit
interface eth2
 description to_leaf2
 ip address 10.1.1.2/31
exit
interface eth3
 description to_leaf3
 ip address 10.1.1.4/31
exit
interface eth4
 description to_leaf4
 ip address 10.1.1.6/31
exit
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
 address-family ipv4 unicast
  network 10.0.0.1/32
  maximum-paths 64
  neighbor LEAVES activate
  neighbor LEAVES soft-reconfiguration inbound
 exit-address-family
end
```

**Verify**:

```
show interface brief
show bgp summary
```

Expected: every `eth1..4` and `lo` has its IP (the SONiC `EthernetN` rows shown alongside them are unused — ignore), all 4 leaf peers in `Active` state (leaves not configured yet).

---

## 2 — `leaf1`

Open the `leaf1` console.

```sh
vtysh
```

```
configure terminal
interface lo
 ip address 10.0.1.1/32
 ip address 10.0.10.1/32
exit
interface eth1
 description to_spine1
 ip address 10.1.1.1/31
exit
interface eth2
 description to_spine2
 ip address 10.1.2.1/31
exit
interface eth3
 description to_gpu1
 ip address 10.2.1.0/31
exit
interface eth4
 description to_gpu2
 ip address 10.2.1.2/31
exit
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
 address-family ipv4 unicast
  network 10.0.1.1/32
  network 10.0.10.1/32
  network 10.2.1.0/31
  network 10.2.1.2/31
  maximum-paths 64
  neighbor SPINES activate
  neighbor SPINES soft-reconfiguration inbound
 exit-address-family
end
```

**Verify** (within ~10s):

```
show bgp summary
```

Expected (the Established peer surfaces its description label):

```
Neighbor          V    AS    ...   State/PfxRcd
spine1(10.1.1.0)  4   65000  ...   1            ← spine1 Established
10.1.2.0          4   65000  ...   Active       ← spine2 not configured yet
```

---

## 3 — `leaf2`

```sh
vtysh
```

```
configure terminal
interface lo
 ip address 10.0.1.2/32
 ip address 10.0.10.2/32
exit
interface eth1
 description to_spine1
 ip address 10.1.1.3/31
exit
interface eth2
 description to_spine2
 ip address 10.1.2.3/31
exit
interface eth3
 description to_gpu3
 ip address 10.2.2.0/31
exit
interface eth4
 description to_gpu4
 ip address 10.2.2.2/31
exit
router bgp 65102
 bgp router-id 10.0.1.2
 bgp bestpath as-path multipath-relax
 no bgp default ipv4-unicast
 neighbor SPINES peer-group
 neighbor SPINES advertisement-interval 0
 neighbor SPINES timers 3 9
 neighbor 10.1.1.2 remote-as 65000
 neighbor 10.1.1.2 peer-group SPINES
 neighbor 10.1.1.2 description spine1
 neighbor 10.1.2.2 remote-as 65000
 neighbor 10.1.2.2 peer-group SPINES
 neighbor 10.1.2.2 description spine2
 address-family ipv4 unicast
  network 10.0.1.2/32
  network 10.0.10.2/32
  network 10.2.2.0/31
  network 10.2.2.2/31
  maximum-paths 64
  neighbor SPINES activate
  neighbor SPINES soft-reconfiguration inbound
 exit-address-family
end
```

After this step: leaf1 ↔ leaf2 reachability is up via spine1. `gpu1 → gpu3` should ping. Still single-path (spine2 down).

---

## 4 — `spine2`

```sh
vtysh
```

```
configure terminal
interface lo
 ip address 10.0.0.2/32
exit
interface eth1
 description to_leaf1
 ip address 10.1.2.0/31
exit
interface eth2
 description to_leaf2
 ip address 10.1.2.2/31
exit
interface eth3
 description to_leaf3
 ip address 10.1.2.4/31
exit
interface eth4
 description to_leaf4
 ip address 10.1.2.6/31
exit
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
 address-family ipv4 unicast
  network 10.0.0.2/32
  maximum-paths 64
  neighbor LEAVES activate
  neighbor LEAVES soft-reconfiguration inbound
 exit-address-family
end
```

**ECMP-arrived verification** (on leaf1):

```
show ip route 10.0.1.2
```

Expected: 2 next-hops.

```
Routing entry for 10.0.1.2/32
  Known via "bgp", distance 20, metric 0, best
  Last update 00:00:08 ago
  * 10.1.1.0, via eth1, weight 1
  * 10.1.2.0, via eth2, weight 1
```

(For the compact `B>*` form across the whole routing table, use `show ip route bgp`.)

---

## 5 — `leaf3`

```sh
vtysh
```

```
configure terminal
interface lo
 ip address 10.0.1.3/32
 ip address 10.0.10.3/32
exit
interface eth1
 description to_spine1
 ip address 10.1.1.5/31
exit
interface eth2
 description to_spine2
 ip address 10.1.2.5/31
exit
interface eth3
 description to_gpu5
 ip address 10.2.3.0/31
exit
interface eth4
 description to_gpu6
 ip address 10.2.3.2/31
exit
router bgp 65103
 bgp router-id 10.0.1.3
 bgp bestpath as-path multipath-relax
 no bgp default ipv4-unicast
 neighbor SPINES peer-group
 neighbor SPINES advertisement-interval 0
 neighbor SPINES timers 3 9
 neighbor 10.1.1.4 remote-as 65000
 neighbor 10.1.1.4 peer-group SPINES
 neighbor 10.1.1.4 description spine1
 neighbor 10.1.2.4 remote-as 65000
 neighbor 10.1.2.4 peer-group SPINES
 neighbor 10.1.2.4 description spine2
 address-family ipv4 unicast
  network 10.0.1.3/32
  network 10.0.10.3/32
  network 10.2.3.0/31
  network 10.2.3.2/31
  maximum-paths 64
  neighbor SPINES activate
  neighbor SPINES soft-reconfiguration inbound
 exit-address-family
end
```

---

## 6 — `leaf4`

```sh
vtysh
```

```
configure terminal
interface lo
 ip address 10.0.1.4/32
 ip address 10.0.10.4/32
exit
interface eth1
 description to_spine1
 ip address 10.1.1.7/31
exit
interface eth2
 description to_spine2
 ip address 10.1.2.7/31
exit
interface eth3
 description to_gpu7
 ip address 10.2.4.0/31
exit
interface eth4
 description to_gpu8
 ip address 10.2.4.2/31
exit
router bgp 65104
 bgp router-id 10.0.1.4
 bgp bestpath as-path multipath-relax
 no bgp default ipv4-unicast
 neighbor SPINES peer-group
 neighbor SPINES advertisement-interval 0
 neighbor SPINES timers 3 9
 neighbor 10.1.1.6 remote-as 65000
 neighbor 10.1.1.6 peer-group SPINES
 neighbor 10.1.1.6 description spine1
 neighbor 10.1.2.6 remote-as 65000
 neighbor 10.1.2.6 peer-group SPINES
 neighbor 10.1.2.6 description spine2
 address-family ipv4 unicast
  network 10.0.1.4/32
  network 10.0.10.4/32
  network 10.2.4.0/31
  network 10.2.4.2/31
  maximum-paths 64
  neighbor SPINES activate
  neighbor SPINES soft-reconfiguration inbound
 exit-address-family
end
```

---

## End-to-end verification

From your laptop:

```bash
make bgp-check    # every leaf-spine session Established, PfxRcd=13 (leaf side) / 4 (spine side)
make ping-mesh    # 56 / 56 OK
make lab-status   # one-shot summary
```

Or per-switch via UI consoles:

```sh
# any leaf
vtysh -c "show ip route 10.0.1.3"     # expect 2 next-hops (ECMP)
vtysh -c "show bgp summary"           # 2 spine peers Established, PfxRcd=13 each

# any spine
vtysh -c "show bgp summary"           # 4 leaf peers Established, PfxRcd=4 each
```

---

## Appendix A — Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| You typed your config but `do show interface brief` shows no IPs | You're in `(config-router)#` or `(config-bgp)#`, not at the interface block. The IP commands silently went into the BGP context. | `end` to get out, then re-enter `configure terminal` → `interface eth1` |
| Peer stuck in `Active` after both ends configured | Wrong neighbor IP on one side, OR you typed the local-end IP instead of the remote-end IP, OR `eth*` is down | `do show interface brief` to confirm IPs match the topology doc; cross-check both sides — leaf1's `neighbor 10.1.1.0` must match spine1's local IP, and vice versa |
| Peer `Established` but `PfxRcd` stays 0 | You set `no bgp default ipv4-unicast` but forgot the `neighbor X activate` inside `address-family ipv4 unicast` | Re-enter `router bgp <asn>` → `address-family ipv4 unicast` → `neighbor SPINES activate` (or `LEAVES activate` on a spine) |
| Routes received but `show ip route 10.0.1.X` shows only 1 next-hop instead of 2 | Missing `bgp bestpath as-path multipath-relax` — without it, BGP rejects ECMP across the shared-AS spines | Re-enter `router bgp <asn>` → `bgp bestpath as-path multipath-relax` |
| Workers on the same leaf can ping each other but cross-leaf pings fail | The leaf didn't `network` its worker `/31`s — other leaves never learn how to reach them | Re-enter `router bgp <asn>` → `address-family ipv4 unicast` → `network 10.2.X.0/31` + `network 10.2.X.2/31` |
| `show ip route 10.0.1.3` shows 2 ECMP paths on leaf1, but `traceroute` always takes the same one | Not a bug — per-flow ECMP hashes on the 5-tuple, so a single flow consistently picks one path | Vary source/dest port to see the other path: `traceroute -p 12345 10.2.3.1` vs `traceroute -p 12346 10.2.3.1` |
| You typed `exit` once too many and dropped out of vtysh | The vtysh shell exits when you `exit` past the top level | Run `vtysh` again, then `configure terminal`. Anything already applied is still there. |

---

## Appendix B — vtysh ↔ frr.conf mapping

The vtysh commands you typed and the `configs/frr/<switch>/frr.conf` file format are almost 1:1. Here's the translation if you want to persist your work via file-edit + `make sync && make fabric-bootstrap`:

| In vtysh                                  | In `frr.conf`                          |
|-------------------------------------------|----------------------------------------|
| `configure terminal`                      | (implicit — everything below is config) |
| `interface eth1` ... `exit`               | `interface eth1` ... `!`               |
| `ip address 10.1.1.0/31`                  | ` ip address 10.1.1.0/31`              |
| `router bgp 65000` ... `exit`             | `router bgp 65000` ... `!`             |
| `neighbor LEAVES peer-group`              | ` neighbor LEAVES peer-group`          |
| `address-family ipv4 unicast` ... `exit-address-family` | ` address-family ipv4 unicast` ... ` exit-address-family` |
| `end` / `exit`                            | (not used — file just has top-level blocks separated by `!`) |

Notes:

- In `frr.conf`, indentation is significant: lines inside `interface ethN` start with a single leading space; lines inside `address-family ...` start with two leading spaces (because they're nested inside `router bgp`).
- The file needs a `!` between top-level blocks (between the `interface` blocks and `router bgp`, etc.) — this is FRR's block terminator.
- The file also needs these boilerplate lines at the top (already present in the skeleton):
  ```
  frr defaults datacenter
  hostname <name>
  log syslog informational
  service integrated-vtysh-config
  ```
  and a `line vty` block at the bottom.

The cleanest way to see this in action: look at any committed `configs/frr/<switch>/frr.conf` after running `make solve`. Each file is exactly what `vtysh -b` consumes to reproduce what you typed interactively.

---

## Appendix C — Want to revert?

```bash
make solve         # restores all 6 frr.conf from git and re-applies
make lab-status    # confirm 56/56 OK + BGP Established everywhere
```
