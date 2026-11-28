/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { getContainer } from './nodine';
import { buildSharePanelHtml } from './shareWebviewHtml';
import qrLibSource from './vendor/qrcode-generator.qrjs';

/**
 * "Share on LAN" — zero-infrastructure phone preview (the Expo-QR flow).
 *
 * Architecture (RTCPeerConnection is main-thread-only in Chromium, the
 * supervisor lives in THIS ext-host worker, so the pieces are split by what
 * can live where — every hop uses a supported transport):
 *
 *   phone browser  <--WebRTC DataChannel-->  webview panel (main thread)
 *        webview panel  <--vscode.postMessage JSON-->  this file (worker)
 *          this file  <--MessageChannel preview protocol-->  supervisor
 *            supervisor  <--per-port channel, raw HTTP-->  runtime worker
 *
 * This module claims the supervisor's preview bridge slot directly
 * (container.__sup.initPreviewSW) — in the ext-host context the SDK never
 * registers sw-nodine.js (no navigator.serviceWorker in a worker), so the
 * slot is free and this module acts as the bridge holder: it receives the
 * per-port MessagePorts the runtime worker creates on listen(), acks them,
 * and speaks the raw-HTTP preview-req/preview-res wire protocol.
 */

interface PendingRequest {
	chunks: Uint8Array[];
	resolve: (r: { b64: string; err?: string }) => void;
	idleTimer?: ReturnType<typeof setTimeout>;
	contentLen?: number; // from the response head; undefined until parsed
	headBytes?: number;  // header block size once found
}

interface BridgeHandle {
	sid: string;
	hasPort(port: number): boolean;
	listPorts(): { port: number; argv: string[] }[];
	request(port: number, head: string, bodyBytes: Uint8Array | null): Promise<{ b64: string; err?: string }>;
}

let bridge: BridgeHandle | null = null;
let panel: vscode.WebviewPanel | null = null;
let reqSeq = 0;
// Module scope: finishPending/settleIfComplete run from the per-port
// onmessage handlers (set up inside ensurePreviewBridge) — the pending map
// must outlive that call and be reachable from them.
const pending = new Map<string, PendingRequest>();

function finishPending(id: string, p: PendingRequest): void {
	if (!pending.has(id)) { return; }
	pending.delete(id);
	if (p.idleTimer) { clearTimeout(p.idleTimer); }
	const total = p.chunks.reduce((n, c) => n + c.length, 0);
	const all = new Uint8Array(total);
	let off = 0;
	for (const c of p.chunks) { all.set(c, off); off += c.length; }
	p.resolve({ b64: bytesToB64(all) });
}

/** True when the accumulated bytes satisfy the response's Content-Length. */
function settleIfComplete(p: PendingRequest): boolean {
	if (p.contentLen === undefined && p.chunks.length) {
		const head = findHeaderEnd(p.chunks);
		if (head >= 0) {
			p.headBytes = head;
			const headText = new TextDecoder().decode(concatChunks(p.chunks, head));
			const m = headText.match(/content-length:\s*(\d+)/i);
			p.contentLen = m ? parseInt(m[1], 10) : -1; // -1: no CL (close-delimited)
		}
	}
	if (p.contentLen !== undefined && p.contentLen >= 0 && p.headBytes !== undefined) {
		const bodySoFar = p.chunks.reduce((n, c) => n + c.length, 0) - p.headBytes;
		if (bodySoFar >= p.contentLen) { return true; }
	}
	return false;
}

function findHeaderEnd(chunks: Uint8Array[]): number {
	const lim = Math.min(chunks.reduce((n, c) => n + c.length, 0), 64 * 1024);
	const all = concatChunks(chunks, lim);
	for (let i = 0; i + 3 < all.length; i++) {
		if (all[i] === 13 && all[i + 1] === 10 && all[i + 2] === 13 && all[i + 3] === 10) { return i + 4; }
	}
	return -1;
}

function concatChunks(chunks: Uint8Array[], limit: number): Uint8Array {
	const all = new Uint8Array(limit);
	let off = 0;
	for (const c of chunks) {
		const take = Math.min(c.length, limit - off);
		all.set(c.subarray(0, take), off);
		off += take;
		if (off >= limit) { break; }
	}
	return all;
}

function bytesToB64(bytes: Uint8Array): string {
	let bin = '';
	const STEP = 0x8000;
	for (let i = 0; i < bytes.length; i += STEP) {
		bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
	}
	return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
	return out;
}

