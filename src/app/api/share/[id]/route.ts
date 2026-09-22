/**
 * GET /api/share/[id] — fetch a share's metadata and a public download URL.
 *
 * If the share is expired or has hit its download limit, we trigger a reaper
 * sweep of just that share (delete from OpenList + mark deleted) and return
 * 404/410. Otherwise we atomically claim one download against the limit and
 * return the OpenList `raw_url`, which is a signed, no-auth download link.
 *
 * The download-limit check and increment happen in a single atomic SQLite
 * UPDATE (see incrementDownloads), so concurrent requests for the last
 * allowed download can't all succeed.
 */
import { NextRequest, NextResponse } from "next/server";
import { getClient, getDb } from "@/lib/runtime";
import { getShare, incrementDownloads, markDeleted } from "@/lib/share-store";
import { deleteShareFile } from "@/lib/reaper";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const db = getDb();
  const share = getShare(db, ctx.params.id);
  if (!share) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Expired (time-based): clean up and report gone.
  if (share.expires_at <= Date.now()) {
    const client = getClient();
    try {
      await deleteShareFile(client, share);
    } catch {
      // best-effort; reaper will retry
    }
    markDeleted(db, share.id);
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  // Atomically claim one download. This returns -1 if the share was
  // concurrently deleted, or has already hit its download limit — in either
  // case the share is gone (or should be), so clean up and 410.
  const newCount = incrementDownloads(db, share.id);
  if (newCount < 0) {
    const client = getClient();
    try {
      await deleteShareFile(client, share);
    } catch {
      // best-effort; reaper will retry
    }
    markDeleted(db, share.id);
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  // Fetch the signed download URL from OpenList.
  let rawUrl: string;
  try {
    const client = getClient();
    const info = await client.get(share.path);
    rawUrl = info.raw_url;
  } catch (err) {
    // We already counted this download; on a transient backend failure we
    // don't roll back the counter (the file is still there). Return 502.
    return NextResponse.json(
      { error: `failed to fetch file: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    id: share.id,
    type: share.type,
    name: share.name,
    mime: share.mime,
    size: share.size,
    expires_at: share.expires_at,
    max_downloads: share.max_downloads,
    downloads: newCount,
    download_url: rawUrl,
  });
}
