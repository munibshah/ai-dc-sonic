# Exercise — Build the EVPN-VXLAN overlay, one piece at a time

## Scenario

The fabric you built in Lab 1 is up. Every leaf can route to every other leaf via two ECMP paths through the spines. That underlay is fine for any L3 service — but the AI team wants a single flat L2 segment that spans all four leaves, so they can plug `gpu1`..`gpu8` into it later and run a Gloo/NCCL collective without any per-host L3 plumbing.

Your job: add an **EVPN-VXLAN overlay** on top of the underlay. You'll set up the L2 segment on each leaf using **SONiC's native CLI** (`config vlan`, `config vxlan`), activate the BGP L2VPN-EVPN address family on every device with `vtysh`, watch **Type-3 (inclusive-multicast) routes** propagate through the spines to build the flood list, and end with a ping that rides a real VXLAN tunnel from `leaf1` to `leaf3`. (Type-2 MAC routes come in Lab 3, once real GPU hosts put MACs on this segment.)

You'll build the **leaves first** (so each leaf has something to advertise), then the **spines** (so the leaves' routes can actually traverse the fabric), then verify and ping.

### Why an AI Data Center needs this overlay

Distributed training is fundamentally a **broadcast/multicast workload**. AllReduce shuffles gradients between every pair of GPUs every step; NCCL's optimized collectives use multicast trees; bootstrap rendezvous uses raw broadcasts. All of that is cheap when every GPU is on one L2 segment, and *very* expensive when they're spread across L3 boundaries.

EVPN-VXLAN gives you both:

