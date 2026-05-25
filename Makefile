# AI DC Lab — Makefile
#
# Two run modes:
#   1. Default (remote): targets execute on a REMOTE Ubuntu box via SSH. The
#      repo lives at $(REMOTE_REPO) on the remote; `make sync` rsyncs the
#      laptop copy over.  See notes/decisions.md (ADR-010) for the move
#      from OrbStack to a remote box.
#   2. `make LOCAL=1 <target>`: skip SSH and rsync entirely. Everything runs
#      on this machine; the repo path is auto-detected via $(CURDIR). Use
#      this when you've cloned the repo onto the same Linux box that will
#      run the lab (no separate dev laptop / remote host split).

LOCAL ?=

ifeq ($(LOCAL),1)
  # All commands run locally on this box.
  REMOTE_HOST ?= localhost
  REMOTE_IP   ?= 127.0.0.1
  REMOTE_REPO ?= $(CURDIR)
  SSH         := bash -c
  SSH_TTY     := bash -c
  RUN         := cd $(REMOTE_REPO) &&
else
  # Default: SSH into a remote Linux box and run things there.
  REMOTE_HOST ?= aidc-remote
  REMOTE_REPO ?= /home/aidc-sonic/ai-dc-sonic
  REMOTE_IP   ?= 192.168.1.29
  REMOTE_USER ?= aidc-sonic
  SSH         := ssh $(REMOTE_HOST)
  SSH_TTY     := ssh -t $(REMOTE_HOST)
  RUN         := $(SSH) "cd $(REMOTE_REPO) &&"
endif

# ---- topology --------------------------------------------------------------
TOPO     := topo/aidc.clab.yml
LAB_NAME := aidc

WORKERS  := gpu1 gpu2 gpu3 gpu4 gpu5 gpu6 gpu7 gpu8
LEAVES   := leaf1 leaf2 leaf3 leaf4
SPINES   := spine1 spine2

# Lab container images. All three default to pre-built multi-arch images on
# Docker Hub — `make pull` will docker-pull them, no local builds needed.
#
# Dockerfile developers can opt back into a local build by overriding the
# corresponding *_IMAGE var to its local-build tag (e.g. aidc/worker:latest),
# which flips `make pull` to use `make build-<component>` instead of pulling.
#
# Maintainers republish via the scripts/publish-*.sh helpers (multi-arch buildx).
WORKER_IMAGE       ?= munibshah/aidc-worker:latest
ORCHESTRATOR_IMAGE ?= munibshah/aidc-orchestrator:latest
UI_IMAGE           ?= munibshah/aidc-ui:latest

# All env vars containerlab needs to substitute into topo/aidc.clab.yml.
# Used as a prefix to every `containerlab ...` invocation.
CLAB_ENV := WORKER_IMAGE=$(WORKER_IMAGE) ORCHESTRATOR_IMAGE=$(ORCHESTRATOR_IMAGE) UI_IMAGE=$(UI_IMAGE)

# ---- help ------------------------------------------------------------------
.PHONY: help
help:
	@echo "AI DC Lab — runs on $(REMOTE_HOST) ($(REMOTE_IP))"
	@echo "  Mode: $(if $(filter 1,$(LOCAL)),LOCAL (no SSH; repo: $(REMOTE_REPO)),REMOTE via SSH (repo: $(REMOTE_HOST):$(REMOTE_REPO)))"
	@echo "  Tip:  prepend 'LOCAL=1' to run everything on this machine without SSH."
	@echo ""
	@echo "  ---- One-time setup ----"
	@echo "  make sync             rsync local repo -> $(REMOTE_HOST):$(REMOTE_REPO)"
	@echo "  make pull             pull all lab images (sonic-vs, worker, orchestrator, ui)"
	@echo ""
	@echo "  ---- Lab lifecycle ----"
	@echo "  make up               clab deploy (16 containers: 14 lab + orchestrator + ui)"
	@echo "  make down             clab destroy --cleanup"
	@echo "  make reload           down + up"
	@echo "  make warm             up + bootstrap + bgp-check + ping-mesh"
	@echo "  make fabric-bootstrap (re)apply FRR config + restart bgpd on every switch"
	@echo ""
	@echo "  ---- Inspection ----"
	@echo "  make ping-mesh         pairwise ping across all gpu workers"
	@echo "  make bgp-check         'show bgp summary' on every switch"
	@echo "  make shell-<node>      exec into a container (e.g. make shell-leaf1)"
	@echo "  make logs-orchestrator tail FastAPI backend logs"
	@echo "  make logs-ui           tail Next.js frontend logs"
	@echo "  make ps                list running lab containers"
	@echo "  make ssh               open an interactive ssh session to $(REMOTE_HOST)"
	@echo "  open http://$(REMOTE_IP):3000   labs index (browser)"
	@echo ""
	@echo "  ---- Lab guide (docs/lab-guide/) ----"
	@echo "  make wipe             blank the switch FRR configs (enter exercise mode)"
	@echo "  make solve            restore working configs via 'git show' (exit exercise mode)"
	@echo "  make lab-status       quick \"am I done?\" summary"

# ---- sync ------------------------------------------------------------------
# Sync the laptop repo to the remote. Excludes generated artifacts.
# In LOCAL=1 mode this is a no-op (the repo is already on the target machine).
.PHONY: sync
ifeq ($(LOCAL),1)
sync:
	@echo "sync: LOCAL=1, nothing to do (repo already at $(REMOTE_REPO))"
