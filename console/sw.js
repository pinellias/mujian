/* 幕间 · 服务工作线程（PWA）
 * 作用：让网页可被「安装」到手机主屏，以 standalone 模式打开（无浏览器地址栏/工具栏）。
 * 策略：网络优先 + 离线兜底。
 *   - 普通页面/静态资源：先打网络拿最新（你边改边看不踩缓存），失败再回退缓存。
 *   - /api/ 数据接口：永远直连网络，绝不缓存（保证剧本数据实时）。
 * 改了资源想强制刷新缓存，把 CACHE 版本号 +1 即可。 */
'use strict';
const CACHE = 'mujian-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/boot.js',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();   /* 新 SW 立刻生效，不等旧标签页关掉 */
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;            /* 非 GET 一律直连 */

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          /* 跨域不插手 */
  if (url.pathname.startsWith('/api/')) return;             /* 数据接口永远走网络 */

  /* 导航请求（打开页面）：网络优先，离线时回退首页缓存 */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  /* 其余静态资源：stale-while-revalidate —— 先给缓存，后台更新 */
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