- **L3 everywhere** in the underlay (ECMP, fast convergence, scalable to thousands of switches)
- **L2 where it matters** in the overlay (the GPUs see one flat wire, ARP works, the rendezvous protocol works, NCCL's optimized comms work)

This pattern is what every hyperscale AI fabric runs. Same control plane, same data plane, just at thousand-switch scale.

## Step 1: Bring up the L2 segment on `leaf1` 

Click **Topology** → `leaf1`. New terminal tab.

### Look at what's there

```sh
show vxlan tunnel
show vxlan vlanvnimap
ip -br link show | grep -E 'Vlan|vxlan|vtep'
```

Expected: `show vxlan tunnel` says "no entries" or returns empty headers — no VXLAN tunnels configured yet. `ip -br link show | grep -E 'Vlan|vxlan|vtep'
` shows no `Vlan*` or `vtep*` devices. **The overlay is purely additive** — you're going to create new objects, leave the existing underlay alone.

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

**Read the arguments carefully — this is where the wiring happens, and it's easy to miss:**

```
config vxlan evpn_nvo add  nvo1   vtep
                    │       │      └── the VTEP to attach to — the *name* of the tunnel
                    │       │          you created in step 3, NOT the generic word "vtep"
                    │       └───────── the NVO object's name (arbitrary; "nvo1" by convention)
                    └───────────────── create an EVPN-NVO binding
```

Here's the subtlety: back in step 3 you ran `config vxlan add **vtep** 10.0.10.1`. That first argument — `vtep` — wasn't the keyword "VTEP", it was the **name** you gave this leaf's VXLAN tunnel object. (SONiC lets you call it anything; this lab names it `vtep` on every leaf for consistency, which is why the word appears to repeat.) So when you now type `... add nvo1 vtep`, that trailing `vtep` is a **reference back to that named tunnel** — it's the literal string that connects `nvo1` to the endpoint you built one step ago.

In other words: step 3 created a tunnel *named* `vtep`; step 4 creates an NVO *named* `nvo1` and points it at the tunnel named `vtep`. Same object, referenced by name. If you'd named the tunnel `myvtep` in step 3, this command would read `config vxlan evpn_nvo add nvo1 myvtep`.

`evpn_nvo` is the flag that says "generate BGP L2VPN-EVPN routes for whatever rides this tunnel." Without it the tunnel exists but BGP never advertises it. (The kernel device only takes its display name `vtep-1000` once you add the VLAN↔VNI map in step 5 — `vtep` is the SONiC object name, `vtep-1000` is the resulting Linux netdev.)

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

That's the whole data-plane setup — five commands. The map is the keystone: This is what turns "a VLAN" and "a tunnel" into "this L2 segment travels the fabric as VNI 10100."

> 💡 **What just happened under the hood**: each `config` command wrote an entry to SONiC's `config_db.json`. `swssconfig` picked the entries up and programmed the kernel: a Linux bridge named `Bridge`, a VLAN sub-interface `Vlan1000@Bridge`, and a VXLAN device `vtep-1000`. You can see the kernel objects with `ip -br link show`, and the SONiC view with `show vxlan tunnel`.

> 💡 **Why a VLAN, not just a VXLAN device?** SONiC's data model says: a VLAN is the L2 segment, a VXLAN tunnel is the encap endpoint, and a `map` entry connects "VLAN 1000 here ↔ VNI 10100 over the wire." This factoring lets one VXLAN tunnel carry many VLANs (with one map entry each). 

> 💡 **Why `config interface ip add Vlan1000 192.168.100.1/24`?** That's the per-leaf "I'm participating in this segment at this IP" announcement. For our verification ping (leaf-to-leaf), this is the IP we'll send from. In Lab 3, real workers will get IPs in this same 192.168.100.0/24 subnet and reach the leaf as their first hop.

> 💡 **What's an EVPN NVO?** "Network Virtualization Overlay" — the binding object that says "this VXLAN tunnel is part of the EVPN signaling plane, so generate Type-2/Type-3 routes for any VNI mapped to it." Without `evpn_nvo`, the tunnel exists but FRR's EVPN AF wouldn't know to advertise anything for it.

### Verify

```sh
show vxlan tunnel
show vxlan vlanvnimap
ip -br link show Vlan1000 
ip -br link show vtep-1000
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

> 💡 **Why `vtysh` here instead of `config bgp`?** Modern SONiC's `config bgp` CLI is intentionally minimal — only `device-global`, `remove`, `shutdown`, `startup`. The full neighbor / address-family lifecycle isn't surfaced through it; production SONiC operators drive BGP through the `BGP_GLOBALS*` config_db tables (or YANG/mgmtd in newer builds), and `vtysh` for interactive work. 

> 💡 **What does `advertise-all-vni` actually do?** It tells FRR: "scan the kernel for VXLAN devices, and for every VNI you find, originate Type-3 (inclusive multicast) routes immediately, and Type-2 (MAC) routes for any MAC that lands in the bridge fdb." This is why you set up the kernel devs *first* — `advertise-all-vni` is a **discovery** mechanism, not a creation one.

Repeat the same `vtysh` block on `leaf2`, `leaf3`, `leaf4` — changing the `router bgp <ASN>` line to the leaf's own ASN (65102, 65103, 65104).

Quick sanity check on leaf1:

```
show evpn vni
```

Expected — a single summary row for your VNI:

```
VNI        Type VxLAN IF              # MACs   # ARPs   # Remote VTEPs  Tenant VRF
10100      L2   vtep-1000             0        0        0               default
```

Read the row left to right — every column is a checkpoint that one earlier step worked:

- **`VNI 10100`** — the VNI you created in step 5's `config vxlan map add vtep 1000 10100`. If this line is missing entirely, FRR never discovered a VXLAN device → `advertise-all-vni` had nothing to scan, which usually means the map command didn't land.
- **`Type L2`** — a layer-2 VNI (a bridged segment), as opposed to an `L3` VNI used for symmetric IRB routing. Ours is pure L2 — one flat wire across the leaves — so `L2` is exactly right.
- **`VxLAN IF: vtep-1000`** — **this is the load-bearing column.** It's the proof that FRR reached into the kernel, found the SONiC-programmed `vtep-1000` netdev, and bound its EVPN instance to it. The whole reason you built the kernel devices *before* turning on the EVPN address family is so this discovery succeeds. If this said `<none>` or the row was absent, EVPN would have nothing to advertise.
- **`# MACs 0`** — **and it stays 0 for this entire lab — that's expected, not a bug.** A VNI's MAC count is the number of *host* MACs on the segment, and right now nothing is plugged into VLAN 1000 except the leaf's own SVI. FRR does **not** advertise the SVI's gateway MAC by default (you can confirm with `show evpn vni 10100`: `Advertise-svi-macip: No`), so it contributes no MAC. With zero host MACs, FRR has nothing to originate a **Type-2 (MAC) route** for — so in Lab 2 you'll only ever see **Type-3 (inclusive-multicast)** routes. Type-2 routes are a **Lab 3** phenomenon: when the GPU workers attach real NICs to this segment, their MACs land in the bridge fdb and *then* the count climbs and Type-2 routes flow.
- **`# Remote VTEPs 0`** — **expected to be 0 right now, and that's not a bug either.** You've only configured the *leaves*; the spines aren't transiting L2VPN-EVPN routes yet (that's the very next step). With no path for the other leaves' Type-3 routes to reach leaf1, leaf1 knows of zero remote VTEPs. After you activate the spines in Step 4 and the overlay converges, this column becomes **3** (leaf2/leaf3/leaf4) — and the [later verify](#step-6-verify-the-data-plane) re-runs `show evpn vni 10100` to confirm it.

