const CACHE_NAME = 'medplus-cache-v4';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/tools/ks/ks.webp',
  '/tools/tiemtruyen/tiem.webp',
  '/tools/ttthuoc/TTthuoc.webp',
  '/tools/tuongki/tuongki.webp'
];

// ─── INSTALL ───────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// ─── ACTIVATE: Xóa cache cũ, claim clients ngay ────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim()) 
  );
});

// ─── FETCH ─────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  // Thêm điều kiện: Bỏ qua các request nội bộ của OneSignal để tránh lỗi
  if (event.request.url.includes('onesignal.com')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});

// ─── ONESIGNAL SDK IMPORT ──────────────────────────────────
// Để OneSignal tự động xử lý toàn bộ logic click thông báo ẩn bên dưới
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
