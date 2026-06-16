# Decision records (ADR-lite)

Brief, opinionated, dated. Append-only. Each entry: **Decision → Why → Trade-off**.

---

## ADR-001 — eBGP numbered (not unnumbered) for the underlay
**Date:** 2026-05-24

**Decision:** Use eBGP between every leaf and every spine, with numbered /31 P2P addressing, **not** BGP unnumbered (RFC 5549 / link-local).

**Why:**
- Numbered P2Ps show up clearly in `tcpdump` and routing tables. As a teaching lab this matters more than operational ergonomics.
- The /31 IPs encode topology (`10.1.<spine_id>.<leaf_id*2>`). A reader can guess which link a packet came from just by reading the source IP.
- Unnumbered would have meant explaining IPv6 link-local + RFC 5549 in the very first scenario. Not worth it.

**Trade-off:** Real hyperscale fabrics often use BGP unnumbered to save addressing planning. We're paying a small "less production-realistic" tax for pedagogical clarity. Documented this in the first blog so an interviewer can ask about it.

---

## ADR-002 — Shared AS on the spines (both spines are AS 65000)
**Date:** 2026-05-24

**Decision:** Both spine switches use AS 65000. Each leaf has a unique AS (65101–65104).

**Why:**
- This is the standard CLOS pattern. Leaves never need to talk to other leaves directly; spines exist to relay.
- Shared spine AS naturally drops routes that would loop back to the originating leaf (AS-path loop prevention), which is what we want.
- Simpler than per-spine ASNs + manual filtering.

**Trade-off:** For EVPN in Phase 2 we'll likely need `allowas-in` on leaf-side EVPN peering so that leaves accept routes originated by other leaves but transited through the same-AS spines. We'll document that gotcha when we get there.

