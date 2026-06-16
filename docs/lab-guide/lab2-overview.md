# Lab Guide 2 — Build an EVPN-VXLAN overlay on top of your underlay

In [Lab 1](00-overview.md) you built an L3 underlay — a CLOS that routes every packet hop-by-hop with eBGP. That underlay is enough for any L3 traffic; it's how the worker `/31`s reach each other today.

But real AI fabrics don't put GPUs on per-leaf `/31` links. They put **every GPU in one flat L2 segment**, even though the GPUs are spread across many leaves. That way NCCL/Gloo collectives operate the way they're designed to — broadcast and multicast within a single subnet, no L3 hops mid-AllReduce, no per-host routing config to maintain. This is the "rail-optimized" pattern in every hyperscale AI fabric design ([ADR-005](../../notes/decisions.md)).

To deliver that single-segment illusion on top of an L3 fabric, you need an **overlay**: a virtual L2 network tunneled over the L3 underlay. The standard AI/cloud-DC choice is **EVPN-VXLAN** — BGP signals which MAC is at which VTEP (control plane), and VXLAN encapsulates the L2 frame in a UDP packet that the underlay routes (data plane).

That's what you'll build, **using SONiC's native CLI** the way you would on a real production switch.

By the end of this lab, every leaf will share one stretched L2 segment (VLAN 1000 / VNI 10100 / subnet 192.168.100.0/24) with every other leaf, you'll see Type-2 MAC routes flowing through your spines, and a ping from leaf1 to leaf3 will ride a real VXLAN tunnel through the underlay you just built.

> **Note**: Lab 2 is leaf-only. You'll set up the overlay on the four leaves and verify it with leaf-to-leaf ping. Bringing `gpu1`..`gpu8` onto the overlay segment (and running an actual AllReduce across it) is Lab 3.

---

## The SONiC overlay model: three primitives

SONiC organizes the EVPN-VXLAN overlay around three primitives. The CLI maps 1:1 onto them:

| Primitive | What it is | SONiC CLI |
|---|---|---|
| **VLAN** | The L2 segment surface — the "broadcast domain" learners and tenants attach to | `config vlan add <vlan_id>` |
| **VXLAN tunnel** | The encap/decap endpoint, sourced from a VTEP loopback | `config vxlan add <name> <src_ip>` |
| **EVPN NVO** | The "Network Virtualization Overlay" object that binds EVPN signaling to the tunnel | `config vxlan evpn_nvo add <nvo_name> <vxlan_name>` |
| (the binding) | A map entry connecting a VLAN to a VNI on a tunnel | `config vxlan map add <vxlan_name> <vlan_id> <vni>` |

Five commands per leaf. That's the whole data-plane setup. The BGP L2VPN-EVPN address family in vtysh handles the control plane.

---

## What you'll learn

Concepts, not CLI flags:

- **Overlay vs underlay** — what each one does, where they meet, and why "overlay rides underlay" is the right mental model
- **VTEP** — the VXLAN tunnel endpoint, why it's a loopback (not a fabric link), and how the existing `10.0.10.X/32` addresses you saw in Lab 1 become load-bearing now
- **VLAN ↔ VNI mapping** — SONiC's data model for "this L2 segment is VLAN 1000 locally and VNI 10100 over the wire"
- **EVPN NVO** — why this extra binding object exists (it's how SONiC knows which VTEP a VNI should ride)
- **BGP L2VPN-EVPN address family** — the same BGP you already speak, with two new route types: Type-2 (MAC) and Type-3 (inclusive multicast)
- **`advertise-all-vni`** — how FRR auto-discovers SONiC's VXLAN devices and originates routes for them
- **The textbook shared-AS-spine EVPN gotcha** — and the empirical reality that FRR (both 7.5.1 and 10.4.1 in this lab's images) preserves L2VPN-EVPN next-hops on eBGP peers by default (no spine-side knob is needed or even works in this build; on a future FRR where the default changes you'd add `neighbor LEAVES next-hop-unchanged` or `attribute-unchanged next-hop` as defense-in-depth). ADR-002 captures the finding.
- **What `config` writes to vs what `vtysh` configures** — the two CLI surfaces, where they overlap, and where they don't

> 💡 **About the two CLIs**: this lab uses **both** SONiC's `config` (and `show`) CLI **and** FRR's `vtysh`. Why? Modern SONiC's `config bgp` is intentionally minimal (only `device-global`/`remove`/`shutdown`/`startup` — no `add neighbor`), so production SONiC drives BGP via `BGP_GLOBALS*` config_db tables or YANG/mgmtd. For interactive Lab 1 work we use `vtysh` (the direct surface). VXLAN tables are fully wired in modern SONiC, so Lab 2 uses `config vxlan` natively. See ADR-008 + ADR-011 for the history.

---

## Teaching philosophy

Lab 1 was "build the routing protocol." Lab 2 is "build the **service**" — the overlay is a thing you can sell to a tenant: a flat segment they think of as one wire, that's actually stitched out of many physical links.

For each step you'll:

1. **Set up the data plane** — `config vlan add`, `config vxlan add`, `config vxlan evpn_nvo add`, `config vxlan map add` on a leaf. Verify with `show vxlan tunnel`, `show vxlan vlanvnimap`.
2. **Activate the control plane** — drop into `vtysh`, add `address-family l2vpn evpn` + `neighbor … activate`. Leaves also add `advertise-all-vni`. Spines just need `activate` — FRR preserves EVPN next-hops by default; see Step 4 of the exercise for the deeper note.
3. **Verify the control plane is working** — `show bgp l2vpn evpn summary` (sessions Established), `show bgp l2vpn evpn` (routes arrived), `show evpn vni` (FRR sees the kernel VXLAN dev).
4. **Verify the data plane** — `show vxlan remotevtep` (SONiC view: 3 rows with `Creation Source: EVPN`) or equivalently `vtysh -c "show evpn vni 10100"` (FRR view: "Remote VTEPs for this VNI" lists the other leaves). Both work in the current `aidc/sonic-vs:202511` image.
5. **Send a packet** — `ping -I Vlan1000 192.168.100.<other_leaf>`. **First overlay packet.**

Each step has a **💡 Why this matters in AI DCs** callout connecting the config to AllReduce traffic, ARP scaling, anycast gateways, multi-tenancy.

---

## Prerequisites

- **Lab 1 is complete** (or at least understood). The overlay rides on the underlay you built there. If the underlay isn't healthy, the overlay can't work — that's literally the whole point.
- When you click **Start lab ▶** for Lab 2, the orchestrator applies the **canonical underlay config** (the same config you'd get from clicking Solve in Lab 1) so you always start from a known-good L3 fabric, even if your last Lab 1 session left things half-built.
- Open [`../topology.md`](../topology.md) §3 in another tab. You'll want the **leaf VTEP loopback** column (`10.0.10.1`..`10.0.10.4`) handy — those are already advertised by your underlay; the overlay binds VXLAN tunnels to them.

---

## The overlay addressing scheme

| Thing | Value | Notes |
|---|---|---|
| L2 segment | **VLAN 1000** | SONiC's "broadcast domain" object |
| L2VNI | **10100** | The VXLAN Network Identifier; binds to VLAN 1000 |
| Overlay subnet | **192.168.100.0/24** | Reserved per [ADR-005](../../notes/decisions.md) |
| Leaf VTEP IPs | `10.0.10.1`..`10.0.10.4` | Already on each leaf's `lo:Loopback1`, advertised via BGP IPv4 unicast |
| Per-leaf test IPs | `192.168.100.1`..`192.168.100.4` | One per leaf on `Vlan1000` — used to ping leaf-to-leaf and prove the overlay works |
| VXLAN tunnel name | `vtep` | SONiC tunnel object name |
| EVPN NVO name | `nvo1` | SONiC NVO object name |
| Kernel devices SONiC creates | `Vlan1000@Bridge`, `vtep-1000` | Auto-named; you won't manage these directly |

`192.168.100.X` where `X = leaf_id` makes it trivial to know who you're pinging: `192.168.100.3` is always leaf3, no matter which leaf you're sitting on.

---

## The workflow loop

For each leaf:

1. Open the leaf's console from the **Topology** button.
2. Run the five SONiC CLI commands (`config vlan add`, `config interface ip add`, `config vxlan add`, `config vxlan evpn_nvo add`, `config vxlan map add`). Verify with `show vxlan tunnel`.
3. Drop into `vtysh`, add the L2VPN-EVPN address family block, `neighbor SPINES activate`, `advertise-all-vni`.

Then for each spine:

4. Open the spine console.
5. Drop into `vtysh`, add the L2VPN-EVPN AF block with just `neighbor LEAVES activate` — FRR preserves EVPN next-hops on eBGP by default; no other spine knob is needed in this image.

Then verify:

6. On leaf1: `show bgp l2vpn evpn summary` (both spines Established), `show bgp l2vpn evpn` (Type-2 routes from leaf2/3/4 visible), `vtysh -c "show evpn vni 10100"` (FRR's "Remote VTEPs for this VNI" lists the other VTEPs with `flood: HER`).
7. **First overlay packet**: `ping -I Vlan1000 192.168.100.3` from leaf1. Success.
8. Inline **Check ▸** after each verification step; **Submit ✓** when done.

---

## Persistence note

Same caveats as Lab 1. Your `config` and `vtysh` edits go to the running daemons + the SONiC config_db. **Neither is written back to disk** (the SONiC `config save` step is not run by the lab). If a switch container restarts, your work is lost — but the orchestrator never restarts switch containers, so you can walk away.

For controlled state changes:

- **Reset** — re-applies the canonical underlay config (back to Lab-1-Solve state) and tears down any overlay VLANs/VXLANs you created. Use when you've made a mess and want to start fresh.
- **Solve** — applies the full Lab-2 answer: canonical overlay configs + `overlay-setup.sh` on every leaf. Your run is flagged "solved" on the completion screen.

---

## Where to go

- **[`lab2-exercise.md`](lab2-exercise.md)** — the guided walkthrough. Start here.
- **[`lab2-solution.md`](lab2-solution.md)** — pure copy-pasteable answer key + a common-mistakes troubleshooter.

Reference material to keep open in another tab:

- **[`../topology.md`](../topology.md)** — full IP / link reference. Section 3 has the VTEP loopbacks.
- **[`../switch-cli-reference.md`](../switch-cli-reference.md)** — SONiC `config`/`show` + vtysh CLI cheat sheet.
- **[`../../notes/decisions.md`](../../notes/decisions.md)** — ADR-002 (shared-spine-AS EVPN gotcha) and ADR-005 (why one stretched L2 segment) explain *why* the lab is shaped this way; ADR-008 explains why Lab 1 used vtysh and Lab 2 uses `config vxlan`.
