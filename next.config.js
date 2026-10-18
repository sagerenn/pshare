// Optional sub-path the whole site is served under, e.g. "/pshare" when
// published to a GitHub Pages project site (https://<owner>.github.io/pshare/).
// Normalize so "pshare/", "/pshare", and "/pshare///" all become "/pshare";
// empty (the default) serves from the root, like the Docker image does.
// NEXT_PUBLIC_ prefix so the same value is inlined into the client bundle
// (src/lib/config.ts reads it for share links and SW registration).
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const normalized = rawBasePath.replace(/\/+$/, "").replace(/^\/+/, "");
const basePath = normalized ? `/${normalized}` : "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // pshare is a fully static site: no Next server, no API routes. The browser
  // talks directly to OpenList. `output: "export"` produces a self-contained
  // `out/` directory that can be hosted on any static host / edge / FaaS.
  output: "export",

  // Static export can't run Next's image optimizer; serve images as-is.
  images: { unoptimized: true },

  // Clean URLs without trailing slashes keep share links tidy on static hosts.
  trailingSlash: false,

  // Optional sub-path the whole site is served under (normalized above).
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

module.exports = nextConfig;
