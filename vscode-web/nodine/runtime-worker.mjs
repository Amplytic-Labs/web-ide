import acorn from './acorn-vendor.mjs';
import { createModuleWrapBinding } from './sync-module-wrap.mjs';

// P2-006-008: capture the Worker's REAL navigator values at module init —
// the Node bootstrap later replaces globalThis.navigator with the
// internal/navigator.js polyfill, whose hardwareConcurrency getter calls the
// os binding (mutual recursion -> stack overflow, caught live via npm's
// fetch-retry path reading os.availableParallelism()).
const __nodineNavCores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
const __nodineNavMem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0;
// The Node bootstrap replaces globalThis.AbortController with Node's JS
// implementation; fetch() requires the NATIVE AbortSignal. Capture the
// Worker's own class before the bootstrap runs.
const __nodineNativeAbortController = globalThis.AbortController;
const __nodineNativeAbortSignal = globalThis.AbortSignal;
const __nodineNativeBtoa = globalThis.btoa.bind(globalThis);
const __nodineNativeAtob = globalThis.atob.bind(globalThis);
// P1-POC runtime worker — THE PROOF.
//
// This Dedicated Worker is the "fresh realm": it loads the upstream Node.js
// v26.13.0 lib/ sources (fetched verbatim from /libsources.json) and drives the
// real bootstrap chain through them, servicing every C++ dependency through
// host-provided bindings (the internalBinding registry below).
//
// Chain stages + wrapper parameters are EXACTLY what src/builtin_info.h:29-48
// specifies and what src/node_realm.cc:329-356 + src/api/environment.cc:1059
// execute in C++ (including the two web-exposure stages and both switches the
// P1-A2 vm harness skipped):
//   per-context:        (exports, primordials, privateSymbols, perIsolateSymbols)
//   bootstrap/realm:    (process, getLinkedBinding, getInternalBinding, primordials)
//   bootstrap/node etc: (process, require, internalBinding, primordials)
//   regular builtins:   (exports, require, module, process, internalBinding, primordials)
//
// Where the P1-A2 harness used vm.compileFunction(parsingContext), this worker
// uses `new Function(params..., source)` — the web-platform substitute for
// ScriptCompiler::CompileFunction (obligation #34). The Worker's own global
// scope IS the realm: fresh intrinsics, no Node globals.
//
// One worker = one process run: full chain -> one entry script -> one gate
// test -> report -> done. The gate driver (run-gate.cjs) spawns one worker per
// test with ?test=T1..T7, exactly like separate `node` invocations.

// ---------------------------------------------------------------------------
// 0. Platform capture — BEFORE the chain overwrites any worker global
//    (bootstrap/web/exposed-window-or-worker replaces setTimeout/fetch/etc.
//     with Node's own implementations; the host loop driver must keep the
//     platform primitives).
// ---------------------------------------------------------------------------
const platformSetTimeout = globalThis.setTimeout;
// Pin the PLATFORM's URL.createObjectURL + Blob BEFORE Node's bootstrap replaces
// globalThis.URL with Node's own class (whose createObjectURL needs OpenSSL
// crypto → ERR_NO_CRYPTO in our host; observed live in the T6 ESM spike).
const platformURLCtor = globalThis.URL;
const platformCreateObjectURL = platformURLCtor.createObjectURL.bind(platformURLCtor);
const platformBlobCtor = globalThis.Blob;
const platformClearTimeout = globalThis.clearTimeout;
const platformQueueMicrotask = globalThis.queueMicrotask;
const platformPerformance = globalThis.performance;
const platformFetch = globalThis.fetch;
// P2-008 Step-0.5: BROWSER-SIDE FETCH SEMAPHORE — agent-socket semantics.
// Real Node bounds concurrent requests per agent (npm sets
// npm_config_maxsockets=8; its own default is 8 in recent majors). Our
// bridge dispatched EVERY ClientRequest as an immediate browser fetch():
// measured live (rec1, warm mirror) 164 concurrent in-flight fetches in
// the install worker → body buffers + sha256 parts pushed the renderer
// past 1 GB RSS on a 4 GB box → OOM kill at +131 s; and async CLOSEs
// queued behind the saturated submit ring (bridgeQueue 266) while OPENs
// kept landing → per-proc FDs piled to the 1024 cap → EMFILE (-24) →
// npm-tar TAR_ENTRY_ERROR (dropped files, corrupt tree; rec2). A global
// semaphore sized from npm_config_maxsockets restores the agent contract:
// requests QUEUE in the agent (here: in JS), never flood the platform.
let FETCH_SLOTS = -1; // resolved lazily from the process env
let fetchActive = 0;
const fetchQueue = [];
function fetchSlotCount() {
  if (FETCH_SLOTS < 0) {
    let v = null;
    try { v = (INIT && INIT.env && (INIT.env.npm_config_maxsockets || INIT.env.NPM_CONFIG_MAXSOCKETS)) || null; } catch {}
    const n = parseInt(v || '8', 10);
    FETCH_SLOTS = Number.isFinite(n) && n > 0 ? n : 8;
  }
  return FETCH_SLOTS;
}
function pumpFetchQueue() {
  while (fetchQueue.length > 0 && fetchActive < fetchSlotCount()) {
    const w = fetchQueue.shift();
    fetchActive++;
    platformFetch(w.url, w.init).then(w.resolve, w.reject).finally(() => { fetchActive--; pumpFetchQueue(); });
  }
}
function platformFetchGated(url, init) {
  if (fetchActive < fetchSlotCount()) {
    fetchActive++;
    return platformFetch(url, init).finally(() => { fetchActive--; pumpFetchQueue(); });
  }
  return new Promise((resolve, reject) => fetchQueue.push({ url, init, resolve, reject }));
}
// P2-006-008 mount-aware base: the worker script's own directory. Works at the
// server root AND behind any reverse-proxy path prefix (the preview gateway
// mounts this app under /nodine/). Absolute-path fetches would escape the
// prefix and 404 on the wrong backend.
const SELF_BASE = new URL('.', self.location.href).href; // .../[prefix]/
const urlUnder = (p) => new URL(String(p).replace(/^\//, ''), SELF_BASE).href;
const platformCrypto = globalThis.crypto; // pre-bootstrap capture (Node's webcrypto may replace globalThis.crypto)
// P2-006-008: the platform's web classes, captured BEFORE the Node bootstrap
// replaces the globals with lazy undici-backed versions. The libsources shim
// for internal/deps/undici/undici reads this (reading globalThis at
// shim-eval time would be circular — the lazy globals require the shim).
globalThis.__nodinePlatformWeb = {
  fetch: platformFetch,
  FormData: globalThis.FormData,
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
  MessageEvent: globalThis.MessageEvent,
  CloseEvent: globalThis.CloseEvent,
  ErrorEvent: globalThis.ErrorEvent,
  EventSource: globalThis.EventSource,
  WebSocket: globalThis.WebSocket,
};
const platformMessagePost = globalThis.postMessage.bind(globalThis);
const platformConsoleError = globalThis.console.error.bind(globalThis.console);
const measureMemory = platformPerformance.measureUserAgentSpecificMemory?.bind(platformPerformance);
const nowMs = () => platformPerformance.now() - T_BOOT;
const T_BOOT = platformPerformance.now();

// P2-006 runtime worker: the Node JS-core host AND the ABI bridge endpoint
// for ONE process. The kernel (separate worker) owns the VFS + fd tables.
const TEST_ID = 'RUN'; // legacy gate-trace switch (residual debug reports compare against T3/T6 - inert)
let INIT = null; // the nodine-init message (section 6 fills it)

// Evidence relay: postMessage for the live page log + POST /report for the
// persistent ndjson. Both channels carry identical records.
// nodine-init handler — installed at MODULE TOP so the page's init
// message is never lost to the libsources-fetch await window below.
// ---- P2-006-007 process contract state ------------------------------------
let STDIO_MODE = 'inherit';   // 'inherit' | 'pipe' | 'ignore' (from INIT)
let CHANNEL_PORT = null;      // supervisor channel (pipe stdio + child_process)
// B1-PREVIEW: the supervisor may hand this worker a port toward the preview
// service worker (init.previewSWPort, transferred). http servers in THIS
// worker then reach the browser with zero host involvement — the
// fully-browser transport. Null → listen() dark-listens (no transport).
let PREVIEW_SW_PORT = null;   // channel to the SW (control + request fan-in)
let PREVIEW_SW_PORT_READY = null; // resolved once the port is installed
// B1-PREVIEW: per-port bridge records — {port, chan (worker side of the
// per-port MessageChannel), server, conns: Map(id -> sock)}. listenViaSW
// closes over its own record; NO shared mutable "current port" state.
const previewPorts = new Map();
// MODULE SCOPE: the init message can arrive (and be installed) BEFORE the
// http factory runs — installPreviewSWPort must exist from module top. The
// per-port channel request handler is attached later (preview-request
// handling lives inside the http factory closure where VirtualSocket /
// HTTP1Connection are defined; the channel's early messages queue on the
// port until then — MessagePort queues survive until start()).
function installPreviewSWPort(port) {
  if (PREVIEW_SW_PORT) { try { port.close(); } catch {} return; } // idempotent
  PREVIEW_SW_PORT = port;
  PREVIEW_SW_PORT.onmessage = (ev) => {
    const m = ev.data;
    if (m && m.type === 'preview-port-gone') {
      // page-side teardown: any listening server on this port must close
      PREVIEW_SW_GONE_HOOKS.forEach((h) => { try { h(m.port); } catch {} });
    }
  };
  PREVIEW_SW_PORT.start && PREVIEW_SW_PORT.start();
  PREVIEW_SW_PORT_READY = Promise.resolve();
}
const PREVIEW_SW_GONE_HOOKS = []; // http factory registers its cleanup here
// 0.5.2 (LAN-SHARE): the supervisor can attach the preview bridge AFTER this
// worker spawned (the share command opened while a dev server already runs).
// It then sends 'preview-sw-port' on CHANNEL_PORT with the per-worker preview
// port transferred — install it and let the http factory re-register any
// dark-listened servers on the now-live bridge.
const PREVIEW_BRIDGE_LIVE_HOOKS = []; // http factory registers its re-registration here
function handlePreviewSwPortMsg(ev) {
  const port = ev && ev.ports && ev.ports[0];
  if (!port) return;
  const had = !!PREVIEW_SW_PORT;
  installPreviewSWPort(port);
  if (!had) PREVIEW_BRIDGE_LIVE_HOOKS.forEach((h) => { try { h(); } catch {} });
}
// Platform MessageChannel + onmessage setter, captured BEFORE the bootstrap
// chain replaces the globals (Node's EventTarget onmessage setter throws
// ERR_INVALID_THIS for platform MessagePorts — observed live in B1 E2E).
const platformMessageChannel = globalThis.MessageChannel;
const platformWorkerCtor = globalThis.Worker; // M1.7A: nested browser workers (wasm threads) — captured pre-realm

const platformPortSetOnmessage = (() => {
  const probe = new MessageChannel();
  const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  if (desc && desc.set) return desc.set;
  return function (fn) { this.addEventListener('message', fn); };
})();
function platformArmPort(port, handler) {
  platformPortSetOnmessage.call(port, (ev) => handler(ev));
  port.start && port.start();
}
const stdinQueue = [];        // pipe-mode stdin bytes (fed by 'stdin-bytes')
var stdinEofSeen = false;     // E6: upstream closed our piped stdin ('stdin-eof')
// P2-006-008: the pipe-mode read-waiter list — USED by stdinPipeRead/
// pumpStdinQueue since P2-006-007 but NEVER DECLARED: every pipe-mode stdin
// read crashed with "ReferenceError: stdinReadWaiters is not defined"
// (observed live: the create-expo-app grandchild's prompt readline died
// as an unhandled rejection with zero terminal output).
const stdinReadWaiters = [];   // { into, off, len, resolve } queue
let stdinWaiters = 0;         // pending pipe-mode stdin reads (quit condition)
let stdinRetryCount = 0;      // in-flight fd-0 EAGAIN retries (quit condition —
                              // a flowing stdin keeps the process alive, Node semantics)
let liveChildren = 0;         // child_process handles (quit condition)
// P2-006-008: spawn requests posted to the supervisor whose spawn-result
// has not arrived yet. THE PREMATURE-QUIET KILLER: the yarn shell posts the
// grandchild spawn, its JS stack unwinds, and every liveness counter is
// zero for the whole supervisor round-trip (endpoint alloc + worker spawn
// + chain boot ≈ 100+ ms) — liveChildren only counts AFTER the result.
// Observed live: /bin/sh child died 201 ms in, mid-spawn of create-expo-app,
// all counters zero (life-ring: PROC_READY, CHDIR, quiet). A pending spawn
// RPC is an active handle exactly like a uv_process_t in init.
let pendingSpawnReplies = 0;
const childHandles = new Map(); // pid -> ChildProcess-ish record (child_process batch)
const channelPortHandlers = new Map(); // type -> (msg) handler (registered by later bindings)
let spawnReqSeq = 0; // M1.6: unique spawn-result keys per concurrent spawn()
function raiseProcessSignal(sig) {
  // Node default: no listener ⇒ the signal terminates (SIGINT ⇒ exit 130).
  // B25: 'terminates' means NOW — the old emulation only set processExitCode
  // and left the event loop alive, so Ctrl+C against a server that reads
  // stdin for its own hotkeys (expo start: r/j/a) did nothing: it ignores
  // unknown bytes and keeps serving. When no listener exists, post the
  // hard proc-exit (130) directly — the supervisor's handleExit flushes
  // stdio, reclaims the endpoint and terminates the worker, which also
  // unwinds the parent chain (npm sees child-exit → the shell resumes).
  // With a listener, keep emit-only semantics (graceful shutdown paths:
  // expo's own SIGINT handler closes metro and exits itself).
  try {
    const had = typeof realmProcess?.emit === 'function' ? realmProcess.emit(String(sig)) : false;
    if (!had) {
      processExitCode = sig === 'SIGINT' ? 130 : 128;
      try { report({ type: 'signal-default-kill', sig, code: processExitCode }); } catch {}
      try { platformMessagePost({ type: 'proc-exit', code: processExitCode }); } catch {}
    }
  } catch { processExitCode = 130; }
}
function deliverStdinToWaiters() { pumpStdinQueueRef && pumpStdinQueueRef(); } // wired by the fs binding
let pumpStdinQueueRef = null;
// B21 (stdin-cancel): module-level cancel for fd-0 pipe reads — the
// uv_read_stop equivalent. Defined HERE (not in the fs-binding factory) so
// the bootstrap stdin-pause hook stage can call it; the factory's
// stdinPipeRead/pumpStdinQueue wire cancelStdinReadImpl for the EOF-set
// side effects. State touched is all module-level (stdinReadWaiters/
// stdinWaiters/stdinEofSeen). (The first cut defined it INSIDE the factory
// closure — the stage's call died as a swallowed ReferenceError and the
// cancel never ran; markers proved it: pause-fired posted, cancel didn't.)
let cancelStdinReadImpl = null; // set by the fs binding: EOF-flag + pump
function cancelStdinRead() {
  const ws = stdinReadWaiters.splice(0, stdinReadWaiters.length);
  stdinWaiters = 0;
  globalThis.__stdinCancelled = true;
  stdinEofSeen = true; // subsequent fd-0 pipe reads settle at once
  try { platformMessagePost({ type: 'stdin-cancel', waiters: ws.length }); } catch {} // B21-DIAG
  for (const w of ws) w.resolve(0);
  if (cancelStdinReadImpl) { try { cancelStdinReadImpl(); } catch {} }
}

// P2-006-008: loop-death observability for the RUNTIME worker (the kernel
// driver has had this since P2-004): an unhandled rejection in a deep npm
// promise chain otherwise looks like "process exited 0 silently mid-flow"
// (observed live — npx died right after the create-expo-app packument
// arrived, all liveness counters zero, no error output anywhere).
self.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  try {
    report({
      type: 'unhandled-rejection',
      reason: String((r && (r.stack || r)) || r).slice(0, 1200),
    });
  } catch {}
  platformConsoleError('[nodine] unhandled rejection:', (r && (r.stack || r)) || r);
});

const initPromise = new Promise((resolve) => {
self.onmessage = (ev) => {
  const m = ev.data;
  // B7 WARM POOL: warm-preinit delivers the supervisor's parsed libsources
  // BEFORE adoption — a parked warm worker's module top then skips its own
  // 6 MB fetch (the whole point of the pool: no per-worker libsources
  // transfer). It does NOT resolve initPromise: the worker stays parked
  // until the real nodine-init arrives.
  if (m && m.type === 'warm-preinit') {
    if (m.libSources && !LIBDATA_FROM_INIT) LIBDATA_FROM_INIT = m.libSources;
    return;
  }
  if (m && m.type === 'nodine-init' && !INIT) {
    INIT = m;
    // B1 speed: the supervisor may hand the parsed libsources payload with
    // init (it fetched it ONCE per page) — skip the worker's own 6.1 MB
    // fetch + JSON.parse entirely.
    if (m.libSources) { LIBDATA_FROM_INIT = m.libSources; }
    // B1-PREVIEW: install early (before main() runs) so a listen() racing
    // the init path still finds the port installed.
    if (m.previewSWPort) installPreviewSWPort(m.previewSWPort);
    resolve(m);
  }
};
});

const reportQueue = [];
function report(obj) {
  // The supervisor's onWorkerMsg receives EVERY report through the worker
  // message channel already (window.__p2007.logs, perf harness). The old
  // EXTRA POST to the host's /report endpoint — one HTTP fetch per report
  // event, ~30 per command, all chained serially through reportChain — was
  // the dominant component of "exit takes 2-3 s": the run-result POST (and
  // the whole chain behind it) had to settle before main() returned. HTTP
  // reporting is gone; the message channel is the one true tap.
  platformMessagePost({ ...obj, t: Date.now() });
  return Promise.resolve();
}

// HOST_STDOUT/STDERR stay EMPTY in P2-006: stdout bytes go through the
// kernel stdio device OFDs (OP_WRITE on fd 1/2 -> kernel FIFO) and the
// KERNEL DRIVER drains them to the page. Kept as sinks for the report only.
const HOST_STDOUT = [];
const HOST_STDERR = [];
const utf8Decoder = new TextDecoder();
// Platform encode/decode engines, captured BEFORE the bootstrap chain replaces
// the globals with Node's own (exposed-wildcard.js swaps in internal/encoding.js's
// TextEncoder/TextDecoder). The 'encoding_binding' shim below runs on these.
const platformTextEncoder = new TextEncoder();
const platformDecoders = {
  // WHATWG defaults: BOM stripped, errors replaced
  strip: new TextDecoder('utf-8'),
  keep: new TextDecoder('utf-8', { ignoreBOM: true }),
  fatalStrip: new TextDecoder('utf-8', { fatal: true }),
  fatalKeep: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
};

// ---------------------------------------------------------------------------
// 1. Fetch the verbatim lib/ sources + the uv errno map.
// ---------------------------------------------------------------------------
// P2-008-PERF Step-0 state — declared HERE (before the first use below); the
// helper functions live with the OP table further down (hoisted declarations).
var PERF = null;               // activated in main() when INIT.perf
var LAST_SYNC_RUNG = 0;        // rung index the last syncOp wait woke on
var LAST_SYNC_WAIT_MS = 0;     // E5: wall time the last syncOp spent in the wait ladder (blocked), vs total op time = JS submit/retire + pump-side work
var PERF_WIN = null;           // E5: per-op {n,sumMs,maxMs} since the last 5 s state push
var PERF_DELIV_MODE = 'boot';  // S0.6: how the CURRENT drain's completions arrived (wake/tick/defer)
var PERF_DELIV_PENDING = null; // S0.6: the previous wait's result, consumed by the next pump
var PERF_PREBOOT_NET = [];     // libsources/uvmap fetch timings (always on)
var LIBDATA_FROM_INIT = null;  // supervisor-supplied libsources (B1 speed: no per-spawn fetch)
report({ type: 'boot', pid: INIT?.pid, ua: navigator.userAgent, crossOriginIsolated: globalThis.crossOriginIsolated });

const [libRes, uvRes] = await Promise.all([
  LIBDATA_FROM_INIT
    ? Promise.resolve(null) // served by the supervisor — no fetch at all
    : (async () => { const __t0 = platformPerformance.now(); const r = await platformFetch(urlUnder('libsources.json')); PERF_PREBOOT_NET.push({ url: 'libsources.json', ms: +(platformPerformance.now() - __t0).toFixed(0), status: r.status }); return r; })(),
  (async () => { const __t0 = platformPerformance.now(); const r = await platformFetch(urlUnder('uvmap.json')); PERF_PREBOOT_NET.push({ url: 'uvmap.json', ms: +(platformPerformance.now() - __t0).toFixed(0), status: r.status }); return r; })(),
]);
if (!LIBDATA_FROM_INIT && (!libRes || !libRes.ok || !uvRes.ok)) throw new Error('libsources/uvmap fetch failed');
const LIBDATA = LIBDATA_FROM_INIT || await libRes.json(); // { nodeVersion, tarballSha256, count, ids, sources }
const UVMAP = await uvRes.json();    // [{name, value, message}]
const builtinIds = LIBDATA.ids;
const readSource = (id) => {
  const src = LIBDATA.sources[id];
  // B15: async_hooks.setPromiseHooks — the vendored Node 26 sources don't
  // export it (promise hooks ride the trampoline here), but Metro's bundled
  // expo-server http.js calls it at module load. No-op graft appended to the
  // module body: promise-hook consumers get silent success (documented
  // divergence). Done HERE (not in compileFunction) because both compile
  // paths — builtins.compileFunction and the CJS loader — read via this fn.
  // NOTE: async_hooks ends with `module.exports = {...}` (a REassignment),
  // so the graft must write to module.exports — the `exports` alias points
  // at the orphaned pre-assignment object.
  if (id === 'async_hooks' && typeof src === 'string' && !src.includes('setPromiseHooks')) {
    return src + '\n;module.exports.setPromiseHooks = module.exports.setPromiseHooks || function setPromiseHooks() {};';
  }
  return src;
};

report({ type: 'libsources', count: LIBDATA.count, nodeVersion: LIBDATA.nodeVersion, bytes: JSON.stringify(LIBDATA).length });

// T8 part A: digest every served source IN THE BROWSER and report the hashes.
// The Playwright driver independently hashes the vendor tree on disk and
// compares — a genuine end-to-end integrity check of what the worker executed.
async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
{
  // P1 LATENCY FIX (batch-3): hashing all 428 sources on EVERY worker spawn
  // cost real milliseconds in the per-command path (each shell command boots
  // a fresh runtime worker). The integrity check is a T8 TEST VERIFICATION
  // (the Playwright driver compares these hashes against the vendored tree)
  // — not a runtime necessity. Gate it on INIT.perf (the diagnostics flag
  // the test drivers already set); production spawns skip it entirely.
  // NOTE: perf gating reads INIT PER MESSAGES THAT ARRIVED BEFORE this
  // point; a spawn whose init message lands later would miss the hashes.
  // The T8 drivers boot with perf on and their init arrives during the
  // libsources await above (always slower than this line), so in practice
  // INIT is set. Keep ONE macrotask yield here regardless: the original
  // block's digest loop yielded the event loop many times, and worker
  // boot ordering downstream (transport init vs. the init message) relies
  // on not running the whole module synchronously past this point.
  await new Promise((r) => platformSetTimeout(r, 0));
  if (INIT?.perf) {
    const t0 = nowMs();
    const out = {};
    for (const id of builtinIds) out[id] = await sha256Hex(readSource(id));
    await report({ type: 'integrity-hashes', hashes: out, ms: +(nowMs() - t0).toFixed(1) });
  } else {
    report({ type: 'integrity-hashes', skipped: true, reason: 'perf-mode only (P1 latency fix)' });
  }
}

// ---------------------------------------------------------------------------
// 2. KERNEL TRANSPORT — the frozen ABI v1.0.2 bridge endpoint (in-process
//    port of poc/p2-004/public/runtime-client.js). The Rust/WASM kernel
//    lives in a DEDICATED worker holding the KSM; this worker is the bridge
//    for ONE process endpoint. NO filesystem state lives here — every byte
//    goes over the transport to the kernel's VFS + fd tables.
//
//    §11  sync:  CAS-before-publish mailbox + the §11.3 wait ladder
//    §12  async: submit-ring publish + persistent waitAsync consumer
//    §5.5 bridge heartbeat (ep_heartbeat_ms >= every 250 ms)
//    §21.3 kernel-death health check (1000 ms heartbeat age)
// ---------------------------------------------------------------------------
// Pre-bootstrap engine captures: the pump/heartbeat MUST NOT resolve
// `setTimeout` post-bootstrap (Node's own tracked timers would arm
// platformTimerId forever and waitForQuiet would never go quiet).
const engineSetTimeout = globalThis.setTimeout;
const engineSetInterval = globalThis.setInterval;
const engineClearInterval = globalThis.clearInterval;

const ABIC = {
  TRANSPORT_BASE: 0x10000, EP_STRIDE: 0x141000,
  EP_HEADER: 0x00, EP_SRH: 0x40, EP_CRH: 0x50, EP_MBOX: 0x60,
  EP_TX_ARENA: 0x0100, EP_RX_ARENA: 0x40100, EP_SYNCRES: 0x80100,
  EP_SUBMIT_SLOTS: 0xC0100, EP_COMPLETION_SLOTS: 0x100100,
  TX_SIZE: 0x40000, RX_SIZE: 0x40000, TX_SYNC_RESERVE: 0x2000,
  TX_SYNC_PAYLOAD_MAX: 8128, RX_PAYLOAD_MAX: 0x40000 - 64,
  RING_SLOTS: 4096, MASK: 4095, SYNC_RING_SLOTS: 64,
  FLAG_MODE_SYNC: 1, FLAG_STAT_BIGINT: 2,
  SM_IDLE: 0, SM_SUBMITTED: 1, SM_COMPLETED: 2, SM_ABANDONED: 3,
  DOORBELL: 0x2000, KCTL_STATE: 0x10, KCTL_HEARTBEAT: 0x28,
  SYNC_TOTAL_TIMEOUT_MS: 10000, KERNEL_DEATH_MS: 1000,
};
const OP = {
  ABI_PROBE: 0x0001, CAPS_QUERY: 0x0002,
  PROC_READY: 0x0010, PROC_EXIT: 0x0011,
  OPEN: 0x0100, CLOSE: 0x0101, READ: 0x0102, WRITE: 0x0103,
  STAT: 0x0104, LSTAT: 0x0105, FSTAT: 0x0106, MKDIR: 0x0107,
  RMDIR: 0x0108, UNLINK: 0x0109, RENAME: 0x010A, READDIR: 0x010B,
  FTRUNCATE: 0x010C,
  // P2-006-007 ABI v1.0.3 surface
  CHDIR: 0x0015, TRUNCATE: 0x0121, CHMOD: 0x0122, UTIMES: 0x0123,
  LINK: 0x0124, SYMLINK: 0x0125, READLINK: 0x0126,
};
const ST = { NONE: 0, INLINE: 1, RX: 2, SYNCRES: 3 };

// ---- P2-008-PERF Step-0 instrumentation (docs/perf/baseline.md) ------------
// All gated on INIT.perf (supervisor passes perf:true when the page is loaded
// with ?perf=1). Zero-cost when off: one null check per call site. Records go
// via platformMessagePost (NOT report() — no /report POST per record).
// (PERF / LAST_SYNC_RUNG / PERF_PREBOot_NET are declared above the libsources
// fetch — the first use precedes this point in module order.)
const OP_NAMES = (() => { const m = new Map(); for (const [k, v] of Object.entries(OP)) m.set(v, k); return m; })();
const PERF_LAT_EDGES = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];
function perfLatBucket(ms) {
  let i = 0; while (i < PERF_LAT_EDGES.length && ms > PERF_LAT_EDGES[i]) i++;
  return i;
}
function pctl(arr, p) { // S0.6: percentile over a numeric array (copy, sort)
  if (!arr || !arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(3);
}
function perfOpEntry(op) {
  const name = OP_NAMES.get(op) || ('op0x' + op.toString(16));
  let e = PERF.counts[name];
  if (!e) e = PERF.counts[name] = { n: 0, err: 0, lat: new Array(PERF_LAT_EDGES.length + 1).fill(0), rungs: [0, 0, 0, 0, 0], maxMs: 0 };
  return e;
}
function perfRpcDone(op, t0, rung, isAsync = false) {
  const ms = platformPerformance.now() - t0;
  const e = perfOpEntry(op);
  if (isAsync) { e.nAsync = (e.nAsync || 0) + 1; e.sumMsAsync = (e.sumMsAsync || 0) + ms; }
  e.n++; e.lat[perfLatBucket(ms)]++;
  e.sumMs = (e.sumMs || 0) + ms;                 // E5: time-weighted total
  e.waitMs = (e.waitMs || 0) + (isAsync ? 0 : (LAST_SYNC_WAIT_MS || 0)); // E5: blocked-in-ladder share (sync only)
  if (ms > e.maxMs) e.maxMs = ms;
  if (!PERF_WIN) PERF_WIN = {};
  const _on = OP_NAMES.get(op) || ('op0x' + op.toString(16));
  const w = PERF_WIN[_on] || (PERF_WIN[_on] = { n: 0, sumMs: 0, maxMs: 0, waitMs: 0, nAsync: 0 });
  w.n++; w.sumMs += ms; if (ms > w.maxMs) w.maxMs = ms; w.waitMs += (isAsync ? 0 : (LAST_SYNC_WAIT_MS || 0));
  if (isAsync) w.nAsync++;
  if (rung >= 2) { e.rungs[Math.min(rung, 4)]++; PERF.ladderSuspect++; }
}
function perfRpcErr(op, t0) {
  const e = perfOpEntry(op); e.err++;
  const ms = platformPerformance.now() - t0;
  if (ms > e.maxMs) e.maxMs = ms;
}
function perfNetStart(url, method, relayed) {
  if (!PERF) return -1;
  PERF.net.push({ url: String(url).slice(0, 300), method, relayed: !!relayed, t0: +(nowMs().toFixed(1)) });
  return PERF.net.length - 1;
}
function perfNetDone(idx, fields) {
  if (!PERF || idx < 0 || !PERF.net[idx]) return;
  Object.assign(PERF.net[idx], fields);
}
function perfLatSummary() {
  // bucket counts -> approx p50/p90/p99 per op
  const out = {};
  for (const [name, e] of Object.entries(PERF.counts)) {
    const total = e.n + e.err;
    if (!total) continue;
    const q = (p) => {
      let acc = 0;
      const target = Math.ceil(total * p);
      for (let i = 0; i < e.lat.length; i++) {
        acc += e.lat[i];
        if (acc >= target) return i === 0 ? '<' + PERF_LAT_EDGES[0] : (i < PERF_LAT_EDGES.length ? PERF_LAT_EDGES[i - 1] + '-' + PERF_LAT_EDGES[i] : '>' + PERF_LAT_EDGES[PERF_LAT_EDGES.length - 1]);
      }
      return '>?';
    };
    out[name] = { n: e.n, nAsync: e.nAsync || 0, err: e.err, p50: q(0.5), p90: q(0.9), p99: q(0.99), maxMs: +e.maxMs.toFixed(1), sumMs: +(e.sumMs || 0).toFixed(1), sumMsAsync: +(e.sumMsAsync || 0).toFixed(1), waitMs: +(e.waitMs || 0).toFixed(1), rungs2plus: e.rungs.slice(2).reduce((a, b) => a + b, 0) };
  }
  return out;
}
function perfSnapshot() {
  const win = PERF_WIN || {};
  PERF_WIN = {}; // E5: window stats per 5 s push — per-op {n,sumMs,maxMs,waitMs}
  return {
    pid: INIT?.pid ?? -1,
    t: +(nowMs().toFixed(0)),
    outstanding: outstanding.size,
    bridgeQueue: bridgeQueue.length,
    pendingHttp: pendingHttpFetches,
    liveChildren, pendingSpawnReplies, stdinWaiters, stdinRetryCount,
    dynImport: dynImportInFlight,
    lastSyncRung: LAST_SYNC_RUNG,
    corgi: { ...DIRECT_CORGI_STATS }, // Phase-4: substitution counters per push
    eagain: { sync: { ...SYNC_EAGAIN_RETRIES }, async: { ...ASYNC_EAGAIN_RETRIES } }, // Phase-5: EAGAIN-retry health
    winRpc: win,
  };
}
function activatePerf(init) {
  PERF = {
    counts: {}, net: [], npmTimers: {}, boot: { libsources: PERF_PREBOOT_NET.slice() },
    // S0.6 Step-1b: async-completion delivery stats (see armCompletions)
    deliv: { passes: {}, idleDrains: 0, byMode: {}, lat: {}, batch: 0, batchHist: new Array(20).fill(0), drainDur: [], selfWake: null },
    ladderSuspect: 0, pid: init.pid, argv: init.argv || [], entry: init.entry || null,
    t0: nowMs(),
  };
  // S0.6 Step-1b: self-wake calibration (H4) — MOVED to transportAttach (see
  // startPerfSelfWake): activatePerf runs before the transport exists, so the
  // old `if (KSM && epBase >= 0)` guard here was always false and every
  // s06probe proc reported selfWake: null (docs/perf/async-completion-path.md §3.2).
  // 5 s state push (hang detector trail) — engine timer, invisible to the
  // Node-timer liveness accounting, so it cannot perturb quit detection.
  engineSetInterval(() => { if (PERF) platformMessagePost({ type: 'perf-state', ...perfSnapshot() }); }, 5000);
}

let KSM = null;          // the shared WebAssembly.Memory
let I32 = null;          // Int32Array over the CURRENT buffer
let epBase = 0;          // this endpoint's region base
let epIndex = -1;
let epGeneration = 0;
let nextReqId = 1n;
const outstanding = new Map(); // reqId -> { op, resolve, reject }
const bridgeQueue = [];       // §17.3 bounded queue (submit-blocked requests)
// P2-008: real Node's libuv request queue is effectively UNBOUNDED (one
// uv_fs_t per call; the threadpool executes 4 at a time). Node's own
// internal rimraf (fs.rm — npm ci's node_modules removal) fires its whole
// child-recursive callback fan-out without any pacing: ~41K unlinks on this
// tree arrive faster than the kernel retires them, and the old 1,024 cap
// surfaced as fs EAGAIN (npm ci died exit -11 at buildDeps, measured
// 2026-11-13). Parked jobs are plain JS objects (~150 B); 65 536 ≈ 10 MB
// worst case — the drain (pumpBridgeQueue) resubmits as slots free.
const BRIDGE_QUEUE_MAX = 65536;
let armed = false;

function refreshViews() {
  // Shared memory growth swaps ksm.buffer for a NEW SAB object; old SABs
  // keep their old length. Refresh the typed-array views on every attach
  // AND whenever the byteLength changes under us.
  const b = KSM.buffer;
  if (!I32 || I32.buffer.byteLength !== b.byteLength) I32 = new Int32Array(b);
}
function heartbeatAgeMs() {
  const dv = new DataView(KSM.buffer);
  return Date.now() - Number(dv.getBigUint64(ABIC.KCTL_HEARTBEAT, true));
}
function kernelDead() {
  return Atomics.load(I32, ABIC.KCTL_STATE / 4) !== 1 || heartbeatAgeMs() > ABIC.KERNEL_DEATH_MS;
}
function endpointDead() {
  // §5.5 live endpoint header state
  const st = readEpU32(ABIC.EP_HEADER + 0x10);
  return st !== 2; // ENDPOINT_STATE_RUNNING
}
function readEpU32(off) {
  return Atomics.load(I32, (epBase + off) / 4);
}
function doorbell() {
  Atomics.add(I32, ABIC.DOORBELL / 4, 1);
  Atomics.notify(I32, ABIC.DOORBELL / 4, 1);
}

// ---- §11 sync request/reply ------------------------------------------------
// P2-008 Phase-5: the kernel's §17.3-item-4 ladder converts pre-dispatch
// deferrals (arena/ring pressure) into completed uv::EAGAIN for SYNC ops
// too. Real libuv BLOCKS a synchronous fs call until it completes — it
// never surfaces EAGAIN — and npm/tar treat a sync-stat EAGAIN as fatal
// (tar's CwdError). Bounded retry at this seam restores libuv fidelity:
// the 25 ms mailbox nap lets the driver pump and async completions retire
// (freeing RX-arena spans), so the retried op dispatches on a later pass.
// 200 attempts ≈ 5 s of pure nap + dispatch time; a 30 s wall cap fails
// honestly (returns the EAGAIN status) rather than hanging forever.
const SYNC_EAGAIN_RETRIES = { retries: 0, exhausted: 0 };
function syncOp(op, a0 = 0n, a1 = 0n, a2 = 0n, txBytes = null, timeoutMs = ABIC.SYNC_TOTAL_TIMEOUT_MS) {
  // P2-008-PERF: wrapper only — zero overhead when PERF is null (one check).
  if (!PERF) return syncOpEagainRetry(op, a0, a1, a2, txBytes, timeoutMs, 0);
  const __pfT0 = platformPerformance.now();
  try {
    const r = syncOpEagainRetry(op, a0, a1, a2, txBytes, timeoutMs, 0);
    perfRpcDone(op, __pfT0, LAST_SYNC_RUNG);
    return r;
  } catch (e) {
    perfRpcErr(op, __pfT0);
    throw e;
  }
}
function syncOpEagainRetry(op, a0, a1, a2, txBytes, timeoutMs, attempt) {
  const r = syncOpRaw(op, a0, a1, a2, txBytes, timeoutMs);
  if (r.status !== UV.UV_EAGAIN || attempt >= 200) {
    if (r.status === UV.UV_EAGAIN) SYNC_EAGAIN_RETRIES.exhausted++;
    return r;
  }
  SYNC_EAGAIN_RETRIES.retries++;
  // wall-clock cap: give up honestly after 30 s of retrying
  if (!syncEagainT0) syncEagainT0 = platformPerformance.now();
  if (platformPerformance.now() - syncEagainT0 > 30000) {
    SYNC_EAGAIN_RETRIES.exhausted++;
    syncEagainT0 = 0;
    return r;
  }
  // bounded nap on the mailbox seq word (same yield esmSyncRetry uses)
  const smbState2 = (epBase + ABIC.EP_MBOX) / 4;
  Atomics.wait(I32, smbState2, Atomics.load(I32, smbState2), 25);
  const out = syncOpEagainRetry(op, a0, a1, a2, txBytes, timeoutMs, attempt + 1);
  if (r.status === UV.UV_EAGAIN && out.status !== UV.UV_EAGAIN) syncEagainT0 = 0;
  return out;
}
let syncEagainT0 = 0;
function syncOpRaw(op, a0 = 0n, a1 = 0n, a2 = 0n, txBytes = null, timeoutMs = ABIC.SYNC_TOTAL_TIMEOUT_MS) {
  refreshViews();
  const smb = epBase + ABIC.EP_MBOX;
  const smbState = (smb + 4) / 4;
  const seqIdx = smb / 4;
  // The submit path is synchronous (callers rely on syncOp returning the
  // result); the idle-wait above uses the engine timer via a nested event
  // loop ONLY on the rare abandoned-reset path — implemented as a bounded
  // spin below (the driver resets within one pump pass, ≤250 ms).
  let idleTries = 0;
  while (Atomics.load(I32, smbState) !== ABIC.SM_IDLE) {
    if (idleTries++ > 3000) { // ~30 s worst case; the §11.3 kernel reset rides on pump passes
      // P2-006-008: carry the kernel snapshot IN the error — the wedge was
      // seen intermittently only, so the next occurrence must be
      // self-diagnosing (kctl/heartbeat/endpoint/ring counters).
      throw new Error('sync mailbox stuck (state=' + Atomics.load(I32, smbState) + ') — kernel did not reset'
        + ' (kctl=' + Atomics.load(I32, ABIC.KCTL_STATE / 4)
        + ', hbAgeMs=' + heartbeatAgeMs()
        + ', epState=' + readEpU32(ABIC.EP_HEADER + 0x10)
        + ', smSeq=' + Atomics.load(I32, seqIdx)
        + ', srP=' + Atomics.load(I32, (epBase + ABIC.EP_SRH + 8) / 4) + ')');
    }
    // The ABANDONED→IDLE reset happens inside a pump pass — keep ringing so
    // the driver's loop re-pumps while we wait (P2-006-007: heavy CJS-graph
    // storms can leave the mailbox ABANDONED for longer than one interval).
    if ((idleTries & 7) === 0) doorbell();
    // Bounded nap via a synchronous spin on the seq word (the kernel's
    // ABANDONED reset bumps sm_seq; waiting on it is the documented wake).
    const sc = Atomics.load(I32, seqIdx);
    Atomics.wait(I32, seqIdx, sc, 10);
  }
  // §11.2 F-B2 with the AV-R1b fix: CAS IDLE→SUBMITTED FIRST, THEN load the
  // expected sm_seq — a completion can only fire after SUBMITTED (and after
  // the sr_tail publish below), so seq can only move away from this value;
  // an in-flight ABANDONED-reset bump that lands between the CAS and the
  // load is absorbed by the reqId-echo retry in the retire loop.
  if (Atomics.compareExchange(I32, smbState, ABIC.SM_IDLE, ABIC.SM_SUBMITTED) !== ABIC.SM_IDLE) {
    throw new Error('sync mailbox CAS lost');
  }
  let c = Atomics.load(I32, seqIdx);
  const reqId = nextReqId++;
  let txOff = 0, txLen = 0;
  if (txBytes && txBytes.length > 0) {
    if (txBytes.length > ABIC.TX_SYNC_PAYLOAD_MAX) {
      Atomics.store(I32, smbState, ABIC.SM_IDLE);
      throw new Error('sync TX payload > 8128 B (bridge must chunk)');
    }
    txOff = ABIC.TX_SIZE - ABIC.TX_SYNC_RESERVE;
    txLen = txBytes.length;
    new Uint8Array(KSM.buffer, epBase + ABIC.EP_TX_ARENA + txOff, txLen).set(txBytes);
  }
  const srh = (epBase + ABIC.EP_SRH) / 4;
  const tail = Atomics.load(I32, srh + 1);
  const slot = epBase + ABIC.EP_SUBMIT_SLOTS + (tail & ABIC.MASK) * 64;
  const B = new DataView(KSM.buffer, slot, 64);
  B.setBigUint64(0x00, reqId, true);
  B.setUint32(0x08, op, true);
  B.setUint32(0x0c, ABIC.FLAG_MODE_SYNC, true);
  B.setUint32(0x10, txOff, true);
  B.setUint32(0x14, txLen, true);
  B.setBigUint64(0x18, a0, true);
  B.setBigUint64(0x20, a1, true);
  B.setBigUint64(0x28, a2, true);
  B.setBigUint64(0x30, 0n, true);
  B.setBigUint64(0x38, 0n, true);
  Atomics.store(I32, srh + 1, tail + 1);
  Atomics.add(I32, srh + 2, 1); // sr_sync_pending
  doorbell();
  // §11.3 ladder: escalating rungs, per-rung kernel-state + heartbeat checks.
  // E5: LAST_SYNC_WAIT_MS = wall time spent blocked in this ladder (the
  // JS-vs-wait thread split for the op); reset here, set at every exit.
  const __wlT0 = platformPerformance.now();
  LAST_SYNC_WAIT_MS = 0;
  const __wlDone = () => { LAST_SYNC_WAIT_MS = platformPerformance.now() - __wlT0; };
  const rungs = [1, 5, 20, 100, 500];
  let waited = 0, ri = 0;
  for (;;) {
    Atomics.wait(I32, seqIdx, c, rungs[ri]);
    if (Atomics.load(I32, seqIdx) !== c) { LAST_SYNC_RUNG = ri; __wlDone(); break; } // completion (or reset) bumped sm_seq
    waited += rungs[ri];
    ri = Math.min(ri + 1, rungs.length - 1);
    if (kernelDead() || endpointDead()) {
      if (Atomics.compareExchange(I32, smbState, ABIC.SM_SUBMITTED, ABIC.SM_ABANDONED) !== ABIC.SM_SUBMITTED) {
        __wlDone(); break; // completed between the checks — retire it (AV-R1a)
      }
      const err = new Error('ERR_NODINE_KERNEL_DEAD');
      err.code = 'ERR_NODINE_KERNEL_DEAD';
      __wlDone();
      throw err;
    }
    if (waited >= timeoutMs) {
      // AV-R1a: the kernel may complete between the seq check above and
      // this CAS. If the CAS FAILS the result IS there — retire it instead
      // of wedging the mailbox in COMPLETED forever.
      if (Atomics.compareExchange(I32, smbState, ABIC.SM_SUBMITTED, ABIC.SM_ABANDONED) !== ABIC.SM_SUBMITTED) {
        __wlDone(); break; // state moved (COMPLETED) — fall through to the retire path
      }
      const err = new Error('ERR_NODINE_ETIMEOUT');
      err.code = 'ERR_NODINE_ETIMEOUT';
      __wlDone();
      throw err;
    }
  }
  // Retire (with the AV-R1b reqId-echo retry: an ABANDONED-reset bump can
  // land between our CAS and our first wait, waking us on the WRONG seq —
  // the mailbox fields then echo the OLD reqId; re-arm and keep waiting).
  const deadline = Date.now() + 1000;
  for (;;) {
    const DV = new DataView(KSM.buffer, smb, 64);
    const state = Atomics.load(I32, smbState);
    const echoId = DV.getBigUint64(0x10, true);
    if (state === ABIC.SM_COMPLETED && echoId === reqId) {
      const out = {
        reqId: echoId,
        op: DV.getUint32(0x08, true),
        status: DV.getInt32(0x18, true),
        kind: DV.getUint32(0x1c, true),
        len: DV.getUint32(0x24, true),
      };
      if (out.kind === ST.SYNCRES && out.len > 0) {
        out.payload = new Uint8Array(KSM.buffer, epBase + ABIC.EP_SYNCRES, out.len).slice();
      } else if (out.kind === ST.INLINE && out.len > 0) {
        out.payload = new Uint8Array(KSM.buffer, smb + 0x28, Math.min(out.len, 16)).slice();
      } else {
        out.payload = new Uint8Array(0);
      }
      Atomics.compareExchange(I32, smbState, ABIC.SM_COMPLETED, ABIC.SM_IDLE);
      return out;
    }
    // Not our completion yet: either a stale wake (reset bump) or still
    // SUBMITTED — re-arm on the CURRENT seq and keep waiting (bounded).
    if (Date.now() > deadline) {
      Atomics.compareExchange(I32, smbState, ABIC.SM_SUBMITTED, ABIC.SM_ABANDONED);
      const err = new Error('ERR_STALE_COMPLETION');
      err.code = 'ERR_STALE_COMPLETION';
      throw err;
    }
    c = Atomics.load(I32, seqIdx);
    Atomics.wait(I32, seqIdx, c, 50);
  }
}

// ---- §12 async submit + persistent completion consumer ---------------------
// §9.2 TX bump allocator: spans are handed out linearly from
// [0, TX_SIZE - TX_SYNC_RESERVE); completion retires are FIFO, so the span
// FIFO front tells us which prefix is reclaimable. Full-drain resets the
// frontier to 0; mid-stream, only tail-end space is allocatable (no
// mid-arena compaction — documented cost, same discipline as the RX ledger).
const TX_ASYNC_LIMIT = ABIC.TX_SIZE - ABIC.TX_SYNC_RESERVE; // 248 KiB
let txTail = 0;
const txSpans = []; // FIFO of { reqId, off, need } in submit order
function txAlloc(len) {
  const need = (len + 7) & ~7;
  if (need > TX_ASYNC_LIMIT) return -2; // never fits — caller must chunk
  if (txTail + need > TX_ASYNC_LIMIT) return -1; // queue until retire
  const off = txTail;
  txTail += need;
  return off;
}
function ringFull() {
  const srh = (epBase + ABIC.EP_SRH) / 4;
  const used = Atomics.load(I32, srh + 1) - Atomics.load(I32, srh);
  return used > ABIC.RING_SLOTS - ABIC.SYNC_RING_SLOTS;
}
function publishAsyncRecord(op, a0, a1, a2, txOff, txLen) {
  const reqId = nextReqId++;
  const srh = (epBase + ABIC.EP_SRH) / 4;
  const tail = Atomics.load(I32, srh + 1);
  const slot = epBase + ABIC.EP_SUBMIT_SLOTS + (tail & ABIC.MASK) * 64;
  const B = new DataView(KSM.buffer, slot, 64);
  B.setBigUint64(0x00, reqId, true);
  B.setUint32(0x08, op, true);
  B.setUint32(0x0c, 0, true); // async
  B.setUint32(0x10, txOff, true);
  B.setUint32(0x14, txLen, true);
  B.setBigUint64(0x18, a0, true);
  B.setBigUint64(0x20, a1, true);
  B.setBigUint64(0x28, a2, true);
  B.setBigUint64(0x30, 0n, true);
  B.setBigUint64(0x38, 0n, true);
  Atomics.store(I32, srh + 1, tail + 1);
  return reqId;
}
function trySubmitOne(job) {
  // job = { op, a0, a1, a2, txBytes, resolve, reject }
  if (kernelDead()) {
    const err = new Error('ERR_NODINE_KERNEL_DEAD'); err.code = 'ERR_NODINE_KERNEL_DEAD';
    job.reject(err); return true;
  }
  if (job.op !== OP.PROC_READY && endpointDead()) {
    const err = new Error('ERR_NODINE_EENDPOINT'); err.code = 'ERR_NODINE_EENDPOINT';
    job.reject(err); return true;
  }
  if (ringFull()) return false;
  let txOff = 0, txLen = 0;
  if (job.txBytes && job.txBytes.length > 0) {
    txOff = txAlloc(job.txBytes.length);
    if (txOff === -2) {
      const err = new Error(`async TX payload ${job.txBytes.length} exceeds the arena ${TX_ASYNC_LIMIT} (op 0x${job.op.toString(16)}) — bridge must chunk`);
      err.code = 'EINVAL'; err.errno = -22;
      job.reject(err); return true;
    }
    if (txOff < 0) return false; // queue until retire frees tail space
    new Uint8Array(KSM.buffer, epBase + ABIC.EP_TX_ARENA + txOff, job.txBytes.length).set(job.txBytes);
    txLen = job.txBytes.length;
  }
  const reqId = publishAsyncRecord(job.op, job.a0, job.a1, job.a2, txOff, txLen);
  outstanding.set(reqId, job);
  if (txLen > 0) txSpans.push({ reqId, off: txOff, need: (txLen + 7) & ~7 });
  doorbell();
  return true;
}
function pumpBridgeQueue() {
  while (bridgeQueue.length > 0) {
    if (!trySubmitOne(bridgeQueue[0])) break;
    bridgeQueue.shift();
  }
}
function asyncOp(op, a0 = 0n, a1 = 0n, a2 = 0n, txBytes = null) {
  refreshViews();
  traceLife('async-op', 'op=0x' + op.toString(16));
  return new Promise((resolve, reject) => {
    const job = { op, a0, a1, a2, txBytes, resolve, reject };
    if (PERF) job.submitT = platformPerformance.now();
    if (bridgeQueue.length > 0 || !trySubmitOne(job)) {
      if (bridgeQueue.length >= BRIDGE_QUEUE_MAX) {
        const err = new Error('EAGAIN'); err.code = 'EAGAIN'; err.errno = -11;
        reject(err); return;
      }
      bridgeQueue.push(job);
    }
  });
}
// P2-008 Phase-5: async EAGAIN resubmission counters (soak evidence — the
// fix firing without a failure is a healthy signal, not noise).
const ASYNC_EAGAIN_RETRIES = { retries: 0, exhausted: 0 };
function rejectJob(job, rec) {
  const err = new Error(`nodine fs op 0x${rec.op.toString(16)} failed: ${rec.status}`);
  err.errno = rec.status; err.nodineStatus = rec.status;
  // Node error shape: uv errnos map to their code name so userland
  // catch blocks see e.code === 'ENOENT' etc.
  for (const e of UVMAP) {
    if (e.value === rec.status) { err.code = e.name; break; }
  }
  if (!err.code && rec.status <= -0x10000000) {
    err.code = 'ERR_NODINE_' + (-rec.status - 0x10000000).toString(16).toUpperCase().padStart(8, '0');
  }
  job.reject(err);
}
function drainCompletions() {
  refreshViews();
  const crh = epBase + ABIC.EP_CRH;
  let head = Atomics.load(I32, crh / 4);
  const tail = Atomics.load(I32, (crh / 4) + 1);
  let progressed = false;
  while (head !== tail) {
    const slot = epBase + ABIC.EP_COMPLETION_SLOTS + (head & ABIC.MASK) * 64;
    const DV = new DataView(KSM.buffer, slot, 64);
    const rec = {
      reqId: DV.getBigUint64(0x00, true),
      op: DV.getUint32(0x08, true),
      status: DV.getInt32(0x0c, true),
      kind: DV.getUint32(0x10, true),
      len: DV.getUint32(0x14, true),
      off: DV.getUint32(0x18, true),
    };
    // capture payload BEFORE retire (RX arena bytes are only valid until the
    // kernel reuses the span).
    if (rec.kind === ST.RX && rec.len > 0) {
      rec.payload = new Uint8Array(KSM.buffer, epBase + ABIC.EP_RX_ARENA + rec.off, rec.len).slice();
    } else if (rec.kind === ST.INLINE && rec.len > 0) {
      rec.payload = new Uint8Array(KSM.buffer, slot + 0x20, Math.min(rec.len, 16)).slice();
    } else {
      rec.payload = new Uint8Array(0);
    }
    head++;
    Atomics.store(I32, crh / 4, head); // retire (frees the RX span)
    const job = outstanding.get(rec.reqId);
    if (job) {
      outstanding.delete(rec.reqId);
      traceLife('async-done', 'op=0x' + rec.op.toString(16) + ' st=' + rec.status);
      if (PERF && job.submitT !== undefined) {
        perfRpcDone(rec.op, job.submitT, -1, true);
        // S0.6 Step-1b: per-completion arrival-mode attribution + batch size
        const __lat = platformPerformance.now() - job.submitT;
        const D = PERF.deliv;
        D.byMode[PERF_DELIV_MODE] = (D.byMode[PERF_DELIV_MODE] || 0) + 1;
        D.lat[PERF_DELIV_MODE] = D.lat[PERF_DELIV_MODE] || new Array(PERF_LAT_EDGES.length + 1).fill(0);
        D.lat[PERF_DELIV_MODE][perfLatBucket(__lat)]++;
        D.batch++;
      }
      // P2-008 Phase-5: the kernel's §17.3-item-4 ladder completes
      // arena-starved deferrals with uv::EAGAIN. That conversion happens
      // on the defer path BEFORE process_entry runs (kernel-core lib.rs,
      // the `cr_used >= RING_SLOTS || rx_short` branch) — the op never
      // executed, so resubmitting is side-effect-free for ANY op. Real
      // libuv never rejects an fs request with EAGAIN; npm/tar's async
      // stat callback saw exactly that (CwdError → rollback, the soak
      // c2-c7 root cause). Resubmit with pacing until the arena drains
      // (retires free spans), 10000 attempts (the binding cap under storms —
      // 2 ms pacing burns 1000 in ~2 s; npm's rm-storms outlast that) with a
      // 30 s wall cap, then fail honestly. READ (0x0102) is excluded as a
      // canary: if the pre-dispatch invariant ever breaks, READ's fd+offset
      // cursor is the op class where a re-execution would be observable first.
      if (rec.status === UV.UV_EAGAIN && rec.op !== OP.READ && (job.eagainAttempts || 0) < 10000) {
        job.eagainAttempts = (job.eagainAttempts || 0) + 1;
        ASYNC_EAGAIN_RETRIES.retries++;
        if (!job.eagainT0) job.eagainT0 = platformPerformance.now();
        if (platformPerformance.now() - job.eagainT0 > 30000) {
          ASYNC_EAGAIN_RETRIES.exhausted++;
          rejectJob(job, rec);
        } else {
          platformSetTimeout(() => {
            if (outstanding.has(rec.reqId)) return; // already resubmitted
            // keep the ORIGINAL promise identity: park the job under a
            // NEW reqId that trySubmitOne mints at publish time.
            const ok = trySubmitOne(job);
            if (!ok) {
              if (bridgeQueue.length >= BRIDGE_QUEUE_MAX) {
                ASYNC_EAGAIN_RETRIES.exhausted++;
                rejectJob(job, rec);
              } else {
                bridgeQueue.push(job); // park; pumpBridgeQueue resubmits
              }
            }
          }, 2); // 2 ms pacing: let the drain loop retire more spans first
        }
      } else if (rec.status === UV.UV_EAGAIN) {
        ASYNC_EAGAIN_RETRIES.exhausted++;
        rejectJob(job, rec);
      } else if (rec.status === 0) job.resolve(rec);
      else {
        rejectJob(job, rec);
      }
    }
    progressed = true;
  }
  // TX span reclaim: retires are FIFO, so compact the span FIFO from the
  // front while its reqId is no longer outstanding; a fully drained arena
  // resets the bump frontier to 0.
  while (txSpans.length && !outstanding.has(txSpans[0].reqId)) txSpans.shift();
  if (txSpans.length === 0) txTail = 0;
  if (progressed) pumpBridgeQueue();
  return progressed;
}
function armCompletions() {
  if (armed || globalThis.__P2006_NO_PUMP) return;
  armed = true;
  const pump = () => {
    if (!KSM) return;
    const crSeqIdx = (epBase + ABIC.EP_CRH + 8) / 4;
    // S0.6 F1: WORK-CONSERVING drain loop. The Step-1b measurement
    // (docs/perf/async-completion-path.md §3.1) showed the old
    // `engineSetTimeout(pump, 250)` re-drain on sync "not-equal" parked the
    // whole completion path a quarter-second per hit — 88% of the
    // sequential-extract wall (1,020 hits) and 96% of par8 (6,336 hits,
    // the EMFILE storm's fuel). The wait result of the PREVIOUS arm still
    // decides how THIS drain's completions arrived ('wake' / 'tick' /
    // 'defer' — the Step-1b tagging is unchanged).
    for (;;) {
      if (PERF) PERF_DELIV_MODE = PERF_DELIV_PENDING || 'boot';
      PERF_DELIV_PENDING = null;
      const __dpT0 = platformPerformance.now();
      const __dpBatchBefore = PERF ? PERF.deliv.batch : 0;
      const expected = Atomics.load(I32, crSeqIdx); // BEFORE drain (§15.5)
      const got = drainCompletions();
      if (PERF) {
        const dur = platformPerformance.now() - __dpT0;
        PERF.deliv.passes[PERF_DELIV_MODE] = (PERF.deliv.passes[PERF_DELIV_MODE] || 0) + 1;
        PERF.deliv.drainDur.push(dur);
        if (PERF.deliv.drainDur.length > 4096) PERF.deliv.drainDur.splice(0, 2048);
        const __batch = PERF.deliv.batch - __dpBatchBefore;
        if (__batch > 0) PERF.deliv.batchHist[Math.min(19, Math.floor(Math.log2(__batch) + 0.5))]++;
        if (!got && PERF_DELIV_MODE !== 'boot') PERF.deliv.idleDrains++;
      }
      const w = Atomics.waitAsync(I32, crSeqIdx, expected, 250);
      if (w.async) {
        w.value.then((res) => {
          if (PERF) PERF_DELIV_PENDING = (res === 'ok') ? 'wake' : 'tick';
          pump();
        }, pump);
        return;
      }
      // sync "not-equal": completions are in the ring RIGHT NOW. Re-drain
      // in place (F1; was: engineSetTimeout(pump, 250)).
      //
      // Termination: this loop runs synchronously — no microtask can run
      // inside it (job resolve/reject merely QUEUE reactions), so nothing
      // can submit NEW ops while we spin; the kernel can only complete ops
      // that were already in flight (submit ring ≤ 4 096 slots;
      // pumpBridgeQueue only re-submits parked jobs — ≤ 1 024 — as
      // completions retire, it never mints work). A sync "not-equal" means
      // cr_seq advanced since the expected load ⇒ the kernel published ≥ 1
      // completion ⇒ the NEXT iteration's drain retires ≥ 1 of a finite,
      // non-growing set. The loop therefore reaches a quiet arm (waitAsync
      // goes async) in finitely many iterations — worst case bounded by
      // in-flight ops, each iteration being real work the old code would
      // have charged a 250 ms timer for.
      if (PERF) PERF_DELIV_PENDING = 'defer';
      continue;
    }
  };
  pump();
}
// §5.5 bridge heartbeat + §21.3 health timer.
let hbTimer = null;
function startHeartbeat() {
  if (hbTimer || globalThis.__P2006_NO_HB) return;
  hbTimer = engineSetInterval(() => {
    if (!KSM) return;
    const now = BigInt(Date.now());
    const dv = new DataView(KSM.buffer, epBase + ABIC.EP_HEADER, 64);
    dv.setUint32(0x18, Number(now & 0xFFFFFFFFn), true);
    dv.setUint32(0x1c, Number(now >> 32n), true);
  }, 200);
}
let perfSelfWakeStarted = false;
// S0.6 Step-1b (§3.2 fix): the notify→waitAsync-promise→then hop latency,
// driver out of the loop, measured on a PRIVATE 4-byte SAB. The original
// design armed cr_seq — the same cell the permanent pump arms — where
// Atomics.notify wakes an ARBITRARY waiter (it would have raced the pump
// even had it run post-attach); and it ran at activatePerf time, before
// KSM existed, so it never ran at all (selfWake: null, s06probe). 200
// iterations, p50/p90/p99 in perf-exit. PERF-gated, zero behavior change.
function startPerfSelfWake() {
  if (perfSelfWakeStarted) return;
  perfSelfWakeStarted = true;
  (async () => {
    try {
      const ia = new Int32Array(new SharedArrayBuffer(4));
      const lat = [];
      for (let i = 0; i < 200; i++) {
        ia[0] = 0;
        const t0 = platformPerformance.now();
        const w = Atomics.waitAsync(ia, 0, 0, 1000);
        Atomics.notify(ia, 0, 1);
        await w.value;
        lat.push(platformPerformance.now() - t0);
      }
      const s = lat.slice().sort((a, b) => a - b);
      PERF.deliv.selfWake = { n: lat.length, p50: +s[Math.floor(s.length * 0.5)].toFixed(3), p90: +s[Math.floor(s.length * 0.9)].toFixed(3), p99: +s[Math.min(s.length - 1, Math.floor(s.length * 0.99))].toFixed(3) };
    } catch {}
  })();
}
function transportAttach(memory, index, generation) {
  KSM = memory;
  epIndex = index;
  epGeneration = generation;
  epBase = ABIC.TRANSPORT_BASE + index * ABIC.EP_STRIDE;
  refreshViews();
  startHeartbeat();
  armCompletions();
  if (PERF) startPerfSelfWake();
}
// STAT/LSTAT/FSTAT result -> Node's 18-slot array
let processExitCode = undefined; // set by process_methods reallyExit (module scope)
function statArray(payload, bigint) {
  if (bigint) return new BigInt64Array(payload.buffer, payload.byteOffset, 18);
  return new Float64Array(payload.buffer, payload.byteOffset, 18);
}

// UV errno values from the real libuv table (uv-errno-linux.txt, generated
// from node v26.13.0's vendored deps/uv headers + system errno.h).
const UV = {};
for (const e of UVMAP) UV['UV_' + e.name] = e.value;

// ---------------------------------------------------------------------------
// 3. Binding registry — the entire native seam. Ported from
//    poc/p1-a/realm-harness.mjs (P1-A2, 30 bindings) + the new REAL
//    implementations this PoC adds: 'uv', real 'fs', real 'modules', timers
//    loop driver, process_methods cwd/abort, messaging.DOMException.
// ---------------------------------------------------------------------------
const bindingFactories = new Map();
const bindingCache = new Map();
function getInternalBinding(name) {
  if (bindingCache.has(name)) return bindingCache.get(name);
  const factory = bindingFactories.get(name);
  if (factory === undefined) {
    const err = new Error(`No such binding: ${name}`);
    err.code = 'ERR_INVALID_MODULE';
    throw err; // mirrors node_binding.cc:1012
  }
  const exports = factory();
  bindingCache.set(name, exports);
  return exports;
}
function getLinkedBinding(name) {
  // process._linkedBinding is for embedder-linked C++ addons only
  // (node_binding.cc:1018-1072); Nodine services everything via
  // internalBinding, so linked bindings stay empty.
  const err = new Error(`No such binding was linked: ${name}`);
  err.code = 'ERR_INVALID_MODULE';
  throw err;
}
function defBinding(name, factory) { bindingFactories.set(name, factory); }

// OBLIGATION 1+2: private/per-isolate symbol tables (env_properties.h:20-76).
const privateSymbols = {
  arrow_message_private_symbol: Symbol('node:arrowMessage'),
  contextify_context_private_symbol: Symbol('node:contextify:context'),
  decorated_private_symbol: Symbol('node:decorated'),
  empty_context_frame_sentinel_symbol: Symbol('node:empty_context_frame_sentinel'),
  ffi_pointer_address_private_symbol: Symbol('node:ffi:pointer_address'),
  transfer_mode_private_symbol: Symbol('node:transfer_mode'),
  host_defined_option_symbol: Symbol('node:host_defined_option_symbol'),
  js_transferable_wrapper_private_symbol: Symbol('node:js_transferable_wrapper'),
  entry_point_module_private_symbol: Symbol('node:entry_point_module'),
  entry_point_promise_private_symbol: Symbol('node:entry_point_promise'),
  module_source_private_symbol: Symbol('node:module_source'),
  module_export_names_private_symbol: Symbol('node:module_export_names'),
  module_circular_visited_private_symbol: Symbol('node:module_circular_visited'),
  module_export_private_symbol: Symbol('node:module_export'),
  module_first_parent_private_symbol: Symbol('node:module_first_parent'),
  module_last_parent_private_symbol: Symbol('node:module_last_parent'),
  napi_type_tag: Symbol('node:napi:type_tag'),
  napi_wrapper: Symbol('node:napi:wrapper'),
  untransferable_object_private_symbol: Symbol('node:untransferableObject'),
  exit_info_private_symbol: Symbol('node:exit_info_private_symbol'),
  promise_trace_id: Symbol('node:promise_trace_id'),
  source_map_data_private_symbol: Symbol('node:source_map_data_private_symbol'),
};
const perIsolateSymbols = {
  fs_use_promises_symbol: Symbol('fs_use_promises_symbol'),
  async_id_symbol: Symbol('async_id_symbol'),
  ffi_sb_shared_buffer_symbol: Symbol('ffi_sb_shared_buffer_symbol'),
  ffi_sb_invoke_slow_symbol: Symbol('ffi_sb_invoke_slow_symbol'),
  ffi_sb_arguments_symbol: Symbol('ffi_sb_arguments_symbol'),
  ffi_sb_return_symbol: Symbol('ffi_sb_return_symbol'),
  constructor_key_symbol: Symbol('constructor_key_symbol'),
  handle_onclose_symbol: Symbol('handle_onclose'),
  // P2-006-008: internal/worker/io.js destructures the UNSUFFIXED spellings
  // (handle_onclose, oninit) — missing keys made every MessagePort prototype
  // defineProperty land on the SAME "undefined" key and the second one threw
  // "TypeError: Cannot redefine property: undefined" (killed worker_threads
  // → create-expo). Both spellings now alias the same symbols.
  handle_onclose: Symbol('handle_onclose'),
  oninit: Symbol('oninit'),
  no_message_symbol: Symbol('no_message_symbol'),
  messaging_deserialize_symbol: Symbol('messaging_deserialize_symbol'),
  imported_cjs_symbol: Symbol('imported_cjs_symbol'),
  messaging_transfer_symbol: Symbol('messaging_transfer_symbol'),
  messaging_clone_symbol: Symbol('messaging_clone_symbol'),
  messaging_transfer_list_symbol: Symbol('messaging_transfer_list_symbol'),
  oninit_symbol: Symbol('oninit'),
  owner_symbol: Symbol('owner_symbol'),
  onpskexchange_symbol: Symbol('onpskexchange'),
  resource_symbol: Symbol('resource_symbol'),
  trigger_async_id_symbol: Symbol('trigger_async_id_symbol'),
  builtin_source_text_module_hdo: Symbol('node:builtin_source_text_module_hdo'),
  embedder_module_hdo: Symbol('node:embedder_module_hdo'),
  source_text_module_default_hdo: Symbol('node:source_text_module_default_hdo'),
  vm_context_no_contextify: Symbol('node:vm_context_no_contextify'),
  vm_dynamic_import_default_internal: Symbol('node:vm_dynamic_import_default_internal'),
  vm_dynamic_import_main_context_default: Symbol('node:vm_dynamic_import_main_context_default'),
  vm_dynamic_import_missing_flag: Symbol('node:vm_dynamic_import_missing_flag'),
  vm_dynamic_import_no_callback: Symbol('node:vm_dynamic_import_no_callback'),
};

// OBLIGATION 3: process object skeleton as C++ creates it before any JS runs
// (node_process_object.cc:96-158). 3a: mutable own-prototype object
// (bootstrap/node.js:425-426 setPrototypeOf(getPrototypeOf(process), EE.proto)).
const NODE_VERSION = LIBDATA.nodeVersion; // '26.13.0' — the REAL runtime under test
let hostCwd = null; // set from INIT.cwd in main() (kernel-authoritative mirror)
// Lexical posix normalize (mirror discipline for process.cwd(); symlink
// components are resolved kernel-side but the mirror stays lexical — the
// documented divergence, no getcwd op in v1.0.3).
function hostCwdResolve(d) {
  const base = String(d).startsWith('/') ? '' : (hostCwd || '/');
  const parts = (base + '/' + String(d)).split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('');
}
const realmProcess = (() => {
  const hiddenProto = {};
  const p = Object.create(hiddenProto);
  Object.defineProperty(p, 'version', { value: `v${NODE_VERSION}` });
  // P2-006-007: the environment comes from the spawn contract (INIT.env) —
  // the supervisor composes HOME/PATH/TERM/npm_config_* per process.
  p.env = Object.assign(Object.create(null), INIT?.env || {
    NODE_ENV: 'nodine-poc', LANG: 'en_US.UTF-8', HOME: '/home/user', PATH: '/usr/bin:/bin',
  });
  p.versions = Object.freeze({
    node: NODE_VERSION,
    v8: 'host-engine', // the browser engine — fidelity decision (documented divergence)
    uv: 'bridge',      // the loop driver below, not libuv
    openssl: 'bridge-noble', // the crypto bridge (@noble/hashes + js-md5; sync hashes)
  });
  // B20: arch is 'x64', NOT 'wasm32' — the same B16 discipline as platform.
  // The runtime EMULATES a Linux x64 Node: uv-errno-linux table, /usr/bin
  // PATH, glibc-shaped npm. process.arch is the arch the Node BINARY was
  // built for (lib/os.js just returns it) — and the entire ecosystem keys
  // arch tables off it. 'wasm32' broke fb-dotslash's artifact map during
  // create-expo-app → `npm start` (React Native DevTools prep):
  //   const artifacts = artifactsByPlatformAndArch['linux']; // {x64, arm64}
  //   const { slug, binary } = artifacts['wasm32'] ?? artifacts['*']; // 💥
  // (linux has no '*' fallback — destructure of undefined; B16 already
  // fixed the PLATFORM half for the same reason). os.machine() stays
  // honestly 'wasm32-browser' (B17 report parity: diagnostics, not keys).
  Object.defineProperty(p, 'arch', { value: 'x64' });
  // B16: platform is 'linux', NOT 'nodine' — the runtime IS a Linux-shaped
  // environment (uv-errno-linux.txt errno table, /usr/bin PATH, POSIX shell,
  // glibc-style npm behavior). A custom platform string breaks every
  // platform-keyed table in the ecosystem (fb-dotslash read `undefined.wasm32`
  // → "Cannot read properties of undefined (reading 'wasm32')" during
  // create-expo-app; npm/metro/esbuild key off it too). 'linux' is the honest
  // value for what we emulate; identity lives in os.hostname()/report.
  Object.defineProperty(p, 'platform', { value: 'linux' });
  p.release = Object.freeze({ name: 'node' });
  p._rawDebug = (...a) => platformConsoleError('[rawDebug]', ...a);
  p[privateSymbols.exit_info_private_symbol] = [0, 0, 0];
  return p;
})();

// OBLIGATION 4: 'builtins' — the builtin loader core (node_builtins.cc:869-910).
const capturedLoaders = { internalBinding: undefined, requireBuiltin: undefined };
// P2-006-007: the CJS dynamic-import ESM lane — Node's cascaded ESM loader,
// reachable from userland CJS (whose require cannot name internal modules).
// Mirrors loader.js loadESMFromCJS.

// ---- P2-006-007: the bare-specifier ESM mini-loader ------------------------
// Node's cascaded ESM loader needs the ModuleJobSync path (sync evaluation)
// that this engine cannot provide (blob imports are async-only). This loader
// provides the SAME resolution semantics for the package graphs we run:
//   - relative / absolute / '#' package imports / bare node_modules walk
//   - package.json exports (string | {import,default,require}) / main
//   - ESM deps: recursive blob modules with specifiers rewritten to dep URLs
//   - CJS deps + node: builtins: executed by the worker's REAL CJS machinery,
//     exposed to the blob graph through globalThis.__NODINE_CJS_REGISTRY
// Memoized by absolute path; cycles fall back to a rejected import (rare in
// practice for the npm tree — documented limitation).
globalThis.__NODINE_CJS_REGISTRY = new Map();
let __cjsRegId = 0;
const esmLoaderMemo = new Map(); // abs path -> Promise<ns>
const BUILTIN_IDS = new Set(builtinIds);
// The §11 mailbox can be ABANDONED for a few pump passes under CJS-graph
// storms; the loader's sync helpers retry instead of failing resolution
// (a spurious ENOENT here poisons package.json detection — the falsified
// 'type' verdict sends CJS packages down the ESM lane).
function esmSyncRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= 6 || !/sync mailbox stuck/.test(String(e && e.message))) throw e;
      // yield a macrotask so the driver's pump passes run + retry
      const sc = Atomics.load(I32, (epBase + ABIC.EP_MBOX) / 4);
      Atomics.wait(I32, (epBase + ABIC.EP_MBOX) / 4, sc, 25);
    }
  }
}
function esmReadFile(p) {
  const fsb = getInternalBinding('fs');
  return fsb.readFileUtf8 ? esmSyncRetry(() => fsb.readFileUtf8(p, 0)) : null;
}
function esmStatKind(p) {
  // returns 'file' | 'dir' | null via the binding's stat sync path
  const fsb = getInternalBinding('fs');
  const res = esmSyncRetry(() => syncOp(OP.STAT, 0n, 0n, 0n, platformTextEncoder.encode(p)));
  if (res.status !== 0) return null;
  const mode = new Float64Array(res.payload.buffer, res.payload.byteOffset, 18)[1];
  if ((mode & 0xF000) === 0x4000) return 'dir';
  return 'file';
}
function esmReadJson(p) {
  try { const t = esmReadFile(p); return t ? JSON.parse(t) : null; } catch { return null; }
}
function esmNearestPackageJson(file) {
  let dir = file.slice(0, file.lastIndexOf('/'));
  for (;;) {
    const pj = esmReadJson(dir + '/package.json');
    if (pj) return { dir, pj };
    if (dir === '' || dir === '/') return null;
    const up = dir.slice(0, dir.lastIndexOf('/'));
    if (up === dir) return null;
    dir = up;
  }
}
function esmTryFile(base) {
  for (const cand of [base, base + '.mjs', base + '.js', base + '.cjs', base + '/index.mjs', base + '/index.js', base + '/index.cjs']) {
    if (esmStatKind(cand) === 'file') return cand;
  }
  return null;
}
function esmExportsTarget(pj, preferImport) {
  const ex = pj.exports;
  if (typeof ex === 'string') return ex;
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    // Node condition order (ESM import context): node > import > require >
    // default. We are a node-shaped runtime — the 'default' (browser)
    // fallback comes LAST (P2-006-007 falsifier catch: picking 'default'
    // first served browser builds that lack the node API surface).
    const pick = (obj) => {
      if (typeof obj === 'string') return obj;
      if (obj && typeof obj === 'object') {
        for (const cond of preferImport === false ? ['node', 'require', 'import', 'default'] : ['node', 'import', 'require', 'default']) {
          if (obj[cond] !== undefined) {
            const r = pick(obj[cond]);
            if (r !== null) return r;
          }
        }
      }
      return null;
    };
    const r = pick(ex);
    if (r !== null) return r;
  }
  return null;
}
function esmResolveSpec(spec, parentFile) {
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
    const base = spec.startsWith('/') ? spec : parentFile.slice(0, parentFile.lastIndexOf('/') + 1) + spec;
    const resolved = esmTryFile(base);
    if (resolved) return resolved;
    // strip query/hash then retry
    const cleaned = base.split('?')[0].split('#')[0];
    return esmTryFile(cleaned) || cleaned;
  }
  if (spec.startsWith('#')) {
    const pkg = esmNearestPackageJson(parentFile);
    const importsMap = pkg && pkg.pj.imports;
    if (importsMap) {
      let target = importsMap[spec];
      if (typeof target === 'object' && target !== null) {
        // conditions: import > node > default > require (Node order, browser-
        // compatible fallbacks last)
        target = target.import ?? target.node ?? target.default ?? target.require;
        if (typeof target === 'object' && target !== null) {
          target = target.import ?? target.node ?? target.default ?? target.require;
        }
      }
      if (typeof target === 'string') {
        const base = pkg.dir + '/' + target.replace(/^\.\//, '');
        return esmTryFile(base) || base;
      }
    }
    const dbg = pkg ? ('; pkg=' + pkg.dir + ' imports=' + JSON.stringify(Object.keys(pkg.pj.imports || {})) + ' raw=' + JSON.stringify(pkg.pj.imports && pkg.pj.imports[spec]).slice(0, 200)) : '; NO package.json found';
    throw new Error('Cannot resolve package import ' + spec + ' from ' + parentFile + dbg);
  }
  // builtin?
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  if (spec.startsWith('node:') || BUILTIN_IDS.has(bare)) return 'builtin:' + bare;
  // node_modules walk
  let dir = parentFile.slice(0, parentFile.lastIndexOf('/'));
  for (;;) {
    const nmRoot = dir + '/node_modules/' + bare;
    const pj = esmReadJson(nmRoot + '/package.json');
    if (pj) {
      const target = esmExportsTarget(pj, true) || pj.main || './index.js';
      const base = nmRoot + '/' + String(target).replace(/^\.\//, '');
      const resolved = esmTryFile(base);
      if (resolved) return resolved;
    } else if (esmStatKind(nmRoot) === 'dir') {
      const idx = esmTryFile(nmRoot);
      if (idx) return idx;
    }
    const up = dir.slice(0, dir.lastIndexOf('/'));
    if (up === dir || dir === '') break;
    dir = up;
  }
  return null;
}
function esmIsCjs(file) {
  if (file.endsWith('.cjs')) return true;
  if (file.endsWith('.mjs')) return false;
  const pkg = esmNearestPackageJson(file);
  return !(pkg && pkg.pj.type === 'module');
}
function esmScanRequests(src) {
  const specs = new Set();
  const re = /(?:^|[\s;}])(?:import|export)\s+[^'";()]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (spec) specs.add(spec);
  }
  return [...specs];
}
function esmCjsBridgeBlob(mod, namedKeys) {
  const id = 'cjs-' + (++__cjsRegId);
  // Register under the SAME id the blob resolves (P2-006-007 falsifier
  // catch: the first cut keyed by blob URL while the blob fetched by id —
  // every bridge import silently yielded undefined).
  globalThis.__NODINE_CJS_REGISTRY.set(id, mod);
  const lines = [
    'const __m = globalThis.__NODINE_CJS_REGISTRY_GET(' + JSON.stringify(id) + ');',
    'const __ns = (__m && (typeof __m === \'object\' || typeof __m === \'function\')) ? { ...__m } : {};',
    '__ns.default = (__m && __m.default !== undefined && __m.__esModule) ? __m.default : __m;',
  ];
  for (const k of namedKeys) {
    lines.push('export const ' + JSON.stringify(k).slice(1, -1) + ' = (__m && __m[' + JSON.stringify(k) + '] !== undefined) ? __m[' + JSON.stringify(k) + '] : undefined;');
  }
  lines.push('export default __ns.default;');
  return platformCreateObjectURL(new platformBlobCtor([lines.join('\n')], { type: 'text/javascript' }));
}
function esmLoadBuiltin(name) {
  const reqB = capturedLoaders.requireBuiltin;
  const mod = reqB(name);
  return mod;
}
async function esmLoadModule(absPath) {
  const memo = esmLoaderMemo.get(absPath);
  if (memo) return memo;
  const p = (async () => {
    report({ type: 'esm-load', path: absPath, cjs: esmIsCjs(absPath) });
    if (esmIsCjs(absPath)) {
      // CJS package: execute through the WORKER's real CJS machinery via a
      // synthetic require from the parent context is not possible here — use
      // the requireBuiltin-free path: read + compile via the fs binding's
      // CJS loader hook through a Module created by Node's loader.
      // The cleanest available execution context: globalThis.__nodineCjsRequire
      // (installed below once the CJS loader is live).
      const mod = await globalThis.__nodineCjsRequire(absPath);
      const named = mod && (typeof mod === 'object' || typeof mod === 'function') ? Object.keys(mod).slice(0, 512) : [];
      const blob = esmCjsBridgeBlob(mod, named);
      const ns = await import(blob);
      return { ns, blobUrl: blob };
    }
    const src = esmReadFile(absPath);
    if (src === null || src === undefined) throw new Error('ESM read failed: ' + absPath);
    const specs = esmScanRequests(src);
    let rewritten = src;
    for (const spec of specs) {
      let depUrl;
      const resolved = esmResolveSpec(spec, absPath);
      if (resolved === null) continue; // leave as-is; the engine will error honestly
      if (resolved.startsWith('builtin:')) {
        const name = resolved.slice(8);
        const mod = esmLoadBuiltin(name);
        const named = mod && (typeof mod === 'object' || typeof mod === 'function') ? Object.keys(mod).slice(0, 512) : [];
        depUrl = esmCjsBridgeBlob(mod, named);
      } else if (esmIsCjs(resolved)) {
        const mod = await globalThis.__nodineCjsRequire(resolved);
        const named = mod && (typeof mod === 'object' || typeof mod === 'function') ? Object.keys(mod).slice(0, 512) : [];
        depUrl = esmCjsBridgeBlob(mod, named);
      } else {
        const rec = await esmLoadModule(resolved);
        depUrl = rec.blobUrl;
      }
      if (depUrl) {
        rewritten = rewritten.split("'" + spec + "'").join("'" + depUrl + "'");
        rewritten = rewritten.split('"' + spec + '"').join('"' + depUrl + '"');
      }
    }
    report({ type: 'esm-blob', path: absPath, specs: specs.length, bytes: rewritten.length });
    const blob = platformCreateObjectURL(new platformBlobCtor([rewritten], { type: 'text/javascript' }));
    const ns = await Promise.race([
      import(blob),
      new Promise((_, rej) => engineSetTimeout(() => rej(new Error('esm blob import timeout: ' + absPath)), 15000)),
    ]);
    report({ type: 'esm-blob-ok', path: absPath });
    return { ns, blobUrl: blob };
  })();
  esmLoaderMemo.set(absPath, p);
  return p;
}
async function esmImportSpec(spec, parentFile) {
  const resolved = esmResolveSpec(spec, parentFile);
  if (resolved === null) throw new Error("Cannot find module '" + spec + "' imported from " + parentFile);
  if (resolved.startsWith('builtin:')) {
    const mod = esmLoadBuiltin(resolved.slice(8));
    const ns = mod && (typeof mod === 'object' || typeof mod === 'function') ? { ...mod } : {};
    ns.default = mod;
    return ns;
  }
  if (esmIsCjs(resolved)) {
    const mod = await globalThis.__nodineCjsRequire(resolved);
    const ns = mod && (typeof mod === 'object' || typeof mod === 'function') ? { ...mod } : {};
    ns.default = (mod && mod.default !== undefined && mod.__esModule) ? mod.default : mod;
    return ns;
  }
  return (await esmLoadModule(resolved)).ns;
}
// registry GET used by the bridge blobs (a function, so blobs can call it)
globalThis.__NODINE_CJS_REGISTRY_GET = (id) => globalThis.__NODINE_CJS_REGISTRY.get(id);
// __nodineCjsRequire: Node's REAL CJS loader on an arbitrary path —
// installed lazily (the loader must be booted first). Module._load through
// the internal loader keeps require() semantics for the dep graph.
{
  const getLoader = () => {
    const reqB = capturedLoaders.requireBuiltin;
    return reqB('internal/modules/cjs/loader');
  };
  // absolute-path execution (the mini-loader's CJS lane)
  Object.defineProperty(globalThis, '__nodineCjsRequire', {
    configurable: true,
    get() {
      return (p) => {
        const CJSLoader = getLoader();
        if (!CJSLoader.Module._load) throw new Error('CJS loader unavailable');
        report({ type: 'cjs-load-start', path: p });
        const watchdog = engineSetTimeout(() => report({ type: 'cjs-load-STUCK', path: p }), 8000);
        try {
          const r = CJSLoader.Module._load(p, null, false);
          platformClearTimeout(watchdog);
          report({ type: 'cjs-load-ok', path: p });
          return r;
        } catch (e) {
          platformClearTimeout(watchdog);
          report({ type: 'cjs-load-err', path: p, error: String(e && (e.stack || e)).slice(0, 200) });
          throw e;
        }
      };
    },
  });
  // specifier execution WITH a parent module context (resolution from the
  // importer's directory — the prologue's require() equivalent, callable
  // from the serialized chain).
  Object.defineProperty(globalThis, '__nodineCjsRequireFrom', {
    configurable: true,
    get() {
      return (spec, parentFile) => {
        const CJSLoader = getLoader();
        const Module = CJSLoader.Module;
        if (!Module || !Module._load) throw new Error('CJS loader unavailable');
        const parent = new Module(parentFile, null);
        parent.filename = parentFile;
        parent.paths = Module._nodeModulePaths(parentFile.slice(0, parentFile.lastIndexOf('/')));
        return Module._load(spec, parent, false);
      };
    },
  });
}
// The unified CJS dynamic-import entry: BOTH lanes under the serialization
// chain (the §11 sync mailbox is single-flight; npm's Display fires
// Promise.all([import('chalk'), import('supports-color')]) and the lanes
// must not interleave sync ops).
globalThis.__nodineDynamicImport = (spec, parentFile) => {
  dynImportInFlight++; // synchronous: the import expression is in flight NOW
  const run = dynImportChain.then(async () => {
    try {
    report({ type: 'dyn-import', spec, from: parentFile });
    let m;
    try {
      m = globalThis.__nodineCjsRequireFrom(spec, parentFile);
      report({ type: 'dyn-import-cjs-ok', spec });
    } catch (e) {
      report({ type: 'dyn-import-esm-lane', spec, why: String(e && e.message).slice(0, 120) });
      return await esmImportSpec(spec, parentFile); // await: the finally keeps the keepalive until settle
    }
    const ns = (m !== null && (typeof m === 'object' || typeof m === 'function')) ? { ...m } : {};
    ns.default = (m && m.default !== undefined && m.__esModule) ? m.default : m;
    return ns;
    } finally { dynImportInFlight--; }
  });
  dynImportChain = run.then(() => undefined, () => undefined);
  return run;
};
let dynImportChain = Promise.resolve();
let dynImportInFlight = 0;
// P2-006-008: in-flight http-bridge fetches. A pending fetch is an active
// handle for the Node event loop; the quiet gate must hold the process open
// while any bridge request is unsettled (otherwise processes exit before
// responses arrive — observed with bare make-fetch-happen programs).
let pendingHttpFetches = 0;
let lastHttpActivityAt = 0;
// P2-006-008-3: last HTTP activity timestamp — the keep-alive-socket stand-in
// (see waitForQuit). Real Node's loop stays alive through npm's whole install
// because the agent pool holds OPEN SOCKETS (active handles) between requests;
// our fetch bridge counts only IN-FLIGHT fetches, so the mirror-accelerated
// install (fetches resolving in ~1-10 ms) opened pure-microtask gaps between
// batches that exceeded the sustained-quiet window — the worker was declared
// dead MID-INSTALL (npm log ended at line 410, create-expo saw a fake exit 0
// and printed "Your project is ready!" with node_modules half-built).
function pendingHttpFetchCount() { return pendingHttpFetches; }
// P2-006-008 liveness trace: the quit decision killed npx mid-flow
// (observed: quit-quiet 815 ms after last visible activity, all counters
// zero, while npm was provably between fetch-1 and fetch-2). This ring
// records WHAT kept the loop alive and WHEN it stopped, so the next
// occurrence is diagnosable from the quit-quiet report alone.
const LIFE_RING_MAX = 240;
const lifeRing = [];
let lifeT0 = 0;
function traceLife(kind, detail) {
  if (!lifeT0) lifeT0 = Date.now();
  lifeRing.push(Date.now() - lifeT0 + 'ms ' + kind + (detail !== undefined ? ' ' + detail : ''));
  if (lifeRing.length > LIFE_RING_MAX) lifeRing.splice(0, lifeRing.length - LIFE_RING_MAX);
}
globalThis.__nodineEsmImport = (spec, parentFile) => {
  // The mini-loader (above): full node_modules/#imports resolution, CJS
  // bridging through the real worker CJS machinery, ESM deps as rewritten
  // blob modules. The cascaded loader needs the sync ModuleJob path this
  // engine cannot host (documented limitation).
  // SERIALIZED: the §11 sync mailbox is single-flight — concurrent dynamic
  // imports (npm's Display does Promise.all([import('chalk'),
  // import('supports-color')])) must not interleave sync ops (the collision
  // surfaces as spurious ENOENT/not-idle deep in resolution).
  const run = esmLoaderChain.then(() => esmImportSpec(spec, parentFile));
  esmLoaderChain = run.then(() => undefined, () => undefined);
  return run.then(undefined, (e) => {
    report({ type: 'esm-import-error', spec, parentFile, error: String(e && (e.stack || e)).slice(0, 500) });
    throw e;
  });
};
let esmLoaderChain = Promise.resolve();
defBinding('builtins', () => Object.freeze({
  builtinIds,
  config: JSON.stringify({ target_defaults: {}, variables: {} }),
  hasCachedBuiltins: () => false,
  getCacheUsage: () => ({}),
  builtinCategories: { prefix: {} },
  natives: {},
  compileFunction(id) {
    // kFunction wrapper, builtin_info.h:41-47. The web-platform substitute
    // for ScriptCompiler::CompileFunction is `new Function` (obligation 34).
    // P2-006-007: BRIDGE BUILTINS — child_process/http/https/zlib/crypto are
    // provided by the browser-native binding layer with Node's public API
    // (documented divergence: their lib/*.js equivalents need a process-level
    // libuv emulation that the v1.0.3 ABI does not expose; ADR-0004 sanctions
    // the fetch bridge for node:http clients, ADR-0006 the genuine-package
    // path). Every other builtin is the VERBATIM vendored source.
    const bridge = BRIDGE_BUILTINS.get(id);
    if (bridge !== undefined) {
      return function (exports, require, module, process, internalBinding, primordials) {
        bridge(exports, require, module, process, internalBinding);
      };
    }
    const fn = new Function(
      'exports', 'require', 'module', 'process', 'internalBinding', 'primordials',
      readSource(id));
    // B15: async_hooks.setPromiseHooks — vendored Node 26 sources don't
    // export it (promise hooks ride the trampoline here), but Metro's
    // bundled expo-server http.js calls it at module load. No-op graft:
    // promise-hook consumers get silent success (documented divergence).
    if (id === 'async_hooks') {
      return function (exports, require, module, process, internalBinding, primordials) {
        fn(exports, require, module, process, internalBinding, primordials);
        if (typeof exports.setPromiseHooks !== 'function') {
          exports.setPromiseHooks = () => {};
        }
      };
    }
    return fn;
  },
  setInternalLoaders(internalBindingFn, requireBuiltinFn) {
    capturedLoaders.internalBinding = internalBindingFn;
    capturedLoaders.requireBuiltin = requireBuiltinFn;
  },
  importBuiltinSourceTextModule() { throw new Error('not supported in PoC'); },
}));

// OBLIGATION 5/14: 'util' (node_util.cc:542-614; internal/util.js:62-70).
// P2-008: settlement tracker for getPromiseDetails — module scope (one per
// worker); WeakMap so settled promises without other refs get collected.
const utilPromiseDetails = new WeakMap();
defBinding('util', () => ({
  privateSymbols,
  defineLazyProperties(target, id, keys, enumerable = true) {
    for (const key of keys) {
      Object.defineProperty(target, key, {
        __proto__: null,
        get() {
          const mod = capturedLoaders.requireBuiltin(id);
          const value = mod[key];
          Object.defineProperty(target, key, { __proto__: null, value, enumerable, configurable: true, writable: true });
          return value;
        },
        configurable: true,
        enumerable,
      });
    }
  },
  constructSharedArrayBuffer(byteLength, maxByteLength, ctor) {
    return new SharedArrayBuffer(byteLength, { maxByteLength });
  },
  // node_util.cc GuessHandleType returns an INTEGER INDEX into internal/util.js's
  // handleTypes = ['TCP','TTY','UDP','FILE','PIPE','UNKNOWN'] (util.js:859-863).
  // FIX (P1-POC2): the predecessor's shim returned the STRING 'FILE' —
  // handleTypes['FILE'] === undefined, so is_main_thread.js's stdio switch fell
  // to the DEFAULT case: a black-hole Writable (is_main_thread.js:94-103) that
  // silently discarded every console.log. Return 3 (UV_FILE) for every fd —
  // all PoC stdio is the host VFS relay.
  guessHandleType: () => 3,
  sleep: () => { throw new Error('sleep: bridge must provide (Atomics.wait based)'); },
  getOwnNonIndexProperties(obj, filter) { return Object.getOwnPropertySymbols(obj); },
  // P2-006-008: util.inspect Proxy introspection (internal/util/inspect.js:146).
  // The browser engine does not expose Proxy targets/handlers; undefined makes
  // inspect fall back to normal object formatting (observed via npm's config
  // Proxy in the install error path).
  getProxyDetails() { return undefined; },
  // util.inspect (formatRaw:1388) special-cases Module namespace objects.
  isModuleNamespaceObject(v) {
    try { return v !== null && typeof v === 'object' && v[Symbol.toStringTag] === 'Module'; } catch { return false; }
  },
  previewEntries() { return undefined; },
  getExternalValue() { return undefined; },
  // P2-006-008: node_util.cc GetPromiseDetails — internal/util/inspect.js
  // (Promise formatting) and esm/module_job.js (isPromisePending on the
  // linked promise) require [state, value]; the browser engine cannot
  // introspect synchronously, so a captured FLAG drives it: module_job's
  // isPromisePending consults state only — report kFulfilled for settled
  // unknowns (the linked-promise path treats it as "not pending", the
  // inspect path prints the settled shape). create-expo's prompts hit
  // this through util.inspect of a Promise (FATAL after the isTTY fix
  // unlocked the interactive render path).
  getPromiseDetails(v) {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return undefined;
    if (typeof v.then !== 'function') return undefined;
    return [0, undefined]; // kPending — safest honest default
  },
  getConstructorName(v) { return (v !== null && typeof v === 'object' && v.constructor && v.constructor.name) || undefined; },
  isInsideNodeModules: () => false,
  getCallSites: () => [],
  // P2-008 FIX (the create-expo template step): getPromiseDetails
  // (node_util.cc) — required by internal/webstreams/util.js isPromisePending
  // (fatal live: 'TypeError: getPromiseDetails is not a function' at
  // writableStreamDefaultWriterEnsureReadyPromiseRejected killed
  // create-expo-app's extraction), util.inspect's Promise formatting, and
  // module_job's linkedPromise probe. Pure JS cannot read a promise's state
  // synchronously: track settlement with probes attached at first query (the
  // promise IS pending at that moment — the probe was just attached). Every
  // consumer tolerates the approximation: 'pending' on a settled promise only
  // makes the caller's reject a no-op; inspect shows stale-but-plausible
  // text. Non-promises → undefined (the native contract).
  getPromiseDetails(p) {
    try {
      if (!(p instanceof Promise)) return undefined;
      let d = utilPromiseDetails.get(p);
      if (d === undefined) {
        d = { state: 0, value: undefined };
        utilPromiseDetails.set(p, d);
        p.then(
          (v) => { d.state = 1; d.value = v; },
          (v) => { d.state = 2; d.value = v; },
        );
        return [0, undefined];
      }
      return d.state === 0 ? [0, undefined] : [d.state, d.value];
    } catch { return undefined; }
  },
  promiseHooks: { onInit() {}, onBefore() {}, onAfter() {}, onSettled() {}, hasHooks: false },
  constants: Object.freeze({
    kPending: 0, kFulfilled: 1, kRejected: 2,
    kExiting: 0, kExitCode: 1, kHasExitCode: 2, // env.h:1214-1219
    ALL_PROPERTIES: 0, ONLY_WRITABLE: 2, ONLY_ENUMERABLE: 4, ONLY_CONFIGURABLE: 8,
    SKIP_STRINGS: 16, SKIP_SYMBOLS: 32,
    kDisallowCloneAndTransfer: 0, kTransferable: 1, kCloneable: 2,
  }),
  // shouldAbortOnUncaughtToggle (internal/process/execution.js:53)
  shouldAbortOnUncaughtToggle: new Uint32Array(1),
}));

// OBLIGATION 6: 'errors' (node_errors.cc).
const hostUncaughtState = { handler: undefined };
defBinding('errors', () => {
  const state = {};
  return Object.freeze({
    setPrepareStackTraceCallback(fn) { state.prepareStackTrace = fn; },
    setEnhanceStackForFatalException(a, b) { state.enhance = [a, b]; },
    setMaybeCacheGeneratedSourceMap() {},
    setSourceMapsEnabled() {}, setSourceMapsNative() {}, // documented divergence (P1-A2 §5)
    triggerUncaughtException(err, fromPromise) {
      esmEntryTerminal = true;
      platformMessagePost({ type: 'uncaught', message: String(err?.stack || err), fromPromise: !!fromPromise });
      platformConsoleError('[uncaught via Node errors binding]', err?.stack || err);
    },
    exitCodes: Object.freeze({
      kNoFailure: 0, kGenericUserError: 1, kInternalJSParseError: 3,
      kInternalJSEvaluationFailure: 4, kV8FatalError: 5,
      kInvalidFatalExceptionMonkeyPatching: 6, kExceptionInFatalExceptionHandler: 7,
      kInvalidCommandLineArgument: 9, kInvalidCommandLineArgument2: 12,
      kUnsettledTopLevelAwait: 13, kStartupSnapshotFailure: 14,
      kProcessTimeout: 124, kAbort: 134,
    }),
  });
});

// OBLIGATION 7: 'module_wrap' — ESM seam. For T1–T5 a constructor-shaped stub
// suffices (proven by P1-A2). For the T6 SPIKE the registry below backs
// ModuleWrap with blob: URLs + the engine's dynamic import() — see §T6 notes
// and the report for what actually happens.
// P2-006-008: SYNCHRONOUS ModuleWrap — custom binding implementation of
// src/module_wrap.cc's JS-facing contract (source: poc/p2-008/sync-module-wrap.mjs,
// vendored parser: acorn 8.15.0, ADR-0013). The upstream loader JS drives this
// class untouched: Module._compile → loadESMFromCJS → importSyncForRequire →
// ModuleJobSync → instantiate() + evaluateSync() → synchronous namespace
// (live bindings via namespace getters + a with-scope proxy over the
// dependency namespaces; TLA graphs rejected with ERR_REQUIRE_ASYNC_MODULE
// by upstream throwIfAsyncGraph before evaluateSync runs).
const esmRegistry = {
  urlToWrap: new Map(),      // Node module URL -> ModuleWrap instance (debug)
  callbacks: {},             // registered by the upstream bootstrap (utils.js)
};
// In-flight ESM evaluations (async entries / TLA factories). The real Node
// event loop holds the process alive for pending ESM jobs; our loop driver's
// quiet check must do the same (T6 fix lineage, preserved).
let pendingEsmOps = 0;
function pendingEsmOpsCount() { return pendingEsmOps; }
// ESM-entry latch: for eval-module entries the loader chain has async gaps
// BEFORE the first evaluate() starts. The quiet gate must hold the entry open
// until the first evaluate() completes, an uncaught error terminates it, or
// the timeout hits.
let esmEntryInFlight = false;   // set for eval_module entries
let esmEvalStarted = false;     // first ModuleWrap.evaluate() entered
let esmEntryTerminal = false;   // uncaught exception terminated the entry

const esmHost = {
  dynamicImport(spec, modulePath) {
    return globalThis.__nodineDynamicImport(spec, modulePath);
  },
  importMetaResolveInit(url) {
    const f = esmRegistry.callbacks.importMetaResolve;
    try { return f ? f(url) : null; } catch { return null; }
  },
  importMetaCallback(hdo, meta, wrap) {
    const f = esmRegistry.callbacks.importMeta;
    if (typeof f === 'function') { try { f(hdo, meta, wrap); } catch {} }
  },
  isDefaultHdo(sym) {
    if (esmHost.__defaultHdo === undefined) {
      try {
        esmHost.__defaultHdo = capturedLoaders.internalBinding('symbols').source_text_module_default_hdo || null;
      } catch { esmHost.__defaultHdo = null; }
    }
    return sym === esmHost.__defaultHdo;
  },
  report(evt) { try { report(evt); } catch {} },
  trace(msg) { if (globalThis.__P2007_ESM_TRACE) globalThis.__P2007_ESM_TRACE.push(msg); },
  onEvalStart() { pendingEsmOps++; esmEvalStarted = true; },
  onEvalEnd() { pendingEsmOps--; },
};
const nodineModuleWrap = createModuleWrapBinding(acorn, esmHost);
defBinding('module_wrap', () => Object.freeze({
  ModuleWrap: nodineModuleWrap.ModuleWrap,
  setImportModuleDynamicallyCallback(fn) { esmRegistry.callbacks.importDynamic = fn; },
  setInitializeImportMetaObjectCallback(fn) { esmRegistry.callbacks.importMeta = fn; },
  setImportMetaResolveInitializer(fn) { esmRegistry.callbacks.importMetaResolve = fn; },
  createRequiredModuleFacade: nodineModuleWrap.createRequiredModuleFacade,
  throwIfPromiseRejected: nodineModuleWrap.throwIfPromiseRejected,
  kUninstantiated: 0, kInstantiating: 1, kInstantiated: 2,
  kEvaluating: 3, kEvaluated: 4, kErrored: 5,
  kSourcePhase: 1, kDeferPhase: 2, kEvaluationPhase: 3, // module_wrap.h:37-39
}));


// P2-006-008 OBLIGATION: 'block_list' (src/node_block_list.cc +
// src/node_sockaddr.cc). Pulled in when node:net's ESM facade enumerates its
// exports (the lazy BlockList/SocketAddress getters force internal/blocklist.js
// + internal/socketaddress.js to load). Pure-logic JS implementation of the
// native handle classes: inet_pton/inet_ntop equivalent parse/format +
// address/range/subnet membership algebra. No sockets are created.
defBinding('block_list', () => {
  const AF_INET = 2;
  const AF_INET6 = 10;

  function parseIPv4(str) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(str));
    if (!m) return null;
    const b = [];
    for (let i = 1; i <= 4; i++) {
      const n = +m[i];
      if (n > 255) return null;
      b.push(n);
    }
    return { af: AF_INET, bytes: b };
  }

  function formatIPv4(a) { return a.bytes.join('.'); }

  function parseIPv6(str) {
    let s = String(str);
    const pct = s.indexOf('%');
    if (pct !== -1) s = s.slice(0, pct);
    const lastColon = s.lastIndexOf(':');
    if (lastColon !== -1 && s.indexOf('.', lastColon) !== -1) {
      const v4 = parseIPv4(s.slice(lastColon + 1));
      if (!v4) return null;
      s = s.slice(0, lastColon + 1) +
        ((v4.bytes[0] << 8) | v4.bytes[1]).toString(16) + ':' +
        ((v4.bytes[2] << 8) | v4.bytes[3]).toString(16);
    }
    if (s === '::') return { af: AF_INET6, groups: new Array(8).fill(0) };
    const head = s.startsWith('::') ? [] : s.split('::')[0].split(':').filter((x) => x !== '');
    let tail = [];
    let hasFill = s.includes('::');
    if (hasFill) {
      const idx = s.indexOf('::');
      const after = s.slice(idx + 2);
      tail = after === '' ? [] : after.split(':').filter((x) => x !== '');
    } else {
      head.push(...s.split(':'));
      if (head.length !== 8) return null;
    }
    const g = new Array(8).fill(0);
    if (head.length + tail.length > 8) return null;
    for (let i = 0; i < head.length; i++) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(head[i])) return null;
      g[i] = parseInt(head[i], 16);
    }
    for (let i = 0; i < tail.length; i++) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(tail[i])) return null;
      g[8 - tail.length + i] = parseInt(tail[i], 16);
    }
    return { af: AF_INET6, groups: g };
  }

  function formatIPv6(a) {
    const g = a.groups;
    // best zero-run compression (>= 2 groups), like inet_ntop
    let bestStart = -1, bestLen = 0, i = 0;
    while (i < 8) {
      if (g[i] === 0) {
        let j = i;
        while (j < 8 && g[j] === 0) j++;
        if (j - i > bestLen) { bestLen = j - i; bestStart = i; }
        i = j;
      } else i++;
    }
    if (bestLen < 2) return g.map((x) => x.toString(16)).join(':');
    const left = g.slice(0, bestStart).map((x) => x.toString(16)).join(':');
    const right = g.slice(bestStart + bestLen).map((x) => x.toString(16)).join(':');
    return left + '::' + right;
  }

  function parseAny(str, af) {
    const v6 = parseIPv6(str);
    if (v6) return v6;
    const v4 = parseIPv4(str);
    if (v4) return v4;
    return null;
  }

  function addrToBits(a) {
    // big-endian bit string for range/subnet comparisons
    if (a.af === AF_INET) return a.bytes.map((b) => b.toString(2).padStart(8, '0')).join('');
    return a.groups.map((g) => g.toString(2).padStart(16, '0')).join('');
  }

  class SocketAddressHandle {
    constructor(address, port, type, flowlabel) {
      const parsed = type === AF_INET6 ? parseIPv6(address) : parseIPv4(address);
      if (!parsed) {
        throw new Error(`Invalid address: ${address}`);
      }
      this._addr = parsed;
      this._port = port;
      this._flowlabel = flowlabel;
    }
    detail() {
      return {
        address: this._addr.af === AF_INET ? formatIPv4(this._addr) : formatIPv6(this._addr),
        port: this._port,
        family: this._addr.af,
        flowlabel: this._flowlabel,
      };
    }
    flowlabel() { return this._flowlabel; }
    _compare(other) {
      const A = addrToBits(this._addr);
      const B = addrToBits(other._addr);
      return A < B ? -1 : A > B ? 1 : 0;
    }
  }

  class BlockListHandle {
    constructor() {
      this._addresses = [];   // { bits }
      this._ranges = [];      // { start, end, af }
      this._subnets = [];     // { bits, prefix, af }
    }
    addAddress(sa) { this._addresses.push(addrToBits(sa._addr)); }
    addAddresses(list) { for (const sa of list) this.addAddress(sa); }
    addRange(start, end) {
      this._ranges.push({ start: addrToBits(start._addr), end: addrToBits(end._addr), af: start._addr.af });
    }
    addSubnet(network, prefix) {
      this._subnets.push({ bits: addrToBits(network._addr), prefix: prefix | 0, af: network._addr.af });
    }
    removeAddress(sa) {
      const b = addrToBits(sa._addr);
      const i = this._addresses.indexOf(b);
      if (i !== -1) this._addresses.splice(i, 1);
    }
    removeRange(start, end) {
      const s = addrToBits(start._addr); const e = addrToBits(end._addr);
      this._ranges = this._ranges.filter((r) => r.start !== s || r.end !== e);
    }
    removeSubnet(network, prefix) {
      const b = addrToBits(network._addr);
      this._subnets = this._subnets.filter((s) => s.bits !== b || s.prefix !== (prefix | 0));
    }
    _checkBits(bits) {
      for (const a of this._addresses) if (a === bits) return true;
      for (const r of this._ranges) if (bits >= r.start && bits <= r.end) return true;
      for (const s of this._subnets) {
        if (bits.length !== s.bits.length) continue;
        if (bits.slice(0, s.prefix) === s.bits.slice(0, s.prefix)) return true;
      }
      return false;
    }
    checkString(address, af) {
      const parsed = af === AF_INET6 ? parseIPv6(address) : parseIPv4(address);
      if (!parsed) return false;
      return this._checkBits(addrToBits(parsed));
    }
    check(sa) { return this._checkBits(addrToBits(sa._addr)); }
    getRules() {
      const out = [];
      for (const r of this._subnets) {
        const af = r.bits.length === 32 ? AF_INET : AF_INET6;
        const parsed = af === AF_INET
          ? { af, bytes: r.bits.match(/(.{8})/g).map((x) => parseInt(x, 2)) }
          : { af, groups: r.bits.match(/(.{16})/g).map((x) => parseInt(x, 2)) };
        const fmt = af === AF_INET ? formatIPv4(parsed) : formatIPv6(parsed);
        out.push(`${fmt}/${r.prefix}`);
      }
      return out;
    }
    getSize() {
      return this._addresses.length + this._ranges.length + this._subnets.length;
    }
    clear() {
      this._addresses = []; this._ranges = []; this._subnets = [];
    }
  }

  return Object.freeze({
    BlockList: BlockListHandle,
    SocketAddress: SocketAddressHandle,
    AF_INET,
    AF_INET6,
  });
});


// P2-006-008 OBLIGATION: 'v8' (src/node_v8.cc). Required when userland/npm
// requires the public 'v8' module (lib/v8.js) — e.g. npm's fetch-error
// reporting path. The host engine is V8 (Chromium) but exposes none of the
// heap-statistics natives to JS; the honest implementation returns
// correctly-shaped zeroed statistics (documented divergence: no heap-snapshot
// or CPU-profile captures in the browser host).
defBinding('v8', () => {
  const heapStatisticsBuffer = new Float64Array(16);
  const heapSpaceStatisticsBuffer = new Float64Array(4);
  const heapCodeStatisticsBuffer = new Float64Array(4);
  // The browser host does not expose V8 heap limits to JS; report the
  // conservative default-heap shape (2 GiB limit) so consumers that size
  // caches off getHeapStatistics() (npm arborist PackumentCache) get sane
  // values instead of 0 (which lru-cache treats as "unset" and rejects).
  heapStatisticsBuffer[0] = 536870912;   // total_heap_size
  heapStatisticsBuffer[1] = 33554432;    // total_heap_size_executable
  heapStatisticsBuffer[2] = 536870912;   // total_physical_size
  heapStatisticsBuffer[3] = 1610612736;  // total_available_size
  heapStatisticsBuffer[4] = 134217728;   // used_heap_size
  heapStatisticsBuffer[5] = 2147483648;  // heap_size_limit
  heapStatisticsBuffer[6] = 0;           // does_zap_garbage
  heapStatisticsBuffer[7] = 100663296;   // malloced_memory
  heapStatisticsBuffer[8] = 134217728;   // peak_malloced_memory
  heapStatisticsBuffer[9] = 1;           // number_of_native_contexts
  heapStatisticsBuffer[10] = 0;          // number_of_detached_contexts
  heapStatisticsBuffer[11] = 1048576;    // total_global_handles_size
  heapStatisticsBuffer[12] = 524288;     // used_global_handles_size
  heapStatisticsBuffer[13] = 67108864;   // external_memory
  heapStatisticsBuffer[14] = 1073741824; // total_allocated_bytes
  const kHeapSpaces = Object.freeze([
    'read_only_space', 'new_space', 'old_space', 'code_space',
    'shared_space', 'trusted_space', 'new_large_object_space',
    'large_object_space', 'code_large_object_space', 'shared_large_object_space',
    'trusted_large_object_space',
  ]);
  return Object.freeze({
    cachedDataVersionTag() { return 0; },
    setFlagsFromString() {},
    startCpuProfile() { return false; },
    stopCpuProfile() { return null; },
    startHeapProfile() { return false; },
    stopHeapProfile() { return null; },
    isStringOneByteRepresentation(v) { return String(v).length === new TextEncoder().encode(String(v)).length ? true : true; },
    updateHeapStatisticsBuffer() {},
    updateHeapSpaceStatisticsBuffer() {},
    updateHeapCodeStatisticsBuffer() {},
    setHeapSnapshotNearHeapLimit() {},
    setHeapProfileNearHeapLimit() {},
    getCppHeapStatistics() { return undefined; },
    detailLevel: 0,
    heapStatisticsBuffer, heapCodeStatisticsBuffer, heapSpaceStatisticsBuffer,
    kTotalHeapSizeIndex: 0, kTotalHeapSizeExecutableIndex: 1, kTotalPhysicalSizeIndex: 2,
    kTotalAvailableSize: 3, kUsedHeapSizeIndex: 4, kHeapSizeLimitIndex: 5,
    kDoesZapGarbageIndex: 6, kMallocedMemoryIndex: 7, kPeakMallocedMemoryIndex: 8,
    kNumberOfNativeContextsIndex: 9, kNumberOfDetachedContextsIndex: 10,
    kTotalGlobalHandlesSizeIndex: 11, kUsedGlobalHandlesSizeIndex: 12,
    kExternalMemoryIndex: 13, kTotalAllocatedBytes: 14,
    kHeapSpaces, kSpaceSizeIndex: 0, kSpaceUsedSizeIndex: 1,
    kSpaceAvailableSizeIndex: 2, kPhysicalSpaceSizeIndex: 3,
    kCodeAndMetadataSizeIndex: 0, kBytecodeAndMetadataSizeIndex: 1,
    kExternalScriptSourceSizeIndex: 2, kCPUProfilerMetaDataSizeIndex: 3,
  });
});


// P2-006-008 OBLIGATION: 'internal_only_v8' (src/node_v8.cc internal-only
// surface) — required by internal/heap_utils.js (pulled via the public v8
// module's error-reporting path). queryObjects is a debug-console-only
// native in Node; honest ENOTSUP-style behavior for the browser host.
defBinding('internal_only_v8', () => Object.freeze({
  queryObjects() { throw new Error('queryObjects is not supported in the browser host'); },
}));

// OBLIGATION 8: 'config' (node_config.cc:40-100).
defBinding('config', () => Object.freeze({
  hasOpenSSL: true,         // P2-006-007: the crypto bridge (@noble/hashes + js-md5 + browser WebCrypto) provides the surface; the webcrypto lazy loader needs this true
  hasIntl: true,
  hasSmallICU: true,
  hasTracing: true,
  hasNodeOptions: true,
  hasInspector: false,      // no C++ inspector agent in the browser host
  hasWasmWebAPI: true,
  isDebugBuild: false,
  openSSLIsBoringSSL: false,
  noBrowserGlobals: false,
  bits: 64,
}));

// OBLIGATION 9: 'timers' — THE event-loop seam (src/timers.cc + env.cc:1733-1812).
// The host implements the libuv timer/check/idle handle behavior over the
// Worker's platform timer queue; Node's own lib/internal/timers.js runs
// unmodified on top (getTimerCallbacks/processTimers/processImmediate).
const timersState = {
  processImmediate: undefined, // JS callback, installed by bootstrap/node.js:371-380
  processTimers: undefined,
  platformTimerId: null,
  timerBase: 0,               // env->timer_base(): when the current platform timer was armed
  timerRef: false,
  immediateCheckScheduled: false,
  immediateRef: false,
  timerFireCount: 0,
  immediateRunCount: 0,
};
const armLog = [];
function armPlatformTimer(durationMs) {
  if (durationMs > 1000) armLog.push({ ms: durationMs, at: Math.round(nowMs()), stack: String(new Error().stack).split('\n').slice(1, 4).join(' | ').slice(0, 300) });
  if (armLog.length > 20) armLog.shift();
  globalThis.__P2006_TIMER_LOG = armLog;
  if (timersState.platformTimerId !== null) platformClearTimeout(timersState.platformTimerId);
  timersState.timerBase = nowMs();
  // uv timers < 1ms round to 1ms (libuv behavior, env.cc:1797 clamp)
  timersState.platformTimerId = platformSetTimeout(onPlatformTimerFire, Math.max(1, durationMs));
}
// env.cc:1748-1806 RunTimers
function onPlatformTimerFire() {
  timersState.platformTimerId = null;
  timersState.timerFireCount++;
  const now = nowMs();
  let expiry;
  try {
    expiry = timersState.processTimers(now);
  } catch (err) {
    report({ type: 'error', where: 'processTimers', message: String(err?.stack || err) });
    throw err;
  }
  // Phase-boundary tick drain (env.cc loop interrupt / timers.js:541,615,644
  // call runNextTicks around timer callbacks). Without this, the platform's
  // automatic microtask checkpoint after this macrotask would drain promise
  // jobs BEFORE nextTicks queued by the timer callback — inverting Node's
  // nextTick-before-microtasks order (observed as E/F flip in T4).
  if (typeof realmProcess._tickCallback === 'function') {
    try {
      realmProcess._tickCallback();
    } catch (err) {
      report({ type: 'error', where: 'tickCallback(timer-phase)', message: String(err?.stack || err) });
      throw err;
    }
  }
  if (expiry !== 0) {
    const duration = Math.abs(expiry) - (nowMs() - timersState.timerBase);
    armPlatformTimer(duration > 0 ? duration : 1);
  }
}
// env.cc:1809-1835 CheckImmediate: the uv_check handle callback. We run the
// check phase as a platform macrotask armed when an immediate is queued
// (toggleImmediateRef(true) in C++ starts an idle handle to keep the loop
// alive; the check handle itself runs every loop iteration).
function scheduleImmediateCheck() {
  if (timersState.immediateCheckScheduled) return;
  timersState.immediateCheckScheduled = true;
  platformSetTimeout(() => {
    timersState.immediateCheckScheduled = false;
    if (!timersState.processImmediate) return;
    if (timersState.immediateInfo[0] === 0) return; // immediateInfo[kCount]
    timersState.immediateRunCount++;
    try {
      // CheckImmediate loops while has_outstanding (env.cc:1825-1832)
      do {
        timersState.processImmediate();
      } while (timersState.immediateInfo[2] === 1); // kHasOutstanding
    } catch (err) {
      report({ type: 'error', where: 'processImmediate', message: String(err?.stack || err) });
      throw err;
    }
    settleLoop(); // ticks/microtasks queued by immediates
  }, 0);
}
defBinding('timers', () => Object.freeze({
  immediateInfo: timersState.immediateInfo ?? (timersState.immediateInfo = new Float64Array(3)),
  // P2-006-008: timeoutInfo is SHARED with timers.js — its [0] is the ref'd
  // timer count (incRefCount/decRefCount write this exact array). waitForQuit
  // reads it for liveness: unref'd timers still FIRE (armed via scheduleTimer)
  // but no longer keep the process alive — real Node semantics. This is what
  // lets npm's libnpmexec with-lock touch timer (unref'd) coexist with clean
  // process exit, and keeps ref'd timers (setInterval, dev servers) alive
  // indefinitely.
  timeoutInfo: timersState.timeoutInfo ?? (timersState.timeoutInfo = new Float64Array(2)),
  getLibuvNow: () => nowMs(),
  scheduleTimer(duration) { armPlatformTimer(duration); },
  toggleTimerRef(ref) { timersState.timerRef = !!ref; /* liveness via timeoutInfo[0] */ },
  toggleImmediateRef(ref) {
    timersState.immediateRef = !!ref;
    if (ref) scheduleImmediateCheck(); // idle handle keep-alive -> schedule a check phase
  },
  setupTimers(processImmediate, processTimers) {
    timersState.processImmediate = processImmediate;
    timersState.processTimers = processTimers;
  },
}));

// OBLIGATION 10: 'task_queue' (node_task_queue.cc). In the WORKER host,
// enqueueMicrotask now queues on the SAME realm's microtask queue (fixes the
// P1-A2 vm cross-realm flaw). runMicrotasks() cannot synchronously drain on
// the web — documented divergence; the loop driver (settleLoop) drains via
// `await` checkpoints at every phase boundary.
const taskQueueState = { rejectCb: undefined, tickCb: undefined };
defBinding('task_queue', () => Object.freeze({
  enqueueMicrotask(fn) { platformQueueMicrotask(fn); },
  runMicrotasks() { /* DIVERGENCE: no sync drain on the web; settleLoop compensates */ },
  setTickCallback(fn) { taskQueueState.tickCb = fn; },
  tickInfo: new Uint32Array(4),
  promiseRejectEvents: Object.freeze({
    kPromiseRejectWithNoHandler: 0,
    kPromiseHandlerAddedAfterReject: 1,
    kPromiseResolveAfterResolved: 2,
    kPromiseRejectAfterResolved: 3,
  }),
  setPromiseRejectCallback(fn) { taskQueueState.rejectCb = fn; },
}));
// Bridge the engine's unhandled rejections to Node's promise-reject callback
// (the web substitute for V8 SetPromiseRejectCallback).
self.addEventListener('unhandledrejection', (ev) => {
  report({ type: 'unhandledrejection', reason: String(ev.reason?.stack || ev.reason).slice(0, 2000) });
  const cb = taskQueueState.rejectCb;
  if (cb) {
    try {
      cb(0 /* kPromiseRejectWithNoHandler */, ev.promise, ev.reason);
      ev.preventDefault?.();
    } catch { /* let the platform report it */ }
  }
});

// OBLIGATION 11: 'async_wrap' (async_wrap.cc).
defBinding('async_wrap', () => {
  const s = {};
  // async-wrap.cc: the async-id stack is a Float64Array of (id, triggerId)
  // pairs. Native starts at 32 entries and grows on overflow via the native
  // pushAsyncContext fallback (async_hooks.js:38-39, 549-559); the PoC
  // pre-sizes deeper — growth-on-overflow is native-only. DISCOVERED by this
  // PoC's entry run: pushAsyncContext (async_hooks.js:552) reads
  // async_wrap.async_ids_stack.length UNCONDITIONALLY (promise hooks call it
  // for every promise callback) — the binding must export the array.
  const asyncIdsStack = new Float64Array(1024 * 2);
  const execRes = [];
  const asyncHookFields = new Uint32Array(9);
  const asyncIdFields = new Float64Array(4);
  return Object.freeze({
    setupHooks(init, before, after, destroy, promiseResolve) {
      s.hooks = { init, before, after, destroy, promiseResolve };
    },
    setCallbackTrampoline(fn) { s.trampoline = fn; },
    async_hook_fields: asyncHookFields,
    async_id_fields: asyncIdFields,
    execution_async_resources: execRes,
    async_ids_stack: asyncIdsStack,
    pushAsyncContext(asyncId, triggerAsyncId) {
      // native overflow fallback (AsyncHooks::push_async_context)
      asyncIdFields[0] = asyncId;   // kExecutionAsyncId
      asyncIdFields[1] = triggerAsyncId; // kTriggerAsyncId
    },
    popAsyncContext() {
      asyncIdFields[0] = 0; asyncIdFields[1] = 0;
      return false;
    },
    executionAsyncResource() { return execRes[0]; },
    clearAsyncIdStack() {},
    async_hook_flags: new Uint32Array(1),
    registerDestroyHook() {},
    // B15: internal/promise_hooks destructures setPromiseHooks from THIS
    // binding at module load (Metro's expo-server chain loads it). The
    // trampoline owns promise-hook dispatch here, so the native setter is
    // a no-op — but it must EXIST or the destructure throws TypeError
    // ("setPromiseHooks is not a function"), killing `npm start`.
    setPromiseHooks() {},
    constants: Object.freeze({
      kInit: 0, kBefore: 1, kAfter: 2, kDestroy: 3, kTotals: 4, kPromiseResolve: 5,
      kCheck: 6, kStackLength: 7, kUsesExecutionAsyncResource: 8,
      kExecutionAsyncId: 0, kTriggerAsyncId: 1, kAsyncIdCounter: 2,
      kDefaultTriggerAsyncId: 3,
      kAsyncIdStackOverflowWarningShown: 1 << 0,
    }),
  });
});

// OBLIGATION 12: 'symbols' (node_symbols.cc).
defBinding('symbols', () => perIsolateSymbols);

// OBLIGATION 13: 'constants' (node_constants.cc) — Linux tables.
defBinding('constants', () => {
  const signals = {};
  let n = 1;
  for (const name of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
    'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE',
    'SIGALRM', 'SIGTERM', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN',
    'SIGTTOU', 'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH',
    'SIGIO', 'SIGPOLL', 'SIGPWR', 'SIGSYS']) {
    signals[name] = { signal: n++ };
  }
  const errno = {};
  let e = 1;
  for (const name of ['EPERM', 'ENOENT', 'ESRCH', 'EINTR', 'EIO', 'ENXIO', 'E2BIG',
    'ENOEXEC', 'EBADF', 'ECHILD', 'EAGAIN', 'ENOMEM', 'EACCES', 'EFAULT', 'ENOTBLK',
    'EBUSY', 'EEXIST', 'EXDEV', 'ENODEV', 'ENOTDIR', 'EISDIR', 'EINVAL', 'ENFILE',
    'EMFILE', 'ENOTTY', 'ETXTBSY', 'EFBIG', 'ENOSPC', 'ESPIPE', 'EROFS', 'EMLINK',
    'EPIPE', 'EDOM', 'ERANGE']) {
    errno[name] = e++;
  }
  errno.EISDIR = 21; errno.EADDRINUSE = 98; errno.ECONNREFUSED = 111; errno.ECONNRESET = 104;
  errno.EINPROGRESS = 115; errno.EWOULDBLOCK = 11; errno.ENOTEMPTY = 39;
  const fsConsts = {
    O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512,
    O_APPEND: 1024, O_SYMLINK: 32768, O_DIRECT: 65536, O_NONBLOCK: 2048, O_SYNC: 1052672,
    S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192, S_IFBLK: 24576,
    S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152,
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
    UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2,
    UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3,
    UV_DIRENT_FIFO: 4, UV_DIRENT_SOCKET: 5, UV_DIRENT_CHAR: 6, UV_DIRENT_BLOCK: 7,
  };
  return Object.freeze({
    os: Object.freeze({
      signals: Object.freeze(signals), errno: Object.freeze(errno),
      priority: Object.freeze({ PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 }),
      dlopen: Object.freeze({}),
    }),
    errno: Object.freeze(errno),
    fs: Object.freeze(fsConsts),
    crypto: Object.freeze({}),
    zlib: Object.freeze({}),
  });
});

// OBLIGATION 15: 'types' (node_types.cc) over the JS type system.
defBinding('types', () => Object.freeze({
  isNativeError: (v) => v instanceof Error,
  isPromise: (v) => v instanceof Promise,
  isExternal: () => false,
  isDate: (v) => v instanceof Date,
  isTypedArray: (v) => ArrayBuffer.isView(v),
  isUint8Array: (v) => v instanceof Uint8Array,
  isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || v instanceof SharedArrayBuffer,
  isArgumentsObject: () => false,
  isBigIntObject: () => false,
  isBooleanObject: (v) => v instanceof Boolean,
  isNumberObject: (v) => v instanceof Number,
  isStringObject: (v) => v instanceof String,
  isSymbolObject: () => false,
  isBoxedPrimitive: (v) => v instanceof Boolean || v instanceof Number || v instanceof String || v instanceof Symbol,
  isKeyObject: () => false,
  isCryptoKey: () => false,
  isMapIterator: () => false,
  isSetIterator: () => false,
  isWeakMap: (v) => v instanceof WeakMap,
  isWeakSet: (v) => v instanceof WeakSet,
  isRegExp: (v) => v instanceof RegExp,
  isAsyncFunction: (v) => Object.prototype.toString.call(v) === '[object AsyncFunction]',
  isGeneratorFunction: (v) => Object.prototype.toString.call(v) === '[object GeneratorFunction]',
  isGeneratorObject: (v) => Object.prototype.toString.call(v) === '[object Generator]',
  isMap: (v) => v instanceof Map,
  isSet: (v) => v instanceof Set,
  isArrayBuffer: (v) => v instanceof ArrayBuffer,
  isDataView: (v) => v instanceof DataView,
  isSharedArrayBuffer: (v) => v instanceof SharedArrayBuffer,
  isProxy: () => false,
  // P2-006-008: internal/util/types.js spreads this binding; util.inspect's
  // namespace formatting (formatRaw:1386) needs the Module-namespace predicate.
  isModuleNamespaceObject(v) {
    try { return v !== null && typeof v === 'object' && v[Symbol.toStringTag] === 'Module'; } catch { return false; }
  },
  isArrayBufferDetached: () => false,
  isBigInt64Array: (v) => v instanceof BigInt64Array,
  isBigUint64Array: (v) => v instanceof BigUint64Array,
  isFloat16Array: () => false,
  isFloat32Array: (v) => v instanceof Float32Array,
  isFloat64Array: (v) => v instanceof Float64Array,
  isUint8ClampedArray: (v) => v instanceof Uint8ClampedArray,
  isUint16Array: (v) => v instanceof Uint16Array,
  isUint32Array: (v) => v instanceof Uint32Array,
  isInt8Array: (v) => v instanceof Int8Array,
  isInt16Array: (v) => v instanceof Int16Array,
  isInt32Array: (v) => v instanceof Int32Array,
}));

// OBLIGATION 17: 'options' (node_options.cc). Defaults matching `node -e ''`
// with no flags + the PoC's pinned divergences. '--eval' carries the test
// program; '--vfs-load' MUST be '' (finishVfsMounts treats undefined as set).
const CLI_OPTIONS = {
  '--eval': '',
  '--print': false,
  '--input-type': '',
  '--import': [],
  '--experimental-loader': [],
  '--require': [],
  '--require-module': [],
  '--inspect-brk': false,
  '--no-node-snapshot': true,
  '--stack-size': 984,
  '--dns-result-order': undefined,
  'preserve-symlinks': false,
  'preserve-symlinks-main': false,
  '--expose-internals': false,
  'experimental-modules': true,
  '--async-context-frame': false, // pinned: ALS rides async_hooks (P1-A2 §5 row 2)
  '--enable-source-maps': false,
  '--experimental-network-inspection': false,
  '--experimental-permission': false,
  '--permission': false,
  '--permission-audit': false,
  '--experimental-sqlite': false,
  '--experimental-webstorage': false,
  '--localstorage-file': '',
  '--no-experimental-global-navigator': false,
  '--no-experimental-global-webcrypto': false,
  '--no-experimental-global-customevent': false,
  '--no-experimental-fetch': false,
  '--no-experimental-websocket': false,
  '--experimental-web-worker': false,
  '--experimental-eventsource': false,
  '--experimental-detect-module': false,
  '--experimental-vm-modules': false,
  '--frozen-intrinsics': false,
  '--stack-trace-limit': 10,
  '--no-warnings': false,
  '--warnings': true,
  '--pending-deprecation': false,
  '--trace-deprecation': false,
  '--trace-warnings': false,
  '--trace-exit': false,
  '--trace-uncaught': false,
  '--trace-sigint': false,
  '--trace-promises': undefined,
  '--test-udp-no-try-send': false,
  '--experimental-strip-types': false,
  '--strip-types': false,
  '--watch': false,
  '--watch-path': [],
  '--inspect': false,
  '--conditions': [],
  '--experimental-default-type': 'commonjs',
  '--experimental-loader-types': [],
  '--experimental-json-modules': true,
  '--experimental-wasm-modules': false,
  '--network-family-autoselection': false,
  '--no-addons': false,
  '--force-fips': false,
  '--use-env-proxy': false,
  '--vfs-load': '',
  '--entry-url': false,
  '--report-on-signal': false,
  '--heapsnapshot-signal': '',
  '--diagnostic-dir': '',
  '--enable-fips-indicator-events': false,
  '--heapsnapshot-near-heap-limit': 0,
  '--http-parser': 'default',
};
defBinding('options', () => Object.freeze({
  getCLIOptionsValues: () => CLI_OPTIONS,
  getCLIOptionsInfo: () => ({ options: new Map(), aliases: new Map() }),
  getOptionsAsFlags: () => ({}),
  getEmbedderOptions: () => Object.freeze({
    hasInspector: false, shouldRegisterInspectorCode: false,
    noBrowserGlobals: false, buildMode: 'release',
    hasEmbedderPreload: false, noGlobalSearchPaths: false,
  }),
  getEnvOptionsInputType: () => ({ __proto__: null }),
  getNamespaceOptionsInputType: () => ({ __proto__: null }),
  parseNodeOptionsEnvVar: () => [],
  envSettings: Object.freeze({ kDisallowedInEnvvar: 0, kAllowedInEnvvar: 1 }),
  types: Object.freeze({ kBoolean: 0, kString: 1, kUInteger: 2, kV8Duration: 3, kNoOp: -1 }),
}));

// OBLIGATION 18: 'icu' (node_i18n.cc) over the engine's Unicode support.
defBinding('icu', () => Object.freeze({
  getStringWidth: (str) => {
    let w = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp >= 32) w += 1;
    }
    return w;
  },
  toASCII: (s) => { try { return new URL(`http://${s}`).hostname; } catch { return s; } },
  toUnicode: (s) => s,
  toUpperFull: (s) => s.toUpperCase(),
  toLowerFull: (s) => s.toLowerCase(),
  getDefaultICULocale: () => 'en-US',
  getDefaultTimeZone: () => 'UTC',
}));

// 'encoding_binding' (node_string.cc encodeInto/encodeUtf8String/decodeUTF8 +
// node_i18n.cc toASCII) — DISCOVERED by this PoC's entry run: the entry's
// fs.writeFileSync('utf8') went Node's TextEncoder (bootstrap/web/
// exposed-wildcard.js lazily replaces the global with internal/encoding.js's,
// exposed-wildcard.js:50-54), and that module destructures this binding at
// init (internal/encoding.js:59-65); lib/url.js:39 reads toASCII from it at
// init too. Implemented over the PLATFORM encoder/decoders captured before
// bootstrap (module scope, §0) — the WHATWG engines are the same ones the
// native binding wraps via V8/ICU.
defBinding('encoding_binding', () => {
  // node_string.cc: shared result tuple read back by TextEncoder#encodeInto
  // (internal/encoding.js:348-354 reads {0: read, 1: written}).
  const encodeIntoResults = new Uint32Array(2);
  return Object.freeze({
    encodeIntoResults,
    encodeInto(input, dest) {
      const r = platformTextEncoder.encodeInto(String(input), dest);
      encodeIntoResults[0] = r.read;
      encodeIntoResults[1] = r.written;
    },
    encodeUtf8String(input) {
      return platformTextEncoder.encode(`${input}`);
    },
    decodeUTF8(input, ignoreBOM, fatal) {
      const bytes = input instanceof ArrayBuffer ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      const dec = fatal
        ? (ignoreBOM ? platformDecoders.fatalKeep : platformDecoders.fatalStrip)
        : (ignoreBOM ? platformDecoders.keep : platformDecoders.strip);
      return dec.decode(bytes);
    },
    // IDNA domain-to-ASCII (url.js:39 uses it for WHATWG URL host parsing) —
    // the platform URL engine ships the same IDNA processing.
    toASCII: (domain) => {
      try { return new URL(`http://${domain}`).hostname; } catch { return `${domain}`; }
    },
  });
});

// OBLIGATION 19: 'trace_events' + 'process_methods' + 'credentials' +
// 'performance' + 'buffer'.
defBinding('trace_events', () => {
  const state = {};
  return {
    setTraceCategoryStateUpdateHandler(fn) { state.handler = fn; },
    isTraceCategoryEnabled: () => false,
    // No native category-enabled buffer in the browser host — trace_events.js
    // falls back to isTraceCategoryEnabled (internal/trace_events.js:27-31).
    getCategoryEnabledBuffer: () => undefined,
    // V8 trace API is not exposed to the web; tracing is disabled (no-op).
    trace: () => {},
    usePerfetto: false,
  };
});

defBinding('process_methods', () => {
  const state = {};
  const hrtimeBuffer = new Float64Array(3);
  const t0 = Date.now();
  return {
    dlopen() { throw new Error('dlopen: native addons unsupported in Nodine'); },
    uptime: () => (platformPerformance.now() - T_BOOT) / 1000,
    _getActiveRequests: () => [],
    _getActiveHandles: () => [],
    getActiveResourcesInfo: () => [],
    reallyExit(code) {
      // P2-006-008: capture WHO exits — npx died exit-0 silently mid-flow
      // (between the /npm packument fetch and the /create-expo-app fetch,
      // 3/3 with --loglevel silly). The stack names the caller.
      if (!state.reallyExitLogged) {
        state.reallyExitLogged = true;
        try { report({ type: 'exit-stack', code, stack: String(new Error().stack).slice(0, 4000) }); } catch {}
      }
      // M1.7A: process exit must not leak nested browser workers (the
      // pnpm-wasm thread pool). Terminate them all before the exit report.
      try { pnpm_wasmNodeSupport.runCleanup(); report({ type: 'worker-teardown', kind: 'reallyExit' }); } catch {}
      state.exitCode = code; processExitCode = code; platformMessagePost({ type: 'exit', code });
    },
    // P2-006-007: process.kill — own pid raises the signal locally (Node
    // default: unhandled ⇒ exit 128+N); other pids route to the supervisor
    // (kill RPC on the channel port).
    _kill(pid, sig) { return this.kill(pid, sig); },
    kill(pid, sig) {
      const signal = typeof sig === 'string' ? sig : (sig === 0 ? 'SIGTERM' : null);
      if (typeof pid !== 'number') throw new Error('invalid pid');
      if (pid === (INIT?.pid ?? 1)) {
        raiseProcessSignal(signal || 'SIGTERM');
        return true;
      }
      if (CHANNEL_PORT) CHANNEL_PORT.postMessage({ type: 'kill', pid, sig: signal || 'SIGTERM' });
      return true;
    },
    exit() {},
    execve() { throw new Error('execve: not supported'); },
    constrainedMemory: () => undefined,
    availableMemory: () => undefined,
    setEmitWarningSync(fn) { state.emitWarningSync = fn; },
    _debugProcess() {}, _debugEnd() {},
    _rawDebug(s) { platformConsoleError(s); },
    abort() { throw new Error('abort: not supported in PoC'); },
    cwd: () => hostCwd,
    chdir(d) {
      // Kernel-authoritative: OP_STAT decides existence + dir-ness.
      const res = syncOp(OP.STAT, 0n, 0n, 0n, platformTextEncoder.encode(String(d)));
      if (res.status === UV.UV_ENOENT) { const err = new Error(`ENOENT: no such file or directory, chdir '${d}'`); err.code = 'ENOENT'; err.errno = res.status; throw err; }
      if (res.status !== 0) { const err = new Error(`EACCES: permission denied, chdir '${d}'`); err.code = 'EACCES'; err.errno = res.status; throw err; }
      const mode = new Float64Array(res.payload.buffer, res.payload.byteOffset, 18)[1];
      if ((mode & 0xF000) !== 0x4000) { const err = new Error(`ENOTDIR: not a directory, chdir '${d}'`); err.code = 'ENOTDIR'; throw err; }
      hostCwd = String(d);
    },
    umask: () => 0o22,
    hrtimeBuffer,
    hrtime() {
      const ns = BigInt(Math.round((platformPerformance.now() - T_BOOT) * 1e6));
      const sec = Number(ns / 1000000000n);
      const nanos = Number(ns % 1000000000n);
      hrtimeBuffer[0] = sec / 0x100000000; // hi
      hrtimeBuffer[1] = sec % 0x100000000; // lo
      hrtimeBuffer[2] = nanos;
    },
    hrtimeBigInt() {
      const ns = BigInt(Math.round((platformPerformance.now() - T_BOOT) * 1e6));
      new DataView(hrtimeBuffer.buffer).setBigUint64(0, ns, true);
    },
    cpuUsage(out) { out[0] = 0; out[1] = 0; },
    threadCpuUsage(out) { out[0] = 0; out[1] = 0; },
    memoryUsage() { return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }; },
    rss() {},
    resourceUsage(out) { out.fill ? out.fill(0) : out; },
    loadEnvFile() {},
    patchProcessObject(p) {
      // node_process_object.cc:160-244: argv/execArgv/pid/title/debugPort.
      // argv[1] is the entry module when the run uses run_main_module.
      p.argv = [INIT?.argv0 || '/nodine/bin/node', ...(INIT?.entry ? [INIT.entry] : []), ...(INIT?.argv || [])];
      p.execArgv = [];
      // B26: real node's execPath is ALWAYS the absolute interpreter binary
      // path — even when launched via a bare `node` (PATH hit). The old
      // argv0-passthrough left '/nodine/bin/node' (or bare 'node') in
      // process.execPath, which broke TWO ecosystem surfaces:
      //  (1) module.globalPaths — the vendored loader computes it from
      //      dirname(execPath); with the honest '/usr/bin/node' it now
      //      yields ['/usr/lib/node_modules', '/usr/lib/node'] — the REAL
      //      global install root of the seeded npm (env.PREFIX-less prefix
      //      = dirname(dirname(execPath)) = /usr → /usr/lib/node_modules);
      //  (2) resolveGlobal-style probes (@expo/require-utils: '@expo/ngrok'
      //      for `expo start --tunnel`) which read node:module.globalPaths
      //      to find globally-installed packages — with the broken value
      //      they saw only cwd-relative paths and re-prompted forever
      //      ('Install @expo/ngrok@^4.1.0 and try again' ×3).
      {
        const raw0 = String(INIT?.argv0 || 'node');
        p.execPath = raw0.includes('/') ? raw0
          : (raw0 === 'node' || raw0 === 'nodine-node' ? '/usr/bin/node' : '/usr/bin/' + raw0);
      }
      Object.defineProperty(p, 'pid', { value: INIT?.pid ?? 1, writable: false });
      Object.defineProperty(p, 'ppid', { get: () => 0 });
      p.title = 'node';
      p.debugPort = 9229;
      // M1.7A-b4 FIX (pnpm install crash): node_process_methods.cc installs
      // the credential accessors from the credentials binding on the
      // process object; our bootstrap skipped them, so the @pnpm/wasm
      // harness's pnpm_fs.uid host op crashed the guest with
      // "TypeError: process.getuid is not a function" (observed live: the
      // install died silently right after its first registry request).
      // Same honest single-user values as the credentials binding (uid 0
      // per getUserInfo; the binding's -1 sentinel is internal-only).
      p.getuid = () => 0;
      p.geteuid = () => 0;
      p.getgid = () => 0;
      p.getegid = () => 0;
      p.getgroups = () => [];
    },
  };
});

defBinding('credentials', () => Object.freeze({
  implementsPosixCredentials: false,
  getuid: () => -1, geteuid: () => -1, getgid: () => -1, getegid: () => -1,
  getgroups: () => [],
  safeGetenv: (name) => realmProcess.env[name],
  getTempDir: () => '/tmp',
}));

defBinding('performance', () => {
  const milestones = new Float64Array(40);
  return Object.freeze({
    now: () => nowMs(),
    timeOrigin: () => Date.now(),
    markBootstrapComplete() { milestones[5] = nowMs(); },
    timerify: (fn) => fn,
    getTimeOrigin: () => Date.now() * 1e-3,
    milestones,
    timerStart() {}, timerEnd() {},
    // P2-006-007: internal/perf/observe.js calls these AT MODULE LOAD
    observerCounts: new Float64Array(16),
    setupObservers() {}, // no native observer stream; the JS entry points no-op
    updateGarbageCollectionTracking() {},
    constants: Object.freeze({
      NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN: 1,
      NODE_PERFORMANCE_MILESTONE_NODE_START: 2,
      NODE_PERFORMANCE_MILESTONE_LOOP_START: 3,
      NODE_PERFORMANCE_MILESTONE_LOOP_EXIT: 4,
      NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE: 5,
      NODE_PERFORMANCE_MILESTONE_ENVIRONMENT: 6,
      NODE_PERFORMANCE_MILESTONE_THIRD_PARTY_START: 7,
      NODE_PERFORMANCE_MILESTONE_CLONE_START: 8,
      NODE_PERFORMANCE_MILESTONE_CLONE_COMPLETE: 9,
      NODE_PERFORMANCE_MILESTONE_DESTROY_START: 10,
      NODE_PERFORMANCE_MILESTONE_DESTROY_COMPLETE: 11,
      NODE_PERFORMANCE_MILESTONE_INSTANT: 12,
      NODE_PERFORMANCE_EVENT_LOOP_START: 13,
      NODE_PERFORMANCE_EVENT_LOOP_EXIT: 14,
      NODE_PERFORMANCE_MILESTONE_COMPLETE: 15,
    }),
  });
});

defBinding('buffer', () => {
  const enc = new TextEncoder();
  const binding = {
    kMaxLength: 0x7fffffff,
    kStringMaxLength: 0x1fffffe8,
    byteLengthUtf8: (s) => enc.encode(s).length,
    compare: (a, b) => {
      const len = Math.min(a.length, b.length);
      for (let i = 0; i < len; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    },
    compareOffset: (a, b, o1, o2, l) => {
      for (let i = 0; i < l; i++) { if (a[o1 + i] !== b[o2 + i]) return a[o1 + i] < b[o2 + i] ? -1 : 1; }
      return 0;
    },
    // node_buffer.cc Copy is called as binding.copy(source, target, targetStart,
    // sourceStart, sourceEnd) — lib/buffer.js:306 `_copy(source, target, ...)`,
    // SOURCE FIRST (FIX: the shim's params were swapped, so `source` received
    // the number targetStart and b1.copy(b3) died on `source.subarray`).
    copy: (source, target, targetStart, sourceStart, sourceEnd) => {
      const n = Math.min(sourceEnd - sourceStart, target.length - targetStart);
      target.set(source.subarray(sourceStart, sourceStart + n), targetStart);
      return n;
    },
    fill: (buf, val, start, end) => {
      if (typeof val === 'number') buf.fill(val, start, end);
      else if (typeof val === 'string') { const b = enc.encode(val); for (let i = start; i < end; i++) buf[i] = b[i % b.length]; }
      return buf;
    },
    isAscii: (buf) => { for (const b of buf) if (b > 0x7f) return false; return true; },
    isLatin1: (buf) => { for (const b of buf) if (b > 0xff) return false; return true; },
    isUtf8: (buf) => { try { utf8Decoder.decode(buf); return true; } catch { return false; } },
    stringLengthUtf8: (s) => enc.encode(s).length,
    // M1.3 fix: these run with `buf` being a Buffer — calling buf.indexOf
    // here re-enters Buffer.prototype.indexOf (which dispatches string
    // searches back to indexOfString / number searches to indexOfNumber) and
    // recurses until RangeError. Observed live: every preview request died in
    // HTTP1Connection.parse's buf.indexOf('\r\n\r\n') → preview 502/503s.
    // Always scan on the plain Uint8Array view instead.
    indexOfBuffer: (buf, search, byteOffset, encoding, dir) => {
      const s = typeof search === 'string' ? enc.encode(search) : search;
      outer: for (let i = byteOffset; i <= buf.length - s.length; i++) {
        for (let j = 0; j < s.length; j++) if (buf[i + j] !== s[j]) continue outer;
        return i;
      }
      return -1;
    },
    indexOfNumber: (buf, byte, start) => Uint8Array.prototype.indexOf.call(buf, byte, start),
    indexOfString: (buf, s, start) => {
      const needle = enc.encode(s);
      outer: for (let i = start; i <= buf.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer;
        return i;
      }
      return -1;
    },
    swap16: SwapN(2), swap32: SwapN(4), swap64: SwapN(8),
    atob: (s) => __nodineNativeAtob(s),
    btoa: (s) => __nodineNativeBtoa(s),
    asciiWriteStatic: (buf, str, offset, maxLength) => WriteStatic(buf, str, offset, maxLength, 'latin1'),
    latin1WriteStatic: (buf, str, offset, maxLength) => WriteStatic(buf, str, offset, maxLength, 'latin1'),
    utf8WriteStatic: (buf, str, offset, maxLength) => WriteStatic(buf, str, offset, maxLength, 'utf-8'),
    asciiSlice: (buf, start, end) => Latin1Slice(buf, start, end),
    latin1Slice: (buf, start, end) => Latin1Slice(buf, start, end),
    base64Slice: (buf, start, end) => B64Slice(buf, start, end, false),
    base64urlSlice: (buf, start, end) => B64Slice(buf, start, end, true),
    hexSlice: (buf, start, end) => HexSlice(buf, start, end),
    ucs2Slice: (buf, start, end) => new TextDecoder('utf-16le').decode(buf.subarray(start, end)),
    utf8Slice: (buf, start, end) => utf8Decoder.decode(buf.subarray(start, end)),
    base64Write: (buf, str, offset, maxLength) => WriteStatic(buf, str, offset, maxLength, 'base64'),
    base64urlWrite: (buf, str, offset, maxLength) => WriteStatic(buf, str, offset, maxLength, 'base64url'),
    hexWrite: (buf, str, offset, maxLength) => WriteStatic(buf, str, offset, maxLength, 'hex'),
    ucs2Write: (buf, str, offset, maxLength) => WriteStatic(buf, str, offset, maxLength, 'utf-16le'),
    asciiWrite: (buf, str, offset, maxLength) => WriteStatic(buf, str, offset, maxLength, 'latin1'),
    latin1Write: (buf, str, offset, maxLength) => WriteStatic(buf, str, offset, maxLength, 'latin1'),
    utf8Write: (buf, str, offset, maxLength) => WriteStatic(buf, str, offset, maxLength, 'utf-8'),
    arrayBufferAlignedOffset(ab, alignment) { return 0; },
    createUnsafeArrayBuffer(size) { return new ArrayBuffer(size); },
    setDetachKey() {},
    setupBufferJS(prototype, allocator) {
      return Object.freeze({
        createFromString(str, encoding) {
          return BufferFrom(str, encoding);
        },
        createFromTypedArray() { throw new Error('PoC: createFromTypedArray'); },
        createUnsafe(size) { return new Uint8Array(size); },
      });
    },
    setBufferPrototype(proto) { binding._bufferProto = proto; },
  };
  function SwapN(n) {
    return (buf) => {
      const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i + n <= buf.byteLength; i += n) {
        if (n === 2) v.setUint16(i, v.getUint16(i, false), true);
        else if (n === 4) v.setUint32(i, v.getUint32(i, false), true);
        else v.setBigUint64(i, v.getBigUint64(i, false), true);
      }
      return buf;
    };
  }
  function BufferFrom(str, encoding) {
    return enc.encode(str);
  }
  function WriteStatic(buf, str, offset, maxLength, encoding) {
    let bytes;
    if (encoding === 'base64' || encoding === 'base64url') {
      const b64 = encoding === 'base64url' ? str.replace(/-/g, '+').replace(/_/g, '/') : str;
      const bin = __nodineNativeAtob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else if (encoding === 'hex') {
      bytes = new Uint8Array(str.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(str.substr(i * 2, 2), 16);
    } else if (encoding === 'utf-16le') {
      bytes = new Uint8Array(str.length * 2);
      const v = new DataView(bytes.buffer);
      for (let i = 0; i < str.length; i++) v.setUint16(i * 2, str.charCodeAt(i), true);
    } else if (encoding === 'utf-8') {
      bytes = enc.encode(str);
    } else {
      bytes = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    }
    const len = Math.min(bytes.length, maxLength ?? bytes.length, buf.length - offset);
    buf.set(bytes.subarray(0, len), offset);
    return len;
  }
  function Latin1Slice(buf, start, end) { let s = ''; for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]); return s; }
  function B64Slice(buf, start, end, url) {
    const bin = Latin1Slice(buf, start, end);
    const b64 = __nodineNativeBtoa(bin);
    return url ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
  }
  function HexSlice(buf, start, end) { let s = ''; for (let i = start; i < end; i++) s += buf[i].toString(16).padStart(2, '0'); return s; }
  return binding;
});

// OBLIGATION 20: 'async_context_frame' — pinned off; upstream JS fallback used.
let acfStorage;
defBinding('async_context_frame', () => Object.freeze({
  getContinuationPreservedEmbedderData: () => acfStorage,
  setContinuationPreservedEmbedderData(v) { acfStorage = v; },
}));

// OBLIGATION 21: 'mksnapshot' — inert (isBuildingSnapshotBuffer[0] stays 0).
defBinding('mksnapshot', () => Object.freeze({
  isBuildingSnapshotBuffer: new Uint8Array([0]),
  setSerializeCallback() {},
  setDeserializeCallback() {},
  setDeserializeMainFunction() { throw new Error('not building snapshot'); },
  runEmbedderPreload() { throw new Error('no embedder preload'); },
}));

// OBLIGATION 22: 'messaging' (node_messaging.cc). The browser has native
// MessageChannel/structuredClone; the binding maps onto them. NEW vs P1-A2:
// DOMException (internal/util.js lazyDOMException reads it from here) +
// exposeLazyDOMExceptionProperty (bootstrap/web/exposed-wildcard.js:29).
defBinding('messaging', () => {
  const state = {};
  return Object.freeze({
    setDeserializerCreateObjectFunction(fn) { state.deserializer = fn; },
    structuredClone: globalThis.structuredClone,
    // P2-006-008: internal/worker/io.js destructures MessagePort +
    // MessageChannel at MODULE LOAD and immediately runs prototype surgery
    // on MessagePort.prototype — undefined here was the stackless
    // "Cannot read properties of undefined (reading 'prototype')" that
    // killed create-expo's require('worker_threads') (bisected live:
    // every other external of its graph passes). The PLATFORM classes are
    // the real ones; io.js re-parents their prototype onto NodeEventTarget
    // (inherited methods keep working — postMessage/onmessage included).
    MessagePort: globalThis.MessagePort,
    MessageChannel: globalThis.MessageChannel,
    receiveMessageOnPort: () => undefined, // sync drain not observable (documented divergence)
    moveMessagePortToContext: () => { throw new Error('moveMessagePortToContext: cross-context ports unsupported'); },
    messageChannel: () => {
      const { port1, port2 } = new MessageChannel();
      return [port1, port2];
    },
    newMessagePort: () => { throw new Error('PoC: MessagePort wrapping is host work'); },
    startMessagePort() {}, stopMessagePort() {}, drainMessagePort() {},
    broadcastChannel: () => { throw new Error('PoC stub'); },
    get DOMException() { return perContextExports.DOMException; },
    exposeLazyDOMExceptionProperty(target) {
      // node_messaging.cc ExposeLazyDOMExceptionProperty: a lazy global getter
      // returning the context's DOMException constructor.
      Object.defineProperty(target, 'DOMException', {
        __proto__: null,
        enumerable: false,
        configurable: true,
        get() { return perContextExports.DOMException; },
        set(v) { Object.defineProperty(target, 'DOMException', { __proto__: null, value: v, writable: true, configurable: true, enumerable: false }); },
      });
    },
  });
});

// OBLIGATION 23: 'diagnostics_channel' (node_diagnostics_channel.cc:159-161).
defBinding('diagnostics_channel', () => {
  const state = { subscribers: new Uint32Array(64), links: new Map(), statusCbs: new Map() };
  return Object.freeze({
    get subscribers() { return state.subscribers; },
    linkNativeChannel(name, index) {
      if (TEST_ID === 'T6' && typeof name === 'string') report({ type: 'dc-link', name });
      state.links.set(name, index);
      state.statusCbs.set(index, () => {});
    },
    notifyChannelActive(index) { if (TEST_ID === 'T6') report({ type: 'dc-active', index }); state.subscribers[index] = 1; },
    notifyChannelInactive(index) { if (TEST_ID === 'T6') report({ type: 'dc-inactive', index }); state.subscribers[index] = 0; },
  });
});

// OBLIGATION 24: 'url_pattern' — bridge onto the platform's URLPattern.
defBinding('url_pattern', () => Object.freeze({
  URLPattern: globalThis.URLPattern ?? class URLPatternShim {
    constructor() { throw new Error('URLPattern: bridge onto platform URLPattern'); }
  },
}));

// OBLIGATION 25: 'url' — the URL parser seam (node_url.cc wraps ada::). The
// browser ships the WHATWG URL engine natively; this binding implements the
// ada-shaped contract internal/url.js v26 expects (parse/update/pathToFileURL/
// canParse/getOrigin + the shared urlComponents snapshot buffer).
defBinding('url', () => {
  const state = {};
  // Pin the PLATFORM's URL engine at factory time — after bootstrap,
  // globalThis.URL is replaced by Node's own (exposed-wildcard.js) and calling
  // it from the binding would recurse into the binding itself.
  const PlatformURL = globalThis.URL;
  // Shared component snapshot (node_url.cc writes into one array per parse).
  // Indices per setURLContextFromBinding (internal/url.js:177-189):
  // [0]=protocol_end [1]=username_end [2]=host_start [3]=host_end [4]=port
  // [5]=pathname_start [6]=search_start [7]=hash_start [8]=scheme_type
  const components = [0, 0, 0, 0, 0, 0, 0, 0, 1];
  const OMITTED = 4294967295; // URLContext.#omitted
  const schemeTypes = { 'http:': 0, 'https:': 2, 'ws:': 3, 'ftp:': 4, 'wss:': 5, 'file:': 6 };

  function refreshComponents(u, href) {
    const protocolEnd = href.indexOf(':') + 1;
    const search = u.search || '';
    const hash = u.hash || '';
    const pathname = u.pathname || '';
    const pathnameStart = href.length - (pathname.length + search.length + hash.length);
    const searchStart = search.length > 0 ? href.length - (search.length + hash.length) : OMITTED;
    const hashStart = hash.length > 0 ? href.length - hash.length : OMITTED;
    // authority span for URLs that have one ('//' after scheme)
    let hostStart = pathnameStart;
    let hostEnd = pathnameStart;
    const authorityIdx = href.indexOf('//', protocolEnd - 1);
    if (authorityIdx === protocolEnd) { // special scheme with authority
      const authStart = protocolEnd + 2;
      const atIdx = href.indexOf('@', authStart);
      hostStart = (atIdx !== -1 && atIdx < pathnameStart) ? atIdx + 1 : authStart;
      hostEnd = pathnameStart;
      const colonIdx = href.indexOf(':', hostStart);
      if (colonIdx !== -1 && colonIdx < hostEnd) hostEnd = colonIdx;
    }
    components[0] = protocolEnd;
    components[1] = hostStart; // username_end: [protocol_end+2, username_end)
    components[2] = hostStart;
    components[3] = hostEnd;
    components[4] = u.port ? Number(u.port) : OMITTED;
    components[5] = pathnameStart;
    components[6] = searchStart;
    components[7] = hashStart;
    components[8] = schemeTypes[u.protocol] ?? 1; // 1 = NOT_SPECIAL (ada::scheme::type)
    return components;
  }

  function makeInvalidURLError() {
    const codes = capturedLoaders.requireBuiltin('internal/errors').codes;
    return new codes.ERR_INVALID_URL('Invalid URL');
  }

  function parse(input, base, raiseException) {
    let u;
    try {
      u = base !== undefined && base !== '' ? new PlatformURL(input, base) : new PlatformURL(input);
    } catch {
      if (raiseException) throw makeInvalidURLError();
      return undefined;
    }
    refreshComponents(u, u.href);
    return u.href;
  }

  function update(href, action, value) {
    // updateActions (internal/url.js:140-151)
    let u;
    try { u = new PlatformURL(href); } catch { return undefined; }
    try {
      switch (action) {
        case 0: u.protocol = value; break;   // kProtocol
        case 1: u.host = value; break;       // kHost
        case 2: u.hostname = value; break;   // kHostname
        case 3: u.port = value; break;       // kPort
        case 4: u.username = value; break;   // kUsername
        case 5: u.password = value; break;   // kPassword
        case 6: u.pathname = value; break;   // kPathname
        case 7: u.search = value; break;     // kSearch ('' removes the query)
        case 8: u.hash = value; break;       // kHash
        case 9: {                             // kHref
          u.href = value; break;
        }
        default: return undefined;
      }
    } catch {
      return undefined;
    }
    refreshComponents(u, u.href);
    return u.href;
  }

  function pathToFileURL(input, interpretAsWindowsPath, base) {
    // POSIX path -> file: URL (the nodine host is not Windows; the windows
    // variant is accepted but treated like posix — documented PoC limitation).
    let p = String(input);
    if (!p.startsWith('/')) p = '/' + p;
    const encoded = p.split('/').map((seg, i) => {
      if (i === 0) return '';
      return encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    }).join('/');
    const u = new PlatformURL('file://' + encoded);
    refreshComponents(u, u.href);
    return u.href;
  }

  return Object.freeze({
    URL: PlatformURL,
    parse,
    update,
    pathToFileURL,
    canParse: (url, base) => {
      try {
        if (base !== undefined && base !== null && base !== '') new PlatformURL(url, base);
        else new PlatformURL(url);
        return true;
      } catch { return false; }
    },
    getOrigin: (url) => { try { return new PlatformURL(url).origin; } catch { return 'null'; } },
    get urlComponents() { return components; },
    // P2-006-008: legacy url.format (lib/url.js:611 bindingUrl.format) —
    // reconstructs the href with the fragment/search/auth-part flags applied
    // by suffix excision so the original serialization is preserved.
    format(href, fragment = true, unicode = false, search = true, auth = true) {
      let u;
      try { u = new PlatformURL(String(href)); } catch { return String(href); }
      let out = String(href);
      let cut = out.length;
      if (u.hash && !fragment) cut = Math.min(cut, out.length - u.hash.length);
      if (u.search && !search) cut = Math.min(cut, out.length - u.hash.length - u.search.length);
      out = out.slice(0, cut);
      if (!auth && u.username) {
        const creds = u.username + (u.password ? ':' + u.password : '') + '@';
        out = out.replace(creds, '');
      }
      if (unicode) { try { out = decodeURI(out); } catch {} }
      return out;
    },
    domainToASCII: (d) => { try { return new PlatformURL(`http://${d}`).hostname; } catch { return false; } },
    domainToUnicode: (d) => d,
    encodeAuthChars: new Uint8Array(256),
    setURLConstructor(ctor) { state.URL = ctor; },
    getURLConstructor: () => state.URL ?? globalThis.URL,
    URLSearchParams_from: globalThis.URLSearchParams,
    onUrlSearchParametersChanged() {},
    toASCIIFastPath: (s) => s,
    getOsFileURL: () => { throw new Error('PoC stub'); },
  });
});

// OBLIGATION 26: 'contextify' — the compile seam (node_contextify.cc). The
// web substitute for ScriptCompiler::CompileFunction is `new Function`.
defBinding('contextify', () => {
  // P2-006-008-3: vm.createContext validates via isContext after makeContext
  // ('The "contextifiedObject" argument must be an vm.Context' otherwise) —
  // track contextified objects in a WeakSet (the browser host has no separate
  // V8 contexts; contextify-in-place).
  const contexts = new WeakSet();
  class ContextifyScriptShim {
    // Native signature (internal/vm.js:180-208 makeContextifyScript ->
    // node_contextify.cc ContextifyScript::New): EIGHT POSITIONAL args:
    // (code, filename, lineOffset, columnOffset, cachedData,
    //  produceCachedData, parsingContext, hostDefinedOptionId).
    // FIX (P1-POC2): the native binding stores hostDefinedOptionId in the
    // v8::Script's HOST-DEFINED OPTIONS; esm/utils.js:171-186 registerModule()
    // reads it back through the host_defined_option_symbol private symbol and
    // uses it as the moduleRegistries WeakMap KEY. Without it, the entry
    // script dies with "TypeError: Invalid value used as weak map key" at
    // registerImportModuleDynamically <- makeContextifyScript <- compileScript
    // (lib/internal/process/execution.js:415). The shim mirrors the HDO store
    // as a private-symbol property on the script object.
    constructor(code, filename, lineOffset, columnOffset, cachedData,
               produceCachedData, parsingContext, hostDefinedOptionId) {
      this._source = String(code);
      this._filename = filename;
      if (hostDefinedOptionId !== undefined) {
        this[privateSymbols.host_defined_option_symbol] = hostDefinedOptionId;
      }
      this._fn = new Function('exports', 'require', 'module', '__filename', '__dirname', this._source);
    }
    runInThisContext() { return this._fn(); }
    runInContext(contextifiedObject, opts) {
      // sandbox === null means "current context" (internal/vm.js:218-228
      // runScriptInThisContext FunctionPrototypeCalls runInContext with
      // sandbox=null) — indirect eval is the web equivalent of running a
      // compiled Script in the current realm.
      return (0, eval)(this._source);
    }
    createCachedData() { return null; }
    getPropertyNames() { return []; }
  }
  return Object.freeze({
    ContextifyScript: ContextifyScriptShim,
    containsModuleSyntax(source) {
      // regex placeholder — a real parser is bridge work (P1-A2 §6.1 caveat)
      return /^\s*(import|export)[\s{'"*]/m.test(source);
    },
    // Native signature (internal/vm.js:133-165 internalCompileFunction ->
    // node_contextify.cc ScriptCompiler::CompileFunction): TEN POSITIONAL
    // args, returns { function }. The host-defined option id lands on the
    // compiled FUNCTION object (registerImportModuleDynamically is called on
    // result.function and registerModule reads the same private symbol).
    compileFunction(code, filename, lineOffset, columnOffset, cachedData,
                    produceCachedData, parsingContext, contextExtensions,
                    params, hostDefinedOptionId) {
      const fn = new Function(...(params ?? []), code);
      if (hostDefinedOptionId !== undefined) {
        fn[privateSymbols.host_defined_option_symbol] = hostDefinedOptionId;
      }
      return { function: fn };
    },
    compileFunctionForCJSLoader(content, filename, isSeaMain, shouldDetectModule, isEmbedder = false) {
      let fn;
      // Node strips the shebang before compiling (loader.js stripShebang —
      // hashbangs are Script/Module grammar, not Function-body grammar).
      let src = typeof content === 'string' && content.startsWith('#!') ? content.replace(/^#![^\n]*\n?/, '\n') : content;
      // P2-006-007: CJS dynamic import() interop. Node compiles CJS with an
      // importModuleDynamically host hook (vm.js) that resolves bare
      // specifiers through the module's own resolver; `new Function` has no
      // host options, so bare `import('chalk')` would hit the WORKER's
      // module graph and die. Bridge it the way Node's CJS-ESM interop
      // behaves: require() the specifier (full node_modules resolution via
      // the module's own require) and shape the CJS namespace
      // ({...named, default}); native import() stays the fallback for
      // URLs / ESM-only specifiers. The transform only rewrites the
      // import-keyword call form (never property access); string-literal
      // 'import(' occurrences are the documented residual risk, checked
      // against the tree we run (none in npm 12.2.2's CJS).
      if (/\bimport\s*\(/.test(src)) {
        src = src.replace(/(^|[^.\w$])import\s*\(/g, '$1__cjsDynamicImport(');
        src = 'const __cjsDynamicImport = (spec) => globalThis.__nodineDynamicImport(spec, __filename);\n' + src;
      }
      try {
        fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src);
      } catch (e) {
        // surface the module path — CJS SyntaxErrors are otherwise anonymous
        e.message = filename + ': ' + e.message;
        throw e;
      }
      // B10 DIAG: RUNTIME errors inside a module body are just as anonymous
      // (the fn is a plain Function — the stack shows <anonymous> frames,
      // no file). Wrap it so any throw while the module executes prefixes
      // the filename: 'TypeError: ... (loading /path/to/module.js)'. This
      // is what identified the missing-binding crashes (expo CLI died with
      // a bare 'Cannot read properties of undefined (reading prototype)'
      // and NO module name — five candidate modules, no way to tell).
      const wrapped = function (...args) {
        try {
          return fn.apply(this, args);
        } catch (e) {
          if (e instanceof Error && !e.__nodineModuleTagged) {
            e.__nodineModuleTagged = true;
            try { e.message = e.message + ' (loading ' + filename + ')'; } catch {}
          }
          throw e;
        }
      };
      try { Object.defineProperty(wrapped, 'name', { value: (fn.name || 'module') + '[' + filename.split('/').pop() + ']' }); } catch {}
      return {
        function: wrapped,
        cachedDataRejected: undefined,
        sourceMapURL: undefined,
        sourceURL: filename,
        static: shouldDetectModule ? { containsModuleSyntax: /^\s*(import|export)[\s{'"*]/m.test(content) } : undefined,
      };
    },
    isContext: (o) => (o && typeof o === 'object') && (contexts.has(o) || o[privateSymbols.contextify_context_private_symbol] !== undefined),
    // P2-006-008-3: vm.createContext → makeContext(sandbox, ...) — real Node's
    // native makeContext (node_contextify.cc) marks the sandbox with the
    // contextify_context_private_symbol; internal/vm.js's isContext reads THAT
    // symbol (not the binding), so the mark must be set here. Contextify-in-
    // place (the sandbox object itself is the context — the browser host has
    // no separate V8 contexts). vm.js destructures makeContext at module load
    // (missing export = 'makeContext is not a function' at require time).
    makeContext(sandbox) {
      if (sandbox && typeof sandbox === 'object') {
        contexts.add(sandbox);
        try { sandbox[privateSymbols.contextify_context_private_symbol] = { }; } catch {}
      }
      return sandbox;
    },
    // P2-006-008-3: vm.js destructures `constants` at module load and reads
    // constants.measureMemory.mode.SUMMARY at TOP LEVEL (vm.js:373-381) — a
    // missing entry crashed require('vm') itself, surfacing as an unhandled
    // rejection from Node's lazyWritableReleasedError path (which requires vm
    // to build a cross-realm regex) and REPLACING the real error during the
    // Expo golden's npm-install phase.
    constants: {
      measureMemory: {
        mode: { SUMMARY: 0, DETAILED: 1 },
        execution: { DEFAULT: 0, EAGER: 1 },
      },
    },
    // vm.measureMemory(mode, execution) — the browser host has no per-context
    // measurement; resolve with a well-shaped summary (vm.js returns the
    // binding result directly; undefined would mean ERR_CONTEXT_NOT_INITIALIZED).
    measureMemory(_mode, _execution) {
      return Promise.resolve({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } });
    },
  });
});

// OBLIGATION 32 (P1-A2 discovery): 'uv' — the UV errno backbone (src/uv.cc).
// Pure data, generated from node v26.13.0's vendored libuv UV_ERRNO_MAP with
// Linux errno values (uv-errno-linux.txt). NOT frozen: errors.js caches
// `errmap` onto the exports object (errors.js:632).
defBinding('uv', () => {
  const errmap = new Map();
  for (const e of UVMAP) errmap.set(e.value, ['E' + e.name.slice(1), e.message]);
  const out = {
    errname(err) {
      const entry = errmap.get(err);
      if (entry) return entry[0];
      if (err >= 0) throw new Error(`err >= 0: ${err}`);
      return 'UNKNOWN';
    },
    getErrorMessage(err) {
      const entry = errmap.get(err);
      return entry ? entry[1] : 'unknown error';
    },
    getErrorMap() { return errmap; },
  };
  for (const e of UVMAP) out['UV_' + e.name] = e.value;
  return out;
});

// OBLIGATION 27: 'fs' — the kernel-VFS syscall seam (node_file.cc). THIS PoC
// implements a REAL subset against the host VFS: sync open/read/write/close/
// stat/fstat/lstat/readFileUtf8/writeFileUtf8/mkdir/internalModuleStat plus
// the async FSReqCallback protocol and Read/WriteFileJob thread-pool jobs
// (completions delivered from the platform event loop, like libuv would).
defBinding('fs', () => {
  // The REAL filesystem binding — every call crosses the frozen ABI v1.0.2
  // transport into the Rust kernel's VFS + per-process fd tables. Zero
  // filesystem state lives in this worker (no parallel VFS, no shadow fd
  // table). Sync mode = §11 mailbox; async/callback/promises = §12 ring.
  const O = { RDONLY: 0, WRONLY: 1, RDWR: 2, CREAT: 64, EXCL: 128, TRUNC: 512, APPEND: 1024 };
  const READ_CHUNK = 128 * 1024;   // async READ result-area budget (256 KiB cap)
  const WRITE_CHUNK = 128 * 1024;  // async TX arena budget (248 KiB cap)
  const SYNC_TX_MAX = 8128;        // §11.6 sync reserve

  function uvName(errno) {
    for (const e of UVMAP) if (e.value === errno) return e.name;
    return 'UNKNOWN';
  }
  function uvMessage(errno, syscall, path, dest) {
    const n = uvName(errno);
    const p = path !== undefined ? ` '${path}'` : '';
    const d = dest !== undefined ? ` -> '${dest}'` : '';
    return `${n}: ${syscall}${p}${d}, errno: ${errno}`;
  }
  function makeErr(errno, syscall, path, dest) {
    // Kernel meta-codes (NODINE_*) surface with their protocol name.
    if (errno <= -0x10000000) {
      const err = new Error(`nodine: ${syscall} failed with kernel status ${errno}`);
      err.errno = errno;
      err.code = `ERR_NODINE_${(-errno - 0x10000000).toString(16).toUpperCase().padStart(8, '0')}`;
      err.syscall = syscall;
      if (path !== undefined) err.path = path;
      return err;
    }
    const err = new Error(uvMessage(errno, syscall, path, dest));
    err.errno = errno;
    err.code = uvName(errno);
    err.syscall = syscall;
    if (path !== undefined) err.path = path;
    if (dest !== undefined) err.dest = dest;
    return err;
  }
  function uvThrow(errno, syscall, path, dest) { throw makeErr(errno, syscall, path, dest); }
  function fillCtx(ctx, errno, syscall, path) {
    if (ctx) { ctx.errno = errno; ctx.syscall = syscall; ctx.path = path; }
  }
  function notImpl(name) {
    report({ type: 'fs-notimpl', name });
    const err = new Error(`fs binding: ${name} — no kernel op in ABI v1.0.2 (reserved surface)`);
    err.code = 'ENOSYS';
    err.errno = UV.UV_ENOSYS;
    throw err;
  }
  function checkSync(res, syscall, path, dest) {
    if (res.status === 0) return res;
    uvThrow(res.status, syscall, path, dest);
  }
  function completeAsync(fn) {
    // Macrotask delivery (the p1-poc loop model): asyncFsOutstanding keeps
    // waitForQuiet honest while ops are in flight.
    asyncFsOutstanding++;
    platformSetTimeout(() => {
      asyncFsOutstanding--;
      try { fn(); } catch (e) { platformConsoleError('async fs delivery error', e); }
    }, 0);
  }
  const enc = platformTextEncoder;
  const isReq = (v) => v && typeof v === 'object' && typeof v.oncomplete === 'function';
  const kUsePromises = Symbol('kUsePromises');

  // P2-009 (B18): worker-side STAT CACHE. Evidence (dev-logs/perf-breakdown.
  // json): npm install's reify walks stat/lstat the SAME ~10-15K paths
  // repeatedly (135K LSTAT + 55K STAT for 560 packages) — arborist's
  // loadActual/placeDep re-walks the node_modules tree per dependency
  // placement. Each async op costs a full worker→doorbell→pump→notify→drain
  // round-trip (p50 0.15 ms floor; p99 100-250 ms under contention), so the
  // redundant walks ARE the 47s→220s gap vs native. Kernel + driver are
  // idle (busy 0.03%) — pure transport latency, so the fix is to NOT CROSS
  // the transport for repeats: cache the kernel's stat reply per
  // (path, follow-symlinks) and invalidate on ANY mutation op the process
  // itself issues.
  //   * Per-fs-binding = per-PROCESS cache — a CHILD process's mutations
  //     would not invalidate a running parent's cache, so the spawn bridge
  //     clears it (fsStatCacheOnChildSpawn, wired where the process's child
  //     spawn lands). npm awaits each child to completion before re-reading
  //     the tree, which restores visibility at the next walk regardless.
  //   * Failed stats (ENOENT) cache too — arborist's "does node_modules/x
  //     exist" checks are the hottest reads, and mkdir-then-stat sequences
  //     invalidate via MKDIR anyway.
  //   * Entries hold the payload Uint8Array COPY (drainCompletions already
  //     .slice()s it off the recycled RX arena), so cached bytes are stable.
  // Cap 2^14 entries (install-scale trees are ~10-15K distinct paths); the
  // cap is a size guard, not an eviction policy — clear wholesale on hit.
  const fsStatCache = new Map(); // "S\0path"|"L\0path" -> Uint8Array|null(ENOENT)
  const FS_STAT_CACHE_MAX = 16384;
  const fsStatCacheKey = (path, follow) => (follow ? 'S\0' : 'L\0') + String(path);
  function fsStatCacheHas(path, follow) { return fsStatCache.has(fsStatCacheKey(path, follow)); }
  function fsStatCacheGet(path, follow) { return fsStatCache.get(fsStatCacheKey(path, follow)); }
  function fsStatCachePut(path, follow, payload) {
    if (fsStatCache.size >= FS_STAT_CACHE_MAX) fsStatCache.clear();
    fsStatCache.set(fsStatCacheKey(path, follow), payload);
  }
  function fsStatCacheInval(path) { // drop BOTH follow modes of this path
    fsStatCache.delete(fsStatCacheKey(path, true));
    fsStatCache.delete(fsStatCacheKey(path, false));
  }
  function fsStatCacheInvalAll() { fsStatCache.clear(); }
  function fsStatCacheOnChildSpawn() { fsStatCache.clear(); }

  // P2-009 (B19): sync-execution fast path for metadata FS ops. The §11 sync
  // mailbox completes a metadata op in 0.04-0.11 ms (doorbell→pump LANE-0
  // priority→sm_seq notify) vs ~1.2 ms via the §12 async ring — a ~10x round-
  // trip win for SEQUENTIAL awaited ops (npm reify: ~134K of them). The
  // promises/callback stat/lstat/mkdir/rmdir/unlink/rename bindings run the
  // same kernel op through syncOp inside a resolved-promise wrapper (userland
  // semantics unchanged: errors still surface as rejections / oncomplete
  // errors). Gates: NODINE_SYNC_FAST=0 disables (kill switch); fires only
  // while this worker has NO async op outstanding (single-flight mailbox +
  // no completion-drain starvation — bursts fall back automatically); any
  // mailbox contention error falls back to the async ring.
  const SYNC_FAST = (() => {
    try {
      const v = String(((INIT && INIT.env) || {}).NODINE_SYNC_FAST ?? '1').trim().toLowerCase();
      return !/^(0|off|false|no)$/.test(v);
    } catch { return true; }
  })();
  const syncFastOk = () => SYNC_FAST && outstanding.size === 0 && bridgeQueue.length === 0;
  function syncFastTry(op, a0, a1, a2, txBytes) {
    // Returns { ok, res } — ok:false means "contended, use asyncOp".
    try {
      return { ok: true, res: syncOp(op, a0, a1, a2, txBytes) };
    } catch (e) {
      if (e && (e.code === 'ERR_NODINE_ETIMEOUT' || /mailbox stuck|CAS lost/i.test(String(e && e.message)))) {
        return { ok: false, res: null };
      }
      throw e; // genuine kernel error surfaces normally
    }
  }

  // -- stat shaping ----------------------------------------------------------
  function statArray(payload, bigint) {
    if (bigint) return new BigInt64Array(payload.buffer, payload.byteOffset, 18);
    return new Float64Array(payload.buffer, payload.byteOffset, 18);
  }
  // M1.7A: fd→path registry — the kernel's OP_FSTAT reports mode=0 for
  // DIRECTORY OFDs (STAT fills them; FSTAT does not). wasm-util's WASI
  // preopen check fstatSync(fd,{bigint:true}).isDirectory() then fails
  // with ENOTDIR ('Preopen not dir: ["/","/"]'). Bridge-side repair,
  // no kernel change: remember each open()'s path; when FSTAT returns
  // an all-zero/unknown type, re-derive the stat via OP.STAT(path).
  const fdPathRegistry = new Map();
  function rememberFd(fd, path) {
    if (typeof fd === 'number' && fd >= 0) {
      if (fdPathRegistry.size > 4096) fdPathRegistry.clear();
      fdPathRegistry.set(fd, String(path));
    }
    return fd;
  }
  function forgetFd(fd) { fdPathRegistry.delete(fd); }

  // R-FSYNC: memory-only VFS has no durable state to flush — fsync/fdatasync
  // are no-op successes for any fd the registry knows (tmpfs behaves the
  // same); unknown fds fail with EBADF so closed/invalid descriptors don't
  // silently pass. No kernel op exists, hence the registry consultation.
  function fsyncNoOp(fd, req, op) {
    const known = fdPathRegistry.has(fd) || fd === 0 || fd === 1 || fd === 2;
    const fail = () => {
      const e = makeErr(-9, op, null); e.code = 'EBADF'; // UV_EBADF
      return e;
    };
    if (req === kUsePromises) return known ? Promise.resolve() : Promise.reject(fail());
    if (isReq(req)) {
      const err = known ? null : fail();
      completeAsync(() => req.oncomplete.call(req, err));
      return;
    }
    if (!known) throw fail();
  }
  const fs_constants_O_DIRECTORY = 0x10000; // Linux O_DIRECTORY (node fs.constants.O_DIRECTORY)
  function repairFstatSlots(arr, fd) {
    try {
      const modeIdx = 1;
      const mode = Number(arr[modeIdx]) & 0xF000;
      if (mode !== 0) return arr; // kernel filled it (regular file)
      const p = fdPathRegistry.get(fd);
      if (!p) return arr;
      const res = syncOp(OP.STAT, 0n, 0n, 0n, enc.encode(p));
      if (res.status !== 0) return arr;
      // The payload slots are ALWAYS Float64; statArray(_, true) re-views
      // those bytes as BigInt64 (garbage — found live: mode read as
      // 4670368328391327744). Build a properly-typed array for the caller.
      const fv = statArray(res.payload, false);
      const wantBigint = arr instanceof BigInt64Array;
      if (wantBigint) {
        const out = new BigInt64Array(18);
        for (let i = 0; i < 18; i++) out[i] = BigInt(Math.round(fv[i]));
        return out;
      }
      const outF = new Float64Array(18);
      outF.set(fv);
      return outF;
    } catch { }
    return arr;
  }
  function doStat(op, path, bigint, syscall) {
    const res = syncOp(op, 0n, 0n, 0n, enc.encode(String(path)));
    if (res.status !== 0) return { err: res.status };
    // M1.7A fix: kernel stat payloads are ALWAYS Float64 slots. The old
    // `statArray(payload, bigint)` re-views the same bytes as BigInt64
    // when bigint=true — garbage (mode 4670368328391327744) that made
    // `statSync(p,{bigint:true}).isDirectory()` false and killed the
    // pnpm-wasm guest's chdir with ENOTDIR (os error 54). Convert
    // explicitly to the requested numeric type.
    if (!bigint) return { stats: statArray(res.payload, false) };
    const fv = statArray(res.payload, false);
    const out = new BigInt64Array(18);
    for (let i = 0; i < 18; i++) out[i] = BigInt(Math.round(fv[i]));
    return { stats: out };
  }

  // -- internal whole-file helpers (also the seed path) ----------------------
  function openSyncFd(path, flags, mode) {
    const res = syncOp(OP.OPEN, BigInt(flags), BigInt(mode), 0n, enc.encode(path));
    if (res.status !== 0) uvThrow(res.status, 'open', path);
    return new DataView(res.payload.buffer, res.payload.byteOffset, 4).getUint32(0, true);
  }
  function readWholeFileSync(path) {
    // open + fstat + positional read loop + close. Returns Uint8Array.
    const fd = openSyncFd(path, O.RDONLY, 0);
    try {
      const st = checkSync(syncOp(OP.FSTAT, BigInt(fd)), 'fstat', path);
      const size = Number(new Float64Array(st.payload.buffer, st.payload.byteOffset, 18)[8]);
      const out = new Uint8Array(size);
      let off = 0;
      while (off < size) {
        const want = Math.min(size - off, ABIC.RX_PAYLOAD_MAX);
        const r = checkSync(syncOp(OP.READ, BigInt(fd), BigInt(want), BigInt(off)), 'read', path);
        if (r.kind === ST.NONE || r.len === 0) break; // EOF
        out.set(r.payload.subarray(0, r.len), off);
        off += r.len;
      }
      return out.subarray(0, off);
    } finally {
      syncOp(OP.CLOSE, BigInt(fd));
    }
  }
  function mkdirPSync(path, mode) {
    // recursive mkdir (Node's binding.mkdir(path, mode, recursive, ...)):
    // walk missing parents, create each, return the FIRST created path.
    const parts = String(path).split('/').filter(Boolean);
    let firstCreated = undefined;
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      const st = syncOp(OP.STAT, 0n, 0n, 0n, enc.encode(cur));
      if (st.status === 0) continue;
      if (st.status !== UV.UV_ENOENT) uvThrow(st.status, 'mkdir', cur);
      const r = syncOp(OP.MKDIR, BigInt(mode), 0n, 0n, enc.encode(cur));
      if (r.status !== 0) uvThrow(r.status, 'mkdir', cur);
      if (firstCreated === undefined) firstCreated = cur;
    }
    return firstCreated;
  }
  function seedFileKernel(path, contents, flags = O.WRONLY | O.CREAT | O.TRUNC, mode = 0o644) {
    // path's parents must exist; the entry runner pre-creates /project.
    // flags-aware: appendFileSync rides here with O_APPEND (no TRUNC).
    const bytes = typeof contents === 'string' ? enc.encode(contents) : contents;
    const fd = openSyncFd(path, flags, mode);
    try {
      let off = 0;
      while (off < bytes.length) {
        const chunk = bytes.subarray(off, Math.min(off + SYNC_TX_MAX, bytes.length));
        const r = checkSync(syncOp(OP.WRITE, BigInt(fd), -1n, 0n, chunk), 'write', path);
        off += new DataView(r.payload.buffer, r.payload.byteOffset, 4).getUint32(0, true);
      }
    } finally {
      syncOp(OP.CLOSE, BigInt(fd));
    }
  }
  function readdirAllSync(path) {
    // cookie-batched OP_READDIR walk -> [{name, kind}]
    const out = [];
    let cookie = 0n;
    for (;;) {
      const res = checkSync(syncOp(OP.READDIR, cookie, 256n, 16384n, enc.encode(path)), 'readdir', path);
      const dv = new DataView(res.payload.buffer, res.payload.byteOffset, res.payload.byteLength);
      const count = dv.getUint32(0, true);
      if (count === 0) break;
      cookie = dv.getBigUint64(8, true);
      let cursor = 16;
      for (let i = 0; i < count; i++) {
        const kind = new Uint8Array(res.payload.buffer, res.payload.byteOffset + cursor, 1)[0];
        const nameLen = dv.getUint32(cursor + 4, true);
        const name = utf8Decoder.decode(new Uint8Array(res.payload.buffer, res.payload.byteOffset + cursor + 8, nameLen));
        out.push({ name, kind });
        cursor += 8 + ((nameLen + 7) & ~7);
      }
    }
    return out;
  }

  class FSReqCallback { constructor() { this.oncomplete = undefined; } }

  // ReadFileJob — the node_file.cc one-shot: open+fstat+read+close for files
  // <= maxRead; larger files hand the fd back to JS for chunked reading.
  class ReadFileJob {
    constructor(path, flags, maxRead, trackFd) {
      this.path = path; this.flags = flags; this.maxRead = maxRead;
      this.trackFd = trackFd; this.ondone = undefined;
    }
    run(path) {
      const p = path ?? this.path;
      const flags = this.flags;
      asyncOp(OP.OPEN, BigInt(flags), 0o666n, 0n, enc.encode(p)).then((res) => {
        const fd = new DataView(res.payload.buffer, res.payload.byteOffset, 4).getUint32(0, true);
        return asyncOp(OP.FSTAT, BigInt(fd)).then((st) => {
          const size = Number(new Float64Array(st.payload.buffer, st.payload.byteOffset, 18)[8]);
          if (size > this.maxRead) {
            // large file: (null, undefined, fd, size, undefined) — JS continues
            return Promise.resolve(this.ondone && this.ondone.call(this, null, undefined, fd, size, undefined));
          }
          const buf = new Uint8Array(size);
          const readAll = (off) => {
            if (off >= size) return Promise.resolve();
            const want = Math.min(size - off, READ_CHUNK);
            return asyncOp(OP.READ, BigInt(fd), BigInt(want), BigInt(off)).then((r) => {
              if (r.len > 0) buf.set(r.payload.subarray(0, r.len), off);
              if (r.len === 0) return; // AV-T1: shrank mid-read — stop, no spin
              return readAll(off + r.len);
            });
          };
          return readAll(0).then(() => asyncOp(OP.CLOSE, BigInt(fd))).then(() => {
            const buffer = toBuffer(buf);
            this.ondone && this.ondone.call(this, null, buffer, -1, size, undefined);
          });
        }).catch((e) => asyncOp(OP.CLOSE, BigInt(fd)).catch(() => {}).then(() => {
          const err = e && e.errno !== undefined ? e : makeErr(UV.UV_EIO, 'read', p);
          this.ondone && this.ondone.call(this, err);
        }));
      }, (e) => {
        this.ondone && this.ondone.call(this, e && e.errno !== undefined ? e : makeErr(UV.UV_EIO, 'open', p));
      });
      return undefined;
    }
  }
  // WriteFileJob — open+write+close one-shot. data is a Buffer (fs.js
  // encodes strings before constructing).
  class WriteFileJob {
    constructor(path, flags, mode, data) {
      this.path = path; this.flags = flags; this.mode = mode;
      this.data = data && data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data;
      this.ondone = undefined;
    }
    run(path) {
      const p = path ?? this.path;
      // B18: one-shot write mutates the path (fsPromises.writeFile /
      // appendFile via flag 'a' — the b18 probe caught appendFile's stale
      // size through exactly this job).
      fsStatCacheInval(p);
      asyncOp(OP.OPEN, BigInt(this.flags), BigInt(this.mode), 0n, enc.encode(p)).then((res) => {
        const fd = new DataView(res.payload.buffer, res.payload.byteOffset, 4).getUint32(0, true);
        const data = this.data;
        const writeAll = (off) => {
          if (off >= data.length) return Promise.resolve();
          const chunk = data.subarray(off, Math.min(off + WRITE_CHUNK, data.length));
          return asyncOp(OP.WRITE, BigInt(fd), -1n, 0n, chunk).then(() => writeAll(off + chunk.length));
        };
        return writeAll(0)
          .then(() => asyncOp(OP.CLOSE, BigInt(fd)))
          .then(() => {
            this.ondone && this.ondone.call(this, null);
          }, (e) => asyncOp(OP.CLOSE, BigInt(fd)).catch(() => {}).then(() => {
            // AV-R5: never leak the fd on mid-write failures.
            this.ondone && this.ondone.call(this, e);
          }));
      }, (e) => {
        this.ondone && this.ondone.call(this, e && e.errno !== undefined ? e : makeErr(UV.UV_EIO, 'open', p));
      }).catch((e) => {
        this.ondone && this.ondone.call(this, e);
      });
      return undefined;
    }
  }

  function toBuffer(u8) {
    // Buffer-shaped object over the bytes (the p1-poc approach — the real
    // Buffer prototype comes from the 'buffer' binding cache).
    const proto = bindingCache.get('buffer')?._bufferProto;
    const obj = new Uint8Array(u8);
    if (proto) Object.setPrototypeOf(obj, proto);
    return obj;
  }

  // The C++ FileHandle (node_file.cc) — the internal constructor
  // promises.js wraps: `new FileHandle(new binding.FileHandle(fd))`
  // (readFileInOneRoundTrip's large-file path).
  class InternalFileHandle {
    constructor(fd) {
      this.fd = fd;
    }
    getAsyncId() { return 0; }
    close() { return asyncOp(OP.CLOSE, BigInt(this.fd)); }
    closeSync() {
      const r = syncOp(OP.CLOSE, BigInt(this.fd));
      if (r.status !== 0) uvThrow(r.status, 'close');
    }
    releaseFD() { }
  }

  // ---- P2-006-007: new-op helpers + pipe-stdio plumbing ---------------------
  function decodeUvPath(payload, encoding) {
    if (encoding === 'buffer') { const B = globalThis.Buffer; return B ? B.from(payload) : payload; }
    return new TextDecoder(encoding === 'latin1' ? 'latin1' : 'utf-8').decode(payload);
  }
  // pipe-mode stdio: fd 1/2 writes relay to the supervisor; fd 0 reads drain
  // the supervisor-fed queue ('stdin-bytes' on the channel port).
  function stdioPipeWrite(fd, view) {
    // P2-008 FIX (the 64 KiB garbage "npm error" from the piped pack child):
    // Node Buffers override slice() to return a zero-copy VIEW — posting
    // view.buffer then ships the ENTIRE underlying ArrayBuffer (observed
    // live: a 141-byte clean write delivered as 65,600 bytes of pool
    // garbage — module sources + NUL/space padding — because the write
    // Buffer was a view into a 64 KiB pool buffer). Exact-size copy, always.
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    platformMessagePost({ type: 'stdio-bytes', stream: fd, bytes: copy.buffer }, [copy.buffer]);
    return Promise.resolve(view.byteLength);
  }
  function stdinPipeRead(into, off, len) {
    return new Promise((resolve) => {
      // E6: EOF already seen with an empty queue → immediate 0-byte read
      if (stdinEofSeen && stdinQueue.length === 0) {
        try { platformMessagePost({ type: 'stdin-read-eof-fast' }); } catch {} // B21-DIAG
        resolve(0); return;
      }
      const w = { into, off, len, resolve };
      stdinReadWaiters.push(w);
      stdinWaiters = stdinReadWaiters.length; // M1.6 fix: a process blocked reading piped stdin is LIVE (the counter was only updated on waiter resolution, so a waiting reader looked quiet and quit-quiet killed it — real Node keeps stdin readers alive)
      try { platformMessagePost({ type: 'stdin-read-registered', eof: stdinEofSeen, queued: stdinQueue.length }); } catch {} // B21-DIAG
      pumpStdinQueue();
    });
  }
  // B21 (stdin-cancel): fd-0 reads were UNSETTLEABLE — the runtime has no
  // uv_read_stop equivalent. A paused/closed stdin left the pipe waiter
  // (this lane) or the EAGAIN retry loop (kernel-FIFO lane) armed forever;
  // waitForQuit counts stdinWaiters/stdinRetryCount as liveness, so
  // proc-exit was never posted and the terminal prompt never returned
  // (reproduced live: readline question answered → 'GOT bob' printed →
  // prompt hung >90 s, while trivial no-stdin scripts exit in 2 s — the
  // intermittent race the hang diagnosis describes). The module-level
  // cancelStdinRead() (see top of file) is the read-stop equivalent:
  // resolve pipe waiters with 0 bytes (EOF semantics — the stream pushes
  // null, kIsPerformingIO clears, kIoDone fires, _destroy completes, the
  // gate drains) and flag EOF so later pipe reads settle immediately. The
  // EAGAIN lane checks __stdinCancelled per retry and exits its loop the
  // same way. This impl hook lets the factory pump after the cancel.
  pumpStdinQueueRef = pumpStdinQueue;
  cancelStdinReadImpl = pumpStdinQueue;
  // M1.6 fix: wire the channel-side pump — deliverStdinToWaiters() (called
  // when the supervisor pushes stdin-bytes onto CHANNEL_PORT) referenced
  // pumpStdinQueueRef but NOTHING ever assigned it, so the function was a
  // NO-OP: channel-delivered stdin bytes sat in stdinQueue forever; only
  // bytes that arrived BEFORE a read registered were seen (the eager
  // pump inside stdinPipeRead). Delayed SDK ContainerProcess.input writes
  // were silently lost (observed live: write #3+ of a sequence vanished).
  pumpStdinQueueRef = pumpStdinQueue;
  function pumpStdinQueue() {
    for (;;) {
      const w = stdinReadWaiters[0];
      if (!w) return;
      if (stdinQueue.length === 0) {
        // E6: EOF with nothing queued → 0-byte read (real EOF semantics)
        if (stdinEofSeen) { stdinReadWaiters.shift(); stdinWaiters = stdinReadWaiters.length; w.resolve(0); return; }
        return;
      }
      const chunk = stdinQueue[0];
      const take = Math.min(chunk.length, w.len);
      w.into.set(chunk.subarray(0, take), w.off);
      if (take === chunk.length) stdinQueue.shift();
      else stdinQueue[0] = chunk.subarray(take);
      if (take > 0) {
        stdinReadWaiters.shift();
        stdinWaiters = stdinReadWaiters.length;
        w.resolve(take);
      } else if (stdinQueue.length === 0) {
        return;
      }
    }
  }
  return {
    FSReqCallback,
    ReadFileJob,
    WriteFileJob,
    FileHandle: InternalFileHandle,
    kUsePromises,
    // B18: cross-module cache invalidation handle — the child_process bridge
    // (OUTSIDE this closure) calls this at every spawn so a child's VFS
    // mutations can never ride a running parent's cached stats.
    _fsStatCacheOnChildSpawn: fsStatCacheOnChildSpawn,
    getNumParallelJobs() { return 4; },
    // runtime-entry helpers (main.js): kernel-mediated seeding — NOT part of
    // Node's binding surface; prefixed with _ to stay visibly internal.
    _mkdirP: mkdirPSync,
    _seedFile: seedFileKernel,
    // ---- P2-006-007 ops (ABI v1.0.3) ----------------------------------------
    symlink(target, path, flags, req) {
      const t = enc.encode(String(target));
      const l = enc.encode(String(path));
      const tx = new Uint8Array(t.length + 1 + l.length);
      tx.set(t, 0); tx[t.length] = 0; tx.set(l, t.length + 1); // [target][NUL][linkpath]
      fsStatCacheInval(String(path)); // B18: new dirent
      if (req === kUsePromises) return asyncOp(OP.SYMLINK, 0n, 0n, 0n, tx).then(() => undefined);
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.SYMLINK, 0n, 0n, 0n, tx).then(() => req.oncomplete.call(req, null), (e) => req.oncomplete.call(req, e)));
        return;
      }
      const res = syncOp(OP.SYMLINK, 0n, 0n, 0n, tx);
      if (res.status !== 0) uvThrow(res.status, 'symlink', path);
    },
    readlink(path, encoding, req) {
      const tx = enc.encode(String(path));
      const decode = (payload) => decodeUvPath(payload, encoding);
      if (req === kUsePromises) {
        return asyncOp(OP.READLINK, 1024n, 0n, 0n, tx).then((res) => decode(res.payload));
      }
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.READLINK, 1024n, 0n, 0n, tx).then((res) => req.oncomplete.call(req, null, decode(res.payload)), (e) => req.oncomplete.call(req, e)));
        return;
      }
      const res = syncOp(OP.READLINK, 1024n, 0n, 0n, tx);
      if (res.status !== 0) uvThrow(res.status, 'readlink', path);
      return decode(res.payload);
    },
    link(existingPath, newPath, req) {
      const a = enc.encode(String(existingPath));
      const b = enc.encode(String(newPath));
      const tx = new Uint8Array(a.length + 1 + b.length);
      tx.set(a, 0); tx[a.length] = 0; tx.set(b, a.length + 1);
      fsStatCacheInvalAll(); // B18: new dirent — conservative wholesale
      if (req === kUsePromises) return asyncOp(OP.LINK, 0n, 0n, 0n, tx).then(() => undefined);
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.LINK, 0n, 0n, 0n, tx).then(() => req.oncomplete.call(req, null), (e) => req.oncomplete.call(req, e)));
        return;
      }
      const res = syncOp(OP.LINK, 0n, 0n, 0n, tx);
      if (res.status !== 0) uvThrow(res.status, 'link', existingPath, newPath);
    },
    chmod(path, mode, req) {
      const tx = enc.encode(String(path));
      fsStatCacheInval(String(path)); // B18: mode rides the stat payload
      if (req === kUsePromises) return asyncOp(OP.CHMOD, BigInt(mode), 0n, 0n, tx).then(() => undefined);
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.CHMOD, BigInt(mode), 0n, 0n, tx).then(() => req.oncomplete.call(req, null), (e) => req.oncomplete.call(req, e)));
        return;
      }
      const res = syncOp(OP.CHMOD, BigInt(mode), 0n, 0n, tx);
      if (res.status !== 0) uvThrow(res.status, 'chmod', path);
    },
    fchmod(fd, mode, req) {
      // M1.7A-b4 FIX (pnpm store lock): no FCHMOD kernel op in the ABI,
      // but the fd→path registry (M1.7A, kept for FSTAT repair) lets us
      // emulate fd-based chmod as a path CHMOD. The @pnpm/wasm harness's
      // secureDirectory() fchmodSync()s its lock directory (0o700); the
      // old honest-ENOSYS made pnpm's store-lock open fail with
      // ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK (os error 52) and killed
      // the whole install. Unknown fd keeps the honest ENOSYS.
      const p = fdPathRegistry.get(fd);
      if (p === undefined) {
        const e = makeErr(-38, 'fchmod', null); e.code = 'ENOSYS';
        if (req === kUsePromises) return Promise.reject(e);
        if (isReq(req)) { completeAsync(() => req.oncomplete.call(req, e)); return; }
        throw e;
      }
      const tx = enc.encode(p);
      if (req === kUsePromises) return asyncOp(OP.CHMOD, BigInt(mode), 0n, 0n, tx).then(() => undefined);
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.CHMOD, BigInt(mode), 0n, 0n, tx).then(() => req.oncomplete.call(req, null), (e) => req.oncomplete.call(req, e)));
        return;
      }
      const res = syncOp(OP.CHMOD, BigInt(mode), 0n, 0n, tx);
      if (res.status !== 0) uvThrow(res.status, 'fchmod', p);
    },
    utimes(path, atime, mtime, req) {
      // atime/mtime: Date (ms) | number (SECONDS, unix semantics) | string.
      const toNs = (v) => {
        let ms;
        if (v instanceof Date) ms = v.getTime();
        else if (typeof v === 'number') ms = v * 1000;
        else ms = Date.parse(String(v));
        if (!Number.isFinite(ms)) { const e = makeErr(-22, 'utimes', path); throw e; }
        return BigInt(Math.round(ms * 1e6));
      };
      const tx = enc.encode(String(path));
      const a0 = toNs(atime), a1 = toNs(mtime);
      fsStatCacheInval(String(path)); // B18: times ride the stat payload
      if (req === kUsePromises) return asyncOp(OP.UTIMES, a0, a1, 1n, tx).then(() => undefined);
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.UTIMES, a0, a1, 1n, tx).then(() => req.oncomplete.call(req, null), (e) => req.oncomplete.call(req, e)));
        return;
      }
      const res = syncOp(OP.UTIMES, a0, a1, 1n, tx);
      if (res.status !== 0) uvThrow(res.status, 'utimes', path);
    },
    futimes(fd, atime, mtime, req) {
      const e = makeErr(-38, 'futimes', null); e.code = 'ENOSYS';
      if (req === kUsePromises) return Promise.reject(e);
      if (isReq(req)) { completeAsync(() => req.oncomplete.call(req, e)); return; }
      throw e;
    },
    writeBuffers(fd, buffers, position, req) {
      // iovec composition at the bridge: sequential chunked writes (the
      // single atomic writev is a documented v1.0.3 divergence).
      // P2-006-008: pipe-mode stdio interception here TOO — TTY streams
      // write through the iovec path (writev), and only writeBuffer had
      // the check; a pipe-mode child's stream writes bypassed the pipe
      // and landed in the kernel stdio FIFO instead.
      if (STDIO_MODE === 'pipe' && (fd === 1 || fd === 2)) {
        let n = 0;
        for (const buf of buffers) { stdioPipeWrite(fd, buf); n += buf.byteLength; }
        if (req === kUsePromises) return Promise.resolve(n);
        if (isReq(req)) {
          completeAsync(() => Promise.resolve(n).then((v) => req.oncomplete.call(req, null, v), (e) => req.oncomplete.call(req, e)));
          return;
        }
        return n;
      }
      const base = position === null || position === undefined ? -1n : BigInt(position);
      const writeAll = async () => {
        let written = 0;
        for (const buf of buffers) {
          let off = 0;
          while (off < buf.length) {
            const chunk = buf.subarray(off, Math.min(off + 128 * 1024, buf.length));
            const at = base < 0n ? -1n : base + BigInt(written + off);
            await asyncOp(OP.WRITE, BigInt(fd), at, 0n, chunk);
            off += chunk.length;
          }
          written += buf.length;
        }
        return written;
      };
      if (req === kUsePromises) return writeAll();
      if (isReq(req)) {
        completeAsync(() => writeAll().then((n) => req.oncomplete.call(req, null, n), (e) => req.oncomplete.call(req, e)));
        return;
      }
      let written = 0;
      for (const buf of buffers) {
        let off = 0;
        while (off < buf.length) {
          const chunk = buf.subarray(off, Math.min(off + 128 * 1024, buf.length));
          const at = base < 0n ? -1n : base + BigInt(written + off);
          const res = syncOp(OP.WRITE, BigInt(fd), at, 0n, chunk);
          if (res.status !== 0) uvThrow(res.status, 'write', null);
          off += chunk.length;
        }
        written += buf.length;
      }
      return written;
    },
    StatWatcher: class StatWatcher {
      // B12 POLLING WATCHER: Metro (expo start) and every dev server
      // fs.watch()/fs.watchFile() the project tree; the old empty-class stub
      // never ran a timer and Node's watchers.js start path expects a
      // libuv-style handle. This poll-based StatWatcher watches ONE path by
      // stat-ing it every `interval` ms and calling onchange(newStatus,
      // Float64Array[36]) — new + old stat records back to back, matching
      // internal/fs/watchers.js onchange (fields via getStatsFromBinding;
      // status -1 = gone, 0 = present). The loop uses the ENGINE timer
      // (captured pre-bootstrap) so it never registers as a Node timer
      // (waitForQuit must not see dev-server watchers as keepalive... they
      // ARE keepalive in real Node — a dev server with a watcher stays
      // alive exactly like this).
      constructor(bigint) {
        this.bigint = !!bigint;
        this.owner = undefined;
        this.onchange = null;
        this._timer = null;
        this._closed = false;
        this._last = null;
        this._ref = true;
      }
      start(path, interval) {
        const self = this;
        const intervalMs = Math.max(50, Number(interval) || 500);
        const statPath = String(path);
        const statOnce = () => {
          let arr = null;
          try {
            const res = syncOp(OP.STAT, 0n, 0n, 0n, enc.encode(statPath));
            if (res.status === 0 && res.payload && res.payload.byteLength >= 144) {
              arr = new Float64Array(res.payload.buffer, res.payload.byteOffset, 18);
            }
          } catch { /* ENOENT → arr stays null */ }
          const cur = arr ? Array.from(arr) : null;
          const prev = self._last;
          self._last = cur;
          if (prev === null && cur === null) return; // never existed, no event
          if (prev === null) { self.onchange && self.onchange(0, cur.concat(cur)); return; }        // created
          if (cur === null) { self.onchange && self.onchange(-1, prev.concat(prev)); return; }      // deleted
          for (let i = 0; i < 18; i++) {
            // compare mtime (10) + size (8) + mode (1) — content-ish change
            if ((i === 1 || i === 8 || i === 10) && prev[i] !== cur[i]) {
              self.onchange && self.onchange(0, cur.concat(prev));
              return;
            }
          }
        };
        try { statOnce(); } catch {} // baseline snapshot, no event for initial state? emit per libuv: first callback fires only on CHANGE — but Node's fs.watchFile DOES fire the initial stat immediately (watchers.js: kOldStatus -1 + new -1 + same nlink → suppressed; created file → fires). statOnce handles both.
        self._timer = engineSetInterval(statOnce, intervalMs);
        return 0; // success — matches binding contract (0 = no error)
      }
      close() {
        this._closed = true;
        if (this._timer !== null) { engineClearInterval(this._timer); this._timer = null; }
        return 0;
      }
      ref() { this._ref = true; }
      unref() { this._ref = false; if (this._timer && typeof this._timer === 'object' && this._timer.unref) try { this._timer.unref(); } catch {} }
      hasRef() { return this._ref; }
    },
    FSWatcher: class { },
    splitRoot() { return '/'; },
    kFsStatsFieldsNumber: 18,
    getFormatOfSize: undefined,
    // P2-006-007: LegacyMainResolve — JS port of the C++ binding (the p1-poc
    // left it undefined; npm's resolver hits package mains). Returns the
    // index into legacyMainResolveExtensions (helpers.js:659-685).
    legacyMainResolve(pkgPath, main, base) {
      const statIsFile = (p) => {
        try {
          const res = syncOp(OP.STAT, 0n, 0n, 0n, enc.encode(p));
          if (res.status !== 0) return false;
          const mode = new Float64Array(res.payload.buffer, res.payload.byteOffset, 18)[1];
          return (mode & 0xF000) === 0x8000;
        } catch { return false; }
      };
      const clean = (x) => String(x == null ? '' : x);
      const trySeq = (prefix, exts, off) => {
        for (let i = 0; i < exts.length; i++) {
          if (statIsFile(prefix + exts[i])) return off + i;
        }
        return -1;
      };
      const m = clean(main);
      if (m !== '') {
        const r = trySeq(pkgPath + '/' + m.replace(/^\.\//, ''), ['', '.js', '.json', '.node'], 0);
        if (r >= 0) return r;
        const idx = trySeq(pkgPath + '/' + m.replace(/^\.\//, '').replace(/\/+$/, ''), ['/index.js', '/index.json', '/index.node'], 4);
        if (idx >= 0) return idx;
        return 0; // not found: Node falls back to the main as-is (ENOENT upstream)
      }
      const r2 = trySeq(pkgPath, ['/index.js', '/index.json', '/index.node'], 7);
      if (r2 >= 0) return r2;
      return 7; // package/index.js default
    },

    // ---- open / openFileHandle / close -------------------------------------
    open(path, flags, mode, req) {
      const tx = enc.encode(String(path));
      // B18: O_CREAT/O_TRUNC mutate the path (existence/size) — invalidate
      // the stat cache entry so the next stat sees the new shape. O_APPEND
      // too (appendFile rides open(O_APPEND|O_CREAT) + writeBuffer; the
      // b18 semantics probe caught a stale size on exactly that path).
      if (flags & (O.CREAT | O.TRUNC | O.APPEND)) fsStatCacheInval(String(path));
      if (req === kUsePromises) {
        return asyncOp(OP.OPEN, BigInt(flags), BigInt(mode), 0n, tx).then((res) =>
          rememberFd(new DataView(res.payload.buffer, res.payload.byteOffset, 4).getUint32(0, true), path));
      }
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.OPEN, BigInt(flags), BigInt(mode), 0n, tx).then((res) => {
          const fd = new DataView(res.payload.buffer, res.payload.byteOffset, 4).getUint32(0, true);
          rememberFd(fd, path);
          req.oncomplete.call(req, null, fd);
        }, (e) => req.oncomplete.call(req, e)));
        return;
      }
      return rememberFd(openSyncFd(path, flags, mode), path);
    },
    openFileHandle(path, flags, mode, req) {
      // fsPromises.open: resolves the internal handle; promises.js grafts its
      // FileHandle prototype around { fd, close, closeSync, releaseFD }.
      const tx = enc.encode(String(path));
      // B18: fsPromises.open(O_CREAT|O_TRUNC|O_APPEND) — same mutation
      // invalidation as the callback open() above (appendFile rides this).
      if (flags & (O.CREAT | O.TRUNC | O.APPEND)) fsStatCacheInval(String(path));
      return asyncOp(OP.OPEN, BigInt(flags), BigInt(mode), 0n, tx).then((res) => {
        const fd = new DataView(res.payload.buffer, res.payload.byteOffset, 4).getUint32(0, true);
        return {
          fd,
          getAsyncId() { return 0; },
          close() { return asyncOp(OP.CLOSE, BigInt(fd)); },
          closeSync() {
            const r = syncOp(OP.CLOSE, BigInt(fd));
            if (r.status !== 0) uvThrow(r.status, 'close');
          },
          releaseFD() { },
        };
      });
    },
    close(fd, req) {
      forgetFd(fd);
      // B21 (stdin-cancel): closing fd 0 is the destroy-path signal our
      // streams CAN send the binding (ReadStream._destroy → kFs.close) —
      // cancel the in-flight fd-0 read so the stream's pending callback
      // settles (0 bytes = EOF), kIoDone fires, _destroy completes, and
      // the quit gate stops counting the dead stdin as liveness. Real
      // node closes the fd even with a pending threadpool read; the read
      // completes into a closed fd and is discarded. (see cancelStdinRead)
      if (fd === 0) { try { cancelStdinRead(); } catch {} }
      if (req === kUsePromises) return asyncOp(OP.CLOSE, BigInt(fd));
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.CLOSE, BigInt(fd)).then(() => req.oncomplete.call(req, null), (e) => req.oncomplete.call(req, e)));
        return;
      }
      const r = syncOp(OP.CLOSE, BigInt(fd));
      if (r.status !== 0) uvThrow(r.status, 'close');
    },

    // ---- read / readBuffers -------------------------------------------------
    read(fd, buffer, offset, length, position, req) {
      // P2-006-007 pipe mode: fd 0 is served from the supervisor queue.
      // P2-006-008: fd-0 PIPE reads are the channel-fed queue ONLY when this
      // process's own fd 0 is piped (per-fd stdio: a ['inherit','pipe','pipe']
      // child reads the kernel FIFO — the real terminal — like create-expo).
      // B9 TERMINAL-OWNER: the supervisor may ALSO designate this process
      // the terminal owner while its fd 0 is nominally 'inherit' — stdin
      // then arrives as targeted 'stdin-bytes' on the channel (the kernel's
      // stdin_feed BROADCASTS to every live endpoint's FIFO, so a broadcast
      // feed for a grandchild prompt also corrupts every ancestor's line
      // buffer with ghost keystrokes; verified live — the typed command
      // line answered create-expo's name prompt). __stdinOwned flips fd 0
      // to the channel queue exactly like fd0Piped does.
      const fd0Piped = globalThis.__stdinOwned || (globalThis.__nodineStdioArr ? globalThis.__nodineStdioArr[0] === 'pipe' : STDIO_MODE === 'pipe');
      if (fd0Piped && fd === 0) {
        const take = (n) => n;
        if (req === kUsePromises) return stdinPipeRead(buffer, offset, length).then(take);
        if (isReq(req)) {
          completeAsync(() => stdinPipeRead(buffer, offset, length).then((n) => req.oncomplete.call(req, null, n, buffer), (e) => req.oncomplete.call(req, e)));
          return;
        }
        // readSync(0) in pipe mode: take what is queued, else EAGAIN.
        if (stdinQueue.length === 0) { const e = makeErr(-11, 'read', 0); e.code = 'EAGAIN'; throw e; }
        const chunk = stdinQueue[0];
        const n = Math.min(chunk.length, length);
        buffer.set(chunk.subarray(0, n), offset);
        if (n === chunk.length) stdinQueue.shift(); else stdinQueue[0] = chunk.subarray(n);
        return n;
      }
      // Node's readFile paths request up to kReadFileBufferLength (512 KiB)
      // in ONE call; the ABI's area cap is RX/SYNCRES-64 (256 KiB). The
      // bridge chunks: batches of <= READ_AREA_CAP until the request is
      // satisfied or EOF (§28 worked example: large reads are multi-batch).
      const pos = position === null || position === undefined ? -1n : BigInt(position);
      const READ_AREA_CAP = 262080;
      const readAll = async (into, off, len, base) => {
        let done = 0;
        while (done < len) {
          // B21 (stdin-cancel): a cancelled fd-0 read settles as 0-byte
          // (EOF) instead of spinning on EAGAIN forever — see
          // cancelStdinRead(). Real uv would have completed or been
          // read_stopped; never settling wedged the quit gate (reproduced
          // with readline: answered prompt, then no proc-exit >90 s).
          if (fd === 0 && globalThis.__stdinCancelled) return done;
          const want = Math.min(len - done, READ_AREA_CAP);
          const at = base < 0n ? -1n : base + BigInt(done);
          // P2-006-007: EAGAIN (empty stdin FIFO) is RETRIED at the bridge —
          // blocking-read emulation for the tty-class device (the kernel is
          // the authority; the bridge shapes Node's semantics). 2 ms floor.
          let res;
          for (;;) {
            if (fd === 0 && globalThis.__stdinCancelled) return done;
            try {
              res = await asyncOp(OP.READ, BigInt(fd), BigInt(want), at);
              break;
            } catch (e) {
              if (e && e.errno === -11) {
                if (fd === 0) stdinRetryCount++;
                try { await new Promise((r) => engineSetTimeout(r, 2)); }
                finally { if (fd === 0) stdinRetryCount--; }
                continue;
              }
              throw e;
            }
          }
          if (res.len > 0) into.set(res.payload.subarray(0, res.len), off + done);
          if (res.len < want) return done + res.len; // EOF
          done += res.len;
        }
        return done;
      };
      if (req === kUsePromises) {
        // promises.js: `const bytesRead = (await binding.read(...)) || 0` —
        // the binding resolves the BARE byte count.
        return readAll(buffer, offset, length, pos);
      }
      if (isReq(req)) {
        completeAsync(() => readAll(buffer, offset, length, pos).then((n) => {
          req.oncomplete.call(req, null, n, buffer);
        }, (e) => req.oncomplete.call(req, e)));
        return;
      }
      let done = 0;
      while (done < length) {
        const want = Math.min(length - done, READ_AREA_CAP);
        const at = pos < 0n ? -1n : pos + BigInt(done);
        const res = syncOp(OP.READ, BigInt(fd), BigInt(want), at);
        if (res.status !== 0) uvThrow(res.status, 'read');
        if (res.len > 0) buffer.set(res.payload.subarray(0, res.len), offset + done);
        if (res.len < want) return done + res.len; // EOF
        done += res.len;
      }
      return done;
    },
    readBuffers(fd, buffers, position, req) { notImpl('readBuffers'); },

    // ---- write (Buffer / string / iovec) ------------------------------------
    writeBuffer(fd, buffer, offset, length, position, req, ctx) {
      if (STDIO_MODE === 'pipe' && (fd === 1 || fd === 2)) {
        const view = buffer.subarray(offset, offset + length);
        if (req === kUsePromises) return stdioPipeWrite(fd, view);
        if (isReq(req)) {
          completeAsync(() => stdioPipeWrite(fd, view).then((n) => req.oncomplete.call(req, null, n, buffer), (e) => req.oncomplete.call(req, e)));
          return;
        }
        stdioPipeWrite(fd, view); // fire-and-forget on the sync path (drain is page-side)
        return length;
      }
      const pos = position === null || position === undefined ? -1n : BigInt(position);
      const view = buffer.subarray(offset, offset + length);
      // B18: a write grows the file → the path's cached stat (size) is stale.
      // fdPathRegistry covers fs.open'd fds (npm/tar use open+write+close).
      if (fd > 2) { const p = fdPathRegistry.get(fd); if (p !== undefined) fsStatCacheInval(p); }
      // Node hands the FULL buffer to the binding (fsPromises.writeFile of a
      // 1 MiB Buffer = ONE call); the async TX arena is 248 KiB — chunk.
      const WRITE_TX_CAP = 128 * 1024;
      const writeAll = async (data, base) => {
        let off = 0;
        while (off < data.length) {
          const chunk = data.subarray(off, Math.min(off + WRITE_TX_CAP, data.length));
          const at = base < 0n ? -1n : base + BigInt(off);
          await asyncOp(OP.WRITE, BigInt(fd), at, 0n, chunk);
          off += chunk.length;
        }
        return data.length;
      };
      if (req === kUsePromises) {
        // promises.js: `const bytesWritten = (await binding.writeBuffer(...)) || 0`
        return writeAll(view, pos);
      }
      if (isReq(req)) {
        completeAsync(() => writeAll(view, pos).then((n) => {
          req.oncomplete.call(req, null, n, buffer);
        }, (e) => req.oncomplete.call(req, e)));
        return;
      }
      // sync: chunk to the §11.6 reserve; ctx-protocol errors (never throw)
      const total = view.length;
      let done = 0;
      while (done < total) {
        const chunk = view.subarray(done, Math.min(done + SYNC_TX_MAX, total));
        const res = syncOp(OP.WRITE, BigInt(fd), pos < 0n ? -1n : pos + BigInt(done), 0n, chunk);
        if (res.status !== 0) { fillCtx(ctx, res.status, 'write'); return 0; }
        done += new DataView(res.payload.buffer, res.payload.byteOffset, 4).getUint32(0, true);
      }
      return total;
    },
    writeString(fd, string, position, encoding, req, ctx) {
      const bytes = enc.encode(String(string));
      return this.writeBuffer(fd, bytes, 0, bytes.length, position, req, ctx);
    },

    // ---- whole-file sync fast paths (CJS loader hot path) -------------------
    readFileUtf8(path, flags) {
      const bytes = readWholeFileSync(path);
      return utf8Decoder.decode(bytes);
    },
    writeFileUtf8(path, data, flags, mode) {
      fsStatCacheInval(String(path)); // B18: sync write mutates size/existence
      seedFileKernel(path, data, flags, mode);
    },

    // ---- stat family ---------------------------------------------------------
    // B19: METADATA OPS via the §11 SYNC MAILBOX for promises/callback too.
    // Measured (dev-logs/perf-breakdown.json + hit-test): the sync ladder
    // completes a metadata op in 0.04-0.11 ms (doorbell→pump LANE-0
    // priority→sm_seq notify); the §12 async ring costs ~1.2 ms average
    // (submit→doorbell→pump→cr_seq notify→waitAsync-promise→drain). npm
    // install's reify is ~134K SEQUENTIAL awaited metadata ops — the async
    // hop is pure overhead for a caller that cannot continue until the op
    // finishes anyway. Real Node's libuv runs these on a thread pool with
    // negligible latency; executing them inline (in a resolved-promise
    // wrapper, so userland still sees async semantics/errors as rejections)
    // is behaviorally identical for non-interleaved callers.
    // Safety gates (all must hold; else fall back to the async ring):
    //   * NODINE_SYNC_FAST=0 in env disables everything (kill switch).
    //   * Only fire while NO async op of ours is outstanding — the sync
    //     mailbox is single-flight and the pump's completion drain for our
    //     in-flight async ops must not starve behind a long sync burst.
    //     (npm's sequential pattern means outstanding≈0; graceful-fs and
    //     cacache bursts keep the async path automatically.)
    //   * A mailbox error (CAS lost / stuck / ETIMEOUT) falls back to the
    //     async ring — never spin against a contended mailbox.
    // The helpers live at binding-factory scope (before the object literal);
    // see SYNC_FAST / syncFastOk / syncFastTry below the fsStatCache block.
    stat(path, bigint, req, throwIfNoEntry = true) {
      if (req === kUsePromises) {
        if (fsStatCacheHas(path, true)) {
          const hit = fsStatCacheGet(path, true);
          return hit ? Promise.resolve(statArray(hit, !!bigint)) : (throwIfNoEntry ? Promise.reject(makeErr(UV.UV_ENOENT, 'stat', String(path))) : Promise.resolve(undefined));
        }
        if (syncFastOk()) {
          const t = syncFastTry(OP.STAT, 0n, 0n, 0n, enc.encode(String(path)));
          if (t.ok) {
            if (t.res.status === 0) {
              fsStatCachePut(path, true, t.res.payload);
              return Promise.resolve(statArray(t.res.payload, !!bigint));
            }
            fsStatCachePut(path, true, null);
            if (t.res.status === UV.UV_ENOENT && !throwIfNoEntry) return Promise.resolve(undefined);
            return Promise.reject(makeErr(t.res.status, 'stat', String(path)));
          }
        }
        return asyncOp(OP.STAT, 0n, 0n, 0n, enc.encode(String(path))).then((res) => {
          fsStatCachePut(path, true, res.payload);
          return statArray(res.payload, !!bigint);
        }, (e) => { fsStatCachePut(path, true, null); throw e; });
      }
      if (isReq(req)) {
        completeAsync(() => {
          if (fsStatCacheHas(path, true)) {
            const hit = fsStatCacheGet(path, true);
            if (hit) req.oncomplete.call(req, null, statArray(hit, !!bigint));
            else req.oncomplete.call(req, makeErr(UV.UV_ENOENT, 'stat', String(path)));
            return;
          }
          if (syncFastOk()) {
            const t = syncFastTry(OP.STAT, 0n, 0n, 0n, enc.encode(String(path)));
            if (t.ok) {
              if (t.res.status === 0) {
                fsStatCachePut(path, true, t.res.payload);
                req.oncomplete.call(req, null, statArray(t.res.payload, !!bigint));
                return;
              }
              fsStatCachePut(path, true, null);
              req.oncomplete.call(req, makeErr(t.res.status, 'stat', String(path)));
              return;
            }
          }
          asyncOp(OP.STAT, 0n, 0n, 0n, enc.encode(String(path))).then((res) => {
            fsStatCachePut(path, true, res.payload);
            req.oncomplete.call(req, null, statArray(res.payload, !!bigint));
          }, (e) => { fsStatCachePut(path, true, null); req.oncomplete.call(req, e); });
        });
        return;
      }
      const { err, stats } = doStat(OP.STAT, path, bigint, 'stat');
      if (err !== undefined) {
        if (err === UV.UV_ENOENT && !throwIfNoEntry) return undefined;
        uvThrow(err, 'stat', path);
      }
      return stats;
    },
    lstat(path, bigint, req, throwIfNoEntry = true) {
      if (req === kUsePromises) {
        if (fsStatCacheHas(path, false)) {
          const hit = fsStatCacheGet(path, false);
          return hit ? Promise.resolve(statArray(hit, !!bigint)) : (throwIfNoEntry ? Promise.reject(makeErr(UV.UV_ENOENT, 'lstat', String(path))) : Promise.resolve(undefined));
        }
        if (syncFastOk()) {
          const t = syncFastTry(OP.LSTAT, 0n, 0n, 0n, enc.encode(String(path)));
          if (t.ok) {
            if (t.res.status === 0) {
              fsStatCachePut(path, false, t.res.payload);
              return Promise.resolve(statArray(t.res.payload, !!bigint));
            }
            fsStatCachePut(path, false, null);
            if (t.res.status === UV.UV_ENOENT && !throwIfNoEntry) return Promise.resolve(undefined);
            return Promise.reject(makeErr(t.res.status, 'lstat', String(path)));
          }
        }
        return asyncOp(OP.LSTAT, 0n, 0n, 0n, enc.encode(String(path))).then((res) => {
          fsStatCachePut(path, false, res.payload);
          return statArray(res.payload, !!bigint);
        }, (e) => { fsStatCachePut(path, false, null); throw e; });
      }
      if (isReq(req)) {
        completeAsync(() => {
          if (fsStatCacheHas(path, false)) {
            const hit = fsStatCacheGet(path, false);
            if (hit) req.oncomplete.call(req, null, statArray(hit, !!bigint));
            else req.oncomplete.call(req, makeErr(UV.UV_ENOENT, 'lstat', String(path)));
            return;
          }
          if (syncFastOk()) {
            const t = syncFastTry(OP.LSTAT, 0n, 0n, 0n, enc.encode(String(path)));
            if (t.ok) {
              if (t.res.status === 0) {
                fsStatCachePut(path, false, t.res.payload);
                req.oncomplete.call(req, null, statArray(t.res.payload, !!bigint));
                return;
              }
              fsStatCachePut(path, false, null);
              req.oncomplete.call(req, makeErr(t.res.status, 'lstat', String(path)));
              return;
            }
          }
          asyncOp(OP.LSTAT, 0n, 0n, 0n, enc.encode(String(path))).then((res) => {
            fsStatCachePut(path, false, res.payload);
            req.oncomplete.call(req, null, statArray(res.payload, !!bigint));
          }, (e) => { fsStatCachePut(path, false, null); req.oncomplete.call(req, e); });
        });
        return;
      }
      const { err, stats } = doStat(OP.LSTAT, path, bigint, 'lstat');
      if (err !== undefined) {
        if (err === UV.UV_ENOENT && !throwIfNoEntry) return undefined;
        uvThrow(err, 'lstat', path);
      }
      return stats;
    },
    fstat(fd, bigint, req, shouldNotThrow = false) {
      if (req === kUsePromises) {
        return asyncOp(OP.FSTAT, BigInt(fd)).then((res) => repairFstatSlots(statArray(res.payload, !!bigint), fd));
      }
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.FSTAT, BigInt(fd)).then((res) => {
          req.oncomplete.call(req, null, statArray(res.payload, !!bigint));
        }, (e) => req.oncomplete.call(req, e)));
        return;
      }
      const res = syncOp(OP.FSTAT, BigInt(fd));
      if (res.status !== 0) {
        if (shouldNotThrow) return undefined;
        uvThrow(res.status, 'fstat');
      }
      return repairFstatSlots(statArray(res.payload, !!bigint), fd);
    },

    // ---- directory namespace --------------------------------------------------
    mkdir(path, mode, recursive, req) {
      fsStatCacheInval(String(path)); // B18: a created dir changes the path's stat + parent shape
      if (req === kUsePromises) {
        // B19: non-recursive mkdir rides the sync fast path when quiet (npm
        // reify mkdirs are sequential, awaited one at a time).
        if (!recursive && syncFastOk()) {
          const t = syncFastTry(OP.MKDIR, BigInt(mode), 0n, 0n, enc.encode(String(path)));
          if (t.ok) {
            if (t.res.status === 0) return Promise.resolve(undefined);
            if (t.res.status === 0) return Promise.resolve(undefined);
            return Promise.reject(makeErr(t.res.status, 'mkdir', String(path)));
          }
        }
        return (recursive ? Promise.resolve(mkdirPSync(path, mode)) : asyncOp(OP.MKDIR, BigInt(mode), 0n, 0n, enc.encode(String(path))).then(() => undefined))
          .catch((e) => { throw e.errno !== undefined ? e : makeErr(UV.UV_EIO, 'mkdir', path); });
      }
      if (isReq(req)) {
        completeAsync(() => {
          const run = recursive ? Promise.resolve(mkdirPSync(path, mode)) : asyncOp(OP.MKDIR, BigInt(mode), 0n, 0n, enc.encode(String(path))).then(() => undefined);
          run.then((first) => req.oncomplete.call(req, null, first), (e) => req.oncomplete.call(req, e));
        });
        return;
      }
      if (recursive) return mkdirPSync(path, mode);
      const res = syncOp(OP.MKDIR, BigInt(mode), 0n, 0n, enc.encode(String(path)));
      if (res.status !== 0) uvThrow(res.status, 'mkdir', path);
      return undefined;
    },
    rmdir(path, req) {
      fsStatCacheInval(String(path)); // B18: parent shape changes too — wholesale is safest for namespace ops
      fsStatCacheInvalAll();
      if (req === kUsePromises) {
        if (syncFastOk()) { // B19
          const t = syncFastTry(OP.RMDIR, 0n, 0n, 0n, enc.encode(String(path)));
          if (t.ok) return t.res.status === 0 ? Promise.resolve(undefined) : Promise.reject(makeErr(t.res.status, 'rmdir', String(path)));
        }
        return asyncOp(OP.RMDIR, 0n, 0n, 0n, enc.encode(String(path))).then(() => undefined);
      }
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.RMDIR, 0n, 0n, 0n, enc.encode(String(path))).then(() => req.oncomplete.call(req, null), (e) => req.oncomplete.call(req, e)));
        return;
      }
      const res = syncOp(OP.RMDIR, 0n, 0n, 0n, enc.encode(String(path)));
      if (res.status !== 0) uvThrow(res.status, 'rmdir', path);
    },
    unlink(path, req) {
      fsStatCacheInval(String(path)); // B18: removed dirent
      if (req === kUsePromises) {
        if (syncFastOk()) { // B19
          const t = syncFastTry(OP.UNLINK, 0n, 0n, 0n, enc.encode(String(path)));
          if (t.ok) return t.res.status === 0 ? Promise.resolve(undefined) : Promise.reject(makeErr(t.res.status, 'unlink', String(path)));
        }
        return asyncOp(OP.UNLINK, 0n, 0n, 0n, enc.encode(String(path))).then(() => undefined);
      }
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.UNLINK, 0n, 0n, 0n, enc.encode(String(path))).then(() => req.oncomplete.call(req, null), (e) => req.oncomplete.call(req, e)));
        return;
      }
      const res = syncOp(OP.UNLINK, 0n, 0n, 0n, enc.encode(String(path)));
      if (res.status !== 0) uvThrow(res.status, 'unlink', path);
    },
    rename(oldPath, newPath, req) {
      const tx = new Uint8Array([...enc.encode(String(oldPath)), 0, ...enc.encode(String(newPath))]);
      fsStatCacheInval(String(oldPath)); // B18: both sides change shape —
      fsStatCacheInval(String(newPath)); // wholesale for subtree visibility
      fsStatCacheInvalAll();
      if (req === kUsePromises) {
        if (syncFastOk()) { // B19
          const t = syncFastTry(OP.RENAME, 0n, 0n, 0n, tx);
          if (t.ok) return t.res.status === 0 ? Promise.resolve(undefined) : Promise.reject(makeErr(t.res.status, 'rename', String(oldPath), String(newPath)));
        }
        return asyncOp(OP.RENAME, 0n, 0n, 0n, tx).then(() => undefined);
      }
      const res = syncOp(OP.RENAME, 0n, 0n, 0n, tx);
      if (res.status !== 0) uvThrow(res.status, 'rename', oldPath, newPath);
    },
    readdir(path, encoding, withTypes, req) {
      const wantTypes = !!withTypes;
      // P2-008 fidelity: encoding 'buffer' must yield Buffer names (real
      // Node's C++ readdir does; the sync path already did). The callback +
      // promises paths decoded to strings unconditionally — internal/fs/rimraf
      // (fs.rm's fallback) readdirs with encoding 'buffer' and does
      // Buffer.concat([childPathPrefix, files[i]]) — with string names it
      // threw ERR_INVALID_ARG_TYPE (npm ci, buildDeps → fs.rm → rimraf).
      const wantBuf = encoding === 'buffer';
      const nm = (name) => (wantBuf ? toBuffer(enc.encode(name)) : name);
      if (req === kUsePromises) {
        return (async () => {
          const entries = [];
          let cookie = 0n;
          for (;;) {
            const res = await asyncOp(OP.READDIR, cookie, 256n, 16384n, enc.encode(String(path)));
            const dv = new DataView(res.payload.buffer, res.payload.byteOffset, res.payload.byteLength);
            const count = dv.getUint32(0, true);
            if (count === 0) break;
            cookie = dv.getBigUint64(8, true);
            let cursor = 16;
            for (let i = 0; i < count; i++) {
              const kind = new Uint8Array(res.payload.buffer, res.payload.byteOffset + cursor, 1)[0];
              const nameLen = dv.getUint32(cursor + 4, true);
              const name = utf8Decoder.decode(new Uint8Array(res.payload.buffer, res.payload.byteOffset + cursor + 8, nameLen));
              entries.push(wantTypes ? { name: nm(name), kind } : nm(name));
              cursor += 8 + ((nameLen + 7) & ~7);
            }
          }
          return wantTypes ? { 0: entries.map((e) => e.name), 1: entries.map((e) => e.kind) } : entries;
        })();
      }
      if (isReq(req)) {
        completeAsync(() => (async () => {
          const names = [], types = [];
          let cookie = 0n;
          for (;;) {
            const res = await asyncOp(OP.READDIR, cookie, 256n, 16384n, enc.encode(String(path)));
            const dv = new DataView(res.payload.buffer, res.payload.byteOffset, res.payload.byteLength);
            const count = dv.getUint32(0, true);
            if (count === 0) break;
            cookie = dv.getBigUint64(8, true);
            let cursor = 16;
            for (let i = 0; i < count; i++) {
              const kind = new Uint8Array(res.payload.buffer, res.payload.byteOffset + cursor, 1)[0];
              const nameLen = dv.getUint32(cursor + 4, true);
              const name = utf8Decoder.decode(new Uint8Array(res.payload.buffer, res.payload.byteOffset + cursor + 8, nameLen));
              names.push(nm(name)); types.push(kind);
              cursor += 8 + ((nameLen + 7) & ~7);
            }
          }
          req.oncomplete.call(req, null, wantTypes ? { 0: names, 1: types } : names);
        })().catch((e) => req.oncomplete.call(req, e)));
        return;
      }
      const entries = readdirAllSync(path);
      if (wantTypes) return { 0: entries.map((e) => nm(e.name)), 1: entries.map((e) => e.kind) };
      if (encoding === 'buffer') return entries.map((e) => toBuffer(enc.encode(e.name)));
      return entries.map((e) => e.name);
    },
    readdirRecursive(basePath, encoding, withFileTypes, req) {
      // fs.readdir({recursive:true}) — JS walk over OP_READDIR (the in-tree
      // permission-model path fs.js:1802-1872 is the reference composition).
      // Shape (fs.js:1871): withFileTypes -> the grouped {0,1,2,3} record;
      // plain -> the relative-names array, returned AS-IS.
      // P2-008 fidelity: encoding 'buffer' -> Buffer names (see readdir).
      const wantTypes = !!withFileTypes;
      const wantBuf = encoding === 'buffer';
      const nm = (name) => (wantBuf ? toBuffer(enc.encode(name)) : name);
      const walk = async (dir, prefix, names, types) => {
        let cookie = 0n;
        for (;;) {
          const res = await asyncOp(OP.READDIR, cookie, 256n, 16384n, platformTextEncoder.encode(dir));
          const dv = new DataView(res.payload.buffer, res.payload.byteOffset, res.payload.byteLength);
          const count = dv.getUint32(0, true);
          if (count === 0) break;
          cookie = dv.getBigUint64(8, true);
          let cursor = 16;
          for (let i = 0; i < count; i++) {
            const kind = new Uint8Array(res.payload.buffer, res.payload.byteOffset + cursor, 1)[0];
            const nameLen = dv.getUint32(cursor + 4, true);
            const name = utf8Decoder.decode(new Uint8Array(res.payload.buffer, res.payload.byteOffset + cursor + 8, nameLen));
            const rel = prefix ? prefix + '/' + name : name;
            names.push(nm(rel)); types.push(kind);
            if (kind === 2) await walk(dir + '/' + name, rel, names, types);
            cursor += 8 + ((nameLen + 7) & ~7);
          }
        }
      };
      const grouped = () => ({ 0: names, 1: types, 2: names.map(() => names.length), 3: types.map((t) => t === 2 ? 1 : 0) });
      let names = [], types = [];
      const run = (async () => {
        names = []; types = [];
        await walk(String(basePath), '', names, types);
        return wantTypes ? grouped() : names;
      })();
      if (req === kUsePromises) return run;
      if (isReq(req)) {
        completeAsync(() => run.then((r) => req.oncomplete.call(req, null, r), (e) => req.oncomplete.call(req, e)));
        return;
      }
      // sync variant
      names = []; types = [];
      const stack = [[String(basePath), '']];
      while (stack.length) {
        const [dir, prefix] = stack.shift();
        for (const e of readdirAllSync(dir)) {
          const rel = prefix ? prefix + '/' + e.name : e.name;
          names.push(nm(rel)); types.push(e.kind);
          if (e.kind === 2) stack.push([dir + '/' + e.name, rel]);
        }
      }
      return wantTypes ? grouped() : names;
    },
    ftruncate(fd, len, req) {
      if (req === kUsePromises) return asyncOp(OP.FTRUNCATE, BigInt(fd), BigInt(len)).then(() => undefined);
      if (isReq(req)) {
        completeAsync(() => asyncOp(OP.FTRUNCATE, BigInt(fd), BigInt(len)).then(() => req.oncomplete.call(req, null), (e) => req.oncomplete.call(req, e)));
        return;
      }
      const res = syncOp(OP.FTRUNCATE, BigInt(fd), BigInt(len));
      if (res.status !== 0) uvThrow(res.status, 'ftruncate');
    },

    // ---- exists / access / module stat ----------------------------------------
    existsSync(path) {
      const res = syncOp(OP.STAT, 0n, 0n, 0n, enc.encode(String(path)));
      return res.status === 0;
    },
    access(path, mode, req) {
      // v1 VFS has no permission enforcement (perm bits stored, never
      // checked) — access composes to an existence probe, POSIX F_OK shape.
      const doIt = () => syncOp(OP.STAT, 0n, 0n, 0n, enc.encode(String(path)));
      if (req === kUsePromises) return doIt().status === 0 ? Promise.resolve() : Promise.reject(makeErr(UV.UV_ENOENT, 'access', path));
      if (isReq(req)) {
        completeAsync(() => {
          const r = doIt();
          if (r.status === 0) req.oncomplete.call(req, null);
          else req.oncomplete.call(req, makeErr(r.status, 'access', path));
        });
        return;
      }
      const r = doIt();
      if (r.status !== 0) uvThrow(r.status, 'access', path);
    },
    internalModuleStat(path) {
      const res = syncOp(OP.STAT, 0n, 0n, 0n, enc.encode(String(path)));
      if (res.status !== 0) return res.status;
      const mode = new Float64Array(res.payload.buffer, res.payload.byteOffset, 18)[1];
      return (mode & 0xF000) === 0x4000 ? 1 : 0; // S_IFDIR : file
    },

    // ---- composed ops -----------------------------------------------------------
    copyFile(src, dest, mode, req) {
      const run = (async () => {
        const bytes = await (async () => {
          const res = await asyncOp(OP.OPEN, BigInt(O.RDONLY), 0n, 0n, enc.encode(String(src)));
          const fd = new DataView(res.payload.buffer, res.payload.byteOffset, 4).getUint32(0, true);
          try {
            const st = await asyncOp(OP.FSTAT, BigInt(fd));
            const size = Number(new Float64Array(st.payload.buffer, st.payload.byteOffset, 18)[8]);
            const out = new Uint8Array(size);
            let off = 0;
            while (off < size) {
              const want = Math.min(size - off, READ_CHUNK);
              const r = await asyncOp(OP.READ, BigInt(fd), BigInt(want), BigInt(off));
              if (r.len === 0) break;
              out.set(r.payload.subarray(0, r.len), off);
              off += r.len;
            }
            return out.subarray(0, off);
          } finally {
            await asyncOp(OP.CLOSE, BigInt(fd));
          }
        })();
        const flags = O.WRONLY | O.CREAT | O.TRUNC | ((mode & 1) ? O.EXCL : 0); // COPYFILE_EXCL
        const res = await asyncOp(OP.OPEN, BigInt(flags), 0o666n, 0n, enc.encode(String(dest)));
        const fd = new DataView(res.payload.buffer, res.payload.byteOffset, 4).getUint32(0, true);
        try {
          let off = 0;
          while (off < bytes.length) {
            const chunk = bytes.subarray(off, Math.min(off + WRITE_CHUNK, bytes.length));
            await asyncOp(OP.WRITE, BigInt(fd), -1n, 0n, chunk);
            off += chunk.length;
          }
        } finally {
          await asyncOp(OP.CLOSE, BigInt(fd));
        }
      })();
      if (req === kUsePromises) return run;
      if (isReq(req)) {
        completeAsync(() => run.then(() => req.oncomplete.call(req, null), (e) => req.oncomplete.call(req, e)));
        return;
      }
      // sync copy (COPYFILE_EXCL honored — AV-R6)
      const bytes = readWholeFileSync(src);
      seedFileKernel(dest, bytes, O.WRONLY | O.CREAT | O.TRUNC | ((mode & 1) ? O.EXCL : 0));
    },
    rmSync(path, maxRetries, recursive) {
      const st = syncOp(OP.LSTAT, 0n, 0n, 0n, enc.encode(String(path)));
      if (st.status === UV.UV_ENOENT) return;
      if (st.status !== 0) uvThrow(st.status, 'rm', path);
      const mode = new Float64Array(st.payload.buffer, st.payload.byteOffset, 18)[1];
      if ((mode & 0xF000) === 0x4000) {
        if (recursive) {
          for (const e of readdirAllSync(path)) {
            this.rmSync(path + '/' + e.name, 0, recursive);
          }
        }
        const r = syncOp(OP.RMDIR, 0n, 0n, 0n, enc.encode(path));
        if (r.status !== 0) uvThrow(r.status, 'rmdir', path);
      } else {
        const r = syncOp(OP.UNLINK, 0n, 0n, 0n, enc.encode(path));
        if (r.status !== 0) uvThrow(r.status, 'unlink', path);
      }
    },
    mkdtemp(prefix, encoding, req) {
      const tryOnce = () => {
        const suffix = Math.random().toString(36).slice(2, 10);
        const dir = String(prefix) + suffix;
        const r = syncOp(OP.MKDIR, 0o700n, 0n, 0n, platformTextEncoder.encode(dir));
        return { dir, r };
      };
      if (req === kUsePromises || isReq(req)) {
        const run = (async () => {
          for (;;) {
            const { dir, r } = tryOnce();
            if (r.status === 0) return dir;
            if (r.status !== UV.UV_EEXIST) uvThrow(r.status, 'mkdtemp', dir);
          }
        })();
        if (req === kUsePromises) return run;
        completeAsync(() => run.then((d) => req.oncomplete.call(req, null, d), (e) => req.oncomplete.call(req, e)));
        return;
      }
      for (;;) {
        const { dir, r } = tryOnce();
        if (r.status === 0) return dir;
        if (r.status !== UV.UV_EEXIST) uvThrow(r.status, 'mkdtemp', dir);
      }
    },

    // ---- honest ENOSYS surface (no kernel op in v1.0.2) --------------------------
    accessSync(path, mode) { return this.access(path, mode); },
    // P2-006-008: chmod/fchmod/utimes/futimes/link/symlink/readlink ALL have
    // REAL implementations above (ABI v1.0.3 ops + honest fd-variant ENOSYS)
    // — the notImpl entries that used to sit here SHADOWED them (later keys
    // win in object literals); caught live by npx bin-linking (symlink) and
    // libnpmexec's with-lock touchLock (utimes → ECOMPROMISED).
    // R-FSYNC FIX: the VFS is memory-only, so there is nothing to flush to a
    // disk — fsync/fdatasync succeed as no-ops (tmpfs returns 0 the same way).
    // The old honest-ENOSYS broke every write-file-atomic 8.x user: its
    // writeFileSync/writeFile await fs.fsync unguarded, so bin-links'
    // dos2Unix (CRLF hashbang fix) and any dep pulling the module rejected
    // with ENOSYS after the file was already written. Verified live: npm
    // 12's lockfile writes don't use wfa (fsp.writeFile via
    // @npmcli/package-json), but the module IS bundled and reachable.
    // Unknown fd still fails honestly with EBADF (there is no kernel FSYNC
    // op to validate the fd, so consult the fd→path registry).
    fsync(fd, req) { return fsyncNoOp(fd, req, 'fsync'); },
    fdatasync(fd, req) { return fsyncNoOp(fd, req, 'fdatasync'); },
    chown(path, uid, gid, req) { notImpl('chown'); },
    fchown(fd, uid, gid, req) { notImpl('fchown'); },
    lchown(path, uid, gid, req) { notImpl('lchown'); },
    lutimes(path, atime, mtime, req) { notImpl('lutimes'); },
    // R-REALPATH FIX: fs.promises.realpath and realpath(.native) reach the
    // binding, while realpathSync + callback realpath use the pure-JS walk in
    // lib/fs.js — the notImpl here made every promise/native realpath reject
    // with ENOSYS (pnpm 9 dies at startup on exactly that: verified live
    // 2026-11-27). Emulate with the kernel ops that DO exist (LSTAT +
    // READLINK): follow symlinks up to 40 hops (uv__fs__realpath semantics),
    // detect loops via a seen-set, resolve and normalize targets lexically (POSIX rules, join with
    // separators — NOT the host-mirror flattener), complete with the resolved path.
    realpath(path, encoding, req) {
      // POSIX lexical normalize WITH separators (hostCwdResolve is the
      // host-mirror flattener — join('') — and must NOT be used here).
      const rpNorm = (s) => {
        const out = [];
        for (const seg of String(s).split('/')) {
          if (seg === '' || seg === '.') continue;
          if (seg === '..') { out.pop(); continue; }
          out.push(seg);
        }
        return '/' + out.join('/');
      };
      const run = () => {
        let p = String(path);
        if (!p.startsWith('/')) p = rpNorm((hostCwd || '/') + '/' + p);
        const seen = new Set();
        for (;;) {
          if (seen.has(p)) { const e = makeErr(-40, 'realpath', p); e.code = 'ELOOP'; throw e; }
          seen.add(p);
          const st = syncOp(OP.LSTAT, 0n, 0n, 0n, enc.encode(p));
          if (st.status !== 0) uvThrow(st.status, 'realpath', p);
          const mode = Number(statArray(st.payload, false)[1]);
          if ((mode & 0o170000) !== 0o120000) return p; // not a symlink — done
          if (seen.size > 40) { const e = makeErr(-40, 'realpath', p); e.code = 'ELOOP'; throw e; }
          const rl = syncOp(OP.READLINK, 1024n, 0n, 0n, enc.encode(p));
          if (rl.status !== 0) uvThrow(rl.status, 'realpath', p);
          const target = decodeUvPath(rl.payload, encoding);
          p = rpNorm(target.startsWith('/') ? target : p.replace(/[^/]*$/, '') + target);
        }
      };
      if (req === kUsePromises) {
        try { return Promise.resolve(run()); } catch (e) { return Promise.reject(e); }
      }
      if (isReq(req)) {
        completeAsync(() => {
          try { req.oncomplete.call(req, null, run()); }
          catch (e) { req.oncomplete.call(req, e); }
        });
        return;
      }
      return run();
    }, // was: notImpl — realpathSync/callback realpath never reached here (JS walk)
    statfs(path, bigint, req) { notImpl('statfs'); },
    bufferCopy(src, srcStart, srcEnd, dst, dstStart) { notImpl('bufferCopy'); },
    cpSyncCheckPaths() { notImpl('cpSyncCheckPaths'); },
    cpSyncOverrideFile() { notImpl('cpSyncOverrideFile'); },
    cpSyncCopyDir() { notImpl('cpSyncCopyDir'); },
  };
});

// fs_dir — fs.opendir / DirHandle over cookie-batched OP_READDIR.
defBinding('fs_dir', () => {
  const enc = platformTextEncoder;
  function collect(path) {
    const out = [];
    let cookie = 0n;
    for (;;) {
      const res = syncOp(OP.READDIR, cookie, 256n, 16384n, enc.encode(path));
      if (res.status !== 0) uvThrowFsDir(res.status, 'scandir', path);
      const dv = new DataView(res.payload.buffer, res.payload.byteOffset, res.payload.byteLength);
      const count = dv.getUint32(0, true);
      if (count === 0) break;
      cookie = dv.getBigUint64(8, true);
      let cursor = 16;
      for (let i = 0; i < count; i++) {
        const kind = new Uint8Array(res.payload.buffer, res.payload.byteOffset + cursor, 1)[0];
        const nameLen = dv.getUint32(cursor + 4, true);
        const name = utf8Decoder.decode(new Uint8Array(res.payload.buffer, res.payload.byteOffset + cursor + 8, nameLen));
        out.push(name, kind);
        cursor += 8 + ((nameLen + 7) & ~7);
      }
    }
    return out;
  }
  function uvThrowFsDir(errno, syscall, path) {
    const err = new Error(`${errno}: ${syscall} '${path}'`);
    err.errno = errno; err.syscall = syscall; err.path = path;
    throw err;
  }
  class DirHandle {
    constructor(path) {
      this.path = path;
      this.closed = false;
      this.entries = null;
      this.i = 0;
    }
    read(encoding, bufferSize, req) {
      if (req !== undefined && req !== null && typeof req.oncomplete === 'function') {
        completeAsyncFsDir(() => {
          try { req.oncomplete.call(req, null, this.#readImpl(encoding)); }
          catch (e) { req.oncomplete.call(req, e); }
        });
        return;
      }
      return this.#readImpl(encoding);
    }
    #readImpl(encoding) {
      if (this.closed) {
        const err = new Error('Directory handle was closed');
        err.code = 'ERR_DIR_CLOSED';
        throw err;
      }
      if (this.entries === null) this.entries = collect(this.path);
      if (this.i >= this.entries.length) return null;
      const pair = this.entries.slice(this.i, this.i + 2);
      this.i += 2;
      return pair; // [name, UV_DIRENT kind]
    }
    close(req) {
      this.closed = true;
      if (req !== undefined && req !== null && typeof req.oncomplete === 'function') {
        completeAsyncFsDir(() => req.oncomplete.call(req, null));
      }
    }
  }
  function completeAsyncFsDir(fn) {
    asyncFsOutstanding++;
    platformSetTimeout(() => { asyncFsOutstanding--; try { fn(); } catch (e) { platformConsoleError('fs_dir async error', e); } }, 0);
  }
  return {
    opendir(path, encoding, req) {
      if (req !== undefined && req !== null && typeof req.oncomplete === 'function') {
        completeAsyncFsDir(() => {
          try {
            const st = syncOp(OP.STAT, 0n, 0n, 0n, enc.encode(String(path)));
            if (st.status === UV.UV_ENOENT) { req.oncomplete.call(req, null, undefined); return; }
            if (st.status !== 0) { req.oncomplete.call(req, uvThrowFsDirObj(st.status, 'scandir', path)); return; }
            req.oncomplete.call(req, null, new DirHandle(String(path)));
          } catch (e) { req.oncomplete.call(req, e); }
        });
        return;
      }
      const st = syncOp(OP.STAT, 0n, 0n, 0n, enc.encode(String(path)));
      if (st.status === UV.UV_ENOENT) return undefined; // dir.js recursive mode tolerates
      if (st.status !== 0) uvThrowFsDir(st.status, 'scandir', path);
      return new DirHandle(String(path));
    },
    opendirSync(path) {
      const st = syncOp(OP.STAT, 0n, 0n, 0n, enc.encode(String(path)));
      if (st.status !== 0) uvThrowFsDir(st.status, 'scandir', path);
      return new DirHandle(String(path));
    },
  };
  function uvThrowFsDirObj(errno, syscall, path) {
    const err = new Error(`${errno}: ${syscall} '${path}'`);
    err.errno = errno; err.syscall = syscall; err.path = path;
    return err;
  }
});

// OBLIGATION 37 (P1-POC2): 'os' — host OS seam (src/node_os.cc). Called at
// lib/os.js module load: getOSInformation() → [type, version, release,
// machine]. Values are HONEST for the Nodine host (this is not Linux;
// process.platform is 'nodine' — see report divergences): parallelism and
// endianness are real browser/engine values.
defBinding('os', () => {
  const isBigEndianValue = new Uint8Array(new Uint32Array([1]).buffer)[0] === 0;
  function osInfo() {
    return ['Nodine', 'browser', '1.0.0', 'wasm32-browser'];
  }
  return Object.freeze({
    getOSInformation: osInfo,
    getAvailableParallelity: () => __nodineNavCores,
    getAvailableParallelism: () => __nodineNavCores,
    // lib/os.js cpus() consumes the FLAT [model, speed, user, nice, sys,
    // idle, irq] × N shape. Count is the real browser-observed parallelism;
    // per-CPU model/speed/times are not observable from a worker (model is
    // labeled honestly, speed 0 = unknown, times 0 — same discipline as
    // getFreeMem/getLoadAvg). The yarn shell's dep graph calls os.cpus() at
    // module scope.
    getCPUs: () => {
      const n = __nodineNavCores;
      const out = new Array(n * 7);
      for (let i = 0; i < n; i++) {
        const b = i * 7;
        out[b] = 'Nodine Browser Worker (wasm32)';
        out[b + 1] = 0; out[b + 2] = 0; out[b + 3] = 0; out[b + 4] = 0; out[b + 5] = 0; out[b + 6] = 0;
      }
      return out;
    },
    getFreeMem: () => 0,                       // not observable in a worker (documented)
    getTotalMem: () => __nodineNavMem * 1024 * 1024 * 1024,
    getHomeDirectory: () => '/home/user',
    getHostname: () => 'nodine',
    getInterfaceAddresses: () => [],
    getLoadAvg: () => [0, 0, 0],
    getPriority: (pid, ctx) => { if (ctx) ctx.errno = 0; return 0; },
    setPriority: (pid, priority, ctx) => { if (ctx) ctx.errno = 0; return 0; },
    getUserInfo: () => ({ uid: 0, gid: 0, username: 'user', homedir: '/home/user', shell: '/bin/sh' }),
    getUptime: () => Math.floor((globalThis.performance?.now?.() || 0) / 1000),
    isBigEndian: () => isBigEndianValue,
  });
});


// P2-006-008: 'signal_wrap' — process.on('SIGINT', …) reaches here via
// internal/process/signal.js startListeningIfSignal (the yarn shell
// registers SIGINT/SIGTERM handlers around every spawned command). Signals
// in Nodine are DELIVERED by the supervisor channel ('signal' messages →
// raiseProcessSignal → process.emit), so the binding only registers
// interest: start() reports success, close/unref are no-ops, and onsignal
// is never fired from here (the channel path emits directly).
defBinding('signal_wrap', () => {
  class Signal {
    constructor() { this.onsignal = null; }
    start(signum) { this.signum = signum; return 0; }
    stop() {}
    close() {}
    ref() {}
    unref() {}
    hasRef() { return false; }
  }
  return Object.freeze({ Signal });
});

defBinding('fs_event_wrap', () => {
  // B12 POLLING FSEvent: fs.watch(dir) — Metro watches the project tree.
  // The old stub returned UV_ENOSYS from start(), which Node's watchers.js
  // turned into a thrown UVException, which killed expo start as an
  // unhandled rejection (observed live: 'ENOSYS: function not implemented,
  // watch /home/user/demo/ax7'). Poll the directory: readdir + stat each
  // entry (name → {mtimeMs, size, mode}); on diff, fire
  // onchange(0, 'rename'|'change', filename) per libuv semantics. Cost is
  // one OP_READDIR + N stats per tick (500 ms default) — trivial for a
  // dev-server project tree in the kernel VFS.
  class FSEvent {
    constructor() { this.owner = undefined; this.onchange = null; this.initialized = false; this._timer = null; }
    start(path, persistent, recursive, encoding) {
      const self = this;
      const dir = String(path);
      const snapshot = () => {
        const out = new Map(); // name -> key string
        try {
          const res = syncOp(OP.READDIR, 0n, 256n, 16384n, platformTextEncoder.encode(dir));
          if (res.status !== 0 || !res.payload) return out;
          const txt = platformDecoders.strip.decode(res.payload);
          // cookie-batched OP_READDIR walk → JSON array [{name, kind}]
          let entries = null;
          try { entries = JSON.parse(txt); } catch { return out; }
          if (!Array.isArray(entries)) return out;
          for (const e of entries) {
            const name = e && e.name;
            if (typeof name !== 'string') continue;
            let key = e.kind || '?';
            try {
              const st = syncOp(OP.STAT, 0n, 0n, 0n, platformTextEncoder.encode(dir + '/' + name));
              if (st.status === 0 && st.payload && st.payload.byteLength >= 144) {
                const f = new Float64Array(st.payload.buffer, st.payload.byteOffset, 18);
                key = (f[1] || 0) + ':' + (f[8] || 0) + ':' + (f[10] || 0) + ':' + (f[13] || 0);
              }
            } catch {}
            out.set(name, key);
          }
        } catch {}
        return out;
      };
      let prev = null;
      const tick = () => {
        const cur = snapshot();
        if (prev !== null) {
          for (const [name, key] of cur) {
            if (!prev.has(name)) { self.onchange && self.onchange(0, 'rename', name); return; }
            if (prev.get(name) !== key) { self.onchange && self.onchange(0, 'change', name); return; }
          }
          for (const name of prev.keys()) {
            if (!cur.has(name)) { self.onchange && self.onchange(0, 'rename', name); return; }
          }
        }
        prev = cur;
      };
      prev = snapshot(); // baseline — no events for the initial state
      this.initialized = true;
      this._timer = engineSetInterval(tick, 500);
      return 0; // success
    }
    close() {
      this.initialized = false;
      if (this._timer !== null) { engineClearInterval(this._timer); this._timer = null; }
      return 0;
    }
    ref() {}
    unref() {}
    hasRef() { return false; }
  }
  return Object.freeze({ FSEvent });
});

// OBLIGATION 28: 'permission' — default all-allowed (matches default Node).
defBinding('permission', () => Object.freeze({
  isPermissionEnabled: () => false,
  isEnabled: () => false,
  getFlags: () => [],
  has: () => false,
  report: () => undefined,
}));

// OBLIGATION 29: 'modules' (node_modules.cc:689-756) — REAL VFS-backed
// implementations of the package.json fast-paths the CJS/ESM loaders need.
function readWholeFileSyncKernel(path) {
  const fdRes = syncOp(OP.OPEN, 0n /* RDONLY */, 0n, 0n, platformTextEncoder.encode(path));
  if (fdRes.status !== 0) throw new Error('open ' + path + ' -> ' + fdRes.status);
  const fd = new DataView(fdRes.payload.buffer, fdRes.payload.byteOffset, 4).getUint32(0, true);
  try {
    const st = syncOp(OP.FSTAT, BigInt(fd));
    if (st.status !== 0) throw new Error('fstat ' + path);
    const size = Number(new Float64Array(st.payload.buffer, st.payload.byteOffset, 18)[8]);
    const out = new Uint8Array(size);
    let off = 0;
    while (off < size) {
      const want = Math.min(size - off, 262080);
      const r = syncOp(OP.READ, BigInt(fd), BigInt(want), BigInt(off));
      if (r.status !== 0) throw new Error('read ' + path);
      if (r.len === 0) break;
      out.set(r.payload.subarray(0, r.len), off);
      off += r.len;
    }
    return out.subarray(0, off);
  } finally {
    syncOp(OP.CLOSE, BigInt(fd));
  }
}
// P2-006-008: package-scope walk for the ESM loader (package_json_reader.js
// getPackageType/getPackageScopeConfig). URL strings arrive percent-encoded
// (%40npmcli); the kernel VFS stores decoded paths. Walk up from the module
// URL's directory; a node_modules basename is the scope boundary (matches
// Node's readPackageScope semantics).
function nodineUrlToPath(u) {
  let s = String(u);
  try {
    if (s.startsWith('file://')) {
      const parsed = new URL(s);
      s = decodeURIComponent(parsed.pathname);
    }
  } catch {}
  return s;
}
function packageScopeWalk(urlOrPath, wantSerialized) {
  let dir = nodineUrlToPath(urlOrPath);
  if (dir.endsWith('/')) dir = dir.slice(0, -1);
  const lastSlash = dir.lastIndexOf('/');
  if (lastSlash >= 0) dir = dir.slice(0, lastSlash); // dirname of the module URL
  let firstCandidate = dir + '/package.json';
  for (let guard = 0; guard < 128; guard++) {
    const base = dir.slice(dir.lastIndexOf('/') + 1);
    if (base === 'node_modules') break; // scope boundary
    const pj = dir + '/package.json';
    const serialized = serializePackageJSON(pj);
    if (serialized !== undefined) return wantSerialized ? serialized : (serialized[2] ?? 'none');
    if (dir === '' || dir.lastIndexOf('/') <= 0) {
      if (dir !== '' && dir !== '/') {
        // last candidate: /package.json
        const s2 = serializePackageJSON('/package.json');
        if (s2 !== undefined) return wantSerialized ? s2 : (s2[2] ?? 'none');
      }
      break;
    }
    dir = dir.slice(0, dir.lastIndexOf('/'));
  }
  return wantSerialized ? undefined : 'none';
}


function serializePackageJSON(jsonPath) {
  // Kernel-authoritative read (OP_OPEN/READ/CLOSE); missing/invalid -> undefined.
  // P2-006-008: the ESM resolver passes URL strings (file:///a/b%40c) — the
  // kernel VFS stores decoded paths.
  let bytes;
  try { bytes = readWholeFileSyncKernel(nodineUrlToPath(jsonPath)); } catch { return undefined; }
  if (!bytes || bytes.length === 0) return undefined;
  let parsed;
  try { parsed = JSON.parse(utf8Decoder.decode(bytes)); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const name = typeof parsed.name === 'string' ? parsed.name : null;
  const main = typeof parsed.main === 'string' ? parsed.main : null;
  const type = parsed.type === 'module' ? 'module' : parsed.type === 'commonjs' ? 'commonjs' : 'none'; // native node_module.cc: 'none' for typeless (deserialize omits null → breaks format detection)
  const plain = (v) => v === undefined ? null : (typeof v === 'string' ? v : JSON.stringify(v));
  return [name, main, type, plain(parsed.imports), plain(parsed.exports), jsonPath];
}
function nearestParentPackageJSON(checkPath) {
  let dir = String(checkPath);
  for (;;) {
    const serialized = serializePackageJSON(dir === '/' ? '/package.json' : dir + '/package.json');
    if (serialized !== undefined) return serialized;
    if (dir === '/') return undefined;
    const idx = dir.lastIndexOf('/');
    dir = idx <= 0 ? '/' : dir.slice(0, idx);
  }
}

defBinding('modules', () => Object.freeze({
  moduleFormats: Object.freeze({ kCommonJS: 0, kModule: 1, kWasm: 2, kJson: 3 }),
  packageJsonReader: {
    read() { return [false, undefined]; },
  },
  // Serialized form (package_json_reader.js deserializePackageJSON):
  // [name, main, type, plainImports, plainExports, optionalFilePath] | undefined
  readPackageJSON(jsonPath, isESM, base, specifier) {
    return serializePackageJSON(jsonPath);
  },
  getNearestParentPackageJSON(checkPath) {
    return nearestParentPackageJSON(checkPath);
  },
  getNearestParentPackageJSONType(checkPath) {
    const serialized = nearestParentPackageJSON(checkPath);
    if (serialized === undefined) return undefined;
    return serialized[2] ?? 'none';
  },
  // P2-006-008: real implementations (was: hardcoded no-scope stubs — the
  // root cause of "type":"module" packages being CJS-translated).
  getPackageScopeConfig(urlString) {
    const serialized = packageScopeWalk(urlString, true);
    if (serialized !== undefined) return serialized;
    // no scope found: return the candidate pjsonPath (exists:false contract)
    let dir = nodineUrlToPath(urlString);
    if (dir.endsWith('/')) dir = dir.slice(0, -1);
    dir = dir.slice(0, dir.lastIndexOf('/'));
    return dir + '/package.json';
  },
  getPackageType(urlString) { return packageScopeWalk(urlString, false); },
  // compile_cache.h:21-24 CACHED_CODE_TYPES — cache disabled (entries undefined)
  cachedCodeTypes: Object.freeze({ kCommonJS: 0, kESM: 1, kStrippedTypeScript: 2 }),
  enableCompileCache: () => 1,
  getCompileCacheDir: () => undefined,
  compileCacheStatus: () => 0,
  flushCompileCache() {},
  getCompileCacheEntry: () => undefined,
  saveCompileCacheEntry() {},
  stripTypeScriptTypes() { throw new Error('amaro strip-types: host provides TS stripper or disables'); },
}));

// OBLIGATION 30: 'wasm_web_api' + 'worker'.
defBinding('wasm_web_api', () => {
  const state = {};
  return Object.freeze({
    setImplementation(fn) { state.impl = fn; },
  });
});
defBinding('worker', () => Object.freeze({
  get isMainThread() { return true; },
  getThreadId() { return 1; },
  getWorkerId() { return 0; },
  threadId: 1,
  markAsUnserialable() {},
  updateErrorMessage() {},
}));

// OBLIGATION 16: 'string_decoder'.
defBinding('string_decoder', () => {
  // P2-006-007: a REAL decoder — string_decoder.js reads the layout
  // constants + decode/flush from the binding and allocates the native
  // decoder as a Buffer of kSize. Layout (ours, self-consistent):
  //   [0..23] scratch (unused by the JS path) | [24] missing | [25] buffered
  //   | [26] encoding field. Incremental decoding rides TextDecoder
  //   {stream:true} (native, exact); buffered/missing counts are computed
  //   lexically to drive end()'s flush decision (over-count is harmless —
  //   flush() of nothing returns ''; under-count would drop tails, so the
  //   scanner errs permissive).
  const kIncompleteCharactersStart = 0, kIncompleteCharactersEnd = 24;
  const kMissingBytes = 24, kBufferedBytes = 25, kEncodingField = 26, kSize = 32;
  const aux = new WeakMap(); // decoder Buffer -> { td: TextDecoder, enc: number }
  const ENCODINGS = ['utf-8', 'utf-16le', 'latin1', 'ascii', 'base64', 'base64url', 'hex'];
  function stateOf(dec) {
    let st = aux.get(dec);
    if (!st) {
      const enc = dec[kEncodingField] & 7;
      const name = ENCODINGS[enc] || 'utf-8';
      st = { td: new TextDecoder(name), enc, name };
      aux.set(dec, st);
    }
    return st;
  }
  function trailingIncomplete(enc, buf) {
    // utf-8: count the trailing partial sequence; utf-16le: odd byte; others: 0.
    if (enc === 0) {
      let n = 0;
      for (let i = buf.length - 1; i >= 0 && n < 4; i--) {
        const b = buf[i];
        if (b < 0x80) break;
        if ((b & 0xC0) === 0x80) { n++; continue; }
        // lead byte: complete only if enough continuations followed
        const need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 0;
        if (need === 0) break; // stray continuation treated as complete
        if (buf.length - i >= need) break; // complete sequence
        n++; // lead byte itself is part of the pending tail
        return Math.min(n + 0, 3) + 0 === 0 ? n : n; // keep count = bytes in tail
      }
      return n;
    }
    if (enc === 1) return buf.length & 1;
    return 0;
  }
  function decode(dec, buf) {
    const st = stateOf(dec);
    if (!buf || buf.length === 0) return '';
    if (st.enc === 7) return buf; // 'buffer' encoding: identity
    const out = st.td.decode(buf, { stream: true });
    dec[kBufferedBytes] = trailingIncomplete(st.enc, buf);
    dec[kMissingBytes] = 0;
    return out;
  }
  function flush(dec) {
    const st = stateOf(dec);
    const out = st.td.decode(); // finish the stream
    st.td = new TextDecoder(st.name); // reusable decoder (Node semantics)
    dec[kBufferedBytes] = 0;
    dec[kMissingBytes] = 0;
    return out;
  }
  return Object.freeze({
    kIncompleteCharactersStart, kIncompleteCharactersEnd, kMissingBytes,
    kBufferedBytes, kEncodingField, kSize, decode, flush,
    encodings: Object.freeze({
      'utf8': 0, 'ucs2': 1, 'utf16le': 1, 'latin1': 2, 'ascii': 3,
      'base64': 4, 'base64url': 5, 'hex': 6, 'buffer': 7,
    }),
  });
});

// OBLIGATION 33: 'sea' — only needed for the embedding.js entry; reports "not SEA".
defBinding('sea', () => Object.freeze({
  isSea: () => false,
  isVfsEnabled: () => false,
  mainCodePath: undefined,
}));

// 'cjs_lexer' (node_cjs_lexer.cc, the merve CJS lexer) — discovered by this
// PoC: internal/modules/esm/translators.js:65 destructures `parse` at module
// init. parse(source) -> [Set<exportName>, Array<reexportSpecifier>]. Real
// (regex-based) analysis of the source's CJS export statements — a full lexer
// is bridge work; module-load behavior verified for the common shapes.
defBinding('cjs_lexer', () => ({
  parse(source) {
    if (source == null) return [new Set(), []];
    const src = String(source);
    const exports = new Set();
    const reexports = [];
    // exports.foo = / exports['foo'] = / module.exports.foo =
    for (const m of src.matchAll(/(?:module\.)?exports(?:\[(['"])([^'"]+)\1|\.([A-Za-z_$][\w$]*))\s*=/g)) {
      exports.add(m[2] ?? m[3]);
    }
    // Object.defineProperty(exports, 'foo', ...)
    for (const m of src.matchAll(/Object\.defineProperty\(\s*exports\s*,\s*(['"])([^'"]+)\1/g)) {
      exports.add(m[2]);
    }
    // module.exports = require('x') — reexport
    for (const m of src.matchAll(/module\.exports\s*=\s*require\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      reexports.push(m[2]);
      exports.add('default');
    }
    if (/module\.exports\s*=/.test(src)) exports.add('default');
    // P2-006-008: TypeScript re-export idioms (cjs-module-lexer parity).
    // __exportStar(require('x'), exports) — reexport every name of x
    for (const m of src.matchAll(/__exportStar\(\s*require\(\s*(['"])([^'"]+)\1\s*\)\s*,\s*exports\s*\)/g)) {
      reexports.push(m[2]);
    }
    // __createBinding(exports, require('x'), 'Name') / (exports, m, 'Name')
    for (const m of src.matchAll(/__createBinding\(\s*exports\s*,\s*(?:require\(\s*(['"])([^'"]+)\1\s*\)|[\w$]+)\s*,\s*(['"])([^'"]+)\3/g)) {
      exports.add(m[4]);
    }
    // Object.defineProperty(exports, "Name", { get: function () { return require('x').Name; } }) — named reexport
    for (const m of src.matchAll(/Object\.defineProperty\(\s*exports\s*,\s*(['"])([^'"]+)\1\s*,\s*\{[^}]*?require\(\s*(['"])([^'"]+)\3\s*\)/g)) {
      exports.add(m[2]);
    }
    return [exports, reexports];
  },
}));

// 'blob' (node_blob.cc) — discovered by this PoC: bootstrap/web/exposed-wildcard
// lazily exposes Blob/File, but internal/blob.js destructures the binding at
// module-init (blob.js:23-29). Real in-memory implementation over Uint8Array
// with the handle protocol blob.js uses (slice/getReader with synchronous
// pull callbacks for memory-resident data).
defBinding('blob', () => {
  class BlobHandle {
    constructor(data, type) { this.data = data; this.type = type || ''; }
    get length() { return this.data.length; }
    slice(start, end) {
      const s = Math.max(0, Math.min(start, this.data.length));
      const e = Math.max(0, Math.min(end ?? this.data.length, this.data.length));
      return new BlobHandle(this.data.slice(s, e), this.type);
    }
    getType() { return this.type; }
    getReader() {
      let offset = 0;
      const data = this.data;
      return {
        pull(cb) {
          if (offset >= data.length) { cb(0, undefined); return; }
          const chunk = data.slice(offset, offset + 65536);
          offset += chunk.length;
          cb(1, chunk.buffer);
        },
      };
    }
  }
  const dataObjectRegistry = new Map();
  function createBlob(sources, length) {
    // sources: array of {data:ArrayBuffer|Uint8Array|string-ish, ...} per
    // blob.js normalizeSourceObject — handle the types it passes through.
    let total = 0;
    const parts = [];
    for (const src of sources) {
      let bytes;
      if (src instanceof Uint8Array) bytes = src;
      else if (src instanceof ArrayBuffer) bytes = new Uint8Array(src);
      else if (typeof src === 'string') bytes = new TextEncoder().encode(src);
      else if (src && typeof src === 'object' && typeof src.byteLength === 'number') bytes = new Uint8Array(src.buffer ?? src, src.byteOffset ?? 0, src.byteLength);
      else bytes = new Uint8Array(0);
      parts.push(bytes);
      total += bytes.length;
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { merged.set(p, off); off += p.length; }
    return new BlobHandle(merged, '');
  }
  return {
    createBlob,
    createBlobFromFilePath(path) {
      const node = vfsLookup(path);
      if (!node || node.kind !== 'file') return undefined;
      return [new BlobHandle(node.data, ''), node.data.length];
    },
    storeDataObject(id, obj) { dataObjectRegistry.set(id, obj); },
    getDataObject(id) { return dataObjectRegistry.get(id); },
    kMaxLength: 0x7fffffff,
  };
});

// ---------------------------------------------------------------------------
// 4. Chain driver — evaluate the chain exactly as C++ does
//    (api/environment.cc:1059-1085, node_realm.cc:329-356, node_builtins.cc:487-547).
// ---------------------------------------------------------------------------
const PER_CONTEXT_PARAMS = ['exports', 'primordials', 'privateSymbols', 'perIsolateSymbols'];
const BOOTSTRAP_PARAMS = ['process', 'require', 'internalBinding', 'primordials'];
const REALM_PARAMS = ['process', 'getLinkedBinding', 'getInternalBinding', 'primordials'];

function compileAndCall(id, params, args) {
  const fn = new Function(...params, readSource(id));
  return fn(...args);
}

const perContextExports = {};
const primordials = {};

const stageTimings = [];
function stage(name, fn) {
  const t0 = nowMs();
  try {
    const detail = fn();
    const ms = +(nowMs() - t0).toFixed(1);
    stageTimings.push({ name, ms, ok: true });
    report({ type: 'stage', name, ms, detail: String(detail) });
    return true;
  } catch (err) {
    const ms = +(nowMs() - t0).toFixed(1);
    stageTimings.push({ name, ms, ok: false });
    report({ type: 'stage', name, ms, ok: false, error: String(err?.stack || err) });
    platformConsoleError(`STAGE FAILED: ${name}: ${err?.stack || err}`);
    throw err;
  }
}


// ===========================================================================
// P2-006-007 Round 4 — bridge builtins (child_process / http / https / zlib
// / crypto) + module-load stubs for net/tls/dns/tty/v8-class internals.
// Layering (documented divergence, ADR-0004/0006): the BROWSER-NATIVE
// binding layer provides these modules with Node's public API; everything
// else remains the verbatim vendored core. zlib rides pako (sync, upstream),
// hashes ride @noble/hashes + js-md5 (upstream), http/https ride fetch
// (redirect:'follow' — 3xx never surfaces; documented), child_process rides
// the supervisor process RPC (real workers, real endpoints, real exit codes).
// ===========================================================================
// B4 latency: these five were SEQUENTIAL top-level awaits — each import
// waited for the previous one's fetch+parse+eval before starting its own
// (measured as a large share of per-spawn worker bring-up). Parallelize:
// all five module loads start in the same microtask; jsmd5 must still be
// awaited before MD5FN is captured (UMD attaches globalThis.md5 on eval).
const [PAKO, NOBLE_sha1, NOBLE_sha256, NOBLE_sha512] = await Promise.all([
  import(urlUnder('unpkg/pako/package/dist/pako.esm.mjs')),
  import(urlUnder('unpkg/noble/package/esm/sha1.js')),
  import(urlUnder('unpkg/noble/package/esm/sha256.js')),
  import(urlUnder('unpkg/noble/package/esm/sha512.js')),
  import(urlUnder('unpkg/jsmd5/package/src/md5.js')), // UMD: attaches self.md5
]);
const NOBLE = { sha1: NOBLE_sha1, sha256: NOBLE_sha256, sha512: NOBLE_sha512 };
const MD5FN = globalThis.md5;

// ---- module-load stubs (net/tls/dns/tty/etc. must be requirable) --------
// P2-007/B1: TCP/Pipe carries the REAL net.Server surface (bind/bind6/
// listen/close + backlog/error events, node_tcp_wrap.cc semantics at the
// JS-visible level: numeric errno returns, 0 = success). Upstream net.js
// drives these handles DIRECTLY (createServerHandle → handle.bind6(host,
// port, flags) → listen(backlog)) whenever a JS lib builds its own
// net.Server — expo's choosePortAsync is the observed case (TypeError:
// handle.bind6 is not a function killed `npm start`). "Binding" here just
// records the endpoint: it must succeed with 0 so net.js proceeds, but it
// must NEVER surface a listening socket that nothing serves — the SW
// preview bridge only handles servers created through node:http. The
// handle's listen() is armed, and connections are dropped (accepted-then-
// destroyed) via the no-op onconnection; a bind error surfaces as
// listenInCluster's normal errno path (UV_EADDRINUSE etc. are never faked).
class BridgeTCPHandle {
  constructor() { this.fd = -1; this._bound = null; this._listening = false; this.onconnection = null; this[perIsolateSymbols.owner_symbol] = undefined; } // M1.7A fix: bare owner_symbol was never in scope — raw net.Server listens crashed with ReferenceError (only http.Server paths had exercised this class)
  bind(host, port) { this._bound = { host: String(host), port: port | 0 }; return 0; }
  bind6(host, port) { this._bound = { host: String(host), port: port | 0 }; return 0; }
  listen(backlog) { this._listening = true; return 0; }
  close() { this._listening = false; this._bound = null; return 0; }
  ref() { return this; } unref() { return this; }
  setNoDelay() { return this; } setKeepAlive() { return this; }
  reset() {}
  getsockname(out) { if (this._bound) { out.port = this._bound.port; out.family = this._bound.host.includes(':') ? 'IPv6' : 'IPv4'; out.address = this._bound.host; } return 0; }
  onread() {} // no bytes ever arrive: connections are never accepted
}
class BridgePipeHandle {
  constructor() { this.fd = -1; this._bound = null; this._listening = false; this.onconnection = null; }
  bind(name) { this._bound = String(name); return 0; }
  listen(backlog) { this._listening = true; return 0; }
  close() { this._listening = false; return 0; }
  ref() { return this; } unref() { return this; }
  setNoDelay() { return this; } setKeepAlive() { return this; }
  reset() {}
}
defBinding('tcp_wrap', () => Object.freeze({
  TCP: BridgeTCPHandle,
  TCPConnectWrap: class TCPConnectWrap {},
  constants: Object.freeze({ SOCKET: 0, SERVER: 1, TCP_IPV4ONLY: 0, TCP_IPV6ONLY: 1 }),
}));
defBinding('pipe_wrap', () => Object.freeze({
  Pipe: BridgePipeHandle,
  PipeConnectWrap: class PipeConnectWrap {},
  constants: Object.freeze({ SOCKET: 0, SERVER: 1, IPC: 2 }),
}));
defBinding('udp_wrap', () => Object.freeze({
  UDP: class UDP {}, SendWrap: class SendWrap {},
  UDPRecvWrap: class UDPRecvWrap {},
}));
defBinding('stream_wrap', () => Object.freeze({
  ShutdownWrap: class ShutdownWrap {}, WriteWrap: class WriteWrap {},
  kReadBytesRead: 1, kArrayBufferOffset: 2, kBytesWritten: 3,
  kLastWriteWasAsync: 4,
}));
defBinding('cares_wrap', () => Object.freeze({
  getaddrinfo(req, hostname, family, hints) {
    // DNS through the browser is not synchronous-callable; npm's registry
    // path never resolves manually (fetch handles it). Emit the documented
    // error to the resolver callback instead of faking success.
    const err = new Error('getaddrinfo EAI_AGAIN ' + hostname);
    err.code = 'EAI_AGAIN'; err.errno = -3001;
    if (req && typeof req.oncomplete === 'function') req.oncomplete(err, []);
    return 0;
  },
  queryA() { throw new Error('dns.resolve: unsupported in the browser runtime'); },
  queryAaaa() { throw new Error('dns.resolve: unsupported'); },
  queryTxt() { throw new Error('dns.resolve: unsupported'); },
  GetAddrInfoReqWrap: class {}, QueryReqWrap: class {},
  ChannelWrap: class ChannelWrap { // make-fetch-happen's DNS LRU cache wraps one
    constructor() { this.servers = []; }
    queryA(req, name) { if (req && req.oncomplete) req.oncomplete(null, []); return []; }
    queryAaaa(req, name) { if (req && req.oncomplete) req.oncomplete(null, []); return []; }
    queryCname(req, name) { if (req && req.oncomplete) req.oncomplete(null, []); return []; }
    setServers() {}
    getServers() { return []; }
  },
  ADDRCONFIG: 0, ALL: 1, V4MAPPED: 2,
}));
defBinding('tty_wrap', () => Object.freeze({
  // P2-006-008: stdio devices ARE the interactive terminal (360de23's TTY
  // adaptation) — isatty must report that per fd: a piped fd (per-fd stdio)
  // honestly reports false; an inherit fd is tty-class. create-expo's
  // prompts library uses isatty(0)&&isatty(1) to draw the interactive
  // prompt (a degraded CI path renders a different non-input flow).
  isTTY: (fd) => {
    const arr = globalThis.__nodineStdioArr;
    if (Array.isArray(arr) && fd >= 0 && fd <= 2) return arr[fd] === 'inherit';
    return fd === 0 || fd === 1 || fd === 2;
  },
  UV_TTY_MODE_NORMAL: 0,
  UV_TTY_MODE_RAW_VT: 1,
  UV_TTY_MODE_IO: 2,
  TTY: class TTY {},
}));
defBinding('http_parser', () => Object.freeze({
  HTTPParser: class HTTPParser { execute() { return 0; } finish() { return 0; } reinitialize() {} pause() {} resume() {} },
  methods: ['DELETE','GET','HEAD','POST','PUT','CONNECT','OPTIONS','TRACE','COPY','LOCK','MKCOL','MOVE','PROPFIND','PROPPATCH','SEARCH','UNLOCK','BIND','REBIND','UNBIND','ACL','REPORT','MKACTIVITY','CHECKOUT','MERGE','PATCH','NOTIFY','SUBSCRIBE','UNSUBSCRIBE','PURGE','MKCALENDAR','LINK','UNLINK','SOURCE'],
  REQUEST: 1, RESPONSE: 2,
}));
defBinding('process_wrap', () => Object.freeze({
  Process: class Process { spawn() { throw new Error('process_wrap: child_process is bridge-provided'); } kill() {} close() {} },
}));
defBinding('spawn_sync', () => Object.freeze({
  spawn(options) { const e = new Error('spawn_sync: bridge-provided (child_process)'); e.errno = 38; throw e; },
}));
defBinding('heap_utils', () => Object.freeze({
  getHeapStatistics(out) {
    const st = globalThis.performance?.measureUserAgentSpecificMemory
      ? { heap_size_limit: 2 * 1024 * 1024 * 1024, total_heap_size: 64 * 1024 * 1024, used_heap_size: 16 * 1024 * 1024 }
      : { heap_size_limit: 2 * 1024 * 1024 * 1024, total_heap_size: 64 * 1024 * 1024, used_heap_size: 16 * 1024 * 1024 };
    if (out && typeof out === 'object') { let i = 0; for (const k of Object.keys(st)) out[i++] = st[k]; }
    return st;
  },
  getHeapCodeStatistics() { return {}; },
  getHeapSnapshot() { throw new Error('heap snapshot unsupported'); },
}));
defBinding('profiler', () => Object.freeze({
  startProfiles() {}, stopProfiles() {}, setIdle() {}, getProfiles() { return []; },
}));
defBinding('serdes', () => {
  // B12 REAL SERIALIZER: v8.serialize/deserialize back Metro's cache (and
  // every structuredClone-shaped cache in the npm tree). The old empty-class
  // stub made DefaultSerializer's constructor throw
  // '_setTreatArrayBufferViewsAsHostObjects is not a function' the moment
  // Metro's DiskCacheManager wrote its first snapshot (observed live: expo
  // start → [metro-file-map] Cache write error). This implementation frames
  // a payload as [magic u32][version u32][json bytes] and exposes the
  // ValueSerializer method surface v8.js drives: writeHeader/writeValue/
  // releaseBuffer + the _set* knobs (recording intent) and the uint32/raw
  // primitives DefaultSerializer's _writeHostObject uses. Values are JSON
  // encoded with bigint/typed-array replacers — sufficient for Metro's
  // plain-object + string cache payloads; Functions/symbols fail at WRITE
  // time with the DataCloneError v8 would raise.
  const MAGIC = 0x43415241; // 'CARA'
  const VERS = 1;
  class SerDesError extends Error { constructor(msg) { super(msg); this.name = 'DataCloneError'; } }
  class Serializer {
    constructor() {
      this._chunks = [];
      this._abViewsAsHost = false;
      this._cloneFn = null;
    }
    _setTreatArrayBufferViewsAsHostObjects(v) { this._abViewsAsHost = !!v; }
    _setCloneFunctions(fn) { this._cloneFn = fn; }
    _getDataCloneError(msg) { return new SerDesError(msg); }
    writeHeader() {
      this._u32(MAGIC); this._u32(VERS);
    }
    writeValue(value) {
      let payload;
      try {
        payload = platformTextEncoder.encode(JSON.stringify(value, (k, v) => {
          if (typeof v === 'bigint') return { __nodineBigInt: v.toString() };
          if (v instanceof Uint8Array) return { __nodineU8: Array.from(v) };
          if (v != null && typeof v === 'object' && !(v instanceof Array) && v.buffer instanceof ArrayBuffer && v.constructor && v.constructor.name && v.constructor.name !== 'Object') {
            return { __nodineU8: Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
          }
          return v;
        }));
      } catch (e) { throw this._getDataCloneError(String((e && e.message) || e)); }
      this._u32(payload.length);
      this._chunks.push(payload);
    }
    writeUint32(v) { this._u32(v >>> 0); }
    writeDouble(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, +v, true); this._chunks.push(b); }
    writeRawBytes(bytes) { this._chunks.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
    writeUint64(hi, lo) { this._u32(hi >>> 0); this._u32(lo >>> 0); }
    _u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this._chunks.push(b); }
    releaseBuffer() {
      let len = 0; for (const c of this._chunks) len += c.length;
      const out = new Uint8Array(len);
      let off = 0;
      for (const c of this._chunks) { out.set(c, off); off += c.length; }
      this._chunks = [];
      return out;
    }
    transferArrayBuffer() {}
  }
  class Deserializer {
    constructor(buffer) {
      this.buffer = buffer instanceof Uint8Array ? buffer
        : (buffer && buffer.buffer instanceof ArrayBuffer ? new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength) : new Uint8Array(0));
      this._off = 0;
    }
    readHeader() {
      if (this._u32() !== MAGIC || this._u32() !== VERS) {
        const e = new Error('Unable to deserialize cloned data due to invalid or unsupported version.');
        e.name = 'DataCloneError'; throw e;
      }
    }
    readValue() {
      const len = this._u32();
      const bytes = this.buffer.subarray(this._off, this._off + len);
      this._off += len;
      return JSON.parse(platformDecoders.strip.decode(bytes), (k, v) => {
        if (v && typeof v === 'object' && v.__nodineBigInt !== undefined) return BigInt(v.__nodineBigInt);
        if (v && typeof v === 'object' && Array.isArray(v.__nodineU8)) return new Uint8Array(v.__nodineU8);
        return v;
      });
    }
    readUint32() { return this._u32(); }
    readDouble() { const d = new DataView(this.buffer.buffer, this.buffer.byteOffset + this._off, 8).getFloat64(0, true); this._off += 8; return d; }
    readRawBytes(length) { const b = this.buffer.subarray(this._off, this._off + length); this._off += length; return b; }
    readUint64() { const hi = this._u32(), lo = this._u32(); return [hi, lo]; }
    _u32() { const v = new DataView(this.buffer.buffer, this.buffer.byteOffset + this._off, 4).getUint32(0, true); this._off += 4; return v; }
    transferArrayBuffer() {}
  }
  return Object.freeze({
    Serializer, Deserializer,
    transferArrayBuffer() {}, transferImageBitmap() {},
  });
});
defBinding('report', () => Object.freeze({
  // lib/internal/process/per_thread.cc surface — no native reporter in the
  // browser host (documented); the JS getters degrade to empty reports.
  // B17: FULL accessor parity with lib/internal/process/report.js — the
  // vendored source calls every one of these nr.* functions from its
  // getter/setter bodies (nr.getExcludeNetwork etc.). The old 3-fn surface
  // made `process.report.excludeNetwork` throw `nr.getExcludeNetwork is
  // not a function` — npm 12's reify-finish reads it on the exit path,
  // killing every real install at ~2s ("npm error nr.getExcludeNetwork is
  // not a function", exit 1, no debug log).
  // B17b: getReport must return a JSON STRING (the native binding
  // serializes; report.js:64 does JSONParse(nr.getReport(err))). Our old
  // object return made every JSON.parse(getReport()) throw
  // '"[object Object]" is not valid JSON' — the ACTUAL create-expo-app /
  // npm exec / npx blocker: with platform now 'linux' (B16), Arborist's
  // checkPlatform → npm-install-checks getFamilyFromReport() runs on every
  // install and parses the report (stack captured in dev-logs: line 66 =
  // report.js getReport). Defaults mirror real Node's per_thread.cc:
  // excludeNetwork=false, compact=false, reportOn*=false, directory '' (cwd),
  // filename '' (auto), signal SIGUSR2. glibcVersionRuntime is claimed so
  // libc detection resolves 'glibc' (the VFS emulates a glibc-shaped Linux).
  getReport() {
    return JSON.stringify({
      header: {
        hostName: 'nodine', osName: 'Nodine', platform: 'linux',
        glibcVersionRuntime: '2.36',
      },
    });
  },
  setReportFilePath() {}, writeReport() { return ''; },
  getCompact() { return false; }, setCompact() {},
  getDirectory() { return ''; }, setDirectory() {},
  getFilename() { return ''; }, setFilename() {},
  getExcludeEnv() { return false; }, setExcludeEnv() {},
  getExcludeNetwork() { return false; }, setExcludeNetwork() {},
  getSignal() { return 'SIGUSR2'; }, setSignal() {},
  shouldReportOnFatalError() { return false; }, setReportOnFatalError() {},
  shouldReportOnSignal() { return false; }, setReportOnSignal() {},
  shouldReportOnUncaughtException() { return false; }, setReportOnUncaughtException() {},
}));
defBinding('crypto', () => Object.freeze({
  // Minimal internal surface for lib/tls.js + internal/crypto loads; the
  // PUBLIC crypto module is a bridge builtin (noble-backed).
  getAllowUnauthorized: () => false,
  getCiphers: () => [],
  getDefaultHashList: () => [],
  getHashes: () => ['sha1', 'sha256', 'sha512', 'md5'],
  // internal/crypto/webcrypto.js load-time constants (the lazy globalThis.crypto
  // loader destructures exactly these)
  kWebCryptoKeyFormatRaw: 1, kWebCryptoKeyFormatPKCS8: 2, kWebCryptoKeyFormatSPKI: 3,
  kWebCryptoCipherEncrypt: 1, kWebCryptoCipherDecrypt: 2,
  // M1.7A: internal/crypto/keys.js:162 destructures createNativeKeyObjectClass
  // at MODULE LOAD (the pnpm-wasm harness imports node:crypto for randomUUID).
  // Returns [KeyObject, SecretKeyObject, PublicKeyObject, PrivateKeyObject].
  // Shape-faithful enough for load: the classes carry handle slots and the
  // init callback populates slot accessors; actual key MATH stays on the
  // noble-backed public bridge.
  createNativeKeyObjectClass(init) {
    class KeyObjectHandle {
      constructor(h) { this.h = h; }
    }
    const kHandle = Symbol('kHandle');
    const kKeyObject = Symbol('kKeyObject');
    class NativeKeyObject {
      constructor(handle) { this[kHandle] = handle; this[kKeyObject] = this; }
      get handle() { return this[kHandle]; }
    }
    let getKeyObjectSlots;
    try {
      const slots = init ? init(NativeKeyObject) : null;
      getKeyObjectSlots = slots && slots.getKeyObjectSlots ? slots.getKeyObjectSlots : () => ({});
    } catch { getKeyObjectSlots = () => ({}); }
    const slot = (self) => { try { return getKeyObjectSlots(self); } catch { return {}; } };
    class KeyObject extends NativeKeyObject {}
    class SecretKeyObject extends KeyObject {}
    class PublicKeyObject extends KeyObject {}
    class PrivateKeyObject extends KeyObject {}
    KeyObject.prototype[kHandle] = undefined;
    return [KeyObject, SecretKeyObject, PublicKeyObject, PrivateKeyObject];
  },
  // M1.7A: keys.js:1231 destructures createCryptoKeyClass similarly
  // (CryptoKey + InternalCryptoKey, slot-array storage on the native base).
  createCryptoKeyClass(init) {
    const kSlots = Symbol('kSlots');
    class NativeCryptoKey {
      constructor() { this[kSlots] = new Array(10).fill(undefined); }
    }
    try { if (init) init(NativeCryptoKey); } catch { }
    class CryptoKey {
      constructor() { throw new TypeError('Illegal constructor'); }
    }
    class InternalCryptoKey extends NativeCryptoKey { }
    return [CryptoKey, InternalCryptoKey];
  },
}));

// ---- pako-backed zlib handle ------------------------------------------------
function pakoMakeHandle(kind) {
  // kind: 'inflate' | 'inflateRaw' | 'gunzip' | 'deflate' | 'deflateRaw' | 'gzip'
  class PakoHandle {
    constructor(opts) {
      this.opts = opts || {};
      this.chunks = [];
      let mode = kind, level;
      if (kind === 'gunzip' || kind === 'inflate' || kind === 'inflateRaw') {
        if (kind === 'inflate' && this.opts.dictionary) mode = 'inflate';
      } else {
        level = this.opts.level;
      }
      this.kind = kind;
      this.closed = false;
      this.ended = false;
      this.err = 0; this.msg = '';
      const self = this;
      const streams = {
        inflate: () => new PAKO.Inflate({ raw: false }),
        inflateRaw: () => new PAKO.Inflate({ raw: true }),
        gunzip: () => new PAKO.Inflate({ raw: false, gzip: true }),
        deflate: () => new PAKO.Deflate({ raw: false, level: level ?? 6 }),
        deflateRaw: () => new PAKO.Deflate({ raw: true, level: level ?? 6 }),
        gzip: () => new PAKO.Deflate({ gzip: true, level: level ?? 6 }),
      };
      this.handle = (streams[kind] || streams.inflate)();
      this.handle.onData = (chunk) => { self.chunks.push(chunk); };
      this.handle.onEnd = (status) => {
        if (status !== 0) { self.err = status; self.msg = PAKO.constants ? ('pako status ' + status) : ''; }
        self.ended = true;
      };
      // extra output beyond chunks for the finished stream
      this.handle.onEndStatus = 0;
    }
    _drain() {
      const out = this.chunks;
      this.chunks = [];
      return out.length === 1 ? out[0] : concatBytes(out);
    }
    _processChunk(chunk, flushFlag) {
      if (this.closed) throw new Error('zlib handle closed');
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(0);
      const final = flushFlag === 4 /* Z_FINISH */ || flushFlag === 2 /* Z_FULL_FLUSH? see constants */;
      const ok = this.handle.push(data, flushFlag === 4 ? PAKO.constants.Z_FINISH : PAKO.constants.Z_SYNC_FLUSH);
      if (!ok && !this.ended) { /* need more input */ }
      if (this.handle.err !== undefined && this.handle.err !== 0 && this.handle.err !== this.err) {
        const e = new Error('incorrect header check / data error (' + this.handle.err + ') ' + (this.handle.msg || ''));
        e.errno = -5; e.code = 'Z_DATA_ERROR';
        this.err = this.handle.err;
        throw e;
      }
      return this._drain();
    }
    close() { this.closed = true; }
    reset() {}
    on(ev, fn) { (this._ee = this._ee || new Map()).set(ev, fn); return this; }
    emit() { return false; }
  }
  return PakoHandle;
}
function concatBytes(list) {
  let n = 0;
  for (const c of list) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of list) { out.set(c, o); o += c.length; }
  return out;
}

// ---- BRIDGE BUILTINS --------------------------------------------------------
const BRIDGE_BUILTINS = new Map();

// ===== zlib =====
BRIDGE_BUILTINS.set('zlib', (exports, require, module) => {
  const { Transform } = require('stream');
  const Z_NO_FLUSH = 0, Z_PARTIAL_FLUSH = 1, Z_SYNC_FLUSH = 2, Z_FULL_FLUSH = 3, Z_FINISH = 4;
  const Z_OK = 0, Z_STREAM_END = 1, Z_NEED_DICT = 2, Z_ERRNO = -1, Z_STREAM_ERROR = -2,
    Z_DATA_ERROR = -3, Z_MEM_ERROR = -4, Z_BUF_ERROR = -5, Z_VERSION_ERROR = -6;
  const constants = {
    Z_NO_FLUSH, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH, Z_BLOCK: 5, Z_TREES: 6,
    Z_OK, Z_STREAM_END, Z_NEED_DICT, Z_ERRNO, Z_STREAM_ERROR, Z_DATA_ERROR, Z_MEM_ERROR,
    Z_BUF_ERROR, Z_VERSION_ERROR,
    Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
    Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
    Z_DEFLATED: 8,
    Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15,
    Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384,
    Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8,
    Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
  };
  function handleFor(mode) { return pakoMakeHandle(mode); }
  class BridgeZlib extends Transform {
    constructor(mode, opts) {
      super(opts || {});
      this.handle = new (handleFor(mode))(opts || {});
      this._handle = { close() {}, reset() {}, ref() {}, unref() {} };
      const self = this;
      this.handle.onDataPush = true;
    }
    _transform(chunk, _enc, cb) {
      try { cb(null, this.handle._processChunk(chunk, Z_SYNC_FLUSH)); }
      catch (e) { cb(e); }
    }
    _flush(cb) {
      try {
        const tail = this.handle._processChunk(new Uint8Array(0), Z_FINISH);
        cb(null, tail && tail.length ? tail : undefined);
      } catch (e) { cb(e); }
    }
  }
  // minizlib contract: handle classes with _processChunk + EE + close.
  // P2-006-008: minizlib's write() digs into `this.#handle._handle` (the
  // native handle) to intercept .close during _processChunk — expose a
  // duck-typed _handle on every class instance.
  function makeClass(mode) {
    return class ZlibMode extends Transform {
      constructor(opts) {
        super(opts || {});
        this.handle = new (handleFor(mode))(opts || {});
        this._handle = { close() {}, reset() {}, ref() {}, unref() {} };
      }
      _transform(chunk, _enc, cb) {
        try { const out = this.handle._processChunk(chunk, Z_SYNC_FLUSH); cb(null, out && out.length ? out : undefined); }
        catch (e) { cb(e); }
      }
      _flush(cb) {
        try {
          const tail = this.handle._processChunk(new Uint8Array(0), Z_FINISH);
          cb(null, tail && tail.length ? tail : undefined);
        } catch (e) { cb(e); }
      }
      close() { this.handle.close(); this.destroy(); }
      // minizlib drives the raw handle directly (this.#handle._processChunk)
      // on the CLASS it receives — expose the duck-typed methods too:
      _processChunk(chunk, flag) { return this.handle._processChunk(chunk, flag); }
      reset() {}
    };
  }
  const Deflate = makeClass('deflate'), Inflate = makeClass('inflate');
  const Gzip = makeClass('gzip'), Gunzip = makeClass('gunzip');
  const DeflateRaw = makeClass('deflateRaw'), InflateRaw = makeClass('inflateRaw');
  const Unzip = class Unzip extends Transform {
    // auto-detect: gzip (1f 8b) | zlib (78 xx) | raw deflate | brotli/zstd → ENOTSUP
    constructor(opts) {
      super(opts || {});
      this.detected = null;
      this._handle = { close() {}, reset() {}, ref() {}, unref() {} };
    }
    _detect(chunk) {
      // auto-detect: gzip (1f 8b) | zlib (78 xx) | raw deflate | brotli/zstd → ENOTSUP
      const b = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) this.detected = new (handleFor('gunzip'))({});
      else if (b.length >= 2 && b[0] === 0x28 && b[1] === 0xb5) { const e = new Error('Brotli decompression is not supported by the browser-native zlib bridge yet'); e.code = 'ENOTSUP'; e.errno = -95; throw e; }
      else if (b.length >= 1 && b[0] === 0x78) this.detected = new (handleFor('inflate'))({});
      else this.detected = new (handleFor('inflateRaw'))({});
    }
    _transform(chunk, _enc, cb) {
      try {
        if (!this.detected) this._detect(chunk);
        const out = this.detected._processChunk(chunk, Z_SYNC_FLUSH);
        cb(null, out && out.length ? out : undefined);
      } catch (e) { cb(e); }
    }
    _flush(cb) {
      try {
        const tail = this.detected ? this.detected._processChunk(new Uint8Array(0), Z_FINISH) : undefined;
        cb(null, tail && tail.length ? tail : undefined);
      } catch (e) { cb(e); }
    }
    // P2-006-008: minizlib calls _processChunk DIRECTLY (its write() digs
    // into the handle) — the Transform machinery never runs on that path, so
    // detection must happen here too, not only in _transform.
    _processChunk(chunk, flag) {
      if (!this.detected) this._detect(chunk);
      return this.detected._processChunk(chunk, flag);
    }
    close() { if (this.detected) this.detected.close(); this.destroy(); }
    reset() {}
  };
  const BrotliCompress = class extends Transform { constructor() { const e = new Error('Brotli is not supported by the browser-native zlib bridge yet'); e.code = 'ENOTSUP'; throw e; } };
  const BrotliDecompress = BrotliCompress;
  const ZstdCompress = BrotliCompress, ZstdDecompress = BrotliCompress;
  function oneShot(kind, data, opts) {
    const h = new (handleFor(kind))(opts || {});
    return h._processChunk(data, Z_FINISH);
  }
  Object.assign(exports, {
    constants, Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, Unzip,
    BrotliCompress, BrotliDecompress, ZstdCompress, ZstdDecompress,
    createDeflate: (o) => new Deflate(o), createInflate: (o) => new Inflate(o),
    createGzip: (o) => new Gzip(o), createGunzip: (o) => new Gunzip(o),
    createDeflateRaw: (o) => new DeflateRaw(o), createInflateRaw: (o) => new InflateRaw(o),
    createUnzip: (o) => new Unzip(o),
    createBrotliCompress: (o) => new BrotliCompress(o), createBrotliDecompress: (o) => new BrotliDecompress(o),
    deflate: (d, cb) => cb(null, oneShot('deflate', d)), inflate: (d, cb) => cb(null, oneShot('inflate', d)),
    deflateSync: (d, o) => oneShot('deflate', d, o), inflateSync: (d, o) => oneShot('inflate', d, o),
    gzipSync: (d, o) => oneShot('gzip', d, o), gunzipSync: (d, o) => oneShot('gunzip', d, o),
    gzip: (d, cb) => cb(null, oneShot('gzip', d)), gunzip: (d, cb) => cb(null, oneShot('gunzip', d)),
    deflateRawSync: (d, o) => oneShot('deflateRaw', d, o), inflateRawSync: (d, o) => oneShot('inflateRaw', d, o),
    unzipSync: (d, o) => {
      if (d.length >= 2 && d[0] === 0x1f && d[1] === 0x8b) return oneShot('gunzip', d, o);
      if (d.length >= 1 && d[0] === 0x78) return oneShot('inflate', d, o);
      return oneShot('inflateRaw', d, o);
    },
    crc32: (data, value) => 0,
  });
});

// ===== crypto =====
BRIDGE_BUILTINS.set('crypto', (exports, require, module) => {
  const nobleHash = (name) => {
    const mod = NOBLE[name];
    return mod ? (mod[name] || mod) : null;
  };
  const HASHES = {
    sha1: () => NOBLE.sha1.sha1.create(),
    'sha-1': () => NOBLE.sha1.sha1.create(),
    sha256: () => NOBLE.sha256.sha256.create(),
    'sha-256': () => NOBLE.sha256.sha256.create(),
    sha512: () => NOBLE.sha512.sha512.create(),
    'sha-512': () => NOBLE.sha512.sha512.create(),
    md5: () => ({ _bufs: [], update(d) { this._bufs.push(d); return this; }, digest(enc) {
      const all = this._bufs.length === 1 ? this._bufs[0] : concatBytes(this._bufs);
      const hex = MD5FN(all instanceof Uint8Array ? all : Buffer.from(all));
      return encDigest(Buffer.from(hex, 'hex'), enc);
    } }),
  };
  function encDigest(bytes, enc) {
    if (enc === 'hex' || enc === undefined && false) return Buffer.from(bytes).toString('hex');
    if (enc === 'base64') return Buffer.from(bytes).toString('base64');
    if (enc === 'base64url') return Buffer.from(bytes).toString('base64url');
    if (enc === 'latin1' || enc === 'binary') return Buffer.from(bytes).toString('latin1');
    return Buffer.from(bytes); // 'buffer'/undefined
  }
  function createHash(alg) {
    const norm = String(alg).toLowerCase();
    const mk = HASHES[norm];
    if (!mk) { const e = new Error('Digest method not supported in the browser-native crypto bridge: ' + alg); e.code = 'ERR_OSSL_EVP_UNSUPPORTED'; throw e; }
    const h = mk();
    return {
      update(data) { h.update(data instanceof Uint8Array ? data : Buffer.isBuffer(data) ? data : Buffer.from(String(data))); return this; },
      digest(enc) { return encDigest(h.digest(), enc); },
      copy() { const c = mk(); c.update === h.update; return { update() { return this; }, digest(e2) { return encDigest(h.digest(), e2); } }; },
    };
  }
  function randomBytes(size, cb) {
    const b = Buffer.allocUnsafe(size);
    platformCrypto.getRandomValues(b);
    if (cb) { process.nextTick(cb, null, b); return b; }
    return b;
  }
  Object.assign(exports, {
    createHash,
    getHashes: () => ['sha1', 'sha256', 'sha512', 'md5'],
    getCiphers: () => [],
    randomBytes,
    randomFillSync(buf) { platformCrypto.getRandomValues(buf); return buf; },
    randomInt(min, max, cb) {
      const lo = typeof max === 'number' ? min : 0;
      const hi = typeof max === 'number' ? max : min;
      const v = lo + Math.floor(Math.random() * (hi - lo));
      if (cb) { process.nextTick(cb, null, v); return; }
      return v;
    },
    randomUUID: () => platformCrypto.randomUUID(),
    timingSafeEqual(a, b) {
      if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) throw new Error('crypto.timingSafeEqual: invalid arguments');
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
      return diff === 0;
    },
    webcrypto: platformCrypto,
    createVerify() { const e = new Error('crypto.createVerify is not supported in the browser-native crypto bridge yet (sync verify); npm audit only'); e.code = 'ENOTSUP'; throw e; },
    createSign() { const e = new Error('crypto.createSign: not supported'); e.code = 'ENOTSUP'; throw e; },
    createCipheriv() { const e = new Error('crypto.createCipheriv: use webcrypto'); e.code = 'ENOTSUP'; throw e; },
    createDecipheriv() { const e = new Error('crypto.createDecipheriv: use webcrypto'); e.code = 'ENOTSUP'; throw e; },
    createHmac() { const e = new Error('crypto.createHmac: not supported in the bridge yet (webcrypto SubtleDigest is async-only)'); e.code = 'ENOTSUP'; throw e; },
    pbkdf2() { throw new Error('crypto.pbkdf2: use webcrypto (async)'); },
    scrypt() { throw new Error('crypto.scrypt: use webcrypto'); },
    constants: {},
  });
});



// ===== child_process (supervisor RPC; real workers, real endpoints) =====
BRIDGE_BUILTINS.set('child_process', (exports, require, module) => {
  const { EventEmitter } = require('events');
  const { Readable, Writable } = require('stream');
  const normSpawnArgs = (file, args, options) => {
    let f = file, a = Array.isArray(args) ? args.slice() : [];
    let opts = args && !Array.isArray(args) && typeof args === 'object' ? args : (options || {});
    if (opts.shell === true) {
      const cmd = [file, ...a].join(' ');
      f = '/bin/sh'; a = ['-c', cmd];
    } else if (typeof opts.shell === 'string') {
      const cmd = [file, ...a].join(' ');
      f = opts.shell; a = ['-c', cmd];
    }
    return { file: f, args: a, opts };
  };
  class ChildProcess extends EventEmitter {
    constructor() {
      super();
      this.pid = undefined;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this.spawnfile = '';
      this.spawnargs = [];
      this.stdio = [];
      this._pending = [];
    }
    kill(sig) {
      if (this.killed || this.exitCode !== null) return this;
      if (CHANNEL_PORT && this.pid) CHANNEL_PORT.postMessage({ type: 'kill', pid: this.pid, sig: sig || 'SIGTERM' });
      this.killed = true;
      return this;
    }
    ref() { return this; }
    unref() { return this; }
    send() { return false; }
    disconnect() {}
    _queue(type, fn) { (this._handlers = this._handlers || new Map()).set(type, fn); }
  }
  function spawn(file, args, options) {
    const { file: f, args: a, opts } = normSpawnArgs(file, args, options);
    const stdio = opts.stdio || ['pipe', 'pipe', 'pipe'];
    // P2-006-008: Stream-object stdio (the yarn shell passes its OWN
    // process.stdout/stdin/stderr objects through to spawned commands) means
    // "wire this fd to THAT stream" — the child joins the parent's OWN
    // stdio MODE, PER DIRECTION: passing process.stdout through a piped
    // parent puts the child's fd 1 on the SAME pipe chain (exec's capture);
    // passing process.stdin keeps fd 0 on the parent's REAL stdin — a piped
    // parent (exec) still reads the terminal/tty itself (exec's stdin is
    // 'pipe' but the yarn shell hands its OWN process.stdin object, which is
    // the tty). Getting this wrong lost every keystroke in create-expo's
    // prompt (the grandchild read an empty pipe queue while terminal bytes
    // sat in the kernel FIFO — observed live: 'NodineExpoGolden' → 'apden'
    // → nothing).
    const outMode = STDIO_MODE === 'pipe' ? 1 : STDIO_MODE === 'ignore' ? 2 : 0;
    const inMode = STDIO_MODE === 'ignore' ? 2 : 0; // own stdin is the real fd 0
    // E6 PIPELINE FIX: an OBJECT stdio for fd 1/2 that is NOT our own
    // stdout/stderr is a pipe TARGET the caller owns (the yarn shell passes
    // the next stage's stdin Writable as the previous stage's stdout —
    // Handle.pipeTo wiring). Real Node dup()s the parent's descriptor onto
    // the child's fd; the browser substitute is: give the child a REAL pipe
    // (fd1='pipe', bytes arrive here as child-stdout messages) and pump
    // every received byte into the provided Writable. The old mapping
    // (outMode) sent inherit-mode shells' children to the GLOBAL kernel
    // FIFO — 'cat x | wc -l' printed cat's output to the terminal AND wc
    // read 0 lines (observed live; the Writable was dropped on the floor).
    const ownStream = (v, i) => v !== null && typeof v === 'object' &&
      (i === 0 ? v === realmProcess.stdin : i === 1 ? v === realmProcess.stdout : v === realmProcess.stderr);
    const stdioMode = Array.isArray(stdio)
      ? stdio.map((v, i) => {
          if (v === 'inherit') return 0;
          if (v === 'pipe') return 1;
          if (v === 'ignore') return 2;
          if (typeof v === 'number') return 0;      // fd sharing → inherit
          if (v !== null && typeof v === 'object') {
            if (ownStream(v, i)) return i === 0 ? inMode : outMode; // own-stream → per-direction
            return i === 0 ? 0 : 1; // foreign Writable/Readable: fd0 keeps the tty, fd1/2 become a pumped pipe
          }
          return 1;
        })
      : (stdio === 'inherit' ? [0, 0, 0] : stdio === 'ignore' ? [2, 2, 2] : [1, 1, 1]);
    // M1.4 output isolation (dup semantics for piped parents): a child's
    // 'inherit' fd 1/2 means "share MY descriptor" — real Node dups the
    // parent's fd. In a PIPE-mode process (SDK container spawns) our fd 1/2
    // IS the channel pipe, but the generic inherit mapping sends the child
    // to the GLOBAL kernel FIFO instead, whose drain reaches every
    // concurrent process's stream (observed live: cross-contamination).
    // Redirect those fds to 'pipe' and re-emit the received bytes onto our
    // OWN stdout/stderr — exactly the own-stream dup path above — so the
    // child's output rides this process's channel, isolated. fd 0 keeps
    // inherit (a real-terminal child reads the kernel FIFO — the
    // P2-006-008 create-expo prompt semantics). Inherit-mode PARENTS (the
    // terminal demo) are untouched: their STDIO_MODE is 'inherit'.
    let inheritOut = false, inheritErr = false;
    if (STDIO_MODE === 'pipe') {
      const wantsInherit = (i) => (Array.isArray(stdio) ? stdio[i] === 'inherit' : stdio === 'inherit');
      if (stdioMode[1] === 0 && wantsInherit(1)) { stdioMode[1] = 1; inheritOut = true; }
      if (stdioMode[2] === 0 && wantsInherit(2)) { stdioMode[2] = 1; inheritErr = true; }
    }
    const child = new ChildProcess();
    child.spawnfile = f;
    child.spawnargs = a;
    const wantsIn = stdioMode[0] === 1, wantsOut = stdioMode[1] === 1, wantsErr = stdioMode[2] === 1;
    // P2-006-008 FD-SHARING (real-Node dup semantics): when the caller passes
    // its OWN stdio STREAM as the child's stdio (the yarn shell does exactly
    // this), the child's fd IS the parent's fd. The child still gets pipe
    // mode (the bytes arrive here as child-stdout messages), but they must be
    // re-emitted onto OUR OWN fd — NOT buffered in a local Readable nothing
    // reads (the yarn shell only pipes Transform streams; plain
    // process.stdout sharing relies on the kernel-level dup).
    let ownOut = wantsOut && stdio[1] !== null && typeof stdio[1] === 'object' && stdio[1] === realmProcess.stdout;
    let ownErr = wantsErr && stdio[2] !== null && typeof stdio[2] === 'object' && stdio[2] === realmProcess.stderr;
    // E6 PIPELINE FIX: foreign Writable targets (the yarn shell's pipeline
    // wiring — next stage's stdin as this stage's stdout/stderr). The child
    // runs with a real pipe; every child-stdout/-stderr byte is written into
    // the caller's Writable (real-Node dup semantics), and EOF ends it.
    const foreignOut = wantsOut && stdio[1] !== null && typeof stdio[1] === 'object' && stdio[1] !== realmProcess.stdout
      ? stdio[1] : null;
    const foreignErr = wantsErr && stdio[2] !== null && typeof stdio[2] === 'object' && stdio[2] !== realmProcess.stderr
      ? stdio[2] : null;
    if (foreignOut) ownOut = false; // the pump owns re-emission now
    if (foreignErr) ownErr = false;
    const env = Object.assign({}, opts.env || process.env);
    const cwd = opts.cwd || process.cwd();
    if (!CHANNEL_PORT) {
      const err = new Error('spawn ' + f + ' ENOENT: no supervisor channel');
      err.code = 'ENOENT'; err.errno = -2; err.syscall = 'spawn'; err.path = f;
      process.nextTick(() => { child.emit('error', err); child.emit('close', null, null); });
      return child;
    }
    // pipe-mode streams (the supervisor relays via the channel port)
    const mkOut = () => {
      const r = new Readable({ read() {} });
      r.setEncoding = r.setEncoding.bind(r);
      return r;
    };
    const mkIn = () => {
      // E6 PIPELINE FIX: bytes may arrive BEFORE the spawn-result sets
      // child.pid (the previous pipeline stage starts writing the moment
      // its own spawn completes — wc's stdin Writable exists from ITS spawn
      // call, but the async spawn-result has not landed yet). The old
      // write() dropped every byte while pid was undefined — 'cat x | wc -l'
      // printed 0. Queue until the pid lands, then flush in order.
      const pending = [];
      let ended = false;
      const w = new Writable({
        write(chunk, _enc, cb) {
          if (child.pid) {
            CHANNEL_PORT.postMessage({ type: 'child-stdin', pid: child.pid, bytes: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length) });
          } else {
            pending.push(Buffer.from(chunk));
          }
          cb();
        },
        final(cb) {
          ended = true;
          if (child.pid) CHANNEL_PORT.postMessage({ type: 'child-stdin', pid: child.pid, eof: true });
          cb();
        },
      });
      w.__flushPid = (pid) => {
        for (const b of pending) CHANNEL_PORT.postMessage({ type: 'child-stdin', pid, bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) });
        pending.length = 0;
        if (ended) CHANNEL_PORT.postMessage({ type: 'child-stdin', pid, eof: true });
      };
      return w;
    };
    let spawned = false, exited = false;
    // M1.4 isolation dup: an inherit-redirected child's fd 1/2 (see above)
    // is OUR fd — re-emit received bytes onto our own stdout/stderr. No local
    // child.stdout buffer (a dup child shares the descriptor; its bytes
    // appear on our stream, exactly as the own-stream fd-sharing path does).
    if (inheritOut) ownOut = true;
    if (inheritErr) ownErr = true;
    const stdoutChunks = (wantsOut && !ownOut && !foreignOut) ? mkOut() : null;
    const stderrChunks = (wantsErr && !ownErr && !foreignErr) ? mkOut() : null;
    if (stdoutChunks) child.stdout = stdoutChunks;
    if (stderrChunks) child.stderr = stderrChunks;
    if (wantsIn) child.stdin = mkIn();
    const onPortMsg = (m) => {
      if (!m || m.pid !== child.pid) return;
      // P2-006-008: the supervisor's stream EOF marker is {eof:true} with NO
      // bytes field — Buffer.from(undefined) threw "The first argument must
      // be of type string or Buffer" on every piped-child exit (observed
      // live: exec('echo …') crashed the parent at the child's EOF).
      if (m.type === 'child-stdout') {
        if (ownOut) { try { realmProcess.stdout.write(Buffer.from(m.bytes)); } catch {} return; }
        if (foreignOut) { // E6: pump into the caller's pipe target
          if (m.eof) { try { foreignOut.end(); } catch {} return; }
          try { foreignOut.write(Buffer.from(m.bytes)); } catch {}
          return;
        }
        if (!stdoutChunks) return;
        if (m.eof) { stdoutChunks.push(null); return; }
        stdoutChunks.push(Buffer.from(m.bytes));
      } else if (m.type === 'child-stderr') {
        if (ownErr) { try { realmProcess.stderr.write(Buffer.from(m.bytes)); } catch {} return; }
        if (foreignErr) { // E6: pump into the caller's pipe target
          if (m.eof) { try { foreignErr.end(); } catch {} return; }
          try { foreignErr.write(Buffer.from(m.bytes)); } catch {}
          return;
        }
        if (!stderrChunks) return;
        if (m.eof) { stderrChunks.push(null); return; }
        stderrChunks.push(Buffer.from(m.bytes));
      }
      else if (m.type === 'child-exit') {
        channelPortHandlers.delete('child-stdout:' + child.pid);
        channelPortHandlers.delete('child-stderr:' + child.pid);
        channelPortHandlers.delete('child-exit:' + child.pid);
        child.exitCode = typeof m.code === 'number' ? m.code : null;
        exited = true;
        child.emit('exit', child.exitCode, null);
        // 'close' after the stdio streams end
        const finish = () => {
          if (child.stdin) try { child.stdin.end(); } catch {}
          if (stdoutChunks) stdoutChunks.push(null);
          if (stderrChunks) stderrChunks.push(null);
          // E6: the supervisor's EOF markers may already have ended these;
          // end() on an ended Writable is a no-op-safe best effort.
          if (foreignOut) try { foreignOut.end(); } catch {}
          if (foreignErr) try { foreignErr.end(); } catch {}
          setImmediate(() => child.emit('close', child.exitCode, null));
        };
        finish();
      }
    };
    traceLife('spawn-posted', f);
    pendingSpawnReplies++;
    // M1.6 fix: concurrent spawn() calls from one process used to share the
    // bare 'spawn-result' handler key — the second registration overwrote
    // the first, so the first child's result was consumed by the second
    // child's handler (wrong pid wiring) and the second result was dropped
    // (its handler already deleted): with two inherit children the second
    // child's output handlers were never registered and its bytes were lost
    // (observed live in the migrated demo; the old inherit-mode demo never
    // hit this path). Unique per-request key now; the supervisor echoes the
    // reqId back on the reply.
    const spawnReqId = 'spawn-result#' + (++spawnReqSeq);
    // B18: a spawned child may mutate the VFS we cached stats for — drop the
    // whole cache at spawn time (npm's exec/await sequencing means the parent
    // re-walks after the child exits, repopulating fresh entries). Reaches
    // the fs binding through the binding registry (this closure is outside
    // the fs binding's scope — the in-scope call was a ReferenceError that
    // killed every npx run; caught via npm's debug log 2026-11-19).
    try { bindingCache.get('fs')?._fsStatCacheOnChildSpawn?.(); } catch {}
    CHANNEL_PORT.postMessage({
      type: 'spawn', argv: [f, ...a], env, cwd, reqId: spawnReqId,
      stdio: [stdioMode[0] === 0 ? 'inherit' : stdioMode[0] === 2 ? 'ignore' : 'pipe',
              stdioMode[1] === 0 ? 'inherit' : stdioMode[1] === 2 ? 'ignore' : 'pipe',
              stdioMode[2] === 0 ? 'inherit' : stdioMode[2] === 2 ? 'ignore' : 'pipe'],
      shell: false,
    });
    const spawnReply = (m) => {
      if (m.type !== 'spawn-result') return;
      channelPortHandlers.delete(spawnReqId);
      pendingSpawnReplies--;
      traceLife('spawn-result', m.error || ('pid=' + m.pid));
      if (m.error || typeof m.pid !== 'number') {
        const err = new Error('spawn ' + f + ' ' + (m.error || 'ENOENT'));
        err.code = m.error || 'ENOENT'; err.errno = -2; err.syscall = 'spawn'; err.path = f; err.spawnargs = a;
        child.emit('error', err);
        child.emit('close', null, null);
        return;
      }
      child.pid = m.pid;
      // E6: release any bytes queued before the pid landed
      if (child.stdin && child.stdin.__flushPid) child.stdin.__flushPid(m.pid);
      liveChildren++;
      traceLife('child-spawn');
      channelPortHandlers.set('child-stdout:' + m.pid, onPortMsg);
      channelPortHandlers.set('child-stderr:' + m.pid, onPortMsg);
      channelPortHandlers.set('child-exit:' + m.pid, onPortMsg);
      child.emit('spawn');
      const _origEmit = child.emit.bind(child);
      child.emit = function (type, ...rest) {
        const r = _origEmit(type, ...rest);
        if (type === 'close' && liveChildren > 0) { liveChildren--; traceLife('child-close'); }
        return r;
      };
    };
    channelPortHandlers.set(spawnReqId, spawnReply);
    return child;
  }
  function execFile(file, args, options, callback) {
    let cb = callback, opts = options;
    if (typeof options === 'function') { cb = options; opts = undefined; }
    if (typeof args === 'function') { cb = args; opts = undefined; args = []; }
    if (!Array.isArray(args)) { opts = args; args = []; }
    const child = spawn(file, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
    let stdout = '', stderr = '';
    if (child.stdout) child.stdout.setEncoding('utf8'), child.stdout.on('data', (d) => { stdout += d; });
    if (child.stderr) child.stderr.setEncoding('utf8'), child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (cb) cb(code === 0 ? null : new Error('Command failed: ' + file + ' ' + args.join(' ') + '\n' + stderr), stdout, stderr);
    });
    return child;
  }
  function exec(cmd, options, callback) {
    let cb = callback, opts = options;
    if (typeof options === 'function') { cb = options; opts = undefined; }
    const { file, args } = normSpawnArgs(cmd, [], Object.assign({ shell: true }, opts || {}));
    return execFile(file, args, opts, cb);
  }
  function spawnSync(file, args, options) {
    // Sync via a bounded busy-wait on the async machinery (the event loop is
    // driven by the settle loop; honest bounded wait, mirrors libuv sync).
    // B23: the OLD return was a BARE thenable { then(resolve) } — every
    // synchronous inspection of the result (r.status / r.error / r.stdout,
    // the exact pattern npx/expo-style probes use right after the call) saw
    // undefined FOREVER, because only awaiting the thenable produced the real
    // object. Real Node returns a plain result SYNCHRONOUSLY. The worker
    // cannot block its single thread on supervisor IPC, so full sync is
    // impossible here — but we return a SELF-FILLING object: the SAME object
    // is the thenable AND carries the result fields, written the moment the
    // child closes (and on timeout), so (a) `await r` resolves it, (b) sync
    // readers after an await tick elsewhere see the filled fields, and
    // (c) the never-observed case at call time is status: null + pending
    // marker instead of undefined — detectable, not silently wrong.
    const { file: f, args: a, opts } = normSpawnArgs(file, args, options);
    const stdio = opts.stdio || ['pipe', 'pipe', 'pipe'];
    let out = '', err = '', code = null, errEvt = null, done = false;
    const wantOut = Array.isArray(stdio) ? stdio[1] !== 'ignore' : stdio !== 'ignore';
    const child = spawn(f, a, Object.assign({}, opts, { stdio: ['ignore', wantOut ? 'pipe' : 'ignore', 'pipe'] }));
    if (child.stdout) { child.stdout.setEncoding && child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { out += d; }); }
    if (child.stderr) { child.stderr.setEncoding && child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err += d; }); }
    child.on('error', (e) => { errEvt = e; });
    const t0 = Date.now();
    const result = {
      status: null,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      pid: child.pid,
      output: [null, Buffer.from(''), Buffer.from('')],
      error: null,
      pending: true,
    };
    const fill = (extra) => {
      result.status = code;
      result.stdout = Buffer.from(out);
      result.stderr = Buffer.from(err);
      result.output = [null, Buffer.from(out), Buffer.from(err)];
      result.error = errEvt;
      result.pending = false;
      if (extra) Object.assign(result, extra);
      return result;
    };
    child.on('close', (c) => { code = c; done = true; fill(); });
    result.then = (resolve, reject) => {
      const poll = () => {
        if (done) return resolve ? resolve(fill()) : fill();
        if (Date.now() - t0 > (opts.timeout || 300000)) {
          child.kill('SIGKILL');
          return resolve ? resolve(fill({ status: null, signal: 'SIGKILL', error: new Error('spawnSync timeout') })) : fill({ status: null, signal: 'SIGKILL', error: new Error('spawnSync timeout') });
        }
        setTimeout(poll, 5);
      };
      poll();
      return this;
    };
    return result;
  }
  // execSync/spawnSync are SYNCHRONOUS in Node's API. The browser worker
  // cannot block its single thread on IPC — we run the wait on the
  // platform timer via Atomics.wait on a private signal (the established
  // sleep primitive) and process the channel port... which ALSO needs the
  // event loop. Honest approach: a tight async settle is impossible
  // synchronously; instead we return the thenable from spawnSync and have
  // execSync bridge via the shell's synchronous contract = documented
  // divergence: execSync throws ERR_ASYNC_DISABLED unless the caller
  // awaits. npm's execSync paths (git version probes) tolerate failure.
  function execSync(cmd, options) {
    const e = new Error('execSync is not supported in the browser runtime (single-threaded worker; use exec or spawn)');
    e.code = 'ERR_EXEC_SYNC_UNSUPPORTED';
    throw e;
  }
  Object.assign(exports, {
    spawn, execFile, exec, spawnSync, execSync,
    fork(file, args, options) {
      // fork = node IPC; the bridge does not support the IPC channel yet.
      const child = spawn(file, args, Object.assign({}, options, { stdio: (options && options.stdio) || ['ignore', 'pipe', 'pipe'] }));
      return child;
    },
    ChildProcess,
  });
});

// ===== http / https (fetch-backed client; ADR-0004 egress) =====

// ---------------------------------------------------------------------------
// P2-008 Step-3 Phase-2 — DIRECT NETWORK ADAPTER (browser fetch → registry).
// Evidence & decision gate: docs/perf/direct-network.md (Phase 0).
// Mode plumbing (INIT.env, supervisor-composed):
//   NODINE_NETWORK_MODE       = 'direct' (default — self-contained: the
//                                  browser talks to the allowlisted registries
//                                  directly; no host relay needed) | 'proxy'
//                                  (host must serve an /egress relay)
//   NODINE_NETWORK_ALLOWLIST  = comma-separated HTTPS hosts (default registry.npmjs.org)
//   NODINE_NETWORK_PROXY_URL  = optional USER-SUPPLIED relay base URL
// The corgi gate moved from the relay into the adapter: evaluated on the
// ORIGINAL npm headers (npm-command is required), rewriting accept to the
// preflight-free single-value corgi form. Substituted requests falling back
// on 404/406/415 retry with the original full-metadata accept (§2.3).
// ---------------------------------------------------------------------------
const DIRECT_CORGI_ACCEPT = 'application/vnd.npm.install-v1+json';
const DIRECT_CORGI_COMMANDS = new Set(['install', 'update']); // Phase-0 §1.2: the #fetchManifest-fullMetadata commands
// Phase-4 kill switch: NODINE_DIRECT_CORGI=off|0|false (case-insensitive)
// disables substitution outright — every packument rides the original
// full-metadata accept. Reaches INIT.env the same way as the mode vars
// (leading env assignment on the typed command → supervisor.baseEnv).
function directCorgiDisabled() {
  try {
    const v = String(((INIT && INIT.env) || {}).NODINE_DIRECT_CORGI || '').trim().toLowerCase();
    return v === 'off' || v === '0' || v === 'false';
  } catch {}
  return false;
}
// Phase-4 counters: substitution decision/fallback/full-serve tallies for the
// full-vs-corgi equivalence battery. Exposed via perfSnapshot() (5 s pushes)
// and the final perf-exit dump.
const DIRECT_CORGI_STATS = { substituted: 0, fellBack: 0, fullServed: 0 };
function directNetConfig() {
  const env = (INIT && INIT.env) || {};
  // Package default 'direct': this runtime ships self-contained on static
  // hosts (no /egress relay exists), so the browser must talk to the
  // allowlisted registries directly. Embeddings that DO run a relay can
  // opt back into 'proxy' via BootOptions.env.NODINE_NETWORK_MODE.
  const mode = String(env.NODINE_NETWORK_MODE || 'direct').toLowerCase();
  const allow = String(env.NODINE_NETWORK_ALLOWLIST || 'registry.npmjs.org')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const proxyUrl = String(env.NODINE_NETWORK_PROXY_URL || '').trim() || null;
  return { mode, allow: new Set(allow), proxyUrl };
}
// Packument-path shape (mirrors the relay's egressClassOf): not '/', not
// '/-...' (tarballs & registry endpoints), not *.tgz.
function directIsPackumentPath(pathname) {
  if (!pathname || pathname === '/') return false;
  if (pathname.startsWith('/-')) return false;
  if (pathname.endsWith('.tgz')) return false;
  return true;
}
// Date-sensitive resolution detection (§2.3, fail closed). npm 12.2.2's
// `before` (a Date) is NOT env-exported (envVal maps Date→null) and
// `min-release-age` is envExport:false — env alone is INSUFFICIENT, so we
// mirror @npmcli/config's own layering across three sources:
//   1. process.env (env-sourced values; the supervisor passes these through),
//   2. process.argv (--before=... / --min-release-age=... CLI flags — npm
//      never reassigns process.argv, verified),
//   3. .npmrc files (user ~/.npmrc + project .npmrc) for before= /
//      min-release-age= lines.
// Any hit ⇒ substitution disabled ⇒ full metadata.
function directDateSensitive() {
  try {
    const env = (typeof realmProcess !== 'undefined' && realmProcess && realmProcess.env) || {};
    if (env.npm_config_before || env.NPM_CONFIG_BEFORE) return true;
    if (env.npm_config_min_release_age || env.NPM_CONFIG_MIN_RELEASE_AGE) return true;
    const av = (typeof realmProcess !== 'undefined' && realmProcess && realmProcess.argv) || [];
    for (const a of av) {
      const s = String(a);
      if (s === '--before' || s.startsWith('--before=')) return true;
      if (s === '--min-release-age' || s.startsWith('--min-release-age=')) return true;
    }
    // .npmrc scan — best effort with the runtime's own fs (the same files npm
    // itself reads; an absent file is absent for both).
    try {
      const env2 = (typeof realmProcess !== 'undefined' && realmProcess && realmProcess.env) || {};
      const home = env2.HOME || '/home/user';
      const cwd = (typeof realmProcess !== 'undefined' && realmProcess && realmProcess.cwd && realmProcess.cwd()) || null;
      const files = [String(home).replace(/\/+$/, '') + '/.npmrc'];
      if (cwd) files.push(String(cwd).replace(/\/+$/, '') + '/.npmrc');
      if (typeof esmReadFile === 'function') {
        for (const f of files) {
          try {
            const txt = String(esmReadFile(f));
            if (!txt) continue;
            for (const line of txt.split('\n')) {
              if (/^\s*(before|min-release-age)\s*=/.test(line)) return true;
            }
          } catch {} // absent — npm sees the same absence
        }
      }
    } catch {}
  } catch {}
  return false;
}
// The main decision: given a ClientRequest's shape, return
//   { direct: true, fetchHeaders, substituting } | { direct: false }.
// Fails CLOSED to the relay on: non-GET/HEAD, non-HTTPS, host not
// allowlisted, any authorization credential (§2.5 — never silently
// de-authenticate).
function directAdapterPlan(method, url, headers) {
  const cfg = directNetConfig();
  if (cfg.mode !== 'direct') return { direct: false };
  if (method !== 'GET' && method !== 'HEAD') return { direct: false };
  if (!url || url.protocol !== 'https:') return { direct: false };
  if (!cfg.allow.has(String(url.hostname || '').toLowerCase())) return { direct: false };
  const h = headers || {};
  if (h['authorization'] !== undefined && h['authorization'] !== '') return { direct: false };
  // Corgi gate — ORIGINAL headers, BEFORE stripping (needs npm-command):
  const clientAccept = String(h['accept'] || '');
  const npmCommand = String(h['npm-command'] || '').toLowerCase();
  const substituting =
    method === 'GET' &&
    directIsPackumentPath(url.pathname) &&
    clientAccept === 'application/json' &&
    DIRECT_CORGI_COMMANDS.has(npmCommand) &&
    !directDateSensitive() &&
    !directCorgiDisabled();
  // Phase-4 counters — the substitution decision point. fullServed covers
  // the complementary branch: a packument GET in direct mode that did NOT
  // substitute (kill switch, date-sensitive, or non-{install,update} command).
  if (directIsPackumentPath(url.pathname)) {
    if (substituting) DIRECT_CORGI_STATS.substituted++;
    else if (method === 'GET') DIRECT_CORGI_STATS.fullServed++;
  }
  // Forward ONLY preflight-safe headers (Phase 0.2): accept. user-agent /
  // accept-encoding are forbidden header names (browser substitutes its own);
  // npm-command / pacote-* / npm-auth-type / npm-session / referer are NOT
  // safelisted and MUST be dropped for direct mode.
  const fetchHeaders = {};
  if (substituting) fetchHeaders['accept'] = DIRECT_CORGI_ACCEPT;
  else if (h['accept'] !== undefined) fetchHeaders['accept'] = String(h['accept']);
  return { direct: true, fetchHeaders, substituting };
}
function ensureTrailingSlash(u) { return u.endsWith('/') ? u : u + '/'; }

function bridgeHttpFactory(isHttps) {
  return (exports, require, module) => {
    const { EventEmitter } = require('events');
    const { Readable } = require('stream');
    const FORBIDDEN = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade']);
    class Agent extends EventEmitter {
      constructor(opts) { super(); this.opts = opts || {}; this.sockets = {}; this.freeSockets = {}; this.requests = {}; this.destroyed = false; }
      createConnection() { return null; }
      getName() { return 'fetch'; }
      destroy() { this.destroyed = true; this.emit('close'); }
    }
    Agent.prototype.defaultPort = isHttps ? 443 : 80;
    Agent.prototype.protocol = isHttps ? 'https:' : 'http:';
    const globalAgent = new Agent({ keepAlive: true });
    class IncomingMessage extends Readable {
      constructor(response, url, expectBody = true) {
        super({ highWaterMark: 16 * 1024 });
        this.response = response;
        const headers = {};
        for (const [k, v] of response.headers.entries()) headers[k] = v;
        this.headers = headers;
        this.statusCode = response.status;
        this.statusMessage = response.statusText || '';
        this.httpVersion = '1.1';
        this.trailers = {};
        this.complete = false;
        this.url = url || '';
        this.socket = { remoteAddress: 'fetch-bridge', destroyed: false, setEncoding() {}, setTimeout() {}, on() {}, once() {}, end() {}, destroy() {}, ref() {}, unref() {} };
        this._reader = null;
        // P2-006-008: integrity guard — a proxy hop (or any transport) that
        // silently truncates a content-length response must surface as a
        // RETRYABLE network error (ECONNRESET), never as a short body that
        // JSON-parses into "Unexpected end of JSON input" (observed live on
        // the preview chain). 204/304 and HEAD carry no body by definition.
        // P2-008 Step-3 direct mode: content-length is JS-visible ONLY on
        // identity (tarball) responses — on gzip packuments the browser
        // hides it, parseInt(undefined) is NaN, and the guard correctly does
        // not run. NEVER compare a decoded Fetch stream against an encoded
        // wire length (Phase-0 §0.3; acceptance criterion).
        const st = this.statusCode;
        this._cl = (expectBody && st !== 204 && st !== 304)
          ? parseInt(headers['content-length'], 10) : NaN;
        this._got = 0;
        // P2-006-008-2: the relay's end-to-end digest over the EXACT bytes it
        // sent — verified at stream end in _read. Survives proxies that
        // truncate, re-chunk or strip content-length: a mismatch surfaces as
        // a RETRYABLE ECONNRESET (npm retries), never as "invalid json".
        // P2-008 Step-0.5 OOM FIX: parts collection DOUBLES every body's
        // resident memory (a copy per chunk retained to stream end) — with
        // the unbounded browser-side fetch fan-out (164 in flight observed)
        // that pushed the install worker past 1 GB RSS on a 4 GB box
        // (OOM-killed mid-reify). The relay ALWAYS sends exact content-length
        // on the buffered path, and the CL guard alone catches truncation;
        // parts (and the digest) now run ONLY for bodies ≤ 2 MiB.
        this._wantSum = String(headers['x-nodine-sha256'] || '') || null;
        this._sumParts = (this._wantSum && Number.isFinite(this._cl) && this._cl <= 2 * 1024 * 1024) ? [] : null;
        this._counted = false; // pendingHttpFetches-- exactly once (done + destroy paths overlap)
      }
      _read() {
        if (this._reader === null) {
          if (!this.response.body) {
            this.complete = true;
            if (!this._counted) { this._counted = true; pendingHttpFetches--; lastHttpActivityAt = Date.now(); }
            this.push(null);
            return;
          }
          this._reader = this.response.body.getReader();
        }
        const reader = this._reader;
        reader.read().then(({ done, value }) => {
          if (done) {
            const finish = () => {
              this.complete = true;
              if (!this._counted) {
                this._counted = true; pendingHttpFetches--; lastHttpActivityAt = Date.now();
                // P2-008 E6: the perf record rides on the SAME once-guard as
                // pendingHttpFetches — 'done' + _destroy both fire on the
                // normal end path, and an unguarded counter would double-count
                // bytes/requests in BOTH the liveness counter and perf stats.
                perfNetDone(this.__pfIdx, { endMs: +(nowMs().toFixed(1)), bytes: this._got, ok: true });
              }
              traceLife('http-body-end', this._got + '/' + (Number.isFinite(this._cl) ? this._cl : '?') + 'B ' + this.url.pathname);
              if (Number.isFinite(this._cl) && this._got < this._cl) {
                const err = new Error('Response truncated: got ' + this._got + ' of ' + this._cl + ' bytes for ' + this.url);
                err.code = 'ECONNRESET';
                this.destroy(err);
                return;
              }
              this.push(null);
            };
            if (this._sumParts) {
              if (!platformCrypto || !platformCrypto.subtle) { this._sumParts = null; finish(); return; }
              // verify the relay's sha256 over the bytes THIS side received
              const parts = this._sumParts;
              this._sumParts = null;
              let total = 0;
              for (let i = 0; i < parts.length; i++) total += parts[i].byteLength;
              const all = new Uint8Array(total);
              let off = 0;
              for (let i = 0; i < parts.length; i++) { all.set(parts[i], off); off += parts[i].byteLength; }
              platformCrypto.subtle.digest('SHA-256', all).then((h) => {
                const u = new Uint8Array(h);
                let hex = '';
                for (let i = 0; i < u.length; i++) hex += (u[i] < 16 ? '0' : '') + u[i].toString(16);
                if (hex !== this._wantSum) {
                  traceLife('http-integrity-fail', this._got + 'B ' + this.url.pathname);
                  const err = new Error('Response integrity mismatch (sha256) after ' + this._got + ' bytes for ' + this.url);
                  err.code = 'ECONNRESET';
                  this.destroy(err);
                  return;
                }
                finish();
              }, (e) => this.destroy(e));
              return;
            }
            finish();
            return;
          }
          this._got += value.byteLength;
          if (this._sumParts) this._sumParts.push(new Uint8Array(value)); // copy: the consumer owns the original
          if (!this.push(value)) return; // respect backpressure
          this._read();
        }, (err) => { this.destroy(err); });
      }
      _destroy(err, cb) {
        if (!this._counted) {
          this._counted = true; pendingHttpFetches--; lastHttpActivityAt = Date.now();
          perfNetDone(this.__pfIdx, { endMs: +(nowMs().toFixed(1)), bytes: this._got, ok: !err, err: err ? String(err.code || err.message).slice(0, 80) : undefined });
        }
        if (this._reader) { try { this._reader.cancel(); } catch {} }
        cb(err);
      }
    }
    class ClientRequest extends EventEmitter {
      constructor(urlOrOptions, cb) {
        super();
        let opts = typeof urlOrOptions === 'string' || urlOrOptions instanceof URL
          ? { [typeof urlOrOptions === 'string' ? 'path' : 'href']: String(urlOrOptions) }
          : (urlOrOptions || {});
        // normalize the Node options shape
        const url = new URL(urlOrOptions instanceof URL ? urlOrOptions.href
          : (typeof urlOrOptions === 'string' ? urlOrOptions
          : ((opts.protocol || (isHttps ? 'https:' : 'http:')) + '//' + (opts.hostname || opts.host || 'localhost') + ((opts.port && ((':' + opts.port))) || '') + (opts.path || '/'))));
        this.url = url;
        this.method = (opts.method || 'GET').toUpperCase();
        this._headers = {};
        if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) this._headers[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        this._ended = false;
        this._aborted = false;
        this._body = [];
        this._controller = new __nodineNativeAbortController();
        this._timeoutMs = 0;
        this._socketEmitted = false;
        this._response = null;
        if (cb) this.on('response', cb);
      }
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v); return this; }
      getHeader(k) { return this._headers[String(k).toLowerCase()]; }
      get headersSent() { return this._ended; }
      removeHeader(k) { delete this._headers[String(k).toLowerCase()]; return this; }
      flushHeaders() { this._send(); }
      setTimeout(ms, cb) { this._timeoutMs = ms; if (cb) this.on('timeout', cb); return this; }
      abort() { this._aborted = true; this._controller.abort(); }
      destroy(err) { this._aborted = true; this._controller.abort(); if (err) this.emit('error', err); }
      write(chunk, _enc, cb) {
        if (chunk != null) this._body.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
        if (cb) cb();
        return true;
      }
      end(chunk, _enc, cb) {
        if (chunk) this.write(chunk);
        this._ended = true;
        if (typeof chunk === 'function') cb = chunk;
        if (cb) this.once('finish', cb);
        this.emit('finish');
        this._send();
        return this;
      }
      _send() {
        if (this._sent || this._aborted) return;
        this._sent = true;
        traceLife('http-req', this.method + ' ' + this.url.pathname);
        const headers = {};
        for (const [k, v] of Object.entries(this._headers)) {
          if (FORBIDDEN.has(k)) continue; // browser-controlled (documented)
          headers[k] = v;
        }
        const body = this._body.length === 0 ? undefined
          : (this._body.length === 1 ? this._body[0] : Buffer.concat(this._body));
        const hasStreamingBody = false;
        const signal = this._controller.signal;
        // P2-006-008: cross-origin requests carrying non-CORS-safelisted
        // headers (npm-auth-type, authorization, ...) cannot be sent from the
        // browser (registry.npmjs.org answers preflight with 404 — verified).
        // Route them through the same-origin egress relay (server.cjs /egress,
        // the dev-server stand-in for ADR-0004's service-worker virtual
        // network), which performs the exact request and streams the raw
        // response back. accept-encoding stays dropped so tarball bytes are
        // identity-encoded (npm hashes the compressed archive).
        let fetchUrl = this.url.href;
        let outHeaders = headers;
        let relayUsesPost = false;
        const sameOrigin = this.url.origin === self.location.origin;
        // P2-008 Step-3 Phase-2: the DIRECT NETWORK ADAPTER. For allowlisted
        // anonymous public HTTPS registry requests, skip the relay entirely —
        // browser fetch straight to the registry (Phase-0 evidence:
        // docs/perf/direct-network.md). The corgi gate runs HERE, on the
        // ORIGINAL npm headers (npm-command is required for the decision),
        // rewriting the accept to the preflight-free single-value corgi form.
        // A substituted request that answers 404/406/415 falls back to the
        // ORIGINAL full-metadata accept (pacote's own semantics, §2.3).
        let directPlan = null;
        if (!sameOrigin) {
          directPlan = directAdapterPlan(this.method, this.url, headers);
        }
        if (directPlan && directPlan.direct) {
          outHeaders = directPlan.fetchHeaders;
        } else {
          directPlan = null;
          if (!sameOrigin) {
            // Fetch-spec CORS safelist: content-type is ONLY safelisted for
            // application/x-www-form-urlencoded, multipart/form-data and
            // text/plain (P2-006-008-3 — npm's audit POST carries
            // application/json, which used to pass as "safelisted" here, went
            // DIRECT to the registry, preflighted, and the registry's 404
            // OPTIONS killed the whole fetch with "TypeError: network error").
            const SAFE = new Set(['accept', 'accept-language', 'content-language', 'range', 'user-agent']);
            const ctSafe = (v) => {
              const s = String(v).split(';')[0].trim().toLowerCase();
              return s === 'application/x-www-form-urlencoded' || s === 'multipart/form-data' || s === 'text/plain';
            };
            const needsRelay = Object.keys(headers).some((k) => !SAFE.has(k) && (k !== 'content-type' || !ctSafe(headers[k])));
            if (needsRelay) {
              // P2-008 Step-3 §2.6: a user-supplied proxy (NODINE_NETWORK_
              // PROXY_URL) replaces the built-in /egress hop. Requests are
              // never silently de-authenticated — the full original header set
              // rides the x-nodine-headers envelope, exactly like /egress.
              const cfg = directNetConfig();
              fetchUrl = cfg.proxyUrl ? new URL('egress', ensureTrailingSlash(cfg.proxyUrl)).href : urlUnder('egress');
              if (body !== undefined && this.method === 'GET') relayUsesPost = true; // fetch cannot GET with a body; the relay forwards the real method
              outHeaders = {
                'content-type': 'application/octet-stream',
                'x-nodine-url': this.url.href,
                'x-nodine-method': this.method,
                'x-nodine-headers': JSON.stringify(headers),
              };
            }
          }
        }
        if (this._timeoutMs > 0) {
          const t = setTimeout(() => { this._controller.abort(new Error('HTTP request timed out')); this.emit('timeout'); }, this._timeoutMs);
          signal.addEventListener('abort', () => clearTimeout(t), { once: true });
        }
        pendingHttpFetches++;
        // P2-EXIT: START stamp only — a request queued behind the 8-slot
        // semaphore (or stalled by the network) must not refresh the
        // keep-alive stand-in; only settled traffic does (see the undici
        // wrapper above for the full rationale).
        const __pfIdx = perfNetStart(this.url.href, this.method, fetchUrl !== this.url.href);
        const doFetch = (url, hdrs) => platformFetchGated(url, {
          method: relayUsesPost ? 'POST' : this.method,
          headers: hdrs,
          body: (body !== undefined && body !== null) ? (body instanceof Uint8Array ? body : Buffer.from(body)) : undefined,
          redirect: 'follow', // documented divergence: 3xx never surfaces to callers
          signal,
        });
        // Direct-mode plan resolution: corgi fallback (§2.3) + redirect
        // destination validation (§2.1 — treat metadata/redirect targets as
        // untrusted; only allowlisted hosts may be fetched).
        const resolveDirect = async (response) => {
          if (directPlan && directPlan.substituting && (response.status === 404 || response.status === 406 || response.status === 415)) {
            // abbreviated representation unavailable/insufficient → retry
            // with the ORIGINAL full-metadata accept, preserving semantics.
            DIRECT_CORGI_STATS.fellBack++; // Phase-4 counter
            perfNetDone(__pfIdx, { note: 'corgi-fallback' });
            const fb = await doFetch(fetchUrl, { accept: 'application/json' });
            return { response: fb, fellBack: true };
          }
          if (directPlan) {
            let dest = null;
            try { dest = new URL(response.url || fetchUrl); } catch { dest = null; }
            if (!dest || !directNetConfig().allow.has(String(dest.hostname || '').toLowerCase())) {
              const err = new Error('direct fetch redirect destination not allowlisted: ' + String(response.url));
              err.code = 'ERR_UNSAFE_REDIRECT';
              throw err;
            }
          }
          return { response, fellBack: false };
        };
        doFetch(fetchUrl, outHeaders).then((response) => {
          if (this._aborted) { pendingHttpFetches--; lastHttpActivityAt = Date.now(); return; }
          if (directPlan) return resolveDirect(response);
          return { response, fellBack: false };
        }).then((r2) => {
          const response = r2.response;
          if (this._aborted) { pendingHttpFetches--; lastHttpActivityAt = Date.now(); return; }
          if (!this._socketEmitted) { this._socketEmitted = true; this.emit('socket', this._dummySocket()); }
          this._response = response;
          if (r2.fellBack) traceLife('http-corgi-fallback', this.url.pathname);
          perfNetDone(__pfIdx, { ttfbMs: +(nowMs().toFixed(1)), status: response.status });
          const incoming = new IncomingMessage(response, this.url.href, this.method !== 'HEAD');
          incoming.__pfIdx = __pfIdx;
          this.emit('response', incoming);
        }, (err) => {
          pendingHttpFetches--;
          lastHttpActivityAt = Date.now();
          perfNetDone(__pfIdx, { endMs: +(nowMs().toFixed(1)), ok: false, err: String(err && err.message || err).slice(0, 80) });
          if (this._aborted) return;
          try { report({ type: 'http-bridge-err', url: String(this.url.href).slice(0, 100), error: String(err && (err.stack || err)).slice(0, 400) }); } catch {}
          this.emit('error', err);
        });
        if (!this._socketEmitted) {
          setImmediate(() => {
            if (!this._socketEmitted && !this._aborted) { this._socketEmitted = true; this.emit('socket', this._dummySocket()); }
          });
        }
      }
      _dummySocket() { return { destroyed: false, setEncoding() {}, setTimeout() {}, setNoDelay() {}, setKeepAlive() {}, on() {}, once() {}, end() {}, destroy() {}, ref() {}, unref() {}, remoteAddress: 'fetch-bridge' }; }
      on(ev, fn) { const r = super.on(ev, fn); return r; }
    }

    // ================= B1-PREVIEW: http.Server over the SW bridge ============
    // Batch 1 of the package/app separation: the browser worker's http
    // servers reach the browser through the page's preview service worker
    // (fully-browser transport — no host process, no host tunnel). When no
    // SW port was transferred (bare/embedded pages without SW registration)
    // listen() dark-listens (see PortServer.listen below).
    const darkServers = new Map(); // port -> server (dark-listened)
    // installPreviewSWPort lives at MODULE SCOPE (the init message can be
    // installed before this factory runs). Here we only register the http
    // factory's teardown hook for page-side 'preview-port-gone' notices.
    PREVIEW_SW_GONE_HOOKS.push((portNo) => {
      const rec = previewPorts.get(portNo);
      if (rec && rec.server && rec.server.listening) {
        try { rec.server.emit('close'); } catch {}
        rec.server.listening = false;
      }
      previewPorts.delete(portNo);
    });
    // 0.5.2 (LAN-SHARE): the bridge may come live AFTER listen() dark-listened
    // (the share panel attached while a dev server was already running).
    // Re-register every dark server on the bridge so the running server
    // becomes reachable without a restart. listenViaSW re-adds the server to
    // darkServers on ack ("uniform close() bookkeeping"), so drop the entry
    // here to avoid double-registration.
    PREVIEW_BRIDGE_LIVE_HOOKS.push(() => {
      for (const [portNo, srv] of [...darkServers]) {
        if (!srv || !srv.listening) { darkServers.delete(portNo); continue; }
        if (listenViaSW(portNo, srv)) darkServers.delete(portNo);
      }
    });

    // A preview request arriving on a per-port channel: parse head+body,
    // open a VirtualSocket + HTTP1Connection (the per-request parser),
    // wire response capture FIRST, then deliver the bytes.
    function onPreviewChanMsg(rec, m) {
      if (!m || m.type !== 'preview-req') return;
      const server = rec.server;
      if (!server || !server.listening) return;
      const cid = m.id; // SW request id doubles as the connection id
      if (rec.conns.has(cid)) return; // duplicate delivery
      const headU8 = platformTextEncoder.encode(m.head);
      const bodyU8 = m.body ? new Uint8Array(m.body) : null;
      const total = (bodyU8 && bodyU8.length) ? concatPreview(headU8, bodyU8) : headU8;
      // 1) socket + parser objects
      const sock = new VirtualSocket(rec.port, cid);
      rec.conns.set(cid, sock);
      const hc = new HTTP1Connection(server, sock);
      server._conns.set(cid, sock);
      server._httpConnections.set(cid, hc);
      // 2) response capture — wired BEFORE emitting 'connection'/'request'
      //    so a fully-synchronous handler (res.end in the same tick) still
      //    has its writes captured. VirtualSocket._send is per-instance.
      const send = (msg) => {
        if (!rec.chan) return;
        try { rec.chan.postMessage(msg); } catch {} // CLONE only — buffers may
        // be views into kernel shared memory; transferring would detach KSM.
      };
      sock._send = (b) => { try { console.error('[nodine-preview] res chunk', cid, b.length); } catch {} send({ type: 'preview-res', id: cid, bytes: b }); };
      // end-of-response: VirtualSocket.end fires on res.end with
      // Connection: close; keep-alive responses rely on the finish patch.
      const finishOnce = () => {
        if (sock.__previewDone) return;
        sock.__previewDone = true;
        try { console.error('[nodine-preview] res end', cid); } catch {}
        rec.conns.delete(cid);
        server._conns.delete(cid);
        server._httpConnections.delete(cid);
        send({ type: 'preview-res-end', id: cid });
      };
      const origEnd = sock.end.bind(sock);
      sock.end = (chunk, encOrCb, cb) => {
        if (chunk != null) sock.write(chunk, typeof encOrCb === 'function' ? undefined : encOrCb);
        finishOnce();
        sock.writable = false;
        sock.emit('close');
        const cb2 = typeof encOrCb === 'function' ? encOrCb : cb;
        if (cb2) cb2();
      };
      const origDestroy = sock.destroy.bind(sock);
      sock.destroy = () => {
        finishOnce();
        sock.destroyed = true; sock.writable = false;
        sock.emit('close');
      };
      // ServerResponse emits 'finish' after end() — catch it for keep-alive
      // responses whose socket stays open (real Node leaves the connection
      // for the next request; the SW bridge is one-request-per-connection).
      const patchRes = (res) => {
        if (!res || res.__previewPatched) return;
        res.__previewPatched = true;
        res.on('finish', () => { finishOnce(); });
      };
      // Intercept the single 'request' emit of THIS connection to patch its
      // ServerResponse, then restore the original emit (no per-request leak).
      const origEmit = server.emit;
      server.emit = function patchedEmit(evname, ...args) {
        server.emit = origEmit; // one-shot: the emit we care about is imminent
        if (evname === 'request' && args[1]) patchRes(args[1]);
        return origEmit.apply(this, [evname, ...args]);
      };
      // 3) deliver: connection + request bytes through the real parser
      try { server.emit('connection', sock); } catch {}
      try { hc.onBytes(total); } catch (e) {
        finishOnce();
        send({ type: 'preview-res-err', id: cid, error: String(e && e.message || e) });
      }
    }
    function concatPreview(a, b) {
      const out = new Uint8Array(a.length + b.length);
      out.set(a, 0); out.set(b, a.length);
      return out;
    }

    // listenViaSW(port, srv): async-first. Wait for the SW port, create the
    // per-port channel, hand the SW side to the supervisor (which forwards it
    // to the SW as preview-port-open and records the port for its registry),
    // then emit 'listening'. MessagePort queues survive transfer: the SW's
    // preview-open-ack (or an early request) posted after its registration
    // is delivered on our port1 whenever the SW gets to it. Returns false
    // ONLY when no bridge exists (→ dark-listen).
    function listenViaSW(port, srv) {
      if (!PREVIEW_SW_PORT && !PREVIEW_SW_PORT_READY) return false;
      const rec = {
        port, server: srv, chan: null, conns: new Map(),
        ackWaiter: null,
      };
      previewPorts.set(port, rec);
      srv.__previewRec = rec;
      const whenReady = PREVIEW_SW_PORT_READY || Promise.resolve();
      whenReady.then(() => {
        if (!PREVIEW_SW_PORT || !CHANNEL_PORT) return; // no bridge — cleanup below
        const { port1, port2 } = new platformMessageChannel();
        rec.chan = port1;
        platformArmPort(port1, (cev) => {
          const m = cev.data;
          if (!m || typeof m !== 'object') return;
          if (m.type === 'preview-open-ack') { try { console.error('[nodine-preview] ack on :' + port); } catch {} rec.ackWaiter && rec.ackWaiter(); return; }
          if (m.type === 'preview-req') { try { console.error('[nodine-preview] req', m.id, String(m.head || '').split('\r\n')[0]); } catch {} onPreviewChanMsg(rec, m); return; }
        });
        // Ask the SW (via supervisor forward) to register this port; the SW
        // acks ON THIS CHANNEL (queued even if we get there first).
        CHANNEL_PORT.postMessage({ type: 'preview-port-open', port }, [port2]);
        // 10 s without an ack → no SW registered; surface a real error.
        new Promise((resolveAck) => {
          const to = setTimeout(() => resolveAck('timeout'), 10000);
          rec.ackWaiter = () => { clearTimeout(to); resolveAck('ack'); };
        }).then((r) => {
          rec.ackWaiter = null;
          if (r === 'timeout') {
            previewPorts.delete(port);
            try { port1.close(); } catch {}
            srv.emit('error', new Error('preview bridge unavailable (no service worker?)'));
            return;
          }
          darkServers.set(port, srv); // uniform close() bookkeeping
          srv.port = port;
          srv.listening = true;
          platformMessagePost({ type: 'port-open', port }); // supervisor event
          srv.emit('listening');
        });
      });
      return true;
    }
    function unlistenViaSW(port) {
      const rec = previewPorts.get(port);
      if (!rec) return;
      previewPorts.delete(port);
      for (const [cid, sock] of rec.conns) { try { sock.destroy && sock.destroy(); } catch {} }
      if (rec.chan) { try { rec.chan.close(); } catch {} }
      if (PREVIEW_SW_PORT) {
        try { PREVIEW_SW_PORT.postMessage({ type: 'preview-port-close', port }); } catch {}
      }
      if (CHANNEL_PORT) {
        try { CHANNEL_PORT.postMessage({ type: 'preview-port-close', port }); } catch {}
      }
      platformMessagePost({ type: 'port-close', port });
    }

    class VirtualSocket extends EventEmitter {
      constructor(port, connId) {
        super();
        this.port = port; this.connId = connId;
        this.remoteAddress = '127.0.0.1';
        this.remotePort = port;
        this.localAddress = '127.0.0.1';
        this.destroyed = false;
        this.writable = true;
        this.readable = true;
        this._pendingWrite = null;
        this._buffer = null;
      }
      write(chunk, encOrCb, cb) {
        const cb2 = typeof encOrCb === 'function' ? encOrCb : cb;
        try {
          const b = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk), typeof encOrCb === 'string' ? encOrCb : undefined);
          this._send(b);
        } catch (e) { if (cb2) cb2(e); return false; }
        if (cb2) cb2();
        return true;
      }
      // Transport plumbing is per-instance: every live bridge path
      // (onPreviewChanMsg) overrides _send/end/destroy on the instance and
      // routes bytes to the preview service-worker channel. The class
      // defaults exist so an un-overridden socket degrades quietly —
      // there is no fallback transport.
      _send() {}
      end(chunk, cb) { if (chunk) this.write(chunk); this.writable = false; this.emit('close'); if (cb) cb(); }
      destroy() { this.destroyed = true; this.writable = false; this.emit('close'); }
      setNoDelay() { return this; }
      setKeepAlive() { return this; }
      setTimeout(ms, cb) { if (cb) this.on('timeout', cb); return this; }
      ref() { return this; }
      unref() { return this; }
      pause() { return this; }
      resume() { return this; }
      setEncoding() { return this; }
      _onData(bytes) { this.emit('data', bytes); }
      _onClose() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
    }

    class ServerResponse extends EventEmitter {
      constructor(socket, req) {
        super();
        this.socket = socket;
        this.req = req;
        this._headers = {};
        this._headerNames = {};
        this.statusCode = 200;
        this.statusMessage = undefined;
        this.headersSent = false;
        this.finished = false;
        this._chunks = [];
        this.useChunkedEncodingByDefault = true;
        this._shouldKeepAlive = true;
      }
      assignSocket(s) { this.socket = s; }
      get headers() { return this._headers; }
      setHeader(k, v) { const lk = String(k).toLowerCase(); this._headers[lk] = v; this._headerNames[lk] = String(k); return this; }
      // B11: Node ≥18 API — on-headers@1.1.0 probes
      // ServerResponse.prototype.appendHeader AT MODULE LOAD
      // ('typeof http.ServerResponse.prototype.appendHeader') to pick its
      // header-merge strategy; the class was not exported from the http
      // bridge at all, so the probe crashed expo's dev-server middleware
      // chain with 'Cannot read properties of undefined (reading
      // 'prototype')' (observed live: npm start → expo start → on-headers).
      appendHeader(k, v) {
        const lk = String(k).toLowerCase();
        const prev = this._headers[lk];
        if (prev === undefined) this.setHeader(k, v);
        else {
          const merged = Array.isArray(prev) ? prev.concat(v) : (Array.isArray(v) ? [prev].concat(v) : [prev, v]);
          this._headers[lk] = merged; this._headerNames[lk] = String(k);
        }
        return this;
      }
      getHeader(k) { return this._headers[String(k).toLowerCase()]; }
      getHeaderNames() { return Object.keys(this._headers); }
      getHeaders() { return this._headers; }
      removeHeader(k) { delete this._headers[String(k).toLowerCase()]; }
      hasHeader(k) { return Object.prototype.hasOwnProperty.call(this._headers, String(k).toLowerCase()); }
      flushHeaders() { this._implicitHead(); }
      writeContinue() { try { this.socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n')); } catch {} }
      writeHead(status, reasonOrHeaders, headers) {
        if (this.headersSent) return this;
        let reason = this.statusMessage;
        if (typeof reasonOrHeaders === 'string') reason = reasonOrHeaders;
        else if (reasonOrHeaders && typeof reasonOrHeaders === 'object') headers = reasonOrHeaders;
        this.statusCode = status;
        if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
        this._implicitHead(reason);
        return this;
      }
      _statusLine(reason) {
        const code = this.statusCode || 200;
        const text = reason || this.statusMessage || STATUS_TEXTS[code] || 'OK';
        return 'HTTP/1.1 ' + code + ' ' + text + '\r\n';
      }
      _implicitHead(reason) {
        if (this.headersSent) return;
        this.headersSent = true;
        const names = Object.keys(this._headers);
        if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) {
          if (this.useChunkedEncodingByDefault) this.setHeader('Transfer-Encoding', 'chunked');
          else this.setHeader('Content-Length', '0');
        }
        if (!this.hasHeader('date')) this.setHeader('Date', new Date().toUTCString());
        if (!this.hasHeader('connection')) this.setHeader('Connection', this._shouldKeepAlive ? 'keep-alive' : 'close');
        let head = this._statusLine(reason);
        for (const lk of Object.keys(this._headers)) {
          head += (this._headerNames[lk] || lk) + ': ' + this._headers[lk] + '\r\n';
        }
        head += '\r\n';
        try { this.socket.write(Buffer.from(head, 'latin1')); } catch {}
      }
      write(chunk, encOrCb, cb) {
        const cb2 = typeof encOrCb === 'function' ? encOrCb : cb;
        if (!this.headersSent) this._implicitHead();
        if (chunk == null) { if (cb2) cb2(); return true; }
        const b = chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof encOrCb === 'string' ? encOrCb : 'utf8');
        if (this.hasHeader('content-length')) { try { this.socket.write(b); } catch (e) { if (cb2) cb2(e); } }
        else {
          const hex = b.length.toString(16);
          const prefix = Buffer.from(hex + '\r\n', 'latin1');
          const suffix = Buffer.from('\r\n', 'latin1');
          try { this.socket.write(Buffer.concat([prefix, b, suffix])); } catch (e) { if (cb2) cb2(e); }
        }
        if (cb2) cb2();
        return true;
      }
      end(chunk, encOrCb, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = null; }
        if (typeof encOrCb === 'function') { cb = encOrCb; encOrCb = null; }
        if (!this.headersSent) {
          // head not sent: buffer everything, send with content-length
          const b = chunk == null ? Buffer.alloc(0) : (chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), encOrCb || 'utf8'));
          if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) this.setHeader('Content-Length', String(b.length));
          this.useChunkedEncodingByDefault = false;
          this._implicitHead();
          if (b.length) { try { this.socket.write(b); } catch {} }
        } else if (chunk != null) {
          this.write(chunk, encOrCb);
        }
        if (this.hasHeader('transfer-encoding')) { try { this.socket.write(Buffer.from('0\r\n\r\n', 'latin1')); } catch {} }
        this.finished = true;
        this.emit('finish');
        if (cb) cb();
        if (!this._shouldKeepAlive) { try { this.socket.end(); } catch {} }
        else this.req && this.req._resumeParser && this.req._resumeParser();
        return this;
      }
      destroy() { try { this.socket.destroy(); } catch {} }
    }

    const STATUS_TEXTS = { 200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 413: 'Payload Too Large', 416: 'Range Not Satisfiable', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

    class ServerIncomingMessage extends EventEmitter {
      constructor(socket) {
        super();
        this.socket = socket;
        this.method = 'GET';
        this.url = '/';
        this.headers = {};
        this.httpVersion = '1.1';
        this.rawHeaders = [];
        this.trailers = {};
        this.complete = false;
        this._bodyQueue = [];
        this._bodyListeners = false;
        this._paused = false;
      }
      setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
      _pushBody(chunk) {
        this._bodyQueue.push(chunk);
        this._drainBody();
      }
      _drainBody() {
        if (!this._bodyListeners || this._paused) return;
        while (this._bodyQueue.length > 0) {
          const c = this._bodyQueue.shift();
          this.emit('data', c);
        }
      }
      on(ev, fn) {
        const r = super.on(ev, fn);
        if (ev === 'data') { this._bodyListeners = true; this._drainBody(); }
        return r;
      }
      pipe(dest) { this.on('data', (c) => { try { dest.write(c); } catch {} }); this.on('end', () => { try { dest.end && dest.end(); } catch {} }); return dest; }
      pause() { this._paused = true; return this; }
      resume() { this._paused = false; this._drainBody(); return this; }
      _resumeParser() { this._paused = false; this._drainBody(); }
    }

    class PortServer extends EventEmitter {
      constructor(handler) {
        super();
        if (handler) this.on('request', handler);
        this.listening = false;
        this.port = 0;
        this._conns = new Map();
        this._httpConnections = new Map();
      }
      listen(...args) {
        let port = 0, host, backlog, cb;
        for (const a of args) {
          if (typeof a === 'function') cb = a;
          else if (typeof a === 'number') { if (port === 0) port = a; else backlog = a; }
          else if (typeof a === 'string') { if (!host) host = a; }
          else if (a && typeof a === 'object') { port = a.port ?? port; host = a.host ?? host; }
        }
        if (cb) this.once('listening', cb);
        // B1-PREVIEW: the fully-browser SW transport is the ONLY transport —
        // there is no host tunnel.
        if (listenViaSW(port, this)) return this;
        // B14 DARK-LISTEN: no SW bridge (its site-wide registration can be
        // undesirable on shared origins — see BootOptions.enablePreview), so
        // listen() still SUCCEEDS: mark listening, remember the port, emit
        // 'listening'. No external connections can arrive; dev servers
        // (expo/Metro, vite, webpack serve) reach their banner + interactive
        // mode, which is the terminal-session contract.
        darkServers.set(port, this);
        this.__dark = true;
        this.port = port;
        this.listening = true;
        platformMessagePost({ type: 'port-open', port }); // supervisor event
        setImmediate(() => this.emit('listening'));
        return this;
      }
      address() { return this.listening ? { port: this.port, family: 'IPv4', address: '127.0.0.1' } : null; }
      close(cb) {
        if (this.port) {
          darkServers.delete(this.port);
          if (this.__previewRec) unlistenViaSW(this.port); // B1-PREVIEW
        }
        this.listening = false;
        for (const [, s] of this._conns) { try { s.destroy(); } catch {} }
        if (cb) this.once('close', cb);
        setImmediate(() => this.emit('close'));
        return this;
      }
      ref() { return this; }
      unref() { return this; }
      getConnections(cb) { if (cb) cb(null, this._conns.size); }
      setTimeout() { return this; }
      keepAliveTimeout() {}
    }

    class HTTP1Connection {
      constructor(server, socket) {
        this.server = server;
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        this.req = null;
        this.res = null;
        this.bodyRemaining = 0; // content-length remaining
        this.chunked = false;
        this.chunkState = 0; // 0=headers 1=size 2=data 3=trailers
        this.chunkRemaining = 0;
      }
      onBytes(bytes) {
        this.buf = this.buf.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.buf, bytes]);
        this.parse();
      }
      onClose() { if (this.req && !this.req.complete) { this.req.complete = true; } }
      parse() {
        for (;;) {
          if (!this.req) {
            const idx = this.buf.indexOf('\r\n\r\n');
            if (idx === -1) {
              if (this.buf.length > 64 * 1024) { try { this.socket.destroy(); } catch {} }
              return;
            }
            const head = this.buf.subarray(0, idx).toString('latin1');
            this.buf = this.buf.subarray(idx + 4);
            const lines = head.split('\r\n');
            const reqLine = lines[0] || '';
            const m = /^([A-Z]+)\s+(\S+)\s+HTTP\/(\d)\.(\d)$/.exec(reqLine);
            if (!m) { try { this.socket.destroy(); } catch {} return; }
            const req = new ServerIncomingMessage(this.socket);
            req.method = m[1];
            req.url = m[2];
            req.httpVersion = m[3] + '.' + m[4];
            const rawHeaders = [];
            const headers = {};
            for (let i = 1; i < lines.length; i++) {
              const c = lines[i].indexOf(':');
              if (c <= 0) continue;
              const name = lines[i].slice(0, c).trim();
              const val = lines[i].slice(c + 1).trim();
              rawHeaders.push(name, val);
              const lk = name.toLowerCase();
              if (headers[lk] !== undefined) headers[lk] += ', ' + val;
              else headers[lk] = val;
            }
            req.rawHeaders = rawHeaders;
            req.headers = headers;
            this.req = req;
            this.res = new ServerResponse(this.socket, req);
            const te = String(headers['transfer-encoding'] || '').toLowerCase();
            this.chunked = te.includes('chunked');
            this.bodyRemaining = this.chunked ? 0 : (parseInt(headers['content-length'], 10) || 0);
            this.chunkState = this.chunked ? 1 : 0;
            // emit request
            const isUpgrade = (headers['connection'] || '').toLowerCase().includes('upgrade');
            if (isUpgrade) {
              req.complete = true;
              try { this.server.emit('upgrade', req, this.socket, Buffer.from(this.buf)); } catch (e) { try { this.socket.destroy(); } catch {} }
              this.req = null; this.res = null; this.buf = Buffer.alloc(0);
              return; // connection handed to the upgrader
            }
            try { this.server.emit('request', req, this.res); } catch (e) { try { this.res.destroy(); } catch {} }
            continue;
          }
          // body phase
          if (this.chunked) {
            if (this.chunkState === 1) {
              const nl = this.buf.indexOf('\r\n');
              if (nl === -1) return;
              const sizeHex = this.buf.subarray(0, nl).toString('latin1').split(';')[0].trim();
              this.chunkRemaining = parseInt(sizeHex, 16) || 0;
              this.buf = this.buf.subarray(nl + 2);
              if (this.chunkRemaining === 0) {
                this.chunkState = 3; // trailers until blank line
                continue;
              }
              this.chunkState = 2;
              continue;
            }
            if (this.chunkState === 2) {
              if (this.buf.length === 0) return;
              const take = Math.min(this.buf.length, this.chunkRemaining);
              const piece = this.buf.subarray(0, take);
              this.buf = this.buf.subarray(take);
              this.chunkRemaining -= take;
              if (this.chunkRemaining === 0) this.chunkState = 1; // consume CRLF next round
              this.req._pushBody(Buffer.from(piece));
              continue;
            }
            if (this.chunkState === 3) {
              const idx = this.buf.indexOf('\r\n');
              if (idx === -1) return;
              this.buf = this.buf.subarray(idx + 2);
              this.req.complete = true;
              this.req.emit('end');
              this.req = null; this.res = null;
              continue;
            }
          } else {
            if (this.bodyRemaining > 0) {
              if (this.buf.length === 0) return;
              const take = Math.min(this.buf.length, this.bodyRemaining);
              const piece = this.buf.subarray(0, take);
              this.buf = this.buf.subarray(take);
              this.bodyRemaining -= take;
              this.req._pushBody(Buffer.from(piece));
              if (this.bodyRemaining === 0) {
                this.req.complete = true;
                this.req.emit('end');
                this.req = null; this.res = null;
                continue;
              }
              return;
            }
            // no body expected
            this.req.complete = true;
            this.req.emit('end');
            this.req = null; this.res = null;
            continue;
          }
        }
      }
    }

    function request(options, cb) {
      return new ClientRequest(options, cb);
    }
    function get(options, cb) {
      const req = request(options, cb);
      req.end();
      return req;
    }
    Object.assign(exports, {
      Agent, globalAgent, ClientRequest, IncomingMessage,
      request, get,
      // P2-006-008: the in-runtime http Server (real request parsing; no
      // TCP — inbound connections arrive via the preview SW bridge).
      Server: PortServer,
      createServer(handler) { return new PortServer(handler); },
      // B11: the response class — middleware (on-headers, compression,
      // morgan) reads http.ServerResponse.prototype at require time; a
      // missing export killed the whole expo dev-server middleware chain.
      ServerResponse,
      // Node exposes OutgoingMessage as ServerResponse's prototype chain —
      // minimal stand-in for instanceof checks in the wild.
      OutgoingMessage: ServerResponse,
      METHODS: ['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'],
      STATUS_CODES: STATUS_TEXTS,
      maxHeaderSize: 16384,
    });
  };
}
BRIDGE_BUILTINS.set('http', bridgeHttpFactory(false));
BRIDGE_BUILTINS.set('https', bridgeHttpFactory(true));
// ===== internal/deps/undici/undici (B15 + P2-EXIT) =====
// The libsources shim maps the global fetch onto the raw platform fetch —
// a PENDING PROMISE the quiet gate cannot see: waitForQuit's allQuiet
// counts pendingHttpFetches (http-bridge requests), but a global fetch
// bypasses the bridge. A process whose only pending work is a global
// fetch (create-expo's fetch('https://api.expo.dev/v2/versions')) was
// declared quiet and exited 0 MID-AWAIT: empty project dir, no error,
// "Install done" never printed (root cause of the create-expo-app
// empty-folder bug). Bridge the module and wrap fetch with the SAME
// liveness counter so a pending global fetch holds the process open
// exactly like a bridge request. Everything else re-exports the platform
// classes verbatim — identical shape to the libsources shim it replaces.
BRIDGE_BUILTINS.set('internal/deps/undici/undici', (exports) => {
  const P = globalThis.__nodinePlatformWeb || {};
  const rawFetch = P.fetch;
  // P2-EXIT (B15 follow-up): undici TIMEOUT PARITY. B15 made a pending
  // global fetch hold the process open (pendingHttpFetches++ until settle)
  // — correct liveness semantics, but the wrapper had NO timeout, and real
  // Node's global fetch is undici with headersTimeout=300s / bodyTimeout
  // =300s defaults: a request that never gets an answer REJECTS at 300 s.
  // The raw platform fetch can stay pending FOREVER (Brave Shields stalls
  // requests instead of erroring them; plain Chromium rejects them), so a
  // never-settling fetch held the process open indefinitely — observed live
  // twice in the create-expo-app flow: the npm child printed "added N
  // packages", then its ONLY live work was a stalled fetch (life-snap
  // http=1 on every heartbeat, 90+ s, no proc-exit ever posted) while the
  // 2 s keep-alive-socket stand-in in waitForQuit kept refreshing on the
  // START stamp the old wrapper wrote; the parent chain (sh →
  // create-expo-app → npx) then correctly refused to die on a live child
  // and the Demo❯ prompt never returned. Root fix: enforce the SAME
  // deadline undici enforces — 300 s from dispatch, covering the whole
  // promise (undici splits it into headersTimeout 300 s + bodyTimeout
  // 300 s; a single total deadline is the conservative common
  // denominator: it can only fire earlier than undici's worst case,
  // never later). A caller's own init.signal still wins (it rejects the
  // platform fetch first); this is a backstop for requests the network
  // never answers. NODINE_FETCH_TIMEOUT_MS overrides (0 disables),
  // mirroring undici's configurable dispatcher timeouts.
  const FETCH_TIMEOUT_MS = (() => {
    let v = null;
    try { v = INIT && INIT.env && INIT.env.NODINE_FETCH_TIMEOUT_MS; } catch {}
    const n = parseInt(v || '', 10);
    return Number.isFinite(n) && n >= 0 ? n : 300000; // undici default
  })();
  exports.fetch = typeof rawFetch === 'function'
    ? function fetch(input, init) {
        // Chain the caller's signal into ours so an external abort rejects
        // the platform fetch FIRST (semantics unchanged for well-behaved
        // callers like pacote's 30 s timeout signal).
        const outerSignal = (init && typeof init === 'object') ? init.signal : undefined;
        const ac = new __nodineNativeAbortController();
        if (outerSignal) {
          if (outerSignal.aborted) ac.abort(outerSignal.reason);
          else outerSignal.addEventListener('abort', () => ac.abort(outerSignal.reason), { once: true });
        }
        pendingHttpFetches++;
        // P2-EXIT: stamp START, not "activity". waitForQuit's keep-alive
        // stand-in treats lastHttpActivityAt as FRESH activity; a fetch
        // stalled for T seconds must not look alive just for being pending
        // (that is what held the create-expo npm child open: each new
        // pending fetch reset the 2 s stand-in, forever). Activity is now
        // stamped ONLY when a fetch settles — when bytes actually moved.
        const startedAt = Date.now();
        const timeoutErr = () => {
          const err = new Error('fetch timeout after ' + FETCH_TIMEOUT_MS + 'ms (undici headersTimeout parity)');
          err.name = 'TimeoutError'; // undici/DOM naming
          err.code = 'UNDICI_HEADERS_TIMEOUT';
          return err;
        };
        let timer = null;
        if (FETCH_TIMEOUT_MS > 0) {
          timer = platformSetTimeout(() => {
            if (timer === null) return;
            timer = null;
            ac.abort(timeoutErr());
          }, FETCH_TIMEOUT_MS);
        }
        const mergeInit = (init && typeof init === 'object') ? { ...init, signal: ac.signal } : { signal: ac.signal };
        let p;
        try {
          p = rawFetch(input, mergeInit);
        } catch (err) {
          pendingHttpFetches--;
          if (timer) { platformClearTimeout(timer); timer = null; }
          throw err;
        }
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          pendingHttpFetches--;
          if (timer) { platformClearTimeout(timer); timer = null; }
          lastHttpActivityAt = Date.now(); // real movement — refresh the stand-in
        };
        if (FETCH_TIMEOUT_MS > 0) {
          // diagnostic: name the keeper if the backstop is the thing that
          // fired (a 300 s stall is worth a life-ring line)
          platformSetTimeout(() => {
            if (!settled) traceLife('global-fetch-stalled', ((Date.now() - startedAt) / 1000).toFixed(0) + 's ' + String(typeof input === 'string' ? input : (input && input.url) || input).slice(0, 90));
          }, FETCH_TIMEOUT_MS);
        }
        p.then(settle, settle);
        return p;
      }
    : undefined;
  exports.FormData = P.FormData;
  exports.Headers = P.Headers;
  exports.Request = P.Request;
  exports.Response = P.Response;
  exports.MessageEvent = P.MessageEvent;
  exports.CloseEvent = P.CloseEvent;
  exports.ErrorEvent = P.ErrorEvent;
  exports.EventSource = P.EventSource;
  exports.WebSocket = P.WebSocket;
  exports.createFastMessageEvent = (type, init) => new P.MessageEvent(type, init);
  exports.setGlobalDispatcher = () => {};
  exports.getGlobalDispatcher = () => null;
  exports.EnvHttpProxyAgent = class EnvHttpProxyAgent {};
  exports.ProxyAgent = class ProxyAgent {};
  exports.Agent = class Agent {};
  exports.Dispatcher = class Dispatcher {};
  exports.Pool = class Pool {};
  exports.Client = class Client {};
});
BRIDGE_BUILTINS.set('tls', (exports, require) => {
  // Loadable surface for require('tls') consumers (agent-base etc.):
  // real TLS handshakes need raw sockets — unsupported (egress is
  // fetch-backed, ADR-0004). Construction/connect fail honestly.
  const { EventEmitter } = require('events');
  class TLSSocket extends EventEmitter {
    constructor() { super(); const e = new Error('tls.TLSSocket: raw TLS sockets are unsupported in the browser runtime (fetch-backed egress)'); e.code = 'ENOTSUP'; throw e; }
  }
  class SecureContext {}
  exports.TLSSocket = TLSSocket;
  exports.Server = class extends EventEmitter { constructor() { const e = new Error('tls.Server: unsupported'); e.code = 'ENOTSUP'; throw e; } };
  exports.SecureContext = SecureContext;
  exports.connect = function connect() { const e = new Error('tls.connect: raw TLS sockets are unsupported in the browser runtime'); e.code = 'ENOTSUP'; throw e; };
  exports.createSecureContext = () => new SecureContext();
  exports.createServer = () => { const e = new Error('tls.createServer: unsupported'); e.code = 'ENOTSUP'; throw e; };
  exports.DEFAULT_MIN_VERSION = 'TLSv1.2';
  exports.DEFAULT_MAX_VERSION = 'TLSv1.3';
  exports.rootCertificates = [];
  exports.getCiphers = () => [];
});
BRIDGE_BUILTINS.set('http2', (exports) => {
  // @sigstore/sign requires http2 at load and reads constants only.
  const c = {};
  for (const k of ['NGHTTP2_NO_ERROR','NGHTTP2_PROTOCOL_ERROR','HTTP2_HEADER_STATUS','HTTP2_HEADER_METHOD','HTTP2_HEADER_PATH','HTTP2_HEADER_AUTHORITY','HTTP2_HEADER_SCHEME','HTTP_STATUS_OK']) c[k] = 0;
  exports.constants = c;
  exports.connect = () => { const e = new Error('http2: unsupported in the browser runtime'); e.code = 'ENOTSUP'; throw e; };
  exports.createServer = () => { const e = new Error('http2: unsupported'); e.code = 'ENOTSUP'; throw e; };
});
BRIDGE_BUILTINS.set('dgram', (exports) => {
  exports.createSocket = () => { const e = new Error('dgram: UDP sockets are unsupported in the browser runtime'); e.code = 'ENOTSUP'; throw e; };
});
BRIDGE_BUILTINS.set('worker_threads', (exports, require) => {
  // expo 2g + write-file-atomic require worker_threads at LOAD.
  exports.isMainThread = true;
  exports.threadId = 0;
  exports.workerData = null;
  exports.parentPort = null;
  exports.resourceLimits = {};
  exports.markAsUntransferable = () => {};
  exports.moveMessagePortToContext = () => { throw new Error('unsupported'); };
  exports.receiveMessageOnPort = () => undefined;
  exports.MessagePort = require('internal/worker/io').MessagePort || class {};
  // M1.7A: the platform MessageChannel with Node-isms grafted on. The old
  // `class {}` stub had NO port1/port2 — the pnpm-wasm harness's lifetime
  // channel died at `lifetime.port1.start()` (undefined port). Browser
  // MessagePort has start()/close(); ref()/unref() are Node liveness
  // concepts — no-op substitutes (our loop-liveness counters own the
  // event-loop semantics).
  exports.MessageChannel = class MessageChannel {
    constructor() {
      const ch = new platformMessageChannel();
      for (const side of ['port1', 'port2']) {
        const port = ch[side];
        if (port && typeof port.ref !== 'function') { try { port.ref = () => port; port.unref = () => port; } catch { } }

      }
      this.port1 = ch.port1;
      this.port2 = ch.port2;
    }
  };
  // M1.7A: browser-Worker-backed Worker. The entry (VFS path or file:
  // URL) is bundled to a blob URL (module graph resolved from the VFS,
  // node:worker_threads redirected to the nested-worker prelude), then
  // started on a REAL nested browser Worker. The browser worker executes
  // the actual WASM thread workload (wasi-threads protocol); all fs/host
  // ops are RPC'd back to the parent — by design of the pnpm harness.
  exports.Worker = class Worker {
    constructor(entry, options = {}) {
      const raw = entry instanceof URL ? entry.href : String(entry);
      let p = raw.startsWith('file:') ? decodeURIComponent(raw.slice('file://'.length)) : raw;
      // Node accepts 'data:'/'blob:' too; we only serve VFS paths here.
      const data = options.workerData !== undefined ? options.workerData : null;
      const { url, modules } = pnpm_wasmNodeSupport.bundleWorkerEntry(p);
      // workerData (SABs included — structured clone SHARES them) is
      // posted as the FIRST message; the bootstrap waits for it before
      // importing the entry, so the prelude's `workerData` is real.
      // M1.7A-b4 FIX (install hang): the old boot set self.onmessage =
      // null after workerData, so any message arriving during the
      // module-graph evaluation window was DROPPED. wasi-threads posts
      // 'load'+'start' IMMEDIATELY after Worker construction for pool
      // exhaustion (allocateAndLoadWorker does not await whenLoaded —
      // upstream relies on the worker-side handler queueing early
      // starts). The 4 preloaded pool workers are always booted before
      // their first message (preloadWorkers awaits the loaded ack), so
      // `pnpm --version` passed; pnpm install's 5th+ pthread spawn hit
      // the gap, its load/start vanished, the thread never ran — the
      // endless worker-bundle/worker-created churn + zero-output hang.
      // Trampoline now: early messages queue in an inbox; the prelude
      // (pnpm_wasmPreludeUrl) drains it when it installs its handler.
      const boot = [
        'globalThis.__NODINE_WORKER_BOOT__ = new Promise((resolve) => {',
        '  globalThis.__NODINE_WORKER_INBOX__ = [];',
        '  self.onmessage = function (e) {',
        '    if (e.data && e.data.__nodineWorkerData && globalThis.__NODINE_WORKER_DATA__ === undefined) {',
        '      globalThis.__NODINE_WORKER_DATA__ = e.data.value; resolve(); return;',
        '    }',
        '    globalThis.__NODINE_WORKER_INBOX__.push(e.data);',
        '  };',
        '});',
        // M1.7A-b4 DIAG: nested-worker lifecycle trace (postMessage to
        // parent rides the wasi-threads channel? NO — postMessage from the
        // worker goes to the PARENT Worker object's onmessage, which the
        // wasi-threads harness installed via worker.on('message'). Prefix
        // diag messages with __nodineWtDiag so the harness ignores them
        // (unknown __emnapi__ types are warned, not fatal) — TEMPORARY,
        // removed before commit.
        'const __wtDiag = (m) => { try { self.postMessage({ __nodineWtDiag: true, msg: m, t: Date.now() }); } catch {} };',
        'globalThis.__NODINE_WORKER_BOOT__.then(() => { __wtDiag("boot:workerData-ok importing"); import(' + JSON.stringify(url) + ').then(() => __wtDiag("boot:import-resolved"), (e) => __wtDiag("boot:import-REJECTED " + (e && e.message))); });',
      ].join('\n');
      const bootUrl = platformCreateObjectURL(new platformBlobCtor([boot], { type: 'text/javascript' }));
      const w = new platformWorkerCtor(bootUrl, { type: 'module' });
      w.postMessage({ __nodineWorkerData: true, value: data });
      this._worker = w;
      this._exited = false;
      this._listeners = { message: [], error: [], exit: [] };
      this._pendingExit = 0;
      w.onmessage = (e) => {
        if (e.data && e.data.__nodineWtDiag) { report({ type: 'worker-diag', msg: String(e.data.msg).slice(0, 250) }); return; } // M1.7A-b4 TEMP DIAG
        if (e.data && e.data.pnpmHostRpc) report({ type: 'worker-diag', msg: 'hostRpc:' + e.data.pnpmHostRpc.method + ' op=' + (e.data.pnpmHostRpc.args && e.data.pnpmHostRpc.args[0] && e.data.pnpmHostRpc.args[0].operation) }); // M1.7A-b4 TEMP DIAG
        if (e.data && e.data.pnpmWasiRpc) report({ type: 'worker-diag', msg: 'wasiRpc:' + e.data.pnpmWasiRpc.namespace + '.' + e.data.pnpmWasiRpc.name }); // M1.7A-b4 TEMP DIAG
        if (e.data && e.data.__emnapi__) report({ type: 'worker-diag', msg: 'emnapi:' + e.data.__emnapi__.type }); // M1.7A-b4 TEMP DIAG
        emitWorkerEvent(this, 'message', e.data);
      };
      w.onmessageerror = (e) => { emitWorkerEvent(this, 'error', normalizeWorkerError(e)); };
      w.onerror = (e) => {
        const err = e && e.message ? new Error(e.message + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '')) : new Error('worker error');
        emitWorkerEvent(this, 'error', err);
      };
      this._cleanup = pnpm_wasmNodeSupport.registerCleanup(() => { try { w.terminate(); } catch { } pnpm_wasmNodeSupport.noteWorkerStopped(); });
      pnpm_wasmNodeSupport.noteWorkerStarted();
      report({ type: 'worker-created', entry: p, modules });
    }
    postMessage (value, transferList) { this._worker.postMessage(value, transferList || []); }
    ref () { return this; }
    unref () { return this; }
    terminate () {
      if (this._terminated) return Promise.resolve(0);
      this._terminated = true;
      try { this._worker.terminate(); } catch { }
      if (this._cleanup) { this._cleanup.run(); this._cleanup = null; }
      else pnpm_wasmNodeSupport.noteWorkerStopped();
      emitWorkerEvent(this, 'exit', 0);
      return Promise.resolve(0);
    }
    get threadId () { return 1; }
    get stdin () { return null; }
    get stdout () { return null; }
    get stderr () { return null; }
    on (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return this; }
    once (ev, fn) { const g = (...a) => { this.off(ev, g); fn(...a); }; return this.on(ev, g); }
    off (ev, fn) { const l = this._listeners[ev]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return this; }
    // M1.7A: EventEmitter surface the harness uses on shutdown
    removeAllListeners (ev) { if (ev === undefined) this._listeners = { message: [], error: [], exit: [] }; else this._listeners[ev] = []; return this; }
    listenerCount (ev) { return (this._listeners[ev] || []).length; }
    eventNames () { return Object.keys(this._listeners).filter((k) => this._listeners[k].length > 0); }
    setMaxListeners () { return this; }
    getMaxListeners () { return 10; }
    emit (ev, ...args) { emitWorkerEvent(this, ev, ...args); return true; }
    addListener (ev, fn) { return this.on(ev, fn); }
    removeListener (ev, fn) { return this.off(ev, fn); }
  };
  function emitWorkerEvent (worker, ev, arg) {
    for (const fn of (worker._listeners[ev] || []).slice()) {
      try { fn(arg); } catch (e) { report({ type: 'worker-listener-error', error: String(e && e.stack || e).slice(0, 300) }); }
    }
  }
  function workerBridgeInlineData (data) {
    if (data === null || data === undefined) return 'null';
    // SharedArrayBuffer and plain data pass via structured-clone-compatible
    // literal embedding. Functions cannot (workerData in the harness is
    // { atomicControl: SharedArrayBuffer }).
    try {
      const seen = new Set();
      const enc = (v, d) => {
        if (d > 4) return 'null';
        if (v === null || v === undefined) return 'null';
        const t = typeof v;
        if (t === 'number' || t === 'boolean' || t === 'string') return JSON.stringify(v);
        if (t === 'bigint') return String(v) + 'n';
        if (t === 'function' || t === 'symbol') return 'null';
        if (v instanceof SharedArrayBuffer) {
          // SABs CANNOT be inlined — they must be TRANSFERRED/shared to keep
          // identity with the parent's view. Signal the caller.
          return { __sab: true };
        }
        if (Array.isArray(v)) return '[' + v.map((x) => enc(x, d + 1)).join(',') + ']';
        if (seen.has(v)) return 'null'; seen.add(v);
        return '({' + Object.keys(v).slice(0, 128).map((k) => JSON.stringify(k) + ':' + enc(v[k], d + 1)).join(',') + '})';
      };
      const r = enc(data, 0);
      if (r && typeof r === 'object' && r.__sab) return null; // caller falls back to transfer path
      return r;
    } catch { return null; }
    return null;
  }
});

const stages = [
  ['per_context/primordials', () => compileAndCall(
    'internal/per_context/primordials', PER_CONTEXT_PARAMS,
    [perContextExports, primordials, privateSymbols, perIsolateSymbols]),
    () => `${Object.keys(primordials).length} primordial entries`],
  ['per_context/domexception', () => compileAndCall(
    'internal/per_context/domexception', PER_CONTEXT_PARAMS,
    [perContextExports, primordials, privateSymbols, perIsolateSymbols]),
    () => typeof perContextExports.DOMException],
  ['per_context/messageport', () => compileAndCall(
    'internal/per_context/messageport', PER_CONTEXT_PARAMS,
    [perContextExports, primordials, privateSymbols, perIsolateSymbols]),
    () => typeof perContextExports.emitMessage],
  ['bootstrap/realm', () => compileAndCall(
    'internal/bootstrap/realm', REALM_PARAMS,
    [realmProcess, getLinkedBinding, getInternalBinding, primordials]),
    () => `loaders: internalBinding=${typeof capturedLoaders.internalBinding}, requireBuiltin=${typeof capturedLoaders.requireBuiltin}`],
  ['bootstrap/node', () => compileAndCall(
    'internal/bootstrap/node', BOOTSTRAP_PARAMS,
    [realmProcess, capturedLoaders.requireBuiltin, capturedLoaders.internalBinding, primordials]),
    () => 'global+process setup ran'],
  // The two web-exposure stages the P1-A2 harness SKIPPED — included here
  // (node_realm.cc:333-340): they install Node's OWN console/URL/timers/
  // queueMicrotask/MessageChannel/... over the worker's browser globals.
  ['bootstrap/web/exposed-wildcard', () => compileAndCall(
    'internal/bootstrap/web/exposed-wildcard', BOOTSTRAP_PARAMS,
    [realmProcess, capturedLoaders.requireBuiltin, capturedLoaders.internalBinding, primordials]),
    () => 'console+URL+TextEncoder+Event/EventTarget exposed'],
  ['bootstrap/web/exposed-window-or-worker', () => compileAndCall(
    'internal/bootstrap/web/exposed-window-or-worker', BOOTSTRAP_PARAMS,
    [realmProcess, capturedLoaders.requireBuiltin, capturedLoaders.internalBinding, primordials]),
    () => 'setTimeout/queueMicrotask/structuredClone = Node implementations'],
  ['bootstrap/switches/is_main_thread', () => compileAndCall(
    'internal/bootstrap/switches/is_main_thread', BOOTSTRAP_PARAMS,
    [realmProcess, capturedLoaders.requireBuiltin, capturedLoaders.internalBinding, primordials]),
    () => 'main-thread switch ran'],
  // B21 (stdin-cancel): the is_main_thread switch above built process.stdin
  // as an fs.ReadStream on fd 0 (guessHandleType=3 → FILE case). readline/
  // prompts close with input.pause() ONLY — no destroy, no fd close — so a
  // fd-0 read armed before pause would stay in flight forever (no readStop
  // in this runtime) and the quit gate would never see quiet (reproduced
  // live: readline prompt answered → terminal prompt never returned). This
  // stage wraps the stdin stream's pause() to first cancel the in-flight
  // fd-0 read — the uv_read_stop equivalent for our stdin device; userland
  // pause semantics are unchanged (a later resume() re-arms a fresh read,
  // same as real node restarting a read after read_stop). The close(fd-0)
  // cancel inside the fs binding covers the destroy path.
  ['nodine/stdin-pause-hook', () => {
    let hooked = false;
    try {
      const s = realmProcess && Object.prototype.hasOwnProperty.call(realmProcess, 'stdin')
        ? Object.getOwnPropertyDescriptor(realmProcess, 'stdin')
        : null;
      if (s && typeof s.get === 'function') {
        const getStdin = s.get;
        Object.defineProperty(realmProcess, 'stdin', {
          configurable: true,
          get() {
            const stream = getStdin.call(this);
            try {
              if (stream && !stream.__nodinePauseHooked && typeof stream.pause === 'function') {
                stream.__nodinePauseHooked = true;
                const origPause = stream.pause.bind(stream);
                stream.pause = () => {
                  try { platformMessagePost({ type: 'stdin-pause-fired' }); } catch {}
                  try { cancelStdinRead(); } catch {}
                  return origPause();
                };
                hooked = true;
                try { platformMessagePost({ type: 'stdin-hook-armed' }); } catch {}
              }
            } catch {}
            return stream;
          },
        });
        hooked = true; // getter wrapped; the stream hook arms on first access
      }
    } catch (e) { try { platformMessagePost({ type: 'stdin-hook-error', message: String(e && e.message).slice(0, 200) }); } catch {} }
    return hooked ? 'stdin pause→cancel hook installed' : 'stdin hook skipped (no getter)';
  }],
  // Also skipped by the harness (ADVERSARIAL_REVIEW §1.1 correction 4):
  ['bootstrap/switches/does_own_process_state', () => compileAndCall(
    'internal/bootstrap/switches/does_own_process_state', BOOTSTRAP_PARAMS,
    [realmProcess, capturedLoaders.requireBuiltin, capturedLoaders.internalBinding, primordials]),
    () => 'process state switch ran (cwd/chdir/umask)'],
];

// ---------------------------------------------------------------------------
// 5. Loop driver — the host's libuv stand-in at the JS boundary.
//    process._tickCallback IS Node's runNextTicks (bootstrap/node.js:363-369);
//    the driver calls it at every phase boundary, and `await null` checkpoints
//    drain the engine microtask queue (the runMicrotasks() substitute).
// ---------------------------------------------------------------------------
const tickInfoRef = () => bindingCache.get('task_queue').tickInfo;
async function settleLoop(maxRounds = 200) {
  for (let i = 0; i < maxRounds; i++) {
    // 1. drain nextTick queue (Node's own JS drain, incl. nested nextTicks)
    if (typeof realmProcess._tickCallback === 'function') realmProcess._tickCallback();
    // 2. drain promise microtasks (engine checkpoint — runMicrotasks() substitute)
    await null;
    // 3. if microtasks scheduled more ticks, loop — this reproduces Node's
    //    processTicksAndRejections do-while interleave at phase granularity.
    if (tickInfoRef()[0] !== 1) break;
  }
}
// Wait until the "event loop" is quiet: no scheduled platform timers, no
// pending immediates, no ticks. This mirrors the loop-exit condition
// (immediateInfo count == 0 && no active handles) closely enough for the gate.
async function waitForQuiet(timeoutMs = 8000) {
  const t0 = nowMs();
  for (;;) {
    await settleLoop();
    const immediateCount = timersState.immediateInfo ? timersState.immediateInfo[0] : 0;
    const hasTimer = timersState.platformTimerId !== null;
    const hasTicks = tickInfoRef()[0] === 1;
    const pendingFs = pendingAsyncFsOps();
    const pendingEsm = pendingEsmOpsCount();
    const esmGateOpen = !esmEntryInFlight || esmEntryTerminal || (esmEvalStarted && pendingEsm === 0);
    if (TEST_ID === 'T3') report({ type: 'quiet-poll', ms: +(nowMs() - t0).toFixed(0), immediateCount, hasTimer, hasTicks, pendingFs, out: HOST_STDOUT.length });
    if (!immediateCount && !hasTimer && !hasTicks && !pendingFs && !pendingEsm && !pendingHttpFetches && !pendingSpawnReplies && esmGateOpen) return;
    if (nowMs() - t0 > timeoutMs) {
      if (!waitForQuiet.reported) {
        waitForQuiet.reported = true;
        report({ type: 'quiet-timeout', immediateCount, hasTimer, hasTicks, pendingFs, pendingEsm });
      }
      return;
    }
    await new Promise((r) => platformSetTimeout(r, 5));
  }
}
let asyncFsOutstanding = 0;
function pendingAsyncFsOps() {
  // in-flight ABI ops (submitted or queued) + scheduled callback deliveries —
  // waitForQuiet must not report quiet while kernel ops are outstanding.
  return asyncFsOutstanding + outstanding.size + bridgeQueue.length;
}

// ---------------------------------------------------------------------------
// 6. Nodine runtime entry — message-driven (no baked-in tests). The page
//    spawns this worker per process run and sends ONE init message:
//      { type: 'nodine-init', ksmMemory, epIndex, generation, pid,
//        files: { '/project/main.js': 'source', ... }, entry, code, argv }
//    files are seeded THROUGH THE KERNEL (mkdir -p + open/write/close via
//    the transport) before the Node bootstrap chain runs.
// ---------------------------------------------------------------------------
// The initPromise is installed at MODULE TOP (splice R1c) — a message
// posted during the libsources fetch / integrity hashing window must not be
// lost, so the handler exists before the first top-level await.

// ---------------------------------------------------------------------------
// 7. RUN: attach -> PROC_READY -> seed -> bootstrap chain -> entry -> settle
//    -> exit code -> OP_PROC_EXIT -> report.
// ---------------------------------------------------------------------------
async function main() {
  const init = await initPromise;
  // P2-008-PERF Step-0: activate instrumentation when the supervisor asked
  // (page loaded with ?perf=1). Every hook is a null-check when off.
  if (init.perf) activatePerf(init);
  // B8 ENV FIX: realmProcess is built at MODULE TOP (before this await),
  // so its env is ALWAYS the hardcoded fallback — INIT was still null when
  // the IIFE ran. Every spawn therefore saw only HOME/LANG/NODE_ENV/PATH
  // regardless of the env the supervisor posted with nodine-init
  // (verified live: postMessage carried MYVAR=zig; process.env did not).
  // Rebuild env HERE, from the real init contract, before the bootstrap
  // chain consumes it (safeGetenv, mode plumbing, Node's internal env).
  if (init.env && typeof init.env === 'object') {
    realmProcess.env = Object.assign(Object.create(null), init.env);
  }
  transportAttach(init.ksmMemory, init.epIndex, init.generation);

  // Bring-up: OP_PROC_READY births the ProcessRecord (FD_SPEC §8 — the
  // endpoint is ALLOCATED until this lands).
  await asyncOp(OP.PROC_READY, BigInt((1 << 16) | 2), 0n, 0n);

  // P2-006-007 process contract: cwd (kernel-authoritative via OP_CHDIR),
  // stdio mode + supervisor channel.
  hostCwd = INIT?.cwd || '/project';
  STDIO_MODE = INIT?.stdioMode || 'inherit';
  // P2-006-008: per-fd stdio — the supervisor sends stdioArr = ['inherit'|'pipe'|'ignore' ×3]
  // for spawn requests with array stdio (the yarn shell's
  // [process.stdin, process.stdout, process.stderr]). fd-0 reads use fd0Mode
  // (a real-terminal child reads the kernel FIFO even when fd1/2 are piped —
  // create-expo's prompt); fd-1/2 writes keep STDIO_MODE (pipe = channel relay).
  const initArr = INIT?.stdioArr;
  globalThis.__nodineStdioArr = Array.isArray(initArr) && initArr.length === 3 ? initArr : null;
  if (globalThis.__nodineStdioArr && STDIO_MODE.includes(',')) {
    STDIO_MODE = globalThis.__nodineStdioArr[1] === 'pipe' || globalThis.__nodineStdioArr[2] === 'pipe' ? 'pipe' : 'inherit';
  }
  CHANNEL_PORT = INIT?.channelPort || null;
  // B1-PREVIEW: main()-side install (idempotent — the module-top listener
  // may have installed it already; whichever runs second is a no-op).
  if (INIT?.previewSWPort) installPreviewSWPort(INIT.previewSWPort);
  if (CHANNEL_PORT) {
    // B7 FIX: platformArmPort, not bare `.onmessage =` — this install runs
    // AFTER the Node bootstrap chain, so the global MessagePort prototype
    // may already be Node's (ERR_INVALID_THIS on platform ports; same
    // class as the npm exit-path crash — see the pre-exit handshake fix).
    platformArmPort(CHANNEL_PORT, (ev) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      // E6 PIPELINE FIX: per-fd stdio — the pipeline's LAST stage runs with
      // stdioArr ['pipe','inherit','inherit'] (fd0 from the pipe, fd1/2 to
      // the terminal); the scalar STDIO_MODE resolves 'inherit' then and
      // this branch DROPPED every stdin-bytes message — 'cat x | wc -l'
      // printed 0. Honor the per-fd array for fd 0. B9 TERMINAL-OWNER:
      // __stdinOwned (set by the 'stdin-own' channel message) counts as
      // piped too — the supervisor routes targeted stdin-bytes here while
      // this process owns the terminal, bypassing the kernel broadcast.
      const fd0Piped = globalThis.__stdinOwned || (globalThis.__nodineStdioArr ? globalThis.__nodineStdioArr[0] === 'pipe' : STDIO_MODE === 'pipe');
      if (m.type === 'preview-sw-port') { handlePreviewSwPortMsg(ev); return; }
      if (m.type === 'stdin-own') {
        // B9 TERMINAL-OWNER: grant/revoke terminal-stdin ownership. While
        // owned, fd-0 reads come from the channel queue (targeted bytes)
        // and the kernel FIFO is left untouched — the broadcast feed never
        // runs for this tree, so ancestors' line buffers stay clean.
        globalThis.__stdinOwned = !!m.own;
        if (m.own) deliverStdinToWaiters();
        return;
      }
      if (m.type === 'stdin-bytes' && fd0Piped) {
          stdinQueue.push(new Uint8Array(m.bytes));
        deliverStdinToWaiters();
      } else if (m.type === 'stdin-eof' && fd0Piped) {
        // E6 PIPELINE FIX: the supervisor signals upstream EOF (the writer
        // ended its stdin) — deliver a 0-byte read (real EOF) to a waiting
        // reader and mark the queue closed so subsequent reads see EOF.
        stdinEofSeen = true;
        deliverStdinToWaiters();
      } else if (m.type === 'signal') {
        raiseProcessSignal(m.sig || 'SIGINT');
      }
      // child_process batch: pid-qualified handlers (child-stdout:<pid> etc.)
      // + bare spawn-result.
      let h = channelPortHandlers.get(m.type)
        || (m.pid !== undefined ? channelPortHandlers.get(m.type + ':' + m.pid) : undefined);
      if (!h && m.type === 'spawn-result' && m.reqId) h = channelPortHandlers.get(m.reqId); // M1.6 per-request keys
      if (h) h(m);
    });
    // platformArmPort already called port.start() via the captured setter path.
  }
  {
    const cwdBytes = platformTextEncoder.encode(hostCwd);
    const r = await asyncOp(OP.CHDIR, 0n, 0n, 0n, cwdBytes);
    if (r.status !== 0) {
      report({ type: 'chdir-failed', cwd: hostCwd, status: r.status });
    }
  }
  platformMessagePost({ type: 'proc-ready' }); // P2-006-007 supervisor contract

  // Seed the project files THROUGH the kernel transport (the fs binding's
  // internal helpers — the same OP_MKDIR/OP_OPEN/OP_WRITE every Node call
  // takes; no side channel, no fake VFS).
  const fsb = getInternalBinding('fs');
  fsb._mkdirP('/project', 0o777);
  for (const [p, contents] of Object.entries(init.files || {})) {
    const dir = p.slice(0, p.lastIndexOf('/')) || '/';
    fsb._mkdirP(dir, 0o777);
    fsb._seedFile(p, contents, 1 | 64 | 512, 0o644); // O_WRONLY|O_CREAT|O_TRUNC
  }

  const tChain0 = nowMs();
  for (const [name, fn] of stages) {
    stage(name, fn);
  }
  const chainMs = +(nowMs() - tChain0).toFixed(1);
  report({ type: 'chain-complete', ms: chainMs, stages: stageTimings });
  if (PERF) {
    // P2-008-PERF: boot-cost breakdown + npm's own 'time'/'timeEnd' taps.
    // npm's timers.js measures phases via process events (timers.js #timeHandler)
    // — recording them here captures idealTree/reify/etc. even when the
    // timing.json file is overwritten by a later npm invocation in the tree.
    PERF.boot.chainMs = chainMs;
    try {
      realmProcess.on('time', (name) => { PERF.npmTimers[name] = { start: +(nowMs().toFixed(0)) }; });
      realmProcess.on('timeEnd', (name) => {
        const e = PERF.npmTimers[name] || (PERF.npmTimers[name] = {});
        e.end = +(nowMs().toFixed(0));
      });
    } catch {}
    platformMessagePost({ type: 'perf-boot', pid: init.pid, chainMs, libsources: PERF.boot.libsources, prebootNet: PERF_PREBOOT_NET });
  }

  // Entry selection: a module entry (files + argv[1]) runs run_main_module;
  // otherwise eval_string with INIT.code.
  const useModule = !!init.entry;
  if (!useModule) CLI_OPTIONS['--eval'] = init.code || '';
  if (init.inputTypeModule) {
    CLI_OPTIONS['--input-type'] = 'module';
    esmEntryInFlight = true;
  }

  // P2-006-007: blob-compiled ESM modules (the mini-loader) have no function
  // parameters — process must be reachable via the global. The realm process
  // object is the SAME one compiled CJS modules receive. (Runs AFTER the
  // bootstrap chain: realmProcess exists only then.)
  try { if (realmProcess) globalThis.process = realmProcess; } catch {}
  // M1.7A-b4 FIX #4 (pnpm network op): the Node bootstrap replaces
  // globalThis.AbortController/AbortSignal with Node's JS implementations;
  // their .signal is NOT a native AbortSignal, so PLATFORM fetch() rejects
  // it ("Failed to convert value to 'AbortSignal'" — killed pnpm's
  // registry metadata fetch through the harness's network.request). The
  // vendored undici shim already maps fetch/WHATWG classes onto the
  // platform's; the globals get the same treatment. The runtime's own
  // code uses the __nodineNativeAbortController capture directly.
  try {
    globalThis.AbortController = __nodineNativeAbortController;
    if (__nodineNativeAbortSignal) globalThis.AbortSignal = __nodineNativeAbortSignal;
  } catch {}
  // P2-006-008: the stdio devices ARE the interactive terminal (kernel-fed
  // stdin with EAGAIN semantics, supervisor-relayed stdout/stderr) — report
  // TTY so interactive CLIs engage their TTY paths (npx's Ok-to-proceed,
  // create-expo's prompts). setRawMode: the browser terminal delivers input
  // as typed (no cooked/raw distinction) — accept and ignore the switch
  // (documented divergence). Columns/rows: the terminal's fixed geometry.
  try {
    for (const s of [realmProcess && realmProcess.stdin, realmProcess && realmProcess.stdout, realmProcess && realmProcess.stderr]) {
      if (!s) continue;
      try { s.isTTY = true; } catch {}
      if (typeof s.setRawMode !== 'function') {
        try { s.setRawMode = function () { return this; }; } catch {}
      }
      if (typeof s.columns !== 'number') { try { s.columns = 80; } catch {} }
      if (typeof s.rows !== 'number') { try { s.rows = 24; } catch {} }
      // readline cursor controls (npm's spinner calls cursorTo/clearLine on
      // TTY streams — internal/tty.js normally installs these). The
      // terminal emulator understands REAL ANSI (\r, CSI K/A/B/C/D), so
      // these are implemented as actual writes — npm's spinner then redraws
      // ONE line instead of scrolling a new spinner per frame (the "wall of
      // ⠙⠹⠸" observed live). clearLine(dir): 0=right, 1=whole, -1=left.
      if (typeof s.cursorTo !== 'function' || s.__nodineStubCursor) {
        try {
          s.__nodineStubCursor = true;
          s.cursorTo = function (x, y) {
            if (y === undefined || y === null) { this.write(typeof x === 'number' && x > 0 ? '\r' + (x < 80 ? '\x1b[' + x + 'C' : '') : '\r'); }
            else { this.write('\x1b[' + (y + 1) + ';' + (x + 1) + 'H'); }
            return this;
          };
          s.clearLine = function (dir) {
            this.write(dir === -1 ? '\x1b[1K' : dir === 1 ? '\r\x1b[2K' : '\x1b[K');
            return this;
          };
          s.moveCursor = function (dx, dy) {
            if (dx) this.write(dx > 0 ? '\x1b[' + dx + 'C' : '\x1b[' + (-dx) + 'D');
            if (dy) this.write(dy > 0 ? '\x1b[' + dy + 'B' : '\x1b[' + (-dy) + 'A');
            return this;
          };
        } catch {}
      }
    }
  } catch {}
  // P2-006-008: the require(esm) interposition (P2-006-007's disabled
  // experiment — a Promise returned from the sync Module._load) is REMOVED.
  // The synchronous ModuleWrap binding now serves the REAL upstream path
  // (loadESMFromCJS → importSyncForRequire → ModuleJobSync → evaluateSync).
  // No interposition; require() stays genuinely synchronous.
  const tEntry0 = nowMs();
  let entryError = null;
  try {
    if (useModule) {
      compileAndCall('internal/main/run_main_module', BOOTSTRAP_PARAMS,
        [realmProcess, capturedLoaders.requireBuiltin, capturedLoaders.internalBinding, primordials]);
    } else {
      compileAndCall('internal/main/eval_string', BOOTSTRAP_PARAMS,
        [realmProcess, capturedLoaders.requireBuiltin, capturedLoaders.internalBinding, primordials]);
    }
  } catch (err) {
    entryError = String(err?.stack || err);
    report({ type: 'entry-error', error: entryError });
    // Node semantics: an uncaught exception prints the full stack to stderr
    // before exiting 1. Without this the failure is invisible in the
    // terminal (observed live: create-expo-app died with only a bare
    // "TypeError: ..." line and no frames anywhere).
    try { realmProcess.stderr.write(entryError + '\n'); } catch {}
  }
  const entryMs = +(nowMs() - tEntry0).toFixed(1);
  report({ type: 'entry-done', ms: entryMs, error: entryError });
  if (PERF) { PERF.boot.entryMs = entryMs; platformMessagePost({ type: 'perf-entry', pid: init.pid, entryMs }); }

  // Drain the "event loop" (ticks, microtasks, immediates, timers, async fs).
  // process.exit() anywhere terminates immediately (Node semantics: pending
  // timers do not fire, in-flight ops are abandoned to the reclaim path).
  await (globalThis.__P2006_SKIP_QUIET ? null : waitForQuit());

async function waitForQuit() {
  // Single direct-condition loop (p1-poc's waitForQuiet returns undefined on
  // BOTH success and timeout — racing it was a spin bug). Conditions mirror
  // waitForQuiet exactly: no immediates, no armed platform timer, no ticks,
  // no in-flight fs; process.exit() anywhere terminates immediately; the
  // whole wait is bounded (never wedge a run on a stray long timer).
  const t0 = Date.now();
  for (;;) {
    if (processExitCode !== undefined) {
      try { if (timersState.platformTimerId !== null) platformClearTimeout(timersState.platformTimerId); } catch {}
      return;
    }
    await settleLoop();
    // P2-006-008 drain-order fix: the quiet decision must be made at a
    // MACROTASK boundary. settleLoop returns from a microtask continuation,
    // and its `await null` checkpoints only advance pending promise chains
    // one link per round — FIFO interleaving lets this loop's continuation
    // run BEFORE deeper chain links queued by the drained round, so a
    // resolved-but-unchained promise (fs.promises.mkdir recursive over an
    // existing parent; npm's with-lock touch cycle) is orphaned mid-flight
    // and the process exits with live continuations still queued (the
    // with-lock hang / ECOMPROMISED class). Node's uv_run decides loop
    // death only after runMicrotasks() drains EXHAUSTIVELY; on the web that
    // guarantee exists only at macrotask boundaries. Hop through one 0 ms
    // macrotask (raw engineSetTimeout — NOT armPlatformTimer, so it cannot
    // show up as a Node timer), then settle whatever the drained chains
    // scheduled, BEFORE judging quiet.
    await new Promise((r) => engineSetTimeout(r, 0));
    await settleLoop();
    const immediateCount = timersState.immediateInfo ? timersState.immediateInfo[0] : 0;
    // P2-006-008: hasTimer honors ref/unref — timeoutInfo[0] is the ref'd
    // timer count timers.js maintains in the binding's shared array. Armed
    // but fully-unref'd timers do not keep the loop alive (uv semantics).
    const refdTimers = timersState.timeoutInfo ? timersState.timeoutInfo[0] : 0;
    const hasTimer = timersState.platformTimerId !== null && refdTimers > 0;
    const hasTicks = tickInfoRef()[0] === 1;
    const pendingFs = pendingAsyncFsOps();
    // liveness snapshot (change-throttled): what is holding the loop open
    const snap = 'imm=' + immediateCount + ' tmr=' + (hasTimer ? 1 : 0) + '/' + refdTimers
      + ' tick=' + (hasTicks ? 1 : 0) + ' fs=' + pendingFs + ' http=' + pendingHttpFetches
      + ' kids=' + liveChildren + ' spawn=' + pendingSpawnReplies + ' din=' + dynImportInFlight
      + ' wt=' + pnpm_wasmNodeSupport.liveWorkers()
      // B21-DIAG: the two stdin terms were invisible in the snap while the
      // gate still counts them — a wedged stdin read showed 'all-zero' yet
      // never quit. Surface them.
      + ' sin=' + stdinWaiters + ' srty=' + stdinRetryCount;
    if (snap !== waitForQuit._lastSnap) {
      waitForQuit._lastSnap = snap;
      traceLife('alive', snap);
      // B6-DIAG: surface the liveness snapshot to the supervisor on every
      // CHANGE (bounded by the change-throttle above) — a hung process can
      // then NAME its holder instead of dying silently. Cheap: one message
      // per counter change, not per loop iteration.
      report({ type: 'life-snap', snap, at: Math.round(Date.now() - lifeT0) + 'ms' });
    }
    // B7-DIAG: UNTHROTTLED heartbeat — every 64th iteration, report the
    // snapshot REGARDLESS of change. A flapping counter (a 0→1→0 cycle
    // whose alternating values both eventually match _lastSnap) can look
    // like silence under the change gate; the heartbeat names the state
    // even while flapping, and its absence proves a BLOCKED loop.
    if ((waitForQuit._hb = (waitForQuit._hb || 0) + 1) % 64 === 0) {
      report({ type: 'life-snap', snap: snap + ' [hb]', at: Math.round(Date.now() - lifeT0) + 'ms' });
    }
    // P2-006-007: real processes may be LONG-RUNNING (npm install, dev
    // servers). Node's real semantics keep the loop alive while refs exist —
    // so: live children and pending pipe-stdio reads keep the process alive
    // WITHOUT a timeout, and the anti-wedge responsibility moves to the
    // supervisor (kill/Ctrl+C → endpoint-died). process.exit() anywhere
    // still terminates immediately.
    // P2-006-008: the old 8 s anti-wedge cap is REMOVED — it fired on any
    // timer-only keepalive (killed a plain 20×1 s ref'd-timer loop at 8 s,
    // and murdered npx mid-install during Arborist's in-memory quiet gap →
    // signal-exit deleted the with-lock dir → surviving touch timer stat'd
    // ENOENT → ECOMPROMISED). A ref'd timer is a legitimate keepalive for
    // as long as it exists, exactly like Node; wedged runs are the
    // supervisor's to kill.
    // M1.3 fix: SW-bridge listeners are ACTIVE HANDLES too — a process whose
    // only activity is a listening preview server (node -e '…listen(4173…)')
    // saw an all-zero snapshot ~80 ms after the listen callback and exited,
    // tearing the server down between the host's server-ready event and its
    // first fetch (observed live: intermittent preview 503s that persist on
    // retry). Real Node keeps the loop alive while a server listens; the
    // quit decision must count previewPorts the same way.
    // M1.7A: live nested browser workers are active handles — real Node
    // keeps the loop alive while worker_threads workers run (the pnpm-wasm
    // harness's whole install runs inside its worker pool with the parent
    // JS otherwise silent). Without this the process is quit-quiet-killed
    // ~600 ms after wasm instantiation begins.
    const liveWasmWorkers = pnpm_wasmNodeSupport.liveWorkers();
    const allQuiet = !immediateCount && !hasTimer && !hasTicks && !pendingFs && !pendingHttpFetches && !liveChildren && !pendingSpawnReplies && !stdinWaiters && stdinRetryCount === 0 && dynImportInFlight === 0 && previewPorts.size === 0 && liveWasmWorkers === 0
      // P2-006-008-3: KEEP-ALIVE-SOCKET STAND-IN — hold the loop open for 2 s
      // after the last HTTP activity. Real Node never sees loop-death during
      // an npm install (agent keep-alive sockets are active handles); our
      // fetch bridge goes handle-silent between mirror-fast batches while
      // npm's promise chains (JSON.parse → arborist edge resolution → next
      // manifest fetch) bridge the gap in pure microtasks. npm exits
      // EXPLICITLY (process.exit) when done, so this hold only delays
      // pathological quit-quiet kills — never a genuine exit.
      // P2-EXIT: "activity" = SETTLED traffic only (see the undici wrapper
      // and bridge _send: the stamp is written when a fetch settles, not
      // when it starts). A stalled fetch no longer refreshes this stand-in
      // forever, so the gate returns to quiet once the fetch deadline (or
      // a real settle) frees pendingHttpFetches.
      && (Date.now() - lastHttpActivityAt) >= 2000;
    // P2-006-008: loop-death now requires SUSTAINED quiet (60 ms). The
    // counters approximate uv's active-handles set, but the approximation
    // has blind windows — npm pauses its spinner timer, then spends ~10-40 ms
    // in promise-based readline/prompt setup with NOTHING counted (no timer,
    // no fs, no http, no stdin retry armed yet), and a single all-zero
    // snapshot killed the process right before the "Ok to proceed?" prompt
    // (reproduced live: life-ring "http-body-end 2484410B → alive all-zero
    // 28 ms later → quit-quiet", no error output, exit 0). uv_run never sees
    // such gaps because its handle accounting is exact; requiring the quiet
    // state to PERSIST bridges every setup-phase window while leaving
    // genuinely-finished programs to exit just 80 ms later.
    if (allQuiet) {
      if (waitForQuit._quietSince === undefined) waitForQuit._quietSince = Date.now();
      if (Date.now() - waitForQuit._quietSince < 80) {
        await new Promise((r) => engineSetTimeout(r, 5));
        continue;
      }
      report({ type: 'quit-quiet', dynImportInFlight, pendingFs, hasTicks, hasTimer, immediateCount, liveChildren, pendingSpawnReplies, stdinWaiters, stdinRetryCount, refdTimers,
               life: lifeRing.slice(-90) });
      return;
    }
    waitForQuit._quietSince = undefined;
    await new Promise((r) => engineSetTimeout(r, 5));
  }
}


  // Node exit semantics: process.exit(code) wins; else the exitCode property
  // (natural drain); else entry errors map to 1.
  const exitCode = typeof processExitCode === 'number'
    ? processExitCode
    : (typeof realmProcess?.exitCode === 'number' ? realmProcess.exitCode : (entryError ? 1 : 0));

  // OP_PROC_EXIT: the kernel drains this endpoint and reclaims every fd and
  // OFD of the pid (§21.2). Fire-and-await so the page sees a terminal
  // endpoint state before reporting done.
  if (globalThis.__P2006_SKIP_PROC_EXIT) {
    report({ type: 'proc-exit-skipped' });
  } else
  try {
    // P2-007 exit-latency fix: the OLD ~70 ms blind sleep (one 50 ms host
    // keepalive beat + margin) is replaced by an explicit handshake. This
    // posts 'pre-exit' to the supervisor, which RPCs flush-stdio to the
    // driver (a SYNCHRONOUS drain of both kernel stdio FIFOs) and replies;
    // only then does the reclaim run. Final writes always land — with zero
    // fixed latency on the common path (handshake round-trip ≈ 1-3 ms).
    report({ type: 'exit-phase', phase: 'pre-exit-wait' });
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      // hard backstop: if the supervisor never answers (bare embedding,
      // older page), proceed after 250 ms — same guarantee the sleep gave.
      const backstop = platformSetTimeout(done, 250);
      if (CHANNEL_PORT) {
        // B7 FIX: ERR_INVALID_THIS on npm exits — a bare `.onmessage =`
        // resolves the setter through the CURRENT global MessagePort
        // prototype, which npm's tree (worker_threads/undici) replaces
        // with Node's JS MessagePort; Node's setter then rejects the
        // PLATFORM port ("Value of this must be of type EventTarget" —
        // observed live: npm init/install died at exactly this phase, see
        // the exit-phase trace). platformArmPort uses the setter captured
        // BEFORE the bootstrap (the documented platformPortSetOnmessage).
        platformArmPort(CHANNEL_PORT, (ev) => {
          if (ev.data && ev.data.type === 'stdio-flushed-ack') {
            platformClearTimeout(backstop);
            done();
          }
        });
        CHANNEL_PORT.postMessage({ type: 'pre-exit' });
      } else {
        platformClearTimeout(backstop);
        done();
      }
    });
    report({ type: 'exit-phase', phase: 'pre-exit-ack' });
    // restore the channel dispatcher the handshake temporarily replaced
    // (B7 FIX: platformArmPort for the same ERR_INVALID_THIS reason).
    if (CHANNEL_PORT) {
      platformArmPort(CHANNEL_PORT, (ev) => {
        const m = ev.data;
        if (!m || typeof m !== 'object') return;
        // E6 PIPELINE FIX: per-fd stdio (see the main() dispatcher) — fd0
        // piped with fd1/2 inherited must still receive stdin-bytes.
        // B9: 'stdin-own' handled here too (post-handshake dispatcher).
        const fd0Piped = globalThis.__stdinOwned || (globalThis.__nodineStdioArr ? globalThis.__nodineStdioArr[0] === 'pipe' : STDIO_MODE === 'pipe');
        if (m.type === 'preview-sw-port') { handlePreviewSwPortMsg(ev); return; }
        if (m.type === 'stdin-own') {
          globalThis.__stdinOwned = !!m.own;
          if (m.own) deliverStdinToWaiters();
          return;
        }
        if (m.type === 'stdin-bytes' && fd0Piped) {
          stdinQueue.push(new Uint8Array(m.bytes));
          deliverStdinToWaiters();
        } else if (m.type === 'stdin-eof' && fd0Piped) {
          // E6 PIPELINE FIX: upstream EOF (see the main() dispatcher).
          stdinEofSeen = true;
          deliverStdinToWaiters();
        } else if (m.type === 'signal') {
          raiseProcessSignal(m.sig || 'SIGINT');
        }
        let h = channelPortHandlers.get(m.type)
          || (m.pid !== undefined ? channelPortHandlers.get(m.type + ':' + m.pid) : undefined);
        if (!h && m.type === 'spawn-result' && m.reqId) h = channelPortHandlers.get(m.reqId); // M1.6 per-request keys
        if (h) h(m);
      });
    }
    report({ type: 'exit-phase', phase: 'proc-exit-op' });
    await asyncOp(OP.PROC_EXIT, BigInt(exitCode), 0n, 0n);
    report({ type: 'exit-phase', phase: 'proc-exit-done' });
  } catch (e) {
    report({ type: 'proc-exit-error', error: String(e) });
  }

  if (PERF) {
    // P2-008-PERF: the final per-process dump — RPC histograms, wait-rung
    // suspicion, network trace, npm time/timeEnd taps, boot costs.
    platformMessagePost({
      type: 'perf-exit', pid: INIT.pid, exitCode,
      argv: INIT.argv || [], entry: INIT.entry || null,
      t0: PERF.t0, upMs: +(nowMs() - PERF.t0).toFixed(0),
      ladderSuspect: PERF.ladderSuspect,
      corgi: { ...DIRECT_CORGI_STATS }, // Phase-4: final per-process substitution counters
      eagain: { sync: { ...SYNC_EAGAIN_RETRIES }, async: { ...ASYNC_EAGAIN_RETRIES } }, // Phase-5: final EAGAIN-retry health
      rpc: perfLatSummary(),
      net: PERF.net,
      npmTimers: PERF.npmTimers,
      boot: PERF.boot,
      // S0.6 Step-1b: delivery stats — drainDur is capped at the last 4096
      // samples (rolling); lat buckets use PERF_LAT_EDGES.
      deliv: {
        passes: PERF.deliv.passes, idleDrains: PERF.deliv.idleDrains,
        byMode: PERF.deliv.byMode, batch: PERF.deliv.batch,
        batchHist: PERF.deliv.batchHist, // index k = round(log2(batchSize))
        lat: PERF.deliv.lat, latEdges: PERF_LAT_EDGES,
        drainDur: PERF.deliv.drainDur.length > 2048
          ? { sampled: PERF.deliv.drainDur.length, p50: pctl(PERF.deliv.drainDur, 0.5), p90: pctl(PERF.deliv.drainDur, 0.9), p99: pctl(PERF.deliv.drainDur, 0.99), max: Math.max(...PERF.deliv.drainDur) }
          : PERF.deliv.drainDur,
        selfWake: PERF.deliv.selfWake,
      },
    });
  }

  await report({
    type: 'run-result',
    verdict: entryError ? 'FAIL' : 'OK',
    exitCode,
    entryMs,
    chainMs,
    stdout: HOST_STDOUT.join(''),
    stderr: HOST_STDERR.join(''),
    entryError,
  });
  // M1.7A-b3: natural loop-death must tear down any live nested workers
  // too (Ctrl+C/signal exits land here with workers still alive; Node
  // kills its worker_threads on process exit). The supervisor terminates
  // the whole runtime worker afterwards, so this is belt-and-braces
  // cleanup - the workers cannot outlive their process either way.
  try { pnpm_wasmNodeSupport.runCleanup(); report({ type: 'worker-teardown', kind: 'loop-death' }); } catch {}
  platformMessagePost({ type: 'done', exitCode, verdict: entryError ? 'FAIL' : 'OK' });
  platformMessagePost({ type: 'proc-exit', code: exitCode }); // P2-006-007 contract (LAST message)
}

main().catch(async (err) => {
  platformConsoleError('FATAL', err);
  await report({ type: 'fatal', error: String(err?.stack || err) });
  platformMessagePost({ type: 'done', exitCode: 1, verdict: 'FATAL', fatal: String(err?.stack || err) });
  platformMessagePost({ type: 'proc-exit', code: 1 });
});

// ==== M1.7A: browser Worker bridge (VFS entry -> blob bundle -> nested browser Worker) ====
// The harness's thread workers (worker.mjs) are message-pump-only: every
// WASI/pnpm_fs/pnpm_host operation is RPC'd to the parent over postMessage
// + SharedArrayBuffer Atomics handshakes. The nested browser worker needs
// NO kernel access — only the pnpm_wasmNodeCompat prelude (postMessage to
// parent, parentPort/workerData/reportError/worker global) and the ESM
// graph of the entry, served from the PARENT's VFS.
// Parent-side bundling plan:
//   bundleWorkerEntry(entryPath, workerData)
//     -> walks the ESM graph via esmResolveSpec/esmScanRequests
//     -> inlines CJS deps through the runtime's real CJS machinery
//        (values snapshotted at bundle time; worker.mjs's graph is
//        ESM-only, CJS only appears as transitive deps of ESM shims)
//     -> rewrites import specifiers to blob URLs
//     -> prepends the PRELUDE (executed before the entry module:
//        globals the entry's imports of node:worker_threads consume)
//     -> returns { url, workers: [browserWorker...] } — the workers are
//        created HERE so the prelude owns their ports; exports the class.
const pnpm_wasmNodeSupport = (() => {
  const bundled = new Map(); // absPath -> blobUrl
  const cleanupFns = new Set();
  function entryExists(p) { return esmReadFile(p) !== null && esmReadFile(p) !== undefined; }
  function makePreludeBlob(workerData, ports) {
    // ports = { toParent, fromParent } platform MessagePorts (from a
    // MessageChannel owned by THIS runtime context).
    const src = [
      "const __nodinePorts = self.__NODINE_WORKER_PORTS__;", // set via transfer? no — see below
    ];
    return src.join('\n');
  }
  function buildCjsInline(absPath, seen) {
    // CJS dep: execute NOW in the parent (real CJS machinery) and inline
    // the namespace as a blob. The runtime's esmCjsBridgeBlob needs the
    // __NODINE_CJS_REGISTRY which lives in THIS context — but the blob
    // executes in the NESTED worker. So we inline the namespace VALUES
    // directly as an object literal graph.
    if (seen.has(absPath)) return seen.get(absPath);
    const mod = globalThis.__nodineCjsRequire(absPath);
    const named = mod && (typeof mod === 'object' || typeof mod === 'function') ? Object.keys(mod).slice(0, 512) : [];
    const lines = [];
    for (const k of named) {
      let v;
      try { v = mod[k]; } catch { v = undefined; }
      lines.push('export const ' + k + ' = ' + esmInlineValue(v, seen, 0) + ';');
    }
    const d = mod && mod.default !== undefined ? mod.default : mod;
    lines.push('export default ' + esmInlineValue(d, seen, 0) + ';');
    const url = platformCreateObjectURL(new platformBlobCtor([lines.join('\n')], { type: 'text/javascript' }));
    seen.set(absPath, url);
    return url;
  }
  function esmInlineValue(v, seen, depth) {
    if (depth > 3) return 'undefined';
    const t = typeof v;
    if (v === null || t === 'number' || t === 'boolean') return String(v);
    if (t === 'string') return JSON.stringify(v);
    if (t === 'undefined') return 'undefined';
    if (t === 'bigint') return v + 'n';
    if (Array.isArray(v)) return '[' + v.slice(0, 64).map((x) => esmInlineValue(x, seen, depth + 1)).join(',') + ']';
    if (t === 'function' || t === 'symbol') return 'undefined'; // functions cannot cross the bundle boundary
    if (t === 'object') {
      const keys = Object.keys(v).slice(0, 64);
      return '({' + keys.map((k) => JSON.stringify(k) + ':' + esmInlineValue(v[k], seen, depth + 1)).join(',') + '})';
    }
    return 'undefined';
  }
  function bundleEsm(absPath, seen, stack) {
    if (seen.has(absPath)) return seen.get(absPath);
    if (stack.includes(absPath)) { // cycle: ESM live-binding cycles degrade to an empty stub module (rare; logged)
      report({ type: 'worker-bundle-cycle', path: absPath });
      return platformCreateObjectURL(new platformBlobCtor(['export {}'], { type: 'text/javascript' }));
    }
    const src = esmReadFile(absPath);
    if (src === null || src === undefined) throw new Error('worker bundle: cannot read ' + absPath);
    const specs = esmScanRequests(src);
    let rewritten = src;
    const esmStack = stack.concat([absPath]);
    for (const spec of specs) {
      const resolved = esmResolveSpec(spec, absPath);
      if (resolved === null) continue; // leave to the engine's honest error
      let depUrl;
      if (resolved.startsWith('builtin:')) {
        const name = resolved.slice(8);
        if (name === 'worker_threads') { depUrl = pnpm_wasmPreludeUrl(seen); }
        else {
          const mod = esmLoadBuiltin(name);
          const named = mod && (typeof mod === 'object' || typeof mod === 'function') ? Object.keys(mod).slice(0, 512) : [];
          const lines = ['const __m = ' + JSON.stringify({ __cjsBuiltin: name }) + ';'];
          // builtins: inline their VALUES (functions lose identity; only
          // constant-like exports matter inside worker.mjs's graph)
          for (const k of named) {
            let v; try { v = mod[k]; } catch { v = undefined; }
            lines.push('export const ' + k + ' = ' + esmInlineValue(v, seen, 0) + ';');
          }
          depUrl = platformCreateObjectURL(new platformBlobCtor([lines.join('\n')], { type: 'text/javascript' }));
        }
      } else if (esmIsCjs(resolved)) {
        depUrl = buildCjsInline(resolved, seen);
      } else {
        depUrl = bundleEsm(resolved, seen, esmStack);
      }
      if (depUrl) {
        rewritten = rewritten.split("'" + spec + "'").join("'" + depUrl + "'");
        rewritten = rewritten.split('"' + spec + '"').join('"' + depUrl + '"');
      }
    }
    // import.meta.url: the module must see a file: URL of its VFS path so
    // fileURLToPath(import.meta.url) and new URL('./x', import.meta.url)
    // resolve correctly (run.mjs computes PNPM_WASM_* env values from it;
    // worker.mjs's bundle only needs stability).
    const metaBlob = platformCreateObjectURL(new platformBlobCtor(
      ['export default ' + JSON.stringify('file://' + absPath) + ';'],
      { type: 'text/javascript' }));
    const url = platformCreateObjectURL(new platformBlobCtor([rewritten], { type: 'text/javascript' }));
    seen.set(absPath, url);
    return url;
  }
  let preludeUrlCache = null;
  function pnpm_wasmPreludeUrl(seen) {
    // The node:worker_threads module for the NESTED worker. The nested
    // worker's parentPort is the browser worker's own messaging: the
    // browser DedicatedWorkerGlobalScope exposes postMessage() and
    // onmessage directly. Node's parentPort API: on/once/off/postMessage/
    // ref/unref + MessagePort shape. The prelude imports nothing.
    if (preludeUrlCache) return preludeUrlCache;
    const src = [
      '// M1.7A nested-worker node:worker_threads prelude',
      'const __kOnMessage = typeof self.onmessage;',
      'function __makeEventTarget () {',
      '  const listeners = { message: [], error: [], exit: [] };',
      '  return {',
      // M1.7A-b4 FIX #3 (lazy-replay bug): early/inbox messages were only
      // replayed when the NEXT message arrived. If the parent's last-ever
      // messages (wasi-threads posts load+start then goes quiet) landed in
      // the inbox, the thread NEVER started — the exact pnpm freeze. Pump
      // the queue the moment the first message listener registers.
      '    on (ev, fn) {',
      '      if (listeners[ev]) listeners[ev].push(fn);',
      '      if (ev === "message" && !__pumped && listeners.message.length === 1 && __earlyMessages.length > 0) {',
      '        __pumped = true;',
      '        const q = __earlyMessages.splice(0);',
      '        for (const m of q) __parentEmitter.emit("message", m);',
      '      }',
      '      return this;',
      '    },',
      '    once (ev, fn) { const g = (...a) => { this.off(ev, g); fn(...a); }; (listeners[ev] = listeners[ev] || []).push(g); if (ev === "message" && !__pumped && listeners.message.length === 1 && __earlyMessages.length > 0) { __pumped = true; const q = __earlyMessages.splice(0); for (const m of q) __parentEmitter.emit("message", m); } return this; },',
      '    off (ev, fn) { const l = listeners[ev]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return this; },',
      '    emit (ev, ...args) { for (const fn of (listeners[ev] || []).slice()) { try { fn(...args); } catch (e) { reportError(e); } } return true; },',
      '    _hasListeners () { return (listeners.message && listeners.message.length > 0) || false; },',
      '  };',
      '}',
      'const __parentEmitter = __makeEventTarget();',
      '// M1.7A-b4 FIX (install hang): drain the BOOT INBOX — messages the',
      '// parent posted while the module graph was still evaluating (the',
      '// b4 boot trampoline queues them on __NODINE_WORKER_INBOX__).',
      '// wasi-threads posts load/start immediately on pool-exhaustion',
      '// spawns; without this drain those messages never reach the entry.',
      'const __wtDiagP = (m) => { try { self.postMessage({ __nodineWtDiag: true, msg: "prelude:" + m, t: Date.now() }); } catch {} };',
      'const __earlyMessages = (globalThis.__NODINE_WORKER_INBOX__ || []).splice(0);',
      '__wtDiagP("eval; inbox=" + __earlyMessages.length + " types=" + JSON.stringify(__earlyMessages.map((m) => m && m.__emnapi__ && m.__emnapi__.type)));',
      'let __pumped = false;',
      'self.onmessage = (e) => {',
      '  __wtDiagP("onmessage:" + (e.data && e.data.__emnapi__ && e.data.__emnapi__.type) + " pumped=" + __pumped + " listeners=" + __parentEmitter._hasListeners());',
      '  if (!__pumped && __parentEmitter && __parentEmitter._hasListeners && __parentEmitter._hasListeners()) { __pumped = true; for (const m of __earlyMessages.splice(0)) __parentEmitter.emit(\'message\', m); __parentEmitter.emit(\'message\', e.data); }',
      '  else if (!__pumped) { __earlyMessages.push(e.data); if (__parentEmitter._hasListeners && __parentEmitter._hasListeners()) { __pumped = true; for (const m of __earlyMessages.splice(0)) __parentEmitter.emit(\'message\', m); } }',
      '  else __parentEmitter.emit(\'message\', e.data);',
      '};',
      'class ParentPort {',
      '  constructor () { this._emitter = __parentEmitter; this.on = __parentEmitter.on.bind(__parentEmitter); this.once = __parentEmitter.once.bind(__parentEmitter); this.off = __parentEmitter.off.bind(__parentEmitter); }',
      '  postMessage (value, transferList) { self.postMessage(value, transferList || []); }',
      '  ref () {} unref () {} start () {} close () {}',
      '  get onmessage () { return self.onmessage === __parentEmitter._emitter ? undefined : self.onmessage; }',
      '  set onmessage (fn) { self.onmessage = (e) => fn && fn({ data: e.data }); }',
      '}',
      'const parentPort = new ParentPort();',
      'const workerData = globalThis.__NODINE_WORKER_DATA__;',
      'export { parentPort, workerData };',
      'export const isMainThread = false;',
      'export const threadId = 1;',
      'export const resourceLimits = {};',
      'export function markAsUntransferable () {}',
      'export function moveMessagePortToContext () { throw new Error(\'unsupported\'); }',
      'export function receiveMessageOnPort () { return undefined; }',
      'export const MessagePort = ParentPort;',
      'export const MessageChannel = class { constructor () { const c = new MessageChannel(); this.port1 = c.port1; this.port2 = c.port2; } };',
    ].join('\n');
    preludeUrlCache = platformCreateObjectURL(new platformBlobCtor([src], { type: 'text/javascript' }));
    return preludeUrlCache;
  }
  function bundleWorkerEntry(entryPath) {
    bundled.clear();
    const seen = new Map();
    const url = bundleEsm(String(entryPath), seen, []);
    report({ type: 'worker-bundle', entry: String(entryPath), modules: seen.size });
    return { url, modules: seen.size };
  }
  let liveWorkers = 0;
  function noteWorkerStarted() { liveWorkers++; }
  function noteWorkerStopped() { if (liveWorkers > 0) liveWorkers--; }
  // M1.7A-b3 fix: return a handle, not the bare remover — terminate()
  // must RUN the cleanup (platform terminate + counter decrement) and
  // then deregister it. The old code called the remover and never ran
  // the cleanup, so liveWorkers() stayed > 0 and the process hung after
  // the harness shutdown completed (observed: wt=4 forever after 4×
  // terminate()).
  function registerCleanup(fn) {
    const entry = { fn, off: false };
    cleanupFns.add(entry);
    return {
      run () { if (entry.off) return; entry.off = true; cleanupFns.delete(entry); try { fn(); } catch { } },
      off () { if (entry.off) return; entry.off = true; cleanupFns.delete(entry); },
    };
  }
  function runCleanup() { for (const entry of [...cleanupFns]) { entry.off = true; try { entry.fn(); } catch { } } cleanupFns.clear(); liveWorkers = 0; }
  return { bundleWorkerEntry, registerCleanup, runCleanup, noteWorkerStarted, noteWorkerStopped, liveWorkers: () => liveWorkers };
})();
