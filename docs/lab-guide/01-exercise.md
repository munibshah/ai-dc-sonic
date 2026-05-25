# Exercise — Bring the fabric up, one switch at a time

> Read [`00-overview.md`](00-overview.md) first if you haven't.

## Scenario

You're the network engineer. Six switches were just racked into the lab — `spine1`, `spine2`, `leaf1`, `leaf2`, `leaf3`, `leaf4`. Eight GPU workers (`gpu1`..`gpu8`) are wired in but waiting on the fabric. The switches have no L3 config and no BGP. Your job: bring the fabric up through the UI consoles, watch BGP sessions establish in real time, and end with `gpu1` able to ping `gpu7` over **two parallel paths** (one via spine1, one via spine2).

You'll build in **end-to-end-first order**: spine1 → leaf1 (the first BGP session comes up!) → leaf2 → spine2 (now ECMP appears) → leaf3 → leaf4. Each step gives you something observable.

### Why an AI Data Center needs this fabric

Distributed training is built around one operation: **AllReduce**. After each training step, every GPU needs every other GPU's gradients, summed together. This generates massive, simultaneous, east-west traffic — every-to-every, not the north-south "user → server" pattern a web DC has.

A single-path fabric stalls AllReduce: every GPU is waiting on the slowest serial path. A multi-path ECMP fabric keeps every GPU saturated by hashing flows across many spines in parallel. This is why every hyperscale AI fabric uses **eBGP CLOS** — every leaf is N parallel paths from every other leaf, and BGP/ECMP picks them all up automatically when topology changes.

That's what you're going to build.

### Get to the starting line

If you haven't already:

```bash
make wipe          # if you skipped this earlier
make lab-status    # expect 0 BGP peers + 8/56 OK pings (only same-leaf workers can talk)
```

Then open the UI: **http://192.168.1.26:3000/topology**

---

## Step 1: Bring up `spine1`

Click `spine1` in the topology view. The console pane on the right opens — you're now inside a bash shell on the spine1 container.

### Discover what's there

```sh
hostname
ip -br link show
ip -br addr show eth1 eth2 eth3 eth4 lo
```

Expected:

- `hostname` → `spine1`
- `ip -br link show` → eth0..eth4 + lo, all `UP`
- `ip -br addr show` → eth0 has a 172.20.20.11 mgmt IP, but eth1..eth4 are empty, lo only has 127.0.0.1

This is what a freshly-racked spine looks like: physical links up, no L3.

### Look up your IPs

Open [`../topology.md`](../topology.md) §3 in another tab. Find the spine1 factsheet:

- Loopback → `10.0.0.1/32`
- eth1 (to leaf1) → `10.1.1.0/31`
- eth2 (to leaf2) → `10.1.1.2/31`
- eth3 (to leaf3) → `10.1.1.4/31`
- eth4 (to leaf4) → `10.1.1.6/31`

### Configure the loopback

```sh
vtysh
```

You're in the FRR CLI now. (The prompt may show `will-be-overridden#` — a quirk of the sonic-vs base image where its own hostname line overrides ours. Cosmetic; the FRR daemon's identity is still `spine1`.)

```
configure terminal
interface lo
 ip address 10.0.0.1/32
exit
```

> 💡 **Why a loopback?** Spine1's BGP router-id and the source of its BGP-advertised routes is `10.0.0.1`. Loopback is the "always up" interface — even if `eth1` flaps, the BGP session sourced from the loopback (over `eth2` or any other path) stays identified by the same router-id. In CLOS, a control plane that flaps with every physical link bounce is unworkable; loopback addressing keeps identity decoupled from any single link.

### Configure the fabric interfaces

```
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
```

> 💡 **Why /31s?** Each fabric link is point-to-point between exactly two devices. A `/30` wastes the network and broadcast addresses (2 of 4 unusable). A `/31` (RFC 3021) uses just 2 addresses, both usable as host. At hyperscale with thousands of fabric links, that's tens of thousands of IPs saved — and it cleanly enforces "only two devices on this segment, no surprises."

