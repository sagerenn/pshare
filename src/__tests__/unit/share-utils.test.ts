import { describe, it, expect } from "vitest";
import {
  detectType,
  generateId,
  computeExpiry,
  isExpired,
  formatBytes,
  EXPIRY_PRESETS,
  DOWNLOAD_LIMIT_PRESETS,
} from "@/lib/share-utils";

describe("detectType", () => {
  it("classifies text when isText is true", () => {
    expect(detectType("text/plain", "foo.txt", true)).toBe("text");
    expect(detectType("image/png", "foo.png", true)).toBe("text");
  });

  it("classifies by MIME prefix", () => {
    expect(detectType("image/png", "x")).toBe("image");
    expect(detectType("video/mp4", "x")).toBe("video");
    expect(detectType("audio/mpeg", "x")).toBe("audio");
    expect(detectType("image/svg+xml", "x")).toBe("image");
  });

  it("falls back to extension when MIME is generic", () => {
    expect(detectType("application/octet-stream", "song.mp3")).toBe("audio");
    expect(detectType("application/octet-stream", "clip.webm")).toBe("video");
    expect(detectType("application/octet-stream", "pic.jpg")).toBe("image");
  });

  it("falls back to file for unknown extensions", () => {
    expect(detectType("application/zip", "archive.zip")).toBe("file");
    expect(detectType("application/octet-stream", "data.bin")).toBe("file");
    expect(detectType("", "")).toBe("file");
  });

  it("treats text/* MIME with a filename as a file, not text", () => {
    expect(detectType("text/plain", "notes.txt")).toBe("file");
  });
});

describe("generateId", () => {
  it("produces 10-char base32 ids", () => {
    const id = generateId();
    expect(id).toMatch(/^[a-z2-7]{10}$/);
  });

  it("produces unique ids across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(generateId());
    expect(seen.size).toBe(5000);
  });

  it("respects an injected RNG (deterministic in tests)", () => {
    let n = 0;
    const id = generateId(() => n++ / 100);
    // first char index = floor(0/100)=0 -> 'a', etc.
    expect(id).toHaveLength(10);
  });

  it("clamps a PRNG that returns >= 1 so no char is undefined", () => {
    // A PRNG returning exactly 1 (or above) would index alphabet[32] and
    // produce 'undefined' without the clamp.
    const id = generateId(() => 1);
    expect(id).toMatch(/^[a-z2-7]{10}$/);
    expect(id).not.toContain("undefined");
  });
});

describe("computeExpiry", () => {
  it("adds ttl seconds to now", () => {
    expect(computeExpiry(3600, 1000)).toBe(1000 + 3600 * 1000);
    expect(computeExpiry(60, 0)).toBe(60_000);
  });

  it("throws on non-positive or non-finite ttl", () => {
    expect(() => computeExpiry(0)).toThrow();
    expect(() => computeExpiry(-5)).toThrow();
    expect(() => computeExpiry(NaN)).toThrow();
    expect(() => computeExpiry(Infinity)).toThrow();
  });
});

describe("isExpired", () => {
  it("is expired when now >= expires_at", () => {
    expect(isExpired({ expires_at: 1000, max_downloads: 0, downloads: 0 }, 1000)).toBe(true);
    expect(isExpired({ expires_at: 1000, max_downloads: 0, downloads: 0 }, 999)).toBe(false);
  });

  it("is expired when downloads reach a positive max", () => {
    const farFuture = Date.now() + 1e9;
    expect(isExpired({ expires_at: farFuture, max_downloads: 5, downloads: 5 })).toBe(true);
    expect(isExpired({ expires_at: farFuture, max_downloads: 5, downloads: 4 })).toBe(false);
  });

  it("ignores download count when max is 0 (unlimited)", () => {
    const farFuture = Date.now() + 1e9;
    expect(isExpired({ expires_at: farFuture, max_downloads: 0, downloads: 9999 })).toBe(false);
  });
});

describe("presets", () => {
  it("has ordered, positive expiry presets", () => {
    const secs = EXPIRY_PRESETS.map((p) => p.seconds);
    expect(secs).toEqual([...secs].sort((a, b) => a - b));
    for (const p of EXPIRY_PRESETS) expect(p.seconds).toBeGreaterThan(0);
  });

  it("includes 0 (unlimited) in download presets", () => {
    expect(DOWNLOAD_LIMIT_PRESETS).toContain(0);
  });
});

describe("formatBytes", () => {
  it("formats bytes, KB, MB, and GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
});
