import { describe, it, expect, vi } from "vitest";
import { OpenListClient, OpenListError } from "@/lib/openlist-client";

/**
 * A tiny mock fetch that records calls and returns scripted responses. We
 * build a fake OpenList server in-memory so the client is exercised without
 * any real network or binary.
 */
function mockFetch(handlers: Record<string, (url: string, init: RequestInit) => unknown>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(handlers).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${path}`);
    const data = handlers[key](path, init || {});
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 200, message: "success", data }),
    } as Response;
  });
}

const cfg = {
  openlistBaseUrl: "http://ol.test",
  openlistApiKey: "test-secret-key",
};

describe("OpenListClient auth", () => {
  it("sends the API key as a Bearer token on every request", async () => {
    const fetchImpl = mockFetch({
      "/api/fs/get": () => ({ name: "a", size: 1, is_dir: false, modified: "x", raw_url: "http://ol.test/p/a?sign=s" }),
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await c.get("/pshare/a");
    const call = fetchImpl.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${cfg.openlistApiKey}`);
  });

  it("strips trailing slashes from the base URL", async () => {
    const fetchImpl = mockFetch({
      "/api/fs/get": () => ({ name: "a", size: 1, is_dir: false, modified: "x", raw_url: "x" }),
    });
    const c = new OpenListClient({ openlistBaseUrl: "http://ol.test///", openlistApiKey: "k" }, fetchImpl as unknown as typeof fetch);
    await c.get("/pshare/a");
    expect(fetchImpl.mock.calls[0][0]).toBe("http://ol.test/api/fs/get");
  });
});