### Check your work so far

```
do show interface brief
```

Expected: a long table — `Bridge`, `Ethernet0..Ethernet124`, `dummy`, `eth0..eth4`, `lo`. The SONiC `EthernetN` rows are all `down` (they're physical port names the lab doesn't use — ignore them). The interesting rows are at the bottom: `eth1..eth4` all `up` with the IPs you just configured, `lo up 10.0.0.1/32`, `eth0` `up` with the mgmt IP.

### Configure BGP

```
router bgp 65000
 bgp router-id 10.0.0.1
 bgp bestpath as-path multipath-relax
 no bgp default ipv4-unicast
```

> 💡 **The ASN allocation, and why it looks like this**
>
> Every switch in this fabric has an ASN:
>
> | Device  | ASN   | Notes                              |
> |---------|-------|------------------------------------|
> | spine1  | 65000 | Both spines share one ASN          |
> | spine2  | 65000 | (same)                             |
> | leaf1   | 65101 | Each leaf gets a unique ASN        |
> | leaf2   | 65102 |                                    |
> | leaf3   | 65103 |                                    |
> | leaf4   | 65104 |                                    |
>
> All of these are in the **private AS range** (RFC 6996: 64512–65534). Like RFC 1918 for IPs, private ASNs are reserved for internal use — they never appear in the public BGP table.
>
> **Why eBGP-everywhere, not iBGP + an IGP?** Traditional enterprise designs run an IGP (OSPF / IS-IS) for underlay reachability and iBGP on top for service routes. AI/hyperscale CLOS flips this: every adjacent pair speaks **eBGP**, end of story. Three benefits:
>
> 1. **Loop prevention is free** — eBGP rejects any route whose AS_PATH already contains the receiver's own AS. In a CLOS where every leaf has a unique AS, loops are mathematically impossible without writing a single line of filtering. No IGP split-horizon, no TTL hacks.
> 2. **No full mesh, no route reflectors** — iBGP requires either a full mesh of sessions OR route-reflector hierarchies to propagate external routes. eBGP-only sidesteps both. At 1000+ switches, RR scaling becomes its own engineering problem.
> 3. **One control plane to debug** — when something is broken, it's broken in BGP. There's no IGP that might also be wrong, no redistribution boundary to chase.
>
> **Why both spines share AS 65000?** In a 2-spine CLOS, both spines must be path-equivalent from a leaf's perspective. If spine1=65001 and spine2=65002, every cross-leaf path would have to traverse the inter-spine link (longer AS_PATH = less preferred), and we'd need spine-to-spine peering to glue it together. With a shared spine ASN, every leaf sees both spines as exactly equal-cost, and the spines never have to talk to each other. This is the "shared spine AS" pattern documented across every hyperscale fabric design.

> 💡 **What's `multipath-relax`?** Default BGP requires the AS_PATH to be **identical** (byte-for-byte) across paths to call them equal-cost. In our CLOS, leaf1 sees leaf3's loopback via two paths: `[65000 65103]` via spine1 and `[65000 65103]` via spine2 — same content, but a strict implementation can still treat them as distinct. `multipath-relax` loosens the rule to "same length, same neighbor AS." This is *the* knob that makes ECMP work in CLOS with shared spine ASNs. Without it, ECMP silently collapses to a single next-hop and you'd never know until your training run was 2× slower than expected.

> 💡 **Why `no bgp default ipv4-unicast`?** By default, FRR auto-activates the IPv4-unicast address family for every new neighbor. Best practice (and standard in hyperscale templates) is to disable that and explicitly activate per address-family inside the AF block. It makes intent unambiguous — especially important once you have IPv6 + L2VPN-EVPN + VPNv4 ASes layered on the same neighbors.

### Configure the peer-group and the four leaf neighbors

