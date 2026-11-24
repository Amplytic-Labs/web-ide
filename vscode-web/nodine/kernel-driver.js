// P2-004 kernel driver — the KERNEL WORKER's JS side.
// Owns all platform waits and wakes (KERNEL_ABI.md §10.5: the driver never
// waits inside wasm; the kernel never busy-loops). Instantiates the kernel
// wasm with the KSM (shared WebAssembly.Memory created by the page) as its
// imported linear memory, boots it, then services the kernel doorbell with
// an op-budget-sliced pump loop (P2_004_FAILURE_SEMANTICS.md F-E1: bounded
// passes keep the §5.3 heartbeat fresh under full saturation).
//
// Control plane (page → driver, postMessage — allowed class §2):
//   boot {ksmMemory, wasm}                → boot-ok | boot-failed
//   alloc-endpoint {pid, caps}            → endpoint-allocated {index, generation}
//   endpoint-exit {index}                 → endpoint-exit-ack {rc}
//   endpoint-died {index, generation}     → endpoint-died-ack {rc}
//   shutdown                              → kernel-stopped (after §21.1(e) sweep)
//   set-step-mode {on}                    → step-mode-ack (pump paused)
//   step                                  → stepped {mask} (exactly one pump pass)
//   set-watchdog {intervalMs, thresholdMs}→ watchdog-ack (+ suspect {mask} events)
//   diag {ep, field}                      → diag-result {value}
// P2-006-007 additions (this copy, poc/p2-007):
//   kfs-sync {op, a0, a1, a2, tx}         → kfs-sync-result {status, inline,
//                                           len, syncres} — one §11.2 sync-
//                                           mailbox fs op on ENDPOINT 0
//   stdin-feed {bytes}                    → stdin-fed {ok} — writes the 0x2100
//                                           scratch + nodine_stdin_feed
//
// NOTE (P2-004): the P2-003 reserved-word shutdown hack (KSM word 0x2004) is
// RETIRED — §5.2 reserved words stay zero; shutdown is postMessage.
'use strict';

// Loop-death observability: a pump-loop exception (wasm trap, bug) must
// surface to the page as a message, not vanish as an unhandled rejection —
// without this a dead pump looks like every worker hanging (found while
// diagnosing the T46 E=2 bench timeout).
self.addEventListener('unhandledrejection', (ev) => {
  self.postMessage({ type: 'driver-loop-died', error: String(ev.reason && (ev.reason.stack || ev.reason) || ev.reason) });
});

const KCTL_MAGIC_LO = 0x41524143, KCTL_MAGIC_HI = 0x31454350;
const KCTL_STATE = 0x10 / 4;
const DOORBELL_OFF = 0x2000;
const TRANSPORT_BASE = 0x00010000, EP_STRIDE = 0x00141000;
const EP_CRH = 0x50, EP_MBOX = 0x60;
const MAX_ENDPOINTS = 64;
const PUMP_OP_BUDGET = 512; // bounded per call; re-pumped while pending
// P2-006-007: sync-mailbox / submit-ring constants (KERNEL_ABI §6/§11 — the
// poc/p2-004 native-smoke.cjs spellings) used by the kfs-sync RPC below.
const EP_SRH = 0x40, EP_TX_ARENA = 0x0100, EP_SYNCRES = 0x80100, EP_SUBMIT_SLOTS = 0xC0100;
const RH_TAIL = 1, RH_EXTRA = 2, MASK = 4095;
const SM_IDLE = 0, SM_SUBMITTED = 1, SM_COMPLETED = 2;
const FLAG_MODE_SYNC = 1;
const REQ_REQ_ID = 0x00, REQ_OP = 0x08, REQ_FLAGS = 0x0c, REQ_TX_OFF = 0x10, REQ_TX_LEN = 0x14, REQ_A0 = 0x18;

let exports, I32, doorbellView;
const epViews = [];
let stepMode = false;
let watchdog = null; // {intervalMs, thresholdMs, lastAt}
let stopped = false;

