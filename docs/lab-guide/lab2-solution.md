# Solution — EVPN-VXLAN overlay: every command you need

Just the commands. The *why* behind each one lives in [`lab2-exercise.md`](lab2-exercise.md); this doc is the answer key.

> **Shortcut**: if you'd rather skip the exercise and get a fully working overlay, click **Solve** in the top bar — the orchestrator drops `overlay-setup.sh` onto every leaf (which runs the SONiC `config vlan` / `config vxlan` block), applies the canonical EVPN frr.conf, and reloads. Your run gets flagged "solved" on the completion screen.

---

## 1 — Set up the L2 segment on every leaf (SONiC CLI)

These are SONiC `config` commands — not vtysh. Each leaf gets the **same** five commands; only the literal IPs differ. Run from a shell on each leaf.

**leaf1:**

```sh
config vlan add 1000
config interface ip add Vlan1000 192.168.100.1/24
config vxlan add vtep 10.0.10.1
config vxlan evpn_nvo add nvo1 vtep
config vxlan map add vtep 1000 10100
```

**leaf2:**

```sh
config vlan add 1000
config interface ip add Vlan1000 192.168.100.2/24
config vxlan add vtep 10.0.10.2
config vxlan evpn_nvo add nvo1 vtep
config vxlan map add vtep 1000 10100
```

**leaf3:**

```sh
config vlan add 1000
config interface ip add Vlan1000 192.168.100.3/24
config vxlan add vtep 10.0.10.3
config vxlan evpn_nvo add nvo1 vtep
config vxlan map add vtep 1000 10100
```

**leaf4:**

```sh
config vlan add 1000
config interface ip add Vlan1000 192.168.100.4/24
config vxlan add vtep 10.0.10.4
config vxlan evpn_nvo add nvo1 vtep
config vxlan map add vtep 1000 10100
```

Verify per leaf:

```sh
show vxlan tunnel               # expect: vtep <its VTEP IP> ... 10100 -> Vlan1000
show vxlan vlanvnimap           # expect: Vlan1000 ↔ 10100
ip -br link show Vlan1000 vtep-1000   # both UP
ip addr show Vlan1000           # 192.168.100.<N>/24 present
```

---

## 2 — Activate L2VPN-EVPN on every leaf (vtysh)

Open each leaf's console, `vtysh`, then paste. Only the ASN differs.

**leaf1 (AS 65101):**

```
configure terminal
router bgp 65101
 address-family l2vpn evpn
  neighbor SPINES activate
  advertise-all-vni
 exit-address-family
end
```

**leaf2 (AS 65102):**

```
configure terminal
router bgp 65102
 address-family l2vpn evpn
  neighbor SPINES activate
  advertise-all-vni
 exit-address-family
end
```

**leaf3 (AS 65103):**

```
configure terminal
router bgp 65103
 address-family l2vpn evpn
  neighbor SPINES activate
  advertise-all-vni
 exit-address-family
end
```

**leaf4 (AS 65104):**

```
configure terminal
router bgp 65104
 address-family l2vpn evpn
  neighbor SPINES activate
  advertise-all-vni
 exit-address-family
end
```

> Why vtysh and not `config bgp`? See [`lab2-exercise.md`](lab2-exercise.md) Step 3 — TL;DR: `config bgp` is broken in this image's BGP tables ([ADR-008](../../notes/decisions.md)), but `config vxlan` works fine. We use the right surface for each part of the lab.

---

## 3 — Activate L2VPN-EVPN transit on the spines (vtysh)

Same block on both spines — both are AS 65000.

**spine1 + spine2:**

```
configure terminal
router bgp 65000
 address-family l2vpn evpn
  neighbor LEAVES activate
 exit-address-family
end
```

