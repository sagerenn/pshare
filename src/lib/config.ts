/**
 * Browser-side configuration, read from NEXT_PUBLIC_* env vars which Next.js
 * inlines into the static bundle at build time. Because pshare is a static
 * site with no server, every value must be known at build time — there is no
 * runtime process to read env from.
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
};

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

let cached: Config | null = null;

/** Load (and cache) the config from the build-time env. */
export function loadConfig(): Config {
  if (cached) return cached;
  cached = {
    openlistBaseUrl: str(process.env.NEXT_PUBLIC_OPENLIST_BASE_URL, "").replace(/\/+$/, ""),
    openlistApiKey: str(process.env.NEXT_PUBLIC_OPENLIST_API_KEY, ""),
    openlistMountPath: str(process.env.NEXT_PUBLIC_OPENLIST_MOUNT_PATH, "/pshare"),
    maxBytes: num(process.env.NEXT_PUBLIC_PSHARE_MAX_BYTES, 104857600),
    defaultTtl: num(process.env.NEXT_PUBLIC_PSHARE_DEFAULT_TTL, 86400),
    defaultTtlLabel: str(process.env.NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL, "1 day"),
  };
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