// ---- E5 (Step-0.5): driver-thread accounting --------------------------------
// Gate: the supervisor boots the driver with perf:true (page ?perf=1).
// Accumulates: wall time inside nodine_pump (busy), pump call count,
// max single pump, time parked in the doorbell Atomics.waitAsync, and the
// kfs-sync handler's inline pump. Pushed to the supervisor every 5 s as
// {type:'driver-perf'}; ops/sec come from the workers' own op histograms
// (the kernel exposes no global completed-op counter).
let DRIVER_PERF = null;
function driverPerfInit() {
  DRIVER_PERF = { busyMs: 0, pumpCalls: 0, maxPumpMs: 0, waitMs: 0, kfsBusyMs: 0, kfsCalls: 0, t0: Date.now(),
    // S0.6 Step-1b: notify accounting — counts of async-completion notifies
    // (cr_seq) and sync notifies (sm_seq), passes whose async mask was
    // non-zero, and the notify-loop duration (the loop runs synchronously
    // right after pumpTimed returns, so pump→notify-issued is structurally
    // ~0; this measures the loop's own cost incl. 64-iteration BigInt scan).
    crNotifies: 0, smNotifies: 0, passesWithAsync: 0, notifyLoopMs: [] };
  setInterval(() => {
    if (!DRIVER_PERF) return;
    const nap = DRIVER_PERF.notifyLoopMs;
    let napStats = null;
    if (nap.length) {
      const s = nap.slice().sort((a, b) => a - b);
      napStats = { n: nap.length, p50: +s[Math.floor(nap.length * 0.5)].toFixed(3), p99: +s[Math.min(nap.length - 1, Math.floor(nap.length * 0.99))].toFixed(3), max: +s[s.length - 1].toFixed(3) };
    }
    self.postMessage({
      type: 'driver-perf',
      upMs: Date.now() - DRIVER_PERF.t0,
      busyMs: +DRIVER_PERF.busyMs.toFixed(1),
      pumpCalls: DRIVER_PERF.pumpCalls,
      maxPumpMs: +DRIVER_PERF.maxPumpMs.toFixed(1),
      waitMs: +DRIVER_PERF.waitMs.toFixed(1),
      kfsBusyMs: +DRIVER_PERF.kfsBusyMs.toFixed(1),
      kfsCalls: DRIVER_PERF.kfsCalls,
      crNotifies: DRIVER_PERF.crNotifies,
      smNotifies: DRIVER_PERF.smNotifies,
      passesWithAsync: DRIVER_PERF.passesWithAsync,
      notifyLoop: napStats,
    });
  }, 5000);
}
function pumpTimed(now, budget) {
  if (!DRIVER_PERF) return exports.nodine_pump(now, budget);
  const t0 = performance.now();
  try {
    return exports.nodine_pump(now, budget);
  } finally {
    const ms = performance.now() - t0;
    DRIVER_PERF.busyMs += ms;
    DRIVER_PERF.pumpCalls++;
    if (ms > DRIVER_PERF.maxPumpMs) DRIVER_PERF.maxPumpMs = ms;
  }
}