**Update (2026-05-26, Lab 2 build):** Empirical testing on `netreplica/docker-sonic-vs:latest` (FRR 7.5.1-sonic) inverted the textbook expectations:
- **No `allowas-in` was needed on leaves.** Unique leaf ASNs + the standard eBGP loop-prevention (own-AS rejection) work as designed; cross-leaf EVPN routes propagate cleanly through both shared-AS spines without any leaf-side relaxation.
- **EVPN next-hops are preserved on eBGP peers by default** in this FRR version. Confirmed empirically: on leaf3, `show bgp l2vpn evpn` shows leaf1's Type-3 route with next-hop `10.0.10.1` (leaf1's VTEP), not `10.0.0.1` (spine1's router-id). So the textbook "shared-AS spine rewrites next-hop → silent black-hole" failure mode does **not** fire in this build.
- **No working spine-side knob exists in this build.** Both `neighbor X next-hop-unchanged` (FRR 8.x+ shorthand) and `neighbor X attribute-unchanged next-hop` (FRR 7.x token) are silently accepted by `vtysh`'s parser but never persist into `show running-config`. The shorthand also errors as `% Unknown command` in interactive vtysh on this image; the FRR 7.x form is fake-accepted (no error, no effect, no record). The spine canonical configs in `configs/frr/_overlay/spine{1,2}/frr.conf` therefore only have `neighbor LEAVES activate` on the EVPN AF — the FRR 7.5 default is the only mechanism preserving next-hops in this lab.
- **On modern FRR 8.x+ builds** (current SONiC, recent Cumulus, plain FRR) — add `neighbor LEAVES next-hop-unchanged` to each spine as defense-in-depth. Production templates should always make the intent explicit even when the default does the right thing.
- **Always verify a config push actually loaded** with `vtysh -c "show running-config"`. `vtysh -b` (boot-time parser) drops unknown or no-op commands without warning.

---

## ADR-003 — sonic-vs (amd64 under Rosetta) instead of an arm64-native NOS
**Date:** 2026-05-24

**Decision:** Use `netreplica/docker-sonic-vs:latest` as the switch NOS, accepting that it runs amd64 under Rosetta on Apple Silicon.

**Why:**
- The user explicitly asked for SONiC — it's the resume signal they want.
- Real SONiC config_db.json + FRR + sonic-cli is the actual production interface; an arm64-native FRR-only fabric would be missing that surface.
- 6 sonic-vs containers fit in 24 GB RAM. Each consumes ~1 GB.

**Trade-off:**
- Cold start is 2–5 min (Rosetta translation cost).
- Cannot scale past ~8 sonic-vs containers comfortably on 24 GB.
- Dataplane is the Linux kernel (the SAI "vslib" stub), so we cannot demonstrate hardware features like real PFC pause frames, ECN marking by the ASIC, or queue-level WRED. We approximate via Linux `tc`/`qdisc` and are honest about it in the blogs.

**Fallback plan:** If sonic-vs becomes unworkable at scale, swap to arm64-native FRR with the same EVPN/BGP config. The control plane is portable (it's FRR underneath in both cases). Document the swap as a teaching moment ("when the NOS doesn't fit the lab, the protocols are still the same").

---

## ADR-004 — Gloo (via PyTorch) for CPU collective ops, MPI as Phase 3 addition
**Date:** 2026-05-24

**Decision:** Primary collective backend is PyTorch's Gloo. OpenMPI / mpi4py added in Phase 3 for variety.

**Why:**
- NCCL is GPU-only — not an option without GPUs.
- Gloo is `pip install torch` away, ships with CPU AllReduce/Broadcast/Gather, runs over plain TCP, and is what PyTorch itself uses for CPU distributed training.
- Real production training jobs use Gloo for the CPU rendezvous and NCCL for GPU collectives — so this lab is at minimum a faithful CPU-side reproduction.
- MPI is the *lingua franca* of HPC and is referenced everywhere in the AI training literature. Including it in Phase 3 lets us write the MPI blog from first-hand experience and contrast MPI's tag-based semantics with Gloo's collective-only API.

**Trade-off:** Gloo's CPU performance is modest (no kernel bypass, no RDMA). Lab throughput will be hundreds of Mbps, not Gbps. We use bandwidth as a relative signal in this lab, not an absolute one.

---

## ADR-005 — One stretched L2 segment for all 8 GPUs (Phase 2)
**Date:** 2026-05-24

**Decision:** In Phase 2, all 8 worker nodes will live in a single VXLAN L2 segment (VNI 10100, subnet 192.168.100.0/24), stretched across all 4 leaves via EVPN Type-2 routes.

**Why:**
- This mirrors real **rail-optimized** AI fabric designs. Production AI pods put all GPUs in one big L2 domain so that NCCL/Gloo collectives don't need L3 hops mid-AllReduce.
- Simpler mental model for the user: "all the GPUs are on one wire, the fabric makes it look that way."

**Trade-off:** Stretched L2 doesn't scale past a single pod in production (BUM flooding, MAC table size). At our scale of 8 hosts it's a non-issue. Documented in the EVPN blog.

---

## ADR-006 — Ansible (not Nornir) as the primary automation tool
**Date:** 2026-05-24

**Decision:** Phase 2 config push uses Ansible. We may add a small Nornir example as a counterpoint.

**Why:**
- Ansible is the standard on a network engineer's resume.
- SONiC has community-maintained Ansible roles and modules.
- Nornir is technically nicer (Python-native, parallel, better testability) but less familiar to interviewers.

**Trade-off:** We'll write Ansible idiomatically but lose some of the testability Nornir offers. Mitigated by keeping the actual config rendering in Jinja templates that can be unit-tested with `j2cli` if we want.

---

## ADR-007 — gNMIc → Prometheus → Grafana for telemetry (Phase 3)
**Date:** 2026-05-24

**Decision:** Telemetry pipeline is `gnmic` subscribing to SONiC's gNMI endpoint, exposing a Prometheus scrape endpoint, with Grafana visualizing.

**Why:**
- gNMIc is the de-facto OSS gNMI client; lightweight, configurable, exposes Prom natively.
- Skipping Telegraf removes a moving part.
- Grafana dashboards as code (JSON in `telemetry/grafana/dashboards/`) make the lab reproducible.

**Trade-off:** sonic-vs's gNMI surface is limited compared to real SONiC on hardware (no SAI counters, just config-DB + APP-DB state). We pair with `sflow` on the worker side to get flow-level visibility the switch dataplane can't give us.

---

## ADR-008 — Bypass SONiC's port_config / config_db BGP path; bind-mount FRR config directly
**Date:** 2026-05-24

**Decision:** In `netreplica/docker-sonic-vs:latest` (the only readily-available sonic-vs image and the one referenced in the official Containerlab docs), the lab does **not** drive routing through SONiC's `config_db.json` → `bgpcfgd` → FRR rendering pipeline. Instead, each switch container bind-mounts a hand-written `frr.conf` plus a `daemons` file with `bgpd=yes`, and a post-deploy `bootstrap-switch.sh` brings up `eth1..eth4`, fixes file ownership, restarts FRR daemons, and runs `vtysh -b` to load the unified config.

**Why:**
- The image is FRR 7.5.1-sonic (circa 2021). Its `bgpcfgd` does not recognise the newer `BGP_GLOBALS` / `BGP_GLOBALS_AF` / `BGP_GLOBALS_AF_NETWORK` config_db tables, so the BGP_NEIGHBOR entries we wrote in `config_db.json` never resulted in `bgpd` being enabled (`/etc/frr/daemons` stayed `bgpd=no`).
- The same image does not bridge the containerlab veths (`eth1..eth4`) to its synthetic SONiC ports (`Ethernet0/4/8/12`). The Ethernet ports come up DOWN with no backing veth, while the `eth*` interfaces are UP without IPs. SONiC's INTERFACE table from `config_db.json` consequently has no effect.
- FRR 7.5 also does not auto-load `/etc/frr/frr.conf` from each daemon process — `zebra`, `bgpd`, and `staticd` each look for their own `zebra.conf` / `bgpd.conf` / `staticd.conf`. The unified-config story relies on `vtysh -b` being run explicitly after the daemons start.

**Trade-off:**
- We lose the "this is how real SONiC is configured" surface. The `config_db.json` files still exist in the repo and accurately describe what the same fabric *would* look like under a modern SONiC build, but they are no longer load-bearing for the running lab.
- We gain a config story that is portable across any FRR-based NOS (real SONiC, Cumulus, plain FRR) and is human-readable as `vtysh` output. For a teaching lab, this is the right trade.

**How to apply:** Anything that needs to change BGP/interfaces in the lab today should edit the per-switch file under `configs/frr/<node>/frr.conf` and re-run `make fabric-bootstrap`. Edits to `configs/sonic/<node>/config_db.json` are currently inert — keep them as a future-state reference, not as runtime config.

**Reversion path:** If the lab is later moved onto a current SONiC image (e.g. the official `docker-sonic-vs` from a modern `sonic-buildimage` checkout), the config_db.json files are ready to take over — drop the FRR binds from `topo/aidc.clab.yml`, restore `startup-config:` entries, and remove `make fabric-bootstrap` from `make warm`.

---

## ADR-008.1 — SONiC `config vxlan` / `config vlan` CLI DOES work; only BGP tables are broken
**Date:** 2026-05-25

**Decision:** Lab 2 (EVPN-VXLAN overlay) uses SONiC's native CLI (`config vlan add`, `config vxlan add`, `config vxlan evpn_nvo add`, `config vxlan map add`, `config interface ip add`) for the data-plane setup. Only BGP-related configuration continues to use `vtysh` directly (per ADR-008).

**Why:** Phase 0 testing during Lab 2 redesign (May 2026) on the running `netreplica/docker-sonic-vs:latest` image found:
- `/usr/local/bin/config vxlan` is fully populated with `add`, `del`, `map`, `evpn_nvo` subcommands.
- The full SONiC CLI sequence executes cleanly:
  ```
  config vlan add 1000
  config interface ip add Vlan1000 192.168.100.1/24
  config vxlan add vtep 10.0.10.1
  config vxlan evpn_nvo add nvo1 vtep
  config vxlan map add vtep 1000 10100
  ```
  Each command returns 0 with no tracebacks.
- swssconfig programs the kernel objects: a Linux bridge named `Bridge`, a sub-interface `Vlan1000@Bridge`, and a VXLAN dev `vtep-1000` (auto-named `<vxlan_name>-<vlan_id>`).
- `show vxlan tunnel` and `show vxlan vlanvnimap` reflect the configured state.
- FRR's `advertise-all-vni` (in the `address-family l2vpn evpn` block) discovers the SONiC-created VXLAN dev: `vtysh -c "show evpn vni"` lists VNI 10100 bound to `vtep-1000` with the correct Local VTEP IP.
- `show vxlan remotevtep` populates with `Creation Source: EVPN` once peers exchange Type-3 routes.

In other words: ADR-008's "config_db doesn't work" finding was BGP-specific (`BGP_GLOBALS*` tables introduced in a newer FRR/SONiC layout). The VXLAN/VLAN/EVPN_NVO tables predate that layout and are wired correctly through `swssconfig`. We had assumed without testing that the breakage was repo-wide; the test invalidates that assumption.

**Trade-off:**
- Lab 2 now teaches the SONiC-native overlay workflow — the same `config vxlan` commands a learner would use on a production switch.
- The split CLI surface (vtysh for BGP, `config` for VXLAN) is mildly awkward to explain, but it's the truth of this image. Lab 2's overview and exercise call this out explicitly.
- Persistence still requires `config save` to write config_db to disk; the lab doesn't do this (overlay state is re-applied via `overlay-setup.sh` on every Start/Reset/Solve, matching Lab 1's pattern).

**How to apply:** When adding any new lab that touches VLAN/VXLAN/EVPN data-plane construction, **prefer SONiC `config` CLI over iproute2 or vtysh**. Reserve vtysh for BGP/FRR-protocol work where SONiC's CLI is broken. Always test before assuming a given SONiC CLI surface is broken — Phase 0 of the Lab 2 redesign showed that "everything's broken" was wrong.

---

## ADR-009 — Promote UI (FastAPI + Next.js) from Phase 4 to Phase 2
**Date:** 2026-05-24

**Decision:** The web UI (FastAPI orchestrator + Next.js dashboard) moves to Phase 2, ahead of EVPN/overlay/AllReduce/telemetry. The MVP of Phase 2 is **a working web console into every device in the topology** — equivalent to `make shell-<node>` but in the browser. Subsequent phases (EVPN, telemetry) will each add their own UI surfaces (config-push button, live telemetry panels) instead of being deferred to a final UI sprint.

**Why:**
- The user is preparing for interviews. Being able to demo through a browser tab from Phase 2 onward is much higher signal than CLI walkthroughs.
- Building the UI incrementally alongside each capability is lower-risk than building it all at the end. Each Phase's UI surface stays small and scoped.
- The console-from-browser story is a non-trivial piece of infra (PTY-over-WebSocket, container discovery, terminal emulation) that's better isolated and finished before more moving parts pile up.

**Trade-off:**
- We delay EVPN/AllReduce by one phase. A network engineer's first instinct is to put the routing protocol next; we're deliberately doing the operator surface first instead.
- The UI built in Phase 2 is purposefully thin — list of devices + per-device terminal. No topology graph, no dashboards, no metrics yet. Those grow in Phases 3/4 as their backing data exists.

**How to apply:** When building any later phase, ask "what's the smallest UI surface that lets me demo this?" and bolt it onto the existing FastAPI + Next.js app. Don't defer.

---

## ADR-010 — Move runtime from OrbStack/Apple Silicon to a remote Ubuntu host
**Date:** 2026-05-24

**Decision:** The lab no longer runs on the Mac/OrbStack. All targets execute on a remote Ubuntu 20.04 amd64 box (`aidc-remote`, currently `192.168.1.26`) via SSH. The repo is rsynced over with `make sync`. The Makefile invokes commands directly on the remote — no more `orb -m aidc bash -lc …` indirection.

**Why:**
- The remote has **47 GB RAM and 8 cores**, vs. 24 GB on the M5 — enough headroom to scale the fabric past the current 14 containers in later phases.
- **Native amd64** means `netreplica/docker-sonic-vs` runs without Rosetta translation. Cold boot of the fabric drops from ~2 minutes to seconds; per-switch CPU usage is a fraction of what it was. This also unlocks larger SONiC images.
- One physical host means **the network stack is real Linux networking** — no double-NAT through OrbStack, no port-forward to localhost magic. The Mac browser hits `http://192.168.1.26:3000` directly.
- The Mac stays a thin client (editor + browser). Cleaner separation of "where I write code" vs. "where the lab runs."

**Trade-off:**
- Need network reachability to the remote. If the remote is down/unreachable, the lab is unavailable. The `make ui` UX still works seamlessly because Next.js + FastAPI both bind 0.0.0.0 on the remote.
- The `eveng` user on the remote is in the `docker` and `clab_admins` groups so most commands don't require sudo. `containerlab deploy` still uses `sudo` (containerlab's standard). One sudoers concession: none — we did NOT grant blanket NOPASSWD sudo (an earlier attempt to do so was correctly blocked by the auto-mode classifier).
- We deleted the OrbStack VM path from the Makefile. To re-create the local path, restore the `ORB :=` indirection from git history.

