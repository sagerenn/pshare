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
