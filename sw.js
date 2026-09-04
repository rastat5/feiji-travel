// 飞机旅行 Service Worker - APP版本（网络优先，确保始终加载最新版）
const CACHE_NAME = 'feiji-travel-app-v4';

// 安装：不预缓存页面，避免缓存旧版
self.addEventListener('install', event => {
  self.skipWaiting();
});

// 激活：清空全部旧缓存，立即接管页面
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 请求拦截：网络优先，离线才用缓存（关键：不再用缓存优先导致旧版缓存不更新）
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    fetch(event.request).then(response => {
      // 网络成功时更新缓存（但页面导航类不强缓存，保证下次还是拿最新）
      if (response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      // 离线时回退缓存
      return caches.match(event.request).then(cached => {
        if (cached) return cached;
        if (event.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});

// 接收消息：跳过等待 / 清缓存
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'CLEAR_CACHE') {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
  }
});