**How to apply:** When the home network changes (new remote IP or DNS), update `REMOTE_HOST` / `REMOTE_IP` in the Makefile or pass via env: `REMOTE_HOST=newbox make sync warm ui`.

---

## ADR-011 — Upgrade switch NOS from `netreplica/docker-sonic-vs:latest` (2022) to `aidc/sonic-vs:202511` (modern SONiC)
**Date:** 2026-05-26

**Decision:** The lab now uses `aidc/sonic-vs:202511`, locally tagged from the official `docker-sonic-vs.gz` artifact published by the SONiC project's Azure CI pipeline (branch `202511`, build 1122165, dated 2026-05-25). Replaces `netreplica/docker-sonic-vs:latest` which was a 2022-vintage build and the source of every limitation ADR-008 worked around.

**Why:**
- **FRR 10.4.1** (vs. 7.5.1 in the old image) — modern protocol surface, all current EVPN/MPLS/IS-IS knobs present.
- **SONiC `show vxlan remotevtep` now populates correctly** from APP_DB — the "always empty" quirk that drove Lab 2's `vtysh -c "show evpn vni"` fallback is gone. (The fallback in `lab2.py` still works on this image and adds zero overhead, so it stays as defense-in-depth.)
- **Sourcing path is well-documented**: the SONiC project publishes `docker-sonic-vs.gz` nightlies for every release branch (`master`, `202511`, `202505`, `202411`, ...) discoverable via the catalog at `https://sonic.software/builds.json`. No more "the only readily-available sonic-vs image" excuse.
- **Truly drop-in for our existing approach**: bind-mounting per-switch `frr.conf` files and running `vtysh -b` on supervisor restart works unchanged on FRR 10.4.1. Modern SONiC has a different default startup (`bgpd=no` in `/etc/frr/daemons`, `mgmtd` daemon, more complex SAI stack) but `bootstrap-switch.sh`'s explicit `supervisorctl start bgpd zebra staticd` flow already handles this.

