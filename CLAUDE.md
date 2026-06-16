# CLAUDE.md — repo-specific guidance

Auto-loaded at session start. Conventions and runbooks for this codebase.

## What this repo is

A **learning platform for AI Data Center networking**. The user (whose repo this is) is the **lab builder** — they author labs and operate the platform. **Hundreds of learners** consume the labs through a browser UI to learn how hyperscale AI fabrics actually work: BGP underlay, EVPN-VXLAN overlay, GPU collective traffic, telemetry, failure scenarios.

Underneath the platform is a virtual fabric: `netreplica/docker-sonic-vs` + FRR + containerlab. Two ways it's consumed:

1. **As a demo / operator surface** — `make warm` brings up 14 containers (2 spines, 4 leaves, 8 GPU workers, orchestrator, UI). The README's "Two ways to run" section covers remote vs. LOCAL=1. This is for the lab builder.
2. **As an interactive teaching surface** — a Next.js UI at `:3000` hosts a series of **labs**. Each lab is a self-contained learning experience: a learner reads a guide, runs commands in in-browser consoles (PTY-over-WebSocket into each container), and clicks **Check ▸** widgets for per-step pass/fail. **Submit ✓** runs the full check suite and stamps the lab Passed. **This is what the hundreds of learners interact with.**

### Two audiences, very different needs

| | Lab builder (the user) | Learners (hundreds) |
|---|---|---|
| Surface | `make` targets, source code, host shell | Browser tab at `:3000` |
| What they want | Add new labs, debug failures, tweak content | Walk a guided path, see commands work, "ah-ha" moments |
| Failure cost | Annoyance — `make down && make warm` | Bad reputation, abandonment — they don't come back |

Every lab you ship is **content delivered to many users**. Typos, broken markdown links, checkpoints that pass when they shouldn't, exercise steps that produce a different output than promised, confusing diagrams, UI copy that says "Lab 1" when they're on Lab 3 — every one of these damages the learning experience for everyone after you. Hold the bar high.

## The lab journey (don't drift from this)

The labs form a deliberate sequence — each one builds on the previous lab's end state and advances one rung of the "what you'd actually do to stand up an AI training fabric" ladder:

| # | Title | Starting state | Ending state | Status |
|---|---|---|---|---|
| 1 | Build the BGP Underlay | Bare fabric (`_skeleton`) | Working CLOS underlay (`_canonical`) | shipped |
| 2 | Build the EVPN-VXLAN Overlay | Working underlay (`_canonical`) | Underlay + EVPN L2 segment leaf-to-leaf (`_overlay`) | shipped |
| 3 | GPUs on the Overlay + first AllReduce | `_overlay` | Workers on 192.168.100.0/24, real Gloo collective runs (`_overlay_workers`) | shipped |
| 4 | Telemetry & Visualization with gNMI + Grafana | `_overlay_workers` | Same fabric state — gnmic/Prom/Grafana stack live, dashboards fill during AllReduces. Procedural lab (no FRR config change) | shipped |
| 5 | Inject Failure During AllReduce | full overlay + AllReduce running, telemetry dashboards live | Survive a link cut mid-training, reconvergence visible in the chart | future |
| later | ECN/incast, multi-tenant overlays, NCCL/RDMA emulation | … | … | future |

**Before picking the next lab's scope, re-read the phase roadmap in `README.md` and `notes/decisions.md`.** The AI-DC story is BGP → EVPN-VXLAN → real GPU traffic → telemetry → failure scenarios. If you're tempted to make the next lab a side quest (NCCL emulation, telemetry alerting, etc.) when the previous lab didn't yet land its phase milestone, that's drift — confirm with the user first.

## Architecture: where the lab plumbing lives

The orchestrator and UI are **fully lab-id polymorphic** — every HTTP route and SQLite table is keyed by a `lab_id` string. Adding a lab does not touch HTTP routes, the database schema, or any UI component logic. It's pure metadata + content + checkpoint code.

