"use client";

import { useEffect } from "react";
import { withBasePath } from "@/lib/config";

/**
 * Registers the pshare service worker on the client. Only runs in production
 * builds (the static export); skipped during dev to avoid caching stale
 * assets. The path is base-path aware so registration also works when the
 * site is served from a sub-path (e.g. GitHub Pages).
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register(withBasePath("/sw.js")).catch(() => {
      // Registration failure is non-fatal: the site still works online.
    });
  }, []);
  return null;
}
