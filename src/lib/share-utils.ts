/**
 * Pure helpers for share creation: media-type detection, id generation, and
 * byte formatting. Kept separate from I/O so they can be unit-tested with
 * no network. Expiry and download-limit logic live on the OpenList side
 * (per-user TTL + per-file X-Ttl override), so there is no client-side
 * expiry math here.
 */

export type ShareType = "text" | "file" | "image" | "video" | "audio";

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

/** Extensions that should render as inline text in the share viewer. */
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "xml", "yaml", "yml",
  "ini", "toml", "conf", "cfg", "env", "sh", "bash", "zsh", "fish", "ps1",
  "js", "ts", "jsx", "tsx", "py", "rb", "go", "rs", "java", "kt", "c", "h",
  "cpp", "hpp", "cs", "php", "pl", "lua", "r", "sql", "html", "htm", "css",
  "scss", "less", "svg", "bat", "cmd", "psm1", "psd1",
]);

/**
 * Detect the share type from a MIME type and file name. Text content sent
 * without a file is classified as "text"; a text/* MIME or a known text
 * extension also renders as inline text so that a shared `paste.txt` (or an
 * uploaded `.md`/`.json`/etc.) shows its contents in the viewer rather than
 * a bare download card. Anything else falls back to "file".
 */
export function detectType(mime: string, name: string, isText = false): ShareType {
  if (isText) return "text";
  const m = (mime || "").toLowerCase();
  for (const rule of MIME_RULES) {
    if (m.startsWith(rule.prefix)) return rule.type;
  }
  // text/* MIME (e.g. text/plain, text/markdown, application/json) renders as
  // inline text. image/video/audio were already handled above by MIME_RULES,
  // so a text/* MIME here is genuinely text.
  if (m.startsWith("text/") || m === "application/json" || m === "application/xml") {
    return "text";
  }
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (EXT_RULES[ext]) return EXT_RULES[ext];
  if (TEXT_EXTS.has(ext)) return "text";
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

/**
 * Preset expiry options offered to the uploader (value in seconds). The
 * selected value is sent as the per-file X-Ttl header; 0 means "use the
 * OpenList user's default TTL".
 */
export const EXPIRY_PRESETS = [
  { label: "default", seconds: 0 },
  { label: "10 minutes", seconds: 600 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
] as const;

/** Format a byte count as a human-readable string (B / KB / MB / GB). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Sanitize a file name for use as an OpenList path segment: keep word chars,
 * dots, and dashes; replace everything else with underscore. This avoids path
 * traversal and odd characters in the share URL.
 *
 * A result that is empty or only dots (e.g. input ".." or "...") would be a
 * traversal segment, so it falls back to the default name.
 */
export function sanitizeName(name: string): string {
  const cleaned = (name || "").replace(/[^\w.\-]+/g, "_");
  // Require at least one alphanumeric char so the segment can't be empty,
  // all-dots, or a lone underscore (\w includes _, so test for [a-z0-9]).
  if (!/[a-z0-9]/i.test(cleaned)) return "upload.bin";
  return cleaned;
}
