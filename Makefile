# AI DC Lab — Makefile
#
# Targets execute on the REMOTE Ubuntu box (aidc-remote, 192.168.1.26) via SSH.
# The repo lives at $(REMOTE_REPO) on the remote; we rsync the Mac copy over
# whenever you `make sync`.  Native amd64, no Rosetta — much faster than the
# earlier OrbStack/M-series path.  See README.md and notes/decisions.md
# (ADR-010) for the move from OrbStack to remote.

# ---- remote target ---------------------------------------------------------
REMOTE_HOST  ?= aidc-remote
REMOTE_REPO  ?= /home/eveng/aidc-lab
REMOTE_IP    ?= 192.168.1.26
REMOTE_USER  ?= eveng

# Wrap a command to run on the remote in $(REMOTE_REPO).
SSH      := ssh $(REMOTE_HOST)
RUN      := $(SSH) "cd $(REMOTE_REPO) &&"

# ---- topology --------------------------------------------------------------
TOPO     := topo/aidc.clab.yml
LAB_NAME := aidc

WORKERS  := gpu1 gpu2 gpu3 gpu4 gpu5 gpu6 gpu7 gpu8
LEAVES   := leaf1 leaf2 leaf3 leaf4
SPINES   := spine1 spine2

# ---- help ------------------------------------------------------------------
.PHONY: help
help:
	@echo "AI DC Lab — runs on $(REMOTE_HOST) ($(REMOTE_IP))"
	@echo ""
	@echo "  ---- One-time setup ----"
	@echo "  make sync             rsync local repo -> $(REMOTE_HOST):$(REMOTE_REPO)"
	@echo "  make pull             pull sonic-vs image + build worker image (remote)"
	@echo "  make ui-deps          install backend pip + frontend pnpm deps (remote)"
	@echo ""
	@echo "  ---- Lab lifecycle ----"
	@echo "  make up               clab deploy (14 containers)"
	@echo "  make down             clab destroy --cleanup"
	@echo "  make reload           down + up"
	@echo "  make warm             up + bootstrap + bgp-check + ping-mesh"
	@echo "  make fabric-bootstrap (re)apply FRR config + restart bgpd on every switch"
	@echo ""
	@echo "  ---- Inspection ----"
	@echo "  make ping-mesh        pairwise ping across all gpu workers"
	@echo "  make bgp-check        'show bgp summary' on every switch"
	@echo "  make shell-<node>     exec into a container (e.g. make shell-leaf1)"
	@echo "  make ps               list running lab containers"
	@echo "  make ssh              open an interactive ssh session to $(REMOTE_HOST)"
	@echo ""
	@echo "  ---- UI (Phase 2) ----"
	@echo "  make ui               start FastAPI + Next.js (binds 0.0.0.0)"
	@echo "  make ui-stop          stop both"
	@echo "  make ui-logs          tail both logs"
	@echo "  make ui-smoke         CLI WebSocket end-to-end test"
	@echo "  open http://$(REMOTE_IP):3000  (Mac browser)"
	@echo ""
	@echo "  ---- Lab guide (docs/lab-guide/) ----"
	@echo "  make wipe             blank the switch FRR configs (enter exercise mode)"
	@echo "  make solve            restore working configs via 'git checkout' (exit exercise mode)"
	@echo "  make lab-status       quick \"am I done?\" summary"

# ---- sync ------------------------------------------------------------------
# Sync the local repo to the remote. Excludes generated artifacts.
.PHONY: sync
sync:
	@echo "rsync -> $(REMOTE_HOST):$(REMOTE_REPO)"
	@$(SSH) "mkdir -p $(REMOTE_REPO)"
	@rsync -az --delete \
	  --exclude='.git/' \
	  --exclude='ui/node_modules/' \
	  --exclude='ui/.next/' \
	  --exclude='orchestrator/.venv/' \
	  --exclude='*.pyc' --exclude='__pycache__/' \
	  --exclude='clab-*/' \
	  --exclude='.DS_Store' \
	  ./ $(REMOTE_HOST):$(REMOTE_REPO)/
	@echo "synced."

# ---- pull / build ----------------------------------------------------------
.PHONY: pull
pull:
	$(RUN) docker pull netreplica/docker-sonic-vs:latest
	$(MAKE) build-worker

.PHONY: build-worker
build-worker:
	# --network=host : on this remote, the default docker bridge can't egress
	# DNS/HTTP cleanly (Tailscale interferes with bridge NAT). Host networking
	# bypasses the issue during build. See notes/decisions.md ADR-010.
	$(SSH) "cd $(REMOTE_REPO)/workers && docker build --network=host -t aidc/worker:latest ."

