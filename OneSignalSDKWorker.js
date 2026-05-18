const CACHE_NAME = 'medplus-cache-v5.1'; // Nhớ tăng số này mỗi lần cập nhật app
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

// ─── INSTALL: Lưu cache và bỏ qua chờ đợi ──────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// ─── ACTIVATE: Xóa cache cũ, chiếm quyền điều khiển ngay ───
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim()) 
  );
});

// ─── FETCH: Stale-While-Revalidate ─────────────────────────
self.addEventListener('fetch', event => {
  // Bỏ qua các request của OneSignal để tránh lỗi thông báo
  if (event.request.url.includes('onesignal.com')) {
    return;
  }
  
  // Chỉ cache các request dạng GET (bỏ qua POST, PUT...)
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return cache.match(event.request).then(cachedResponse => {
        
        // Ngầm tải bản mới nhất từ mạng (Network) về
        const fetchedResponse = fetch(event.request).then(networkResponse => {
          // Chỉ lưu đè vào cache nếu file tải về thành công và hợp lệ
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => {
          // Xử lý khi mất mạng (hiện tại bỏ qua, app vẫn xài bản cache)
        });

        // Ưu tiên trả về bản Cache ngay lập tức để app tải nhanh như chớp.
        // Nếu Cache chưa có (người dùng mới vào lần đầu), thì chờ bản tải từ Network.
        return cachedResponse || fetchedResponse;
      });
    })
  );
});

// ─── ONESIGNAL SDK IMPORT ──────────────────────────────────
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
