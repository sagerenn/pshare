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
  right viewer — text (with a Markdown preview/source toggle via
  react-markdown + remark-gfm), inline image, inline `<video>`/`<audio>` —
  or offers a download. Media that the browser can't decode falls back to a
  download card instead of a broken preview.
- **Expiry**: OpenList's TTL feature auto-deletes expired files via its
  background reaper. No pshare-side cleanup is needed.
- **Delete**: the share page offers a Delete button that calls
  `POST /api/fs/remove`.

The API key embedded in the bundle is **low-privilege**: scopes `fs.put`,
`fs.get`, `fs.rm` only, with listing disabled (`CanList=false`). It can only
create, read, and delete files under the mount path — exactly what a no-login
temporary sharing site needs.

## Configuring the connection

There are two ways to tell pshare where OpenList lives:

1. **At build time (recommended for public instances)** — bake the
   `NEXT_PUBLIC_*` vars below into the bundle. Every visitor gets a working
   site with no setup.
2. **At runtime, on the page** — any bundle (e.g. the prebuilt image built
   without secrets) can be pointed at an OpenList backend from the
   **OpenList connection** panel on the home page: enter the base URL and a
   scoped API key, optionally **Test connection** (a live `fs/get` probe on
   the mount path that reports unreachable URLs / rejected keys / missing
   mounts), and **Save**.
   The settings are stored in the browser's `localStorage` and take effect
   immediately — no rebuild, no reload. Saving is per-browser: each visitor
   who needs to *create* shares configures their own browser. **Clear saved
   settings** reverts to the build-time values.

Runtime values override the build-time ones when both exist.

### OpenList behind a reverse-proxy sub-path (Caddy / nginx / httpd …)

pshare fully supports an OpenList reachable under a URL prefix, e.g.
`https://example.com/openlist/` — enter the **public URL including the
prefix** as the OpenList URL (build time or connection panel). API calls
carry the prefix automatically, and the signed download URLs OpenList
returns are rebased onto the public URL, so previews, playback, and
downloads work: OpenList mints those URLs from its *own* origin (its
`site_url` or loopback address — e.g. `http://127.0.0.1:5244/p/…`), which a
visitor's browser could never reach, so pshare maps them onto the base URL
it just used successfully.

Both common proxy styles work:

- **Prefix-stripping** (Caddy `handle_path /openlist/*`, nginx
  `location /openlist/ { proxy_pass http://backend/; }` — note the trailing
  slash, httpd `ProxyPass /openlist/ http://backend/`): the proxy removes
  `/openlist` before forwarding. No OpenList setting is required.
- **Pass-through** (nginx `proxy_pass http://backend;` without a path):
  the prefix is forwarded untouched — configure OpenList's `site_url` with
  the same prefix (e.g. `-site-url /openlist`, or
  `https://example.com/openlist`) so it serves its routes under it.

Pre-signed URLs from storage drivers (S3/OSS/CDN links) are left untouched —
only OpenList's own `/p/` (web proxy) and `/d/` (direct) routes are rebased,
so `web_proxy: on` on the pshare mount is still recommended for inline media
preview.

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

All build-time config is inlined into the static bundle at build time (there
is no runtime server to read env from):

| Var | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_OPENLIST_BASE_URL` | — (see below) | OpenList backend URL |
| `NEXT_PUBLIC_OPENLIST_API_KEY` | — (see below) | Scoped non-admin API key |
| `NEXT_PUBLIC_OPENLIST_MOUNT_PATH` | `/pshare` | Where shares are stored in OpenList |
| `NEXT_PUBLIC_PSHARE_MAX_BYTES` | `104857600` (100 MiB) | Max upload size (client-side check) |
| `NEXT_PUBLIC_PSHARE_DEFAULT_TTL` | `86400` (1 day) | Default TTL label/value |
| `NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL` | `1 day` | Human label for the default TTL |
| `NEXT_PUBLIC_BASE_PATH` | — (root) | Sub-path the whole site is served under, no trailing slash (e.g. `/pshare`) |

The two connection vars are optional: build with them empty to ship an
unconfigured bundle that visitors point at their own OpenList via the
connection panel on the page (see *Configuring the connection* above).

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

  Build args are optional: with the base URL / API key left out, the image
  ships unconfigured and each visitor enters their OpenList URL + key on the
  page (saved in their browser).

- **GitHub Pages** — the `pages` workflow publishes the static export to
  `https://<owner>.github.io/pshare/` on every push to `main`. GitHub Pages
  serves a project repo under a sub-path, so the workflow builds with
  `NEXT_PUBLIC_BASE_PATH=/<repo>` (share links, service-worker paths, and
  manifest URLs follow automatically). Enable Pages once with
  **Settings → Pages → Source: GitHub Actions**; the `OPENLIST_*` secrets and
  `OPENLIST_*` variables are optional — without them the published site is
  unconfigured and visitors connect from the page.

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
    page.tsx                 home: create a share (text or file) → upload to OpenList;
                             includes the OpenList connection panel (runtime URL + API key)
    s/page.tsx               share view: fetch raw_url, render viewer (markdown
                             preview via react-markdown + remark-gfm, inline
                             image/video/audio), download, delete
    manifest.ts              PWA manifest, generated at build time (honors NEXT_PUBLIC_BASE_PATH)
    layout.tsx               PWA metadata, theme color, service-worker registration
    sw-register.tsx          client-side SW registration
  lib/
    config.ts                layered config: build-time NEXT_PUBLIC_* + runtime
                             connection saved in localStorage (overrides build-time);
                             base-path helpers for share links / SW paths
    openlist-client.ts       browser OpenList client (API key, upload, get, remove)
    share-utils.ts           type detection, id, sanitize, expiry presets
  __tests__/
    unit/                    vitest unit tests
    integration/             vitest integration tests (real binary)
    e2e/                     Playwright browser tests (real binary + static export)
    harness/                 shared boot harnesses (openlist-bin, next-app static server)
public/
  sw.js                      service worker (app-shell cache, base-path aware)
  icon-*.png                 PWA icons
scripts/provision-key.js     mint a scoped OpenList API key for the build
scripts/apply-base-path.js  post-build: prefix the manifest link with NEXT_PUBLIC_BASE_PATH
Dockerfile                   multi-arch nginx static-site image
nginx.conf                   SPA + .html fallback config
```
