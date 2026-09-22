import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, createShare, markDeleted, type NewShare } from "@/lib/share-store";
import { reapOnce, deleteShareFile, startReaper } from "@/lib/reaper";
import type { OpenListClient } from "@/lib/openlist-client";

let db: Database.Database;

function newShare(over: Partial<NewShare> = {}): NewShare {
  return {
    id: "share00001",
    path: "/pshare/share00001/file.txt",
    name: "file.txt",
    type: "text",
    mime: "text/plain",
    size: 5,
    expires_at: Date.now() + 3600_000,
    max_downloads: 0,
    ...over,
  };
}

beforeEach(() => {
  db = openDb(path.join(mkdtempSync(path.join(tmpdir(), "reaper-")), "t.db"));
});

function fakeClient(removeImpl?: (dir: string, names: string[]) => Promise<void>) {
  return {
    remove: vi.fn(removeImpl ?? (async () => {})),
  } as unknown as OpenListClient;
}

describe("deleteShareFile", () => {
  it("splits path into dir and name", async () => {
    const client = fakeClient();
    await deleteShareFile(client, { ...newShare(), path: "/pshare/abc/file.txt" } as never);
    expect(client.remove).toHaveBeenCalledWith("/pshare/abc", ["file.txt"]);
  });

  it("handles a path with no subdirectory", async () => {
    const client = fakeClient();
    await deleteShareFile(client, { ...newShare(), path: "/file.txt" } as never);
    expect(client.remove).toHaveBeenCalledWith("/", ["file.txt"]);
  });

  it("throws on empty name", async () => {
    const client = fakeClient();
    await expect(
      deleteShareFile(client, { ...newShare(), path: "/pshare/abc/" } as never),
    ).rejects.toThrow(/file name/);
  });
});

describe("reapOnce", () => {
  it("deletes expired shares from OpenList and marks them deleted", async () => {
    const client = fakeClient();
    createShare(db, newShare({ id: "expired0001", path: "/pshare/expired0001/file.txt", expires_at: 1000 }));
    createShare(db, newShare({ id: "live0000002", path: "/pshare/live0000002/file.txt", expires_at: Date.now() + 9999 }));
    const res = await reapOnce(db, client, 2000);
    expect(res).toEqual({ checked: 1, deleted: 1, failed: 0 });
    expect(client.remove).toHaveBeenCalledWith("/pshare/expired0001", ["file.txt"]);
    // live share untouched
    const live = db.prepare("SELECT deleted_at FROM shares WHERE id='live0000002'").get() as { deleted_at: number | null };
    expect(live.deleted_at).toBeNull();
  });

  it("deletes shares that hit their download limit", async () => {
    const client = fakeClient();
    createShare(db, newShare({ id: "dl00000003", max_downloads: 1, expires_at: Date.now() + 1e9 }));
    db.prepare("UPDATE shares SET downloads=1 WHERE id='dl00000003'").run();
    const res = await reapOnce(db, client, 0);
    expect(res.deleted).toBe(1);
  });

  it("counts failures and leaves the share live for retry", async () => {
    const client = fakeClient(async () => {
      throw new Error("openlist down");
    });
    createShare(db, newShare({ id: "expired0004", expires_at: 1000 }));
    const res = await reapOnce(db, client, 2000);
    expect(res).toEqual({ checked: 1, deleted: 0, failed: 1 });
    const row = db.prepare("SELECT deleted_at FROM shares WHERE id='expired0004'").get() as { deleted_at: number | null };
    expect(row.deleted_at).toBeNull();
  });

  it("processes multiple expired shares in one sweep", async () => {
    const client = fakeClient();
    createShare(db, newShare({ id: "exp0000005", expires_at: 1000 }));
    createShare(db, newShare({ id: "exp0000006", expires_at: 1000 }));
    createShare(db, newShare({ id: "exp0000007", expires_at: 1000 }));
    const res = await reapOnce(db, client, 2000);
    expect(res.deleted).toBe(3);
    expect(client.remove).toHaveBeenCalledTimes(3);
  });
});

describe("startReaper", () => {
  it("runs sweeps on an interval and can be stopped", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    createShare(db, newShare({ id: "exp0000008", expires_at: 1000 }));
    const handle = startReaper(db, client, 1000, () => 2000);
    // First sweep fires after one interval.
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.remove).toHaveBeenCalledTimes(1);
    // Second sweep: share is now deleted, nothing to do.
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.remove).toHaveBeenCalledTimes(1);
    handle.stop();
    vi.useRealTimers();
  });
});
