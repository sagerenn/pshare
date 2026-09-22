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
};

module.exports = nextConfig;
