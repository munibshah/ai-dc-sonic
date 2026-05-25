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

- **2 spine** + **4 leaf** SONiC switches (`netreplica/docker-sonic-vs`)
- **8 "GPU" worker nodes** running real CPU-based collective ops (PyTorch + Gloo)
- **EVPN-VXLAN overlay** stretches all GPUs into one L2 segment (rail-optimized pattern) — *Phase 3*
- **gNMI → Prometheus → Grafana** telemetry stack — *Phase 4*
- **Next.js + FastAPI** dashboard with in-browser device consoles and live topology view — *✓ shipped*

Built in phases. **Phase 1** (BGP underlay) and **Phase 2** (Web UI) are done. See [scenarios/00-bring-up-fabric.md](scenarios/00-bring-up-fabric.md) for the demo.

![phase](https://img.shields.io/badge/phase-2%20complete-2563eb) ![sonic](https://img.shields.io/badge/NOS-SONiC%20vs-7c3aed) ![next](https://img.shields.io/badge/UI-Next.js%2015-059669)

---

## Architecture

The lab runs on a **remote Linux host** (any Ubuntu/Debian box with Docker). Your laptop is just an editor + browser + `make` driver:

```
┌─────────────────────┐         SSH         ┌─────────────────────────────┐
│  Your laptop        │ ──────────────────► │  Remote Linux host          │
│  • git/$EDITOR      │                     │  • Docker + Containerlab    │
│  • `make sync`      │     rsync (push)    │  • 14 containers (the lab)  │
│  • `make warm`      │ ──────────────────► │  • FastAPI :8000            │
│  • browser → :3000  │ ──── HTTP/WS ─────► │  • Next.js  :3000           │
└─────────────────────┘                     └─────────────────────────────┘
```

Why a remote host? See [notes/decisions.md ADR-010](notes/decisions.md). TL;DR: amd64-native SONiC is much faster than running it under Rosetta on Apple Silicon, and a real Linux box has more RAM headroom for scaling out the fabric in later phases.

---

## Requirements

**On your laptop** (Mac or Linux):
- `ssh`, `rsync`, `make`, `curl`
- A modern browser

**On the remote host** (the box that runs the lab):
- Ubuntu 20.04+ (Debian-based; should also work on RHEL with minor tweaks)
- Docker (CE) installed and the lab user in the `docker` group
- ~16 GB RAM and ~10 GB free disk
- Reachable from your laptop on TCP 22 (SSH), 3000 (Next.js), 8000 (FastAPI)

The lab user does **not** need root sudo for day-to-day operation — just membership in `docker` and `clab_admins`. The one-time installer below is the only step that uses sudo.

---

## One-time setup

### 1. SSH key to the remote (so `make` doesn't prompt for a password)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''   # if you don't already have one
ssh-copy-id <user>@<remote-host>                   # uploads your pubkey
```

Then add an SSH alias to `~/.ssh/config` so the Makefile can find your host:

```ssh-config
Host aidc-remote
    HostName 192.168.1.26       # ← your remote's IP or DNS name
    User eveng                  # ← your remote user
    IdentityFile ~/.ssh/id_ed25519
```

### 2. Install Docker + containerlab on the remote

```bash
# On the remote, once:
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
bash -c "$(curl -sL https://get.containerlab.dev)"   # adds you to clab_admins
sudo apt-get install -y python3-venv python3-pip
sudo npm install -g pnpm@9                            # for the UI (Phase 2)
# Log out and back in so the group changes take effect.
```

### 3. Clone this repo on your laptop

```bash
git clone https://github.com/munibshah/ai-dc-sonic.git
cd ai-dc-sonic
```

### 4. (Optional) override the remote in the Makefile

If your SSH alias is **not** `aidc-remote` or your remote IP isn't `192.168.1.26`, pass them as env vars to every `make` command, or edit `Makefile`:

```bash
make REMOTE_HOST=mybox REMOTE_IP=10.0.0.5 warm
```

---

## Getting started

From the cloned repo on your laptop:

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

Successful `make warm` ends with all 56 worker-pair pings passing and BGP up on every switch.

### Web UI (Phase 2)

```bash
make ui-deps          # one-time: install FastAPI venv + Next.js node_modules on the remote
make ui               # start backend + frontend on the remote
open http://<remote-host>:3000   # labs index → click Lab 1 to enter the workbench
make ui-smoke         # headless WebSocket smoke test (no browser needed)
make ui-stop          # stop both
```

Both backend (`orchestrator/api/main.py`) and frontend (`ui/`, Next.js + xterm.js + react-markdown) run **on the remote**. The backend uses a real PTY (`docker exec -it`) and proxies stdio over a WebSocket. The frontend pages:

- **/** — **Labs index.** Cards for each lab (Lab 1 active; Labs 2–4 are placeholders for future content).
- **/labs/&lt;id&gt;** — **Lab workbench.** Free-scroll markdown guide on the left + tabbed terminal pane on the right + a "Topology" button that pops a clickable fabric diagram for picking which device to console into. Multiple terminals stay open across tab switches.
- **/topology** — Standalone topology view (hover a device to see its links' IPs; click for a single console).
- **/console/&lt;name&gt;** — Standalone single-device terminal.
- **/devices** — Flat device grid (the original home page).

---

## Repo layout

```
topo/          containerlab topology (aidc.clab.yml)
configs/
  frr/         per-switch FRR config (bind-mounted into sonic-vs at runtime)
  sonic/       SONiC config_db.json files (kept for reference — see ADR-008)
workers/       worker image (Linux + Python + PyTorch CPU + iperf3 + tcpdump)
automation/    Ansible/Nornir config push  (Phase 3)
telemetry/     gNMIc + Prometheus + Grafana (Phase 4)
scenarios/     numbered demo scripts — start with 00-bring-up-fabric.md
orchestrator/  FastAPI backend (devices API + WebSocket console PTY)
ui/            Next.js 15 dashboard
docs/          reference docs (topology, CLI cheat sheet) + blog posts
notes/         ADR-lite decision records
```

## What this lab is honest about

- **PFC/ECN on sonic-vs is not real silicon.** The dataplane is the Linux kernel. We demo the *configuration workflow* on SONiC and the *behavior* via Linux qdiscs.
- **VXLAN encap is software.** Throughput is hundreds of Mbps, not 100 Gbps. Bandwidth is a relative signal here, not an absolute one.
- **No real GPUs.** PyTorch runs on CPU via the Gloo backend. The collective ops are *real* (real AllReduce ring algorithm, real bytes on the wire); the matmuls are slow. We are studying the network, not the math.
- **SONiC's config_db path isn't fully wired.** The `netreplica/docker-sonic-vs` image we use (the only readily available SONiC VS image) is from 2021 and doesn't load the modern `BGP_GLOBALS` table layout. We bypass it and configure FRR directly via bind-mounted `frr.conf` files. The config_db.json files are kept as a reference for what the same fabric would look like under a modern SONiC build. See [ADR-008](notes/decisions.md).

## Learn by doing

The repo ships with a **hands-on lab guide** that wipes the switch configs and asks you to build the BGP underlay from scratch. Step-by-step solution included for when you get stuck.

```bash
make wipe         # blank the switch FRR configs (enter exercise mode)
$EDITOR configs/frr/leaf1/frr.conf   # …and the other 5 switches
make sync && make fabric-bootstrap   # apply your edits
make lab-status   # check progress (BGP established? all 56 pings OK?)
make solve        # restore working configs from git when done (or to skip ahead)
```

See [`docs/lab-guide/00-overview.md`](docs/lab-guide/00-overview.md) to start.

## Phase roadmap

- **Phase 1** — bare fabric, BGP underlay, ECMP ✓
- **Phase 2** — FastAPI + Next.js UI with web console + topology view ✓ ← **you are here**
- **Phase 3** — EVPN-VXLAN overlay, first AllReduce, Ansible config push
- **Phase 4** — gNMI telemetry, Grafana dashboards, incast + ECN demos
- **Phase 5** — polished demo scenarios + 9 blog posts

The UI was promoted to Phase 2 so every subsequent feature (overlay, collectives, telemetry) can be demoed visually rather than only through `make shell-*`. See [ADR-009](notes/decisions.md).

## Acknowledgements

- **SONiC** ([sonic-net](https://github.com/sonic-net)) — the network OS
- **Containerlab** ([srl-labs](https://github.com/srl-labs/containerlab)) — turns a YAML topology into a live multi-container lab
- **FRR** ([FRRouting](https://frrouting.org/)) — BGP / Zebra / staticd, what's actually running inside each sonic-vs container
- **PyTorch + Gloo** — real collective ops on CPU