```
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
```

> 💡 **Why peer-groups?** A real spine in a real AI DC has dozens or hundreds of leaf peers. Configuring `activate` + `soft-reconfiguration inbound` + `route-map` + `maximum-prefix` on each neighbor individually is unmaintainable. Peer-groups let you say "all leaves get this policy" — one block, many neighbors. Change a policy on the peer-group and it applies to every member.

> 💡 **Why timers 3 9?** BGP defaults are 60s keepalive / 180s hold. In an AI fabric, 180 seconds of un-converged routing during a link failure = 180 seconds of stalled training step + likely a checkpoint restart. Hyperscalers run 3s keepalive / 9s hold (sub-10s convergence), or BFD with sub-second timers in production. We use 3/9 here.

### Activate the address family

```
 address-family ipv4 unicast
  network 10.0.0.1/32
  maximum-paths 64
  neighbor LEAVES activate
  neighbor LEAVES soft-reconfiguration inbound
 exit-address-family
exit
```

> 💡 **Why `maximum-paths 64`?** Tells BGP to install up to **64** equal-cost paths in the FIB. Without this, BGP installs *one* best path and ECMP is dead at the data plane even if the control plane learned multiple paths. Modern AI fabrics with 8, 16, or 32 spines need this set high enough to fan out across all of them.

> 💡 **Why `network 10.0.0.1/32`?** Spine1 needs to advertise *its own loopback* into BGP so leaves can reach it. `network` is the cleanest way — only advertise what's in your IP plan, no surprises from `redistribute connected`.

> 💡 **Why `soft-reconfiguration inbound`?** Stores a copy of the raw received routes from each peer (before any inbound policy). Costs a little memory; gives you `show bgp ipv4 unicast neighbor X received-routes` for debugging policy issues. Worth it in any environment where humans look at BGP.

Finally:

```
end
```

You're back at the top-level FRR prompt (not in any config block).

### Verify what you just built

```
show interface brief
show bgp summary
```

Expected from `show bgp summary`:

```
Neighbor        V         AS    MsgRcvd    MsgSent   ...  State/PfxRcd
10.1.1.1        4      65101          0          0   ...  Active
10.1.1.3        4      65102          0          0   ...  Active
10.1.1.5        4      65103          0          0   ...  Active
10.1.1.7        4      65104          0          0   ...  Active
```

All four leaves show `Active` (or `Connect`). That's correct — the leaves haven't been configured yet, so the TCP connection can't establish.

### Try to ping a neighbor

```
exit
```

(out of vtysh, back at the bash shell)

```sh
ping -c 2 10.1.1.1
```

Expected: 100% loss. leaf1 has no IP on its eth1 yet.

> 💡 **What you've built**: Spine1 has L3 ports, BGP configured with four leaf-peer slots, and is waiting. Zero peers up = zero routes flowing. This is exactly what a freshly-configured spine looks like the moment it's wired in: it knows what it *should* peer with, it's listening, nothing is responding. Time to bring up a leaf.

---

## Step 2: Bring up `leaf1` — and watch the first BGP session establish

Click `leaf1` in the UI topology. New console opens.

### Discover

```sh
hostname              # leaf1
ip -br addr show      # eth1..eth4 empty, lo only 127/8
```

### Look up your IPs ([`../topology.md`](../topology.md) §3, leaf1 factsheet)

- Loopback router-id → `10.0.1.1/32`
- Loopback VTEP (reserved for EVPN-VXLAN later) → `10.0.10.1/32`
- eth1 (to spine1) → `10.1.1.1/31`
- eth2 (to spine2) → `10.1.2.1/31`
- eth3 (to gpu1) → `10.2.1.0/31`
- eth4 (to gpu2) → `10.2.1.2/31`
- ASN → **65101**

