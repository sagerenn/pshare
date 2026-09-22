import { describe, it, expect } from "vitest";
import {
  detectType,
  generateId,
  formatBytes,
  sanitizeName,
  EXPIRY_PRESETS,
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

  it("treats text/* MIME and known text extensions as text", () => {
    // A shared paste.txt (or uploaded notes.md) should render inline in the
    // share viewer, not as a bare download card.
    expect(detectType("text/plain", "notes.txt")).toBe("text");
    expect(detectType("text/markdown", "README.md")).toBe("text");
    expect(detectType("application/json", "data.json")).toBe("text");
    expect(detectType("", "config.yaml")).toBe("text");
    expect(detectType("application/octet-stream", "script.sh")).toBe("text");
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
    expect(id).toHaveLength(10);
  });

  it("clamps a PRNG that returns >= 1 so no char is undefined", () => {
    const id = generateId(() => 1);
    expect(id).toMatch(/^[a-z2-7]{10}$/);
    expect(id).not.toContain("undefined");
  });
});

describe("sanitizeName", () => {
  it("keeps word chars, dots, and dashes", () => {
    expect(sanitizeName("hello-world_1.2.txt")).toBe("hello-world_1.2.txt");
  });

  it("replaces spaces and path separators with underscore (dots are kept)", () => {
    expect(sanitizeName("my file (1).txt")).toBe("my_file_1_.txt");
    // Dots are allowed chars; slashes collapse to a single underscore. A name
    // with real characters stays as a single safe path segment.
    expect(sanitizeName("../etc/passwd")).toBe(".._etc_passwd");
  });

  it("falls back to a default for empty or traversal-only input", () => {
    expect(sanitizeName("")).toBe("upload.bin");
    expect(sanitizeName("///")).toBe("upload.bin");
    expect(sanitizeName("..")).toBe("upload.bin");
    expect(sanitizeName("...")).toBe("upload.bin");
  });
});

describe("EXPIRY_PRESETS", () => {
  it("starts with a 'default' preset of 0 seconds (use OpenList user TTL)", () => {
    expect(EXPIRY_PRESETS[0].label).toBe("default");
    expect(EXPIRY_PRESETS[0].seconds).toBe(0);
  });

  it("has positive, ascending durations after the default", () => {
    const secs = EXPIRY_PRESETS.slice(1).map((p) => p.seconds);
    expect(secs).toEqual([...secs].sort((a, b) => a - b));
    for (const s of secs) expect(s).toBeGreaterThan(0);
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
