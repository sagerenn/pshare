/**
 * POST /api/share — create a new share. No login required.
 *
 * Accepts either:
 *  - JSON { text, ttl, maxDownloads } for a text share, or
 *  - multipart/form-data with a `file` field plus `ttl` and `maxDownloads`.
 *
 * The file/text is streamed to OpenList at /pshare/<id>/<name>, a metadata
 * row is written, and the share id + URL are returned.
 */
import { NextRequest, NextResponse } from "next/server";
import { getClient, getDb } from "@/lib/runtime";
import { loadConfig } from "@/lib/config";
import { createShare } from "@/lib/share-store";
import { computeExpiry, detectType, generateId } from "@/lib/share-utils";
import type { ShareType } from "@/lib/share-store";

export const runtime = "nodejs";
// Shares can be large; don't cap the route at the default 4mb.
export const maxDuration = 300;

type CreateBody = {
  text?: string;
  ttl?: number;
  maxDownloads?: number;
  filename?: string;
  mime?: string;
};

function parseTtl(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 604_800); // cap at 7 days
}

function parseMaxDownloads(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 100_000);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cfg = loadConfig();
  const client = getClient();
  const db = getDb();

  const contentType = req.headers.get("content-type") || "";
  let name: string;
  let mime: string;
  let body: BodyInit;
  let size: number;
  let isText = false;
  let ttl: number;
  let maxDownloads: number;

  if (contentType.includes("application/json")) {
    const data = (await req.json().catch(() => null)) as CreateBody | null;
    if (!data || typeof data.text !== "string" || data.text.length === 0) {
      return NextResponse.json({ error: "missing 'text'" }, { status: 400 });
    }
    if (Buffer.byteLength(data.text, "utf8") > cfg.maxBytes) {
      return NextResponse.json({ error: "text too large" }, { status: 413 });
    }
    const buf = Buffer.from(data.text, "utf8");
    name = (data.filename || "paste.txt").replace(/[^\w.\-]+/g, "_");
    mime = data.mime || "text/plain";
    body = buf;
    size = buf.length;
    isText = true;
    ttl = parseTtl(data.ttl, cfg.defaultTtl);
    maxDownloads = parseMaxDownloads(data.maxDownloads);
  } else if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing 'file' field" }, { status: 400 });
    }
    if (file.size > cfg.maxBytes) {
      return NextResponse.json({ error: "file too large" }, { status: 413 });
    }
    name = file.name.replace(/[^\w.\-]+/g, "_") || "upload.bin";
    mime = file.type || "application/octet-stream";
    // Read the file into a Buffer. We already enforce maxBytes above, so
    // buffering is bounded; this avoids Node fetch stream/duplex quirks and
    // lets us set an accurate Content-Length.
    const buf = Buffer.from(await file.arrayBuffer());
    body = buf;
    size = buf.length;
    ttl = parseTtl(form.get("ttl"), cfg.defaultTtl);
    maxDownloads = parseMaxDownloads(form.get("maxDownloads"));
  } else {
    return NextResponse.json({ error: "unsupported content type" }, { status: 415 });
  }

  const id = generateId();
  const type: ShareType = detectType(mime, name, isText);
  const path = `${cfg.openlistMountPath}/${id}/${name}`;
  const expiresAt = computeExpiry(ttl);

  try {
    await client.upload(path, body, size);
  } catch (err) {
    return NextResponse.json(
      { error: `upload failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  const share = createShare(db, {
    id,
    path,
    name,
    type,
    mime,
    size,
    expires_at: expiresAt,
    max_downloads: maxDownloads,
  });

  return NextResponse.json({
    id: share.id,
    url: `/s/${share.id}`,
    type: share.type,
    name: share.name,
    size: share.size,
    expires_at: share.expires_at,
    max_downloads: share.max_downloads,
  });
}