### Configure

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
```

> 💡 **Why two loopbacks?** `10.0.1.1` is the BGP router-id. `10.0.10.1` is pre-allocated as the **VTEP** address for the EVPN-VXLAN overlay we'll add in a later phase. Why allocate it now? Renumbering loopbacks across a live fabric is painful (peerings change, route-maps need updating). Pre-allocating the VTEP block when you design the fabric means later expansion is a no-op on the underlay.

Now BGP:

```
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
```

> 💡 **Why a unique ASN per leaf?** Three reasons, each one paying for itself many times over at scale:
>
> 1. **Failure isolation and attribution** — if leaf2 misconfigures and starts advertising garbage prefixes, every other device in the fabric sees them as "originated by AS 65102." Trivial to trace, trivial to filter at a spine with `route-map deny match as-path`. With every leaf sharing one AS, you'd disambiguate by router-id or BGP community — much more friction in incident response.
> 2. **Loop prevention only works because of this** — recall eBGP's own-AS rejection rule (covered in the spine1 callout). That rule only buys you anything if every leaf actually has a *unique* AS. With same-AS leaves, the natural loop prevention disappears and you'd need additional config (community-based filters, allowas-in tweaks) just to keep the topology safe. The unique-per-leaf scheme is what makes eBGP-everywhere viable in the first place.
> 3. **Per-leaf policy becomes a one-liner** — want to drain leaf3 for maintenance? `route-map drain deny match as-path 65103` on both spines, traffic shifts to the others automatically. Want to redirect leaf2 to a specific upstream during an upgrade? Match its AS, set local-pref. With shared leaf ASNs, every per-leaf policy needs additional tagging or router-id matching.
>
> At hyperscale operability, this kind of attribution capability pays off in 3am pages.

### Activate and advertise

```
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

> 💡 **Why explicit `network` statements for the worker `/31`s?** GPU workers don't run BGP. They have a default route pointing back at the leaf (`10.2.1.0` for gpu1). So the **leaf** is the one that has to tell the rest of the fabric "I can reach `10.2.1.0/31` and `10.2.1.2/31`." `network` is the cleanest way to do this — it only advertises what you explicitly listed, so a misconfigured interface IP won't accidentally leak into BGP. (`redistribute connected` would be the lazy alternative, but it advertises *everything* including mgmt and link-locals.)

### Watch BGP come up

```
show bgp summary
```

Within ~10 seconds (timers 3 9), you should see:

```
Neighbor          V         AS    ...   State/PfxRcd
spine1(10.1.1.0)  4      65000   ...   1
10.1.2.0          4      65000   ...   Active
```

**Spine1 is Established!** Notice the `spine1(...)` label — that's the `neighbor X description spine1` line you set, surfaced once the session comes up. PfxRcd=1 means spine1 advertised exactly one prefix to leaf1 so far (spine1's own loopback `10.0.0.1/32`). Spine2 is still `Active` because we haven't configured it yet.

### Look at routes

```
show ip route bgp
```

Expected (one BGP-learned route):

```
B>* 10.0.0.1/32 [20/0] via 10.1.1.0, eth1, weight 1, ...
```

That's spine1's loopback, learned via BGP from spine1, reachable via eth1.

### Ping spine1 from leaf1

```
exit
```

```sh
ping -c 2 10.0.0.1
```

Expected: success. Even though the loopback `10.0.0.1` isn't on any direct link, leaf1 has a BGP-learned route to it via `10.1.1.0`, and the ICMP packets follow it. **This is BGP working end-to-end.**

### Ping leaf1 from a GPU

Open the **gpu1** console in the UI.

```sh
ping -c 2 10.0.1.1     # leaf1's loopback
```

Expected: success. gpu1's default route is `10.2.1.0` (leaf1's eth3). Leaf1 has a direct interface IP `10.0.1.1` on its loopback. The ICMP reply finds its way back over the `/31` link. **First GPU-to-fabric connectivity is live.**

