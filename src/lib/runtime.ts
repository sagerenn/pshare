/**
 * Process-wide singletons for the API routes: one OpenList client and one
 * metadata DB. Next.js API route handlers are short-lived functions; sharing
 * these avoids re-opening the SQLite DB and re-logging into OpenList on every
 * request.
 */
import { loadConfig } from "./config";
import { OpenListClient } from "./openlist-client";
import { openDb, closeDb } from "./share-store";
import { startReaper, type ReaperHandle } from "./reaper";
import type { Database } from "better-sqlite3";

let client: OpenListClient | null = null;
let database: Database | null = null;
let reaper: ReaperHandle | null = null;

/** The shared OpenList client. */
export function getClient(): OpenListClient {
  if (!client) {
    const cfg = loadConfig();
    client = new OpenListClient(cfg);
  }
  return client;
}

/** The shared metadata database (opened lazily on first use). */
export function getDb(): Database {
  if (!database) {
    const cfg = loadConfig();
    database = openDb(cfg.dbPath);
    // Start the background reaper once the DB is open so expired/over-limit
    // shares are cleaned up even if nobody re-visits them. The first sweep
    // runs after one interval, so this never blocks a request.
    if (!reaper) {
      reaper = startReaper(database, getClient(), cfg.reaperIntervalMs);
    }
  }
  return database;
}

/** Reset singletons. Used by tests. */
export function resetRuntime(): void {
  if (reaper) {
    reaper.stop();
    reaper = null;
  }
  closeDb();
  client = null;
  database = null;
}
