/*
 * CrewMind service worker — PWA app-shell caching only.
 *
 * Rules:
 *  - /api/ traffic is NEVER intercepted or cached (network only). Live
 *    business data must always come from the server.
 *  - Static assets (icons, manifest) are cache-first.
 *  - Pages are network-first with a cache fallback so the shell still
 *    opens on a flaky jobsite connection; fresh HTML wins when online.
 *  - Cross-origin requests (fonts, Stripe, etc.) are left to the browser.
 */
'use strict';

var CACHE = 'crewmind-shell-v1';

var SHELL = [
  '/',
  '/index.html',
  '/app',
  '/app.html',
  '/signup',
  '/signup.html',
  '/onboard',
  '/onboard.html',
  '/get-quote',
  '/get-quote.html',
  '/book',
  '/book.html',
  '/confirm',
  '/confirm.html',
  '/manifest.json',
  '/assets/cm-mark.png',
  '/assets/cm-mark-512.png',
  '/assets/apple-touch-icon.png',
  '/assets/favicon-16.png',
  '/assets/favicon-32.png',
  '/assets/favicon-64.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Cache shell files one by one so a single miss can't fail install.
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () { /* shell entry unavailable — skip */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === CACHE ? null : caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin: browser default
  if (url.pathname.indexOf('/api/') === 0) return;  // API: network only, never cached

  // Static assets: cache-first.
  if (url.pathname.indexOf('/assets/') === 0 || url.pathname === '/manifest.json') {
    event.respondWith(
      caches.match(request).then(function (hit) {
        return hit || fetch(request).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
          return res;
        });
      })
    );
    return;
  }

  // Pages: network-first, cache fallback for offline.
  event.respondWith(
    fetch(request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
      return res;
    }).catch(function () {
      return caches.match(request).then(function (hit) {
        return hit || caches.match('/index.html');
      });
    })
  );
});