> 💡 **What just happened**: One BGP session is up. Spine1 ↔ leaf1 have a routed adjacency. Workers under leaf1 can reach the spine. This is the moment a freshly-racked leaf has *joined* a fabric in a real DC. The same thing happens automatically every time a hyperscale operator racks a new leaf — within seconds, the new switch is in the routing topology and traffic can flow through it.

---

## Step 3: Bring up `leaf2`

Click `leaf2` in the UI. Same pattern as leaf1, with leaf2's numbers from [`../topology.md`](../topology.md) §3.

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

### Verify the cross-leaf path

On **leaf2**:

```
show ip bgp summary
```

Expected: spine1 (`10.1.1.2`) Established, **PfxRcd=2** (spine1's loopback + leaf1's loopback — spine1 has re-advertised what it learned from leaf1).

On **leaf1**:

```
show ip route bgp
```

Expected: now also includes `10.0.1.2/32`, `10.0.10.2/32`, `10.2.2.0/31`, `10.2.2.2/31` — leaf2's prefixes, learned via spine1.

### Cross-leaf ping

Open **gpu1** console:

```sh
ping -c 2 10.2.2.1     # gpu3, attached to leaf2
```

Expected: success. The traffic goes `gpu1 → leaf1 → spine1 → leaf2 → gpu3`. **First cross-leaf flow.**

> 💡 **Important**: this works through *one* spine. spine2 isn't up yet, so there's no ECMP. A traceroute would show exactly one path. In a real AllReduce workload right now, every gradient byte between leaf1 and leaf2 would serialize on spine1 — and if spine1 fails, the entire training job stalls. This is why we need spine2.

---

## Step 4: Bring up `spine2` — and watch ECMP arrive

Click `spine2` in the UI. Same pattern as spine1, but with the `10.1.2.*` block and router-id `10.0.0.2`.

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

### The ECMP moment

On **leaf1**:

```
show ip route 10.0.1.2
```