So at this stage a healthy leaf shows: the VNI present, bound to `vtep-1000`, zero MACs, zero remote VTEPs. That's "the leaf is ready to advertise" — the fabric-wide convergence comes after the spines are in.

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

> 💡 **The shared-AS-spine EVPN next-hop concern — and how FRR handles **:
>
> In a shared-AS-spine CLOS, when a spine relays an EVPN route from leaf1 to leaf3, standard eBGP behavior says "rewrite the next-hop to me before forwarding." In this lab the route in question is the **Type-3 (inclusive-multicast)** route — but the concern is identical for the Type-2 MAC routes you'll meet in Lab 3, since both carry the originating leaf's VTEP as their next-hop.
>
> 1. leaf1 originates a Type-3 route for its VTEP `10.0.10.1`. The route's next-hop = `10.0.10.1`.
> 2. spine1 receives it. If it applies the default next-hop-self rewrite, the next-hop becomes `10.0.0.1` (spine1's router-id).
> 3. spine1 advertises to leaf3 with next-hop `10.0.0.1`. leaf3 adds `10.0.0.1` to its head-end-replication flood list: "BUM-flood to a VTEP at `10.0.0.1`."
> 4. **`10.0.0.1` is not a VTEP** — it's spine1's router-id loopback. spine1 has no VXLAN device, no UDP 4789 listener.
> 5. Flooded frames arrive at spine1 and are dropped silently. The overlay fails even though the routes look right.
>
> **In FRR, that rewrite does not fire** for L2VPN-EVPN routes on eBGP peers — FRR preserves the original VTEP next-hop by default on this image (FRR 10.4.1): `vtysh -c "show bgp l2vpn evpn"` on leaf3 shows next-hops like `10.0.10.1(spine1)` (= leaf1's VTEP, learned via spine1), not `10.0.0.1`. 
>
> **Should you still add an explicit knob?** In production templates, you should add an explicit knob to not change the next hop for. The relevant commands depending on FRR version:
> - **FRR 8.x+** (and possibly future FRR): `neighbor LEAVES next-hop-unchanged`
> - **FRR 7.x**: `neighbor LEAVES attribute-unchanged next-hop`
> - **In *this* sonic-vs build (FRR 10.4.1)**, There's no working spine-side knob in this image; the FRR default is the only mechanism. We leave the spine config as just `activate`

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
spine1(10.1.1.0)  4   65000   ...  3
spine2(10.1.2.0)  4   65000   ...  3
```

(Exact PfxRcd varies — typically ~3 here, one Type-3 route per *other* leaf, relayed by each spine; it climbs in Lab 3 once Type-2 MAC routes join. The important bit is it's an int, not `Active` or `Idle`.)

Then look at the actual routes:

```
show bgp l2vpn evpn
```

Expected: a multi-RD listing of **Type-3 (inclusive-multicast) routes** — one per VTEP, including one from each other leaf (`10.0.10.2`, `10.0.10.3`, `10.0.10.4`) plus your own (`10.0.10.1`). Each remote one is learned via **both** spines (you'll see two paths, `*>` best and `*=` equal):

```
Route Distinguisher: 10.0.1.2:2
 *>  [3]:[0]:[32]:[10.0.10.2]
                    10.0.10.2(spine1)                            0 65000 65102 i
 *=  [3]:[0]:[32]:[10.0.10.2]
                    10.0.10.2(spine2)                            0 65000 65102 i
```

The prefix `[3]:[0]:[32]:[10.0.10.2]` reads as `<RouteType>:<EthTag>:<IP-len>:<originating-VTEP-IP>` — leaf2 announcing "I'm a VTEP for this VNI; head-end-replicate BUM traffic to me at 10.0.10.2." That's what builds the flood list you'll see in the data plane.

> **Heads-up — you will NOT see any Type-2 (MAC) routes in this lab, and that's correct.** Type-2 routes carry *host* MAC (and MAC/IP) bindings, and there are no hosts on this segment yet — just the four leaf SVIs, whose gateway MACs FRR doesn't advertise by default (`show evpn vni 10100` → `Advertise-svi-macip: No`). With nothing to bind, FRR originates only Type-3. **Type-2 routes arrive in Lab 3**, when the GPU workers attach real NICs and their MACs land in the bridge fdb. So your leaf-to-leaf ping in this lab rides pure **BUM flooding** over the Type-3 flood list — not MAC-route forwarding.

<checkpoint name="evpn_routes_learned" label="Leaf1 learned each leaf's EVPN (Type-3) route" />

> 💡 **Walking the route format, and why Type-3 is enough here**: `[3]:[0]:[32]:[10.0.10.2]` is an *Inclusive Multicast Ethernet Tag* route — EVPN's "I am a VTEP for this VNI" announcement. Every leaf originates exactly one per VNI; together they tell each leaf the full set of remote VTEPs to head-end-replicate broadcast/unknown-unicast/multicast (BUM) traffic to. That single mechanism is enough to make ARP — and therefore a first ping — work across the fabric, with **zero** Type-2 routes. When you reach Lab 3, watch this same `show bgp l2vpn evpn` output sprout `[2]:...:[48]:[mac]` Type-2 entries as the workers come up — at hyperscale (thousands of MACs × thousands of leaves) those become the dominant route population, and production fabrics tune RT filtering to cut the per-leaf import set.

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
10.0.10.1   10.0.10.2  EVPN               oper_down
10.0.10.1   10.0.10.3  EVPN               oper_down
10.0.10.1   10.0.10.4  EVPN               oper_down
```

> ⚠️ **`oper_down` here is expected on this virtual fabric — it does *not* mean the overlay is broken.** The column you care about is **`Creation Source: EVPN`** (the tunnels were learned via BGP, exactly as intended) and the fact that all three remote VTEPs are listed at all. `OperStatus` is set by SONiC's tunnel monitor, which tracks the *simulated ASIC* dataplane — and in the `sonic-vs` image that monitor never goes "up." But the traffic in this lab is forwarded by the **Linux-kernel** VXLAN device `vtep-1000`, which is fully operational. The authoritative proof the overlay works is Option B below (FRR's view), the kernel flood list (`bridge fdb show dev vtep-1000` — one `00:00:00:00:00:00 → <remote VTEP>` entry per leaf), and the ping in Step 7. On real hardware this column reads `oper_up`; on the emulator, trust the kernel and the ping, not `OperStatus`.

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
 Number of MACs (local and remote) known for this VNI: 0
 Number of ARPs (IPv4 and IPv6, local and remote) known for this VNI: 3
 Advertise-gw-macip: No
 Advertise-svi-macip: No
```

The three `flood: HER` lines are the **head-end-replication targets** populated from the Type-3 inclusive-multicast routes EVPN exchanged — they tell the kernel "when you need to BUM-flood in VXLAN 10100, send one copy to each of these VTEPs." This is the FRR view of the same three VTEPs Option A showed — and unlike `show vxlan remotevtep`'s `OperStatus`, it reflects the working control + kernel data plane, which is why it's the view to trust on this emulator.

Note **`Number of MACs ... : 0`** — no Type-2 MAC routes exist in this lab (no host MACs on the segment yet; `Advertise-svi-macip: No` means the SVI MAC isn't advertised). The `# ARPs: 3` are just leaf1's local neighbor-cache entries for the other SVIs, learned during the ping — not advertised routes. Both counts grow in Lab 3 when real workers join.

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
> 5. The ARP reply comes back encap'd from `leaf3`'s VTEP to `leaf1`'s VTEP (leaf3 floods it the same way — it has no MAC route for leaf1 either). `leaf1` decap's and populates its **ARP/neighbor cache** (`192.168.100.3` → leaf3's SVI MAC). Note what it does **not** do: the VXLAN device is created `nolearning` and there's no Type-2 MAC route, so leaf1 installs **no MAC→VTEP fdb entry** for leaf3.
> 6. So every subsequent ICMP packet is **also** BUM-flooded to all three remote VTEPs — only `leaf3` keeps it, `leaf2`/`leaf4` drop it. Wasteful, but perfectly correct at this scale (4 leaves, one host each). **This is exactly the inefficiency Type-2 MAC routes fix** — in Lab 3 the GPU workers' MACs get advertised as Type-2, which installs precise unicast MAC→VTEP fdb entries so each frame is delivered to *one* VTEP instead of flooded to all. Watch the fdb change there with `bridge fdb show dev vtep-1000`.
>
> **One ping = one full control-plane (Type-3 flood-list) + data-plane (BUM flood) cycle. The overlay is live — flooding now, unicast-precise once Lab 3 adds Type-2.**

---

## End-to-end verification

The final check is a leaf-to-leaf ping mesh — every leaf pings every other leaf over the overlay (12 pings: 4 sources × 3 destinations). Click **Submit ✓** in the top bar. The orchestrator will:

1. Re-run every step-level checkpoint.
2. Run the 12-pair leaf-to-leaf overlay ping mesh.
3. Show you a per-check pass/fail card below this guide.

If everything passes, the lab stamps as **Passed**, the completion screen appears, and the CTA for Lab 3 ("Bring GPUs onto the overlay + first AllReduce") lights up.

If something fails, the four common gotchas, in priority order:

1. Mistyped the spine's next-hop knob (e.g. wrote `next-hop-unchanged`, which is rejected by this image's FRR 10.4.1, or `attribute-unchanged next-hop`, which is silently accepted but not persisted into running-config) — overlay still works thanks to FRR's default-preserves behavior, but the line you typed won't show in `vtysh -c "show running-config"`
2. Forgot `advertise-all-vni` on a leaf → no Type-3 route from that leaf, so it's left off every other leaf's flood list and is cut out of the overlay
3. Forgot `config vxlan evpn_nvo add` on a leaf → tunnel exists but EVPN doesn't see it
4. Mismatched VNI or VLAN across leaves → tunnels build but frames are dropped at decap

---

## Stuck? Want to restart?

| You want to… | Click |
|---|---|
| Wipe overlay state + restore healthy underlay | **Reset** in the top bar |
| Run all checks now | **Submit ✓** in the top bar |


---
