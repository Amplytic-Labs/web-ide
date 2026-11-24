/* sw-nodine.js — the Nodine browser preview gateway.
 *
 * B1-PREVIEW (batch 1 of the package/app separation). This is the
 * fully-browser preview transport: an http.Server.listen() inside the
 * runtime reaches the BROWSER through this same-origin service worker —
 * no host server, no external proxy, no tunnel. (The
 * Nodines architecture maps their *.nodine-api.io preview domain
 * onto the same mechanism at StackBlitz; ours stays on the app's own origin.)
 *
 * URL scheme:   /preview/<sid>/<port>/<path...>?<query>
 *   sid  = per-page-load session id (crypto.randomUUID, owned by the page)
 *   port = the VIRTUAL port the in-runtime server listen()ed on
 * Scoping: a fetch is served ONLY if (sid, port) is registered by the live
 * page session — no open proxy, no cross-session reach, no network egress.
 *
 * Message topology (corrected design):
 *   page → SW (navigator.serviceWorker.controller):
 *     {type:'preview-bridge', sid}                 — this session is live
 *     {type:'preview-port-open', sid, port}   [transfer: worker-side port]
 *     {type:'preview-port-close', sid, port}
 *   worker → SW (on the per-port channel that page forwarded):
 *     {type:'preview-open-req', port}              — worker wants to listen
 *     {type:'preview-res', id, bytes}              — response bytes (CLONE)
 *     {type:'preview-res-end', id} | {type:'preview-res-err', id, error}
 *   SW → worker (same per-port channel):
 *     {type:'preview-open-ack'}                    — port registered
 *     {type:'preview-req', id, head, body}         — an HTTP request
 *
 * Root-relative subresources: a client that consumed a preview response is
 * remembered (resultingClientId → {sid, port}); its later root-relative
 * requests (/favicon.ico, /api/x) are reinterpreted under that preview's
 * prefix — the trick a subdomain-based preview gets for free.
 *
 * Batch-1 limitations (docs/PREVIEW.md): no WebSocket pass-through (WS
 * bypasses service workers), one live bridge session per SW (a fresh page
 * load claims it and clears stale registrations), no client-abort
 * propagation, listen(0) ephemeral ports unsupported, no SW for non-secure
 * origins (on such origins registration fails gracefully and listen()
 * dark-listens inside the runtime).
 */
'use strict';

const sessions = new Map();    // sid -> Map(port -> MessagePort to worker)
const clientHints = new Map(); // clientId -> { sid, port }
const workerChans = new Set(); // per-worker channels (kept alive, batch 1)
let bridgeSid = null;          // the session currently owning this SW
let bridgePort = null;         // the live session's supervisor-side port
let forwardErrs = null;        // 'all' | 'exceptions' | null — per-session error-forwarding mode
let reqSeq = 0;
const pending = new Map();     // id -> response parser record

const PREVIEW_RE = /^\/preview\/([A-Za-z0-9-]+)\/(\d+)(\/.*)?$/;

// ---------------------------------------------------------------------------
// M1.5 preview error capture.
//
// When the host boots with forwardPreviewErrors enabled, the SW injects a
// capture script into text/html preview responses. The script runs before
// any page script (injected right after <head…>), binds window.onerror,
// unhandledrejection and console.error, and reports through a NAMESPACED
// postMessage protocol back to THIS worker, which validates sid/port/shape
// and forwards the event to the page over the supervisor bridge port. The
// page SDK then emits 'preview-message'.
//
// Injection is stream-safe: HTML documents are consumed chunk-by-chunk, so
// the injector buffers only until </head> is seen (or a cap), rewrites the
// first buffer, and passes everything after through untouched. The
// content-length header is dropped on injection (the body grows; the
// browser would reject a short body).
// ---------------------------------------------------------------------------
const HOOK_MARKER = '__nodine_preview_hook';

