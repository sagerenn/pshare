import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "pshare — temporary sharing",
  description:
    "Public, no-login sharing for temporary text, files, images, video, and audio.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
