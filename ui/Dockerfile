# AIDC Lab — Next.js UI
#
# Runs as a container alongside the rest of the lab. Built in production mode:
#   - pnpm install + pnpm build happen at image-build time (multi-arch via buildx)
#   - runtime is just `pnpm start` (next start), no on-the-fly compilation
#
# Browser auto-resolves the FastAPI backend via window.location.hostname:8000
# (see ui/lib/api.ts). We deliberately DO NOT bake NEXT_PUBLIC_AIDC_API_BASE
# so the same image works regardless of the host's IP/hostname.

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

# Now copy the rest of the app and build.
COPY . .
RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "start"]