describe("OpenListClient.get/remove", () => {
  it("gets a file info with raw_url", async () => {
    const fetchImpl = mockFetch({
      "/api/fs/get": () => ({ name: "a", size: 1, is_dir: false, modified: "x", raw_url: "http://ol.test/p/a?sign=s" }),
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    const info = await c.get("/pshare/a");
    expect(info.raw_url).toBe("http://ol.test/p/a?sign=s");
    // body is JSON with the path
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({ path: "/pshare/a" });
  });

  it("gets the mount path (the connection-settings probe)", async () => {
    // The runtime settings UI validates a URL + key by calling get() on the
    // mount path: reachability, key validity, the fs.get scope, and the
    // mount's existence all get checked in one round-trip.
    const fetchImpl = mockFetch({
      "/api/fs/get": () => ({ name: "pshare", size: 0, is_dir: true, modified: "x", raw_url: "" }),
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(c.get("/pshare")).resolves.toMatchObject({ is_dir: true });
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe("http://ol.test/api/fs/get");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${cfg.openlistApiKey}`);
  });

  it("throws OpenListError(401) when the API key is rejected", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: 401, message: "token is invalidated", data: null }),
    } as Response));
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(c.get("/pshare")).rejects.toMatchObject({
      name: "OpenListError",
      code: 401,
      message: "token is invalidated",
    });
  });

  it("removes a file by dir + names", async () => {
    const fetchImpl = mockFetch({
      "/api/fs/remove": () => null,
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(c.remove("/pshare/x", ["a.txt"])).resolves.toBeUndefined();
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({ dir: "/pshare/x", names: ["a.txt"] });
  });

  it("throws OpenListError with the envelope code on failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 404, message: "object not found", data: null }),
    } as Response));
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(c.get("/pshare/missing")).rejects.toMatchObject({
      name: "OpenListError",
      code: 404,
      message: "object not found",
    });
  });
});

describe("OpenListClient.upload", () => {
  it("PUTs to /api/fs/put with URL-encoded File-Path header", async () => {
    const fetchImpl = mockFetch({ "/api/fs/put": () => null });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await c.upload("/pshare/x/y.txt", "hello", 5);
    const call = fetchImpl.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect((call[1] as RequestInit).method).toBe("PUT");
    expect(headers["File-Path"]).toBe(encodeURIComponent("/pshare/x/y.txt"));
    expect(headers["Authorization"]).toBe(`Bearer ${cfg.openlistApiKey}`);
    expect(headers["As-Task"]).toBe("false");
    expect(headers["Overwrite"]).toBe("true");
    expect(headers["Content-Length"]).toBe("5");
    // No X-Ttl when ttlSeconds <= 0.
    expect(headers["X-Ttl"]).toBeUndefined();
  });

  it("sends X-Ttl header when ttlSeconds > 0", async () => {
    const fetchImpl = mockFetch({ "/api/fs/put": () => null });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await c.upload("/pshare/x/y.txt", "hello", 5, 600);
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Ttl"]).toBe("600");
  });

  it("omits Content-Length when size is not provided", async () => {
    const fetchImpl = mockFetch({ "/api/fs/put": () => null });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await c.upload("/pshare/x/y.txt", "hello");
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Length"]).toBeUndefined();
  });

  it("throws OpenListError on a non-200 envelope", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 403, message: "forbidden", data: null }),
    } as Response));
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(c.upload("/pshare/x/y.txt", "hello", 5)).rejects.toBeInstanceOf(OpenListError);
  });

  it("throws on a non-JSON response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("not json");
      },
    } as unknown as Response));
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(c.get("/pshare/a")).rejects.toMatchObject({ code: 502 });
  });
});

/**
 * resolveRawUrl: mapping the raw_url OpenList returns onto a URL the
 * visitor's browser can fetch. The cases mirror real deployment shapes,
 * verified against a live OpenList behind prefix-stripping and pass-through
 * reverse proxies:
 *
 *  - root deployment: absolute raw_url at the same origin — untouched.
 *  - sub-path behind a strip-mode proxy (Caddy handle_path), site_url unset:
 *    raw_url is the BACKEND origin + /p/... → rebase onto the public base.
 *  - sub-path, site_url set to the backend path: raw_url carries backend
 *    origin + the path prefix → rebase onto the public base origin.
 *  - sub-path, site_url set to the full public URL: raw_url is already the
 *    public URL → untouched.
 *  - https public proxy in front of an http backend: raw_url is http://
 *    backend/p/... → rebased onto the https base (also fixes mixed content).
 *  - external pre-signed storage URL (S3/OSS) or CDN — untouched, whatever
 *    its origin or path.
 */
import { resolveRawUrl } from "@/lib/openlist-client";

describe("resolveRawUrl", () => {
  it("joins relative proxied paths onto the base (root or sub-path)", () => {
    expect(resolveRawUrl("http://ol.test", "/p/pshare/a/b.txt?sign=s")).toBe(
      "http://ol.test/p/pshare/a/b.txt?sign=s",
    );
    expect(resolveRawUrl("https://host.example/openlist", "/p/pshare/a/b.txt?sign=s")).toBe(
      "https://host.example/openlist/p/pshare/a/b.txt?sign=s",
    );
    expect(resolveRawUrl("http://ol.test/", "p/x")).toBe("http://ol.test/p/x");
  });

  it("passes through a root deployment's absolute raw_url unchanged", () => {
    expect(resolveRawUrl("http://ol.test", "http://ol.test/p/pshare/a/b.txt?sign=s")).toBe(
      "http://ol.test/p/pshare/a/b.txt?sign=s",
    );
  });

  it("passes through a fully-correct public absolute raw_url (site_url set)", () => {
    expect(
      resolveRawUrl(
        "https://host.example/openlist",
        "https://host.example/openlist/p/pshare/a/b.txt?sign=s",
      ),
    ).toBe("https://host.example/openlist/p/pshare/a/b.txt?sign=s");
  });

  it("rebases the backend origin onto the public base (strip-mode proxy, no site_url)", () => {
    // Caddy handle_path strips /openlist; OpenList emits its loopback origin.
    expect(
      resolveRawUrl(
        "http://127.0.0.1:5400/openlist",
        "http://127.0.0.1:5401/p/pshare/abcdefghij/hello.txt?sign=s",
      ),
    ).toBe("http://127.0.0.1:5400/openlist/p/pshare/abcdefghij/hello.txt?sign=s");
  });

  it("rebases backend origin + backend path prefix onto the public base (site_url set to the path)", () => {
    expect(
      resolveRawUrl(
        "http://127.0.0.1:5402/openlist",
        "http://127.0.0.1:5403/openlist/p/pshare/a/hello.txt?sign=s",
      ),
    ).toBe("http://127.0.0.1:5402/openlist/p/pshare/a/hello.txt?sign=s");
  });

  it("adds the sub-path prefix when the same-origin raw_url lacks it", () => {
    // site_url set to the bare public origin, missing the /openlist prefix.
    expect(
      resolveRawUrl(
        "https://host.example/openlist",
        "https://host.example/p/pshare/a/b.txt?sign=s",
      ),
    ).toBe("https://host.example/openlist/p/pshare/a/b.txt?sign=s");
    // Also for the /d direct-download route.
    expect(resolveRawUrl("https://host.example/openlist", "https://host.example/d/pshare/a")).toBe(
      "https://host.example/openlist/d/pshare/a",
    );
  });

  it("rebases an http backend raw_url onto an https base (proxy terminates TLS)", () => {
    expect(
      resolveRawUrl(
        "https://host.example/openlist",
        "http://127.0.0.1:5244/p/pshare/a/b.txt?sign=s",
      ),
    ).toBe("https://host.example/openlist/p/pshare/a/b.txt?sign=s");
  });

  it("leaves external pre-signed storage URLs untouched", () => {
    // S3-style path URL that happens to start with /p/ (bucket "p"): the
    // query has no bare `sign` param, so it is recognized as external.
    expect(
      resolveRawUrl("https://host.example/openlist", "https://s3.example.com/p/key?X-Amz-S=1"),
    ).toBe("https://s3.example.com/p/key?X-Amz-S=1");
    expect(
      resolveRawUrl("https://host.example/openlist", "https://cdn.example.net/files/a/b.bin"),
    ).toBe("https://cdn.example.net/files/a/b.bin");
    // Same-origin but not an OpenList download route (e.g. a CDN path on the
    // same host) — untouched rather than blindly prefixed.
    expect(resolveRawUrl("https://host.example/openlist", "https://host.example/other/x")).toBe(
      "https://host.example/other/x",
    );
  });

  it("rebases a parameterless OpenList /d route (sign not required)", () => {
    // enable_sign off → the direct route carries no query at all; it is
    // still an OpenList route and must go through the public base.
    expect(
      resolveRawUrl("https://host.example/openlist", "http://127.0.0.1:5244/d/pshare/a/b.bin"),
    ).toBe("https://host.example/openlist/d/pshare/a/b.bin");
  });

  it("handles malformed input without throwing", () => {
    // A garbage raw_url falls into the relative branch (joins onto the base);
    // an unparseable base falls back to the raw URL as-is.
    expect(resolveRawUrl("http://ol.test", "::::")).toBe("http://ol.test/::::");
    expect(resolveRawUrl("not a base", "http://ol.test/p/a")).toBe("http://ol.test/p/a");
  });
});