One line per spine — that's it. FRR (both the 7.5.1 in the legacy image and the current 10.4.1 in `aidc/sonic-vs:202511`) preserves L2VPN-EVPN next-hops on eBGP peers by default, so no explicit `next-hop-unchanged` / `attribute-unchanged next-hop` is needed. In a production FRR 8.x+ deployment you'd add `neighbor LEAVES next-hop-unchanged` here as defense-in-depth; on FRR 7.x the equivalent is `neighbor LEAVES attribute-unchanged next-hop`. **Neither knob has a visible effect in this image** — both are silently accepted by `vtysh` and don't persist into `show running-config`. See [`lab2-exercise.md`](lab2-exercise.md) Step 4 for the textbook failure mode this would protect against.

---

## 4 — Verify

On `leaf1`:

```sh
vtysh -c "show bgp l2vpn evpn summary"      # 2 spines Established, int PfxRcd
vtysh -c "show bgp l2vpn evpn"               # Type-2 + Type-3 routes from 3 remote VTEPs
vtysh -c "show evpn vni 10100"               # FRR sees vtep-1000, local VTEP 10.0.10.1
vtysh -c "show evpn vni 10100"                # 3 remote VTEPs (flood: HER) — FRR view
show vxlan remotevtep                         # 3 remote VTEPs (Creation Source: EVPN) — SONiC view
ping -c 2 -W 2 -I Vlan1000 192.168.100.3     # first overlay packet
```

From the UI top bar, click **Submit ✓** — the orchestrator re-runs every checkpoint plus the full 12-pair leaf-to-leaf overlay ping mesh.

---

## Appendix A — Common mistakes

