// Minimal service worker: exists only so the PWA is installable to the home
// screen. No offline caching of audio (YAGNI) — it claims clients and does
// nothing else.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
