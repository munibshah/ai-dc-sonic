# Exercise — Bring the fabric up, one switch at a time

## Scenario

You're the network engineer. Six switches were just racked into the lab — `spine1`, `spine2`, `leaf1`, `leaf2`, `leaf3`, `leaf4`. Eight GPU workers (`gpu1`..`gpu8`) are wired in but waiting on the fabric. The switches come with their fabric interfaces wired and addressed (lo + ethN /31s), but no BGP. Your job: bring the fabric up through the in-UI consoles, watch BGP sessions establish in real time, and end with `gpu1` able to ping `gpu7` over **two parallel paths** (one via spine1, one via spine2).

You'll build in **end-to-end-first order**: spine1 → leaf1 (the first BGP session comes up!) → leaf2 → spine2 (now ECMP appears) → leaf3 → leaf4. Each step gives you something observable, and each step ends with a **Check** button so you get instant feedback before moving on.

### Why an AI Data Center needs this fabric

Distributed training is built around one operation: **AllReduce**. After each training step, every GPU needs every other GPU's gradients, summed together. This generates massive, simultaneous, east-west traffic — every-to-every, not the north-south "user → server" pattern a web DC has.

A single-path fabric stalls AllReduce: every GPU is waiting on the slowest serial path. A multi-path ECMP fabric keeps every GPU saturated by hashing flows across many spines in parallel. This is why every hyperscale AI fabric uses **eBGP CLOS** — every leaf is N parallel paths from every other leaf, and BGP/ECMP picks them all up automatically when topology changes.

That's what you're going to build.

### Get to the starting line

Open the **Topology** button to see the fabric, or click **+** in the terminals pane to open a console for any device. 

---

## Step 1: Bring up `spine1`

Click **Topology** in the top bar, then click `spine1`. A new terminal tab opens — you're now inside a bash shell on the spine1 container.

### Enter FRR CLI

```sh
vtysh
```

You're in the FRR CLI now. (The prompt may show `will-be-overridden#` — a quirk of the sonic-vs base image where its own hostname line overrides ours. Cosmetic; the FRR daemon's identity is still `spine1`.)



### Discover what's there

```sh
show interface brief 
```

Expected:

- eth0..eth4 + lo, all `UP`
- eth0 has a 172.20.20.11 mgmt IP
- eth1..eth4 are configured and can ping leaf1..leaf4

Test this — ping the far end of eth1 (leaf1):

```sh
ping 10.1.1.1
```

Expected: a long table — `Bridge`, `Ethernet0..Ethernet124`, `dummy`, `eth0..eth4`, `lo`. The SONiC `EthernetN` rows are all `down` (they're physical port names the lab doesn't use — ignore them). The interesting rows are at the bottom: `eth1..eth4` all `up` with the IPs mentioned above, `lo up 10.0.0.1/32`, `eth0` `up` with the mgmt IP.

Run the checkpoint:

<checkpoint name="spine1_underlay" label="Spine 1 underlay (lo + ethN IPs)" />


> 💡 **Why a loopback?** Spine1's BGP router-id and the source of its BGP-advertised routes is `10.0.0.1`. Loopback is the "always up" interface — even if `eth1` flaps, the BGP session sourced from the loopback (over `eth2` or any other path) stays identified by the same router-id. In CLOS, a control plane that flaps with every physical link bounce is unworkable; loopback addressing keeps identity decoupled from any single link.

> 💡 **Why /31s?** Each fabric link is point-to-point between exactly two devices. A `/30` wastes the network and broadcast addresses (2 of 4 unusable). A `/31` (RFC 3021) uses just 2 addresses, both usable as host. At hyperscale with thousands of fabric links, that's tens of thousands of IPs saved — and it cleanly enforces "only two devices on this segment, no surprises."


### Configure BGP

Enter configuration mode, then start the BGP process:

