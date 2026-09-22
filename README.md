# pshare

A public, **no-login** website for sharing temporary text, files, images,
video, and audio. Visitors paste text or pick a file, get a short share link,
and anyone with the link can view or download the content until it expires —
then OpenList automatically deletes it.

pshare is a **fully static site** (a Next.js static export) with **no backend
of its own**. The browser talks directly to [OpenList](../openlist) using a
non-admin user's scope-limited API key. All server-side functions — storage,
signed download URLs, and per-file TTL expiry — live on OpenList.

## How it works

```
browser ──▶ OpenList HTTP API (scoped API key) ──▶ Local driver (disk)
  │
  └─ static bundle (nginx / any static host / edge / FaaS)
```

- **Upload**: the browser `PUT /api/fs/put`s the file to OpenList at
  `/pshare/<id>/<name>` with `Authorization: Bearer <key>`. A per-file TTL can
  be set via the `X-Ttl` header; if omitted, the OpenList user's default TTL
  applies. The share link is `/s?id=<id>&name=<name>`.
- **View**: the browser `POST /api/fs/get`s the file info, resolves the
  returned `raw_url` (a public, no-auth signed download link), and renders the
  right viewer (text, image, video, audio) or offers a download.
- **Expiry**: OpenList's TTL feature auto-deletes expired files via its
  background reaper. No pshare-side cleanup is needed.
- **Delete**: the share page offers a Delete button that calls
  `POST /api/fs/remove`.

The API key embedded in the bundle is **low-privilege**: scopes `fs.put`,
`fs.get`, `fs.rm` only, with listing disabled (`CanList=false`). It can only
create, read, and delete files under the mount path — exactly what a no-login
temporary sharing site needs.

## Quick start

### 1. Run the OpenList backend

```bash
cd ../openlist
go build -o /tmp/openlist-ext .
OPENLIST_ADMIN_PASSWORD=admin ./openlist-ext -listen :5246 -data-dir ./data -db ./data/ext.db
```

Mount a **Local** driver at `/pshare` rooted at some folder (via the admin
panel or API).

### 2. Provision a scoped API key

Use the helper to create a non-admin user with write+remove permissions,
disable listing, enable TTL, and mint a scoped API key:

```bash
node scripts/provision-key.js \
  --base http://127.0.0.1:5246 \
  --admin-token <admin-jwt-or-extension-token> \
  --username pshare \
  --password <choose-a-password> \
  --mount /pshare
```

It prints the `NEXT_PUBLIC_*` env vars to set at build time.

### 3. Build & serve the static site

```bash
NEXT_PUBLIC_OPENLIST_BASE_URL=http://127.0.0.1:5246 \
NEXT_PUBLIC_OPENLIST_API_KEY=<printed-key> \
NEXT_PUBLIC_OPENLIST_MOUNT_PATH=/pshare \
  npm run build
npm run serve     # serves out/ on :3000 (or use any static host / nginx / the Docker image)
```

Open http://localhost:3000.

### Build-time configuration

All config is inlined into the static bundle at build time (there is no
runtime server to read env from):

| Var | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_OPENLIST_BASE_URL` | — (required) | OpenList backend URL |
| `NEXT_PUBLIC_OPENLIST_API_KEY` | — (required) | Scoped non-admin API key |
| `NEXT_PUBLIC_OPENLIST_MOUNT_PATH` | `/pshare` | Where shares are stored in OpenList |
| `NEXT_PUBLIC_PSHARE_MAX_BYTES` | `104857600` (100 MiB) | Max upload size (client-side check) |
| `NEXT_PUBLIC_PSHARE_DEFAULT_TTL` | `86400` (1 day) | Default TTL label/value |
| `NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL` | `1 day` | Human label for the default TTL |

## Deploy

pshare is a static export (`out/`), so it runs anywhere:

- **Any static host / CDN / edge / FaaS** — upload the `out/` directory.
- **Docker (multi-arch)** — the included `Dockerfile` builds a slim nginx
  image serving `out/`. CI builds `linux/amd64`, `linux/arm64`, and
  `linux/arm/v7` and publishes to GHCR (`ghcr.io/<owner>/pshare`):

  ```bash
  docker build \
    --build-arg NEXT_PUBLIC_OPENLIST_BASE_URL=... \
    --build-arg NEXT_PUBLIC_OPENLIST_API_KEY=... \
    -t pshare .
  docker run -p 8080:80 pshare
  ```

- **PWA** — a web manifest, service worker, and icons are included, so the
  site is installable and works offline (the app shell caches; share content
  is always fetched live).

## Tests

Three layers, all running against the **real** OpenList binary (no mocks in
integration/e2e):

```bash
# Unit (pure logic: type detection, id, sanitize, client with mock fetch)
npm run test:unit

# Integration (boots real openlist-ext, provisions a scoped key, drives the client)
npm run test:integration    # needs Go to build the binary once

# End-to-end (boots real backend + serves the static export, drives a browser)
npm run test:e2e:install    # one-time: fetch chromium
npm run test:e2e
```

The integration and e2e harnesses (`src/__tests__/harness/`) build the
`openlist-ext` binary from `../openlist` on first run (cached at
`/tmp/openlist-ext`), boot it on a random port with an isolated temp data dir,
provision a non-admin user + scoped API key (CanList=false, TTL enabled),
build the static export with that key, and tear it all down afterward.

## Project layout

```
src/
  app/
    page.tsx                 home: create a share (text or file) → upload to OpenList
    s/page.tsx               share view: fetch raw_url, render viewer, download, delete
    layout.tsx               PWA manifest, theme color, service-worker registration
    sw-register.tsx          client-side SW registration
  lib/
    config.ts                build-time NEXT_PUBLIC_* config
    openlist-client.ts       browser OpenList client (API key, upload, get, remove)
    share-utils.ts           type detection, id, sanitize, expiry presets
  __tests__/
    unit/                    vitest unit tests
    integration/             vitest integration tests (real binary)
    e2e/                     Playwright browser tests (real binary + static export)
    harness/                 shared boot harnesses (openlist-bin, next-app static server)
public/
  manifest.webmanifest       PWA manifest
  sw.js                      service worker (app-shell cache)
  icon-*.png                 PWA icons
scripts/provision-key.js     mint a scoped OpenList API key for the build
Dockerfile                   multi-arch nginx static-site image
nginx.conf                   SPA + .html fallback config
```
