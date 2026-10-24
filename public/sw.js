// RacingHub app service worker (Oct 2026, per Dinesh: install the dashboard
// as an app on PC and phone, alerts even when it's closed).
// - Pages always come from the server (live data); with no connection the
//   app shows offline.html instead of the browser's error page.
// - Race alerts pushed by the server show as system notifications; a click
//   opens (or focuses) the app on that race.
const CACHE = 'rdd-shell-v1';
const OFFLINE_URL = '/offline.html';
const SHELL = [OFFLINE_URL, '/icons/icon-192.png', '/icons/badge-96.png', '/logo.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Race alert', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: d.url || '/', title: d.title || '', body: d.body || '', tag: d.tag || '', snooze: d.snooze || null },
    actions: d.snooze ? SNOOZE_ACTIONS : [],
    timestamp: Date.now(),
  }));
});

// Snooze buttons (25 Oct 2026): PC (Chrome / Edge) and Android show them;
// iPhone doesn't, so there the bell's snooze is used. The server brings the
// alert back after the time if it's still open.
const SNOOZE_ACTIONS = [{ action: 'snooze10', title: 'Snooze 10 min' }, { action: 'snooze30', title: 'Snooze 30 min' }];
function snooze(n, minutes) {
  const d = n.data || {};
  return self.registration.pushManager.getSubscription().catch(() => null).then((sub) => fetch('/api/alerts/snooze-push', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      minutes,
      endpoint: sub ? sub.endpoint : null,
      item: { ...d.snooze, title: String(d.title || '').replace(/^⏰ /, ''), body: d.body, url: d.url, tag: d.tag },
    }),
  })).catch(() => {});
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'snooze10' || event.action === 'snooze30') {
    event.waitUntil(snooze(event.notification, event.action === 'snooze10' ? 10 : 30));
    return;
  }
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const mine = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (mine) {
      return mine.focus().then((c) => (c && 'navigate' in c ? c.navigate(url) : null)).catch(() => self.clients.openWindow(url));
    }
    return self.clients.openWindow(url);
  }));
});