```
configure terminal
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
> **Why eBGP-everywhere, not iBGP + an IGP?** Traditional enterprise designs run an IGP (OSPF / IS-IS) for underlay reachability and iBGP on top for service routes. AI/hyperscale CLOS flips this: every adjacent pair speaks **eBGP**. Three benefits:
>
> 1. **Loop prevention is free** — eBGP rejects any route whose AS_PATH already contains the receiver's own AS. In a CLOS topology where every leaf has a unique AS, loops are mathematically impossible without writing a single line of filtering. No IGP split-horizon, no TTL hacks required. 
> 2. **No full mesh, no route reflectors** — iBGP requires either a full mesh of sessions OR route-reflector hierarchies to propagate external routes. eBGP-only sidesteps both. At 1000+ switches, RR scaling becomes an engineering problem that we avoid with eBGP.
> 3. **One control plane to debug** — when something is broken, it's broken in BGP. There's no IGP that might also be wrong and no redistribution boundary to troubleshoot.

> **Why both spines share AS 65000?** In a 2-spine CLOS, both spines must be path-equivalent from a leaf's perspective. If spine1=65001 and spine2=65002, every cross-leaf path would have to traverse the inter-spine link (longer AS_PATH = less preferred), and we'd need spine-to-spine peering to glue it together. With a shared spine ASN, every leaf sees both spines as exactly equal-cost, and the spines never have to talk to each other. 

> 💡 **What's `multipath-relax`?** Default BGP requires the AS_PATH to be **identical** (byte-for-byte) across paths to call them equal-cost. In our CLOS, leaf1 sees leaf3's loopback via two paths: `[65000 65103]` via spine1 and `[65000 65103]` via spine2 — same content, but a strict implementation can still treat them as distinct. `multipath-relax` loosens the rule to "same length, same neighbor AS." This is *the* knob that makes ECMP work in CLOS with shared spine ASNs. Without it, ECMP collapses to a single next-hop and your training run will be 2× slower than expected.

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

> 💡 **What you've built**: Spine1 has L3 ports, BGP configured with four leaf-peer slots, and is waiting. Zero peers up = zero routes flowing. This is how a freshly-configured spine looks like the moment it's wired in: it knows what it *should* peer with, it's listening, nothing is responding. Time to bring up a leaf.

---

## Step 2: Bring up `leaf1` — and watch the first BGP session establish

Back in **Topology**, click `leaf1`. New terminal tab opens.

### Configure

```sh
vtysh
```

### Look up your IPs

```
show interface brief
```

- Loopback router-id → `10.0.1.1/32`
- Loopback VTEP (reserved for EVPN-VXLAN later) → `10.0.10.1/32`
- eth1 (to spine1) → `10.1.1.1/31`
- eth2 (to spine2) → `10.1.2.1/31`
- eth3 (to gpu1) → `10.2.1.0/31`
- eth4 (to gpu2) → `10.2.1.2/31`
- ASN → **65101**

> 💡 **Why two loopbacks?** `10.0.1.1` is the BGP router-id. `10.0.10.1` is pre-allocated as the **VTEP** address for the EVPN-VXLAN overlay we'll add in a later phase. Why allocate it now? Renumbering loopbacks across a live fabric is painful (peerings change, route-maps need updating). Pre-allocating the VTEP block when you design the fabric means later expansion is a no-op on the underlay.

Now BGP — enter configuration mode and start the BGP process:

```
configure terminal
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
> 2. **Loop prevention only works because of this** — recall eBGP's own-AS rejection rule (covered in the spine1 callout). That rule works if every leaf actually has a *unique* AS. With same-AS leaves, you'd need additional config (community-based filters, allowas-in tweaks) just to keep the topology safe. 
> 3. **Per-leaf policy becomes a one-liner** — want to drain leaf3 for maintenance? `route-map drain deny match as-path 65103` on both spines, traffic shifts to the others automatically. Want to redirect leaf2 to a specific upstream during an upgrade? Match its AS, set local-pref. With shared leaf ASNs, every per-leaf policy needs additional tagging or router-id matching.
>
> At hyperscale operability, this kind of attribution capability pays off.

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

<checkpoint name="leaf1_to_spine1" label="Leaf 1 ↔ Spine 1 BGP session" />

### Look at routes

```
show ip route bgp
```

Expected (one BGP-learned route):

```
B>q 10.0.0.1/32 [20/0] via 10.1.1.0, eth1, weight 1, ...
```

That's spine1's loopback, learned via BGP from spine1, reachable via eth1.

> 💡 **What's the `q` flag?** You may expect `B>*` (the classic "selected + FIB" markers) but see `B>q` instead. `>` still means *selected (best)*; `q` means *queued for ASIC-offload confirmation*. On this virtual SONiC image, zebra runs in `asic-offload=notify_on_offload` mode — it stamps a route `*` only after the (simulated) ASIC reports "offloaded," and the virtual ASIC never sends that notification. **The route is fully installed in the kernel and forwards normally** — `q` here is cosmetic, not an error. On real SONiC hardware these flip to `*` once the ASIC confirms offload. Throughout this lab, read `q` as "installed and forwarding."

### Ping spine1 from leaf1

```
exit
```

```sh
ping -c 2 10.0.0.1
```

Expected: success. Even though the loopback `10.0.0.1` isn't on any direct link, leaf1 has a BGP-learned route to it via `10.1.1.0`, and the ICMP packets follow it. **This is BGP working end-to-end.**

### Ping leaf1 from a GPU

Open the **gpu1** console (Topology → gpu1).

```sh
ping -c 2 10.0.1.1     # leaf1's loopback
```

Expected: success. gpu1's default route is `10.2.1.0` (leaf1's eth3). Leaf1 has a direct interface IP `10.0.1.1` on its loopback. The ICMP reply finds its way back over the `/31` link. **First GPU-to-fabric connectivity is live.**

> 💡 **What just happened**: One BGP session is up. Spine1 ↔ leaf1 have a routed adjacency. Workers under leaf1 can reach the spine. This is the moment a freshly-racked leaf has *joined* a fabric in a real DC. The same thing happens automatically every time a hyperscale operator racks a new leaf — within seconds, the new switch is in the routing topology and traffic can flow through it.

