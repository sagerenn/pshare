# syntax=docker/dockerfile:1
#
# pshare static-site image. pshare is a fully static Next.js export with no
# server, so the final image is just nginx serving the `out/` directory. The
# OpenList API key is a build-time NEXT_PUBLIC_* arg, inlined into the bundle.
#
# Multi-arch (amd64, arm64) is driven by buildx + QEMU in CI; this Dockerfile
# itself is arch-agnostic (no native modules — better-sqlite3 was removed).
# arm/v7 is excluded because Next.js ships no SWC binary for 32-bit armhf.

# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# Install deps with dev tooling (needed for the Next build only).
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Build-time config. The API key is baked into the static bundle; it is a
# low-privilege, scope-limited (fs.put/fs.get/fs.rm, no listing) key.
# All are optional except the base URL + key; defaults match src/lib/config.ts.
ARG NEXT_PUBLIC_OPENLIST_BASE_URL=""
ARG NEXT_PUBLIC_OPENLIST_API_KEY=""
ARG NEXT_PUBLIC_OPENLIST_MOUNT_PATH="/pshare"
ARG NEXT_PUBLIC_PSHARE_MAX_BYTES="104857600"
ARG NEXT_PUBLIC_PSHARE_DEFAULT_TTL="86400"
ARG NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL="1 day"

ENV NEXT_PUBLIC_OPENLIST_BASE_URL=$NEXT_PUBLIC_OPENLIST_BASE_URL \
    NEXT_PUBLIC_OPENLIST_API_KEY=$NEXT_PUBLIC_OPENLIST_API_KEY \
    NEXT_PUBLIC_OPENLIST_MOUNT_PATH=$NEXT_PUBLIC_OPENLIST_MOUNT_PATH \
    NEXT_PUBLIC_PSHARE_MAX_BYTES=$NEXT_PUBLIC_PSHARE_MAX_BYTES \
    NEXT_PUBLIC_PSHARE_DEFAULT_TTL=$NEXT_PUBLIC_PSHARE_DEFAULT_TTL \
    NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL=$NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL

COPY . .
RUN npm run build

# ---- runtime stage ----
FROM nginx:alpine AS runtime
# Static export lands in /app/out; serve it from nginx's html root.
COPY --from=build /app/out /usr/share/nginx/html
# SPA-style fallback so /s/<id> deep links resolve to index.html, plus
# correct MIME for the web manifest and service worker.
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
