# AI Data Center Lab

A virtual AI Data Center fabric you can run on a laptop. Built to learn — and demonstrate — hyperscale networking concepts (CLOS, EVPN-VXLAN, congestion control, telemetry) under realistic AI training traffic.

> **Quick references:** [Lab topology](docs/topology.md) · [Switch CLI cheat sheet](docs/switch-cli-reference.md) · [Phase 1 demo](scenarios/00-bring-up-fabric.md)

```
              spine1            spine2          AS 65000 (shared)
             /  |  \  \        /  /  |  \
         leaf1 leaf2 leaf3 leaf4                AS 65101..65104
          /\    /\    /\    /\
        gpu1 2 3 4  5 6  7 8                    PyTorch+Gloo workers (arm64)
```

- **2 spine** + **4 leaf** SONiC switches (`netreplica/docker-sonic-vs`, amd64 via Rosetta)
- **8 "GPU" worker nodes** running real CPU-based collective ops (PyTorch + Gloo)
- **EVPN-VXLAN overlay** stretches all GPUs into one L2 segment (rail-optimized pattern)
- **gNMI → Prometheus → Grafana** telemetry stack (Phase 3)
- **Next.js + FastAPI** dashboard for live demos (Phase 4)

This lab is built in phases. You are looking at **Phase 1: bare fabric + BGP underlay**. See [scenarios/00-bring-up-fabric.md](scenarios/00-bring-up-fabric.md) for the demo.

---

## Requirements

| Need | Why |
|---|---|
| Apple Silicon Mac (M1/M2/M3/M4/M5) | Lab is sized for ~24 GB RAM, ARM host with Rosetta |
| [OrbStack](https://orbstack.dev) | Linux VM + container runtime. Faster than Docker Desktop, runs amd64 via Rosetta. |
| ~10 GB free disk inside the OrbStack VM | sonic-vs image + worker image + PCAPs |

## One-time setup

```bash
# 1. Install OrbStack from https://orbstack.dev, then create an Ubuntu VM for the lab.
orb create ubuntu aidc

# 2. Install containerlab inside that VM.
orb -m aidc bash -lc 'curl -sL https://containerlab.dev/setup | sudo -E bash -s "install-containerlab"'

# 3. Mount this repo into the VM (OrbStack auto-mounts your home dir to /Users/...).
#    Verify:
orb -m aidc bash -lc "ls '/Users/$USER/Documents/Coding/AIDC lab'"
```

## Getting started

From this directory on the Mac (the Makefile shells into the OrbStack VM for you):

```bash
make pull             # pre-pull sonic-vs (~270 MB) and build the worker image
make warm             # up + fabric-bootstrap + bgp-check + ping-mesh (~2 min cold)
make ping-mesh        # gpu1..gpu8 ping each other via underlay
make shell-leaf1      # drops you into a SONiC CLI on leaf1
make shell-gpu3       # drops you into a worker shell
make down             # tear it all down
```

### Web UI (Phase 2)

```bash
make ui-deps          # one-time: install backend pip deps + frontend pnpm deps
make ui               # start FastAPI (in VM, port 8000) + Next.js (Mac, port 3000)
open http://localhost:3000   # device list + click-to-console
make ui-smoke         # CLI smoke test: WebSocket → leaf1 → vtysh BGP query
make ui-stop          # stop both
```

The backend (`orchestrator/api/main.py`) runs **inside the OrbStack VM** because
that's where Docker lives — it can `docker exec -it <node> bash` with a real PTY
and proxies stdin/stdout over a WebSocket. The frontend (`ui/`, Next.js + xterm.js)
runs on the Mac and reaches the backend via OrbStack's automatic port forwarding
to `localhost:8000`.

## Repo layout

```
topo/          containerlab topology (aidc.clab.yml)
configs/       SONiC startup configs + (Phase 2) Jinja templates
workers/       worker image (arm64 native, torch CPU, iperf3, tcpdump)
automation/    Ansible/Nornir config push (Phase 2)
telemetry/     gNMIc + Prometheus + Grafana (Phase 3)
scenarios/     numbered demo scripts — start with 00-bring-up-fabric.md
orchestrator/  FastAPI backend (Phase 4)
ui/            Next.js dashboard (Phase 4)
docs/          blog posts mapping concepts to scenarios
notes/         ADR-lite decision records
```

## What this lab is honest about

- **PFC/ECN on sonic-vs is not real silicon.** The dataplane is the Linux kernel. We demo the *configuration workflow* on SONiC and the *behavior* via Linux qdiscs. Documented in [docs/](docs/) when relevant.
- **VXLAN encap is software.** Throughput is hundreds of Mbps, not 100 Gbps. Bandwidth is a relative signal in this lab, not an absolute one.
- **No real GPUs.** PyTorch runs on CPU via the Gloo backend. The collective ops are *real* (real AllReduce ring algorithm, real bytes on the wire); the matmuls are slow. This is fine — we are studying the network, not the math.

## Phase roadmap

- **Phase 1** — bare fabric, BGP underlay, ECMP ✓ done
- **Phase 2** — FastAPI + Next.js UI with **web console into every device** ← **you are here**
- **Phase 3** — EVPN-VXLAN overlay, first AllReduce, Ansible config push
- **Phase 4** — gNMI telemetry, Grafana dashboards, incast + ECN demos
- **Phase 5** — polished demo scenarios + all 9 blogs published

The UI was promoted to Phase 2 so that every subsequent feature (overlay,
collectives, telemetry) can be demoed visually from day one rather than only
through `make shell-*`. See [notes/decisions.md ADR-009](notes/decisions.md)
for the *why* behind this re-ordering.
