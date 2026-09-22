# pshare

A public, **no-login** website for sharing temporary text, files, images,
video, and audio. Visitors paste text or pick a file, get a short share link,
and anyone with the link can view or download the content until it expires or
hits its download limit — then it's automatically deleted.

pshare is a thin Next.js app on top of [OpenList](../openlist) (the
`openlist-ext` binary in this repo's sibling directory). pshare authenticates
to a single OpenList instance server-side and proxies all file operations
through it; visitors never see or log in to OpenList.

## How it works

```
browser ──▶ pshare (Next.js) ──▶ OpenList HTTP API ──▶ Local driver (disk)
                │
                └─▶ SQLite (share metadata: id, path, type, expiry, counts)
```

- **Upload**: `POST /api/share` (JSON `{text}` or multipart `file`) → pshare
  streams the bytes to OpenList at `/pshare/<id>/<name>` via `PUT /api/fs/put`,
  writes a metadata row, returns `{id, url}`.
- **View**: `GET /api/share/<id>` → pshare fetches the file's signed
  `raw_url` from OpenList (`POST /api/fs/get`), increments the download
  counter, and returns it. The browser renders the right viewer (text, image,
  video, audio) or offers a download. The `raw_url` is a public, no-auth link.
- **Cleanup**: an in-process reaper starts automatically when the app boots
  and periodically finds shares whose expiry has passed or whose download
  count has hit the limit, deletes the file from OpenList
  (`POST /api/fs/remove`), and marks the share deleted. The first sweep runs
  after one interval, so startup is never blocked on cleanup. For split
  deployments (separate app + worker), a standalone reaper is also available
  via `npm run reaper`. Manual delete is available via
  `DELETE /api/share/<id>` (the share id is the only secret).

## Quick start

### 1. Build & run the OpenList backend

```bash
cd ../openlist
go build -o /tmp/openlist-ext .
OPENLIST_ADMIN_PASSWORD=admin ./openlist-ext -listen :5246 -data-dir ./data -db ./data/ext.db
```

Then in the OpenList admin panel (or via API), mount a **Local** driver at
`/pshare` rooted at some folder. pshare expects all shares to live under that
mount path.

### 2. Configure & run pshare

```bash
cp .env.example .env
# edit .env: point OPENLIST_BASE_URL at the backend, set credentials
npm install
npm run build
npm start
```

Open http://localhost:3000.

### Environment variables

See [`.env.example`](.env.example) for the full list. The essentials:

| Var | Default | Meaning |
|---|---|---|
| `OPENLIST_BASE_URL` | `http://127.0.0.1:5246` | OpenList backend URL |
| `OPENLIST_USERNAME` / `OPENLIST_PASSWORD` | `admin` / `admin` | Credentials pshare logs in with |
| `OPENLIST_MOUNT_PATH` | `/pshare` | Where shares are stored in OpenList |
| `PSHARE_DB` | `./data/pshare.db` | pshare metadata database |
| `PSHARE_MAX_BYTES` | `104857600` (100 MiB) | Max upload size |
| `PSHARE_DEFAULT_TTL` | `3600` (1h) | Default share lifetime (seconds) |

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/share` | `{text, ttl, maxDownloads}` or multipart `file` | `{id, url, type, name, size, expires_at, max_downloads}` |
| `GET` | `/api/share/<id>` | — | `{id, type, name, mime, size, download_url, ...}` or `404`/`410` |
| `DELETE` | `/api/share/<id>/delete` | — | `{ok: true}` |
| `GET` | `/api/health` | — | `{ok, backend}` |

## Tests

Three layers, all running against the **real** OpenList binary (no mocks in
integration/e2e):

```bash
# Unit (pure logic: type detection, store, reaper, client with mock fetch)
npm run test:unit           # 42 tests, ~1s

# Integration (boots real openlist-ext + real Next.js server, drives HTTP API)
npm run test:integration    # 12 tests, ~5s  (needs Go to build the binary once)

# End-to-end (boots real backend + app, drives a real browser with Playwright)
npm run test:e2e:install    # one-time: fetch chromium
npm run test:e2e            # 7 tests, ~10s
```

The integration and e2e harnesses (`src/__tests__/harness/`) build the
`openlist-ext` binary from `../openlist` on first run (cached at
`/tmp/openlist-ext`), boot it on a random port with an isolated temp data dir,
mount a Local storage at `/pshare`, and tear it all down afterward.

## Project layout

```
src/
  app/
    page.tsx                 home: create a share (text or file)
    s/[id]/page.tsx          share view: text/image/video/audio/file viewer
    api/
      share/route.ts         POST create share
      share/[id]/route.ts    GET share metadata + download url
      share/[id]/delete/     DELETE share
      health/route.ts        liveness + backend check
  lib/
    config.ts                env-based config
    openlist-client.ts       OpenList HTTP client (login, upload, list, get, remove)
    share-store.ts           SQLite metadata store
    share-utils.ts           type detection, id, expiry helpers
    reaper.ts                expiry/download-limit cleanup
    runtime.ts               shared singletons
  __tests__/
    unit/                    vitest unit tests
    integration/             vitest integration tests (real binary)
    e2e/                     Playwright browser tests (real binary + app)
    harness/                 shared boot harnesses
scripts/reaper.js            standalone reaper process
```