Expected: **two next-hops** (FRR's single-prefix view uses a detailed format).

```
Routing entry for 10.0.1.2/32
  Known via "bgp", distance 20, metric 0, best
  Last update 00:00:08 ago
  * 10.1.1.0, via eth1, weight 1
  * 10.1.2.0, via eth2, weight 1
```

That's ECMP. Two parallel paths to leaf2's loopback — one via spine1, one via spine2. (If you'd rather see the compact form, `show ip route bgp` gives the familiar `B>* 10.0.1.2/32 [20/0] via 10.1.1.0, eth1 / via 10.1.2.0, eth2` format.)

> 💡 **ECMP is now live, and this is *the* foundational primitive of AI DC fabrics**. AllReduce splits gradient updates into many concurrent flows; with ECMP, each flow hashes (typically on the 5-tuple) to one of the available spines, so the aggregate bandwidth between any two leaves = N × spine_bw, not 1 × spine_bw. With single-path routing, you'd serialize all gradient sync on one spine, and the training step would stall waiting for that one bottleneck. ECMP + `multipath-relax` + `maximum-paths` are the three settings that make this possible — miss any one and ECMP silently doesn't work.

Try the cross-leaf ping again from gpu1 — still works, and now it's redundant.

---

## Step 5: Bring up `leaf3`

Same pattern. Numbers from [`../topology.md`](../topology.md) §3, leaf3 row:

- ASN: **65103**
- Loopbacks: `10.0.1.3/32`, `10.0.10.3/32`
- eth1 (to spine1): `10.1.1.5/31` → neighbor `10.1.1.4`
- eth2 (to spine2): `10.1.2.5/31` → neighbor `10.1.2.4`
- eth3 (to gpu5): `10.2.3.0/31`
- eth4 (to gpu6): `10.2.3.2/31`
- network statements: 4 lines (loopback + VTEP + 2 worker /31s)

Full vtysh sequence in [`02-solution.md`](02-solution.md) §5.

---

## Step 6: Bring up `leaf4`

- ASN: **65104**
- Loopbacks: `10.0.1.4/32`, `10.0.10.4/32`
- eth1: `10.1.1.7/31` → neighbor `10.1.1.6`
- eth2: `10.1.2.7/31` → neighbor `10.1.2.6`
- eth3 (to gpu7): `10.2.4.0/31`
- eth4 (to gpu8): `10.2.4.2/31`

Full vtysh sequence in [`02-solution.md`](02-solution.md) §6.

---

## End-to-end verification

### From any GPU

Open **gpu1** console, then:

```sh
for ip in 10.2.1.3 10.2.2.1 10.2.2.3 10.2.3.1 10.2.3.3 10.2.4.1 10.2.4.3; do
  ping -c 1 -W 1 $ip && echo OK || echo FAIL
done
```

Expected: all 7 OK.

### ECMP across the fabric

Open **leaf1** console:

```sh
vtysh -c "show ip route 10.0.1.3"
```

Expected: 2 next-hops (one via spine1, one via spine2).

### From your laptop

```bash
make ping-mesh    # expect: 56/56 OK
make lab-status   # expect: clean BGP table + 56 / 56 pings OK
```

The UI at http://192.168.1.26:3000/topology should show all nodes green.

---

## 💡 Bonus: simulate a link failure

This is what convinces you that fast timers + ECMP actually matter.

On **spine1** console:

```sh
ip link set eth3 down    # cut the spine1 ↔ leaf3 link
```

On **leaf3** console:

```sh
vtysh -c "show ip bgp summary"
```

Within ~9 seconds (timers 3 9 — hold timer expired), the spine1 peer (`10.1.1.4`) should be `Idle` or `Active`.

From **gpu5** (attached to leaf3):

```sh
ping -c 5 10.2.1.1     # gpu1 (under leaf1)
```

Expected: pings still succeed, because BGP has re-converged onto the spine2-only path. Look at `vtysh -c "show ip route 10.0.1.1"` on leaf3 — only 1 next-hop now (via spine2).

Restore the link:

```sh
# back on spine1:
ip link set eth3 up
```

Within seconds, BGP re-establishes on leaf3 and ECMP returns.

> 💡 **Why this exercise matters**: training jobs are continuous gradient streams. A 30-second BGP reconvergence (default timers) = 30 seconds of stalled training step + likely a checkpoint restart. Fast timers (3/9) get you to sub-10s. In production hyperscale, BFD pushes this to sub-second. The cost is more frequent KEEPALIVE traffic — negligible compared to the cost of stalled GPUs.

---

## Saving your work

Your vtysh changes are **in the running daemons only**. They'll be lost if the container restarts. To persist:

**Option A — Adopt the canonical config**:

```bash
make solve
```

This `git checkout`s the committed `configs/frr/<node>/frr.conf` files (which already contain a working configuration equivalent to what you just built), rsyncs them to the remote, and reloads FRR. Your work is replaced with the canonical version.

**Option B — Save your own work**:

Open `configs/frr/<switch>/frr.conf` on your laptop, transcribe the vtysh commands you ran into FRR config-file format (the appendix in [`02-solution.md`](02-solution.md) shows the mapping — it's mostly the same syntax), then:

```bash
make sync
make fabric-bootstrap
```

Now your edits survive container restarts.

**Option C — Start over**:

```bash
make wipe
```

Blank slate. Try again.

---

## Where to go next

- [`02-solution.md`](02-solution.md) — full copy-pasteable vtysh sequences for every switch, plus a vtysh ↔ frr.conf mapping table and common-mistakes troubleshooter
- [`../topology.md`](../topology.md) — full IP / link / BGP reference
- [`../switch-cli-reference.md`](../switch-cli-reference.md) — vtysh + Linux network CLI cheatsheet
- [`../00-index.md`](../00-index.md) — the concept blogs for each AI DC topic (AllReduce, GPU-to-GPU comms, east-west dominance, etc.), each paired with a scenario you can run on this fabric