self.addEventListener('message', async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'boot') {
      const ksmMemory = msg.ksmMemory;
      ksmRef = ksmMemory;
      if (msg.perf) driverPerfInit();
      const mod = await WebAssembly.instantiate(new Uint8Array(msg.wasm), {
        env: { memory: ksmMemory },
      });
      exports = mod.instance.exports;
      const buf = ksmMemory.buffer;
      I32 = new Int32Array(buf);
      doorbellView = new Int32Array(buf, DOORBELL_OFF, 1);
      for (let i = 0; i < MAX_ENDPOINTS; i++) {
        const base = TRANSPORT_BASE + i * EP_STRIDE;
        epViews.push({
          smSeq: new Int32Array(buf, base + EP_MBOX, 1),
          crSeq: new Int32Array(buf, base + EP_CRH + 0x08, 1),
        });
      }
      const rc = exports.nodine_init(1, BigInt(Date.now()), 0);
      if (rc !== 0) { self.postMessage({ type: 'boot-failed', tag: msg.tag, rc }); return; }
      const magicOk = I32[0] === KCTL_MAGIC_LO && I32[1] === KCTL_MAGIC_HI;
      const version = I32[2], state = I32[KCTL_STATE];
      if (!magicOk || state !== 1) {
        self.postMessage({ type: 'boot-failed', tag: msg.tag, rc: -1, magicOk, version, state });
        return;
      }
      self.postMessage({
        type: 'boot-ok', tag: msg.tag, version, state, caps: I32[5],
        maxEp: I32[6], stride: I32[7].toString(16),
        stackPointer: exports.__stack_pointer.value,
      });
      loop().catch((e) => {
        self.postMessage({ type: 'driver-loop-died', error: String((e && e.stack) || e) });
      });
      return;
    }
    if (msg.type === 'alloc-endpoint') {
      const index = exports.nodine_alloc_endpoint(msg.pid, msg.caps);
      const gen = index >= 0 ? Atomics.load(I32, (0x1000 + index * 64 + 0x10) / 4) : 0;
      self.postMessage({ type: 'endpoint-allocated', tag: msg.tag, index, generation: gen, rc: index });
      return;
    }
    if (msg.type === 'endpoint-exit') {
      const rc = exports.nodine_endpoint_exit(msg.index);
      self.postMessage({ type: 'endpoint-exit-ack', tag: msg.tag, rc });
      return;
    }
    if (msg.type === 'endpoint-died') {
      const rc = exports.nodine_endpoint_died(msg.index, msg.generation);
      self.postMessage({ type: 'endpoint-died-ack', tag: msg.tag, rc });
      return;
    }
    if (msg.type === 'shutdown') {
      // Graceful drain (§21.1): the kernel sweep runs inside nodine_shutdown;
      // the driver then performs the §16.5 final notify sweep over EVERY
      // endpoint's cr_seq + sm_seq (≤ 64×2 notifies) so no waiter hangs.
      const rc = exports.nodine_shutdown(BigInt(Date.now()));
      for (let i = 0; i < MAX_ENDPOINTS; i++) {
        Atomics.notify(epViews[i].smSeq, 0, 1);
        Atomics.notify(epViews[i].crSeq, 0, 1);
      }
      stopped = true;
      self.postMessage({ type: 'kernel-stopped', tag: msg.tag, rc });
      return;
    }
    if (msg.type === 'set-step-mode') {
      stepMode = msg.on;
      self.postMessage({ type: 'step-mode-ack', tag: msg.tag, on: msg.on });
      return;
    }
    if (msg.type === 'step') {
      // One deterministic pump pass (budget applies). In step mode the main
      // loop does not pump; this is the ONLY pump call.
      const mask = exports.nodine_pump(BigInt(Date.now()), msg.budget ?? PUMP_OP_BUDGET);
      notifyMask(mask);
      self.postMessage({ type: 'stepped', tag: msg.tag, mask: mask.toString(16) });
      return;
    }
    if (msg.type === 'set-watchdog') {
      if (msg.on === false || msg.intervalMs == null) {
        watchdog = null;
        self.postMessage({ type: 'watchdog-ack', tag: msg.tag, on: false });
      } else {
        watchdog = { intervalMs: msg.intervalMs, thresholdMs: msg.thresholdMs, lastAt: 0 };
        self.postMessage({ ...msg, type: 'watchdog-ack', tag: msg.tag, on: true }); // type LAST — the spread must not clobber it
      }
      return;
    }
    if (msg.type === 'diag') {
      self.postMessage({ type: 'diag-result', tag: msg.tag, ep: msg.ep, field: msg.field, value: exports.nodine_diag(msg.ep, msg.field).toString() });
      return;
    }
    // ---- P2-006-007 additions ----------------------------------------------
    // kfs-sync: supervisor-side filesystem access on ENDPOINT 0 (the boot
    // pid-1 context) through the §11.2 SYNC MAILBOX — the poc/p2-004
    // native-smoke.cjs syncFs pattern, hosted inside the driver worker so
    // the page never needs its own wasm instance. One op per call:
    // submit (SM_IDLE→SM_SUBMITTED CAS + submit-ring slot write + §10.4
    // doorbell bump), pump, read the completion from the sync mailbox, copy
    // the SYNCRES payload out, retire (SM_COMPLETED→SM_IDLE). The handler is
    // synchronous JS on the driver's single thread, so it can never interleave
    // with the pump loop's own mailbox traffic (and the immediate pump makes
    // latency independent of the doorbell — §13.2).
    if (msg.type === 'kfs-sync') {
      const EP0 = TRANSPORT_BASE;
      const smb = EP0 + EP_MBOX;
      const TX_SYNC_OFF = 0x40000 - 0x2000; // guaranteed sync reserve (§11.6)
      const TX_SYNC_PAYLOAD_MAX = 8128;     // TX_SYNC_RESERVE − 64 (ABI §11.6)
      const buf = ksmRef.buffer;            // CURRENT SAB (growth swaps the object)
      const tx = msg.tx == null ? null
        : msg.tx instanceof Uint8Array ? msg.tx
        : new Uint8Array(msg.tx); // ArrayBuffer tolerated (defensive)
      if (tx && tx.length > TX_SYNC_PAYLOAD_MAX) {
        self.postMessage({ type: 'kfs-sync-result', tag: msg.tag, error: 'tx too large (>8128)' });
        return;
      }
      if (Atomics.load(I32, (smb + 4) / 4) !== SM_IDLE ||
          Atomics.compareExchange(I32, (smb + 4) / 4, SM_IDLE, SM_SUBMITTED) !== SM_IDLE) {
        self.postMessage({ type: 'kfs-sync-result', tag: msg.tag, error: 'sync mailbox busy' });
        return;
      }
      let txOff = 0, txLen = 0;
      if (tx && tx.length) {
        new Uint8Array(buf, EP0 + EP_TX_ARENA + TX_SYNC_OFF, tx.length).set(tx);
        txOff = TX_SYNC_OFF; txLen = tx.length;
      }
      const srh = (EP0 + EP_SRH) / 4;
      const tail = Atomics.load(I32, srh + RH_TAIL);
      const B = new DataView(buf, EP0 + EP_SUBMIT_SLOTS + (tail & MASK) * 64, 64);
      B.setBigUint64(REQ_REQ_ID, 900n, true);
      B.setUint32(REQ_OP, msg.op >>> 0, true);
      B.setUint32(REQ_FLAGS, FLAG_MODE_SYNC >>> 0, true);
      B.setUint32(REQ_TX_OFF, txOff, true);
      B.setUint32(REQ_TX_LEN, txLen, true);
      B.setBigUint64(REQ_A0, BigInt(msg.a0 ?? 0), true);
      B.setBigUint64(REQ_A0 + 8, BigInt(msg.a1 ?? 0), true);
      B.setBigUint64(REQ_A0 + 16, BigInt(msg.a2 ?? 0), true);
      B.setBigUint64(REQ_A0 + 24, 0n, true);
      B.setBigUint64(REQ_A0 + 32, 0n, true);
      Atomics.store(I32, srh + RH_TAIL, tail + 1);
      Atomics.add(I32, srh + RH_EXTRA, 1);
      // §10.4 producer discipline: bump + notify the kernel doorbell after a
      // submit (a wake hint; the direct pump below makes it latency-irrelevant
      // — same thread — but the ABI asks producers to bump).
      Atomics.add(doorbellView, 0, 1);
      Atomics.notify(doorbellView, 0, 1);
      { // E5: the kfs-sync inline pump is driver busy time too
        const t0 = performance.now();
        try {
          exports.nodine_pump(BigInt(Date.now()), 0); // budget 0 = unbounded
        } finally {
          if (DRIVER_PERF) { DRIVER_PERF.kfsBusyMs += performance.now() - t0; DRIVER_PERF.kfsCalls++; }
        }
      }
      const DV = new DataView(buf, smb, 64);
      const status = DV.getInt32(0x18, true);  // SM_STATUS
      const kind = DV.getUint32(0x1c, true);   // SM_KIND
      const len = DV.getUint32(0x24, true);    // SM_LEN
      const inlineV = DV.getUint32(0x28, true); // SM_INLINE
      // Copy the SYNCRES payload (kind 3) out of the KSM BEFORE retiring the
      // mailbox — the reply transfers the plain Uint8Array's buffer to the
      // page (the view itself survives the transfer).
      let syncres = null;
      if (kind === 3 && len > 0 && len <= 0x40000) {
        syncres = new Uint8Array(len);
        syncres.set(new Uint8Array(buf, EP0 + EP_SYNCRES, len));
      }
      Atomics.compareExchange(I32, (smb + 4) / 4, SM_COMPLETED, SM_IDLE);
      self.postMessage(
        { type: 'kfs-sync-result', tag: msg.tag, status, inline: inlineV, len, syncres },
        syncres ? [syncres.buffer] : []
      );
      return;
    }
    // stdin-feed: write the caller's bytes into the 1 KiB kernel scratch at
    // KSM 0x2100 (u8 view) and call nodine_stdin_feed — the bytes land in
    // the kernel stdin FIFO and the foreground process's next fd-0 read
    // drains them (EAGAIN when empty — the worker-side bridge retries).
    // Bounded to the scratch cap; {ok} = accepted byte count (the kernel
    // rejects non-0x2100 offsets and len 0 — validated in native-smoke p7).
    if (msg.type === 'stdin-feed') {
      const STDIN_SCRATCH_OFF = 0x2100, STDIN_SCRATCH_CAP = 1024;
      const bytes = msg.bytes == null ? new Uint8Array(0)
        : msg.bytes instanceof Uint8Array ? msg.bytes
        : new Uint8Array(msg.bytes);
      const n = Math.min(bytes.length, STDIN_SCRATCH_CAP);
      let accepted = 0;
      if (n > 0 && ksmRef) {
        new Uint8Array(ksmRef.buffer, STDIN_SCRATCH_OFF, n).set(bytes.subarray(0, n));
        accepted = exports.nodine_stdin_feed(STDIN_SCRATCH_OFF, n);
      }
      self.postMessage({ type: 'stdin-fed', tag: msg.tag, ok: accepted });
      return;
    }
    // flush-stdio: drain BOTH kernel stdio FIFOs RIGHT NOW and forward the
    // bytes, instead of waiting for the next 50 ms keepalive tick. The
    // supervisor calls this the moment a worker reports proc-exit — the
    // worker used to sleep ~70 ms before OP_PROC_EXIT purely so its final
    // writes would survive one keepalive tick (exit latency: every command
    // paid 70+ ms). With an explicit flush the sleep is unnecessary: the
    // FIFO is drained synchronously here, BEFORE the endpoint reclaim.
    if (msg.type === 'flush-stdio') {
      drainStdio();
      self.postMessage({ type: 'stdio-flushed', tag: msg.tag });
      return;
    }
  } catch (e) {
    self.postMessage({ type: 'driver-error', error: String((e && e.stack) || e), during: msg && msg.type });
  }
});

