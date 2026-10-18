#!/usr/bin/env node
/**
 * Post-build step for sub-path deployments (run automatically by
 * `npm run build`). Next.js 14 correctly prefixes /_next assets and metadata
 * icon URLs with the configured basePath, but two things still need fixing:
 *
 *  1. public/manifest.webmanifest is copied to out/ verbatim, so its
 *     start_url / scope / icon paths stay root-relative; under a sub-path
 *     the PWA would install from the wrong URLs. They are rewritten here.
 *  2. As a safety net, any <link rel="manifest" href="/manifest.webmanifest">
 *     still emitted unprefixed in the generated HTML (the file-based
 *     manifest metadata route had this bug) is rewritten as well.
 *
 * No-op when NEXT_PUBLIC_BASE_PATH is empty/absent (root deployments).
 */
const { existsSync, readdirSync, readFileSync, writeFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const OUT_DIR = join(__dirname, "..", "out");

const rawBase = process.env.NEXT_PUBLIC_BASE_PATH || "";
const normalized = rawBase.replace(/\/+$/, "").replace(/^\/+/, "");
const base = normalized ? `/${normalized}` : "";

if (!base) {
  // Root deployment: Next's output is already correct.
  process.exit(0);
}

/** Prefix a root-relative URL (leave anything else untouched). */
function prefixed(value) {
  return typeof value === "string" && value.startsWith("/") ? `${base}${value}` : value;
}

function patchManifest() {
  const file = join(OUT_DIR, "manifest.webmanifest");
  if (!existsSync(file)) return;
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (manifest.start_url) manifest.start_url = prefixed(manifest.start_url);
  if (manifest.scope) manifest.scope = prefixed(manifest.scope);
  if (Array.isArray(manifest.icons)) {
    manifest.icons = manifest.icons.map((icon) => ({ ...icon, src: prefixed(icon.src) }));
  }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`apply-base-path: prefixed manifest URLs with ${base}`);
}

const TARGET = 'href="/manifest.webmanifest"';
const REPLACEMENT = `href="${base}/manifest.webmanifest"`;

let patched = 0;
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if (entry.endsWith(".html")) {
      const html = readFileSync(full, "utf8");
      if (html.includes(TARGET)) {
        writeFileSync(full, html.split(TARGET).join(REPLACEMENT));
        patched++;
      }
    }
  }
}

if (!existsSync(OUT_DIR)) {
  console.error("apply-base-path: out/ not found — did `next build` run with output:export?");
  process.exit(1);
}

patchManifest();
walk(OUT_DIR);
if (patched > 0) {
  console.log(`apply-base-path: rewrote manifest href in ${patched} page(s)`);
}
