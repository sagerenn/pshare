import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  openDb,
  createShare,
  getShare,
  incrementDownloads,
  markDeleted,
  listExpired,
  listLive,
  type NewShare,
} from "@/lib/share-store";

let db: Database.Database;
let dbPath: string;

function newShare(over: Partial<NewShare> = {}): NewShare {
  return {
    id: "abc1234567",
    path: "/pshare/abc1234567/file.txt",
    name: "file.txt",
    type: "text",
    mime: "text/plain",
    size: 10,
    expires_at: Date.now() + 3600_000,
    max_downloads: 0,
    ...over,
  };
}

beforeEach(() => {
  dbPath = path.join(
    mkdtempSync(path.join(tmpdir(), "pshare-db-")),
    "t.db",
  );
  db = openDb(dbPath);
});

describe("createShare + getShare", () => {
  it("round-trips a share", () => {
    const s = createShare(db, newShare());
    expect(s.downloads).toBe(0);
    expect(s.deleted_at).toBeNull();
    const got = getShare(db, "abc1234567");
    expect(got).not.toBeNull();
    expect(got!.name).toBe("file.txt");
    expect(got!.type).toBe("text");
  });

  it("returns null for unknown id", () => {
    expect(getShare(db, "nope")).toBeNull();
  });

  it("returns null for a deleted share", () => {
    createShare(db, newShare());
    markDeleted(db, "abc1234567");
    expect(getShare(db, "abc1234567")).toBeNull();
  });
});

describe("incrementDownloads", () => {
  it("increments and returns the new count", () => {
    createShare(db, newShare());
    expect(incrementDownloads(db, "abc1234567")).toBe(1);
    expect(incrementDownloads(db, "abc1234567")).toBe(2);
    expect(getShare(db, "abc1234567")!.downloads).toBe(2);
  });

  it("returns -1 for unknown or deleted share", () => {
    expect(incrementDownloads(db, "missing")).toBe(-1);
    createShare(db, newShare());
    markDeleted(db, "abc1234567");
    expect(incrementDownloads(db, "abc1234567")).toBe(-1);
  });

  it("refuses to increment past a download limit (atomic claim)", () => {
    createShare(db, newShare({ id: "limt0000001", max_downloads: 2 }));
    expect(incrementDownloads(db, "limt0000001")).toBe(1);
    expect(incrementDownloads(db, "limt0000001")).toBe(2);
    // At the limit now: further claims return -1 and do not increment.
    expect(incrementDownloads(db, "limt0000001")).toBe(-1);
    expect(getShare(db, "limt0000001")!.downloads).toBe(2);
  });
});

describe("listExpired", () => {
  it("returns shares past their expiry", () => {
    createShare(db, newShare({ id: "expired0001", expires_at: 1000 }));
    createShare(db, newShare({ id: "live0000002", expires_at: Date.now() + 9999 }));
    const exp = listExpired(db, 2000);
    expect(exp.map((s) => s.id)).toEqual(["expired0001"]);
  });

  it("returns shares that hit their download limit", () => {
    createShare(db, newShare({ id: "dl00000003", max_downloads: 2, expires_at: 1e12 }));
    incrementDownloads(db, "dl00000003");
    incrementDownloads(db, "dl00000003");
    const exp = listExpired(db, 0);
    expect(exp.map((s) => s.id)).toEqual(["dl00000003"]);
  });

  it("does not return unlimited shares with high downloads", () => {
    createShare(db, newShare({ id: "unlim000004", max_downloads: 0, expires_at: 1e12 }));
    incrementDownloads(db, "unlim000004");
    incrementDownloads(db, "unlim000004");
    expect(listExpired(db, 0)).toEqual([]);
  });

  it("excludes deleted shares", () => {
    createShare(db, newShare({ id: "expired0005", expires_at: 1000 }));
    markDeleted(db, "expired0005");
    expect(listExpired(db, 2000)).toEqual([]);
  });
});

describe("listLive", () => {
  it("lists non-deleted shares newest-first", () => {
    createShare(db, newShare({ id: "a000000001" }));
    createShare(db, newShare({ id: "b000000002" }));
    markDeleted(db, "a000000001");
    const live = listLive(db);
    expect(live.map((s) => s.id)).toEqual(["b000000002"]);
  });
});
