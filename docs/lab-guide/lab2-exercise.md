# Exercise — Build the EVPN-VXLAN overlay, one piece at a time

> Read [`lab2-overview.md`](lab2-overview.md) first if you haven't.

## Scenario

The fabric you built in Lab 1 is up. Every leaf can route to every other leaf via two ECMP paths through the spines. That underlay is fine for any L3 service — but the AI team wants a single flat L2 segment that spans all four leaves, so they can plug `gpu1`..`gpu8` into it later and run a Gloo/NCCL collective without any per-host L3 plumbing.

Your job: add an **EVPN-VXLAN overlay** on top of the underlay. You'll set up the L2 segment on each leaf using **SONiC's native CLI** (`config vlan`, `config vxlan`), activate the BGP L2VPN-EVPN address family on every device with `vtysh`, watch Type-2 MAC routes propagate through the spines, and end with a ping that rides a real VXLAN tunnel from `leaf1` to `leaf3`.

You'll build the **leaves first** (so each leaf has something to advertise), then the **spines** (so the leaves' routes can actually traverse the fabric), then verify and ping.

### Why an AI Data Center needs this overlay

Distributed training is fundamentally a **broadcast/multicast workload**. AllReduce shuffles gradients between every pair of GPUs every step; NCCL's optimized collectives use multicast trees; bootstrap rendezvous uses raw broadcasts. All of that is cheap when every GPU is on one L2 segment, and *very* expensive when they're spread across L3 boundaries.

EVPN-VXLAN gives you both:

- **L3 everywhere** in the underlay (ECMP, fast convergence, scalable to thousands of switches)
- **L2 where it matters** in the overlay (the GPUs see one flat wire, ARP works, the rendezvous protocol works, NCCL's optimized comms work)

This pattern is what every hyperscale AI fabric runs — Microsoft, Meta, Google internal, AWS HyperPod. Same control plane, same data plane, just at thousand-switch scale instead of six.

## Step 1: Bring up the L2 segment on `leaf1` (via SONiC CLI)

Click **Topology** → `leaf1`. New terminal tab.

### Look at what's there

```sh
show vxlan tunnel
show vxlan vlanvnimap
ip -br link show | grep -E 'Vlan|vxlan|vtep'
```

Expected: `show vxlan tunnel` says "no entries" or returns empty headers — no VXLAN tunnels configured yet. `ip -br link show` shows no `Vlan*` or `vtep*` devices. **The overlay is purely additive** — you're going to create new SONiC objects, leave the existing underlay alone.

### Create the L2 segment, the VTEP, and the EVPN binding — one command at a time

Five `config` commands build the whole data plane (no `vtysh` for this part). Run them **one at a time** and watch the overlay grow on each leaf — the diagram after each command shows exactly what you just created.

**1. Create the VLAN (the L2 segment).**

```sh
config vlan add 1000
```

```
leaf1
  +---------------------+
  | Bridge / VLAN 1000  |   <-- NEW: an empty L2 broadcast domain (one flat wire)
  +---------------------+
  no IP yet . no tunnel yet
```

SONiC creates the backing Linux bridge `Bridge` and `Vlan1000@Bridge` together — a VLAN *is* a bridge in SONiC's single-bridge model.

**2. Add the SVI (an L3 interface on the segment).**

```sh
config interface ip add Vlan1000 192.168.100.1/24
```

```
leaf1
   Vlan1000  192.168.100.1/24   <-- NEW: SVI -- the L3 way in/out of the segment
        |
  +---------------------+
  | Bridge / VLAN 1000  |
  +---------------------+
```

This is the IP we ping from later, and in Lab 3 the GPU workers land in this same `192.168.100.0/24` subnet with this SVI as their first hop.

**3. Create the VTEP (the VXLAN tunnel endpoint).**

```sh
config vxlan add vtep 10.0.10.1
```

```
leaf1
   Vlan1000  192.168.100.1/24
        |
  +---------------------+
  | Bridge / VLAN 1000  |
  +---------------------+

  +---------------------------+
  | vtep-1000  src 10.0.10.1  |   <-- NEW: encap endpoint (not wired to the VLAN yet)
  +---------------------------+
```

The VTEP sources packets from this leaf's VTEP loopback `10.0.10.1` — already advertised by the Lab 1 underlay, so every other leaf can reach it.

**4. Bind the VTEP to EVPN signaling.**

```sh
config vxlan evpn_nvo add nvo1 vtep
```

```
  +-------------------------------------------+
  | vtep-1000  src 10.0.10.1   EVPN-NVO: nvo1 |   <-- NEW: tunnel joins the EVPN control plane
  +-------------------------------------------+
```

`evpn_nvo` is the flag that says "generate BGP L2VPN-EVPN routes for whatever rides this tunnel." Without it the tunnel exists but BGP never advertises it.

**5. Map the VLAN onto the tunnel (VLAN 1000 ⇄ VNI 10100).**

```sh
config vxlan map add vtep 1000 10100
```

```
leaf1
   Vlan1000  192.168.100.1/24
        |
  +---------------------+
  | Bridge / VLAN 1000  |
  +---------------------+
        |
        |  map: VLAN 1000 <--> VNI 10100   <-- NEW: bind the segment to the tunnel
        v
  +-------------------------------------------+
  | vtep-1000  src 10.0.10.1   EVPN-NVO: nvo1 |
  +-------------------------------------------+
        |
        v  VXLAN encap (UDP 4789, VNI 10100)  -->  underlay  -->  remote VTEPs
```

That's the whole data-plane setup — five SONiC primitives, five commands. The map is the keystone: it's what turns "a VLAN" and "a tunnel" into "this L2 segment travels the fabric as VNI 10100."

> 💡 **What just happened under the hood**: each `config` command wrote an entry to SONiC's `config_db.json`. `swssconfig` picked the entries up and programmed the kernel: a Linux bridge named `Bridge`, a VLAN sub-interface `Vlan1000@Bridge`, and a VXLAN device `vtep-1000`. You can see the kernel objects with `ip -br link show`, and the SONiC view with `show vxlan tunnel`.

> 💡 **Why a VLAN, not just a VXLAN device?** SONiC's data model says: a VLAN is the L2 segment, a VXLAN tunnel is the encap endpoint, and a `map` entry connects "VLAN 1000 here ↔ VNI 10100 over the wire." This factoring lets one VXLAN tunnel carry many VLANs (with one map entry each). At hyperscale that matters — you don't want one VXLAN device per tenant per leaf.

> 💡 **Why `config interface ip add Vlan1000 192.168.100.1/24`?** That's the per-leaf "I'm participating in this segment at this IP" announcement. For our verification ping (leaf-to-leaf), this is the IP we'll send from. In Lab 3, real workers will get IPs in this same 192.168.100.0/24 subnet and reach the leaf as their first hop.

> 💡 **What's an EVPN NVO?** "Network Virtualization Overlay" — the binding object that tells SONiC "this VXLAN tunnel is part of the EVPN signaling plane, so generate Type-2/Type-3 routes for any VNI mapped to it." Without `evpn_nvo`, the tunnel exists but FRR's EVPN AF wouldn't know to advertise anything for it.

### Verify

```sh
show vxlan tunnel
show vxlan vlanvnimap
ip -br link show Vlan1000 vtep-1000
ip addr show Vlan1000
```

Expected from `show vxlan tunnel`:

```
vxlan tunnel name    source ip    destination ip    tunnel map name     tunnel map mapping(vni -> vlan)
-------------------  -----------  ----------------  ------------------  ---------------------------------
vtep                 10.0.10.1                      map_10100_Vlan1000  10100 -> Vlan1000
```

`source ip` is your VTEP loopback. `destination ip` is empty because EVPN populates remote VTEPs dynamically (we haven't activated the control plane yet, so no remotes known).

Expected from `ip -br link show`:

```
Vlan1000@Bridge  UP   <MAC>   <BROADCAST,MULTICAST,UP,LOWER_UP>
vtep-1000        UNKNOWN  <MAC>  <BROADCAST,MULTICAST,UP,LOWER_UP>
```

> 💡 **Don't run the checkpoint yet** — `bridges_up` checks *all four leaves*, and only leaf1 is set up so far. Click it after Step 2 (you've done all four).

---

## Step 2: Repeat on `leaf2`, `leaf3`, `leaf4`

Same five commands per leaf, just substitute the leaf-specific IPs:

| Leaf | `config interface ip add` | `config vxlan add` |
|---|---|---|
| leaf2 | `Vlan1000 192.168.100.2/24` | `vtep 10.0.10.2` |
| leaf3 | `Vlan1000 192.168.100.3/24` | `vtep 10.0.10.3` |
| leaf4 | `Vlan1000 192.168.100.4/24` | `vtep 10.0.10.4` |

For each leaf, paste:

```sh
config vlan add 1000
config interface ip add Vlan1000 192.168.100.<N>/24
config vxlan add vtep 10.0.10.<N>
config vxlan evpn_nvo add nvo1 vtep
config vxlan map add vtep 1000 10100
```

After all four leaves are done:

<checkpoint name="bridges_up" label="VLAN + VXLAN tunnel up on every leaf" />

---

## Step 3: Activate the L2VPN-EVPN control plane on every leaf (via `vtysh`)

The data plane is up but no routes are flowing yet. Now activate the BGP address family that signals MAC reachability.

Open `leaf1`'s console, enter `vtysh`:

```
configure terminal
router bgp 65101
 address-family l2vpn evpn
  neighbor SPINES activate
  advertise-all-vni
 exit-address-family
end
```

> 💡 **Why a separate address family?** BGP carries different route types in different address families — IPv4 unicast for L3 prefixes (what you set up in Lab 1), IPv6 unicast, VPNv4 for MPLS L3VPN, **L2VPN-EVPN** for our overlay. Each AF has its own set of routes per neighbor. Same TCP session, same neighbor, different route table.

> 💡 **Why `vtysh` here instead of `config bgp`?** Modern SONiC's `config bgp` CLI is intentionally minimal — only `device-global`, `remove`, `shutdown`, `startup`. The full neighbor / address-family lifecycle isn't surfaced through it; production SONiC operators drive BGP through the `BGP_GLOBALS*` config_db tables (or YANG/mgmtd in newer builds), and `vtysh` for interactive work. We use `vtysh` here for the same reason a SONiC engineer would: it's the direct interactive surface. See [ADR-008](../../notes/decisions.md) and [ADR-011](../../notes/decisions.md) for the history.

> 💡 **What does `advertise-all-vni` actually do?** It tells FRR: "scan the kernel for VXLAN devices, and for every VNI you find, originate Type-3 (inclusive multicast) routes immediately, and Type-2 (MAC) routes for any MAC that lands in the bridge fdb." This is why you set up the kernel devs *first* — `advertise-all-vni` is a **discovery** mechanism, not a creation one.

Repeat the same `vtysh` block on `leaf2`, `leaf3`, `leaf4` — changing the `router bgp <ASN>` line to the leaf's own ASN (65102, 65103, 65104).

Quick sanity check on leaf1:

```
show evpn vni
```

Expected: a single line for VNI 10100, bound to `vtep-1000`, Local VTEP IP `10.0.10.1`. **This is the proof that FRR found the SONiC-created VXLAN device** — without it, EVPN would have nothing to advertise.

---

## Step 4: Activate L2VPN-EVPN on the spines (the load-bearing knob)

The spines need to **transit** EVPN routes between leaves without breaking the next-hop. Without this, your control plane will look perfect but the data plane will silently fail.

Open `spine1`'s console, enter `vtysh`:

```
configure terminal
router bgp 65000
 address-family l2vpn evpn
  neighbor LEAVES activate
 exit-address-family
end
```

Same block on `spine2`. That's it — just one line per spine (`neighbor LEAVES activate`). The conceptual callout is below, and it's important.

> 💡 **The shared-AS-spine EVPN next-hop concern — and how FRR quietly handles it for us**:
>
> The textbook concern: in a shared-AS-spine CLOS, when a spine relays a Type-2 route from leaf1 to leaf3, standard eBGP behavior says "rewrite the next-hop to me before forwarding." Walked through that failure mode:
>
> 1. leaf1 originates a Type-2 route for some MAC behind its VTEP `10.0.10.1`. The route's next-hop = `10.0.10.1`.
> 2. spine1 receives it. If it applies the default next-hop-self rewrite, the next-hop becomes `10.0.0.1` (spine1's router-id).
> 3. spine1 advertises to leaf3 with next-hop `10.0.0.1`. leaf3 programs its bridge fdb: "VXLAN-tunnel to `10.0.0.1`."
> 4. **`10.0.0.1` is not a VTEP** — it's spine1's router-id loopback. spine1 has no VXLAN device, no UDP 4789 listener.
> 5. Frame arrives at spine1, kernel drops it silently. Ping fails. Routes look right. Nothing in logs.
>
> **In FRR, that rewrite does not fire** for L2VPN-EVPN routes on eBGP peers — FRR preserves the original VTEP next-hop by default. Verified empirically on this image (FRR 10.4.1): `vtysh -c "show bgp l2vpn evpn"` on leaf3 shows next-hops like `10.0.10.1(spine1)` (= leaf1's VTEP, learned via spine1), not `10.0.0.1`. The data-plane gotcha doesn't bite here.
>
> **Should you still add an explicit knob?** In production templates, yes — defense-in-depth, makes the intent visible to the next operator, protects against future defaults changing. The relevant commands depending on FRR version:
> - **FRR 8.x+** (and possibly future FRR): `neighbor LEAVES next-hop-unchanged`
> - **FRR 7.x**: `neighbor LEAVES attribute-unchanged next-hop`
> - **In *this* sonic-vs build (FRR 10.4.1)**, neither knob has a visible effect — `next-hop-unchanged` returns `% Unknown command`, and `attribute-unchanged next-hop` is silently accepted but not persisted into `show running-config`. There's no working spine-side knob in this image; the FRR default is the only mechanism. We leave the spine config as just `activate` and rely on it.
>
> **Always verify a config push actually loaded** with `vtysh -c "show running-config"`. `vtysh -b` (the boot-time parser) eats unknown or no-op commands without warning.

After both spines are activated:

<checkpoint name="evpn_neighbors_up" label="BGP EVPN sessions Established (leaf↔spine)" />

---

## Step 5: Verify the EVPN control plane is working

Open `leaf1`'s console, `vtysh`:

```
show bgp l2vpn evpn summary
```

Expected: two rows, one per spine, both with int PfxRcd ≥ 1.

```
Neighbor          V    AS     ...  State/PfxRcd
spine1(10.1.1.0)  4   65000   ...  6
spine2(10.1.2.0)  4   65000   ...  6
```

(Exact PfxRcd varies — typically ~3-6 depending on RD/RT auto-derivation; the important bit is it's an int, not `Active` or `Idle`.)

Then look at the actual routes:

```
show bgp l2vpn evpn
```

Expected: a multi-RD listing with Type-2 (MAC) and Type-3 (inclusive multicast) routes from every other leaf's VTEP (`10.0.10.2`, `10.0.10.3`, `10.0.10.4`).

Type-2 routes look like:

```
*> [2]:[0]:[0]:[48]:[<some_mac>]
                    10.0.10.2                                    0 65000 65102 i
```

Type-3 (inclusive multicast — how the bridge knows to head-end-replicate BUM traffic) look like:

```
*> [3]:[0]:[32]:[10.0.10.2]
                    10.0.10.2                                    0 65000 65102 i
```

Three remote VTEPs visible in the next-hop column:

<checkpoint name="type2_routes_present" label="Leaf1 sees Type-2 MAC routes from all VTEPs" />

> 💡 **Walking the route format**: `[2]:[0]:[0]:[48]:[mac]` reads as `<RouteType>:<EthernetTag>:<MAC-IP-encoding>:<MAC-len-in-bits>:<MAC>`. Type-2 routes are the heart of EVPN's L2 plane — for every MAC the kernel learns on a VXLAN-attached bridge, FRR originates one of these to every EVPN peer. At hyperscale (thousands of MACs per leaf, thousands of leaves), this becomes a **lot** of routes; production fabrics tune RT filtering to cut the per-leaf import set.

---

## Step 6: Verify the data plane

You have two equally-good views into the same data — the SONiC-native one and the FRR one.

### Option A — SONiC view (drop out of vtysh first):

```sh
show vxlan remotevtep
```

Expected: three rows, one per remote leaf's VTEP IP. `Creation Source: EVPN` confirms the tunnels were learned via BGP signaling, not statically configured.

```
SIP         DIP        Creation Source    OperStatus
----------  ---------  -----------------  ------------
10.0.10.1   10.0.10.2  EVPN               oper_up
10.0.10.1   10.0.10.3  EVPN               oper_up
10.0.10.1   10.0.10.4  EVPN               oper_up
```

### Option B — FRR view (still in vtysh):

```
show evpn vni 10100
```

Expected: one entry for VNI 10100, bound to `vtep-1000` and your local VTEP IP, with **three remote VTEPs** listed under "Remote VTEPs for this VNI":

```
VNI: 10100
 Type: L2
 VxLAN interface: vtep-1000
 Local VTEP IP: 10.0.10.1
 Remote VTEPs for this VNI:
  10.0.10.4 flood: HER
  10.0.10.2 flood: HER
  10.0.10.3 flood: HER
 Number of MACs (local and remote) known for this VNI: 1
 Number of ARPs (IPv4 and IPv6, local and remote) known for this VNI: 3
```

The three `flood: HER` lines are the **head-end-replication targets** populated from the Type-3 inclusive-multicast routes EVPN exchanged — they tell the kernel "when you need to BUM-flood, send one copy to each of these VTEPs."

Here's the overlay you just signaled into existence. From `leaf1`'s VTEP, EVPN learned the three remote VTEPs and wired a head-end-replication target for each:

```
                              +--> vtep 10.0.10.2  (leaf2)
                              |
   Vlan1000 --> vtep-1000 ----+--> vtep 10.0.10.3  (leaf3)
   (VNI 10100)  10.0.10.1     |
                              +--> vtep 10.0.10.4  (leaf4)
```

Across all four leaves it's a **full mesh** — a VXLAN tunnel between every pair of VTEPs, each one learned from BGP-EVPN (never statically configured):

```
       V1 ============= V2          V1 = vtep 10.0.10.1 (leaf1)
       | \           / |            V2 = vtep 10.0.10.2 (leaf2)
       |   \       /   |            V3 = vtep 10.0.10.3 (leaf3)
       |     \   /     |            V4 = vtep 10.0.10.4 (leaf4)
       |       X       |
       |     /   \     |            Each line is a VXLAN tunnel
       |   /       \   |            carrying VNI 10100 between two
       | /           \ |            VTEPs (4 VTEPs -> 6 tunnels).
       V3 ============= V4
```

<checkpoint name="remote_vteps_learned" label="Remote VTEPs visible to leaf1" />

> 💡 **Two views, one data plane**: SONiC's `show vxlan remotevtep` reads from APP_DB (which swssconfig keeps in sync with the kernel's VXLAN tunnel state); FRR's `show evpn vni` reads from FRR's own EVPN table. Both should always show the same three remote VTEPs when the overlay is working. If they disagree, the SONiC view is what the actual data plane is doing; the FRR view is what BGP *thinks* should be happening. They diverged in the lab's older `netreplica/docker-sonic-vs:latest` (2022) image because swssconfig didn't back-sync EVPN-learned remote VTEPs into APP_DB — that bug is fixed in the current `aidc/sonic-vs:202511` build.

> 💡 **What you've just verified**: EVPN's signaling actually programmed the SONiC data plane. The Type-3 inclusive-multicast routes from each remote leaf got translated by FRR + SONiC's pipeline into kernel-level entries that tell the VXLAN device "when you need to BUM-flood, head-end-replicate to these VTEPs." This is the moment the control plane and data plane are wired together.

---

## Step 7: First overlay packet

The moment of truth. Open `leaf1`'s console:

```sh
ping -c 2 -W 2 -I Vlan1000 192.168.100.3
```

Expected: success.

```
PING 192.168.100.3 (192.168.100.3) from 192.168.100.1 Vlan1000: 56(84) bytes of data.
64 bytes from 192.168.100.3: icmp_seq=1 ttl=64 time=1.23 ms
64 bytes from 192.168.100.3: icmp_seq=2 ttl=64 time=0.41 ms
```

<checkpoint name="overlay_ping_pair" label="Leaf1 → Leaf3 overlay ping (first packet)" />

> 💡 **What just happened, packet by packet**:
> 1. `ping` issues an ICMP echo from `192.168.100.1` to `192.168.100.3` out interface `Vlan1000`.
> 2. The bridge needs to know the destination MAC. Sends an ARP-who-has for `192.168.100.3`. Since the bridge has no entry yet for that MAC, the ARP is BUM-flooded.
> 3. BUM flooding looks at the head-end-replication list (those entries from the Type-3 routes). One copy of the ARP request is encap'd in a VXLAN packet for each remote VTEP.
> 4. The underlay routes those VXLAN packets to each VTEP. `leaf3` decap's its copy, sees an ARP for `192.168.100.3` which is its own `Vlan1000` IP, responds.
> 5. The ARP reply comes back encap'd from `leaf3`'s VTEP to `leaf1`'s VTEP. The underlay routes it. `leaf1` decap's, learns `192.168.100.3`'s MAC, and originates a Type-2 route for `192.168.100.3`'s IP-MAC binding.
> 6. Subsequent ICMP packets find a unicast fdb entry, get VXLAN-encap'd directly to `leaf3`'s VTEP, no flooding.
>
> **One ping = one full control-plane + data-plane cycle. The overlay is live.**

---

## End-to-end verification

The final check is a leaf-to-leaf ping mesh — every leaf pings every other leaf over the overlay (12 pings: 4 sources × 3 destinations). Click **Submit ✓** in the top bar. The orchestrator will:

1. Re-run every step-level checkpoint.
2. Run the 12-pair leaf-to-leaf overlay ping mesh.
3. Show you a per-check pass/fail card below this guide.

If everything passes, the lab stamps as **Passed**, the completion screen appears, and the CTA for Lab 3 ("Bring GPUs onto the overlay + first AllReduce") lights up.

If something fails, look at the most-likely-cause table in [`lab2-solution.md`](lab2-solution.md). The four common gotchas, in priority order:

1. Mistyped the spine's next-hop knob (e.g. wrote `next-hop-unchanged`, which is rejected by this image's FRR 10.4.1, or `attribute-unchanged next-hop`, which is silently accepted but not persisted into running-config) — overlay still works thanks to FRR's default-preserves behavior, but the line you typed won't show in `vtysh -c "show running-config"`
2. Forgot `advertise-all-vni` on a leaf → no Type-2/Type-3 routes from that leaf
3. Forgot `config vxlan evpn_nvo add` on a leaf → tunnel exists but EVPN doesn't see it
4. Mismatched VNI or VLAN across leaves → tunnels build but frames are dropped at decap

---

## Stuck? Want to restart?

| You want to… | Click |
|---|---|
| See the canonical answer for any step | **Reveal solution** in the top bar |
| Wire the full overlay end-to-end without typing | **Solve** in the top bar (your run is flagged "solved") |
| Wipe overlay state + restore healthy underlay | **Reset** in the top bar |
| Run all checks now | **Submit ✓** in the top bar |

> Your edits live in the running SONiC config_db + FRR daemons. They don't survive a switch container restart — but the orchestrator never restarts switch containers, so you can safely walk away. Close the browser; come back tomorrow; session, lab state, attempts, and last-submit result all persist.

---

## Where to go next

- [`lab2-solution.md`](lab2-solution.md) — copy-pasteable answer key (5 SONiC CLI commands per leaf + 6 vtysh blocks: 4 leaves activating EVPN with `advertise-all-vni` + 2 spines activating EVPN with just `activate` — FRR preserves EVPN next-hops by default) + common-mistakes troubleshooter
- [`../topology.md`](../topology.md) — full IP / link / BGP reference
- [`../switch-cli-reference.md`](../switch-cli-reference.md) — SONiC + vtysh CLI cheat sheet
- [`../../notes/decisions.md`](../../notes/decisions.md) — ADR-002 (the textbook shared-spine-AS EVPN gotcha + the empirical finding that FRR preserves L2VPN-EVPN next-hops by default), ADR-005 (why one stretched L2 segment is the right shape for an AI fabric), ADR-008 (why we use `config vxlan` for L2/VXLAN but `vtysh` for BGP), and ADR-011 (upgrading to `aidc/sonic-vs:202511` / FRR 10.4.1)