// The capture script, serialized once. Runs with the page's own privileges,
// so it must never throw into the page: every handler is guarded and the
// whole install is wrapped in try/catch (an error inside the capture itself
// is never re-captured — no recursion). Session binding (sid/port/mode)
// rides as data-* attributes ON the injected <script> tag and is read once
// at install time via document.currentScript — self-contained, no reliance
// on page markup.
const CAPTURE_SRC = `(function(){try{
var me=document.currentScript;
var SID=me&&me.getAttribute('data-sid')||null;
var PORT=me&&Number(me.getAttribute('data-port'))||null;
var MODE=me&&me.getAttribute('data-mode')||'all';
if(!SID||!PORT)return;
try{window.__nodine_hook_installed=1}catch(_){};
var send=function(kind,payload){
  try{
    var c=navigator.serviceWorker&&navigator.serviceWorker.controller;
    if(!c)return;
    payload.sid=SID;payload.port=PORT;
    c.postMessage({__nodine_preview:1,kind:kind,payload:payload});
  }catch(e){}
};
var meta=function(){try{
  return {sid:SID,port:PORT,pathname:location.pathname,
          search:location.search,hash:location.hash};
}catch(e){return null;}};
window.addEventListener('error',function(ev){
  try{
    var e=ev&&ev.error;
    send('uncaught',{message:ev.message||String((e&&e.message)||e),
      filename:ev.filename||null,line:ev.lineno||null,column:ev.colno||null,
      stack:(e&&e.stack)||null,meta:meta()});
  }catch(_){}
},true);
window.addEventListener('unhandledrejection',function(ev){
  try{
    var r=ev&&ev.reason;
    var msg=(r&&r.message)||(typeof r==='string'?r:String(r));
    send('rejection',{message:msg,
      stack:(r&&r.stack)||null,meta:meta()});
  }catch(_){}
},true);
if(MODE!=='exceptions'){
  var ce=console.error,armed=true;
  console.error=function(){
    try{
      if(armed){
        armed=false;
        try{
          var parts=[],a=arguments;
          for(var i=0;i<a.length;i++){
            var v=a[i];
            try{parts.push(typeof v==='string'?v:((v&&v.stack)||String(v)))}
            catch(_){parts.push('[unserializable]')}
          }
          send('console',{message:parts.join(' '),meta:meta()});
        }catch(_){}
        armed=true;
      }
    }catch(_){}
    return ce.apply(console,arguments);
  };
}
}catch(e){}
})();`;

// Wait-free detection of the </head> close tag within the first buffers.
const HEAD_CLOSE_RE = /<\/head\s*>/i;

function contentTypeOf(headers) {
  for (const [k, v] of headers) if (k.toLowerCase() === 'content-type') return v;
  return null;
}

/**
 * Wrap a preview Response (already fully parsed by makeResponseParser) with
 * an HTML injector when this session asked for error forwarding. Only
 * text/html documents are touched, and only when the buffer strategy can
 * prove it saw the end of <head> (the script must precede page scripts).
 * Non-injectable documents pass through untouched — forwarding then simply
 * covers scripts that run in already-hooked documents (e.g. the top page
 * navigated from an injected one — document.open-style rewrites are NOT
 * re-injected; see the M1.5 report limitations).
 */