**What had to change:**
1. **`topo/aidc.clab.yml`** — `image:` swapped from `netreplica/docker-sonic-vs:latest` to `aidc/sonic-vs:202511`. One line.
2. **BGP-row parser bug fix** in 3 places (`orchestrator/api/dockerlib.py:count_established`, `orchestrator/api/checkpoints/lab1.py:_check_leaf1_to_spine1`, `orchestrator/api/checkpoints/lab2.py:_evpn_peer_established`). FRR 10.4 adds a trailing `Desc` column to `show bgp summary` output, breaking parsers that used `parts[-1]`. Fixed by parsing the State/PfxRcd column at fixed offset 9 (correct across both FRR 7.5 and 10.4).
3. **Nothing else.** Per-switch FRR configs, overlay-setup.sh scripts, bootstrap-switch.sh teardown, checkpoint logic — all unchanged.

**Smoke-test results (2026-05-26):**
- Lab 1: `make solve` + `make lab-status` → 8/8 BGP peers Established, 56/56 ping mesh OK.
- Lab 2: orchestrator `Solve` → all 6 checkpoints PASS in 9.6s (bridges_up, evpn_neighbors_up, type2_routes_present, remote_vteps_learned, overlay_ping_pair, overlay_full_mesh).

**Trade-off:**
- **Image size**: 1.75 GB vs. 1.14 GB for the old one (more SONiC daemons; expected). Across 6 switches that's ~3.6 GB more RAM-resident — well within the 47 GB headroom on the remote.
- **Boot time**: modern SONiC's full SAI/swssconfig/orchagent stack takes ~30s to be ready vs. ~10s for the stripped 2022 image. `make warm` accommodates this with its existing 30s settle period.
- **Image distribution**: `aidc/sonic-vs:202511` is built locally from `docker-sonic-vs.gz` (via `docker load`), not pulled from a registry. The download URL (signed Azure artifact link) expires periodically — if we need to share the image or rebuild from scratch, we either re-pull from the SONiC Azure pipeline or publish our copy to a registry. Worth scripting eventually.

