/**
 * Global test setup for unit tests. The static-site client reads config from
 * NEXT_PUBLIC_* env vars (inlined at build time in production, but read from
 * process.env in tests), so each test gets a known config. There is no DB and
 * no runtime — pshare is a static site.
 *
 * config.ts also reads the runtime connection (OpenList URL + API key) from
 * localStorage, which does not exist in vitest's node environment — so a
 * minimal in-memory stub is installed to keep that browser path testable.
 */
import { beforeEach } from "vitest";
import { resetConfig } from "@/lib/config";

function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}

const storage = makeLocalStorage();
(globalThis as { localStorage?: Storage }).localStorage = storage;

beforeEach(() => {
  // A known config for unit tests. The openlist-client unit tests inject their
  // own fetch, so the base URL / key here are just placeholders.
  process.env.NEXT_PUBLIC_OPENLIST_BASE_URL = "http://ol.test";
  process.env.NEXT_PUBLIC_OPENLIST_API_KEY = "test-secret-key";
  process.env.NEXT_PUBLIC_OPENLIST_MOUNT_PATH = "/pshare";
  process.env.NEXT_PUBLIC_PSHARE_MAX_BYTES = "104857600";
  process.env.NEXT_PUBLIC_PSHARE_DEFAULT_TTL = "86400";
  process.env.NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL = "1 day";
  resetConfig();
  storage.clear();
});
