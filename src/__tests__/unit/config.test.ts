import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadBuildConfig,
  loadConfig,
  saveRuntimeConnection,
  clearRuntimeConnection,
  hasRuntimeConnection,
  readRuntimeConnection,
  resetConfig,
  isConfigured,
  withBasePath,
} from "@/lib/config";

/**
 * The config module layers two sources: build-time NEXT_PUBLIC_* env vars
 * (set to known values by setup.ts) and a runtime connection saved in
 * localStorage (stubbed in-memory by setup.ts). These tests pin the merge
 * semantics: saved values win, fall back cleanly, and never crash when
 * storage is corrupt or unavailable.
 */

// Temporarily remove the localStorage stub installed by setup.ts to simulate
// prerender/SSR (where `localStorage` does not exist) or a browser with
// storage disabled (where access throws).
function withoutLocalStorage<T>(fn: () => T): T {
  const saved = (globalThis as { localStorage?: Storage }).localStorage;
  delete (globalThis as { localStorage?: Storage }).localStorage;
  try {
    return fn();
  } finally {
    (globalThis as { localStorage?: Storage }).localStorage = saved;
  }
}

beforeEach(() => {
  localStorage.clear();
  resetConfig();
});

afterEach(() => {
  localStorage.clear();
  resetConfig();
});

describe("build-time config", () => {
  it("reads the NEXT_PUBLIC_* env values", () => {
    const cfg = loadBuildConfig();
    expect(cfg.openlistBaseUrl).toBe("http://ol.test");
    expect(cfg.openlistApiKey).toBe("test-secret-key");
    expect(cfg.openlistMountPath).toBe("/pshare");
    expect(cfg.defaultTtl).toBe(86400);
  });

  it("reports unconfigured when both env values are missing", () => {
    process.env.NEXT_PUBLIC_OPENLIST_BASE_URL = "";
    process.env.NEXT_PUBLIC_OPENLIST_API_KEY = "";
    resetConfig();
    expect(isConfigured()).toBe(false);
    // Restore the shared env for the rest of the file.
    process.env.NEXT_PUBLIC_OPENLIST_BASE_URL = "http://ol.test";
    process.env.NEXT_PUBLIC_OPENLIST_API_KEY = "test-secret-key";
    resetConfig();
  });
});

describe("base path (sub-path deployments)", () => {
  it("is empty and prefixes nothing by default", () => {
    expect(loadConfig().basePath).toBe("");
    expect(withBasePath("/s?id=abc&name=x.txt")).toBe("/s?id=abc&name=x.txt");
    expect(withBasePath("sw.js")).toBe("/sw.js");
  });

  it("prefixes site-relative paths when built with NEXT_PUBLIC_BASE_PATH", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/pshare";
    resetConfig();
    expect(loadConfig().basePath).toBe("/pshare");
    expect(withBasePath("/s?id=abc&name=x.txt")).toBe("/pshare/s?id=abc&name=x.txt");
    expect(withBasePath("/")).toBe("/pshare/");
    expect(withBasePath("sw.js")).toBe("/pshare/sw.js");
  });

  it("strips a trailing slash from the env value (one canonical form)", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/pshare/";
    resetConfig();
    expect(loadConfig().basePath).toBe("/pshare");
  });
});

describe("runtime connection (localStorage override)", () => {
  it("matches the build config when nothing is saved", () => {
    expect(hasRuntimeConnection()).toBe(false);
    expect(loadConfig()).toEqual(loadBuildConfig());
  });

  it("overrides the base URL and API key, keeping the rest of the build config", () => {
    saveRuntimeConnection("http://rt.example.com/", "rt-key");
    const cfg = loadConfig();
    expect(cfg.openlistBaseUrl).toBe("http://rt.example.com"); // trailing slash stripped
    expect(cfg.openlistApiKey).toBe("rt-key");
    expect(cfg.openlistMountPath).toBe("/pshare");
    expect(cfg.defaultTtlLabel).toBe("1 day");
    expect(hasRuntimeConnection()).toBe(true);
  });

  it("takes effect immediately after saving (cache is reset)", () => {
    expect(loadConfig().openlistBaseUrl).toBe("http://ol.test");
    saveRuntimeConnection("http://rt.example.com", "rt-key");
    expect(loadConfig().openlistBaseUrl).toBe("http://rt.example.com");
  });

  it("configures an otherwise-unconfigured bundle", () => {
    process.env.NEXT_PUBLIC_OPENLIST_BASE_URL = "";
    process.env.NEXT_PUBLIC_OPENLIST_API_KEY = "";
    resetConfig();
    expect(isConfigured()).toBe(false);
    saveRuntimeConnection("http://rt.example.com", "rt-key");
    expect(isConfigured()).toBe(true);
    process.env.NEXT_PUBLIC_OPENLIST_BASE_URL = "http://ol.test";
    process.env.NEXT_PUBLIC_OPENLIST_API_KEY = "test-secret-key";
    resetConfig();
  });

  it("clearing reverts to the build-time config", () => {
    saveRuntimeConnection("http://rt.example.com", "rt-key");
    clearRuntimeConnection();
    expect(hasRuntimeConnection()).toBe(false);
    expect(loadConfig()).toEqual(loadBuildConfig());
  });

  it("saving empty values removes the override instead of blanking the config", () => {
    saveRuntimeConnection("http://rt.example.com", "rt-key");
    expect(saveRuntimeConnection("", "  ")).toBe(true);
    expect(hasRuntimeConnection()).toBe(false);
    expect(loadConfig().openlistBaseUrl).toBe("http://ol.test");
  });
});

describe("robustness", () => {
  it("ignores corrupt storage and falls back to the build config", () => {
    localStorage.setItem("pshare.connection", "{not json");
    expect(hasRuntimeConnection()).toBe(false);
    expect(loadConfig()).toEqual(loadBuildConfig());
  });

  it("ignores a saved connection with a missing field", () => {
    localStorage.setItem(
      "pshare.connection",
      JSON.stringify({ openlistBaseUrl: "http://rt.example.com" }),
    );
    expect(readRuntimeConnection()).toBeNull();
    expect(loadConfig().openlistBaseUrl).toBe("http://ol.test");
  });

  it("reads nothing when localStorage is unavailable (prerender / SSR)", () => {
    saveRuntimeConnection("http://rt.example.com", "rt-key");
    expect(
      withoutLocalStorage(() => {
        resetConfig();
        return loadConfig().openlistBaseUrl;
      }),
    ).toBe("http://ol.test");
  });

  it("reports a failed save when storage throws", () => {
    expect(
      withoutLocalStorage(() => saveRuntimeConnection("http://rt.example.com", "rt-key")),
    ).toBe(false);
    // The build config still applies after the failed save.
    resetConfig();
    expect(loadConfig().openlistBaseUrl).toBe("http://ol.test");
  });

  it("clearing without storage available is a no-op, not a crash", () => {
    expect(() =>
      withoutLocalStorage(() => {
        clearRuntimeConnection();
        resetConfig();
        expect(loadConfig().openlistBaseUrl).toBe("http://ol.test");
      }),
    ).not.toThrow();
  });
});