/** Claim the supervisor's free preview-bridge slot (idempotent). */
function ensurePreviewBridge(): BridgeHandle {
	if (bridge) { return bridge; }
	const container = getContainer();
	const sup: any = container ? (container as any).__sup : null;
	if (!sup || typeof sup.initPreviewSW !== 'function') {
		throw new Error('Nodine runtime is not booted yet — start the dev environment first.');
	}

	const sid = crypto.randomUUID();
	const chan = new MessageChannel();
	const perPort = new Map<number, MessagePort>();
	let onPortsChanged: (() => void) | null = null;

	chan.port2.onmessage = (ev: MessageEvent) => {
		const m = ev.data || {};
		console.error('[lanShare] bridge msg:', m.type, 'port:', m.port, 'ports:', ev.ports ? ev.ports.length : 0);
		if (m.type === 'preview-port-open') {
			const pp: MessagePort | undefined = ev.ports && ev.ports[0];
			if (!pp) { return; }
			pp.onmessage = (e2: MessageEvent) => {
				const r = e2.data || {};
				console.error('[lanShare] pp msg:', r.type, r.id, 'chunkBytes:', r.bytes ? r.bytes.byteLength || r.bytes.length : 0);
				const p = pending.get(r.id);
				if (!p) { return; }
				if (r.type === 'preview-res') {
					p.chunks.push(new Uint8Array(r.bytes));
					// The runtime's end-of-response signal can be missed (the
					// one-shot 'request' emit patch predates the parser's
					// async 'request' emit), so the relay detects completion
					// itself: Content-Length accounting + a short idle timer.
					if (settleIfComplete(p)) {
						finishPending(r.id, p);
					} else {
						if (p.idleTimer) { clearTimeout(p.idleTimer); }
						p.idleTimer = setTimeout(() => { if (pending.has(r.id)) { finishPending(r.id, p); } }, 350);
					}
				} else if (r.type === 'preview-open-req') {
					// an already-listening server re-asserting its channel
					// (listenViaSW's early registration path) — ack it.
					pp.postMessage({ type: 'preview-open-ack' });
				} else if (r.type === 'preview-res-end') {
					finishPending(r.id, p);
				} else if (r.type === 'preview-res-err') {
					pending.delete(r.id);
					if (p.idleTimer) { clearTimeout(p.idleTimer); }
					p.resolve({ b64: '', err: String(r.error || 'preview error') });
				}
			};
			pp.start?.();
			// the runtime worker waits up to 10s for this before giving up
			pp.postMessage({ type: 'preview-open-ack' });
			perPort.set(m.port, pp);
			if (onPortsChanged) { onPortsChanged(); }
		} else if (m.type === 'preview-port-close') {
			const pp = perPort.get(m.port);
			if (pp) { try { pp.close(); } catch { /* already closed */ } }
			perPort.delete(m.port);
			if (onPortsChanged) { onPortsChanged(); }
		}
		// 'preview-worker-chan' is topology bookkeeping — nothing to do.
	};
	chan.port2.start?.();

	// The SW-substitute slot: from now on the supervisor forwards every
	// per-port channel (listen()) to chan.port2 — including the REPLAY from
	// workers whose servers dark-listened before this bridge existed
	// (nodine 0.5.2 broadcasts a preview-sw-port to them on attach).
	sup.initPreviewSW(sid, chan.port1);
	// listen()/close() registry events fire for dark servers too — used to
	// refresh the port picker (the SDK never set this in the worker context).
	sup.onPreviewEvent = () => { if (onPortsChanged) { onPortsChanged(); } };

	bridge = {
		sid,
		hasPort: (port) => perPort.has(port),
		listPorts: () => {
			const reg: Map<number, { pid: number; argv: string[] }> = sup.previewPorts;
			const out: { port: number; argv: string[] }[] = [];
			if (reg && typeof reg.forEach === 'function') {
				reg.forEach((v, port) => { out.push({ port, argv: (v && v.argv) || [] }); });
			}
			return out.sort((a, b) => a.port - b.port);
		},
		request: (port, head, bodyBytes) => new Promise((resolve) => {
			const pp = perPort.get(port);
			if (!pp) { resolve({ b64: '', err: 'no live bridge for port ' + port }); return; }
			const id = 'r' + (++reqSeq);
			pending.set(id, { chunks: [], resolve });
			console.error('[lanShare] posting preview-req', id, 'on port', port, 'head:', head.split('\r\n')[0]);
			pp.postMessage({ type: 'preview-req', id, head, body: bodyBytes || undefined });
			// dev servers hang sometimes; fail the exchange after 30s
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					resolve({ b64: '', err: 'timeout (30s) waiting for the dev server' });
				}
			}, 30000);
		}),
	};
	return bridge;
}

