/* ============================================
 * Service Worker — 离线可用
 *
 * 策略:
 *   导航请求 (HTML)  → network-first, 失败回落缓存
 *   静态资源         → cache-first (URL 带 ?v= 版本戳, 改版即换 URL)
 *
 * 为什么要它: FAQ 里写着「你可以在断网状态下使用本工具来验证这一点」。
 * 没有 SW 的话, 离线状态下新开或刷新页面就是白屏, 这句话不成立。
 * ============================================ */

const CACHE = 'ncm-byberg-v108';

const ASSETS = [
  'assets/css/style.css',
  'assets/js/app.js',
  'assets/js/worker.js',
  'modules/aes-js.js',
  'modules/crypto-utils.js',
  'modules/ncm.js',
  'modules/qmc.js',
  'modules/qmc-mobile.js',
  'modules/kgm.js',
  'modules/metadata.js',
  'modules/deflac.js',
  'modules/lame.min.js',
  'modules/jszip.min.js'
];

// 首屏需要的全部文件。缺任何一个的表现是离线打开后功能残缺。
const PRECACHE = ['./', 'index.html', 'manifest.webmanifest']
  .concat(ASSETS.map((p) => p + '?v=' + V));

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 逐个 add: 某一个 404 不该让整个 install 失败
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航: network-first —— 联网时永远拿最新版, 断网时用缓存
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 静态资源: cache-first
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