async function maybeInjectHook(resp, sid, port, mode) {
  if (!mode) return resp;
  const ct = contentTypeOf(resp.headers);
  if (!ct || !/text\/html/i.test(ct)) return resp;
  // CSP that forbids inline scripts would kill the hook: still inject (the
  // page's own CSP decisions are the app author's), but the report notes it.
  const headers = new Headers(resp.headers);
  headers.delete('content-length'); // body grows; short body = network error
  if (!resp.body) {
    // Empty/absent body (HEAD-like): nothing to hook.
    return new Response(resp.body, { status: resp.status, headers });
  }
  const reader = resp.body.getReader();
  let head = new Uint8Array(0);
  let injected = false;
  const cap = 262144; // 256 KiB: a <head> larger than this is not a head we trust
  const injectAt = (u8, idx) => {
    // The script tag carries its own session binding as data-* attributes;
    // the capture script reads them via document.currentScript at install.
    const enc = new TextEncoder();
    const pre = u8.subarray(0, idx);
    const post = u8.subarray(idx);
    const tag = '<script id="' + HOOK_MARKER + '" data-sid="' + sid + '" data-port="' + port + '" data-mode="' + (mode === 'all' ? 'all' : 'exceptions') + '">' + CAPTURE_SRC + '</' + 'script>';
    const script = enc.encode(tag);
    const out = new Uint8Array(pre.length + script.length + post.length);
    out.set(pre, 0); out.set(script, pre.length); out.set(post, pre.length + script.length);
    return out;
  };
  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!injected) {
            head = head.length ? concatU8(head, value) : value;
            if (head.length > cap) {
              // No </head> in a reasonable prefix: pass through as-is.
              ctrl.enqueue(head);
              head = new Uint8Array(0);
              injected = 'gave-up';
            } else {
              const s = new TextDecoder('utf-8', { fatal: false }).decode(head);
              const m = HEAD_CLOSE_RE.exec(s);
              if (m) {
                // Byte offset of the END of the match: decode is lossless for
                // the prefix only when it ends on a char boundary; if the
                // chunk ends mid-multibyte the regex can't have matched there,
                // so m.index + match length is always within valid bytes.
                const byteIdx = new TextEncoder().encode(s.slice(0, m.index + m[0].length)).length;
                ctrl.enqueue(injectAt(head, byteIdx));
                head = new Uint8Array(0);
                injected = true;
              }
              continue; // keep buffering until </head> or cap
            }
          }
          if (value && value.length) ctrl.enqueue(value);
        }
        if (head.length) ctrl.enqueue(head); // tail of a never-injected doc
        ctrl.close();
      } catch (e) {
        try { ctrl.error(e); } catch {}
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    },
    cancel(reason) {
      try { reader.cancel(reason); } catch {}
    },
  });
  return new Response(stream, { status: resp.status, headers });
}

// A namespaced message from a preview document (the injected hook). These
// arrive on the SW GLOBAL message listener — unlike page control messages
// they carry no transferred ports and are identified ONLY by the protocol
// key __nodine_preview. Validation is strict: current session, live port,
// known kind, sane strings. Anything else is ignored (never fatal — an
// untrusted page must not be able to crash or confuse the gateway).
function isHookMsg(m) {
  return !!(m && typeof m === 'object' && m.__nodine_preview === 1 &&
    typeof m.kind === 'string');
}
function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : null;
}
function onHookMessage(m, clientId) {
  if (!forwardErrs || !bridgeSid || !bridgePort) return;
  const p = m.payload;
  if (!p || typeof p !== 'object') return;
  const kinds = { uncaught: 1, rejection: 1, console: 1 };
  if (!kinds[m.kind]) return;
  if (m.kind === 'console' && forwardErrs !== 'all') return; // exceptions-only
  const meta = p.meta;
  if (!meta || typeof meta !== 'object') return;
  const sid = str(meta.sid, 128);
  if (!sid || sid !== bridgeSid) return;                     // wrong session
  const port = Number(meta.port);
  if (!Number.isInteger(port) || !(sessions.get(sid) || new Map()).has(port)) {
    return; // port not registered in this session → not ours
  }
  const message = str(p.message, 8192);
  if (!message) return;
  // Chromium prefixes uncaught messages with 'Uncaught ' on the error
  // event; the host wants the raw message.
  const clean = m.kind === 'uncaught' ? message.replace(/^Uncaught /, '') : message;
  const ev = {
    type: 'preview-error',
    sid,
    port,
    kind: m.kind,
    message: clean,
    pathname: str(meta.pathname, 2048),
    search: str(meta.search, 2048),
    hash: str(meta.hash, 2048),
    clientId: clientId || null,
  };
  if (m.kind === 'uncaught') {
    ev.filename = str(p.filename, 2048);
    ev.line = Number.isFinite(p.line) ? p.line : null;
    ev.column = Number.isFinite(p.column) ? p.column : null;
    ev.stack = str(p.stack, 32768);
  } else if (m.kind === 'rejection') {
    ev.stack = str(p.stack, 32768);
  }
  try { bridgePort.postMessage(ev); } catch {}
}

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (ev) => { ev.waitUntil(self.clients.claim()); });

