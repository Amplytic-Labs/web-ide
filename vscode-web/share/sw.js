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
	// Broadcast the request to EVERY controlled window client: proxied
	// documents (the px iframe) become clients themselves, and they have no
	// swfetch handler — a fixed clientList[0] could pick the iframe and hang
	// until the guard timeout. The page that owns the DataChannel answers;
	// the pending entry is resolved by whichever swres arrives first.
	for (const c of clientList) {
		try { c.postMessage({ t: 'swfetch', reqId, method: 'GET', path }); } catch { /* gone */ }
	}
	const guard = new Promise((resolve) => setTimeout(() => resolve(null), 30000));
	const r = await Promise.race([p, guard]);
	if (!r) { pending.delete(reqId); return new Response('LAN preview: gateway timeout', { status: 504 }); }
	// Normalize the body to an ArrayBuffer: postMessage's structured clone
	// hands us a (detached-view-safe) Uint8Array, but a NAVIGATION Response
	// (iframe src) built from a typed array can fail to commit in Chromium —
	// its body stream requires a proper ArrayBuffer source.
	let body = r.body;
	if (body && typeof body === 'object') {
		if (body instanceof ArrayBuffer) { /* already fine */ }
		else if (ArrayBuffer.isView(body)) { body = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); }
		else if (Array.isArray(body)) { const u8 = new Uint8Array(body); body = u8.buffer; }
		else { body = new TextEncoder().encode(String(body)).buffer; }
	}
	const headers = new Headers(r.headers || {});
	// COEP: the guest page is served COOP/COEP-credentialless (required for
	// the runtime's SharedArrayBuffer); a same-origin iframe navigation from
	// a COEP page is blocked unless the response carries COEP too — without
	// these headers the iframe shows chrome-error://chromewebdata.
	headers.set('cross-origin-embedder-policy', 'credentialless');
	headers.set('cross-origin-opener-policy', 'same-origin');
	return new Response(body, { status: r.status, headers });
}

self.addEventListener('message', (e) => {
	const m = e.data || {};
	if (m.t !== 'swres' || !pending.has(m.reqId)) return;
	const resolve = pending.get(m.reqId);
	pending.delete(m.reqId);
	resolve({ status: m.status, headers: m.headers || {}, body: m.body });
});
