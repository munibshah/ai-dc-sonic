# AI DC Lab — GPU worker image (multi-arch, CPU-only PyTorch)
#
# This container plays the role of a single "GPU node" in the fabric.
# The real workload is PyTorch with the Gloo collective backend, which gives
# us real AllReduce/Broadcast/Gather traffic over the network without needing
# an actual GPU.
#
# Builds for whatever platform the docker engine is on (amd64 on the remote
# Ubuntu box, arm64 on the M-series Mac).

FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        iputils-ping iproute2 tcpdump iperf3 ethtool curl \
        tmux openssh-server net-tools traceroute jq procps \
        ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch wheel for arm64. Gloo backend ships with torch.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch \
 && pip install numpy mpi4py-mpich \
 || pip install numpy

# OpenMPI runtime (for Phase 3 MPI demos)
RUN apt-get update && apt-get install -y --no-install-recommends \
        openmpi-bin libopenmpi-dev \
    && rm -rf /var/lib/apt/lists/*

# Allow ssh as root for orchestrator-driven exec (Phase 4)
RUN mkdir -p /var/run/sshd \
 && sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?Port .*/Port 2222/' /etc/ssh/sshd_config \
 && echo 'root:aidc' | chpasswd

COPY entrypoint.sh /entrypoint.sh
COPY scripts/ /opt/aidc/scripts/
RUN chmod +x /entrypoint.sh /opt/aidc/scripts/*.py 2>/dev/null || true

WORKDIR /opt/aidc
EXPOSE 2222 29500

ENTRYPOINT ["/entrypoint.sh"]
CMD ["tail", "-f", "/dev/null"]
