# Lab Guide 5 — Build an SRv6 uSID transport across your fabric

In Labs 1–4 you built an IPv4 CLOS underlay, stretched an EVPN-VXLAN overlay across it, put GPUs on that overlay, and watched real AllReduce traffic light up a telemetry dashboard. Everything so far rides **one** transport: VXLAN-over-IPv4-UDP.

This lab introduces a **second, modern transport — SRv6 (Segment Routing over IPv6)** — and lays it down **additively, alongside** what you already have. Your IPv4 underlay and your EVPN-VXLAN overlay keep running untouched. On top of them you'll dual-stack the fabric with IPv6, define **micro-SID (uSID)** locators, and build an SRv6 transport that carries leaf-to-leaf traffic and — the payoff — **load-spreads per-flow across both spines using the IPv6 flow label**, exactly the way VXLAN did in Lab 4, but with a completely different encapsulation.

By the end, a packet from a host behind `leaf1` to a host behind `leaf3` will be wrapped in an SRv6 uSID, ECMP'd across spine1 **and** spine2 on a per-flow basis, decapsulated by `leaf3`, and delivered — and you'll watch the spread fill in on the same Grafana dashboard from Lab 4.

> **Note**: this lab is **leaf-and-spine, additive**. The IPv6 underlay (links + BGP + locator reachability) is **pre-provisioned** for you when you Start — the same way Lab 1 pre-provisioned interface IPs so you could focus on BGP. Your job is the **SRv6 layer**: locators, endpoints, and headend steering. The IPv4 underlay, the VXLAN overlay, and the GPU workers on `192.168.100.0/24` are all still there and still working the whole time.

---

## SRv6 in one minute

Classic Segment Routing puts an ordered list of "segments" (instructions) into the packet header and lets each hop pop the next one. **SRv6** encodes those segments as **IPv6 addresses** — so the segment list is just an IPv6 routing header (SRH), and *every* router in between is a plain IPv6 router that forwards on the outer destination address. No new data plane, no LDP, no MPLS label distribution. The fabric you already have forwards SRv6 the moment you turn on IPv6.

**uSID (micro-SID)** is the compressed flavor. Instead of a full 128-bit IPv6 address per segment, a uSID is a short (here, 16-bit) "micro-instruction" packed into a **uSID container** — a single IPv6 address that can hold a *sequence* of them. For a one-hop path like ours, the whole instruction rides in the outer IPv6 **destination address** with **no SRH at all** (this is *H.Encaps.Red* — "reduced"). That's why SRv6 uSID has tiny header overhead and is what hyperscalers actually deploy.

Three roles, three places in the fabric:

| Role | SRv6 term | Who does it here | What it does |
|---|---|---|---|
| **Headend** | H.Encaps.Red | the ingress leaf | wraps a flow into a uSID (sets the outer IPv6 DA = the remote leaf's uSID) |
| **Transit** | plain IPv6 forwarding | the spines | route the outer IPv6 DA toward the egress leaf — **ECMP on the flow label** |
| **Endpoint** | `End.DT6` (uN/uDT6) | the egress leaf | matches its own uSID, **decapsulates**, delivers the inner packet |

---

## The addressing scheme (pre-provisioned for you)

You don't have to invent any of this — it's laid down for you at Start. Keep it handy:

| Element | Value | Notes |
|---|---|---|
| IPv6 link `/127` | `fc00:<spine>:<leaf>::/127` | spine side `::0`, leaf side `::1`. e.g. spine1↔leaf3 = `fc00:1:3::/127` |
| uSID **locator** | `fcbb:bb00:<leaf>::/48` | block-len 32 + node-len 16. e.g. leaf3 = `fcbb:bb00:3::/48` |
| **End.DT6** endpoint SID | `fcbb:bb00:<leaf>:fe00::` | the address this leaf decapsulates on |
| **Service** prefix | `fd00:100:<leaf>::/64` | "the hosts behind this leaf"; `fd00:100:<leaf>::1` is a concrete host you can ping |

`fcbb:bb00::/32` is the conventional SRv6 uSID block (the same shape Cisco/Arista docs use). Every leaf's `/48` locator is advertised into IPv6 BGP with `maximum-paths 64`, so each leaf learns every other leaf's locator via **both** spines — that two-way ECMP is what makes per-flow load-spreading possible.

---

## What you'll learn

Concepts, not CLI flags:

- **SRv6 vs MPLS-SR vs VXLAN** — why encoding segments as IPv6 addresses means the underlay needs *no* new data plane, and how that compares to the VXLAN overlay you built
- **uSID / micro-segments** — the compressed SID format, and what `block-len 32 node-len 16` actually carves up in a 128-bit address
- **Locator → endpoint → headend** — the three pieces, which live in FRR (control plane) and which live in the Linux kernel (data plane)
- **`End.DT6`** — "decapsulate and do an IPv6 table lookup," the endpoint behavior that terminates a uSID path
- **H.Encaps.Red** — reduced encapsulation: a single uSID in the outer DA, no SRH, minimal overhead
- **Per-flow ECMP via the IPv6 flow label** — how Linux derives the outer flow label from the inner flow so distinct flows hash to different spines (the SRv6 twin of Lab 4's VXLAN UDP-source-port trick)
- **The one gotcha that will bite you** — why an SRv6 endpoint **must** bind to a real device and silently does nothing on `lo`

> 💡 **Why two CLIs again?** Like Lab 2, you'll use **both** surfaces. The SRv6 **locator** is a control-plane object, so it lives in **`vtysh`** (FRR). The **endpoint** and **headend** are kernel data-plane state, so they're plain **`ip -6 route`** commands in the shell — the same division of labor Lab 2/3 used (`vtysh` for BGP, `config`/`ip` for the VXLAN kernel devices). FRR 10.4 takes the locator config but doesn't program the kernel endpoint itself, so you do that hop directly.

---

## Teaching philosophy

Lab 2 built a *service* (an overlay you could sell a tenant). Lab 5 builds an **alternative transport for that service** — and does it without tearing anything down. The whole lab is a lesson in *additive evolution*: real fabrics don't get rebuilt, they get dual-stacked and migrated one capability at a time. You'll feel that directly — VXLAN keeps pinging the entire time you stand SRv6 up next to it.

For each step you'll:

1. **Define the control plane** — the uSID locator in `vtysh` (`show segment-routing srv6 locator` confirms it).
2. **Program the data plane** — the `End.DT6` endpoint and the H.Encaps headend with `ip -6 route` (verify with `ip -6 route show` and the seg6local packet counter).
3. **Send a packet** — a ping that rides a uSID from leaf to leaf, decapsulated at the far end.
4. **Watch it spread** — drive several flows and see them split across both spines on the embedded Grafana dashboard.

Each step has a **💡 Why this matters in AI DCs** callout connecting the mechanic to real fabrics — traffic engineering, multi-tenancy, the end-to-end-vs-fabric encapsulation debate, and why per-flow entropy is non-negotiable for collective performance.

---

## Prerequisites

- **Labs 1–4 understood**, and ideally Lab 4 was the last lab you solved (so the workers are on the overlay). When you click **Start lab ▶** for Lab 5, the orchestrator applies `_srv6_skeleton`: your full IPv4 + EVPN-VXLAN fabric **plus** the pre-provisioned IPv6 dual-stack underlay. If anything looks sick, click **Start ▶** again to re-apply it.
- Keep the **addressing table** above open in another tab. You'll reference the locator and service prefixes constantly.
- The embedded **Telemetry** tab (the Lab 4 Grafana dashboard) is back — you'll use it in the final step to watch the ECMP spread.

---

## Where to go next

- **[`lab5-exercise.md`](lab5-exercise.md)** — the guided, command-by-command walkthrough. Start here.
- **[`lab5-solution.md`](lab5-solution.md)** — the copy-pasteable answer key, a vtysh/`ip` ↔ config mapping, and a common-mistakes table (including *the* `dev lo` trap).