function notifyMask(asyncMask) {
  // async completions → cr_seq; sync completions (KH sync mask) → sm_seq.
  // Routing them separately keeps sync traffic from spuriously waking the
  // bridges' async waiter chains (measured as real contention on 2 cores).
  const syncMask = exports.nodine_sync_mask();
  if (asyncMask === 0n && syncMask === 0n) return;
  const __ntT0 = DRIVER_PERF ? performance.now() : 0;
  let __cr = 0, __sm = 0;
  for (let i = 0; i < MAX_ENDPOINTS; i++) {
    const b = BigInt(i);
    if ((syncMask >> b) & 1n) { Atomics.notify(epViews[i].smSeq, 0, 1); __sm++; }
    if ((asyncMask >> b) & 1n) { Atomics.notify(epViews[i].crSeq, 0, 1); __cr++; }
  }
  if (DRIVER_PERF) {
    if (__cr) DRIVER_PERF.passesWithAsync++;
    DRIVER_PERF.crNotifies += __cr;
    DRIVER_PERF.smNotifies += __sm;
    if (asyncMask !== 0n) {
      DRIVER_PERF.notifyLoopMs.push(performance.now() - __ntT0);
      if (DRIVER_PERF.notifyLoopMs.length > 4096) DRIVER_PERF.notifyLoopMs.splice(0, 2048);
    }
  }
}