---

## Step 3: Bring up `leaf2`

Open the `leaf2` console. Same pattern as leaf1 — interfaces are pre-provisioned, so you only configure BGP.

```sh
vtysh
```

```
configure terminal
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

<checkpoint name="cross_leaf_via_spine1" label="Cross-leaf reachability (gpu1 ↔ gpu3)" />

> 💡 **Important**: this works through *one* spine. spine2 isn't up yet, so there's no ECMP. A traceroute would show exactly one path. In a real AllReduce workload right now, every gradient byte between leaf1 and leaf2 would serialize on spine1 — and if spine1 fails, the entire training job stalls. This is why we need spine2.

---

## Step 4: Bring up `spine2` — and watch ECMP arrive

Open the `spine2` console. Same pattern as spine1 — interfaces are pre-provisioned, so you only configure BGP (router-id `10.0.0.2`, neighbors on the `10.1.2.*` block).

```sh
vtysh
```

```
configure terminal
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
  q 10.1.1.0, via eth1, weight 1
  q 10.1.2.0, via eth2, weight 1
```

That's ECMP. Two parallel paths to leaf2's loopback — one via spine1, one via spine2. (Both lines show the `q` flag — queued for ASIC-offload confirmation, installed and forwarding; see the callout in Step 2. If you'd rather see the compact form, `show ip route bgp` gives `B>q 10.0.1.2/32 [20/0] via 10.1.1.0, eth1 / via 10.1.2.0, eth2`.)

<checkpoint name="spine2_ecmp" label="ECMP — Leaf 1 has 2 paths to Leaf 2" />

> 💡 **ECMP is now live, and this is *the* foundational primitive of AI DC fabrics**. AllReduce splits gradient updates into many concurrent flows; with ECMP, each flow hashes (typically on the 5-tuple) to one of the available spines, so the aggregate bandwidth between any two leaves = N × spine_bw, not 1 × spine_bw. With single-path routing, you'd serialize all gradient sync on one spine, and the training step would stall waiting for that one bottleneck. ECMP + `multipath-relax` + `maximum-paths` are the three settings that make this possible — miss any one and ECMP silently doesn't work.

Try the cross-leaf ping again from gpu1 — still works, and now it's redundant.

---

## Step 5: Bring up `leaf3`

Same pattern. Leaf3 configuration:

- ASN: **65103**
- Loopbacks: `10.0.1.3/32`, `10.0.10.3/32`
- eth1 (to spine1): `10.1.1.5/31` → neighbor `10.1.1.4`
- eth2 (to spine2): `10.1.2.5/31` → neighbor `10.1.2.4`
- eth3 (to gpu5): `10.2.3.0/31`
- eth4 (to gpu6): `10.2.3.2/31`
- network statements: 4 lines (loopback + VTEP + 2 worker /31s)


---

## Step 6: Bring up `leaf4`

- ASN: **65104**
- Loopbacks: `10.0.1.4/32`, `10.0.10.4/32`
- eth1: `10.1.1.7/31` → neighbor `10.1.1.6`
- eth2: `10.1.2.7/31` → neighbor `10.1.2.6`
- eth3 (to gpu7): `10.2.4.0/31`
- eth4 (to gpu8): `10.2.4.2/31`

Once both leaves are up:

<checkpoint name="all_leaves_established" label="Leaf 3 and Leaf 4 fully peered" />

---

## End-to-end verification

Open the **gpu1** console and spot-check a worker on the far side of the fabric:

```sh
ping -c 2 10.2.4.3       # gpu8, attached to leaf4
```

Expected: success. Traffic hashes across both spines.

Look at ECMP from any leaf:

```sh
vtysh -c "show ip route 10.0.1.3"
```

Expected: 2 next-hops (one via spine1, one via spine2).

Then run the full check suite — click **Submit ✓** in the top bar. The orchestrator will:

1. Re-run every step-level checkpoint above.
2. Run a pairwise 56-ping mesh across all 8 workers.
3. Show you a per-check pass/fail card right below this guide.

If everything passes, the lab stamps as **Passed**, a completion screen appears with your timing stats, and a CTA appears for Lab 2.

If something fails, the card shows you exactly which check failed and why. Fix it, then click **Submit ✓** again (it's idempotent — your attempts counter just ticks up).

---

## 💡 Bonus: simulate a link failure

This is what convinces you that fast timers + ECMP actually matter.

On the **spine1** console:

```sh
ip link set eth3 down    # cut the spine1 ↔ leaf3 link
```

On the **leaf3** console:

```sh
vtysh -c "show ip bgp summary"
```

Within ~9 seconds (timers 3 9 — hold timer expired), the spine1 peer (`10.1.1.4`) should be `Idle` or `Active`.

From the **gpu5** console (gpu5 is attached to leaf3):

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

## Stuck? Want to restart?

| You want to… | Click |
|---|---|
| See the canonical answer for any step | **Reveal solution** in the top bar |

---

