# AIDC Lab — Next.js UI
#
# Runs as a container alongside the rest of the lab. Built in production mode:
#   - pnpm install + pnpm build happen at image-build time (multi-arch via buildx)
#   - runtime is just `pnpm start` (next start), no on-the-fly compilation
#
# Browser auto-resolves the FastAPI backend via window.location.hostname:8000
# (see ui/lib/api.ts) when these are left empty — keeps the default image
# host-agnostic for direct-IP / LOCAL use.
#
# For a public single-hostname deployment behind Cloudflare (everything under
# lab.<domain>), pass these build args so the client calls same-origin paths:
#   --build-arg NEXT_PUBLIC_AIDC_API_BASE=https://lab.<domain>
#   --build-arg NEXT_PUBLIC_BOOKING_API_BASE=https://lab.<domain>/booking-api
# NEXT_PUBLIC_* must be present at BUILD time — Next.js inlines them into the
# client bundle; setting them at runtime has no effect.

FROM node:20-alpine

# Next.js requires the GNU libc compat shim on Alpine for some native deps.
RUN apk add --no-cache libc6-compat

# Pin pnpm to 9 — pnpm 10/11 hard-fail on the `sharp` ignored-build-script
# policy that's part of our Next.js dependency tree.
RUN npm install -g pnpm@9

WORKDIR /app

# Install deps first so this layer caches across source edits.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Public base URLs, baked into the client bundle at build time. Empty by
# default => the app falls back to host-relative resolution (see ui/lib/api.ts,
# ui/lib/booking.ts).
ARG NEXT_PUBLIC_AIDC_API_BASE=""
ARG NEXT_PUBLIC_AIDC_WS_BASE=""
ARG NEXT_PUBLIC_BOOKING_API_BASE=""
ENV NEXT_PUBLIC_AIDC_API_BASE=$NEXT_PUBLIC_AIDC_API_BASE \
    NEXT_PUBLIC_AIDC_WS_BASE=$NEXT_PUBLIC_AIDC_WS_BASE \
    NEXT_PUBLIC_BOOKING_API_BASE=$NEXT_PUBLIC_BOOKING_API_BASE

# Now copy the rest of the app and build.
COPY . .
RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "start"]
