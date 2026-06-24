# Solution — SRv6 uSID transport

The complete, copy-pasteable build for all four leaves, plus a behavior reference and the failure modes most likely to bite you. This is exactly what clicking **Solve ✓** lays down (it applies the `_srv6` state).

> Everything below is **additive**. None of it touches the IPv4 underlay or the EVPN-VXLAN overlay — those run unchanged the whole time. The IPv6 underlay (`fc00:<spine>:<leaf>::/127` links, IPv6 BGP, the `fcbb:bb00:<leaf>::/48` locator advertisements, and the seg6 sysctls) is pre-provisioned by **Start**; what follows is only the SRv6 layer you build on top.

---

## Per-leaf build

For each `leafN`, the build is three parts: the **locator** (vtysh), the **endpoint** (kernel), and the **headend** (kernel). The only things that change between leaves are the digit `N` in the locator/endpoint and which service prefixes the headend steers.

### leaf1 (locator `fcbb:bb00:1::/48`)

```sh
# --- control plane: the uSID locator (vtysh) ---
vtysh -c "conf t" \
  -c "segment-routing" -c "srv6" -c "locators" \
  -c "locator MAIN" \
  -c "prefix fcbb:bb00:1::/48 block-len 32 node-len 16" \
  -c "behavior usid" -c "end"

# --- data plane: the End.DT6 endpoint (kernel, on a REAL device) ---
ip link add srv6end type dummy 2>/dev/null || true
ip link set srv6end up
sysctl -w net.ipv6.conf.srv6end.seg6_enabled=1
ip -6 route replace fcbb:bb00:1:fe00:: encap seg6local action End.DT6 table 255 dev srv6end

# --- data plane: the H.Encaps.Red headend, steering the other leaves' services ---
ip -6 route replace fd00:100:2::/64 encap seg6 mode encap.red segs fcbb:bb00:2:fe00:: dev eth1
ip -6 route replace fd00:100:3::/64 encap seg6 mode encap.red segs fcbb:bb00:3:fe00:: dev eth1
ip -6 route replace fd00:100:4::/64 encap seg6 mode encap.red segs fcbb:bb00:4:fe00:: dev eth1
```

### leaf2 (locator `fcbb:bb00:2::/48`)

```sh
vtysh -c "conf t" \
  -c "segment-routing" -c "srv6" -c "locators" \
  -c "locator MAIN" \
  -c "prefix fcbb:bb00:2::/48 block-len 32 node-len 16" \
  -c "behavior usid" -c "end"

ip link add srv6end type dummy 2>/dev/null || true
ip link set srv6end up
sysctl -w net.ipv6.conf.srv6end.seg6_enabled=1
ip -6 route replace fcbb:bb00:2:fe00:: encap seg6local action End.DT6 table 255 dev srv6end

ip -6 route replace fd00:100:1::/64 encap seg6 mode encap.red segs fcbb:bb00:1:fe00:: dev eth1
ip -6 route replace fd00:100:3::/64 encap seg6 mode encap.red segs fcbb:bb00:3:fe00:: dev eth1
ip -6 route replace fd00:100:4::/64 encap seg6 mode encap.red segs fcbb:bb00:4:fe00:: dev eth1
```

### leaf3 (locator `fcbb:bb00:3::/48`)

```sh
vtysh -c "conf t" \
  -c "segment-routing" -c "srv6" -c "locators" \
  -c "locator MAIN" \
  -c "prefix fcbb:bb00:3::/48 block-len 32 node-len 16" \
  -c "behavior usid" -c "end"

ip link add srv6end type dummy 2>/dev/null || true
ip link set srv6end up
sysctl -w net.ipv6.conf.srv6end.seg6_enabled=1
ip -6 route replace fcbb:bb00:3:fe00:: encap seg6local action End.DT6 table 255 dev srv6end

ip -6 route replace fd00:100:1::/64 encap seg6 mode encap.red segs fcbb:bb00:1:fe00:: dev eth1
ip -6 route replace fd00:100:2::/64 encap seg6 mode encap.red segs fcbb:bb00:2:fe00:: dev eth1
ip -6 route replace fd00:100:4::/64 encap seg6 mode encap.red segs fcbb:bb00:4:fe00:: dev eth1
```

### leaf4 (locator `fcbb:bb00:4::/48`)

```sh
vtysh -c "conf t" \
  -c "segment-routing" -c "srv6" -c "locators" \
  -c "locator MAIN" \
  -c "prefix fcbb:bb00:4::/48 block-len 32 node-len 16" \
  -c "behavior usid" -c "end"

ip link add srv6end type dummy 2>/dev/null || true
ip link set srv6end up
sysctl -w net.ipv6.conf.srv6end.seg6_enabled=1
ip -6 route replace fcbb:bb00:4:fe00:: encap seg6local action End.DT6 table 255 dev srv6end

ip -6 route replace fd00:100:1::/64 encap seg6 mode encap.red segs fcbb:bb00:1:fe00:: dev eth1
ip -6 route replace fd00:100:2::/64 encap seg6 mode encap.red segs fcbb:bb00:2:fe00:: dev eth1
ip -6 route replace fd00:100:3::/64 encap seg6 mode encap.red segs fcbb:bb00:3:fe00:: dev eth1
```