else
sync:
	@echo "rsync -> $(REMOTE_HOST):$(REMOTE_REPO)"
	@$(SSH) "mkdir -p $(REMOTE_REPO)"
	# --inplace: write to the same inode rather than rename(temp -> target).
	# Required because Docker bind-mounts files BY INODE — rename would leave
	# the container still attached to the old inode (= old content), even after
	# the host file is updated. With --inplace, the container sees the new
	# content immediately.
	@rsync -az --inplace --no-whole-file --delete \
	  --exclude='.git/' \
	  --exclude='ui/node_modules/' \
	  --exclude='ui/.next/' \
	  --exclude='orchestrator/.venv/' \
	  --exclude='*.pyc' --exclude='__pycache__/' \
	  --exclude='clab-*/' \
	  --exclude='.DS_Store' \
	  ./ $(REMOTE_HOST):$(REMOTE_REPO)/
	@echo "synced."
endif

# ---- pull / build ----------------------------------------------------------
# `make pull` brings the sonic-vs base image down, then for each of the three
# lab images either builds locally (if the *_IMAGE var is its local-build
# default) or pulls from the registry (if it's been overridden / left at the
# Hub default).
.PHONY: pull
pull:
	$(RUN) docker pull netreplica/docker-sonic-vs:latest
	@if [ "$(WORKER_IMAGE)" = "aidc/worker:latest" ]; then \
	  echo "WORKER_IMAGE=$(WORKER_IMAGE) — building locally."; \
	  $(MAKE) build-worker; \
	else \
	  echo "WORKER_IMAGE=$(WORKER_IMAGE) — pulling from registry."; \
	  $(RUN) docker pull $(WORKER_IMAGE); \
	fi
	@if [ "$(ORCHESTRATOR_IMAGE)" = "aidc/orchestrator:latest" ]; then \
	  echo "ORCHESTRATOR_IMAGE=$(ORCHESTRATOR_IMAGE) — building locally."; \
	  $(MAKE) build-orchestrator; \
	else \
	  echo "ORCHESTRATOR_IMAGE=$(ORCHESTRATOR_IMAGE) — pulling from registry."; \
	  $(RUN) docker pull $(ORCHESTRATOR_IMAGE); \
	fi
	@if [ "$(UI_IMAGE)" = "aidc/ui:latest" ]; then \
	  echo "UI_IMAGE=$(UI_IMAGE) — building locally."; \
	  $(MAKE) build-ui; \
	else \
	  echo "UI_IMAGE=$(UI_IMAGE) — pulling from registry."; \
	  $(RUN) docker pull $(UI_IMAGE); \
	fi

.PHONY: build-worker
build-worker:
	# --network=host : on this remote, the default docker bridge can't egress
	# DNS/HTTP cleanly (Tailscale interferes with bridge NAT). Host networking
	# bypasses the issue during build. See notes/decisions.md ADR-010.
	$(SSH) "cd $(REMOTE_REPO)/workers && docker build --network=host -t $(WORKER_IMAGE) ."

.PHONY: build-orchestrator
build-orchestrator:
	$(SSH) "cd $(REMOTE_REPO)/orchestrator && docker build --network=host -t $(ORCHESTRATOR_IMAGE) ."

.PHONY: build-ui
build-ui:
	$(SSH) "cd $(REMOTE_REPO)/ui && docker build --network=host -t $(UI_IMAGE) ."

# ---- lifecycle -------------------------------------------------------------
# All *_IMAGE vars are exported via $(CLAB_ENV) so the topology YAML's
# ${WORKER_IMAGE} / ${ORCHESTRATOR_IMAGE} / ${UI_IMAGE} substitutions resolve.
.PHONY: up
up:
	$(RUN) $(CLAB_ENV) containerlab deploy -t $(TOPO)

.PHONY: down
down:
	$(RUN) $(CLAB_ENV) containerlab destroy -t $(TOPO) --cleanup

.PHONY: reload
reload: down up

.PHONY: ps
ps:
	$(RUN) containerlab inspect -t $(TOPO)

# `make shell-leaf1` -> interactive shell in container `leaf1`.
.PHONY: shell-%
shell-%:
	$(SSH_TTY) "docker exec -it $* bash || docker exec -it $* sh"

# Interactive SSH into the remote box. No-op in LOCAL=1 (you're already on it).
.PHONY: ssh
ifeq ($(LOCAL),1)
ssh:
	@echo "ssh: LOCAL=1, you're already on the lab host."
else
ssh:
	$(SSH)
endif

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
# Orchestrator (FastAPI :8000) and UI (Next.js :3000) run as containers
# deployed by containerlab alongside the lab fabric. `make up` brings them up
# along with everything else.
# ============================================================================

.PHONY: logs-orchestrator
logs-orchestrator:
	$(SSH) "docker logs --tail 50 orchestrator 2>&1"

.PHONY: logs-ui
logs-ui:
	$(SSH) "docker logs --tail 50 ui 2>&1"

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
	# Write via `git show HEAD:path > path` rather than `git checkout path` so the
	# target file is truncated in place — preserves its inode. Docker bind mounts
	# track files by inode; a rename-based checkout would leave the running
	# container attached to the old (orphaned) inode and never see the new content.
	@for sw in $(SWITCHES_FRR); do \
	  git show HEAD:configs/frr/$$sw/frr.conf > configs/frr/$$sw/frr.conf 2>/dev/null \
	    && echo "  restored configs/frr/$$sw/frr.conf" \
	    || echo "  WARN: git show failed for $$sw — are you in a git checkout?"; \
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