function textResp(status, body) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  // -- M1.5 hook traffic (injected capture script) --------------------------
  // Identified ONLY by the namespaced protocol key; never trusted further
  // than onHookMessage's validation allows. These come from PREVIEW pages
  // (same-origin, served by this SW) — cross-origin iframes have their own
  // controller and their messages can't reach this listener (documented
  // limitation in the M1.5 report).
  if (isHookMsg(m)) { onHookMessage(m, ev.source && ev.source.id); return; }
  // -- page control (navigator.serviceWorker.controller) -------------------
  // preview-bridge: the page hands over the SUPERVISOR-side port. Everything
  // the supervisor forwards afterwards (preview-port-open with a transferred
  // worker port, preview-port-close, preview-worker-chan) arrives ON THIS
  // PORT's message event — NOT back here on the SW global listener.
  if (m.type === 'preview-bridge') {
    const p = ev.ports && ev.ports[0];
    if (!p) return;
    // A fresh page load claims the bridge: drop everything registered by
    // earlier (dead) sessions. Known batch-1 limitation: two simultaneously
    // live tabs cannot both serve previews (the newest load wins).
    if (bridgeSid && bridgeSid !== m.sid) {
      for (const [, ports] of sessions) for (const [, q] of ports) { try { q.close(); } catch {} }
      sessions.clear();
    }
    bridgeSid = m.sid;
    bridgePort = p;
    // M1.5: error-forwarding mode for THIS session. 'all' → console.error
    // too; 'exceptions' → uncaught + rejections only; absent/false → no
    // injection at all (the default: hosts opt in).
    forwardErrs = m.forwardErrors === 'all' ? 'all'
      : (m.forwardErrors === 'exceptions' || m.forwardErrors === true) ? 'exceptions'
        : null;
    if (!sessions.has(m.sid)) sessions.set(m.sid, new Map());
    p.onmessage = (bev) => onBridgeMsg(bev, m.sid);
    p.start && p.start();
    return;
  }
  // M1.5: session teardown — the SDK container was destroyed; the SW drops
  // the session's registrations and its bridge so late hook messages from
  // still-open preview tabs find nothing to talk to (stale listeners must
  // not fire and ports must not leak).
  if (m.type === 'preview-bridge-end') {
    if (bridgeSid && bridgeSid === m.sid) {
      const sess = sessions.get(m.sid);
      if (sess) for (const [, q] of sess) { try { q.close(); } catch {} }
      sessions.delete(m.sid);
      try { bridgePort && bridgePort.close(); } catch {}
      bridgeSid = null; bridgePort = null; forwardErrs = null;
      if (ev.source && ev.source.id) clientHints.delete(ev.source.id);
    }
    return;
  }
});

function onBridgeMsg(ev, sid) {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'preview-port-open') {
    const workerSide = ev.ports && ev.ports[0];
    if (!workerSide) return;
    let sess = sessions.get(sid);
    if (!sess) { sess = new Map(); sessions.set(sid, sess); }
    const old = sess.get(m.port);
    if (old) { try { old.close(); } catch {} }
    sess.set(m.port, workerSide);
    workerSide.onmessage = (wev) => onWorkerMsg(wev.data, workerSide, sid, m.port);
    workerSide.start && workerSide.start();
    // Registration ack — listenViaSW emits 'listening' when it arrives (a
    // 10 s silence means no bridge ever formed → dark-listen fallback).
    try { workerSide.postMessage({ type: 'preview-open-ack' }); } catch {}
    return;
  }
  if (m.type === 'preview-port-close') {
    const sess = sessions.get(sid);
    if (!sess) return;
    const p = sess.get(m.port);
    if (p) { try { p.close(); } catch {} }
    sess.delete(m.port);
    return;
  }
  if (m.type === 'preview-worker-chan') {
    // Per-worker channel handed to the SW at spawn (init.previewSWPort's
    // partner). Batch 1 keeps it merely ALIVE (the worker's direct line for
    // future SW→worker notices; per-port traffic uses the per-port channels).
    const p = ev.ports && ev.ports[0];
    if (p) { p.start && p.start(); workerChans.add(p); }
    return;
  }
}

