# AI Data Center Lab

A virtual AI Data Center fabric you control from your laptop. Built to learn — and demonstrate — hyperscale networking (CLOS, EVPN-VXLAN, congestion control, telemetry) under realistic AI training traffic.

> **Quick references:** [Lab topology](docs/topology.md) · [Switch CLI cheat sheet](docs/switch-cli-reference.md) · [Phase 1 demo](scenarios/00-bring-up-fabric.md) · [**Lab guide — build the underlay yourself**](docs/lab-guide/00-overview.md) · **In-browser labs:** open `http://<remote>:3000` and click **Lab 1**.

```
              spine1            spine2          AS 65000 (shared)
             /  |  \  \        /  /  |  \
         leaf1 leaf2 leaf3 leaf4                AS 65101..65104
          /\    /\    /\    /\
        gpu1 2 3 4  5 6  7 8                    PyTorch+Gloo workers
```

- **2 spine** + **4 leaf** SONiC switches (`aidc/sonic-vs:202511`, built from the SONiC project's `202511` Azure CI release; FRR 10.4.1)
- **8 "GPU" worker nodes** running real CPU-based collective ops (PyTorch + Gloo)
- **EVPN-VXLAN overlay** stretches all GPUs into one L2 segment (rail-optimized pattern) — *Labs 2–3 ✓*
- **gNMI → Prometheus → Grafana** telemetry stack with live per-link Mbps charts during AllReduce — *Lab 4 ✓*
- **Next.js + FastAPI** dashboard with in-browser device consoles, live topology view, and embedded Grafana telemetry — *✓ shipped*

Built in phases. **Phase 1** (BGP underlay) and **Phase 2** (Web UI) are done. See [scenarios/00-bring-up-fabric.md](scenarios/00-bring-up-fabric.md) for the demo.

![phase](https://img.shields.io/badge/phase-2%20complete-2563eb) ![sonic](https://img.shields.io/badge/NOS-SONiC%20vs-7c3aed) ![next](https://img.shields.io/badge/UI-Next.js%2015-059669)

---

## Architecture

The lab runs on a **remote Linux host** (any Ubuntu/Debian box with Docker). Your laptop is just an editor + browser + `make` driver:

```
┌─────────────────────┐         SSH         ┌─────────────────────────────┐
│  Your laptop        │ ──────────────────► │  Remote Linux host          │
│  • git/$EDITOR      │                     │  • Docker + Containerlab    │
│  • `make sync`      │     rsync (push)    │  • 17 containers (the lab)  │
│  • `make warm`      │ ──────────────────► │  • FastAPI :8000            │
│  • browser → :3000  │ ──── HTTP/WS ─────► │  • Next.js  :3000           │
│                     │                     │  • Grafana  :3001 (Lab 4+)  │
│                     │                     │  • Prom     :9090 (Lab 4+)  │
└─────────────────────┘                     └─────────────────────────────┘
```

Why a remote host? See [notes/decisions.md ADR-010](notes/decisions.md). TL;DR: amd64-native SONiC is much faster than running it under Rosetta on Apple Silicon, and a real Linux box has more RAM headroom for scaling out the fabric in later phases.

---

## Two ways to run

The lab supports two topologies:

- **Remote box (default)** — you edit on a Mac/laptop, the lab containers + UI run on a separate Linux box, the laptop drives `make` over SSH. Best when you want your laptop to stay quiet and the lab to live on a dedicated machine.
- **Local (`LOCAL=1`)** — clone directly onto the Linux box that will run the lab and prepend `LOCAL=1` to every `make` command. No SSH, no rsync — every target runs directly on this box. Best when you don't have a separate dev laptop, or when you're running on a cloud VM and just SSH'ing in to use it.

Pick whichever fits your setup; everything below works the same way once you decide.

## Requirements

**On your laptop** (Mac or Linux) — only when using remote mode:
- `ssh`, `rsync`, `make`, `curl`
- A modern browser

**On the host that runs the lab** (the remote box, or your local box in `LOCAL=1`):
- Ubuntu 20.04+ (Debian-based; should also work on RHEL with minor tweaks)
- Docker (CE) installed and the lab user in the `docker` group
- ~16 GB RAM and ~10 GB free disk
- Network access for the UI ports (3000, 8000) — only needed if you want to browse to the lab from another machine

The lab user does **not** need root sudo for day-to-day operation — just membership in `docker` and `clab_admins`. The one-time installer below is the only step that uses sudo.

---

## One-time setup

### 1. Install Docker + containerlab on the lab host

```bash
# On the box that will run the lab (remote or local), once:

# (a) Prereqs the rest of this block assumes are present. A minimal Ubuntu
#     install doesn't ship with curl/git, and the installer scripts below
#     will fail silently without them.
sudo apt-get update
sudo apt-get install -y curl git ca-certificates

# (b) Docker. Distro-packaged docker.io is the most reliable path on Ubuntu;
#     use it unless you specifically need a newer Docker CE.
sudo apt-get install -y docker.io
sudo usermod -aG docker $USER
#     Alternative: official Docker CE from get.docker.com
#       curl -fsSL https://get.docker.com | sudo sh
#     Do NOT use 'snap install docker' — its sandboxing breaks containerlab's
#     veth + bind-mount setup.

# (c) Containerlab (uses curl + sudo; will add you to the clab_admins group):
bash -c "$(curl -sL https://get.containerlab.dev)"

# (Python and Node.js are no longer required on the host — the FastAPI
# orchestrator and Next.js UI ship as their own Docker images and are
# brought up by containerlab alongside the lab fabric.)

# Log out and back in (or `newgrp docker && newgrp clab_admins`) so the
# group changes take effect, then check:
docker ps                  # should print an empty table, not "permission denied"
containerlab version
```

### 2. Clone the repo

For **remote mode**, clone on your laptop:
```bash
git clone https://github.com/munibshah/ai-dc-sonic.git
cd ai-dc-sonic
```

For **`LOCAL=1` mode**, clone on the lab host itself:
```bash
ssh <user>@<lab-host>
git clone https://github.com/munibshah/ai-dc-sonic.git
cd ai-dc-sonic
```

### 3. (Remote mode only) SSH key + alias

Skip this for `LOCAL=1`.

```bash
# On your laptop:
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''   # if you don't already have one
ssh-copy-id <user>@<remote-host>                   # upload your pubkey
```

Then add an alias to `~/.ssh/config` so the Makefile can reach the host:

```ssh-config
Host aidc-remote
    HostName 192.168.1.26       # ← your remote's IP or DNS name
    User eveng                  # ← your remote user
    IdentityFile ~/.ssh/id_ed25519
```

If your alias isn't `aidc-remote` or your IP isn't `192.168.1.26`, override per-invocation:
```bash
make REMOTE_HOST=mybox REMOTE_IP=10.0.0.5 warm
```

---

## Getting started

### Remote mode (laptop → remote box)

```bash
make sync             # rsync the repo to the remote (do this whenever you edit a file)
make pull             # pull sonic-vs (~270 MB) and build the worker image on the remote
make warm             # bring up the fabric, run BGP bootstrap, ping-mesh check (~2 min)
make shell-leaf1      # interactive SONiC CLI on leaf1
make shell-gpu3       # shell into a worker
make bgp-check        # `show bgp summary` on every switch
make ping-mesh        # gpu1..gpu8 ping each other across the fabric
make down             # tear it all down
```

### Local mode (single box)

Prepend `LOCAL=1` to every `make` command — no SSH, no rsync:

```bash
make LOCAL=1 pull
make LOCAL=1 warm
make LOCAL=1 shell-leaf1
make LOCAL=1 ui                  # backend on :8000, frontend on :3000
make LOCAL=1 down
```

If you want to access the UI from another machine on the LAN, the Next.js dev server is already bound to `0.0.0.0` — just browse to `http://<this-box-ip>:3000`. The frontend auto-resolves the API base from the page's hostname in LOCAL mode, so no other env vars are needed.

Successful `warm` ends with all 56 worker-pair pings passing and BGP up on every switch.

### About the lab images

`make pull` brings down four images. None of them are built on the host by default; all are `docker pull`s from upstream / Hub:

| Image | What it is | Source |
|---|---|---|
| `aidc/sonic-vs:202511` | The SONiC NOS for the spine and leaf switches (built locally on the lab host from the official `docker-sonic-vs.gz` artifact on the SONiC `202511` Azure CI branch, FRR 10.4.1, ~1.75 GB). See ADR-011 for the upgrade rationale. | [sonic.software](https://sonic.software/) catalog → `docker-sonic-vs.gz` |
| `munibshah/aidc-worker:latest` | GPU-worker image (multi-arch amd64/arm64, ~1.5 GB) — Python + PyTorch CPU + Gloo + iperf3 + tcpdump | [workers/Dockerfile](workers/Dockerfile) |
| `munibshah/aidc-orchestrator:latest` | FastAPI backend that drives the in-browser device consoles (multi-arch, ~250 MB) | [orchestrator/Dockerfile](orchestrator/Dockerfile) |
| `munibshah/aidc-ui:latest` | Next.js UI in production mode (multi-arch, ~1.2 GB) | [ui/Dockerfile](ui/Dockerfile) |

To install the SONiC image on a fresh lab host:
```sh
URL=$(curl -s https://sonic.software/builds.json | jq -r '.["202511"]["docker-sonic-vs.gz"].url')
curl -sSL "$URL" -o /tmp/docker-sonic-vs-202511.gz
docker load < /tmp/docker-sonic-vs-202511.gz
docker tag docker-sonic-vs:latest aidc/sonic-vs:202511
```

The defaults are set in the Makefile (`WORKER_IMAGE`, `ORCHESTRATOR_IMAGE`, `UI_IMAGE`). Override per-invocation if you maintain your own fork:
```bash
make WORKER_IMAGE=otheruser/aidc-worker:v2 pull
```

If you're hacking on a Dockerfile and want to test your local changes against the lab, the build-* targets switch `make pull` into local-build mode for that component:
```bash
make ORCHESTRATOR_IMAGE=aidc/orchestrator:latest build-orchestrator
make ORCHESTRATOR_IMAGE=aidc/orchestrator:latest warm
```

Maintainer publish flow (admin only, runs from your Mac):
```bash
docker login
./scripts/publish-worker.sh        # munibshah/aidc-worker:latest
./scripts/publish-orchestrator.sh  # munibshah/aidc-orchestrator:latest
./scripts/publish-ui.sh            # munibshah/aidc-ui:latest
```

### Web UI (Phase 2)

The orchestrator and UI come up as containers alongside the rest of the lab — `make warm` (or just `make up`) brings up the full stack. Browse to `http://<remote>:3000` (or `http://localhost:3000` in `LOCAL=1` mode).

```bash
make logs-orchestrator   # tail FastAPI logs (docker logs orchestrator --tail 50)
make logs-ui             # tail Next.js logs
make shell-orchestrator  # interactive shell inside the FastAPI container
```

Both backend (`orchestrator/api/main.py`, [Dockerfile](orchestrator/Dockerfile)) and frontend (`ui/`, Next.js + xterm.js + react-markdown, [Dockerfile](ui/Dockerfile)) run as containers managed by containerlab. The backend mounts `/var/run/docker.sock` from the host so it can `docker exec -it` into the other lab containers; it streams stdio over a WebSocket to the browser. The frontend pages:

- **/** — **Labs index.** Cards for each lab (Labs 1–5 active; Lab 6 is a placeholder for future content).
- **/labs/&lt;id&gt;** — **Lab workbench.** Free-scroll markdown guide on the left + tabbed terminal pane on the right + a "Topology" button that pops a clickable fabric diagram for picking which device to console into. Multiple terminals stay open across tab switches.
- **/topology** — Standalone topology view (hover a device to see its links' IPs; click for a single console).
- **/console/&lt;name&gt;** — Standalone single-device terminal.
- **/devices** — Flat device grid (the original home page).

---

## Booking & public access (Cloudflare)

The lab is a **single shared fabric**, so concurrent learners can clobber each other's state. The booking layer turns it into a sellable product: a **public marketing site + lab guides**, **magic-link sign-in**, **bookable exclusive fabric slots** with **confirmation emails**, and a roster for instructor-led training — all on managed Cloudflare services (+ Resend) at near-zero cost.

```
Anyone ──HTTPS──▶ Cloudflare Tunnel ──▶ lab host
                    ├─ lab.<domain>      → UI         :3000   (public landing + /labs previews; /app/* gated)
                    │     /api,/ws        → orchestrator :8000  (reads only are public; mutating routes cookie-gated)
                    │     /booking-api/*  → booking Worker (Workers Route, at the edge)
                    └─ grafana.<domain>  → Grafana    :3001
Identity: magic-link email → signed `aidc_auth` cookie (the Worker is the auth authority — no per-seat cap)
Email:    Resend (transactional: sign-in links + booking/training confirmations with .ics)
```

- **Single hostname.** Everything lives under `lab.<domain>` so one sign-in covers the UI, the orchestrator API, and the Worker (same-origin cookie). No Cloudflare Access (removed — it caps at 50 users).
- **`booking/`** — the Worker: magic-link auth (`/auth/*`), slot reservations + training roster (`/api/*`), public teasers (`/public/*`), email via Resend. Deploy with `make deploy-booking`; schema with `make booking-schema`. See [booking/README.md](booking/README.md).
- **Identity** is the signed `aidc_auth` cookie. The orchestrator gate ([orchestrator/api/booking_gate.py](orchestrator/api/booking_gate.py) + [auth.py](orchestrator/api/auth.py)) HMAC-verifies it and lets only the **current slot holder** Start/Reset/Solve or open a console. Enable with these orchestrator env vars (all set by `source cloudflare/env.public.sh`):

  | Env | Meaning |
  |---|---|
  | `AIDC_BOOKING_ENFORCE=1` | enforce the gate (default off → single-user mode) |
  | `AIDC_BOOKING_URL` | Worker base URL for the holder check (`https://aidc-booking.<acct>.workers.dev`) |
  | `AIDC_BOOKING_SECRET` | shared secret == the Worker's `ORCH_SHARED_SECRET` |
  | `AIDC_AUTH_SECRET` | HMAC secret == the Worker's `AUTH_SIGNING_SECRET` (verifies the session cookie) |
  | `AIDC_BOOKING_FAIL_OPEN=1` | (optional) allow lab use if the booking service is unreachable |

- **Email (Resend):** verify your domain in Resend (add the DKIM/SPF DNS records to the Cloudflare zone), then `wrangler secret put RESEND_API_KEY` and set `FROM_EMAIL` in `booking/wrangler.jsonc`. Before that, magic-link URLs are printed to `wrangler tail` so sign-in still works.
- **Instructor ops** — set the next training and seed slots via the admin endpoints (as the `INSTRUCTOR_EMAIL`) or `wrangler d1 execute` (examples in [booking/README.md](booking/README.md)).
- **Paid-ready** — `slots.payment_status` exists (always `free` today); add Stripe later without schema churn.

---

## Repo layout

```
topo/          containerlab topology (aidc.clab.yml)
configs/
  frr/         per-switch FRR config (bind-mounted into sonic-vs at runtime)
  sonic/       SONiC config_db.json files (kept for reference — see ADR-008)
workers/       worker image (Linux + Python + PyTorch CPU + iperf3 + tcpdump)
automation/    Ansible/Nornir config push  (Phase 3)
telemetry/     gnmic + Prometheus + Grafana stack (Lab 4 — live dashboards during AllReduce)
scenarios/     numbered demo scripts — start with 00-bring-up-fabric.md
orchestrator/  FastAPI backend (devices API + WebSocket console PTY + booking gate)
ui/            Next.js 15 dashboard
booking/       Cloudflare Worker + D1 — slot reservations + training roster
cloudflare/    Cloudflare Tunnel ingress config (public HTTPS, no port-forwarding)
docs/          reference docs (topology, CLI cheat sheet) + blog posts
notes/         ADR-lite decision records
```

## What this lab is honest about

- **PFC/ECN on sonic-vs is not real silicon.** The dataplane is the Linux kernel. We demo the *configuration workflow* on SONiC and the *behavior* via Linux qdiscs.
- **VXLAN encap is software.** Throughput is hundreds of Mbps, not 100 Gbps. Bandwidth is a relative signal here, not an absolute one.
- **No real GPUs.** PyTorch runs on CPU via the Gloo backend. The collective ops are *real* (real AllReduce ring algorithm, real bytes on the wire); the matmuls are slow. We are studying the network, not the math.
- **We configure FRR directly via bind-mounted `frr.conf`** rather than driving it through SONiC's `config_db.json` → `bgpcfgd` pipeline. Modern SONiC (we run `aidc/sonic-vs:202511`, FRR 10.4.1) handles `BGP_GLOBALS*` correctly — see [ADR-011](notes/decisions.md) — but the bind-mount approach is portable across any FRR-based NOS and is the most direct interactive surface. The `configs/sonic/<sw>/config_db.json` files are kept as a reference for what the same fabric looks like under a stock SONiC build. See [ADR-008](notes/decisions.md) for the original rationale and [ADR-011](notes/decisions.md) for what the upgrade fixed.

## Learn by doing

Once `make warm` is up, **the lab is driven entirely from the browser.** Open `http://<host>:3000`, click **Lab 1 · Build the BGP Underlay**, then click **Start lab ▶**. The orchestrator wipes the switches to a bare-bones FRR config, you build the underlay through in-browser consoles, and inline **Check ▸** widgets give you per-step pass/fail. **Submit ✓** at the end runs the full check suite and stamps the lab Passed.

When you're done with Lab 1, click **Lab 2 · Build the EVPN-VXLAN Overlay** for the natural follow-up: stretch a single L2 segment (VNI 10100, subnet 192.168.100.0/24) across all four leaves on top of the underlay you just built, and watch a packet actually ride a VXLAN tunnel for the first time.

After Lab 2, **Lab 3 · GPUs on the Overlay + first AllReduce** brings the eight GPU workers onto that stretched L2 segment as VLAN 1000 access ports and runs a real Gloo AllReduce — first a 2-rank cross-leaf collective by hand, then the full 8-rank version. That's the rail-optimized AI pod pattern, end-to-end at lab scale.

Then **Lab 4 · Telemetry & Visualization with gNMI + Grafana** layers a streaming-telemetry pipeline (gnmic → Prometheus → Grafana) over your working fabric and embeds the dashboard directly in the workbench. You re-run the Lab 3 AllReduces and *watch the per-link Mbps fill in real time* — including ECMP load-spread across both spines. The first lab where you spend more time reading the chart than typing commands.

**Lab 5 · Super Spines — Beyond a Single-Pod CLOS** is a conceptual follow-on: walk the radix math that bounds a single pod (~1024 GPUs on 32-port silicon), see what shape a 3rd tier of BGP would take above your existing spines, and understand why hyperscalers schedule training jobs to live inside a pod when they can. Nothing new gets deployed — you inspect the fabric you already have to anchor each point. See [ADR-013](notes/decisions.md) for why this one's conceptual rather than a deploy lab.

Sessions persist server-side (SQLite, mounted at `./.aidc-orchestrator-data`), so you can close the browser, come back tomorrow, and pick up where you left off.

See [`docs/lab-guide/00-overview.md`](docs/lab-guide/00-overview.md) for the teaching guide.

### Operator / recovery commands (out-of-band)

Learners don't need these — they're the operator's recovery toolkit if the fabric itself is broken or you want to bring the lab up/down outside the UI.

```bash
make wipe         # blank the switch FRR configs (equivalent to clicking Start in the UI)
make solve        # apply canonical configs (equivalent to clicking Solve in the UI)
make lab-status   # BGP-established count + ping-mesh count
make fabric-bootstrap  # re-run the FRR bootstrap script on every switch
```

## Phase roadmap

- **Phase 1** — bare fabric, BGP underlay, ECMP ✓
- **Phase 2** — FastAPI + Next.js UI with web console + topology view ✓
- **Phase 3** — EVPN-VXLAN overlay (Lab 2 ✓), GPUs on the overlay + first AllReduce (Lab 3 ✓), Ansible config push
- **Phase 4** — gNMI streaming telemetry with embedded Grafana dashboards (Lab 4 ✓), super spines / multi-pod scale (Lab 5 ✓ conceptual), failure injection during AllReduce (Lab 6), incast + ECN demos ← **you are here**
- **Phase 5** — polished demo scenarios + 9 blog posts

The UI was promoted to Phase 2 so every subsequent feature (overlay, collectives, telemetry) can be demoed visually rather than only through `make shell-*`. See [ADR-009](notes/decisions.md).

## Acknowledgements

- **SONiC** ([sonic-net](https://github.com/sonic-net)) — the network OS
- **Containerlab** ([srl-labs](https://github.com/srl-labs/containerlab)) — turns a YAML topology into a live multi-container lab
- **FRR** ([FRRouting](https://frrouting.org/)) — BGP / Zebra / staticd, what's actually running inside each sonic-vs container
- **PyTorch + Gloo** — real collective ops on CPU
