import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenListClient } from "@/lib/openlist-client";

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

function fakeToken(expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url");
  return `${header}.${payload}.sig`;
}

const cfg = {
  openlistBaseUrl: "http://ol.test",
  openlistUsername: "admin",
  openlistPassword: "admin",
};

describe("OpenListClient.login + token", () => {
  it("logs in and caches the token", async () => {
    const token = fakeToken(Math.floor(Date.now() / 1000) + 3600);
    const fetchImpl = mockFetch({
      "/api/auth/login": () => ({ token }),
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await c.login();
    // A second token() call should NOT re-login (cached).
    await c.token();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-logs in when the cached token is near expiry", async () => {
    const expired = fakeToken(Math.floor(Date.now() / 1000) - 10);
    const fresh = fakeToken(Math.floor(Date.now() / 1000) + 3600);
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, message: "success", data: { token: calls === 1 ? expired : fresh } }),
      } as Response;
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await c.login();
    await c.token(); // expired -> re-login
    expect(calls).toBe(2);
  });

  it("throws on login failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 401, message: "bad password", data: null }),
    } as Response));
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(c.login()).rejects.toThrow(/login failed/);
  });

  it("re-logs in proactively when the token has no exp (expiresAt=0)", async () => {
    // A token whose JWT payload has no `exp` decodes to expiresAt=0. The
    // client must treat that as "unknown expiry, refresh" rather than
    // "never expires", so it re-logs in on the next token() call.
    const noExpToken = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ sub: "x" }),
    ).toString("base64url")}.sig`;
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, message: "success", data: { token: noExpToken } }),
      } as Response;
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await c.login();
    await c.token(); // expiresAt=0 -> should re-login
    expect(calls).toBe(2);
  });
});

describe("OpenListClient.list/get/remove", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  let c: OpenListClient;

  beforeEach(() => {
    const token = fakeToken(Math.floor(Date.now() / 1000) + 3600);
    fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/api/auth/login") {
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: { token } }) } as Response;
      }
      if (path === "/api/fs/list") {
        const body = JSON.parse(String(init?.body));
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: { content: [{ name: "a", size: 1, is_dir: false, modified: "x" }], total: 1 } }) } as Response;
      }
      if (path === "/api/fs/get") {
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: { name: "a", size: 1, is_dir: false, modified: "x", raw_url: "http://ol.test/p/a?sign=s" } }) } as Response;
      }
      if (path === "/api/fs/remove") {
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: null }) } as Response;
      }
      throw new Error(`unexpected ${path}`);
    });
    c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
  });

  it("lists a directory", async () => {
    const r = await c.list("/pshare");
    expect(r.total).toBe(1);
    expect(r.content[0].name).toBe("a");
  });

  it("gets a file info with raw_url", async () => {
    const info = await c.get("/pshare/a");
    expect(info.raw_url).toBe("http://ol.test/p/a?sign=s");
  });

  it("removes a file", async () => {
    await expect(c.remove("/pshare", ["a"])).resolves.toBeUndefined();
  });

  it("sends the Authorization header", async () => {
    await c.list("/pshare");
    const call = fetchImpl.mock.calls.find((args) => String(args[0]).includes("/api/fs/list"));
    expect((call![1] as RequestInit).headers).toMatchObject({ Authorization: expect.any(String) });
  });
});

describe("OpenListClient.upload", () => {
  it("PUTs to /api/fs/put with File-Path header", async () => {
    const token = fakeToken(Math.floor(Date.now() / 1000) + 3600);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/api/auth/login") {
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: { token } }) } as Response;
      }
      if (path === "/api/fs/put") {
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: null }) } as Response;
      }
      throw new Error(`unexpected ${path}`);
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await c.upload("/pshare/x/y.txt", "hello", 5);
    const call = fetchImpl.mock.calls.find((args) => String(args[0]).includes("/api/fs/put"));
    const headers = (call![1] as RequestInit).headers as Record<string, string>;
    expect(headers["File-Path"]).toBe(encodeURIComponent("/pshare/x/y.txt"));
    expect((call![1] as RequestInit).method).toBe("PUT");
  });

  it("retries once on 401", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/api/auth/login") {
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: { token: fakeToken(Math.floor(Date.now() / 1000) + 3600) } }) } as Response;
      }
      if (path === "/api/fs/list") {
        calls++;
        if (calls === 1) {
          return { ok: true, status: 200, json: async () => ({ code: 401, message: "token invalidated", data: null }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: { content: [], total: 0 } }) } as Response;
      }
      throw new Error(`unexpected ${path}`);
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    const r = await c.list("/pshare");
    expect(r.total).toBe(0);
    // login + first list(401) + re-login + retry list
    expect(fetchImpl.mock.calls.filter((a) => String(a[0]).includes("/api/auth/login"))).toHaveLength(2);
  });

  it("upload retries once on 401 then succeeds", async () => {
    let putCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/api/auth/login") {
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: { token: fakeToken(Math.floor(Date.now() / 1000) + 3600) } }) } as Response;
      }
      if (path === "/api/fs/put") {
        putCalls++;
        if (putCalls === 1) {
          return { ok: true, status: 200, json: async () => ({ code: 401, message: "token invalidated", data: null }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: null }) } as Response;
      }
      throw new Error(`unexpected ${path}`);
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(c.upload("/pshare/x/y.txt", "hello", 5)).resolves.toBeUndefined();
    expect(putCalls).toBe(2);
  });

  it("upload throws on a second 401 instead of recursing forever", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/api/auth/login") {
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success", data: { token: fakeToken(Math.floor(Date.now() / 1000) + 3600) } }) } as Response;
      }
      if (path === "/api/fs/put") {
        return { ok: true, status: 200, json: async () => ({ code: 401, message: "still bad", data: null }) } as Response;
      }
      throw new Error(`unexpected ${path}`);
    });
    const c = new OpenListClient(cfg, fetchImpl as unknown as typeof fetch);
    await expect(c.upload("/pshare/x/y.txt", "hello", 5)).rejects.toThrow(/auth failed after retry/);
    // Exactly two PUTs: the initial attempt + the single retry.
    const puts = fetchImpl.mock.calls.filter((a) => String(a[0]).includes("/api/fs/put"));
    expect(puts).toHaveLength(2);
  });
});
