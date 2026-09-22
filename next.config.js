/** @type {import('next').NextConfig} */
const nextConfig = {
  // Let Next serve large uploads without a hard body cap. We stream uploads
  // straight through to OpenList, so Next itself never buffers the whole file.
  experimental: {
    // Allow larger server-side request bodies for file uploads.
    serverActions: { bodySizeLimit: "500mb" },
    // Avoid bundling the native better-sqlite3 module into the server bundle.
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
};

module.exports = nextConfig;