// §10.5 doorbell loop with op-budget slicing (F-E1):
//   epoch load BEFORE pump (§15.5); pump in bounded slices while the kernel
//   reports immediately-re-pumpable pending work; deferred work is recovered
//   by the ≤250 ms wait cadence (retire does not bump the doorbell — §10.4);
//   heartbeat is written at every pump entry, so it stays fresh under
//   saturation as long as each slice is bounded.
//
// NOTE: every iteration yields to the worker event loop (setTimeout 0) so
// the postMessage control plane is serviced — the P2-003 driver polled a
// reserved KSM word instead (a §5.2 write-discipline violation, retired in
// P2-004); yielding makes the control plane first-class. The yield happens
// BEFORE the doorbell wait each round, so notify latency is unaffected.
// P2-005-006 stdio pump — OP_WRITEs on the shared stdio device OFDs land in
// the kernel's bounded FIFOs (FD_SPEC §4.3); the host drains them here into
// the kernel-heap scratch (the transport-probe 4 KiB region — serialized
// driver discipline: this never overlaps a pump's probe use) and posts the
// bytes to the page. 50 ms keepalive keeps tail latency well under the 250 ms
// doorbell cadence for quiet consoles.
let ksmRef = null; // module-level KSM handle (boot sets it; growth swaps .buffer)
const KH_SCRATCH_OFF = 0x051A2880;
const STDIO_SCRATCH_CAP = 4096;
// AV-R7: per-stream streaming decoders — a multi-byte code point straddling
// a 4 KiB chunk boundary must not corrupt into U+FFFD pairs.
const decOut = new TextDecoder();
const decErr = new TextDecoder();
let stdioTimer = null;
function drainStdio() {
  if (!exports.nodine_stdio_drain) return;
  if (!ksmRef) return;
  const b = ksmRef.buffer; // CURRENT SAB (growth swaps the object)
  for (const stream of [0, 1]) {
    for (;;) {
      const n = Number(exports.nodine_stdio_drain(stream, KH_SCRATCH_OFF, STDIO_SCRATCH_CAP));
      if (n === 0) break;
      // TextDecoder.decode REJECTS views over a SharedArrayBuffer — copy the
      // scratch bytes into a plain ArrayBuffer first (also decouples the post
      // from the scratch region's next drain).
      const copy = new Uint8Array(n);
      copy.set(new Uint8Array(b, KH_SCRATCH_OFF, n));
      self.postMessage({
        type: stream === 0 ? 'stdout' : 'stderr',
        text: (stream === 0 ? decOut : decErr).decode(copy, { stream: true }),
      });
      if (n < STDIO_SCRATCH_CAP) break;
    }
  }
}
function startStdioKeepalive() {
  if (stdioTimer) return;
  stdioTimer = setInterval(drainStdio, 50);
}

