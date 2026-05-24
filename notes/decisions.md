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

## Pending decisions

- **RDMA / RoCEv2 simulation?** Currently deferred to a hypothetical Phase 5. Soft-RoCE (`rxe`) works in Linux containers but adds complexity. Need to decide if it adds enough learning value before building.
- **In-band telemetry (INT)?** Skipping. Real INT requires P4/Tofino. We'll mention it conceptually in the telemetry blog.
- **Multi-tenant L3 EVPN demo?** Will add a second VNI (gpu-pod-a, VNI 10101 with L3VNI 30001) in Phase 4 if there's time.
