# Exercise — Build an SRv6 uSID transport, one piece at a time

> Read [`lab5-overview.md`](lab5-overview.md) first if you haven't — it has the addressing table you'll reference throughout.

## Scenario

Your fabric is humming: IPv4 underlay, EVPN-VXLAN overlay, eight GPUs on `192.168.100.0/24`, telemetry live. Nothing here is going away. The architecture team wants to evaluate **SRv6** as a future transport — encode forwarding instructions as IPv6 addresses, carry traffic in micro-SIDs, and get per-flow ECMP "for free" from the IPv6 flow label — **without** ripping out VXLAN to try it.

So you'll **dual-stack and migrate additively**. When you clicked **Start ▶**, the orchestrator pre-provisioned the IPv6 underlay for you: a `/127` on every spine↔leaf link, an IPv6 BGP session per link, and each leaf's uSID locator `/48` advertised with ECMP via both spines. The seg6 kernel switches (`seg6_enabled`, IPv6 forwarding, IPv6 multipath hashing, flow-label derivation) are already on. **Your job is the SRv6 layer itself**: locators, endpoints, headend — built on the four leaves while VXLAN keeps pinging the whole time.

You'll build **leaf1 and leaf3 fully first** (they're the two ends of the demo path), then replicate onto **leaf2 and leaf4**, then send a uSID packet across the fabric and watch it load-spread.

### Why an AI Data Center cares about SRv6

VXLAN is a great overlay, but it's an *overlay* — opaque to the fabric, a fixed UDP tunnel between two VTEPs. SRv6 puts the steering **in the packet's IPv6 header**, which buys an AI DC three things:

- **Traffic engineering** — you can pin a flow down a specific path (a low-latency rail, a drained spine) by listing segments, without per-flow state in the fabric.
- **One protocol, end to end** — the same SRv6 can run on the GPU server's NIC, the leaf, and the WAN, so a tenant's traffic keeps its policy across domains.
- **Native per-flow ECMP** — because the steering rides in IPv6 and Linux derives the outer flow label from the inner flow, collective traffic spreads across every spine path automatically. That last property is the one we'll prove.

This is the direction hyperscale fabrics are moving — uSID specifically, because its header overhead is tiny enough to live alongside RDMA.

---

## Step 1: Look at the dual-stack underlay you were handed

Open the **Topology** tab and click `leaf1` (or hit **+** in the terminal pane and pick `leaf1`). A console opens.

### Confirm IPv4 + VXLAN are still completely fine

```sh
vtysh -c "show ip bgp summary" | head -12
ping -c1 -I Vlan1000 192.168.100.3
```

The IPv4 underlay is up and a VXLAN overlay ping to leaf3 still works — **you haven't touched any of it.** Everything you do in this lab is additive.

### Now look at the new IPv6 layer underneath

```sh
ip -6 addr show dev eth1 | grep inet6
vtysh -c "show bgp ipv6 unicast summary" | head -12
vtysh -c "show ipv6 route fcbb:bb00:3::/48"
```

Expected: `eth1` carries `fc00:1:1::1/127` (the link to spine1), the IPv6 BGP sessions to both spines are **Established**, and leaf3's locator `fcbb:bb00:3::/48` is in the RIB **via two nexthops** — one through each spine:

```
leaf1's view of leaf3's locator:
  fcbb:bb00:3::/48
     via fc00:1:1::0  (spine1)   <-- ECMP path 1
     via fc00:2:1::0  (spine2)   <-- ECMP path 2
```

That two-way ECMP is the whole reason uSID traffic will load-spread. It's pre-built; you just confirmed it.

<checkpoint name="dualstack_underlay_healthy" label="Dual-stack underlay healthy — IPv4+IPv6 BGP, locators reachable via ECMP" />

> 💡 **Why this matters in AI DCs**: dual-stacking is how real fabrics adopt SRv6 — you light up IPv6 + a locator block alongside the production IPv4/VXLAN and migrate services one at a time. The fabric never goes down for the transport swap; the two coexist for as long as the migration takes (often years). You're seeing the first hour of that migration.

