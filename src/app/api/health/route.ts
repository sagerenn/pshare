/**
 * GET /api/health — liveness + backend reachability check. Used by the e2e
 * harness to wait for the app to be ready and to confirm OpenList is up.
 */
import { NextResponse } from "next/server";
import { getClient } from "@/lib/runtime";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  let backend = "down";
  try {
    await getClient().token();
    backend = "up";
  } catch {
    // leave "down"
  }
  return NextResponse.json({ ok: true, backend });
}