# ---- lifecycle -------------------------------------------------------------
.PHONY: up
up:
	$(RUN) containerlab deploy -t $(TOPO)

.PHONY: down
down:
	$(RUN) containerlab destroy -t $(TOPO) --cleanup

.PHONY: reload
reload: down up

.PHONY: ps
ps:
	$(RUN) containerlab inspect -t $(TOPO)

# `make shell-leaf1` -> interactive shell in container `leaf1` on the remote
.PHONY: shell-%
shell-%:
	$(SSH) -t "docker exec -it $* bash || docker exec -it $* sh"

.PHONY: ssh
ssh:
	$(SSH)

# ---- bring-up: BGP + bootstrap + ping --------------------------------------
.PHONY: fabric-bootstrap
fabric-bootstrap:
	@for sw in $(SPINES) $(LEAVES); do \
	  echo "=== bootstrap $$sw ==="; \
	  $(SSH) "docker exec $$sw sh /usr/local/bin/bootstrap-switch.sh" || true; \
	done

.PHONY: bgp-check
bgp-check:
	@for sw in $(LEAVES) $(SPINES); do \
	  echo "=== $$sw ==="; \
	  $(SSH) "docker exec $$sw vtysh -c 'show bgp summary'" 2>&1 || true; \
	done

.PHONY: ping-mesh
ping-mesh:
	@echo "Pairwise ping across gpu workers (fabric /31 IPs)..."
	@for src in $(WORKERS); do \
	  for dst in $(WORKERS); do \
	    [ "$$src" = "$$dst" ] && continue; \
	    dst_ip=$$($(SSH) "docker exec $$dst ip -4 -o addr show eth1 | awk '{print \$$4}' | cut -d/ -f1" 2>/dev/null); \
	    [ -z "$$dst_ip" ] && echo "  $$src -> $$dst  (no IP on dst)" && continue; \
	    $(SSH) "docker exec $$src ping -c1 -W2 -q $$dst_ip" >/dev/null 2>&1 \
	      && echo "  $$src -> $$dst ($$dst_ip)  OK" \
	      || echo "  $$src -> $$dst ($$dst_ip)  FAIL"; \
	  done; \
	done

.PHONY: warm
warm: up
	@echo "Letting SONiC come up (30s)..."
	@sleep 30
	$(MAKE) fabric-bootstrap
	@echo "Waiting 30s for BGP to settle..."
	@sleep 30
	$(MAKE) bgp-check
	$(MAKE) ping-mesh

# ============================================================================
# UI (Phase 2)
#
# Backend (FastAPI) + Frontend (Next.js) both run on the remote so anything on
# the home network can reach them at http://$(REMOTE_IP):{8000,3000}.
# ============================================================================

UI_LOG_DIR  := /tmp/aidc-ui
UI_BACK_LOG := $(UI_LOG_DIR)/backend.log
UI_FRONT_LOG:= $(UI_LOG_DIR)/frontend.log
UI_BACK_PID := $(UI_LOG_DIR)/backend.pid
UI_FRONT_PID:= $(UI_LOG_DIR)/frontend.pid

.PHONY: ui-deps
ui-deps:
	$(SSH) "mkdir -p $(UI_LOG_DIR)"
	$(SSH) "cd $(REMOTE_REPO)/orchestrator && [ -d .venv ] || python3 -m venv .venv && .venv/bin/pip install --upgrade pip -q && .venv/bin/pip install -q -r requirements.txt"
	$(SSH) "cd $(REMOTE_REPO)/ui && pnpm install"

.PHONY: ui-backend
ui-backend:
	$(SSH) "mkdir -p $(UI_LOG_DIR)"
	@echo "Starting FastAPI backend on $(REMOTE_HOST):8000 ..."
	$(SSH) "cd $(REMOTE_REPO)/orchestrator && nohup .venv/bin/uvicorn api.main:app --host 0.0.0.0 --port 8000 --log-level info >$(UI_BACK_LOG) 2>&1 & echo \$$! >$(UI_BACK_PID); disown"
	@echo "  URL: http://$(REMOTE_IP):8000/api/health"

.PHONY: ui-frontend
ui-frontend:
	$(SSH) "mkdir -p $(UI_LOG_DIR)"
	@echo "Starting Next.js dev server on $(REMOTE_HOST):3000 ..."
	$(SSH) "cd $(REMOTE_REPO)/ui && NEXT_PUBLIC_AIDC_API_BASE='http://$(REMOTE_IP):8000' nohup pnpm dev >$(UI_FRONT_LOG) 2>&1 & echo \$$! >$(UI_FRONT_PID); disown"
	@echo "  URL: http://$(REMOTE_IP):3000"

