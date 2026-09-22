/**
 * Global test setup for unit tests. The static-site client reads config from
 * NEXT_PUBLIC_* env vars (inlined at build time in production, but read from
 * process.env in tests), so each test gets a known config. There is no DB and
 * no runtime — pshare is a static site.
 */
import { beforeEach } from "vitest";
import { resetConfig } from "@/lib/config";

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
});
