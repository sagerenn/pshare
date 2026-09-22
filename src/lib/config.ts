/**
 * Runtime configuration read from environment variables. All values have
 * sensible defaults so the app can boot in development and tests without a
 * fully populated .env file.
 */
export type Config = {
  /** Base URL of the OpenList backend, e.g. http://127.0.0.1:5246 */
  openlistBaseUrl: string;
  /** OpenList username pshare authenticates as. */
  openlistUsername: string;
  /** OpenList password for the above user. */
  openlistPassword: string;
  /** Mount path inside OpenList where pshare stores shared files. */
  openlistMountPath: string;
  /** Local folder the OpenList Local driver is rooted at (harness use). */
  openlistLocalRoot: string;
  /** Path to the pshare SQLite metadata database. */
  dbPath: string;
  /** Default share lifetime in seconds. */
  defaultTtl: number;
  /** Max upload size in bytes. */
  maxBytes: number;
  /** Reaper run interval in milliseconds. */
  reaperIntervalMs: number;
};

/** Read a numeric env var with a fallback. */
function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Read a positive numeric env var, falling back if the value is missing or
 * non-positive. Used for settings like defaultTtl where 0/negative would
 * break downstream logic (computeExpiry throws on ttl <= 0).
 */
function positiveNum(key: string, fallback: number): number {
  const n = num(key, fallback);
  return n > 0 ? n : fallback;
}

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === "" ? fallback : raw;
}

let cached: Config | null = null;

/** Load (and cache) the config from the environment. */
export function loadConfig(): Config {
  if (cached) return cached;
  cached = {
    openlistBaseUrl: str("OPENLIST_BASE_URL", "http://127.0.0.1:5246"),
    openlistUsername: str("OPENLIST_USERNAME", "admin"),
    openlistPassword: str("OPENLIST_PASSWORD", "admin"),
    openlistMountPath: str("OPENLIST_MOUNT_PATH", "/pshare"),
    openlistLocalRoot: str("OPENLIST_LOCAL_ROOT", "./data/localroot"),
    dbPath: str("PSHARE_DB", "./data/pshare.db"),
    defaultTtl: positiveNum("PSHARE_DEFAULT_TTL", 3600),
    maxBytes: num("PSHARE_MAX_BYTES", 104857600),
    reaperIntervalMs: num("PSHARE_REAPER_INTERVAL_MS", 60000),
  };
  return cached;
}

/** Reset the cache. Used by tests to swap config between cases. */
export function resetConfig(): void {
  cached = null;
}