.PHONY: ui
ui: ui-backend ui-frontend
	@echo ""
	@echo "AIDC Lab UI is starting up on $(REMOTE_HOST)."
	@echo "  Backend : http://$(REMOTE_IP):8000/api/devices"
	@echo "  Frontend: http://$(REMOTE_IP):3000"
	@echo ""
	@echo "Give Next.js ~10s to compile the first time, then open the URL in your browser."

.PHONY: ui-stop
ui-stop:
	@echo "Stopping UI processes on $(REMOTE_HOST) ..."
	-@$(SSH) "[ -f $(UI_BACK_PID) ]  && kill \$$(cat $(UI_BACK_PID))  2>/dev/null; true"
	-@$(SSH) "[ -f $(UI_FRONT_PID) ] && kill \$$(cat $(UI_FRONT_PID)) 2>/dev/null; true"
	# Belt-and-suspenders: pnpm forks a worker (`next-server`) that survives
	# killing the `pnpm dev` parent. Reap all related processes by name.
	-@$(SSH) "pkill -9 -f 'uvicorn api.main' 2>/dev/null; pkill -9 -f 'pnpm dev' 2>/dev/null; pkill -9 -f 'next-server' 2>/dev/null; pkill -9 -f 'next dev' 2>/dev/null; rm -f $(UI_BACK_PID) $(UI_FRONT_PID); true"

.PHONY: ui-logs
ui-logs:
	@echo "=== backend ===" ; $(SSH) "tail -n 20 $(UI_BACK_LOG)  2>/dev/null" || echo "no backend log yet"
	@echo "=== frontend ===" ; $(SSH) "tail -n 20 $(UI_FRONT_LOG) 2>/dev/null" || echo "no frontend log yet"

# End-to-end smoke: connects to the WebSocket console, runs a vtysh BGP query on leaf1.
.PHONY: ui-smoke
ui-smoke:
	$(SSH) "cd $(REMOTE_REPO)/orchestrator && .venv/bin/python tests/ws_smoke.py leaf1 \"vtysh -c 'show ip bgp summary' | head -8\""

# ============================================================================
# Lab guide (docs/lab-guide/) — exercise / solve / status
#
# `wipe`   blanks the 6 switch frr.conf files (copies from configs/frr/_skeleton/)
#          and re-applies, so the lab transitions to "no BGP anywhere" state.
# `solve`  reverts those files via `git checkout` and re-applies, returning to
#          the working state. Requires this to be a git checkout.
# ============================================================================

SWITCHES_FRR := spine1 spine2 leaf1 leaf2 leaf3 leaf4

.PHONY: wipe
wipe:
	@echo "Wiping switch FRR configs to skeleton (exercise mode)..."
	@for sw in $(SWITCHES_FRR); do \
	  cp configs/frr/_skeleton/$$sw/frr.conf configs/frr/$$sw/frr.conf; \
	  echo "  blanked configs/frr/$$sw/frr.conf"; \
	done
	$(MAKE) sync
	$(MAKE) fabric-bootstrap
	@echo ""
	@echo "Lab is now in EXERCISE mode."
	@echo "  - All BGP peers will go Active/down within ~10s."
	@echo "  - Read   docs/lab-guide/01-exercise.md  for the task."
	@echo "  - Hint   docs/lab-guide/02-solution.md  has the answer key."
	@echo "  - Reset  make solve"

.PHONY: solve
solve:
	@echo "Restoring switch FRR configs from git (working state)..."
	@for sw in $(SWITCHES_FRR); do \
	  git checkout configs/frr/$$sw/frr.conf 2>/dev/null \
	    && echo "  restored configs/frr/$$sw/frr.conf" \
	    || echo "  WARN: git checkout failed for $$sw — are you in a git checkout?"; \
	done
	$(MAKE) sync
	$(MAKE) fabric-bootstrap
	@echo ""
	@echo "Lab restored to WORKING state. Use 'make lab-status' to confirm."

# Concise "am I done?" — counts Established peers and OK pings.
.PHONY: lab-status
lab-status:
	@echo "== BGP =="
	@$(MAKE) bgp-check 2>&1 | grep -E "^Total number of neighbors|^Neighbor|^(10|spine|leaf)" | head -40 || true
	@echo ""
	@echo "== Ping mesh =="
	@$(MAKE) ping-mesh 2>&1 | grep -c "OK"  | xargs -I{} echo "  {} / 56 pings OK"
	@$(MAKE) ping-mesh 2>&1 | grep -c "FAIL" | xargs -I{} echo "  {} / 56 pings FAIL"