---

## Step 2: Define the uSID locator (the control plane)

A **locator** is a leaf's block of SRv6 address space — its `/48` — plus the rule for carving SIDs out of it. It's a control-plane object, so it lives in FRR. Drop into `vtysh` on `leaf1`:

```sh
vtysh
conf t
segment-routing
 srv6
  locators
   locator MAIN
    prefix fcbb:bb00:1::/48 block-len 32 node-len 16
    behavior usid
end
```

```
leaf1  locator MAIN
  fcbb:bb00:1::/48
  |__ block 32 bits __|__ node 16 __|__ function 16 __|
     fcbb:bb00          0001            (per-SID)
     "which fabric"     "which leaf"    "which behavior"
  behavior: uSID   <-- compressed micro-segments
```

Confirm it landed, then leave vtysh:

```sh
end
do show segment-routing srv6 locator
exit
```

You should see `MAIN ... fcbb:bb00:1::/48 ... Up`, behavior **uSID**.

**Now repeat on `leaf2`, `leaf3`, `leaf4`** — open a console on each and run the same block with **its own** locator prefix:

| Leaf | `prefix` line |
|---|---|
| leaf2 | `prefix fcbb:bb00:2::/48 block-len 32 node-len 16` |
| leaf3 | `prefix fcbb:bb00:3::/48 block-len 32 node-len 16` |
| leaf4 | `prefix fcbb:bb00:4::/48 block-len 32 node-len 16` |

When all four leaves report their locator `Up`, run the check.

<checkpoint name="srv6_locators_configured" label="uSID locators defined on all 4 leaves" />

> 💡 **Why this matters in AI DCs**: the locator is a leaf's *identity* in SRv6 — one summarizable `/48` that the whole fabric routes toward, no matter how many individual SIDs (endpoints, VPNs, policies) the leaf later carves from it. That summarization is why SRv6 scales to fabrics with hundreds of thousands of endpoints without exploding the routing table — the spines only ever carry one `/48` per leaf, exactly what you saw in Step 1.

---

## Step 3: Program the endpoint — make the leaf decapsulate (`End.DT6`)

