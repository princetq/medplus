importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

const CACHE_NAME = 'medplus-cache-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png' // Nên cache sẵn logo để app load nhanh hơn
  '/tools/ks/ks.webp'
  '/tools/tiemtruyen/tiem.webp'
  '/tools/ttthuoc/TTthuoc.webp'
  '/tools/tuongki/tuongki.webp'

];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});
