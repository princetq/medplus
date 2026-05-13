const CACHE_NAME = 'medplus-cache-v3';
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
    ).then(() => self.clients.claim()) // ← Quan trọng: SW kiểm soát tab ngay lập tức
  );
});

// ─── FETCH ─────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});

// ─── NOTIFICATION CLICK ────────────────────────────────────
// Xử lý khi người dùng nhấn vào thông báo push
self.addEventListener('notificationclick', event => {
  event.notification.close();

  // Lấy URL từ notification data (OneSignal lưu ở event.notification.data.url)
  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {

        const targetOrigin = new URL(targetUrl, self.location.origin).origin;

        // Tìm tab đang mở cùng origin (ngocanh.io.vn)
        const existingClient = windowClients.find(client => {
          try {
            return new URL(client.url).origin === targetOrigin;
          } catch (e) {
            return false;
          }
        });

        if (existingClient) {
          // ── Tab đang tồn tại (kể cả bị BFCache trên iOS) ──
          return existingClient.focus()
            .then(focusedClient => {
              if (focusedClient && focusedClient.navigate) {
                // navigate() phá vỡ BFCache, load lại URL mới có ?hdsd=
                return focusedClient.navigate(targetUrl);
              }
              // Fallback cho iOS Safari (không hỗ trợ navigate())
              // Gửi message để index.html tự xử lý
              focusedClient.postMessage({
                type: 'ONESIGNAL_NOTIFICATION_CLICK',
                url: targetUrl
              });
            });
        }

        // ── Không có tab nào → mở tab mới ──
        return self.clients.openWindow(targetUrl);
      })
  );
});

importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
