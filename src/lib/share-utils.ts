/**
 * Pure helpers for share creation: media-type detection, id generation, and
 * expiry computation. Kept separate from I/O so they can be unit-tested with
 * no database or network.
 */
import type { ShareType } from "./share-store";

/** MIME prefixes that map to each media type. Order matters: image/video/audio
 *  are checked before the generic "file" fallback. */
const MIME_RULES: Array<{ type: Exclude<ShareType, "text">; prefix: string }> = [
  { type: "image", prefix: "image/" },
  { type: "video", prefix: "video/" },
  { type: "audio", prefix: "audio/" },
];

/** File-name extensions used as a fallback when MIME is unknown. */
const EXT_RULES: Record<string, Exclude<ShareType, "text" | "file">> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", svg: "image",
  mp4: "video", webm: "video", mov: "video", mkv: "video", avi: "video", m4v: "video",
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", aac: "audio", m4a: "audio", opus: "audio",
};

/**
 * Detect the share type from a MIME type and file name. Text content sent
 * without a file is classified as "text"; anything we can't classify falls
 * back to "file".
 */
export function detectType(mime: string, name: string, isText = false): ShareType {
  if (isText) return "text";
  const m = (mime || "").toLowerCase();
  for (const rule of MIME_RULES) {
    if (m.startsWith(rule.prefix)) return rule.type;
  }
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (EXT_RULES[ext]) return EXT_RULES[ext];
  // text/* MIME (e.g. text/plain, text/markdown) but with a file name => file.
  if (m.startsWith("text/")) return "file";
  return "file";
}

/**
 * Generate a short, URL-safe share id. 10 chars of base32 gives ~50 bits of
 * entropy — far beyond guessable for a public no-login site — while staying
 * short enough to paste easily.
 */
export function generateId(rand: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"; // Crockford base32
  let out = "";
  for (let i = 0; i < 10; i++) {
    // Clamp r to [0, 1) so a PRNG that can return exactly 1 (or >1) can't
    // produce an out-of-range index and an `undefined` char in the id.
    const r = Math.min(Math.max(rand(), 0), 0.999999);
    out += alphabet[Math.floor(r * alphabet.length)];
  }
  return out;
}

/** Preset expiry options offered to the uploader (value in seconds). */
export const EXPIRY_PRESETS = [
  { label: "10 minutes", seconds: 600 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
] as const;

/** Compute the absolute expiry timestamp (epoch ms) for a TTL in seconds. */
export function computeExpiry(ttlSeconds: number, now = Date.now()): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`invalid ttl: ${ttlSeconds}`);
  }
  return now + ttlSeconds * 1000;
}

/** Preset download-limit options offered to the uploader. */
export const DOWNLOAD_LIMIT_PRESETS = [0, 1, 5, 10, 100] as const;

/** True if a share is expired or has hit its download limit. */
export function isExpired(share: { expires_at: number; max_downloads: number; downloads: number }, now = Date.now()): boolean {
  if (share.expires_at <= now) return true;
  if (share.max_downloads > 0 && share.downloads >= share.max_downloads) return true;
  return false;
}

/** Format a byte count as a human-readable string (B / KB / MB / GB). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
