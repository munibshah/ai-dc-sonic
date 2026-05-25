# AIDC Lab — FastAPI orchestrator
#
# Runs as a container alongside the rest of the lab (deployed by containerlab).
# Talks to the host docker daemon via /var/run/docker.sock (bind-mounted in
# topo/aidc.clab.yml) so it can `docker exec -it spine1 bash` etc. into the
# other lab containers.
#
# The lab guide markdown lives in docs/lab-guide/*.md; that directory is
# bind-mounted at /repo/docs in the container so content edits don't require
# an image rebuild. AIDC_REPO_ROOT below points main.py at the mount.

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    AIDC_REPO_ROOT=/repo

# Install the docker CLI. The container talks to the host docker daemon via
# the bind-mounted socket, but it still needs the `docker` command on its
# PATH to issue `docker exec -it <name> bash` for the PTY console.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && chmod a+r /etc/apt/keyrings/docker.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
        https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Bake the api source (including labs.json) into the image. Only the markdown
# under docs/lab-guide/ is bind-mounted at runtime so content can be edited
# without rebuilding.
COPY api/ api/

EXPOSE 8000

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