The most likely things to go wrong with this lab, in priority order (start at the top when something's broken):

| Symptom | Cause | Fix |
|---|---|---|
| `show bgp l2vpn evpn` looks perfect on leaf1 (3 remote VTEPs visible) but `ping -I Vlan1000 192.168.100.3` times out | **Theoretical / future-FRR failure mode**: a spine is rewriting EVPN next-hops to its own router-id. leaf3's view of leaf1's routes shows `nexthop = 10.0.0.X` (a spine) instead of `10.0.10.Y` (a leaf VTEP), so the bridge fdb tunnels point at the spine, which has no UDP 4789 listener; frames are silently dropped. **In this lab's FRR build this does not happen** — FRR preserves L2VPN-EVPN next-hops on eBGP peers by default (verified on both FRR 7.5.1 and FRR 10.4.1). Confirm with `vtysh -c "show bgp l2vpn evpn"` on a receiving leaf: next-hops should be `10.0.10.X(...)` (a VTEP), not `10.0.0.X`. On future FRR builds where the default might change, you'd add `neighbor LEAVES next-hop-unchanged` (FRR 8.x+) or `neighbor LEAVES attribute-unchanged next-hop` (FRR 7.x) to each spine as defense-in-depth. In this image neither syntax has a visible effect (silently accepted, not persisted); the FRR default is the only mechanism. |
| `show vxlan remotevtep` returns "Total count : 0" even when the overlay clearly works | You're on the **legacy `netreplica/docker-sonic-vs:latest` (2022)** image, which has a swssconfig back-sync gap — FRR learns the remote VTEPs but they don't appear in APP_DB. | Upgrade to `aidc/sonic-vs:202511` (see ADR-011) where this is fixed and the SONiC view works. As a workaround on the legacy image, use `vtysh -c "show evpn vni 10100"` (which always works). |
| `show bgp l2vpn evpn summary` on leaf1 shows Established, but `show bgp l2vpn evpn` is empty for one specific leaf's prefixes | That leaf forgot `advertise-all-vni`. It established the session but originates no routes for its VNIs. | On the broken leaf: `configure terminal` → `router bgp <ASN>` → `address-family l2vpn evpn` → `advertise-all-vni` → `end` |
| `show vxlan tunnel` on leaf2 shows the tunnel, but `show evpn vni 10100` in vtysh on leaf2 is empty | Forgot `config vxlan evpn_nvo add nvo1 vtep` on leaf2. The tunnel exists at the data plane, but EVPN signaling wasn't bound to it. | `config vxlan evpn_nvo add nvo1 vtep` on the broken leaf; `show evpn vni` should populate within ~5s |
| Initial ping works, but subsequent pings fail intermittently | Likely a MAC learning race between Type-2 routes and local bridge learning. Usually resolves itself within a few seconds. If persistent, check that the same VLAN (1000) and VNI (10100) are configured on every leaf — a mismatch causes silent black-holing. | `show vxlan vlanvnimap` on every leaf; confirm same VLAN↔VNI |
| `show bgp l2vpn evpn summary` shows session Established but PfxRcd = 0 on every neighbor | Forgot `neighbor SPINES activate` (on a leaf) or `neighbor LEAVES activate` (on a spine) inside `address-family l2vpn evpn`. The session came up but no AF is active on it — same gotcha as Lab 1's `neighbor X activate` requirement, applied to a different AF | Re-enter `router bgp <ASN>` → `address-family l2vpn evpn` → `neighbor SPINES activate` (or `LEAVES activate` on a spine) |
| `config vlan add 1000` returns "Vlan with vlan id 1000 already exists" | A previous Solve / overlay run is still present. Either run the teardown sequence (Appendix C) or click **Reset** to wipe back to underlay-only, then try again. | See Appendix C |
| `config vxlan add vtep 10.0.10.1` returns "Vxlan vtep already exists" | Same — leftover state from a prior run | Run the teardown sequence first; or click Reset |
| `Vlan1000` shows up in `ip -br link` but doesn't get the IP from `config interface ip add` | The VLAN object needs to exist *before* the interface IP is added. `config vlan add 1000` must come first. | Re-order: `config vlan add 1000` → `config interface ip add Vlan1000 ...` |

---

## Appendix B — What this would look like in `config_db.json`

For reference (we don't edit config_db directly — the `config` CLI does it for you), the JSON equivalent of leaf1's overlay setup is:

```json
"VLAN": {
  "Vlan1000": {"vlanid": "1000"}
},
"VLAN_INTERFACE": {
  "Vlan1000": {},
  "Vlan1000|192.168.100.1/24": {}
},
"VXLAN_TUNNEL": {
  "vtep": {"src_ip": "10.0.10.1"}
},
"EVPN_NVO": {
  "nvo1": {"source_vtep": "vtep"}
},
"VXLAN_TUNNEL_MAP": {
  "vtep|map_10100_Vlan1000": {"vni": "10100", "vlan": "Vlan1000"}
}
```

This is what SONiC's `config vxlan` / `config vlan` commands write under the hood. `swssconfig` reads these tables, translates them into kernel objects (Linux bridge `Bridge`, sub-interface `Vlan1000@Bridge`, VXLAN dev `vtep-1000`), and FRR's `advertise-all-vni` discovers the result.

---

## Appendix C — Teardown sequence

To manually clean up Lab 2 state on a leaf (e.g. before re-running the exercise from scratch without clicking Reset):

```sh
config vxlan map del vtep 1000 10100
config vxlan evpn_nvo del nvo1
config vxlan del vtep
config interface ip remove Vlan1000 192.168.100.<N>/24
config vlan del 1000
```

This is the exact sequence `bootstrap-switch.sh` runs every time before applying overlay state, so Start ▶ / Reset always starts from a clean slate.

---

## Appendix D — Want to revert?

Click **Solve** to fully wire the overlay end-to-end, or click **Reset** to wipe overlay state and restore healthy underlay. Both buttons are idempotent.

If you want to verify the reset worked (overlay is *gone*):

```sh
docker exec leaf1 show vxlan tunnel                            # expect: no entries
docker exec leaf1 ip link show Vlan1000 2>&1 | head -1         # expect: "Device does not exist"
docker exec leaf1 vtysh -c "show evpn vni" | head -3           # expect: header only, no VNIs
```

Then click **Start lab ▶** to re-apply the canonical underlay and begin again.
