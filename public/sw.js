// Minimal service worker: enables PWA installability and handles Web Push
// display. No offline caching strategy is implemented - Antlerboard is a
// live data app, and stale cached data would be actively misleading for a
// front office tool. Revisit if an offline "read the roster" mode is ever
// wanted.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Antlerboard", body: event.data.text() };
  }
  const title = payload.title || "Antlerboard";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { link: payload.link || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification.data?.link || "/";
  event.waitUntil(clients.openWindow(link));
});