The locator told the *control plane* "this `/48` is mine." Now you program the *data plane*: an **endpoint SID** the leaf will match, decapsulate, and deliver from. The endpoint behavior is a kernel `seg6local` route. Back in the `leaf1` **shell** (type `exit` if you're still in vtysh):

```sh
ip link add srv6end type dummy
ip link set srv6end up
sysctl -w net.ipv6.conf.srv6end.seg6_enabled=1
ip -6 route replace fcbb:bb00:1:fe00:: encap seg6local action End.DT6 table 255 dev srv6end
```

```
leaf1  endpoint
   fcbb:bb00:1:fe00::   --(arrives wrapped)-->  End.DT6
                                                  |__ strip outer IPv6/uSID
                                                  |__ look inner up in table 255 (local) = deliver here
                                                  |__ deliver to fd00:100:1::x  (local)
   bound to:  srv6end  (a dummy device -- NOT lo!)
```

Verify it attached — the packet counter is your ground truth:

```sh
ip -6 -s route show fcbb:bb00:1:fe00::
```

You should see `encap seg6local action End.DT6 ... dev srv6end` (and `packets 0` for now — it'll climb in Step 5).

> ⚠️ **The trap that will cost you an hour if you hit it**: an `End.DT6` route on **`dev lo`** is *silently accepted and does nothing* — `ip route show` prints a plain route with no `encap`, and any uSID packet that arrives gets an ICMP "destination unreachable." seg6local endpoints **must** bind to a real device. That's why we created the `srv6end` dummy. If your endpoint check fails, this is the first thing to look at.

**Repeat on `leaf2`, `leaf3`, `leaf4`** — same four commands, each with **its own** endpoint SID (`fcbb:bb00:2:fe00::`, `fcbb:bb00:3:fe00::`, `fcbb:bb00:4:fe00::`).

<checkpoint name="endpoint_sids_installed" label="End.DT6 endpoints decapsulating on every leaf" />

> 💡 **Why this matters in AI DCs**: `End.DT6` is "decapsulate and look the inner packet up in a table" — and that *table* is the hook for multi-tenancy. Point different endpoint SIDs at different VRF tables and one fabric carries many isolated tenants' GPU pods over a shared SRv6 core, each only reaching its own hosts. It's the SRv6 equivalent of an EVPN L3VNI, done with one kernel route.

---

## Step 4: Program the headend — steer flows into a uSID (`H.Encaps.Red`)

The endpoint lets a leaf *receive* uSID traffic. The **headend** lets it *send*: a route that says "for traffic to that remote service prefix, wrap it in the remote leaf's uSID." On `leaf1`, install a headend for each other leaf's service prefix:

```sh
ip -6 route replace fd00:100:2::/64 encap seg6 mode encap.red segs fcbb:bb00:2:fe00:: dev eth1
ip -6 route replace fd00:100:3::/64 encap seg6 mode encap.red segs fcbb:bb00:3:fe00:: dev eth1
ip -6 route replace fd00:100:4::/64 encap seg6 mode encap.red segs fcbb:bb00:4:fe00:: dev eth1
```

```
a flow leaf1 -> fd00:100:3::5  gets wrapped (H.Encaps.Red, no SRH):

 inner:  [ IPv6 | fd00:100:1::1 -> fd00:100:3::5 ]            the real packet
                         |
                         v   leaf1 headend
 outer:  [ IPv6 | leaf1 -> fcbb:bb00:3:fe00:: | flowlabel=hash(inner) ][ inner ]
                          ^^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^
                          leaf3's uSID in the    derived from the inner flow
                          outer DA (no SRH!)     => different per flow => ECMP
```

`mode encap.red` is **reduced** encap: a single uSID rides in the outer destination address with no separate routing header — minimum overhead.

**Now do the same on `leaf2`, `leaf3`, `leaf4`**, each steering the *other three* service prefixes into the matching uSID. (leaf3 needs a headend for `fd00:100:1::/64` so its replies to leaf1 ride SRv6 back — the path is symmetric.) The check inspects leaf1:

<checkpoint name="headend_steering_installed" label="Leaf1 steers remote service prefixes into uSID (headend)" />

> 💡 **Why this matters in AI DCs**: the headend is where **traffic engineering** lives. Today you steer with a single uSID = shortest path. List *more* segments and you pin a flow down a specific route — around a hot spine, onto a dedicated low-jitter rail for a latency-sensitive all-to-all, or through a firewall for a cross-tenant flow — all by editing one headend route, with zero new state in the fabric core. That's the SRv6 superpower VXLAN can't match.

---

## Step 5: Send a packet across the uSID transport

Everything's in place: leaf1 can wrap, the spines forward IPv6, leaf3 decapsulates. Send a flow from a host behind leaf1 to a host behind leaf3:

```sh
ping6 -c3 -I fd00:100:1::1 fd00:100:3::1
```

```
  leaf1 (headend)                         leaf3 (End.DT6)
  fd00:100:1::1  --wrap--> fcbb:bb00:3:fe00:: --decap--> fd00:100:3::1
                      \                       /
                       spine1  -- or --  spine2     (ECMP picks one per flow)
```

It should reply. To *prove* leaf3 actually decapsulated (rather than some other path), check its endpoint counter — it climbed:

```sh
# on leaf3:
ip -6 -s route show fcbb:bb00:3:fe00::
```

`packets` is now non-zero: that's leaf3 popping your uSID and delivering the inner packet locally.

<checkpoint name="srv6_path_works" label="Leaf1 → Leaf3 over the SRv6 uSID transport" />

> 💡 **Why this matters in AI DCs**: you just moved real traffic over a transport the fabric core has *no per-flow state* for — the spines are plain IPv6 routers. That statelessness is why SRv6 scales: adding a tenant, a policy, or a path is an edit at the *edge* (the leaf headend), never a touch to the thousands of switches in the middle. Collective traffic for a new training job lands on the fabric without anyone reconfiguring a spine.

---

## Step 6: Watch it spread across both spines, then Submit

A single ping is one flow — it picks one spine and stays there. The payoff is **many** flows spreading. Generate a burst of distinct flows from leaf1 to leaf3 (each destination address is a different flow → a different flow label → a different ECMP decision):

```sh
# on leaf1 — 16 parallel flows to distinct hosts behind leaf3:
for i in $(seq 1 16); do
  ping6 -q -i 0.2 -c 200 -I fd00:100:1::1 fd00:100:3::$i &
done
```

Open the **Telemetry** tab (the Grafana dashboard from Lab 4). Watch the **spine1 and spine2** ingress/egress toward leaf3 — **both light up**, splitting the flows between them (a hash spreads 16 flows, so expect a rough — not perfectly even — split; the more flows, the closer to 50/50):

```
            uSID traffic leaf1 -> leaf3, 16 flows
                       /              \
                 spine1                spine2
           some flows            the rest        <- per-flow ECMP on the flow label
                       \              /
                       leaf3 (End.DT6)
```

That's the same load-spreading you saw for VXLAN in Lab 4 — but the entropy is now the **IPv6 flow label** the kernel derived from each inner flow, not a VXLAN UDP source port. Two transports, same essential property, because both put per-flow entropy where the fabric's ECMP hash can see it.

Let the pings finish (or `kill %1 %2 ...`), then click **Submit ✓**. The finale verifies three things at once:

1. uSID traffic can spread — leaf1 still reaches leaf3's locator via **2** ECMP nexthops.
2. The SRv6 path works end-to-end (leaf1 → leaf3 over uSID).
3. **Regression** — the full 56-pair worker overlay mesh still pings. Your additive SRv6 work didn't disturb VXLAN one bit.

<checkpoint name="submit_finale" label="uSID ECMP across both spines + VXLAN mesh intact" />

> 💡 **Why this matters in AI DCs**: per-flow ECMP is not a nicety — a collective is N² flows between GPUs, and if they all pin to one spine you've halved your bisection bandwidth and your AllReduce stalls. Whether the transport is VXLAN or SRv6, the rule is the same: get per-flow entropy into a field the fabric hashes on. You've now built that property twice, two different ways — which is exactly the operator intuition this lab exists to give you.

---

## You're done

You stood up a complete SRv6 uSID transport — locators, endpoints, headend — **additively, alongside a live VXLAN fabric that never skipped a beat**, and proved it load-spreads per-flow across both spines. If everything passed, the lab stamps **Passed** and the CTA for **Lab 6 — Super Spines** lights up.

## Stuck? Want to restart?

| You want to… | Click |
|---|---|
| Wipe your SRv6 work + restore the clean dual-stack starting point | **Reset** in the top bar |
| Run all checks now | **Submit ✓** in the top bar |

**Reset** re-applies `_srv6_skeleton` — it tears down any `srv6end` device and seg6 routes you added and puts you back at the pre-provisioned dual-stack underlay (IPv4 + VXLAN + IPv6, no SRv6 layer). Your IPv4/VXLAN fabric is never touched by Reset.

### Where to go from here

- [`lab5-solution.md`](lab5-solution.md) — the full copy-pasteable config for all four leaves, a vtysh/`ip` ↔ behavior mapping, and a common-mistakes table
- [`../../notes/decisions.md`](../../notes/decisions.md) — **ADR-014** (why this lab is additive dual-stack with leaves as endpoints, and the `dev lo` spike finding)
- **Lab 6 — Super Spines — Beyond a Single-Pod CLOS** — the conceptual follow-on on multi-pod scale
