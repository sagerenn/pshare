/**
 * The reaper: periodically finds shares that have expired or hit their
 * download limit, deletes their files from OpenList, and marks them deleted
 * in the metadata DB. This is what makes pshare "temporary".
 */
import type { OpenListClient } from "./openlist-client";
import { listExpired, markDeleted, type Share } from "./share-store";
import type { Database } from "better-sqlite3";

export type ReaperResult = { checked: number; deleted: number; failed: number };

/**
 * Run one reaper sweep. Returns counts. Errors deleting individual files are
 * swallowed (logged) so one stuck file doesn't block the rest; it'll be
 * retried next sweep since the share stays non-deleted.
 */
export async function reapOnce(db: Database, client: OpenListClient, now = Date.now()): Promise<ReaperResult> {
  const expired = listExpired(db, now);
  let deleted = 0;
  let failed = 0;
  for (const share of expired) {
    try {
      await deleteShareFile(client, share);
      markDeleted(db, share.id);
      deleted++;
    } catch {
      // Leave it live so we retry next pass.
      failed++;
    }
  }
  return { checked: expired.length, deleted, failed };
}

/** Delete a single share's file from OpenList, splitting path into dir + name. */
export async function deleteShareFile(client: OpenListClient, share: Share): Promise<void> {
  const path = share.path.replace(/^\/+/, "");
  const idx = path.lastIndexOf("/");
  const dir = idx < 0 ? "/" : "/" + path.slice(0, idx);
  const name = idx < 0 ? path : path.slice(idx + 1);
  if (!name) throw new Error(`cannot derive file name from path ${share.path}`);
  await client.remove(dir, [name]);
}

/** A handle returned by startReaper so the loop can be stopped (tests). */
export type ReaperHandle = { stop: () => void; run: () => Promise<ReaperResult> };

/**
 * Start a reaper that runs `reapOnce` on a fixed interval. Returns a handle
 * to stop it. The first sweep is scheduled after one interval, not
 * immediately, so startup isn't blocked on cleanup.
 */
export function startReaper(
  db: Database,
  client: OpenListClient,
  intervalMs: number,
  clock: () => number = Date.now,
): ReaperHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = () => reapOnce(db, client, clock());

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await run();
      } catch {
        // swallow; next tick will retry
      }
      schedule();
    }, intervalMs);
  };
  schedule();

  return {
    run,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