function appOrigin(): string {
	// Mirrors nodine.ts: the extension URI is always served from the app
	// origin in web builds; the ext-host worker itself has a blob: base.
	const ext = vscode.extensions.getExtension('amplytic.webide-dev') ?? vscode.extensions.getExtension('webide-dev');
	const extUri = ext?.extensionUri?.toString() ?? '';
	const u = new URL(extUri);
	return u.origin;
}

async function waitForLivePort(b: BridgeHandle, port: number, ms: number): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (b.hasPort(port)) { return true; }
		await new Promise((r) => setTimeout(r, 250));
	}
	return b.hasPort(port);
}

/**
 * Command entry: pick a listening port, attach the bridge, open the panel.
 */
export async function shareOnLan(): Promise<void> {
	console.error('[lanShare] command invoked');
	let b: BridgeHandle;
	try {
		b = ensurePreviewBridge();
	} catch (e) {
		vscode.window.showErrorMessage('Share on LAN: ' + (e instanceof Error ? e.message : String(e)));
		return;
	}

	console.error('[lanShare] share using container', (getContainer() as any)?.__bootTag);
	console.error('[lanShare] bridge ok, ports:', JSON.stringify(b.listPorts()));
	const ports = b.listPorts();
	let chosen: number;
	if (ports.length === 0) {
		const s = await vscode.window.showInputBox({
			prompt: 'Port to share (start your dev server first so it appears here)',
			placeHolder: '3000',
		});
		if (!s) { return; }
		chosen = Number(s);
		if (!Number.isFinite(chosen) || chosen <= 0 || chosen > 65535) { return; }
	} else if (ports.length === 1) {
		chosen = ports[0].port;
	} else {
		const picks = ports.map((p) => ({
			label: ':' + p.port,
			description: (p.argv && p.argv.length ? p.argv.join(' ') : '') || 'listening',
			port: p.port,
		}));
		const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Which dev server do you want to share?' });
		if (!pick) { return; }
		chosen = pick.port;
	}

	// The shared port may not be live yet (nothing listening, or a server the
	// user is about to (re)start). nodine 0.5.2 re-registers dark servers when
	// the bridge attaches; servers started after the attach register on
	// listen(). The panel is usable immediately either way — requests resolve
	// as soon as the port comes live.
	if (!b.hasPort(chosen)) {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Share on LAN: attaching bridge for :${chosen}` },
			() => waitForLivePort(b, chosen, 4000),
		);
	}

	if (panel) {
		panel.reveal();
	} else {
		panel = vscode.window.createWebviewPanel('nodineLanShare', `LAN share :${chosen}`, { viewColumn: vscode.ViewColumn.Beside }, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		panel.onDidDispose(() => { panel = null; });
		panel.webview.onDidReceiveMessage(async (m) => {
			if (!panel || !m || m.t !== 'req') { return; }
			console.error('[lanShare] relay req', m.id, 'live:', bridge!.hasPort(chosen));
			const r = await bridge!.request(chosen, String(m.head || ''), m.bodyB64 ? b64ToBytes(String(m.bodyB64)) : null);
			console.error('[lanShare] relay res', m.id, 'err:', r.err || 'none', 'len:', r.b64.length);
			panel.webview.postMessage({ t: 'res', id: m.id, b64: r.b64, err: r.err || null });
		});	}

	panel.title = `LAN share :${chosen}`;
	panel.webview.html = buildSharePanelHtml(getNonce(), qrLibSource);
	// the webview makes the offer as soon as it learns the guest base URL
	await new Promise((r) => setTimeout(r, 120));
	panel.webview.postMessage({ t: 'init', port: chosen, guestBase: appOrigin() + '/share/' });
	vscode.window.showInformationMessage(
		`Sharing :${chosen} on your local network. Scan the QR from the panel with your phone (same Wi-Fi).`,
	);
}

function getNonce(): string {
	let s = '';
	while (s.length < 32) { s += Math.random().toString(36).slice(2); }
	return s.slice(0, 32);
}

/** Exposed for tests / teardown. */
export function disposeShareSession(): void {
	try { panel?.dispose(); } catch { /* ignore */ }
	panel = null;
}
