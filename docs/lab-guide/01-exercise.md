# Exercise — Build the BGP underlay

> Read [`00-overview.md`](00-overview.md) first if you haven't.

## Scenario

Your lab is up: 14 containers running on the remote host (2 spines + 4 leaves + 8 GPU workers). Workers are pre-configured with `/31` IPs on their fabric link. The switches are running FRR but have **no routing config** — their `configs/frr/<node>/frr.conf` files contain only a hostname and the FRR boilerplate.

Your job: build the **eBGP underlay** so that all 8 GPU workers can ping each other across the fabric, with **ECMP** between every leaf-to-leaf path (via both spines).

Verify your starting state:

```bash
make wipe                          # if you haven't already
make bgp-check 2>&1 | head -20     # expect: no peers configured anywhere
make ping-mesh | tail -5           # expect: most pairs FAIL (workers can only reach their own leaf)
```

---

## What's given

- **Topology + IP plan** — every interface IP, every loopback, every BGP peer is documented in [`../topology.md`](../topology.md). Use **§3 Per-device factsheets** to look up each switch's interface IPs, and **§5 BGP peer matrix** for who peers with whom.
- **ASN allocation:**
  - Spines: **AS 65000** (both spines share the same ASN — this matters, see hints)
  - Leaves: **AS 65101, 65102, 65103, 65104**
- **Worker subnets to advertise:** each leaf has 2 workers attached, each on its own `/31`. Workers don't run BGP, so the leaf must advertise these subnets.
- **Skeleton files** at `configs/frr/<node>/frr.conf` — start with hostname + boilerplate, you fill in the rest.
- **Bootstrap pipeline** — `make sync && make fabric-bootstrap` runs `vtysh -b` inside every switch, which reads your `frr.conf` and applies it. See `configs/frr/bootstrap-switch.sh` for what's actually happening.

---

## Tasks

### Task 1 — Configure interfaces on each switch
Every spine and every leaf needs:

- **Loopback** (`lo`) with the switch's router-ID `/32`. Leaves also need a second loopback for their VTEP (reserved for Phase 3 — advertise it now so it's in the RIB).
- **Fabric interfaces** (`eth1`..`eth4`) with their `/31` per-link IPs from the topology doc.

Hint: in FRR's `frr.conf`, interface IPs go under per-interface blocks:

```
interface eth1
 description to_<peer>
 ip address <IP>/<mask>
!
```

### Task 2 — Configure BGP

On each switch:

- `router bgp <asn>` with `bgp router-id <loopback IP>`
- Declare each direct neighbor with `neighbor <peer-ip> remote-as <peer-asn>`
- Use **peer-groups** (`SPINES` on the leaves, `LEAVES` on the spines) — it'll save you ~50% of the typing and you'll thank yourself when adding the 50th line of neighbor config.

### Task 3 — Advertise the right prefixes

Inside `address-family ipv4 unicast`, use `network <prefix>` statements. What to advertise:

- **Every switch:** its own loopback `/32`.
- **Every leaf:** also its second loopback (VTEP `/32`) **AND** its two worker `/31` subnets.

Spines learn everything via BGP — no need to advertise the spine-to-leaf P2Ps explicitly.

### Task 4 — Enable ECMP

Both spines share AS 65000. The two BGP paths a leaf gets to a remote leaf will have different AS-paths in *length* zero but the same as-path content `[65000 <remote-leaf-asn>]`. BGP's default best-path tiebreaker rejects equal-cost paths if the as-paths differ in any byte (including AS_PATH router IDs). Two settings make ECMP work:

```
router bgp <asn>
 bgp bestpath as-path multipath-relax
 !
 address-family ipv4 unicast
  maximum-paths 64
```

`multipath-relax` says "equal-cost paths with **same length** but different AS_PATH bytes are still multipath-eligible." `maximum-paths 64` tells the FIB to install up to 64 next-hops per prefix (we'll use 2).

---

## Apply your changes

```bash
make sync                  # rsync your edits to the remote
make fabric-bootstrap      # vtysh -b on every switch
```

For a single switch, you can also re-run the bootstrap directly:

```bash
ssh aidc-remote 'docker exec leaf1 sh /usr/local/bin/bootstrap-switch.sh'
```

---

## Success criteria

Run these and they should all pass:

```bash
make bgp-check
# Every leaf shows 2 spine peers Established with PfxRcd=13
# Every spine shows 4 leaf peers Established with PfxRcd=4

make ping-mesh
# 56/56 OK

make shell-leaf1
# Inside leaf1:
vtysh -c "show ip route 10.0.1.3"
# Expect TWO next-hops (10.1.1.0 via eth1, 10.1.2.0 via eth2) — that's ECMP
```

Or all-in-one:

```bash
make lab-status
```

---

## Hints

1. **Peer-groups (`SPINES`/`LEAVES`) cut typing in half.** Declare the group, set common attributes (timers, activate, soft-reconfiguration) on the group, then just bind each neighbor to the group.

2. **`no bgp default ipv4-unicast` + per-neighbor `activate`** — FRR's default in datacenter mode auto-activates ipv4-unicast on every neighbor, but the *explicit* form is the common production pattern and matches what we use everywhere. If your peers come up but PfxRcd stays 0, you forgot the `activate`.

3. **`bgp bestpath as-path multipath-relax`** is required here. Without it, ECMP collapses to one next-hop because both spines share AS 65000 and the AS-paths differ structurally. Symptom: `show ip route 10.0.1.3` shows only one next-hop instead of two.

4. **Workers' `/31` subnets** must be in `network` statements on the leaf. They will NOT appear via `redistribute connected` because we don't configure that.

5. **`soft-reconfiguration inbound`** on each peer-group lets you run `show bgp ipv4 unicast neighbor X received-routes` for debugging. It costs a little memory but is worth it in a teaching lab.

6. **Order of configuration doesn't strictly matter,** but doing spines first is pedagogically cleaner: spine peers will stay in `Active` until the leaves come up.

---

## Common pitfalls (preview)

The detailed troubleshooting matrix is in [`02-solution.md`](02-solution.md) (last section), but a quick preview of what trips people up:

- Peer stuck in `Active` → either the peer's IP is wrong, the other end isn't configured yet, or the interface is down
- Peer up, PfxRcd=0 → missing `neighbor X activate` in the address-family
- Routes received but only 1 next-hop in `show ip route` → missing `multipath-relax`
- gpu1 can't ping gpu3 but BGP looks healthy → leaf didn't `network` the worker /31s

---

## When you're done

```bash
make lab-status
```

Should print all 56 pings OK and every BGP session Established. The browser UI at `http://192.168.1.26:3000/topology` should show all nodes green again.

If you want to compare your work against the canonical solution, see [`02-solution.md`](02-solution.md). To revert to the canonical state at any time: `make solve`.
