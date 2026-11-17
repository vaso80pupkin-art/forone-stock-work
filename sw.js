/**
 * Service Worker приложения FORONE.KZ · Склад.
 *
 * Стратегия важна для рабочих телефонов:
 *  · код приложения (HTML/JS/CSS) — сначала сеть, кэш как запас. Иначе после
 *    обновления на складе люди продолжали бы работать на старой логике;
 *  · тяжёлые библиотеки (распознавание, XLSX) и иконки — сначала кэш, они не меняются;
 *  · запросы к Google (импорт и Web App) проходят напрямую, мы их не кэшируем:
 *    остатки должны быть свежими, а не вчерашними.
 */
const CACHE_NAME = 'forone-stock-work-v24';
const APP_SHELL = [
  './', './index.html', './styles.css', './app.js', './sync-queue.js', './visual-recognition.js',
  './manifest.json', './manus-routes.json', './vendor/html5-qrcode.min.js', './vendor/xlsx.full.min.js'
];
const IMMUTABLE = ['/vendor/', '/icons/', '/icon-', 'manifest.json', 'manus-routes.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('forone-stock-work-') && key !== CACHE_NAME).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

function isImmutable(url) {
  return IMMUTABLE.some((part) => url.pathname.includes(part));
}

function fromNetworkFirst(request) {
  return fetch(request).then((response) => {
    if (response && response.ok) {
      caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    }
    return response;
  }).catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')));
}

function fromCacheFirst(request) {
  return caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response && response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    return response;
  }));
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Чужие запросы (Google Sheets, Apps Script, распознавание) не перехватываем:
  // синхронизация обязана идти в сеть, а не в локальный кэш.
  if (url.origin !== self.location.origin) return;

  if (isImmutable(url)) {
    event.respondWith(fromCacheFirst(event.request));
    return;
  }
  event.respondWith(fromNetworkFirst(event.request));
});
