/*
 * sw.js — LAN preview proxy service worker (guest side).
 *
 * Scope: /share/. Intercepts fetches under /share/px/<path> (the preview
 * iframe and its subresources) and relays each one to the page that owns the
 * WebRTC DataChannel (the ServiceWorker has no RTC in workers), which pumps
 * it to the host webview -> extension -> runtime dev server. The response
 * comes back as raw bytes + status + headers and is served verbatim.
 */
'use strict';

const PX = '/share/px/';
const pending = new Map(); // reqId -> resolve(Response-init)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
	const url = new URL(e.request.url);
	if (url.origin !== self.location.origin) return;
	if (!url.pathname.startsWith(PX) || e.request.method !== 'GET') return;
	const path = url.pathname.slice(PX.length - 1) + url.search; // keep leading '/'
	e.respondWith(viaClient(path));
});

async function viaClient(path) {
	const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
	if (!clientList.length) return new Response('LAN preview: no connected page', { status: 503 });
	const reqId = 'f' + Math.random().toString(36).slice(2);
	const p = new Promise((resolve) => { pending.set(reqId, resolve); });
	clientList[0].postMessage({ t: 'swfetch', reqId, method: 'GET', path });
	const guard = new Promise((resolve) => setTimeout(() => resolve(null), 30000));
	const r = await Promise.race([p, guard]);
	if (!r) { pending.delete(reqId); return new Response('LAN preview: gateway timeout', { status: 504 }); }
	return new Response(r.body, { status: r.status, headers: r.headers });
}

self.addEventListener('message', (e) => {
	const m = e.data || {};
	if (m.t !== 'swres' || !pending.has(m.reqId)) return;
	const resolve = pending.get(m.reqId);
	pending.delete(m.reqId);
	resolve({ status: m.status, headers: m.headers || {}, body: m.body });
});
