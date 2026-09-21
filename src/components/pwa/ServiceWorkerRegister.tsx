"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Non-fatal: the app works fine without a service worker, it just
        // won't be installable / won't receive push while closed.
      });
    }
  }, []);
  return null;
}
