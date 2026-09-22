import type { Metadata, Viewport } from "next";
import ServiceWorkerRegister from "./sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "pshare — temporary sharing",
  description:
    "Public, no-login sharing for temporary text, files, images, video, and audio.",
  manifest: "/manifest.webmanifest",
  applicationName: "pshare",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "pshare",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
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
