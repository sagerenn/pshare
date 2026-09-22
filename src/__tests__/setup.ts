/**
 * Global test setup. Points pshare at an isolated temp data dir so unit
 * tests that touch the DB never clobber a real one.
 */
import { beforeEach, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetConfig } from "@/lib/config";
import { resetRuntime } from "@/lib/runtime";
import { resetDbHandle } from "@/lib/share-store";

const tmp = mkdtempSync(path.join(tmpdir(), "pshare-test-"));

beforeEach(() => {
  // Each test gets a fresh config pointing at the shared temp dir. DB files
  // are per-test (created in openDb) so tests stay isolated.
  process.env.PSHARE_DB = path.join(tmp, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.OPENLIST_BASE_URL = "http://127.0.0.1:1"; // unused by unit tests
  resetConfig();
  resetRuntime();
  resetDbHandle();
});

afterAll(() => {
  resetRuntime();
});
