/* Service worker: makes Tokyo Music installable and lets the app shell open
   without a network. Network-first, so a redeploy still shows up on the next
   load exactly as it does without a worker; the cache is only a fallback.

   Only the app's own static files are handled. Jellyfin (API, images, audio)
   is never touched, even when it shares this origin. */

const CACHE = "tokyo-music-shell-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest"];
const STATIC_FILE = /\.(?:html|js|css|svg|png|webmanifest|woff2)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAppFile(request) {
  if (request.method !== "GET" || request.headers.has("range")) return false;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return false;
  return request.mode === "navigate" || STATIC_FILE.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!isAppFile(request)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match("index.html", { ignoreSearch: true });
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