**How to apply:** The image is one-shot loaded on the remote. To re-create after a remote rebuild:
```sh
# Discover latest build URL:
curl -s https://sonic.software/builds.json | jq -r '.["202511"]["docker-sonic-vs.gz"].url'
# Download + load (on the lab host):
ssh aidc-remote "curl -sSL '<url>' -o /tmp/docker-sonic-vs-202511.gz && docker load < /tmp/docker-sonic-vs-202511.gz && docker tag docker-sonic-vs:latest aidc/sonic-vs:202511"
```

**Reversion path:** Revert `topo/aidc.clab.yml` to `image: netreplica/docker-sonic-vs:latest` and revert the BGP-row parser fixes (col 9 → col -1). The 2022 image is still pulled and tagged on the remote; no re-download needed.

**Obsoletes:** Most of ADR-008's pain. Specifically:
- ADR-008's "the only readily-available sonic-vs image" framing — no longer true; the SONiC Azure pipeline is the authoritative source.
- The `show vxlan remotevtep` empty-table workaround (still present in lab content for backward compatibility with the older image; can be cleaned up if we never want to support the 2022 image again).
- The implication that we have to bypass config_db entirely — we're still using vtysh-driven `frr.conf` for Lab 1+2 because it's portable and predictable, but modern SONiC's config_db pipeline now works correctly, opening the door to refactoring Lab 1 around the SONiC-native `config bgp` (or YANG/mgmtd) flow in a future ADR if we want.

