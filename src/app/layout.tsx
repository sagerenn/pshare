import type { Metadata, Viewport } from "next";
import ServiceWorkerRegister from "./sw-register";
import "./globals.css";

// Base path the bundle is built for ("" at the root, "/pshare" on a GitHub
// Pages project site). Normalized the same way as next.config.js. Read with a
// literal member access so Next inlines it at build time; this module only
// runs on the server (metadata generation), where the env is readable anyway.
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const normalizedBase = rawBasePath.replace(/\/+$/, "").replace(/^\/+/, "");
const base = normalizedBase ? `/${normalizedBase}` : "";

export const metadata: Metadata = {
  title: "pshare — temporary sharing",
  description:
    "Public, no-login sharing for temporary text, files, images, video, and audio.",
  // public/manifest.webmanifest is copied verbatim into out/, so the URL is
  // base-path aware here; scripts/apply-base-path.js rewrites its contents
  // (start_url / scope / icons) for sub-path deployments after the build.
  manifest: `${base}/manifest.webmanifest`,
  applicationName: "pshare",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "pshare",
  },
  icons: {
    icon: [
      { url: `${base}/icon-192.png`, sizes: "192x192", type: "image/png" },
      { url: `${base}/icon-512.png`, sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: `${base}/icon-192.png`, sizes: "192x192", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
