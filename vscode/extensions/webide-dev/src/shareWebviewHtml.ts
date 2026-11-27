/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Amplytic Labs. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * HTML for the "Share on LAN" webview panel.
 *
 * The webview runs on the MAIN thread (RTCPeerConnection is main-thread-only
 * in Chromium) and owns the browser side of the zero-infrastructure preview:
 * it makes the WebRTC offer, renders it as a QR code (vendored
 * qrcode-generator, MIT), accepts the pasted answer, and relays
 * HTTP-over-DataChannel messages to the extension host worker, which pumps
 * them into the in-memory dev server through the nodine preview bridge.
 *
 * `qrLib` is the vendored qrcode-generator source (esbuild text loader) and
 * `appJs` is the panel script below. Both are inlined into ONE nonce'd script
 * tag so the strict CSP keeps working.
 */

const css = `
	:root { color-scheme: light dark; }
	body {
		margin: 0; padding: clamp(12px, 4vw, 28px);
		font-family: var(--vscode-font-family, system-ui, sans-serif);
		font-size: var(--vscode-font-size, 13px);
		color: var(--vscode-foreground, #ccc);
		background: var(--vscode-editor-background, transparent);
		line-height: 1.5;
	}
	h2 { font-size: 1.05em; margin: 0 0 4px; font-weight: 600; }
	.sub { opacity: .75; margin: 0 0 14px; }
	.card {
		border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
		border-radius: 6px; padding: 14px 16px; margin: 0 0 14px;
	}
	.step { display: inline-block; min-width: 1.6em; text-align: center;
		background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
		border-radius: 50%; margin-right: 8px; font-size: .85em; }
	#qrbox { display: flex; justify-content: center; padding: 10px 0; }
	#qrbox img { max-width: min(420px, 88vw); height: auto; image-rendering: pixelated; }
	.code {
		width: 100%; box-sizing: border-box; word-break: break-all;
		font-family: monospace; font-size: 11px; opacity: .8; margin-top: 8px;
	}
	button {
		font-family: inherit; font-size: 12px; cursor: pointer;
		background: var(--vscode-button-secondaryBackground, #3a3d41);
		color: var(--vscode-button-secondaryForeground, #fff);
		border: none; border-radius: 2px; padding: 5px 12px; margin: 6px 4px 0 0;
	}
	button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
	button:disabled { opacity: .45; cursor: default; }
	textarea {
		width: 100%; box-sizing: border-box; min-height: 74px; resize: vertical;
		font-family: monospace; font-size: 11px;
		background: var(--vscode-input-background, #3c3c3c);
		color: var(--vscode-input-foreground, #ccc);
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
		border-radius: 2px; padding: 6px;
	}
	#status { margin: 2px 0 0; font-weight: 600; }
	#status.ok { color: var(--vscode-testing-iconPassed, #73c991); }
	#status.err { color: var(--vscode-testing-iconFailed, #f14c4c); }
	.muted { opacity: .65; font-size: 12px; }
	.hidden { display: none; }
`;

/**
 * Panel script. Deliberately written WITHOUT template literals / backticks so
 * it can be embedded in the HTML template safely. It speaks two protocols:
 *  - webview <-> extension: vscode.postMessage JSON strings
 *  - webview <-> guest:     WebRTC DataChannel, JSON strings, chunk-framed
 */
