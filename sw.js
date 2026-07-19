/* App-shell cache with stale-while-revalidate: pages load instantly from
   cache, and every visit refreshes the shell in the background so deploys
   arrive on the next open without needing a cache-version bump.
   Never touches api.github.com or the import proxies (different origins). */
"use strict";

var CACHE = "rb-shell-v3";
var SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./js/ingredients.js",
  "./js/importers.js",
  "./js/github.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(e.request, { ignoreSearch: true }).then(function (hit) {
        // "no-cache" revalidates against the server instead of trusting the
        // browser's HTTP cache, so new deploys are picked up promptly.
        var refresh = fetch(e.request, { cache: "no-cache" }).then(function (res) {
          if (res && res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(function () { return null; });
        if (hit) {
          e.waitUntil(refresh);
          return hit;
        }
        return refresh.then(function (res) {
          if (res) return res;
          if (e.request.mode === "navigate") return cache.match("./index.html");
          throw new Error("offline");
        });
      });
    })
  );
});