function onWorkerMsg(m, port, sid, portNo) {
  if (!m || typeof m !== 'object') return;
  // listenViaSW closes over this channel's worker side; the channel existing
  // IS the registration. Ack so the server can emit 'listening' — and to
  // signal "a real bridge exists" (10 s without an ack = no SW → fallback).
  if (m.type === 'preview-open-req') {
    port.postMessage({ type: 'preview-open-ack' });
    return;
  }
  const rec = pending.get(m.id);
  if (!rec) return;
  if (m.type === 'preview-res') { rec.onBytes(m.bytes); return; }
  if (m.type === 'preview-res-end') { rec.onEnd(); return; }
  if (m.type === 'preview-res-err') { rec.onError(m.error); return; }
}

self.addEventListener('fetch', (event) => {
  let url;
  try { url = new URL(event.request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  const m = PREVIEW_RE.exec(url.pathname);
  if (m) {
    const sid = m[1];
    const port = Number(m[2]);
    const path = (m[3] || '/') + url.search;
    if (event.resultingClientId) clientHints.set(event.resultingClientId, { sid, port });
    event.respondWith(servePreview(event.request, sid, port, path));
    return;
  }
  // root-relative subresource from a preview client → same preview prefix
  const hint = (event.resultingClientId && clientHints.get(event.resultingClientId))
    || clientHints.get(event.clientId);
  if (hint && !PREVIEW_RE.test(url.pathname)) {
    event.respondWith(servePreview(event.request, hint.sid, hint.port, url.pathname + url.search));
  }
});

async function servePreview(request, sid, port, path) {
  const sess = sessions.get(sid);
  const chan = sess && sess.get(port);
  if (!chan) {
    return textResp(503, 'nodine preview: port ' + port +
      ' is not open in session ' + String(sid).slice(0, 8) + '…');
  }
  // M1.5: this session's error-forwarding mode (null = disabled).
  const mode = (sid === bridgeSid && forwardErrs) ? forwardErrs : null;
  const id = ++reqSeq;
  const p = new Promise((resolve, reject) => {
    pending.set(id, makeResponseParser(resolve, reject, id));
  });
  // Watchdog: headers not received within 30 s → 504-ish failure (an app
  // that never responds must not hang the tab forever).
  const wd = setTimeout(() => {
    const rec = pending.get(id);
    if (rec && !rec.resolved) {
      pending.delete(id);
      rec.reject(new Error('preview upstream timeout'));
    }
  }, 30000);
  p.finally(() => clearTimeout(wd)).catch(() => {});
  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? await request.arrayBuffer() : null;
    let head = request.method + ' ' + (path || '/') + ' HTTP/1.1\r\nhost: preview\r\n';
    for (const [k, v] of request.headers) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'content-length' || lk === 'connection' ||
          lk === 'transfer-encoding' || lk === 'keep-alive' || lk === 'upgrade') continue;
      head += k + ': ' + v + '\r\n';
    }
    if (body) head += 'content-length: ' + body.byteLength + '\r\n';
    head += '\r\n';
    chan.postMessage({ type: 'preview-req', id, head, body });
  } catch (e) {
    pending.delete(id);
    return textResp(502, 'preview request serialization failed: ' + (e && e.message));
  }
  // M1.5: HTML documents of error-forwarding sessions get the capture hook.
  if (mode) {
    try { return await maybeInjectHook(await p, sid, port, mode); }
    catch { return textResp(502, 'preview upstream error'); }
  }
  return p;
}