- **`orchestrator/api/labs.json`** — the lab registry. Each entry has `id, title, summary, status, duration_min, checkpoint_count, previous_lab_id, next_lab_id, exercise_path, solution_path, overview_path, learning_objectives`. Flip `status: "coming-soon"` → `"active"` to surface a lab.
- **`orchestrator/api/labruns.py`** — dispatches per-lab. Two module-level attributes on each lab module:
  - `BOOTSTRAP_STATE` — name of the `configs/frr/<state>/` dir applied on Start/Reset (e.g. `"_skeleton"` for Lab 1, `"_canonical"` for Lab 2).
  - `SOLVE_STATE` — name of the dir applied on Solve (e.g. `"_canonical"` for Lab 1, `"_overlay"` for Lab 2).
- **`orchestrator/api/checkpoints/lab<N>.py`** — list-of-tuples registry `CHECKPOINTS: [(name, label, runner)]`. Each runner is a zero-arg callable returning `(passed: bool, summary: str, detail: str | None)`. Helpers come from `dockerlib.py` (`docker_exec`, `vtysh`).
- **`configs/frr/<state_name>/<sw>/frr.conf`** — the FRR config applied for that state. Existing states: `_skeleton` (blank), `_canonical` (working underlay), `_overlay` (underlay + EVPN-VXLAN), `_overlay_workers` (overlay + worker access ports). Lab 4 (telemetry) reuses `_overlay_workers` for both BOOTSTRAP and SOLVE — it's a procedural lab, no FRR delta.
- **`configs/frr/<state_name>/<sw>/overlay-setup.sh`** *(optional)* — kernel-side `ip link add` for bridges/VXLAN devs. Sourced by `bootstrap-switch.sh` if non-empty; an empty stub triggers teardown of overlay devs.
- **`configs/frr/<sw>/overlay-setup.sh`** — empty `+x` stub committed per switch as the bind-mount target. The orchestrator's `_apply_configs(state)` truncates and writes content into these.
- **`configs/frr/bootstrap-switch.sh`** — runs inside each switch container: brings up `eth1..eth4`, sources `overlay-setup.sh` if non-empty (or tears down stale overlay devs), restarts FRR daemons, runs `vtysh -b` to load frr.conf.
- **`topo/aidc.clab.yml`** — bind-mounts per switch include `frr.conf`, `bootstrap-switch.sh`, and `overlay-setup.sh`. New kernel-side script types would need a new bind here.
- **`docs/lab-guide/lab<N>-{overview,exercise,solution}.md`** — markdown content. Inline `<checkpoint name="..." label="..." />` widgets are parsed by `ui/components/GuidePane.tsx` into Check buttons.
- **Telemetry stack** *(Lab 4+, always-on)* — three extra containers in `topo/aidc.clab.yml`: `gnmic` (gNMI subscriber, port 9804 internal), `prometheus` (port 9090), `grafana` (port 3001). Configs live in `telemetry/{gnmic,prometheus,grafana}/`. Grafana auto-provisions the dashboard at `telemetry/grafana/dashboards/aidc-lab4-fabric.json` (UID `aidc-lab4`). Any lab can surface the dashboard by setting `"grafana_dashboard_path"` in its `labs.json` entry — the UI then renders a `<TelemetryPane>` iframe alongside the consoles. No per-lab-id branching needed.
- **`orchestrator/api/netdev_exporter.py`** + the `/metrics/netdev` route in `main.py` — Prometheus side-channel that exposes per-veth tx/rx byte counters from each switch by `docker exec`ing into them and reading `/proc/net/dev`. Exists because sonic-vs's OpenConfig doesn't see the clab veths (pitfall #14). Always-on, ~50ms per scrape, cached 3s.

## Runbook: add a new lab end-to-end

### Every new lab is FOUR deliverables, not one

A lab is not "the checkpoint code." It's a complete learning artifact. Don't ship a lab without all four:

1. **Checkpoints** (`orchestrator/api/checkpoints/lab<N>.py`) — the machine-graded steps. Without these, learners get no feedback.
2. **Exercise** (`docs/lab-guide/lab<N>-exercise.md`) — the guided walkthrough learners actually read. Without this, the lab is just a config file dump. Every step needs commands, expected output, and a "💡 Why this matters in AI DCs" callout that connects the technical step to the AI-fabric story.
3. **Solution** (`docs/lab-guide/lab<N>-solution.md`) — the answer key learners reach for when stuck. Includes a common-mistakes table — the 4-6 most likely things that break, in priority order, each with the silent failure mode and the fix. Without this, the only escape hatch for a stuck learner is to give up.
4. **UI review pass** — the workbench page already renders any active lab generically, but the orchestrator + frontend have copy strings, dialogs, and toasts that were written when only one lab existed. Walk the UI as a learner who's never seen the platform before and confirm every line of copy reads truthfully for the new lab. See the "UI review checklist" below.

If you ship 1 and 2 without 3 and 4, you've shipped a half-built lab. Hundreds of learners will land on the broken half.

### 0. Before you start — confirm with the user

- **Which lab am I adding?** Match it to the phase roadmap. If the user says "the next one" and the previous lab's phase milestone (e.g. overlay) is done, pick the next phase beat (e.g. workers on overlay + AllReduce). Don't pick a side quest.
- **Scope boundary**: if the new lab would require changes to `topo/aidc.clab.yml` beyond adding a bind-mount (e.g. a second worker↔leaf veth, new container), explicitly ask — that's a wider blast radius.
- **Solve semantics**: if the lab is procedural (no config to type — e.g. "inject this failure"), confirm what "Solve" should do. Default is "restore baseline."

### 1. Read these to ground yourself in the current state

Don't trust memory; the architecture may have evolved:

- `README.md` (phase roadmap)
- `orchestrator/api/labs.json` (lab registry shape)
- `orchestrator/api/labruns.py` (dispatch, `_apply_configs`)
- `orchestrator/api/checkpoints/lab1.py` and `lab2.py` (canonical examples; copy structure from Lab 2 — it has both BOOTSTRAP_STATE and SOLVE_STATE)
- `orchestrator/api/dockerlib.py` (helpers checkpoints use)
- `configs/frr/bootstrap-switch.sh` (what runs on Start/Reset/Solve)
- `notes/decisions.md` (ADRs that constrain what's possible — esp. ADR-008 on FRR 7.5)
- `docs/lab-guide/lab2-{overview,exercise,solution}.md` (the most recent style template)

### 2. Files to create

#### Checkpoint code

- `orchestrator/api/checkpoints/lab<N>.py` — pattern:
  - 6 checkpoints (matches Lab 1 + 2 cadence). First check = baseline of starting state; last check = full-mesh "submit finale."
  - Each runner returns `(passed, summary, detail)`. Use `docker_exec(container, cmd_list)` and `vtysh(container, "show ...")`.
  - `BOOTSTRAP_STATE = "<dir>"` and `SOLVE_STATE = "<dir>"` at module top.
  - Idempotent and tolerant of order — checks only inspect state, never mutate.

#### FRR configs for the new SOLVE_STATE

- `configs/frr/<new_state>/{spine1,spine2,leaf1,leaf2,leaf3,leaf4}/frr.conf` — 6 files. Start by copying from the previous state's dir and adding only the new lab's bits.

#### Optional kernel-side primitives

- `configs/frr/<new_state>/<sw>/overlay-setup.sh` — only if the lab requires kernel devs (bridges, VXLAN, dummies, etc.). `chmod +x` it. Make it idempotent (`ip addr replace`, `... 2>/dev/null || true`).

#### Markdown content (mirror Lab 2's structure)

- `docs/lab-guide/lab<N>-overview.md` — what you'll learn, teaching philosophy, prereqs, addressing scheme table, workflow loop, persistence note, where-to-go.
- `docs/lab-guide/lab<N>-exercise.md` — step-by-step walkthrough. Inline `<checkpoint name="..." label="..." />` widgets between steps. Every step needs a "💡 Why this matters in AI DCs" callout.
- `docs/lab-guide/lab<N>-solution.md` — copy-pasteable answer key, vtysh ↔ frr.conf mapping appendix, common-mistakes table (the 4 most likely things to break, in priority order — what's the silent failure mode?).

### 3. Files to edit

**Orchestrator + configs:**

- `orchestrator/api/labruns.py` — add the new lab to `_LAB_MODULES`. If the lab needs a brand-new kernel script type (beyond `overlay-setup.sh`), extend `_apply_configs` to handle it.
- `orchestrator/api/labs.json` — flip the lab's entry from `"coming-soon"` to `"active"`, fill in the metadata fields. Set `next_lab_id` to the following lab.
- `orchestrator/api/checkpoints/lab<N-1>.py` and earlier — if you added a new lab module attribute, ensure backward compatibility (the `getattr(..., default)` pattern in `labruns.py` handles missing attributes cleanly).
- `configs/frr/bootstrap-switch.sh` — only if the lab needs a new kernel-side script type beyond `overlay-setup.sh`.
- `topo/aidc.clab.yml` — only if you added a new bind-mount or a topology element.

**UI (touch every time you add a lab — see UI review checklist below for what to look at):**

- `ui/app/labs/[id]/page.tsx` — review `STATUS_MESSAGES`, action toasts, and `ConfirmDialog` bodies for lab-1-specific assumptions; generalize anything that no longer reads true.
- `ui/components/LabControlBar.tsx` — review button labels if the new lab's start/reset/solve semantics deviate.
- `ui/components/PassedScreen.tsx` — review completion copy + the `next_lab_id` CTA.
- (You should not need to touch `GuidePane.tsx`, `CheckpointButton.tsx`, `CheckResultsCard.tsx`, `LabsIndex.tsx`, or `ui/lib/api.ts` — these are fully lab-id-generic. If you find yourself wanting to, prefer adding lab-level metadata in `labs.json` over hardcoding branches.)

**Top-level docs:**

- `README.md` — labs index sentence (which labs are active), follow-up CTA sentence in the "Learn by doing" section, phase roadmap arrow position.

### 4. UI review checklist (the deliverable that's easy to forget)

The UI is lab-id-generic *structurally* (routes, components, API calls all key off `lab_id`), but copy strings written for an earlier lab will read wrong for a new one. Walk through this as a learner who's never seen the platform:

#### Labs index (`/`)

- Card title, summary, and learning objectives reflect the new lab — these come from `labs.json`, so confirm the JSON is right.
- Card shows green "Available" badge (status = "active"), not "Coming soon."
- Duration estimate (`duration_min`) matches reality — time yourself walking it.

#### Lab workbench (`/labs/<N>`)

Read every visible string and ask "does this read truthfully for the new lab?":

- **`ui/app/labs/[id]/page.tsx`** — `STATUS_MESSAGES` (top of file): the start/reset/solve/submit banner copy. If you find anything that's correct only for one specific lab ("Wiping configs", "56-ping mesh", "configuring spine1"), generalize it to lab-agnostic wording.
- **`onStart` / `onReset` / `onSolve` toasts**: same review — generic wording, not lab-specific assumptions.
- **`ConfirmDialog`** for Reset and Solve: bodies describe the action in a way that's truthful regardless of which lab the learner is in.
- **`PassedScreen`**: confirm the lab name + completion CTA + link to `next_lab_id` all render right.
- **`LabControlBar`** button labels (Start, Reset, Solve, Submit): if a new lab has a fundamentally different semantic for one of these (rare — usually only if you scope a non-config-based lab), confirm the existing labels still read sensibly. If not, lift the label into `labs.json` per-lab metadata instead of hardcoding a branch.

#### Guide pane (`ui/components/GuidePane.tsx`)

- Markdown for the new lab renders — code blocks, tables, blockquote callouts (`>`), inline `<checkpoint name="..." label="..." />` widgets all show up correctly.
- All `[link text](path)` markdown links resolve — relative paths from `docs/lab-guide/` resolve to real files. Broken links are noisy in dev tools and embarrassing in production.
- "Reveal solution" toggle swaps to the solution markdown without errors.

#### Per-checkpoint behavior

For each `<checkpoint name="..." />` widget in the exercise markdown, click it before doing the corresponding step and confirm it returns *fail* (not error). Then do the step and confirm it returns *pass*. A checkpoint that passes against an unsolved lab is silently broken — learners will think they're done when they're not.

#### When in doubt, add NEW labs-level metadata rather than branching

If the new lab fundamentally changes a UI surface (button label, dialog copy, status message), prefer adding an optional field to `labs.json` (e.g. `start_dialog_body?: string`) and a `lab.start_dialog_body ?? <default>` fallback in the UI — rather than `if (lab.id === "3") ...`. The platform is meant to scale to many labs; per-lab branches accumulate into spaghetti.

### 5. Verification (end-to-end smoke test)

There's no pytest suite for checkpoints; manual smoke test is the truth:

```bash
# First time after touching topo/aidc.clab.yml or FRR config dirs — full redeploy:
make sync
make ORCHESTRATOR_IMAGE=aidc/orchestrator:latest build-orchestrator
make UI_IMAGE=aidc/ui:latest build-ui
make down
make ORCHESTRATOR_IMAGE=aidc/orchestrator:latest UI_IMAGE=aidc/ui:latest warm

# Iterating on JUST orchestrator code (lab<N>.py, labruns.py, labs.json):
make sync && make ORCHESTRATOR_IMAGE=aidc/orchestrator:latest redeploy-orchestrator

# Iterating on JUST UI code (anything under ui/):
make sync && make UI_IMAGE=aidc/ui:latest redeploy-ui
# Then HARD-REFRESH the browser (Cmd-Shift-R) — Next.js chunk filenames are content-hashed
# so the new bundle is at a new URL, but the browser cache may still serve the old <script> URL.

# LOCAL=1 mode (skip sync; prepend LOCAL=1):
make LOCAL=1 redeploy-orchestrator
make LOCAL=1 redeploy-ui
```

The `redeploy-*` targets rebuild the image AND recreate the container on it (other lab containers stay running). `docker restart <name>` would NOT pick up new code — restart keeps the same image attached.

Then in the browser at `http://<host>:3000`:

1. **Sanity-check the previous lab still works** — the labruns.py refactor touches a shared module; regress-test by clicking into Lab N-1, Start ▶, Solve, Submit ✓.
2. **Walk the new lab top to bottom** — Start ▶, verify each inline Check ▸ passes at its expected moment, then Submit ✓.
3. **Test Solve** — Reset to clean state, then Solve, then Submit ✓ — should pass all checks without typing anything.
4. **SQLite sanity** — `sqlite3 .aidc-orchestrator-data/aidc.db 'select session_id, lab_id, state from lab_runs;'` shows independent rows per lab.

## Pitfalls I've hit (don't repeat)

1. **Drifting from the phase roadmap.** First attempt at Lab 2 picked "link failure" instead of EVPN-VXLAN — looked like an obvious next beat but didn't advance the AI-DC story. Always cross-reference `README.md` phase roadmap before scoping.
2. **EVPN next-hop preservation on spines.** In a shared-AS-spine CLOS, the textbook concern is that the spine could rewrite EVPN next-hops to its own router-id, causing receiving leaves to VXLAN-tunnel to a non-VTEP. **FRR 7.5 in this image preserves L2VPN-EVPN next-hops on eBGP peers by default** (verified empirically — see ADR-002 update). **No working spine-side knob exists in this build** — both `neighbor X next-hop-unchanged` (FRR 8.x+ shorthand) and `neighbor X attribute-unchanged next-hop` (FRR 7.x form) are silently dropped at boot or fake-accepted interactively, with no trace in `show running-config`. Don't bother adding them to spine canonical configs in this image. On modern FRR 8.x+ deployments, add `neighbor LEAVES next-hop-unchanged` as defense-in-depth. **Always verify a config push landed:** `docker exec <sw> vtysh -c "show running-config" | grep <token>`.
3. **Lab-1-hardcoded UI copy.** `ui/app/labs/[id]/page.tsx` had Lab-1-specific strings ("Wiping FRR configs", "56-ping mesh", "start configuring spine1") — I generalized them. If you add anything UI-side that reads correctly only for one lab, generalize it now or it bites the next one.
4. **Orchestrator caches Python imports.** Code changes to `labruns.py` / `lab<N>.py` / labs.json require an orchestrator container rebuild + redeploy — `make sync` alone isn't enough. Use `make redeploy-orchestrator` (and `make redeploy-ui` if you touched the UI).
5. **VTEP loopbacks are pre-allocated for a reason.** `10.0.10.X/32` on each leaf's `lo` is already advertised by the canonical underlay — load-bearing for the overlay. Don't renumber loopbacks unless you have a very good reason; renumbering ripples through every BGP neighbor description and every checkpoint.
6. **`bootstrap-switch.sh` runs `set -e`.** Any failure in the script aborts. Idempotent guards (`2>/dev/null || true`, `ip addr replace` instead of `add`) are mandatory in `overlay-setup.sh` scripts. For SONiC `config` commands, prefer running a teardown sequence first (see existing `bootstrap-switch.sh` "always-teardown" block) over guarding every `config ... add` — clearer intent.
7. **Assuming "all SONiC CLI is broken" is wrong.** ADR-008's "config_db doesn't work" finding was BGP-specific (`BGP_GLOBALS*` tables). The VXLAN/VLAN/EVPN_NVO tables work fine through the SONiC CLI — see ADR-008.1. The original Lab 2 used raw `ip link add` because of this assumption; the redesign uses `config vxlan add` and is significantly cleaner. **Always test before assuming a SONiC CLI surface is broken.**
8. **`docker restart` does NOT pick up a new image.** It restarts the same container instance — same image, same baked-in code. If you `make build-ui` and then `docker restart ui`, the new image is on disk but the running container is still on the old one. Always use `make redeploy-ui` / `make redeploy-orchestrator` (which `rm -f` then `docker run` on the new image). Confirm with `docker inspect <name> --format '{{.Image}}'` vs `docker inspect <tag> --format '{{.Id}}'` — same hash = container is on the latest image.
9. **Browser caches Next.js chunks aggressively.** Next.js JS chunks have content-hashed filenames so a new build lives at a new URL — but the browser may still hold the previous HTML that referenced the old chunk URL. After any UI redeploy, **hard-refresh** (Cmd-Shift-R on Mac, Ctrl-F5 elsewhere) or you'll silently see the previous build. Symptom: `make redeploy-ui` succeeds, the new image is running, but the browser still shows the old layout.
10. **Route-specific chunks live deeper than top-level chunks.** When sanity-checking a UI build, don't just `grep` `/app/.next/static/chunks/*.js` for your new strings — App Router puts route code at `/app/.next/static/chunks/app/<route>/page-<hash>.js`. Use `grep -lR` to search the whole `.next/` tree.
11. **`vtysh -b` silently drops unknown commands.** FRR's boot-time config parser eats unknown tokens (typos, wrong-version syntax) without error. Lab 2's first canonical config had `neighbor LEAVES next-hop-unchanged` — that's FRR 8.x+ shorthand and was dropped at boot by FRR 7.5; no log entry, no error message, `show running-config` showed no line. The overlay still worked (FRR 7.5 preserves EVPN next-hops by default), masking the bug. **Always verify a config push landed:** `docker exec <sw> vtysh -c "show running-config" | grep <token-you-just-added>`. When introducing a new FRR command, test interactively first — `vtysh`'s `?`-completion lists the valid tokens for the current AF/context.
12. **SONiC `show vxlan remotevtep` quirk** (mostly historical, see ADR-011). In the **old `netreplica/docker-sonic-vs:latest`** (2022 image, retired 2026-05-26) the swssconfig pipeline didn't back-sync FRR's EVPN-learned remote VTEPs into APP_DB, so the command returned "Total count : 0" even when the overlay worked. In **modern `aidc/sonic-vs:202511`** (current image, FRR 10.4.1) it populates correctly. Lab 2's checkpoint code falls back from `show vxlan remotevtep` to `vtysh -c "show evpn vni <vni>"` so it works against both images — keep the fallback as long as the older image is a supported revert path.
13. **`show bgp summary` output format changed in FRR 10.4**: an extra trailing `Desc` column was added (showing the neighbor description). Any checkpoint that parses `parts[-1]` as the PfxRcd integer **breaks** on FRR 10.4 (last col becomes a string like "spine1"). Always parse the State/PfxRcd column at fixed offset 9 instead. ADR-011 captures the migration fix; the `dockerlib.count_established()` helper and the per-lab checkpoint files were updated. Future BGP-row parsers should never assume `parts[-1]` is anything but the description column.
14. **sonic-vs's OpenConfig surface does NOT see the clab veths.** Lab 4 ships gnmic for streaming telemetry — but the SONiC image's gNMI/OpenConfig surface only models the synthetic `Ethernet0/4/8/12` ports, not the `eth1..eth4` clab veths that actually carry fabric traffic. So `aidc_interfaces_*` series flow at zero for the links that matter. Lab 4 works around this with a **netdev exporter** inside the orchestrator (`orchestrator/api/netdev_exporter.py`) that `docker exec`s into each switch to read `/proc/net/dev` and exposes it as Prometheus metrics at `/metrics/netdev` (job `orchestrator-netdev`). Dashboards key off `aidc_netdev_tx_bytes_total{device, interface}`, not the gnmic-emitted OpenConfig names. On real hardware the side-channel goes away — keep this asymmetry in mind when porting work from this lab.
15. **`config feature state telemetry enabled` doesn't persist across the bind-mount path.** Per ADR-008, switch state lives in `frr.conf` bind-mounts and overlay-setup.sh, not in `config_db.json`. Enabling a SONiC feature is a runtime change that gets wiped on container recreate / `make warm`. Lab 4's `bootstrap_extra` / `solve_extra` re-enable it every time. Same pattern applies for any future lab that needs a runtime SONiC feature toggle — don't expect it to survive a Start/Reset cycle.
16. **Grafana dashboard provisioning runs once at boot.** If Grafana starts before gnmic has any data flowing, the dashboards open empty and stay empty until a manual refresh. Lab 4 fixes this with a one-line POST to `http://grafana:3000/api/admin/provisioning/dashboards/reload` after telemetry comes up. If you add a new dashboard or change one, the file-provider auto-reloads every 10s (set in `telemetry/grafana/provisioning/dashboards/dashboard-provider.yaml`), but the *first* learner to land on the lab still benefits from the explicit kick.
17. **3 new ports exposed by Lab 4** (`3001` Grafana, `9090` Prometheus — gnmic is internal-only). The lab-host firewall must allow these in addition to `3000` (UI) and `8000` (orchestrator). If the iframe loads "site can't be reached," the host's iptables / ufw is probably blocking `3001`.
18. **Linux's default multipath hash is L3-only, which breaks VXLAN per-flow ECMP.** `net.ipv4.fib_multipath_hash_policy=0` (the default) hashes only outer src+dst IP. For VXLAN, the outer IPs are the source and destination VTEP loopbacks — constant for any traffic between two given leaves. ECMP becomes per-VTEP-pair, not per-flow, and the dashboard shows a systematic pin (e.g. leaf1+leaf2 inbound all on spine1, leaf3+leaf4 all on spine2). Fix: `sysctl -w net.ipv4.fib_multipath_hash_policy=1` on every leaf — bootstrap-switch.sh sets this automatically now. Production AI DCs always do this; NCCL/Gloo collective performance assumes per-flow ECMP.

## SONiC CLI vs vtysh — which to use for what

| Configuration domain | Use | Why |
|---|---|---|
| BGP (any address family — IPv4 unicast, L2VPN-EVPN) | `vtysh` | `config bgp` is broken in this image's `BGP_GLOBALS*` tables (ADR-008) |
| VLAN / VLAN_INTERFACE / VXLAN / EVPN_NVO / VXLAN_TUNNEL_MAP | `config` (SONiC CLI) | `config vxlan`, `config vlan` work end-to-end; swssconfig programs kernel devs that FRR's `advertise-all-vni` discovers (ADR-008.1) |
| Interface IPs on physical ports (`Ethernet0` etc.) | `vtysh` | SONiC `INTERFACE` table has no effect because `Ethernet*` ports don't bridge to containerlab veths (ADR-008) |
| Interface IPs on `Vlan<N>` interfaces | `config interface ip add` | Vlan interfaces work via SONiC CLI (ADR-008.1) |

When adding a new lab, **prefer SONiC CLI first**; reach for vtysh or iproute2 only when you've confirmed the SONiC path is broken for that specific table.

## Coding conventions in this repo

- **No emojis in code or commit messages** unless explicitly authored by a human (the lab markdown uses 💡 callouts — that's the only exception).
- **Don't change `configs/sonic/<sw>/config_db.json`** — per ADR-008, those files are inert reference material; runtime config is in `configs/frr/<sw>/frr.conf`. If you find yourself wanting to edit them, you're working in the wrong layer.
- **Don't run `git push`** without an explicit user request.
- **Numbered `/31`s and shared-AS spines** are deliberate teaching choices (ADR-001, ADR-002). Don't "fix" them to unnumbered or per-spine ASNs.
- **Bind-mount paths are inode-sensitive** — when rewriting files the orchestrator uses `_write_inplace` in `labruns.py` to preserve inodes. Don't rename or recreate bind-mounted files.

## Quick commands cheat-sheet

```bash
# Iterate on UI changes (no clab redeploy needed — other lab containers stay up):
make sync && make UI_IMAGE=aidc/ui:latest redeploy-ui
# Then HARD-REFRESH the browser (Cmd-Shift-R)

# Iterate on orchestrator changes (same, no clab redeploy):
make sync && make ORCHESTRATOR_IMAGE=aidc/orchestrator:latest redeploy-orchestrator

# Full lab redeploy (needed only after topo/aidc.clab.yml or FRR config changes):
make sync && make ORCHESTRATOR_IMAGE=aidc/orchestrator:latest UI_IMAGE=aidc/ui:latest build-orchestrator build-ui down warm

# Check fabric health from the host:
make bgp-check     # show bgp summary on every switch
make ping-mesh     # 56-pair worker mesh
make lab-status    # quick "is everything green?"

# Per-switch shell:
make shell-leaf3
docker exec -it leaf3 vtysh -c "show bgp l2vpn evpn"
docker exec -it leaf3 bridge fdb show dev vxlan10100

# DB inspection:
sqlite3 .aidc-orchestrator-data/aidc.db 'select * from lab_runs;'
```