async function loop() {
  startStdioKeepalive();
  let expected = 0;
  for (;;) {
    if (stepMode) {
      // paused: only the watchdog timer runs; pump happens via 'step' messages
      await new Promise((r) => setTimeout(r, 25));
      runWatchdog();
      const st = Atomics.load(I32, KCTL_STATE);
      if (st === 3) { stopped = true; self.postMessage({ type: 'kernel-stopped', rc: 0 }); return; }
      continue;
    }
    expected = Atomics.load(doorbellView, 0);
    for (;;) {
      // P2-008-PERF DIAG: wrap the pump so a wasm trap names the EXACT
      // pending submit-ring requests (op + args + txlen) at the moment of
      // death — the trap frame alone cannot tell us which write trapped.
      let mask;
      try {
        mask = pumpTimed(BigInt(Date.now()), PUMP_OP_BUDGET);
      } catch (e) {
        self.postMessage({ type: 'driver-loop-died', error: String((e && e.stack) || e), pending: dumpPendingReqs() });
        stopped = true;
        return;
      }
      notifyMask(mask);
      if (exports.nodine_pending() === 0n) break;
      // pending = budget-exhausted work: immediately re-pump. (A deferred
      // endpoint is never 'pending' — see nodine_pump's doc comment.)
    }
    drainStdio();
    runWatchdog();
    const st = Atomics.load(I32, KCTL_STATE);
    if (st === 3) { self.postMessage({ type: 'kernel-stopped', rc: 0 }); return; }
    // §10.5 doorbell wait — ASYNC (waitAsync): the wake path stays µs-class
    // (M9/E5-b measured p50 0.015 ms) AND the worker's event loop stays live
    // so the postMessage control plane flows without a timer-clamped yield
    // (the first P2-004 draft used setTimeout(0) per round trip — 4 ms p50,
    // 400× the §23 budget; P2-003's blocking Atomics.wait could not service
    // messages at all, which is why it polled the reserved 0x2004 word).
    {
      const t0 = performance.now();
      await Atomics.waitAsync(doorbellView, 0, expected, 250).value;
      if (DRIVER_PERF) DRIVER_PERF.waitMs += performance.now() - t0;
    }
    if (stopped) return;
  }
}