**Doesn't obsolete:** ADR-008.1 (VXLAN tables work via SONiC CLI) — still accurate, now via modern SONiC's standard `config vxlan` flow.

---

## ADR-012 — Lab 4 telemetry: gnmic + Prometheus + Grafana, with a kernel-netdev side channel
**Date:** 2026-05-26

**Decision:** Lab 4 implements ADR-007's chosen stack — `gnmic → Prometheus → Grafana` — as three new always-on containers in `topo/aidc.clab.yml`, plus a parallel **netdev exporter inside the orchestrator** that exposes per-veth `/proc/net/dev` counters at `/metrics/netdev` for Prometheus to scrape. Grafana is embedded into the lab UI as an iframe in a third workbench pane (gated on a new optional `labs.json` field `grafana_dashboard_path`). Lab 4 is **procedural, not configuration-changing**: `BOOTSTRAP_STATE == SOLVE_STATE == _overlay_workers`, no FRR delta, Solve is a no-op beyond re-enabling the SONiC `telemetry` feature.

**Why:**
- ADR-007 named the stack two phases ago; this lab finally implements it.
- **Always-on, not Lab-4-conditional** so any future lab (Lab 5 failure injection, ECN/incast, multi-tenant) inherits the dashboards for free. Avoids per-lab-id branching in the topology — `make warm` always brings up 17 containers, regardless of which lab the learner is in.
- **gnmic + Prometheus + Grafana**, not lightweight orchestrator polling, because the headline learning objective is the streaming-telemetry model — push-based gNMI subscriptions, OpenConfig YANG paths, Prometheus rate() queries — which is what hyperscalers actually run. A custom poller would teach nothing transferable.
- **Grafana iframe rather than native recharts** because (a) learners need to see the real production tool, not a one-off UI clone; (b) Grafana's panel editor is itself a teaching surface — learners can open the dashboard in a new tab and tinker; (c) Grafana JSON dashboards are portable to any other site that uses Prometheus.
- **Netdev side-channel** because sonic-vs's OpenConfig surface does not bridge the clab veths (`eth1..eth4`) to the synthetic SONiC ports (per ADR-008) — `aidc_interfaces_*` counters stay flat at zero for the links that actually carry traffic. Without the side channel, the dashboards would be all-zero during a working AllReduce and the lab's pedagogical core would fail. The side channel goes away on real hardware.
- **Embedded iframe + anonymous Grafana** (`GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_DISABLE_LOGIN_FORM=true`, `GF_SECURITY_ALLOW_EMBEDDING=true`) keeps the learner inside the lab UI for the most common interaction (just watch the chart) while still letting them open the full Grafana for deeper inspection.

