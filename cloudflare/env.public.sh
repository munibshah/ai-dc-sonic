# Public (Cloudflare) deployment settings for the AIDC lab.
#
# Source this before any `make` redeploy so the UI bakes the right base URLs and
# the orchestrator gate is enabled:
#
#   source cloudflare/env.public.sh
#   make redeploy-ui            # UI baked for lab.munibshah.com
#   make redeploy-orchestrator  # gate enabled
#   # or the whole stack:  make warm
#
# The shared secret is read from the gitignored cloudflare/.orch-secret, so this
# file is safe to commit. Without sourcing this, `make warm` brings the stack up
# in the default single-user mode (gate OFF, UI host-relative) — handy for LOCAL.

# UI build: same-origin paths behind Cloudflare Access.
export NEXT_PUBLIC_AIDC_API_BASE=https://lab.munibshah.com
export NEXT_PUBLIC_BOOKING_API_BASE=https://lab.munibshah.com/booking-api

# Locally-built images (the redeploy targets rebuild these on the remote).
export UI_IMAGE=aidc/ui:latest
export ORCHESTRATOR_IMAGE=aidc/orchestrator:latest

# Booking gate: only the current slot holder can Start/Reset/Solve or console.
export AIDC_BOOKING_ENFORCE=1
export AIDC_BOOKING_URL=https://aidc-booking.munibshah.workers.dev
export AIDC_BOOKING_SECRET="$(cat "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/.orch-secret" 2>/dev/null)"
# HMAC secret for verifying the aidc_auth session cookie (== Worker AUTH_SIGNING_SECRET).
export AIDC_AUTH_SECRET="$(cat "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/.auth-secret" 2>/dev/null)"