const appJs = [
	'(function () {',
	"'use strict';",
	'var vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;',
	'var dc = null; var pc = null; var sharedPort = 0;',
	'var chunks = Object.create(null); // sid -> {parts:[], n}',
	'function $(id) { return document.getElementById(id); }',
	'function setStatus(msg, cls) { var el = $("status"); el.textContent = msg; el.className = cls || ""; }',
	'function b64uFromBytes(bytes) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); }',
	'function bytesFromB64u(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var bin = atob(s); var out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }',
	'async function deflateCode(str) { var bytes = new TextEncoder().encode(str); var cs = new CompressionStream("deflate"); var stream = new Blob([bytes]).stream().pipeThrough(cs); var buf = await new Response(stream).arrayBuffer(); return b64uFromBytes(new Uint8Array(buf)); }',
	'async function inflateCode(code) { var bytes = bytesFromB64u(code); var ds = new DecompressionStream("deflate"); var stream = new Blob([bytes]).stream().pipeThrough(ds); var buf = await new Response(stream).arrayBuffer(); return new TextDecoder().decode(buf); }',
	'function iceComplete(pc) { return new Promise(function (resolve) { if (pc.iceGatheringState === "complete") return resolve(); var t = setTimeout(resolve, 2500); pc.addEventListener("icegatheringstatechange", function () { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } }); }); }',
	// chunk-framed DataChannel sender: split long JSON strings into fragments
	'function dcSend(obj) { var s = JSON.stringify(obj); var MAX = 64000; if (s.length <= MAX) { dc.send(s); return; } var sid = "s" + Math.random().toString(36).slice(2); var n = Math.ceil(s.length / MAX); for (var i = 0; i < n; i++) dc.send(JSON.stringify({ t: "chunk", sid: sid, i: i, n: n, d: s.slice(i * MAX, (i + 1) * MAX) })); }',
	'function dcFeed(frame) { if (frame.t === "chunk") { var c = chunks[frame.sid] || (chunks[frame.sid] = { parts: [], n: frame.n }); c.parts[frame.i] = frame.d; if (c.parts.filter(function (p) { return p !== undefined; }).length === c.n) { var full = c.parts.join(""); delete chunks[frame.sid]; return JSON.parse(full); } return null; } return frame; }',
	'function renderQr(text) { try { var qr = qrcode(0, "L"); qr.addData(text, "Byte"); qr.make(); $("qrbox").innerHTML = qr.createImgTag(4, 8); $("offerUrl").textContent = text; } catch (e) { $("qrbox").innerHTML = ""; $("offerUrl").textContent = "(URL too long for a QR code - use the copy button below)"; } }',
	'async function makeOffer() {',
	'  try {',
	'    pc = new RTCPeerConnection({ iceServers: [] });',
	'    dc = pc.createDataChannel("http", { ordered: true });',
	'    wireChannel();',
	'    var offer = await pc.createOffer();',
	'    await pc.setLocalDescription(offer);',
	'    await iceComplete(pc);',
	'    var sdp = pc.localDescription.sdp;',
	'    var code = await deflateCode(sdp);',
	'    var url = $("guestBase").value + "#o=" + code;',
	'    renderQr(url);',
	'    setStatus("Offer ready - scan the QR with your phone (same Wi-Fi), or copy the URL.", "");',
	'  } catch (e) { setStatus("Offer failed: " + e.message, "err"); }',
	'}',
	'async function acceptAnswer() {',
	'  try {',
	'    var raw = $("answerBox").value.trim();',
	'    if (!raw) return;',
	'    var sdp = await inflateCode(raw);',
	'    await pc.setRemoteDescription({ type: "answer", sdp: sdp });',
	'    setStatus("Answer accepted - connecting...", "");',
	'  } catch (e) { setStatus("Bad answer code: " + e.message, "err"); }',
	'}',
	'function wireChannel() {',
	'  dc.onopen = function () {',
	'    setStatus("CONNECTED - your phone can now load the app.", "ok");',
	'    $("answerBox").disabled = true; $("connectBtn").disabled = true;',
	'    if (vscode) vscode.postMessage({ t: "ready" });',
	'  };',
	'  dc.onclose = function () { setStatus("Guest disconnected.", ""); };',
	'  dc.onmessage = function (ev) {',
	'    var msg; try { msg = dcFeed(JSON.parse(ev.data)); } catch (e) { return; }',
	'    if (!msg) return;',
	'    if (msg.t === "req") {',
	'      console.error("[share-panel] guest req", msg.id, msg.method, msg.path);',
	'      var head = msg.method + " " + msg.path + " HTTP/1.1\\r\\nHost: nodine.lan\\r\\n";',
	'      var hs = msg.headers || {};',
	'      for (var k in hs) { if (/^(host|connection|content-length)$/i.test(k)) continue; head += k + ": " + hs[k] + "\\r\\n"; }',
	'      head += "Connection: close\\r\\n\\r\\n";',
	'      if (vscode) vscode.postMessage({ t: "req", id: msg.id, head: head, bodyB64: msg.bodyB64 || null });',
	'    }',
	'  };',
	'}',
	'window.addEventListener("message", function (ev) {',
	'  var m = ev.data || {};',
	'  if (m.t === "init") {',
	'    sharedPort = m.port;',
	'    $("guestBase").value = m.guestBase;',
	'    $("portLabel").textContent = ":" + m.port;',
	'    makeOffer();',
	'  } else if (m.t === "res") {',
	'      console.error("[share-panel] host res", m.id, "len", (m.b64 || "").length, "err", m.err);',
	'    dcSend({ t: "res", id: m.id, b64: m.b64, err: m.err || null });',
	'  }',
	'});',
	'$("copyUrlBtn").addEventListener("click", function () { navigator.clipboard.writeText($("offerUrl").textContent); setStatus("URL copied.", "ok"); });',
	'$("connectBtn").addEventListener("click", acceptAnswer);',
	'$("answerBox").addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) acceptAnswer(); });',
	'}());',
].join('\n');

export function buildSharePanelHtml(nonce: string, qrLib: string): string {
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:;">
	<title>Share on LAN</title>
	<style>${css}</style>
</head>
<body>
	<h2>Share dev server <span id="portLabel"></span> on your local network</h2>
	<p class="sub">Zero infrastructure: the phone connects straight to this browser tab over WebRTC. Works on the same Wi-Fi only; nothing leaves your machine.</p>

	<div class="card">
		<span class="step">1</span><strong>Scan with your phone</strong>
		<p class="muted">Scan this QR with the phone's camera (same Wi-Fi as this computer). It opens the preview page with the connection offer embedded.</p>
		<div id="qrbox"><p class="muted">creating offer&hellip;</p></div>
		<div class="code" id="offerUrl"></div>
		<button id="copyUrlBtn">Copy URL</button>
	</div>

	<div class="card">
		<span class="step">2</span><strong>Paste the answer code from the phone</strong>
		<p class="muted">The phone shows an answer code after it loads. Paste it here and connect.</p>
		<textarea id="answerBox" placeholder="paste the answer code (deflate+base64url)..." spellcheck="false"></textarea>
		<button id="connectBtn" class="primary">Connect</button>
	</div>

	<p id="status" class="muted">Starting&hellip;</p>
	<input type="hidden" id="guestBase" value="">
	<script nonce="${nonce}">${qrLib}</script>
	<script nonce="${nonce}">${appJs}</script>
</body>
</html>`;
}