**Trade-off:**
- The lab teaches streaming-telemetry-via-gnmic but the *data the learner sees* comes mostly from the netdev side channel, not from gnmic's OpenConfig stream. The `lab4-solution.md` discloses this honestly with a PromQL example showing what the dashboard would look like on real hardware. Open question whether to drop gnmic entirely (it provides essentially no data in this image) — kept for now because (a) the lab guide *teaches* gnmic, (b) future image upgrades may make it useful, (c) it's already deployed; dropping it adds complexity not subtracts.
- Always-on telemetry stack costs ~300 MB RAM and adds ~20 s to `make warm` cold-start. Trivial against ADR-010's 47 GB headroom but worth noting if running on resource-constrained hosts.
- The Grafana iframe needs `GF_SECURITY_ALLOW_EMBEDDING=true` plus a cross-origin cookie sandbox; if a future Grafana version tightens the X-Frame-Options story, the iframe could break. Test the iframe after any Grafana image bump.
- We chose SONiC's legacy `telemetry` feature (port 8080, more documented) over the newer `gnmi` feature (port 50051) — both ship in `aidc/sonic-vs:202511` but `telemetry` has better gnmic-on-SONiC examples online. Reversion is one line in `lab4.py::_enable_telemetry`.

**How to apply:**
- New labs that want a dashboard: add `"grafana_dashboard_path": "/d/...?kiosk=tv&refresh=5s"` to their labs.json entry, and a new `telemetry/grafana/dashboards/<lab>.json`. The UI picks up the field automatically — no code changes.
- New telemetry sources: add a scrape job to `telemetry/prometheus/prometheus.yml` and (if applicable) export from the orchestrator at a new `/metrics/<thing>` route.
- A future Lab N that needs a per-queue or per-class metric will likely have to extend the netdev exporter (or add another sidecar) — sonic-vs's gNMI won't help. Keep the asymmetry between this lab and real hardware deliberate.

**Reversion path:** Remove the `gnmic`/`prometheus`/`grafana` nodes from `topo/aidc.clab.yml`; remove the `lab4` import + dispatch in `orchestrator/api/labruns.py`; remove the netdev exporter route from `orchestrator/api/main.py`; flip the labs.json `id: "4"` entry back to `coming-soon`. The UI's `<TelemetryPane>` falls back cleanly on missing `grafana_dashboard_path`.

---

## ADR-013 — Super spines: taught conceptually in Lab 5, not deployed
**Date:** 2026-05-28

**Decision:** Lab 5 ("Super Spines — Beyond a Single-Pod CLOS") teaches the super-spine tier **conceptually** — markdown guide + inspection commands against the existing 2-tier fabric — rather than deploying additional `supersp1`/`supersp2` containers above the current spines. `BOOTSTRAP_STATE == SOLVE_STATE == _overlay_workers`; the lab does not change fabric state at all. The new Lab 5 takes id `"5"`; the old `coming-soon` Lab 5 (failure injection) renumbers to id `"6"`.

This insertion is **off the documented Phase 4 roadmap** (which sequenced telemetry → failure injection → incast/ECN). The user explicitly chose to slot super-spines in between Lab 4 and the failure lab, as a conceptual stop that reframes the rest of Phase 4 in terms of pod boundaries.

**Why conceptual instead of deployed:**

A deployed super-spine lab was scoped (see `/Users/umihani/.claude/plans/add-another-lab-between-ancient-river.md` history if recoverable, or rebuild from the appendix below). It required:

- 2 new sonic-vs containers (`supersp1`, `supersp2`) and 4 new veth links in `topo/aidc.clab.yml`.
- A new FRR state directory `_super_spine/` with 8 config files (full configs for spine1/2 + supersp1/2, leaf1-4 identical copies).
- **Cascading state-file work**: every existing FRR state dir (`_skeleton`, `_canonical`, `_overlay`, `_overlay_workers`) needed blank supersp1/supersp2 subdirs added because `orchestrator/api/labruns.py::_apply_configs` iterates the module-level `SWITCHES` constant and raises `FileNotFoundError` if any switch in the list is missing from the source dir. Without these blanks, Labs 1-4 break.
- **Cascading code edits**: extend `labruns.py::SWITCHES`, `netdev_exporter.py::SWITCHES`, `main.py::DEVICE_GROUPS` (new `super_spine` group for the topology page / console picker), Makefile `SPINES`/`SWITCHES_FRR`, and `telemetry/gnmic/gnmic.yaml` targets.
- A new ASN + IP allocation (`AS 64999` shared; `10.3.0.0/16` /31 block — `10.2.x.x` collides with worker /31s per `workers/entrypoint.sh` and `orchestrator/api/labruns.py:172`).
- 6 lab-5 checkpoints (`supersp_interfaces_up`, two `supersp_to_spineN_established`, `vtep_reachability_ecmp`, regression `submit_finale_ping_mesh_intact`, etc.).

That blast radius is **disproportionate to the pedagogical payoff** when the deployed super spines wouldn't carry any actual cross-pod traffic — the platform has one pod, so no traffic naturally traverses the new tier even if it's wired and Established. The hands-on moment would be "type the BGP config, see two more sessions come up, click the ECMP check," and the *interesting* parts of super spines (multi-pod scheduling, blast-radius isolation, scale math) are still markdown-only either way. The conceptual lab delivers the same conceptual payload without the platform surgery.

**Trade-off:**

- The lab is honest about being conceptual. The exercise's Step 4 includes the would-be FRR config blocks as reference reading (not paste-into-console), so a learner who wants the BGP shape gets it. The solution doc carries the full `_super_spine/` state config blocks as Appendix A.
- No hands-on configuration moment in Lab 5. Mitigated by the three inspection checkpoints (`fabric_healthy_two_tier`, `spine_fanout_observed`, `per_pod_ecmp_observed`) — each is a "now you've seen the thing the guide just claimed" beat.
- The Solve button is a no-op re-apply of `_overlay_workers`. UI copy reads slightly off ("Apply the solution config") but isn't strictly wrong — Solve does apply the lab's canonical config; that config just equals the bootstrap state. Decision: tolerate; add `solve_dialog_body` as optional `labs.json` metadata only if the UI walk-through flags it as confusing.

**How to apply:**

- Future labs that fit a "explain a concept without deploying it" mold should follow Lab 5's shape: reuse an existing FRR state for both BOOTSTRAP and SOLVE, build inspection-only checkpoints that pass against the healthy baseline, include would-be config blocks as reference reading rather than paste targets, and keep the regression-guard ping mesh as the submit finale.
- If a later phase wants a *deployed* super-spine lab (e.g. a hypothetical multi-pod Lab 7 with a second pod and real cross-pod traffic), this lab's content stays — the deployment work is purely additive behind it.

**Reversion path:** Replace the lab id `"5"` entry in `orchestrator/api/labs.json` with a pre-Lab-5 version of itself, drop `lab5` from `labruns.py::_LAB_MODULES` and the `from .checkpoints import ... lab5` line, delete `orchestrator/api/checkpoints/lab5.py` and the three `docs/lab-guide/lab5-*.md` files, undo the two README phrasing edits, restore the failure-injection lab's id back to `"5"`. No fabric / topology / FRR state was changed — clean reversal.

---

## Pending decisions

- **RDMA / RoCEv2 simulation?** Currently deferred to a hypothetical Phase 5. Soft-RoCE (`rxe`) works in Linux containers but adds complexity. Need to decide if it adds enough learning value before building.
- **In-band telemetry (INT)?** Skipping. Real INT requires P4/Tofino. We'll mention it conceptually in the telemetry blog.
- **Multi-tenant L3 EVPN demo?** Will add a second VNI (gpu-pod-a, VNI 10101 with L3VNI 30001) in Phase 4 if there's time.
- **gnmic-only telemetry on a future SONiC build?** If a later sonic-vs image starts bridging clab veths to the synthetic Ethernet ports, the netdev side-channel becomes redundant. Track upstream SONiC for that change and plan to drop the side channel when it lands.
