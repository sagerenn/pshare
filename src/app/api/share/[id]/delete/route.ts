/**
 * DELETE /api/share/[id] — manually delete a share. No login: the share id
 * is the only secret, so knowing it is sufficient to delete. This matches
 * the "temporary, no-login" model.
 */
import { NextRequest, NextResponse } from "next/server";
import { getClient, getDb } from "@/lib/runtime";
import { getShare, markDeleted } from "@/lib/share-store";
import { deleteShareFile } from "@/lib/reaper";

export const runtime = "nodejs";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: { id: string } },
): Promise<NextResponse> {
  const db = getDb();
  const share = getShare(db, ctx.params.id);
  if (!share) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const client = getClient();
  try {
    await deleteShareFile(client, share);
  } catch (err) {
    // If the file is already gone from OpenList, still mark deleted locally.
    if (!/not found|object not found/i.test((err as Error).message)) {
      return NextResponse.json(
        { error: `delete failed: ${(err as Error).message}` },
        { status: 502 },
      );
    }
  }
  markDeleted(db, share.id);
  return NextResponse.json({ ok: true });
}
