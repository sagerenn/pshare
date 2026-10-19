/**
 * Browser-side configuration, layered from two sources:
 *
 * 1. Build-time: NEXT_PUBLIC_* env vars which Next.js inlines into the
 *    static bundle at build time. Because pshare is a static site with no
 *    server, every value must be known at build time — there is no runtime
 *    process to read env from.
 * 2. Runtime: an OpenList base URL + API key entered on the page (the
 *    connection settings on the home page) and persisted in the browser's
 *    localStorage. These override the build-time values, so a bundle built
 *    without secrets — e.g. the prebuilt image — can be pointed at any
 *    OpenList instance from the webpage, without a rebuild. The saved
 *    settings are per-browser; for an instance used by many visitors, bake
 *    the values in at build time instead.
 *
 * The OpenList API key is a non-admin user's key with scopes fs.put / fs.get
 * / fs.rm and CanList=false. It is intentionally embedded in the bundle: it
 * is low-privilege (no listing, no admin), scope-limited, and the only secret
 * the browser needs to create and read temporary shares.
 */
export type Config = {
  /** Base URL of the OpenList backend, e.g. https://ol.example.com */
  openlistBaseUrl: string;
  /** A non-admin user's API key (scopes fs.put/fs.get/fs.rm, no list). */
  openlistApiKey: string;
  /** Mount path inside OpenList where pshare stores shared files. */
  openlistMountPath: string;
  /** Max upload size in bytes (enforced client-side as a courtesy). */
  maxBytes: number;
  /** Default per-share TTL in seconds, sent as X-Ttl when the user picks it. */
  defaultTtl: number;
  /** Human label for the default TTL, shown in the UI. */
  defaultTtlLabel: string;
  /** Base path the site is served under ("" or e.g. "/pshare"). */
  basePath: string;
};

/** The runtime-configurable part of the connection, saved in localStorage. */
export type RuntimeConnection = {
  /** Base URL of the OpenList backend, e.g. https://ol.example.com */
  openlistBaseUrl: string;
  /** A non-admin user's API key (scopes fs.put/fs.get/fs.rm, no list). */
  openlistApiKey: string;
};

/** localStorage key holding the saved runtime connection. */
const STORAGE_KEY = "pshare.connection";

// NEXT_PUBLIC_* vars are inlined by Next.js at build time, but ONLY when
// referenced as literal `process.env.NEXT_PUBLIC_X` member access — a dynamic
// `process.env[key]` lookup is NOT replaced and resolves to undefined in the
// browser. So each value is read with a literal member access here. pshare is
// a static site with no runtime server, so every value must be known at build
// time.
function str(raw: string | undefined, fallback: string): string {
  return raw === undefined || raw === "" ? fallback : raw;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The build-time config from the inlined NEXT_PUBLIC_* env vars only — no
 * localStorage access, so it is safe during prerender and during the first
 * client render (which must match the prerendered HTML to hydrate cleanly).
 */
export function loadBuildConfig(): Config {
  return {
    openlistBaseUrl: str(process.env.NEXT_PUBLIC_OPENLIST_BASE_URL, "").replace(/\/+$/, ""),
    openlistApiKey: str(process.env.NEXT_PUBLIC_OPENLIST_API_KEY, ""),
    openlistMountPath: str(process.env.NEXT_PUBLIC_OPENLIST_MOUNT_PATH, "/pshare"),
    maxBytes: num(process.env.NEXT_PUBLIC_PSHARE_MAX_BYTES, 104857600),
    defaultTtl: num(process.env.NEXT_PUBLIC_PSHARE_DEFAULT_TTL, 86400),
    defaultTtlLabel: str(process.env.NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL, "1 day"),
    // Same value as next.config.js's basePath, inlined at build time.
    basePath: str(process.env.NEXT_PUBLIC_BASE_PATH, "").replace(/\/+$/, ""),
  };
}

/**
 * Read the connection saved in this browser at runtime, if any. Returns null
 * when storage is unavailable (prerender / SSR / private mode), the value is
 * corrupt, or either field is empty — an incomplete override is ignored so
 * the build-time values keep working.
 */
export function readRuntimeConnection(): RuntimeConnection | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RuntimeConnection>;
    const baseUrl =
      typeof parsed.openlistBaseUrl === "string" ? parsed.openlistBaseUrl.trim().replace(/\/+$/, "") : "";
    const key = typeof parsed.openlistApiKey === "string" ? parsed.openlistApiKey.trim() : "";
    if (!baseUrl || !key) return null;
    return { openlistBaseUrl: baseUrl, openlistApiKey: key };
  } catch {
    return null;
  }
}

/**
 * Save the OpenList connection for this browser, overriding the build-time
 * values. Takes effect immediately (the config cache is reset). Empty values
 * are treated as "no override" and remove any saved connection. Returns
 * false when localStorage is unavailable, so the UI can warn that the
 * settings will not persist.
 */
export function saveRuntimeConnection(baseUrl: string, apiKey: string): boolean {
  const clean: RuntimeConnection = {
    openlistBaseUrl: baseUrl.trim().replace(/\/+$/, ""),
    openlistApiKey: apiKey.trim(),
  };
  try {
    if (!clean.openlistBaseUrl || !clean.openlistApiKey) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    }
  } catch {
    return false;
  }
  resetConfig();
  return true;
}

/** Forget the connection saved in this browser, falling back to build-time config. */
export function clearRuntimeConnection(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing to clear; the build-time config applies.
  }
  resetConfig();
}

/** True when a connection has been saved in this browser at runtime. */
export function hasRuntimeConnection(): boolean {
  return readRuntimeConnection() !== null;
}

let cached: Config | null = null;

/**
 * Load (and cache) the effective config: the build-time values overridden by
 * any connection saved in this browser at runtime.
 */
export function loadConfig(): Config {
  if (cached) return cached;
  const build = loadBuildConfig();
  const runtime = readRuntimeConnection();
  cached = runtime ? { ...build, ...runtime } : build;
  return cached;
}

/** Reset the cache. Used by tests to swap config between cases. */
export function resetConfig(): void {
  cached = null;
}

/** True when the required OpenList connection settings are present. */
export function isConfigured(): boolean {
  const cfg = loadConfig();
  return cfg.openlistBaseUrl !== "" && cfg.openlistApiKey !== "";
}

/**
 * Prefix a site-relative path with the base path the bundle was built for.
 * withBasePath("/s?id=x") is "/s?id=x" at the root and "/pshare/s?id=x" under
 * a sub-path deployment (e.g. GitHub Pages). Path must start with "/".
 */
export function withBasePath(path: string): string {
  const base = loadConfig().basePath;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Build a shareable absolute URL for a site-relative path, e.g. the share link
 * shown on the home page. Uses the current page's origin, so it is correct on
 * any host the static bundle ends up on.
 */
export function siteUrl(path: string): string {
  return `${window.location.origin}${withBasePath(path)}`;
}

/**
 * True when this page is served over HTTPS but the OpenList base URL is plain
 * http://. Browsers block such cross-scheme fetches outright — "mixed active
 * content" — so the request never leaves the page and fetch rejects with a
 * generic TypeError, which otherwise looks exactly like "OpenList is down".
 * Callers use this to surface the real cause. Fix by serving OpenList over
 * HTTPS, serving this site over plain HTTP, or (per-browser) allowing
 * insecure content for the site.
 */
export function isMixedContent(base: string): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.location.protocol === "https:" && new URL(base).protocol === "http:";
  } catch {
    return false;
  }
}
