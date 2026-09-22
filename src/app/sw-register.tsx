"use client";

import { useEffect } from "react";

/**
 * Registers the pshare service worker on the client. Only runs in production
 * builds (the static export); skipped during dev to avoid caching stale
 * assets.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failure is non-fatal: the site still works online.
    });
  }, []);
  return null;
}