// ---------------------------------------------------------------------------
// Incremental HTTP/1.1 RESPONSE parser: raw bytes from the runtime worker
// (exactly what the in-runtime http.Server wrote to its VirtualSocket) → a
// streaming Response for the browser. content-length and chunked framing;
// read-until-close fallback; hop-by-hop headers stripped; content-encoding
// etc. pass through untouched (the browser decodes the exact bytes).
// ---------------------------------------------------------------------------
function concatU8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function findCRLFCRLF(u8, from) {
  for (let i = from; i + 3 < u8.length; i++) {
    if (u8[i] === 13 && u8[i + 1] === 10 && u8[i + 2] === 13 && u8[i + 3] === 10) return i;
  }
  return -1;
}
function u8ToLatin1(u8, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
  return s;
}

function makeResponseParser(resolve, reject, id) {
  const rec = {
    __idKey: id,
    resolved: false,
    finished: false,
    cancelled: false,
    buf: new Uint8Array(0),
    headerDone: false,
    ctrl: null,
    mode: null,        // 'cl' | 'chunked' | 'eof'
    remaining: 0,      // content-length remaining OR current chunk remaining
    chunkState: 0,     // 0=need-size 1=in-data 2=need-crlf
    resolve,
    reject,

    onBytes(ab) {
      if (this.finished || this.cancelled) return;
      const u8 = ab instanceof Uint8Array ? ab : new Uint8Array(ab);
      this.buf = this.buf.length ? concatU8(this.buf, u8) : u8;
      this.pump();
    },

    resolveWith(resp) {
      if (this.resolved) return;
      this.resolved = true;
      this.resolve(resp);
    },

    finish() {
      if (this.finished) return;
      this.finished = true;
      pending.delete(this.__idKey);
      if (this.ctrl) { try { this.ctrl.close(); } catch {} }
    },

    fail(err) {
      if (this.finished) return;
      this.finished = true;
      pending.delete(this.__idKey);
      if (!this.resolved) {
        this.resolved = true;
        this.resolve(textResp(502, 'preview upstream error: ' + String(err)));
      } else if (this.ctrl) {
        try { this.ctrl.error(new Error(String(err))); } catch {}
      }
    },

    onEnd() { // worker says: response connection complete
      if (this.finished || this.cancelled) return;
      if (!this.headerDone) {
        this.finished = true;
        this.resolveWith(textResp(502, 'preview upstream closed before sending headers'));
        return;
      }
      this.finish();
    },

    onError(err) { this.fail(err); },

    pump() {
      if (!this.headerDone) {
        const idx = findCRLFCRLF(this.buf, 0);
        if (idx === -1) {
          if (this.buf.length > 256 * 1024) this.fail('response head too large');
          return;
        }
        const headText = u8ToLatin1(this.buf, 0, idx);
        this.buf = this.buf.subarray(idx + 4);
        if (!this.parseHead(headText)) return;
        this.startStream();
      }
      this.pumpBody();
    },

    parseHead(text) {
      const lines = text.split('\r\n');
      const m = /^HTTP\/1\.[01] (\d+)(?: (.*))?$/.exec(lines[0] || '');
      if (!m) { this.fail('bad status line: ' + lines[0]); return false; }
      this.status = Number(m[1]);
      const headers = [];
      const fwd = [];
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].indexOf(':');
        if (c <= 0) continue;
        const name = lines[i].slice(0, c).trim();
        const val = lines[i].slice(c + 1).trim();
        headers.push([name.toLowerCase(), val]);
        const lk = name.toLowerCase();
        if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding' ||
            lk === 'upgrade' || lk === 'proxy-authenticate' || lk === 'proxy-authorization' ||
            lk === 'te' || lk === 'trailer') continue;
        fwd.push([name, val]);
      }
      // M1.5: the host page runs crossOriginIsolated (COEP require-corp);
      // a preview response WITHOUT Cross-Origin-Resource-Policy cannot be
      // embedded (iframe/fetch as subresource) — observed live as
      // net::ERR_BLOCKED_BY_RESPONSE. Previews are same-origin by design,
      // so same-origin CORP is honest and restores embeddability. COOP +
      // COEP on the embedded document keep it isolated from the host (a
      // preview is untrusted content; it must not reach the host window).
      // An app that sends its own copies keeps them (first one wins).
      if (!fwd.some((h) => h[0] === 'cross-origin-resource-policy')) {
        fwd.push(['Cross-Origin-Resource-Policy', 'same-origin']);
      }
      if (!fwd.some((h) => h[0] === 'cross-origin-opener-policy')) {
        fwd.push(['Cross-Origin-Opener-Policy', 'same-origin']);
      }
      if (!fwd.some((h) => h[0] === 'cross-origin-embedder-policy')) {
        fwd.push(['Cross-Origin-Embedder-Policy', 'require-corp']);
      }
      this.fwdHeaders = fwd;
      const te = (headers.find((h) => h[0] === 'transfer-encoding') || [null, ''])[1].toLowerCase();
      const cl = headers.find((h) => h[0] === 'content-length');
      if (te.includes('chunked')) { this.mode = 'chunked'; this.chunkState = 0; this.remaining = 0; }
      else if (cl) { this.mode = 'cl'; this.remaining = parseInt(cl[1], 10) || 0; }
      else this.mode = 'eof';
      if (this.status === 101) {
        this.finished = true;
        this.resolveWith(textResp(501,
          'nodine preview: WebSocket/protocol upgrades are not supported (the preview gateway is HTTP-only)'));
        return false;
      }
      return true;
    },

    startStream() {
      this.headerDone = true;
      const nullBody = this.status === 204 || this.status === 304;
      if (nullBody) {
        this.finished = true;
        this.resolveWith(new Response(null, { status: this.status, headers: this.fwdHeaders }));
        return;
      }
      const rec = this;
      const stream = new ReadableStream({
        start(ctrl) { rec.ctrl = ctrl; },
        cancel() { rec.cancelled = true; rec.finished = true; pending.delete(rec.__idKey); },
      });
      this.resolveWith(new Response(stream, { status: this.status, headers: this.fwdHeaders }));
    },

    enqueue(u8) {
      if (this.cancelled || !this.ctrl) return;
      // slice: a private copy — this.buf may be replaced while the chunk is
      // queued inside the stream.
      try { this.ctrl.enqueue(u8.slice()); } catch {}
    },

    pumpBody() {
      if (this.finished || this.cancelled) return;
      for (;;) {
        if (this.mode === 'cl') {
          if (this.remaining === 0) { this.finish(); return; }
          if (this.buf.length === 0) return;
          const take = Math.min(this.buf.length, this.remaining);
          this.enqueue(this.buf.subarray(0, take));
          this.buf = this.buf.subarray(take);
          this.remaining -= take;
          continue;
        }
        if (this.mode === 'chunked') {
          if (this.chunkState === 0) {
            const nl = this.buf.indexOf(10); // '\n'
            if (nl === -1) {
              if (this.buf.length > 16384) this.fail('chunk size line too long');
              return;
            }
            const sizeLine = u8ToLatin1(this.buf, 0, nl).replace(/\r$/, '');
            const size = parseInt(sizeLine.split(';')[0], 16);
            if (!Number.isFinite(size)) { this.fail('bad chunk size: ' + sizeLine); return; }
            this.buf = this.buf.subarray(nl + 1);
            if (size === 0) { this.finish(); return; } // trailers ignored (our servers send none)
            this.remaining = size;
            this.chunkState = 1;
            continue;
          }
          if (this.chunkState === 1) {
            if (this.buf.length === 0) return;
            const take = Math.min(this.buf.length, this.remaining);
            this.enqueue(this.buf.subarray(0, take));
            this.buf = this.buf.subarray(take);
            this.remaining -= take;
            if (this.remaining === 0) this.chunkState = 2;
            continue;
          }
          if (this.chunkState === 2) {
            if (this.buf.length < 2) return;
            if (this.buf[0] !== 13 || this.buf[1] !== 10) { this.fail('bad chunk terminator'); return; }
            this.buf = this.buf.subarray(2);
            this.chunkState = 0;
            continue;
          }
          return;
        }
        // 'eof': everything until close
        if (this.buf.length === 0) return;
        this.enqueue(this.buf);
        this.buf = new Uint8Array(0);
        return;
      }
    },
  };
  return rec;
}