// P2-008-PERF DIAG: read every endpoint's unconsumed submit-ring slots
// (head..tail) — the request that trapped mid-op is still in its ring.
function dumpPendingReqs() {
  const out = [];
  try {
    for (let i = 0; i < MAX_ENDPOINTS; i++) {
      const base = TRANSPORT_BASE + i * EP_STRIDE;
      const srh = base + EP_SRH;
      const head = Atomics.load(I32, srh / 4);
      const tail = Atomics.load(I32, (srh / 4) + 1);
      if (tail === head) continue;
      const DV = new DataView(ksmRef.buffer);
      let n = 0;
      for (let s = head; s !== tail && n < 16; s++, n++) {
        const slot = base + EP_SUBMIT_SLOTS + (s & MASK) * 64;
        out.push({
          ep: i, op: '0x' + DV.getUint32(slot + 0x08, true).toString(16),
          flags: DV.getUint32(slot + 0x0c, true), txLen: DV.getUint32(slot + 0x14, true),
          a0: DV.getBigUint64(slot + 0x18, true).toString(),
          a1: DV.getBigUint64(slot + 0x20, true).toString(),
          a2: DV.getBigUint64(slot + 0x28, true).toString(),
        });
      }
    }
  } catch {}
  return out;
}

function runWatchdog() {
  if (!watchdog) return;
  const now = Date.now();
  if (now - watchdog.lastAt < watchdog.intervalMs) return;
  watchdog.lastAt = now;
  const mask = exports.nodine_watchdog(BigInt(now), watchdog.thresholdMs);
  if (mask !== 0n) self.postMessage({ type: 'suspect', mask: mask.toString(16) });
}