---

## Command ↔ behavior reference

| What you typed | Layer | SRv6 behavior | What it does |
|---|---|---|---|
| `locator MAIN ... behavior usid` (vtysh) | control plane | — | declares this leaf owns `fcbb:bb00:N::/48`, sliced as uSID (block 32 / node 16) |
| `... encap seg6local action End.DT6 ... dev srv6end` | data plane | **End.DT6** (uN/uDT6) | decapsulate a uSID packet for this leaf, look the inner up in the local table (255), deliver |
| `... encap seg6 mode encap.red segs <uSID>` | data plane | **H.Encaps.Red** | wrap a flow into one uSID in the outer IPv6 DA (no SRH); the headend |
| (pre-provisioned) `network fcbb:bb00:N::/48` in IPv6 BGP | control plane | — | advertises the locator so the fabric routes to it via both spines (ECMP) |
| (pre-provisioned) `net.ipv6.seg6_flowlabel=1` | data plane | — | derive the outer flow label from the inner flow → per-flow ECMP |

### How to verify each piece

```sh
vtysh -c "show segment-routing srv6 locator"      # locator MAIN, Up, behavior uSID
ip -6 -s route show fcbb:bb00:3:fe00::            # End.DT6 endpoint + a climbing packet counter
ip -6 route show fd00:100:3::/64                  # headend: "encap seg6 ... segs fcbb:bb00:3:fe00::"
vtysh -c "show ipv6 route fcbb:bb00:3::/48"       # remote locator via TWO nexthops (ECMP)
ping6 -c3 -I fd00:100:1::1 fd00:100:3::1          # end-to-end over the uSID transport
```

The **packet counter** on the endpoint (`ip -6 -s route show <sid>`) is the single most reliable signal — `ip -6 route show` alone does not always render the `encap` attributes in this image, but the counter never lies: if it climbs, the leaf is decapsulating.

---

## Common mistakes (in priority order)

| Symptom | Cause | Fix |
|---|---|---|
| Endpoint check fails; uSID pings return *"destination unreachable"*; `ip route show <sid>` shows a plain route with no `encap` | **The `End.DT6` endpoint was bound to `dev lo`.** A lo-bound seg6local route is silently accepted with no lwtunnel attached — it does nothing. This is *the* SRv6 gotcha. | Delete it and re-add on a real device: `ip -6 route del <sid>; ip -6 route replace <sid> encap seg6local action End.DT6 table 255 dev srv6end`. Confirm `srv6end` exists and is `up`. |
| `srv6_path_works` fails; the **endpoint counter on leaf3 climbs** (decap *is* happening) but the ping still reports 100% loss | **No symmetric return headend.** leaf3 decapsulates fine, but its reply to `fd00:100:1::1` has no SRv6 path back because leaf3 is missing a headend for `fd00:100:1::/64`. | Add the return headend on the egress leaf: `ip -6 route replace fd00:100:1::/64 encap seg6 mode encap.red segs fcbb:bb00:1:fe00:: dev eth1`. Every leaf needs headends for the *other three*. |
| uSID pings fail with no decap at all; the far leaf's endpoint counter stays 0 | **Headend points at the wrong uSID**, or the **service source wasn't specified.** Either the `segs` value doesn't match the destination leaf's endpoint SID, or you pinged without `-I fd00:100:N::1` and sourced from a link address the far leaf can't route back to. | Check the headend `segs` equals the destination leaf's `fcbb:bb00:<dst>:fe00::`, and always `ping6 -I fd00:100:<self>::1 ...`. |
| `srv6_locators_configured` passes but everything downstream is reachable via only **one** spine (ECMP shows 1 nexthop) | **An IPv6 BGP session is down** (a leaf↔spine `/127` mismatch or a flapped session), so a locator is learned via only one path. | `vtysh -c "show bgp ipv6 unicast summary"` on the leaf — both spine sessions must be Established. If not, click **Reset** to re-apply the clean dual-stack underlay. |
| Locator shows `Up` but traffic to it is dropped at the *owning* leaf | **Endpoint SID doesn't fall inside the locator `/48`.** e.g. the locator is `fcbb:bb00:1::/48` but the endpoint was typed `fcbb:bb00:2:fe00::`. The leaf advertises one block but decapsulates a different one. | Make the endpoint SID `fcbb:bb00:<N>:fe00::` match the leaf's own locator digit `N`. |

---

## Reset / re-solve

- **Reset** re-applies `_srv6_skeleton`: it runs the bootstrap teardown (removes `srv6end` and any seg6 routes), then lays the clean dual-stack underlay back down. You're returned to the Step-1 starting point with no SRv6 layer. IPv4 + VXLAN are never touched.
- **Solve** applies `_srv6`: the full build above, on all four leaves, in one shot.

Then click **Start ▶** to build it yourself again, or move on to **Lab 6 — Super Spines** when you're ready.
