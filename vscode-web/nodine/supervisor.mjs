// P2-006-007 supervisor — the browser TERMINAL + PROCESS SUPERVISOR.
//
// One shared kernel (KSM + wasm) booted once per page inside the
// kernel-driver worker. Every process = a NEW Web Worker
// (runtime-worker.mjs) with its OWN
// kernel endpoint. Processes share the kernel VFS (that is how npm
// reads/writes files). This module owns:
//
//   * the driver RPC channel (boot / alloc-endpoint / endpoint-died / diag /
//     shutdown / kfs-sync / stdin-feed),
//   * supervisor-side VFS access through endpoint 0's SYNC MAILBOX
//     (seeding, PATH search, shebang reads, symlink resolution),
//   * the exec rules (PATH -> shebang -> node-worker; the exact frozen
//     contract lives in docs/runtime-worker-contract.md),
//   * the process tree (spawn/exit/SIGINT relay, pipe-mode stdio relay),
//   * the ANSI terminal emulator + the minimal line editor (NOT a shell).
//
// Message contracts are FROZEN — see docs/runtime-worker-contract.md.

// ---------------------------------------------------------------------------
// ABI constants (kernel-abi/src/lib.rs — the poc/p2-004 native-smoke spellings)
// ---------------------------------------------------------------------------
const OP_OPEN = 0x0100, OP_CLOSE = 0x0101, OP_READ = 0x0102, OP_WRITE = 0x0103;
const OP_STAT = 0x0104, OP_LSTAT = 0x0105, OP_FSTAT = 0x0106, OP_MKDIR = 0x0107;
const OP_READDIR = 0x010B, OP_SYMLINK = 0x0125, OP_READLINK = 0x0126, OP_CHMOD = 0x0122;
const OP_RMDIR = 0x0108, OP_UNLINK = 0x0109; // B1 builtins (rm)
const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_CREAT = 64, O_TRUNC = 512;
const TX_SYNC_PAYLOAD_MAX = 8128; // ABI §11.6: TX_SYNC_RESERVE − 64

const enc = new TextEncoder();
const dec = new TextDecoder();

// B10 CACHE-BUST: runtime-worker.mjs is served with max-age=300; the page
// loads THIS module as supervisor.mjs?v=<content-stamp> after a re-stage.
// Propagate the stamp to every Worker URL so pooled/fresh workers can never
// boot a stale runtime-worker from cache. NOTE: import.meta.url, NOT
// self.location — the supervisor runs on the MAIN thread where
// self.location is the PAGE (its query is the page's, e.g. ?e2e=1, and the
// workers would get an unversioned URL right back). Bare embeds (no query
// on this module's own URL) keep the plain relative URL.
const WORKER_URL = (() => {
  try {
    const u = new URL(import.meta.url);
    // Resolve against THIS module's URL, not the page base: the runtime
    // bundle is self-contained and the host may serve it from any
    // directory. The content-stamp query (?v=…) on supervisor.mjs
    // propagates to every Worker URL, so pooled/fresh workers can never
    // boot a stale runtime-worker from cache.
    const w = new URL('runtime-worker.mjs', u);
    if (u.search) w.search = u.search;
    return w.href;
  } catch { return 'runtime-worker.mjs'; }
})();

// Worker-safe diagnostics sink: `window.__p2007` on the main thread, no-op in
// a Worker context (where `window` is not defined — the VS Code extension
// host embeds this supervisor inside a worker).
const DIAG = (typeof window !== 'undefined' && window.__p2007) || undefined;

// ---------------------------------------------------------------------------
// Terminal emulator (80×30 viewport, ≥5000-line scrollback, minimal ANSI set)
// ---------------------------------------------------------------------------
const COLS = 80, ROWS = 30, SCROLLBACK_MAX = 6000;

class Row {
  constructor() { this.c = new Uint16Array(16); this.s = new Uint16Array(16); this.n = 0; }
  ensure(k) {
    if (k <= this.c.length) return;
    let cap = this.c.length;
    while (cap < k) cap *= 2;
    const c = new Uint16Array(cap), s = new Uint16Array(cap);
    c.set(this.c); s.set(this.s); this.c = c; this.s = s;
  }
  put(col, ch, style) {
    this.ensure(col + 1);
    this.c[col] = ch; this.s[col] = style;
    if (col + 1 > this.n) this.n = col + 1;
  }
  clearRange(from, to) { // [from, to)
    const a = Math.max(0, from), b = Math.min(this.n, to);
    if (b > a) { this.c.fill(0, a, b); this.s.fill(0, a, b); }
    if (to >= this.n && from <= 0) this.n = 0;
    else if (to >= this.n) this.n = a;
  }
}

// 16-color xterm palette — index = SGR color − 29 (30→1 black … 37→7 white,
// 90→8 bright black … 97→15 bright white); index 0 = default.
const PALETTE = [
  null, '#8b949e', '#ff7b72', '#7ee787', '#ffd479', '#79b8ff', '#d2a8ff', '#76e3ea',
  '#9aa7b3', '#ffabaa', '#a4f2a8', '#ffe08a', '#a5d6ff', '#e2c5ff', '#b3f0f3', '#ffffff',
];

export class Term {
  constructor(el) {
    this.el = el;
    this.rows = [new Row()];
    this.row = 0; this.col = 0;
    this.style = 0;           // fg:0-15 | bold:16 | dim:32
    this.cursorVisible = true;
    this.pend = '';           // incomplete escape sequence across chunks
    this.viewOff = 0;         // rows scrolled up from the bottom (0 = follow)
    this.dirty = false;
    this.rAF = 0;
    this.rafRender = this.rafRender.bind(this);
  }
  // -- grid helpers ---------------------------------------------------------
  ensureRow(r) { while (this.rows.length <= r) this.rows.push(new Row()); }
  trim() {
    if (this.rows.length <= SCROLLBACK_MAX) return;
    const k = this.rows.length - SCROLLBACK_MAX;
    this.rows.splice(0, k);
    this.row = Math.max(0, this.row - k);
    if (this.onTrim) this.onTrim(k);
  }
  putChar(ch) {
    if (this.col >= COLS) { this.row++; this.col = 0; } // autowrap
    this.ensureRow(this.row);
    this.rows[this.row].put(this.col, ch, this.style);
    this.col++;
    this.trim();
  }
  nl() { this.row++; this.col = 0; this.ensureRow(this.row); this.trim(); } // ONLCR
  // -- output ---------------------------------------------------------------
  writeStr(text, styleOverride) {
    const saved = this.style;
    if (styleOverride !== undefined) this.style = styleOverride;
    this.write(text);
    this.style = saved;
  }
  meta(text) { this.writeStr(text, 7); } // terminal's own messages: cyan (SGR 36)
  // Plain-text dump of the scrollback (E2E observation; styled-free).
  textDump() {
    const out = [];
    for (const row of this.rows) {
      let line = '';
      for (let i = 0; i < row.n; i++) line += String.fromCharCode(row.c[i]);
      out.push(line);
    }
    return out.join('\n');
  }
  write(text) {
    this.pend += text;
    let i = 0;
    const s = this.pend;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        const used = this.esc(s, i);
        if (used === -1) break; // incomplete — wait for more bytes
        i += used;
        continue;
      }
      if (ch === '\n') { this.nl(); i++; continue; }
      if (ch === '\r') { this.col = 0; i++; continue; }
      if (ch === '\b') { this.col = Math.max(0, this.col - 1); i++; continue; }
      if (ch === '\t') { // next multiple of 8 (not in the frozen set, but a
        // raw tab otherwise mangles columns; expanded like a real tty)
        this.putChar(32);
        while (this.col % 8 !== 0 && this.col < COLS) this.putChar(32);
        i++; continue;
      }
      if (ch < ' ') { i++; continue; } // strip other C0 controls
      this.putChar(ch.codePointAt(0));
      i++;
    }
    this.pend = s.slice(i);
    this.markDirty();
  }
  // Parse one escape sequence at s[i] ('ESC' consumed by caller? no — returns
  // chars used INCLUDING the ESC). Returns -1 when the sequence is incomplete.
  esc(s, i) {
    if (i + 1 >= s.length) return -1;
    const t = s[i + 1];
    if (t === '[') { // CSI: params until a final byte in @..~
      let j = i + 2;
      while (j < s.length && !(/[@-~]/).test(s[j])) j++;
      if (j >= s.length) return -1;
      const body = s.slice(i + 2, j), fin = s[j];
      this.csi(body, fin);
      return (j + 1) - i;
    }
    if (t === ']') { // OSC: strip until BEL or ESC \
      const bel = s.indexOf('\x07', i + 2);
      const st = s.indexOf('\x1b\\', i + 2);
      if (bel === -1 && st === -1) return -1;
      return ((bel !== -1 && (st === -1 || bel < st)) ? bel + 1 : st + 2) - i;
    }
    if (t === '(' || t === ')' || t === '#' || t === '%') { // charset etc: 1 more
      if (i + 2 >= s.length) return -1;
      return 3;
    }
    return 2; // single-char escape (RIS, DECSC, …): stripped
  }
  csi(body, fin) {
    const priv = body.startsWith('?');
    const params = (priv ? body.slice(1) : body).split(';').map((x) => parseInt(x, 10) || 0);
    const n = params[0] || 1;
    if (fin === 'm') { // SGR
      if (params.length === 1 && params[0] === 0) { this.style = 0; return; }
      for (const p of params) {
        if (p === 0) this.style = 0;
        else if (p === 1) this.style |= 16;
        else if (p === 2) this.style |= 32;
        else if (p === 22) this.style &= ~(16 | 32);
        else if (p >= 30 && p <= 37) this.style = (this.style & ~15) | (p - 29);
        else if (p >= 90 && p <= 97) this.style = (this.style & ~15) | (p - 90 + 8);
        else if (p === 39) this.style &= ~15;
        // other SGR codes ignored (bg colors, underline, …)
      }
      return;
    }
    if (fin === 'A') { this.row = Math.max(0, this.row - n); return; }
    if (fin === 'B') { this.row += n; this.ensureRow(this.row); return; }
    if (fin === 'C') { this.col = Math.min(COLS - 1, this.col + n); return; }
    if (fin === 'D') { this.col = Math.max(0, this.col - n); return; }
    if (fin === 'K') {
      const r = (this.rows[this.row] ||= new Row());
      if (params[0] === 1) r.clearRange(0, this.col + 1);
      else if (params[0] === 2) r.clearRange(0, COLS);
      else r.clearRange(this.col, COLS);
      return;
    }
    if (fin === 'J') {
      if (params[0] === 2) {
        this.rows.length = Math.min(this.rows.length, this.row + 1);
        (this.rows[this.row] ||= new Row()).clearRange(0, COLS);
      } else { // 0 (default): cursor → end of screen
        this.ensureRow(this.row);
        this.rows[this.row].clearRange(this.col, COLS);
        this.rows.length = this.row + 1;
      }
      return;
    }
    if (fin === 'h' || fin === 'l') {
      if (priv && params[0] === 25) this.cursorVisible = fin === 'h';
      return; // other private modes stripped
    }
    // everything else stripped (per the frozen minimal set)
  }
  // -- editor helpers -------------------------------------------------------
  clearFrom(rowIdx) { // erase grid from a row onward (prompt redraw)
    this.rows.length = Math.max(0, rowIdx);
    this.row = Math.max(0, Math.min(this.row, this.rows.length - 1));
  }
  // -- rendering ------------------------------------------------------------
  markDirty() {
    if (this.dirty) return;
    this.dirty = true;
    this.rAF = requestAnimationFrame(this.rafRender);
  }
  rafRender() {
    this.dirty = false;
    this.render();
  }
  render() {
    const total = this.rows.length;
    const top = Math.max(0, total - ROWS - this.viewOff);
    let html = '';
    for (let r = top; r < top + ROWS && r < total; r++) html += this.renderRow(r, r === this.row);
    // pad to the full viewport so the cursor stays put on short screens
    for (let r = total; r < top + ROWS; r++) html += '\n';
    this.el.innerHTML = html;
  }
  renderRow(r, isCursorRow) {
    const row = this.rows[r];
    if (row.n === 0) {
      return (isCursorRow && this.cursorVisible ? cursorSpan(' ') : '') + '\n';
    }
    let out = '', curStyle = -1, run = '';
    const flush = () => {
      if (run) out += curStyle === 0 ? escapeHtml(run) : spanHtml(run, curStyle);
      run = '';
    };
    const n = Math.max(row.n, isCursorRow ? this.col + 1 : 0);
    for (let c = 0; c < Math.min(n, COLS); c++) {
      const st = c < row.n ? row.s[c] : 0;
      const ch = c < row.n ? row.c[c] : 32;
      if (isCursorRow && this.cursorVisible && c === this.col) {
        flush();
        out += cursorSpan(ch === 32 ? ' ' : String.fromCharCode(ch));
        continue;
      }
      if (st !== curStyle) { flush(); curStyle = st; }
      run += String.fromCharCode(ch);
    }
    flush();
    return out + '\n';
  }
  scrollBy(rows) {
    this.viewOff = Math.max(0, Math.min(this.rows.length - 1, this.viewOff + rows));
    this.markDirty();
  }
  scrollTop() { this.viewOff = Math.max(0, this.rows.length - 1); this.markDirty(); }
  scrollBottom() { this.viewOff = 0; this.markDirty(); }
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function spanHtml(text, style) {
  const fg = style & 15, bold = style & 16, dim = style & 32;
  const color = PALETTE[fg] || 'inherit';
  const weight = bold ? 'font-weight:700' : dim ? 'font-weight:200;opacity:.65' : '';
  return `<span style="color:${color};${weight}">${escapeHtml(text)}</span>`;
}
function cursorSpan(ch) {
  return `<span class="tcursor">${escapeHtml(ch)}</span>`;
}

// ---------------------------------------------------------------------------
// Command line tokenizer (quotes respected; metachar detection is quote-aware)
// ---------------------------------------------------------------------------
export function parseCommandLine(line) {
  const argv = [], assignments = [];
  let metachar = null;
  let i = 0;
  const isQuote = (c) => c === '\'' || c === '"';
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    // quote-aware metachar scan across the whole line happens inline below
    const start = i;
    let tok = '', quoted = false;
    while (i < line.length) {
      const c = line[i];
      if (isQuote(c)) {
        quoted = true;
        const q = c; i++;
        while (i < line.length && line[i] !== q) { tok += line[i++]; }
        if (i >= line.length) return { error: 'unterminated quote' };
        i++; continue;
      }
      if (/\s/.test(c)) break;
      if (c === '|' || c === '<' || c === '>') {
        if (!quoted) { metachar = c; }
        // still consume into the token (the line is rejected anyway)
      }
      if (c === '&' && line[i + 1] === '&' && !quoted) metachar = '&&';
      if (c === ';' && !quoted) metachar = ';';
      tok += c; i++;
    }
    if (start === i) break;
    if (!tok) continue;
    argv.push(tok);
  }
  // leading VAR=val assignments
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]) && argv[0] !== 'export') {
    assignments.push(argv.shift());
  }
  return { argv, assignments, metachar };
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------
export class Supervisor {
  constructor(term, statusEls, perfOpts) {
    this.term = term;
    this.status = statusEls; // {kernel, procs, cwd, exit, seed}
    this.kdrv = null;
    this.ksm = null;
    this.kernel = null;
    this.procs = new Map();  // pid -> proc record
    this.nextPid = 2;
    // B7 WARM POOL: pre-spawned IDLE runtime workers. The worker's module
    // top (libsources parse via the supervisor handoff, uvmap fetch,
    // binding factories) is PROCESS-INDEPENDENT — it parks at
    // `await initPromise` until a nodine-init arrives. A pooled spawn
    // skips the module parse + libsources clone + top-level boot entirely:
    // only transportAttach + PROC_READY + entry remain. Refill is DEFERRED
    // (idle callback / 2 s) so a burst of spawns never pays pool refill on
    // the interactive path.
    this.warmWorkers = [];
    this.warmTarget = 2;
    this._warmRefillScheduled = false;
    this.foreground = null;  // the terminal-root process currently owning keys
    this.terminalOwner = null; // B9: deepest live inherit-fd0 descendant actually reading fd0
    this.baseEnv = {
      HOME: '/home/user', PATH: '/usr/bin:/bin',
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_fetch_retries: '2',
      // npm's default loglevel is 'notice' (the ⠼ progress line + the
      // result summary). The step-2 npm-debug-era 'info' override spewed
      // 'npm info using npm@…' + every 'npm http fetch' line — that was a
      // debugging aid, not product behavior. Back to notice.
      npm_config_loglevel: 'notice',
      // P2-006-008-3: skip npm's audit + funding requests — in the sandbox
      // they cost a registry round trip (the bulk-advisories POST is the one
      // request whose preflight the registry cannot answer) and contribute
      // nothing to the install (StackBlitz-class products run the same way).
      npm_config_audit: 'false', npm_config_fund: 'false',
      // P2-006-008-3b: match npm's connection fan-out to the relay's 8-slot
      // upstream gate (default 15 sockets × retries escalated into CDN
      // throttling under burst — measured: trickle-fed sockets at 694-1001 s
      // each after sustained bulk pulling).
      npm_config_maxsockets: '8',
      TERM: 'xterm-256color', LANG: 'en_US.UTF-8', SHELL: '/bin/sh',
    }; // NO CI var (deliberate — interactive terminal, not CI)
    this.dirCache = new Set(['/']);
    this.stopped = false;
    this.stats = { bootMs: null, seedMs: null, seedFetchMs: null, files: 0, bytes: 0 };
    // ---- B1-PREVIEW: the browser preview bridge --------------------------------
    // The page calls initPreviewSW(sid, swPort) after registering the
    // preview service worker. Every spawned worker that asks to listen
    // gets a dedicated channel to the SW; the registry maps port → owning
    // proc for cleanup + events (Amplify's PreviewsStore equivalent).
    this.previewSid = null;      // page session id
    this.previewSW = null;       // port toward sw-nodine.js
    this.previewPorts = new Map(); // port -> { pid, argv }
    this.onPreviewEvent = null;  // page hook: ({kind:'open'|'close', port, pid, argv})
    // M1.5 page hook: preview-error messages forwarded by the SW (captured
    // inside preview documents). Shape: {type:'preview-error', sid, port,
    // kind:'uncaught'|'rejection'|'console', message, pathname, search,
    // hash, ...metadata}.
    this.onPreviewMessage = null;
    // ---- P2-008-PERF Step-0 (docs/perf/baseline.md) -----------------------
    // Activated by terminal.html when the page is loaded with ?perf=1.
    // Collects: per-process timeline, worker RPC histograms (from perf-exit),
    // 5 s worker state trail (hang detector), kernel diag poll, phase marks.
    this.perf = !!(perfOpts && perfOpts.perf);
    this.perfData = {
      on: this.perf, t0: performance.now(),
      procs: [],        // completed process summaries {pid,parentPid,argv,spawnAt,readyAt,exitAt,code}
      states: [],       // 5 s worker-state trail (per push)
      kpoll: [],        // 5 s kernel diag poll
      exits: [],        // perf-exit dumps (per worker)
      boots: [],        // perf-boot / perf-entry records
      marks: [],        // bench phase marks (set via mark())
      driver: [],       // E5: driver-perf pushes (pump busy %, pump calls, ops)
      thread: { busyMs: 0, msgN: 0, kfsMs: 0, kfsN: 0, termMs: 0, lagP95: 0 }, // E5: supervisor main-thread accounting
    };
    this.perfMonTimer = null;
    if (this.perf) {
      // P2-008-PERF: npm timing JSON + time/timeEnd taps for every npm in the
      // tree (children inherit the parent env). Baseline instrumentation only.
      this.baseEnv.npm_config_timing = 'true';
    }
  }

  mark(name, data) { // phase marks for the benchmark protocol
    if (!this.perf) return;
    this.perfData.marks.push({ name, t: +(performance.now() - this.perfData.t0).toFixed(0), ...(data || {}) });
  }

  // P2-008-PERF: 5 s monitor — kernel diag (heap/residency/inodes/procs) via
  // the driver's diag RPC + hang trail from worker perf-state pushes.
  startPerfMonitor() {
    if (!this.perf || this.perfMonTimer) return;
    // E5 (Step-0.5): supervisor MAIN-THREAD accounting — cumulative JS time
    // inside worker/driver message handling, kfs RPCs, and terminal writes,
    // plus a 500 ms timer-lateness probe (event-loop congestion signal).
    // The page thread does no kernel ops (workers talk to the driver
    // directly); this verifies that claim with numbers.
    {
      const th = this.perfData.thread;
      const owm = this.onWorkerMsg.bind(this);
      this.onWorkerMsg = (proc, m) => { const t0 = performance.now(); try { return owm(proc, m); } finally { th.busyMs += performance.now() - t0; th.msgN++; } };
      const odm = this.onDriverMsg.bind(this);
      this.onDriverMsg = (m) => { const t0 = performance.now(); try { return odm(m); } finally { th.busyMs += performance.now() - t0; th.msgN++; } };
      const okfs = this.kfs.bind(this);
      this.kfs = (...a) => { const t0 = performance.now(); return okfs(...a).finally(() => { th.kfsMs += performance.now() - t0; th.kfsN++; }); };
      const owrite = this.term.write.bind(this.term);
      this.term.write = (d) => { const t0 = performance.now(); try { return owrite(d); } finally { th.termMs += performance.now() - t0; } };
      th.lag = [];
      let last = performance.now();
      this.__lagTimer = setInterval(() => { const now = performance.now(); const late = now - last - 500; last = now; if (late > 1) { th.lag.push(+late.toFixed(1)); if (th.lag.length > 1200) th.lag.shift(); } }, 500);
    }
    const FIELDS = { kallocRegion: 16, kallocLive: 17, kallocHigh: 18, inodes: 22, residency: 25, procsK: 35 };
    this.perfMonTimer = setInterval(async () => {
      if (this.stopped) return;
      const rec = { t: +(performance.now() - this.perfData.t0).toFixed(0), ksmBytes: this.ksm ? this.ksm.buffer.byteLength : 0 };
      try {
        for (const [k, f] of Object.entries(FIELDS)) {
          const r = await this.rpc({ type: 'diag', ep: 0, field: f });
          rec[k] = Number(r.value);
        }
      } catch {}
      this.perfData.kpoll.push(rec);
      // hang detection: a live proc whose last state push is stale (>12 s)
      const now = performance.now();
      for (const p of this.procs.values()) {
        if (p.lastPerfState && now - p.lastPerfStateAt > 12000) {
          this.perfData.states.push({ t: +(now - this.perfData.t0).toFixed(0), pid: p.pid, stale: true, ...(p.lastPerfState || {}) });
        }
      }
    }, 5000);
  }

  // -- driver RPC ------------------------------------------------------------
  rpc(msg, transfer, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const tag = ++this.rpc.tag;
      msg.tag = tag;
      const onMsg = (ev) => {
        if (ev.data?.tag === tag) { this.kdrv.removeEventListener('message', onMsg); resolve(ev.data); }
      };
      this.kdrv.addEventListener('message', onMsg);
      this.kdrv.postMessage(msg, transfer || []);
      setTimeout(() => { this.kdrv.removeEventListener('message', onMsg); reject(new Error('rpc timeout ' + msg.type)); }, timeoutMs);
    });
  }
  // -- sync fs on endpoint 0 (driver kfs-sync) --------------------------------
  // a0/a1/a2 go as BigInts (−1 = positional "use fd offset" sentinel);
  // tx is a Uint8Array (structured-clone copies subarray views correctly).
  async kfs(op, a0 = 0, a1 = 0, a2 = 0, txBytes = null) {
    const r = await this.rpc({ type: 'kfs-sync', op, a0: BigInt(a0), a1: BigInt(a1), a2: BigInt(a2), tx: txBytes });
    if (r.type !== 'kfs-sync-result' || r.error) throw new Error('kfs-sync: ' + (r.error || r.type));
    if (r.syncres != null && !(r.syncres instanceof Uint8Array)) {
      // defensive: normalize an ArrayBuffer into a Uint8Array view
      r.syncres = r.syncres instanceof ArrayBuffer ? new Uint8Array(r.syncres) : new Uint8Array(r.syncres.buffer ?? r.syncres);
    }
    return r; // {status, inline, len, syncres: Uint8Array|null}
  }
  // 18-slot f64 stat view over a SYNCRES payload ([1]=mode [8]=size …)
  statView(syncres) {
    if (!syncres || syncres.length < 144) return new Float64Array(144);
    return new Float64Array(syncres.buffer, syncres.byteOffset, 18);
  }

  // -- path helpers -----------------------------------------------------------
  normalizePath(p) {
    const abs = p.startsWith('/');
    const out = [];
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (out.length) out.pop(); continue; }
      out.push(part);
    }
    const joined = out.join('/');
    return abs ? '/' + joined : (joined || '.');
  }
  abs(cwd, p) { return p.startsWith('/') ? this.normalizePath(p) : this.normalizePath(cwd + '/' + p); }
  parentOf(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }

  async kstat(path) {
    const r = await this.kfs(OP_STAT, 0, 0, 0, enc.encode(path));
    if (r.status !== 0) return { ok: false, status: r.status };
    const f = this.statView(r.syncres);
    const mode = f[1];
    return { ok: true, mode, size: f[8], isDir: (mode & 0o170000) === 0o040000, isFile: (mode & 0o170000) === 0o100000, isSymlink: false };
  }
  async klstat(path) {
    const r = await this.kfs(OP_LSTAT, 0, 0, 0, enc.encode(path));
    if (r.status !== 0) return { ok: false, status: r.status };
    const f = this.statView(r.syncres);
    const mode = f[1];
    return { ok: true, mode, size: f[8], isDir: (mode & 0o170000) === 0o040000, isFile: (mode & 0o100000) === 0o100000, isSymlink: (mode & 0o170000) === 0o120000 };
  }
  async mkdirP(dir) {
    if (this.dirCache.has(dir)) return;
    const parts = this.normalizePath(dir).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      if (this.dirCache.has(cur)) continue;
      const r = await this.kfs(OP_MKDIR, 0o777, 0, 0, enc.encode(cur));
      if (r.status !== 0 && r.status !== -17) throw new Error('mkdir ' + cur + ' -> errno ' + r.status);
      this.dirCache.add(cur);
    }
  }
  // B1 builtins: single-component fs mutations for the rm/mkdir commands.
  // errno -17 (EEXIST) tolerated like the kernel's own create paths.
  async kmkdirOne(path, mode = 0o777) {
    const r = await this.kfs(OP_MKDIR, mode, 0, 0, enc.encode(path));
    if (r.status !== 0 && r.status !== -17) return r.status;
    this.dirCache.add(path);
    return 0;
  }
  async kunlink(path) {
    const r = await this.kfs(OP_UNLINK, 0, 0, 0, enc.encode(path));
    return r.status;
  }
  async krmdir(path) {
    const r = await this.kfs(OP_RMDIR, 0, 0, 0, enc.encode(path));
    return r.status;
  }
  async ksymlink(target, linkpath) {    const t = enc.encode(target), l = enc.encode(linkpath);
    const tx = new Uint8Array(t.length + 1 + l.length);
    tx.set(t, 0); tx[t.length] = 0; tx.set(l, t.length + 1);
    const r = await this.kfs(OP_SYMLINK, 0, 0, 0, tx);
    if (r.status !== 0 && r.status !== -17) throw new Error('symlink ' + linkpath + ' -> errno ' + r.status);
  }
  async kwriteFile(path, u8, mode = 0o644) {
    await this.mkdirP(this.parentOf(path));
    // create-mode: manifest mode | 0o022 pre-compensates the kernel's default
    // umask (0o022) so 644/755 land exactly; modes WITH group/other-write
    // bits get an explicit CHMOD after the write (rare in the npm set).
    const createMode = (mode | 0o022) & 0o7777;
    let r = await this.kfs(OP_OPEN, O_WRONLY | O_CREAT | O_TRUNC, createMode, 0, enc.encode(path));
    if (r.status !== 0) throw new Error('open ' + path + ' -> errno ' + r.status);
    const fd = r.inline;
    try {
      for (let off = 0; off < u8.length; off += TX_SYNC_PAYLOAD_MAX) {
        const end = Math.min(off + TX_SYNC_PAYLOAD_MAX, u8.length);
        r = await this.kfs(OP_WRITE, fd, -1, 0, u8.subarray(off, end)); // pos -1 = sequential
        if (r.status !== 0) throw new Error('write ' + path + ' @' + off + ' -> errno ' + r.status);
      }
    } finally {
      await this.kfs(OP_CLOSE, fd, 0, 0, null);
    }
    if ((mode & 0o022) !== 0) {
      r = await this.kfs(OP_CHMOD, mode & 0o7777, 0, 0, enc.encode(path));
      if (r.status !== 0) throw new Error('chmod ' + path + ' -> errno ' + r.status);
    }
  }
  async kreadFirst(path, max = 128) {
    let r = await this.kfs(OP_OPEN, O_RDONLY, 0, 0, enc.encode(path));
    if (r.status !== 0) return null;
    const fd = r.inline;
    try {
      r = await this.kfs(OP_READ, fd, max, -1, null);
      if (r.status !== 0 || !r.syncres) return null;
      return r.syncres.subarray(0, r.len);
    } finally {
      await this.kfs(OP_CLOSE, fd, 0, 0, null);
    }
  }
  // P2-008-PERF: whole-file read + readdir (npm timing.json harvest).
  async kreadWhole(path) {
    let r = await this.kfs(OP_OPEN, O_RDONLY, 0, 0, enc.encode(path));
    if (r.status !== 0) return null;
    const fd = r.inline;
    const parts = [];
    try {
      for (let off = 0; ; off += TX_SYNC_PAYLOAD_MAX) {
        r = await this.kfs(OP_READ, fd, TX_SYNC_PAYLOAD_MAX, off, null);
        if (r.status !== 0 || !r.syncres || r.len === 0) break;
        parts.push(r.syncres.subarray(0, r.len));
        if (r.len < TX_SYNC_PAYLOAD_MAX) break;
      }
    } finally {
      await this.kfs(OP_CLOSE, fd, 0, 0, null);
    }
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  async kreaddir(path) {
    // OP_READDIR batch loop — layout mirrors the runtime-worker's parser
    // exactly: u32 count, u64 nextCookie @8, then per entry: u8 kind, u32
    // nameLen @+4, name bytes @+8, cursor += 8 + align8(nameLen). count=0 = end.
    const names = [];
    let cookie = 0;
    for (;;) {
      const r = await this.kfs(OP_READDIR, cookie, 256, 16384, enc.encode(path));
      if (r.status !== 0) return null;
      if (!r.syncres || r.len === 0) return names;
      const dv = new DataView(r.syncres.buffer, r.syncres.byteOffset, r.syncres.byteLength);
      const count = dv.getUint32(0, true);
      if (count === 0) return names;
      cookie = Number(dv.getBigUint64(8, true));
      let cursor = 16;
      for (let i = 0; i < count; i++) {
        if (cursor + 8 > dv.byteLength) return names;
        const nameLen = dv.getUint32(cursor + 4, true);
        if (cursor + 8 + nameLen > dv.byteLength) return names;
        names.push(dec.decode(r.syncres.subarray(cursor + 8, cursor + 8 + nameLen)));
        cursor += 8 + ((nameLen + 7) & ~7);
      }
      if (cookie === 0) return names;
    }
  }
  async resolveSymlinks(path) {
    for (let hops = 0; hops < 8; hops++) {
      const st = await this.klstat(path);
      if (!st.ok || !st.isSymlink) return path;
      const r = await this.kfs(OP_READLINK, 64, 0, 0, enc.encode(path));
      if (r.status !== 0 || !r.syncres) return path;
      const target = dec.decode(r.syncres.subarray(0, r.len));
      path = target.startsWith('/')
        ? this.normalizePath(target)
        : this.abs(this.parentOf(path), target);
    }
    return path; // too many hops — the kernel's ELOOP surfaces at open
  }

  // -- boot --------------------------------------------------------------------
  async boot() {
    const t0 = performance.now();
    this.setKernel('booting', 'kernel booting…');
    this.kdrv = new Worker(new URL('kernel-driver.js', import.meta.url));
    this.kdrv.onmessage = (ev) => this.onDriverMsg(ev.data);
    this.kdrv.onerror = (e) => { this.setKernel('error', 'driver worker error'); this.term.meta('\n[driver error] ' + (e.message || 'unknown') + '\n'); };
    const wasm = await (await fetch(new URL('kernel_core.wasm', import.meta.url))).arrayBuffer();
    this.ksm = new WebAssembly.Memory({ initial: 1302, maximum: 32768, shared: true }); // 2 GiB max (was 1 GiB/16384): VFS residency ceiling raised to 1536 MiB for SDK-58 installs
    const res = await this.rpc({ type: 'boot', ksmMemory: this.ksm, wasm: wasm.slice(0), perf: !!this.perf }, [wasm], 60000);
    if (res.type !== 'boot-ok') throw new Error('boot failed: ' + JSON.stringify(res));
    this.kernel = res;
    this.stats.bootMs = Math.round(performance.now() - t0);
    this.setKernel('ready', 'kernel v' + (res.version >> 16) + '.' + (res.version & 0xffff) + ' ready');
    this.startPerfMonitor(); // P2-008-PERF Step-0: 5 s kernel diag + hang trail
    // B1 speed: fetch + parse libsources ONCE per page (6.1 MB). Every
    // spawned worker gets the parsed object with its init message — no
    // per-spawn 6 MB fetch + JSON.parse (structured clone of an already-
    // parsed object is several times cheaper; this also removes the
    // per-command transfer entirely on every spawn).
    this._libSourcesPromise = (async () => {
      const r = await fetch(new URL('libsources.json', new URL('supervisor.mjs', import.meta.url)));
      if (!r.ok) throw new Error('libsources.json HTTP ' + r.status);
      return r.json(); // cached promise: every spawn awaits the same object
    })();
    this._libSourcesPromise.catch(() => { this._libSourcesPromise = null; }); // fall back to per-worker fetch
    // B7: fill the warm pool once libsources is parsed — the first warm
    // worker's module top needs the handoff available at its init post.
    this._libSourcesPromise.then(() => this.warmRefillSoon()).catch(() => {});
  }

  onDriverMsg(m) {
    if (m.type === 'stdout' || m.type === 'stderr') {
      this.term.write(m.text); // driver posts streaming-decoded text
    } else if (m.type === 'driver-perf' && this.perf) {
      // E5: driver-thread accounting push (pump busy %, pump calls, wait time)
      this.perfData.driver.push({ t: +(performance.now() - this.perfData.t0).toFixed(0), ...m });
    } else if (m.type === 'kernel-stopped') {
      this.setKernel('stopped', 'kernel stopped');
    } else if (m.type === 'driver-loop-died' || m.type === 'driver-error') {
      this.setKernel('error', 'driver loop died');
      this.term.meta('\n[driver] ' + (m.error || '') + (m.during ? ' (during ' + m.during + ')' : '') + '\n');
      if (Array.isArray(m.pending) && m.pending.length) {
        this.term.meta('[driver] pending requests at death: ' + JSON.stringify(m.pending) + '\n');
      }
    }
    // tagged rpc replies are consumed by rpc()
  }

  // -- seeding -------------------------------------------------------------------
  // GET /npm-manifest.json → {files:[{path,size,mode,type,target?}],
  // entryStubs:[{path,…,content}]} → seed via kfs-sync: MKDIR (dir-cache),
  // SYMLINK ([target\0linkpath] — TARGET FIRST), OPEN(O_WRONLY|O_CREAT|
  // O_TRUNC) + chunked WRITE (≤ 8128 B — ABI §11.6 sync-payload cap) + CLOSE.
  // 8-wide HTTP prefetch pipeline; stub contents come inline from entryStubs.
  async seed() {
    const t0 = performance.now();
    this.setKernel('seeding', 'fetching manifest…');
    // P2-006-008: try the one-shot seed blob first — ONE request instead of
    // ~2245 (the preview gateway's per-request proxy overhead made per-file
    // seeding ≈ 48 s; the blob is network time only). Any miss falls back to
    // the original per-file pipeline, so direct serving keeps working.
    let mf = null, blobView = null;
    try {
      const r = await fetch(new URL('npm-seed-blob', import.meta.url).href);
      if (r.ok) {
        const u8 = new Uint8Array(await r.arrayBuffer());
        if (u8.length > 8 && u8[0] === 0x43 && u8[1] === 0x53 && u8[2] === 0x42 && u8[3] === 0x31) { // "CSB1"
          const jsonLen = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true);
          mf = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jsonLen)));
          blobView = u8.subarray(8 + jsonLen);
        }
      }
    } catch { /* per-file fallback below */ }
    if (!mf) mf = await (await fetch(new URL('npm-manifest.json', import.meta.url).href)).json();
    const entries = mf.files || [];
    const stubByPath = new Map(
      (mf.entryStubs || []).filter((e) => typeof e.content === 'string').map((e) => [e.path, e.content])
    );
    const files = entries.filter((e) => e.type === 'file' && !stubByPath.has(e.path));
    const PREFETCH = 8;
    const pool = new Map();
    const fetchAt = (i) => {
      if (blobView || pool.has(i) || i >= files.length) return;
      pool.set(i, (async () => {
        const tF = performance.now();
        const r = await fetch(new URL('npm-file?p=' + encodeURIComponent(files[i].path), import.meta.url).href);
        if (!r.ok) throw new Error('npm-file ' + files[i].path + ' -> HTTP ' + r.status);
        const ab = await r.arrayBuffer();
        this.stats.seedFetchMs += performance.now() - tF;
        return ab;
      })());
    };
    if (!blobView) for (let i = 0; i < Math.min(PREFETCH, files.length); i++) fetchAt(i);
    let done = 0, fileIdx = 0; // files[] preserves entries[] order for fetchable files
    for (const e of entries) {
      if (e.type === 'dir') { await this.mkdirP(e.path); continue; }
      if (e.type === 'symlink') { await this.mkdirP(this.parentOf(e.path)); await this.ksymlink(e.target, e.path); done++; continue; }
      let u8;
      const stub = stubByPath.get(e.path);
      if (stub !== undefined) {
        u8 = enc.encode(stub); // entryStubs carry stub contents inline
      } else {
        const i = fileIdx++;
        await this.mkdirP(this.parentOf(e.path));
        if (blobView && typeof e.off === 'number') {
          // .slice, NOT .subarray: postMessage structured-clones a TypedArray
          // VIEW by copying its ENTIRE underlying buffer (V8 behavior) —
          // 2238 views over one 15.6 MB blob ≈ 35 GB of memcpy (measured
          // 42 s seed). slice() copies just this file's bytes into a fresh
          // small buffer; total extra cost is one 15.6 MB pass.
          u8 = blobView.slice(e.off, e.off + e.len);
        } else {
          const ab = await pool.get(i);
          pool.delete(i);
          for (let k = 1; k <= PREFETCH; k++) fetchAt(i + k);
          u8 = new Uint8Array(ab);
        }
      }
      await this.kwriteFile(e.path, u8, e.mode);
      this.stats.files++; this.stats.bytes += u8.length;
      done++;
      if ((done & 63) === 0 || done === entries.length) {
        this.status.seed.textContent =
          `seed ${done}/${entries.length} files · ${(this.stats.bytes / 1048576).toFixed(1)} MB`;
      }
    }
    // demo workspace (also the npm golden-test cwd)
    await this.kwriteFile('/project/package.json',
      enc.encode(JSON.stringify({ name: 'nodine-demo', version: '1.0.0', private: true }, null, 2) + '\n'), 0o644);
    await this.kwriteFile('/project/main.js', enc.encode(
      '// try: node /project/main.js   (after: cd /project && npm install left-pad)\n' +
      'const name = process.argv[2] || "nodine";\n' +
      'console.log("hello from Node " + process.version + " on the nodine kernel, " + name + "!");\n' +
      'try { console.log("left-pad says:", require("left-pad")("ab", 8, "-")); }\n' +
      'catch { console.log("left-pad not installed yet — run: npm install left-pad"); }\n'), 0o644);
    // B1-PREVIEW smoke-test server (see poc/p2-007/preview-demo.js — keep in
    // sync): listen(3999) → the preview panel picks it up via the SW bridge.
    await this.kwriteFile('/project/preview-demo.js', enc.encode(
      'const http = require("http");\n' +
      'const server = http.createServer((req, res) => {\n' +
      '  const url = req.url.split("?")[0];\n' +
      '  if (url === "/" || url === "/index.html") {\n' +
      '    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });\n' +
      '    res.end("<!doctype html><meta charset=\\"utf-8\\"><title>nodine preview</title>" +\n' +
      '      "<body style=\\"font:16px system-ui;background:#101418;color:#7ee787;display:grid;place-items:center;height:100vh;margin:0\\">" +\n' +
      '      "<div><h1>B1 preview OK</h1><p>served from inside the runtime on port <b style=\\"color:#79b8ff\\">3999</b></p>" +\n' +
      '      "<img src=\\"/pixel.gif\\" width=\\"1\\" height=\\"1\\"></div>");\n' +
      '    return;\n' +
      '  }\n' +
      '  if (url === "/pixel.gif") {\n' +
      '    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");\n' +
      '    res.writeHead(200, { "content-type": "image/gif", "content-length": String(gif.length) });\n' +
      '    res.end(gif); return;\n' +
      '  }\n' +
      '  if (url === "/api/time") {\n' +
      '    res.writeHead(200, { "content-type": "application/json" });\n' +
      '    res.end(JSON.stringify({ now: Date.now(), pid: process.pid, node: process.version })); return;\n' +
      '  }\n' +
      '  if (url === "/api/echo" && req.method === "POST") {\n' +
      '    const chunks = [];\n' +
      '    req.on("data", (c) => chunks.push(c));\n' +
      '    req.on("end", () => {\n' +
      '      res.writeHead(200, { "content-type": "application/json" });\n' +
      '      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString("utf8") }));\n' +
      '    }); return;\n' +
      '  }\n' +
      '  res.writeHead(404, { "content-type": "text/plain" }); res.end("not found: " + url);\n' +
      '});\n' +
      'server.listen(3999, () => console.log("preview-demo listening on :" + server.address().port));\n'), 0o644);
    this.stats.seedMs = Math.round(performance.now() - t0);
    this.status.seed.textContent = `seeded ${this.stats.files} files (${(this.stats.bytes / 1048576).toFixed(1)} MB) in ${this.stats.seedMs} ms`;
  }

  // -- E3/E4 project seeding (Step-0.5) ---------------------------------------
  // Fetch /project-seed-blob (a HOST directory as CSB1 — see server.cjs) and
  // apply it under /project/<app>/ with the same kfs-sync machinery as seed().
  // Used by install-only runs (the pre-extracted template, so the measured
  // window is npm install alone) and the E4 extraction microbench (recorded
  // tarballs as plain files). Returns {files, bytes, ms}.
  async seedProject(app) {
    const t0 = performance.now();
    const r = await fetch(new URL('project-seed-blob', import.meta.url).href);
    if (!r.ok) throw new Error('project-seed-blob -> HTTP ' + r.status);
    const u8 = new Uint8Array(await r.arrayBuffer());
    if (u8.length < 8 || u8[0] !== 0x43 || u8[1] !== 0x53 || u8[2] !== 0x42 || u8[3] !== 0x31) {
      throw new Error('project-seed-blob: not CSB1');
    }
    const jsonLen = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true);
    const mf = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jsonLen)));
    const blobView = u8.subarray(8 + jsonLen);
    const root = '/project/' + app;
    await this.mkdirP(root);
    let files = 0, bytes = 0;
    for (const e of mf.files || []) {
      const dest = root + '/' + e.path;
      if (e.type === 'dir') { await this.mkdirP(dest); continue; }
      await this.mkdirP(this.parentOf(dest));
      if (e.type === 'symlink') { await this.ksymlink(e.target, dest); files++; continue; }
      if (e.type !== 'file') continue;
      const body = blobView.slice(e.off, e.off + e.len); // slice, not subarray (view-clone trap)
      await this.kwriteFile(dest, body, e.mode || 0o644);
      files++; bytes += body.length;
    }
    const ms = Math.round(performance.now() - t0);
    return { files, bytes, ms };
  }

  // -- exec resolution -------------------------------------------------------------
  // FROZEN contract (README §2):
  // 1) argv[0] with '/' → path (resolved against cwd); else PATH search
  //    ('/usr/bin:/bin') via kfs STAT (follows symlinks). No hit → 127.
  // 2) Symlink chain resolved (LSTAT + READLINK, ≤8 hops).
  // 3) Node self-stub (/usr/bin/node etc.): entry = abs(argv[1]) or null
  //    (bare `node`), argv0='node', argv = rest AFTER entry.
  // 4) Read the first 128 B. '#!' node-family interpreter → node worker
  //    (entry = script, argv0='node', argv = rest AFTER the script).
  //    Other interpreter → 'exec format not supported: <line>' → 126.
  // 5) No shebang: .js/.mjs/.cjs → node worker; else exec format error → 126.
  // The worker builds process.argv = [argv0, ...(entry ? [entry] : []), ...argv].
  async resolveExec(argv, cwd, env) {
    const argv0 = argv[0];
    let path;
    if (argv0.includes('/')) {
      path = this.abs(cwd, argv0);
    } else {
      const dirs = (env.PATH || '/usr/bin:/bin').split(':');
      path = null;
      for (const d of dirs) {
        if (!d) continue;
        const cand = this.normalizePath(d + '/' + argv0);
        const st = await this.kstat(cand);
        if (st.ok) { path = cand; break; }
      }
      if (!path) return { ok: false, code: 127, message: argv0 + ': command not found' };
    }
    path = await this.resolveSymlinks(path);
    // node self-stub: 'node script.js' — the interpreter IS the command.
    if (path === '/usr/bin/node' || path === '/bin/node' || path === '/usr/local/bin/node') {
      // P2-006-008: `node -v` / `node --version` — real Node prints the
      // version and exits 0. The runtime's process.version IS the genuine
      // v26.13.0 core version (libsources), so print it through the real
      // eval path instead of failing on '-v' as a script path.
      if (argv[1] === '-v' || argv[1] === '--version') {
        return { ok: true, kind: 'node-self', entry: null, argv0: 'node', argv: [],
                 code: 'process.stdout.write(process.version + "\\n")' };
      }
      // P2-006-008: `node -e <code>` / `--eval <code>` / `--eval=<code>`
      // (and -p/--print: eval + inspect the completion value). Falling
      // through to script resolution treated '-e' as a PATH ("Cannot find
      // module /home/user/-e" — observed live; npm internals shell out with
      // -e). argv semantics match real Node: process.argv = [node, ...rest].
      {
        let evalCode = null, print = false, rest = null;
        const a1 = argv[1];
        if (a1 === '-e' || a1 === '--eval' || a1 === '-p' || a1 === '--print') {
          print = a1 === '-p' || a1 === '--print';
          if (argv.length < 3) return { ok: false, code: 9, message: 'node: ' + a1 + ' requires an argument' };
          evalCode = String(argv[2]);
          rest = argv.slice(3);
        } else if (typeof a1 === 'string' && (a1.startsWith('--eval=') || a1.startsWith('--print='))) {
          print = a1.startsWith('--print=');
          evalCode = a1.slice(a1.indexOf('=') + 1);
          rest = argv.slice(2);
        }
        if (evalCode !== null) {
          const code = print
            ? '(function (v) { process.stdout.write(require("util").inspect(v) + "\\n"); })((0, eval)(' + JSON.stringify(evalCode) + '))'
            : evalCode;
          return { ok: true, kind: 'node-self', entry: null, argv0: 'node', argv: rest, code };
        }
      }
      const entry = argv[1] ? this.abs(cwd, argv[1]) : null;
      // entry null (bare `node`) → argv [] (no script; the worker's
      // entry:null handling owns REPL/eval semantics)
      return { ok: true, kind: 'node-self', entry, argv0: 'node', argv: entry ? argv.slice(2) : [] };
    }
    const head = await this.kreadFirst(path, 128);
    const nl = head ? head.indexOf(10) : -1;
    const firstLine = head ? dec.decode(head.subarray(0, nl === -1 ? head.length : nl)) : '';
    if (firstLine.startsWith('#!')) {
      const interp = firstLine.slice(2).trim();
      if (this.isNodeInterpreter(interp)) {
        return { ok: true, kind: 'node-script', entry: path, argv0: 'node', argv: argv.slice(1) };
      }
      return { ok: false, code: 126, message: 'exec format not supported: ' + firstLine.trim() };
    }
    if (/\.(js|mjs|cjs)$/.test(path)) {
      return { ok: true, kind: 'node-script', entry: path, argv0: 'node', argv: argv.slice(1) };
    }
    // B24: fb-dotslash ships a per-platform RUNNER ELF
    // (bin/linux-musl.x86_64/dotslash etc., resolved by the package's
    // index.js — platforms map keyed by os.platform()/os.arch(), both
    // emulated 'linux'/'x64' since B16/B20). React Native DevTools installs
    // by spawning that ELF; on ENOEXEC the caller prints the scary
    // 'An unknown error occurred while installing React Native DevTools'
    // even though the flow is otherwise fine (Metro continues). We can
    // never run the native FB binary — but we can make the exec an honest,
    // successful no-op with a clear one-line notice, which removes the
    // misleading error while documenting exactly what was skipped.
    // Scope: ONLY ELF files whose path matches the fb-dotslash runner
    // layout (…/fb-dotslash/bin/<slug>/dotslash). Any other ELF keeps the
    // faithful 126 ENOEXEC below.
    {
      const isElf = head && head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 /* E */ && head[2] === 0x4c /* L */ && head[3] === 0x46 /* F */;
      if (isElf && /\/node_modules\/fb-dotslash\/bin\/[^/]+\/dotslash$/.test(path)) {
        return {
          ok: true, kind: 'node-self', entry: null, argv0: 'dotslash', argv: [],
          code: 'process.stderr.write("fb-dotslash: native dotslash runner is unavailable in this runtime (React Native DevTools skipped)\\n"); process.exit(0);',
        };
      }
    }
    return { ok: false, code: 126, message: argv0 + ': exec format error' };
  }
  isNodeInterpreter(interp) {
    let t = interp.trim().split(/\s+/);
    if (t[0] === '/usr/bin/env' || t[0] === 'env') {
      if (t[1] === '-S') t = t.slice(2); else t = t.slice(1);
    }
    const exe = t[0] || '';
    return exe === 'node' || exe === 'nodine-node' ||
      exe === '/usr/bin/node' || exe === '/usr/local/bin/node' || exe === '/bin/node' ||
      exe.endsWith('/node');
  }

  // -- process spawn ------------------------------------------------------------------
  async spawnProcess({ argv, env, cwd, stdioMode = 'inherit', parent = null, viaPort = null, reqId = undefined }) {
    // P2-006-008: stdioMode may be a per-fd ARRAY ['inherit'|'pipe'|'ignore' ×3]
    // (spawn requests with array stdio) or the classic single string.
    const stdioArr = Array.isArray(stdioMode) ? stdioMode : null;
    const singleMode = Array.isArray(stdioMode) ? (stdioMode[1] === 'pipe' || stdioMode[2] === 'pipe' ? 'pipe' : stdioMode.every((v) => v === 'ignore') ? 'ignore' : 'inherit') : stdioMode;
    if (this.stopped) return null;
    // B1 speed: settle the page-wide libsources fetch once; later spawns
    // reuse the object (structured clone from the SAME parsed object each
    // time). A failed/absent fetch leaves null → workers self-fetch (old path).
    if (this._libSourcesPromise && !this._libSourcesResolved) {
      try { this._libSourcesResolved = await this._libSourcesPromise; } catch { this._libSourcesResolved = null; }
    }
    const res = await this.resolveExec(argv, cwd, env);
    if (!res.ok) {
      if (viaPort) {
        const pid = this.nextPid++;
        viaPort.postMessage({ type: 'spawn-result', pid, error: res.message, reqId }); // M1.6: echo per-request key
        viaPort.postMessage({ type: 'child-exit', pid, code: res.code });
      } else {
        this.term.meta(res.message + '\n');
        this.showExit(res.code);
      }
      return null;
    }
    let pid = this.nextPid++;
    let ep = null;
    for (let tries = 0; tries < 64; tries++) {
      const r = await this.rpc({ type: 'alloc-endpoint', pid, caps: 3 });
      if (r.type === 'endpoint-allocated' && r.index >= 0) { ep = r; break; }
      pid = this.nextPid++; // live pid / no free endpoint — retry with the next
    }
    if (!ep) {
      if (viaPort) {
        viaPort.postMessage({ type: 'spawn-result', pid, error: 'no free kernel endpoint', reqId });
        viaPort.postMessage({ type: 'child-exit', pid, code: 71 }); // EAGAIN-ish
      } else {
        this.term.meta('spawn failed: no free kernel endpoint\n');
        this.showExit(71);
      }
      return null;
    }
    // B7 WARM POOL: pop a pre-booted idle worker if one is warm — the
    // fresh-Worker path below stays as the fallback (pool empty / drained).
    const pooled = this.warmWorkers.pop() || null;
    const worker = pooled ? pooled.worker : new Worker(WORKER_URL, { type: 'module' });
    const { port1, port2 } = new MessageChannel();
    const proc = {
      pid, worker, port: port1, ep: { index: ep.index, generation: ep.generation },
      parent, children: new Set(), stdioMode: singleMode, stdioArr, argv, entry: res.entry, env, cwd,
      ready: false, exited: false,
      spawnAt: this.perf ? +(performance.now() - this.perfData.t0).toFixed(0) : null,
      readyAt: null, exitAt: null, parentPid: parent ? parent.pid : null,
      lastPerfState: null, lastPerfStateAt: 0,
    };
    this.procs.set(pid, proc);
    if (parent) parent.children.add(pid);
    worker.onmessage = (ev) => this.onWorkerMsg(proc, ev.data);
    worker.onerror = (ev) => this.onWorkerError(proc, ev);
    port1.onmessage = (ev) => this.onChannelMsg(proc, ev.data, ev);
    // FROZEN nodine-init (README §1.2): argv = REST ARGS AFTER entry;
    // the worker builds process.argv = [argv0, ...(entry?[entry]:[]), ...argv].
    // B1-PREVIEW: when the page set up the preview bridge, every spawned
    // worker gets its own channel to the preview SW (a fresh MessagePort
    // pair per worker; the SW end is transferred with the init message).
      let previewSWPort = null;
      const initTransfer = [port2];
      if (this.previewSW) {
        const swc = new MessageChannel();
        previewSWPort = swc.port1;
        // Tell the SW this worker's channel exists (forwarded by the page's
        // port) — the SW stores it for preview-port-open forwarding... no:
        // per-port channels are forwarded LATER on demand. The supervisor's
        // own swc.port2 partner goes to the SW right now so the SW knows the
        // session's channel topology.
        this.previewSW.postMessage(
          { type: 'preview-worker-chan', sid: this.previewSid },
          [swc.port2],
        );
        initTransfer.push(swc.port1);
      }
    worker.postMessage({
      type: 'nodine-init',
      ksmMemory: this.ksm,
      epIndex: ep.index,
      generation: ep.generation,
      pid, // extra vs the minimal contract (diagnostics; harmless additive)
      entry: res.entry,
      argv: res.argv,
      argv0: res.argv0,
      code: res.code || null, // node -v/--version eval (P2-006-008)
      env, cwd,
      // P2-006-008: per-fd array when the caller asked for it (the worker's
      // STDIO_MODE stays the fd-1/2 owner for writes; fd 0 reads honor their
      // own entry) — a string stays whole-spawn.
      stdioMode: Array.isArray(stdioMode) ? stdioMode.join(',') : stdioMode,
      stdioArr: Array.isArray(stdioMode) ? stdioMode : undefined,
      channelPort: port2,
      previewSWPort, // B1-PREVIEW: this worker's channel to the preview SW
      files: null, // the supervisor pre-seeds the VFS through endpoint 0
      perf: this.perf, // P2-008-PERF Step-0: activate worker instrumentation
      libSources: this._libSourcesResolved || undefined, // B1 speed: skip the worker's 6 MB fetch
    }, initTransfer);
    // B5 stdin fix: SDK spawns pass a SYNTHETIC parent (pid -1) so the page
    // can capture stdout/exit on a MessageChannel — the old `!parent` test
    // never foregrounded them, so sendStdin() (the terminal's interactive-
    // stdin route) dropped every keystroke with foreground=null (observed
    // live: npx "Ok to proceed? (y)" unanswerable; trace showed sendStdin
    // called, bytes dropped at `if (!p) return`). A pid -1 parent IS a
    // page-root spawn: foreground it exactly like a parentless POC root.
    if (!parent || parent.pid === -1) this.setForeground(proc);
    // B9 TERMINAL-OWNER FIX: while the foreground root waits on children it
    // never reads fd0 itself — the DEEPEST live descendant with an inherit
    // fd0 owns the terminal (the interactive prompt: npx's "(y)",
    // create-expo's name prompt). sendStdin used to route to the fg ROOT,
    // and the kernel's stdin_feed broadcasts to EVERY live endpoint's fd0
    // FIFO (verified in isolation: one feed → both the sh endpoint and the
    // grandchild endpoint drained the same bytes) — so keystrokes reached
    // the prompt only via that broadcast while the fg root's copy REPLAYED
    // as ghost input the moment the root resumed its line reader
    // (observed live: prompt answered with the buffered command text
    // 'node … index.js testapp' → 'Invalid project name'; stale 'y' answers
    // executing as commands). Track the actual reader and route to IT.
    this.updateTerminalOwner(proc);
    if (viaPort) viaPort.postMessage({ type: 'spawn-result', pid, reqId });
    this.updateProcs();
    this.warmRefillSoon(); // B7: replenish the pool AFTER the interactive path is done
    return proc;
  }

  // -- B7 warm pool -----------------------------------------------------------------
  // Warm workers sit at `await initPromise` with their module top evaluated
  // (libsources parsed from the supervisor handoff, uvmap fetched, platform
  // captures taken). Adopting one costs ONLY the nodine-init post; the
  // worker then resumes at main() → transportAttach → PROC_READY → entry.
  warmCreate() {
    const w = new Worker(WORKER_URL, { type: 'module' });
    // B7: hand the parked worker the parsed libsources NOW — its module top
    // (which may already be past the first await) then skips its own 6 MB
    // fetch. The message queues until the worker's onmessage installs.
    if (this._libSourcesPromise) {
      this._libSourcesPromise.then((ls) => { try { w.postMessage({ type: 'warm-preinit', libSources: ls }); } catch {} })
        .catch(() => {});
    }
    // onmessage stays unset until adoption: the parked worker's queued
    // reports (boot/libsources) flow to the adopting proc's onWorkerMsg.
    return { worker: w, bornAt: performance.now() };
  }
  warmRefillSoon() {
    if (this.stopped || this._warmRefillScheduled) return;
    if (this.warmWorkers.length >= this.warmTarget) return;
    this._warmRefillScheduled = true;
    setTimeout(() => {
      this._warmRefillScheduled = false;
      if (this.stopped) return;
      while (!this.stopped && this.warmWorkers.length < this.warmTarget) {
        try { this.warmWorkers.push(this.warmCreate()); } catch { break; }
      }
    }, 2000); // deferred: never contend with the interactive spawn path
  }
  warmDrain() {
    for (const w of this.warmWorkers) { try { w.worker.terminate(); } catch {} }
    this.warmWorkers.length = 0;
  }

  onWorkerMsg(proc, m) {
    if (!m || proc.exited) return;
    if (m.type === 'proc-ready') { proc.ready = true; if (this.perf) proc.readyAt = +(performance.now() - this.perfData.t0).toFixed(0); return; }
    if (m.type === 'proc-exit') { this.handleExit(proc, m.code ?? 0); return; }
    if (m.type === 'done' && m.exitCode !== undefined) { this.handleExit(proc, m.exitCode); return; } // p2-006 compat
    // B1-PREVIEW: worker http servers announce listen()/close() (the
    // 'server-ready'/'port' event pair of the package API).
    if (m.type === 'port-open') { this.previewPortOpen(m.port, proc); return; }
    if (m.type === 'port-close') { this.previewPortClose(m.port, proc); return; }
    // ---- P2-008-PERF Step-0 record collection (page ?perf=1) --------------
    if (this.perf && typeof m.type === 'string' && m.type.startsWith('perf-')) {
      if (m.type === 'perf-state') {
        proc.lastPerfState = m; proc.lastPerfStateAt = performance.now();
        this.perfData.states.push({ t: +(performance.now() - this.perfData.t0).toFixed(0), pid: proc.pid,
          outstanding: m.outstanding, bridgeQueue: m.bridgeQueue, pendingHttp: m.pendingHttp,
          liveChildren: m.liveChildren, pendingSpawnReplies: m.pendingSpawnReplies,
          stdinWaiters: m.stdinWaiters, stdinRetryCount: m.stdinRetryCount, dynImport: m.dynImport,
          lastSyncRung: m.lastSyncRung,
          corgi: m.corgi || null, // Phase-4: per-process direct-corgi substitution counters
          eagain: m.eagain || null, // Phase-5: per-process EAGAIN-retry health (sync/async)
          winRpc: m.winRpc || null }); // E5: 5 s per-op window {n,sumMs,maxMs,waitMs}
      } else if (m.type === 'perf-exit') {
        this.perfData.exits.push(m);
      } else if (m.type === 'perf-boot' || m.type === 'perf-entry') {
        this.perfData.boots.push(m);
      }
      return;
    }
    if (m.type === 'stdio-bytes' && this.stdioIsPiped(proc, m.stream)) {
      if (proc.parent && !proc.parent.exited) {
        proc.parent.port.postMessage({
          type: m.stream === 2 ? 'child-stderr' : 'child-stdout',
          pid: proc.pid, bytes: m.bytes,
        }, [m.bytes]);
      } else {
        this.term.write(dec.decode(new Uint8Array(m.bytes))); // defensive: fg root in pipe mode
      }
      return;
    }
    // unknown/legacy evidence messages are logged, never fatal
    if (m.type && m.type !== 'boot' && m.type !== 'libsources' && m.type !== 'chain-complete') {
      // P2-006-008: quit-quiet carries the liveness ring — surface it (the
      // report FETCH can be aborted by terminate(); the message cannot).
      if (m.type === 'quit-quiet' && Array.isArray(m.life)) {
        DIAG && DIAG.logs.push('worker ' + proc.pid + ': quit-quiet LIFE ' + m.life.slice(-14).join(' / '));
      } else if (m.type === 'life-snap' && m.snap != null) {
        // B21-DIAG: life-snap carried the snapshot but the formatter dropped
        // it — wedge diagnosis needs the counter state while looping.
        DIAG && DIAG.logs.push('worker ' + proc.pid + ': life-snap ' + String(m.snap).slice(0, 400));
      } else if (m.type === 'unhandled-rejection') {
        DIAG && DIAG.logs.push('worker ' + proc.pid + ': UNHANDLED-REJECTION ' + String(m.reason).slice(0, 800));
      } else {
        // M1.7A diagnostics: carry the message where present (uncaught/
        // entry-error are useless without their text — pnpm-wasm debugging).
        // M1.7A-b4: worker-bundle/-created carry entry/modules (not message)
        // — include them so install-loop diagnosis can see WHICH entry
        // re-bundles (the fields exist on the report; the old line dropped
        // them).
        DIAG && DIAG.logs.push('worker ' + proc.pid + ': ' + m.type +
          (m.message ? ' :: ' + String(m.message).slice(0, 600) : '') +
          (m.error ? ' :: ' + String(m.error).slice(0, 600) : '') +
          (m.entry ? ' :: entry=' + String(m.entry).slice(0, 300) : '') +
          (m.modules != null ? ' :: modules=' + m.modules : '') +
          (m.msg ? ' :: msg=' + String(m.msg).slice(0, 400) : '') +
          (m.stack ? ' :: stack=' + String(m.stack).slice(0, 3500) : ''));
      }
    }
  }
  onWorkerError(proc, ev) {
    if (proc.exited) return;
    this.term.meta('\n[worker ' + proc.pid + ' error] ' + (ev.message || 'load failed') + '\n');
    // module-load failure (the common case until the main agent lands
    // public/runtime-worker.mjs) gets an actionable hint.
    if (!ev.message || /load|module|import/i.test(ev.message) || String(ev.filename || '').includes('runtime-worker')) {
      this.term.meta("runtime-worker.mjs failed to load — the frozen contract it must implement is docs/runtime-worker-contract.md §1.2–1.4.\n");
    }
    this.handleExit(proc, 1);
  }

  // messages arriving on the supervisor end of the process's channel port
  onChannelMsg(proc, m, ev) {
    if (!m || proc.exited) return;
    if (m.type === 'spawn') {
      this.handleSpawnRequest(proc, m).catch((e) => {
        proc.port.postMessage({ type: 'spawn-result', pid: 0, error: String(e.message || e), reqId: m.reqId }); // m is handleSpawnRequest's scope — correct here
      });
      return;
    }
    // M1.6 fix: stdin-bytes from the page SDK (ContainerProcess.input)
    // had NO branch here — delayed writes to a piped root process were
    // silently dropped (immediate writes only worked because they raced
    // the spawn handshake's port wiring). Forward them to the owning
    // worker's channel like sendStdin does for the legacy terminal path.
    if (m.type === 'stdin-bytes' && m.bytes) {
      try { proc.port.postMessage({ type: 'stdin-bytes', bytes: m.bytes }, [m.bytes]); } catch {}
      return;
    }
    if (m.type === 'stdin-eof') {
      try { proc.port.postMessage({ type: 'stdin-eof' }); } catch {}
      return;
    }
    if (m.type === 'child-stdin') {
      const child = this.procs.get(m.pid);
      if (!child) return;
      if (m.eof) { child.port.postMessage({ type: 'stdin-eof' }); return; }
      if (m.bytes) child.port.postMessage({ type: 'stdin-bytes', bytes: m.bytes }, [m.bytes]);
      return;
    }
    if (m.type === 'kill') { // optional extension: a parent killing its child
      const child = this.procs.get(m.pid);
      if (child) child.port.postMessage({ type: 'signal', sig: m.sig || 'SIGTERM' });
      return;
    }
    // B1-PREVIEW: the worker asks to bridge a port to the preview SW. It
    // transfers the SW-side end of a dedicated channel; we forward it to the
    // SW (with our session id) through this supervisor's own SW port. No SW
    // → drop it (the worker's 10 s ack-timeout becomes a listen error).
    if (m.type === 'preview-port-open') {
      const transferred = ev && ev.ports && ev.ports[0];
      // B1-PREVIEW original path (SW bridge)…
      if (this.previewSW && this.previewSid && transferred) {
        this.previewSW.postMessage(
          { type: 'preview-port-open', sid: this.previewSid, port: m.port },
          [transferred],
        );
      } else if (transferred) {
        try { transferred.close(); } catch {}
      }
      return;
    }
    // Exit handshake: the worker is about to run OP_PROC_EXIT (endpoint
    // reclaim frees the stdio OFDs). Flush the kernel FIFOs NOW and ack —
    // the worker's final writes land in the terminal synchronously, no
    // fixed sleep anywhere on the path.
    if (m.type === 'pre-exit') {
      this.rpc({ type: 'flush-stdio' })
        .catch(() => {})
        .finally(() => { try { proc.port.postMessage({ type: 'stdio-flushed-ack' }); } catch {} });
      return;
    }
    if (m.type === 'preview-port-close') {
      if (this.previewSW && this.previewSid) {
        this.previewSW.postMessage({ type: 'preview-port-close', sid: this.previewSid, port: m.port });
      }
      return;
    }
    DIAG && DIAG.logs.push('channel ' + proc.pid + ': ' + (m.type || 'unknown'));
  }

  async handleSpawnRequest(proc, m) {
    let argv = Array.isArray(m.argv) ? m.argv.slice() : [];
    if (!argv.length) {
      proc.port.postMessage({ type: 'spawn-result', pid: 0, error: 'spawn: empty argv' });
      return;
    }
    if (m.shell) argv = ['/bin/sh', '-c', typeof m.shell === 'string' ? m.shell : argv.join(' ')];
    // P2-006-008: per-fd stdio — the worker posts a 3-array of
    // 'inherit'/'pipe'/'ignore'; a single string stays whole-spawn.
    const stdioMode = Array.isArray(m.stdio) ? this.mapStdioPerFd(m.stdio) : this.mapStdio(m.stdio);
    const env = (m.env && typeof m.env === 'object') ? m.env : proc.env;
    const cwd = m.cwd || proc.cwd;
    await this.spawnProcess({ argv, env, cwd, stdioMode, parent: proc, viaPort: proc.port, reqId: m.reqId });
  }
  mapStdio(stdio) {
    if (stdio === 'pipe' || stdio === 'ignore' || stdio === 'inherit') return stdio;
    if (Array.isArray(stdio)) {
      // coarse single-mode mapping (per-fd granularity is the worker bridge's
      // concern) — stdout/stderr drive 'pipe'; all-ignore means ignore.
      const s = (i, dflt) => (stdio[i] === 'pipe' || stdio[i] === 'ignore' || stdio[i] === 'inherit' ? stdio[i] : dflt);
      if (s(1, 'inherit') === 'pipe' || s(2, 'inherit') === 'pipe') return 'pipe';
      if (s(0, 'inherit') === 'ignore' && s(1, 'inherit') === 'ignore' && s(2, 'inherit') === 'ignore') return 'ignore';
    }
    return 'inherit';
  }
  // P2-006-008: PER-FD stdio for spawn requests. The worker's spawn bridge
  // already maps every stdio entry to 'inherit' | 'pipe' | 'ignore' — the
  // supervisor just needs to honor the ARRAY instead of collapsing it.
  // The old coarse mapStdio turned ['inherit','pipe','pipe'] into 'pipe'
  // WHOLE-SPAWN, so a grandchild handed its parent's REAL stdin (fd 0
  // inherit) had its fd 0 piped instead — create-expo's prompt read an
  // empty pipe while terminal keystrokes sat in the kernel FIFO
  // (observed live: 'NodineExpoGolden' → 'apden' → dead prompt).
  mapStdioPerFd(stdio) {
    if (typeof stdio === 'string') return [stdio, stdio, stdio];
    if (Array.isArray(stdio)) {
      const m = (v, dflt) => (v === 'pipe' || v === 'ignore' || v === 'inherit' ? v : dflt);
      return [m(stdio[0], 'inherit'), m(stdio[1], 'pipe'), m(stdio[2], 'pipe')];
    }
    return ['inherit', 'inherit', 'inherit'];
  }

  async handleExit(proc, code) {
    if (proc.exited) return;
    proc.exited = true;
    // Flush the kernel stdio FIFOs NOW (the worker's final writes must land
    // in the terminal BEFORE the endpoint reclaim frees the OFDs — this
    // replaces the worker's old fixed ~70 ms pre-exit sleep; drainStdio is
    // synchronous inside the driver).
    try { await this.rpc({ type: 'flush-stdio' }); } catch {}
    // B1-PREVIEW: close any preview ports this process owned (SW + registry)
    // BEFORE the tree bookkeeping — a killed dev server must stop being
    // reachable from the preview panel immediately.
    this.previewCloseAllForProc(proc);
    if (this.perf) {
      proc.exitAt = +(performance.now() - this.perfData.t0).toFixed(0);
      this.perfData.procs.push({
        pid: proc.pid, parentPid: proc.parentPid, argv: proc.argv, entry: proc.entry,
        spawnAt: proc.spawnAt, readyAt: proc.readyAt, exitAt: proc.exitAt,
        bootMs: proc.readyAt != null && proc.spawnAt != null ? +(proc.readyAt - proc.spawnAt).toFixed(0) : null,
        lifeMs: +(proc.exitAt - (proc.spawnAt ?? proc.exitAt)).toFixed(0), code: code ?? 0,
        stdioMode: proc.stdioMode,
      });
    }
    this.procs.delete(proc.pid);
    if (proc.parent) proc.parent.children.delete(proc.pid);
    try { await this.rpc({ type: 'endpoint-died', index: proc.ep.index, generation: proc.ep.generation }); } catch {}
    try { proc.worker.terminate(); } catch {}
    if (proc.parent && !proc.parent.exited) {
      proc.parent.port.postMessage({ type: 'child-stdout', pid: proc.pid, eof: true });
      proc.parent.port.postMessage({ type: 'child-stderr', pid: proc.pid, eof: true });
      proc.parent.port.postMessage({ type: 'child-exit', pid: proc.pid, code: code ?? 0 });
    }
    if (this.foreground === proc) {
      this.foreground = null;
      this.showExit(code ?? 0);
      this.onForegroundDone?.(code ?? 0);
    }
    // B9 TERMINAL-OWNER FIX: the reader died — the terminal returns to the
    // nearest LIVING ancestor in the foreground tree (the parent that was
    // blocked awaiting this child resumes its own fd0 reads). Re-derive
    // from the fg root down so a deep grandchild exit lands ownership on
    // the correct intermediate, and a fg-root exit clears it entirely.
    // The re-derivation also REVOKES the dead owner's channel grant; the
    // new owner (typically the fg root itself once all children are gone)
    // keeps reading the kernel FIFO — the pre-B9 behavior for plain
    // commands, now free of ghost bytes because the broadcast feed never
    // ran while the tree owned the channel route.
    // Re-derive whenever the exiting proc is the owner or sits ABOVE it in
    // its chain (an ancestor death invalidates the derived path).
    if (this.terminalOwner && (this.terminalOwner === proc || this.isDescendant(this.terminalOwner, proc))) this.syncStdinOwnership();
    this.updateProcs();
  }

  // -- foreground / stdin / signals -----------------------------------------------------
  setForeground(proc) { this.foreground = proc; this.syncStdinOwnership(); this.updateProcs(); }
  // B25 (ISIG): SIGINT to the foreground process group — the fg root and
  // every live descendant. The interactive SHELL root is skipped (a real
  // shell is in the group but shields itself while waiting on the job; it
  // must survive Ctrl+C and print the next prompt). Identified by its entry
  // resolving to /bin/sh (the SH_STUB node script the demo/host boots).
  deliverSignalTree(sig) {
    const fg = this.foreground;
    if (!fg || fg.exited) return;
    const targets = [];
    const isShellRoot = (fg.entry === '/bin/sh' || (fg.argv && fg.argv[0] === '/bin/sh') || (fg.argv0 === 'sh'));
    if (!isShellRoot) targets.push(fg);
    const walk = (p) => {
      for (const cpid of p.children) {
        const c = this.procs.get(cpid);
        if (c && !c.exited) { targets.push(c); walk(c); }
      }
    };
    walk(fg);
    for (const t of targets) {
      try { t.port.postMessage({ type: 'signal', sig }); } catch {}
    }
    return targets.length;
  }
  isDescendant(proc, root) {
    let p = proc;
    while (p) { if (p === root) return true; p = p.parent; }
    return false;
  }
  // B9 TERMINAL-OWNER FIX: the deepest LIVE descendant of the foreground
  // root whose fd 0 is 'inherit' — the process actually reading the
  // terminal. Processes with piped/ignored fd0 never see keystrokes, so
  // they are skipped; a chain of inherit-fd0 waits resolves to the leaf
  // (the prompt owner). Null when the fg root is gone or nothing in its
  // tree inherits the terminal.
  deriveTerminalOwner() {
    const root = this.foreground;
    if (!root || root.exited) return null;
    let owner = root;
    for (;;) {
      let next = null;
      for (const pid of owner.children) {
        const c = this.procs.get(pid);
        if (!c || c.exited) continue;
        const fd0 = c.stdioArr ? c.stdioArr[0] : (c.stdioMode === 'pipe' ? 'pipe' : 'inherit');
        if (fd0 === 'inherit') { next = c; break; } // one live inherit child owns it
      }
      if (!next) return owner;
      owner = next;
    }
  }
  // B9: notify ownership changes over each worker's channel. The previous
  // owner stops reading the channel queue (its fd 0 returns to the kernel
  // FIFO), the new owner starts. Idempotent per worker — same-state grants
  // are skipped via __stdinOwnedState on the proc record.
  grantStdinOwnership(proc, own) {
    if (!proc || proc.__stdinOwnedState === own) return;
    proc.__stdinOwnedState = own;
    try { proc.port.postMessage({ type: 'stdin-own', own }); } catch {}
  }
  // B9: re-derive the owner AND sync grants to every process in the fg
  // tree (a derived change may revoke a stale grant on a proc that still
  // lives but no longer owns the terminal).
  syncStdinOwnership() {
    const owner = this.deriveTerminalOwner();
    const prev = this.terminalOwner;
    if (prev && prev !== owner && !prev.exited) this.grantStdinOwnership(prev, false);
    this.terminalOwner = owner;
    if (owner) this.grantStdinOwnership(owner, true);
  }
  // B9: called from spawnProcess — a new child under the current owner (or
  // anywhere in the fg tree) with an inherit fd0 takes over the terminal.
  updateTerminalOwner(proc) {
    if (!this.foreground) return;
    if (!this.isDescendant(proc, this.foreground) && proc !== this.foreground) return;
    const fd0 = proc.stdioArr ? proc.stdioArr[0] : (proc.stdioMode === 'pipe' ? 'pipe' : 'inherit');
    if (fd0 !== 'inherit') return;
    // Advance ONLY down the current owner's own chain: the new proc must be
    // the owner itself or a DESCENDANT of it (sh waits on node; node's own
    // child takes over from node). A spawn in a different branch (a sibling
    // while another child already owns the terminal) keeps the existing
    // owner — first reader wins, matching sh's sequential children.
    if (this.terminalOwner && this.terminalOwner !== proc && !this.isDescendant(proc, this.terminalOwner)) return;
    // B9: ownership moved — revoke the old grant, grant the new, and route
    // stdin through the channel from now on (sendStdin reads terminalOwner).
    if (this.terminalOwner && this.terminalOwner !== proc) this.grantStdinOwnership(this.terminalOwner, false);
    this.terminalOwner = proc;
    this.grantStdinOwnership(proc, true);
    this.updateProcs();
  }
  signalTree(root, sig) {
    for (const p of this.procs.values()) {
      if (p === root || this.isDescendant(p, root)) {
        try { p.port.postMessage({ type: 'signal', sig }); } catch {}
      }
    }
  }
  // P2-006-008: per-fd pipe check — a spawn like ['inherit','pipe','pipe']
  // (create-expo via the yarn shell: real stdin, piped stdout) must route
  // fd-1/2 bytes to the parent while fd 0 stays on the kernel FIFO.
  stdioIsPiped(proc, stream) {
    if (proc.stdioArr) {
      const entry = stream === 2 ? proc.stdioArr[2] : proc.stdioArr[1];
      return entry === 'pipe';
    }
    return proc.stdioMode === 'pipe';
  }

  async sendStdin(bytes) { // Uint8Array — routed to the TERMINAL OWNER (B9)
    // B25 (ISIG): a lone Ctrl+C (\x03) never reaches the app in a real tty —
    // the line discipline converts it to SIGINT for the FOREGROUND PROCESS
    // GROUP. Our runtime used to deliver it as a plain byte to the fd0
    // reader, so Ctrl+C was dead against servers that read stdin for their
    // own keys (expo start's r/j/a) and simply ignored unknown bytes — the
    // reported 'cannot stop expo start with Ctrl+C'. Convert \x03 to signal
    // delivery for the whole foreground tree instead. Any feed where \x03 is
    // the FIRST byte counts (xterm.js sends it alone); trailing bytes after
    // it, if any, still pass through (real ISIG flushes then signals).
    if (bytes && bytes.length && bytes[0] === 3) {
      this.deliverSignalTree('SIGINT');
      if (bytes.length > 1) { bytes = bytes.slice(1); } else { return; }
    }
    // B9 TERMINAL-OWNER FIX: route to the process actually reading fd0 —
    // the deepest live inherit-fd0 descendant of the foreground root — not
    // the fg root itself. The kernel's stdin_feed BROADCASTS to every live
    // endpoint's FIFO, so feeding at the root while a grandchild owns the
    // prompt both corrupts the root's line buffer (ghost commands after
    // the child exits) and hands the prompt whatever the root's reader had
    // buffered (observed: the typed command line answering create-expo's
    // name prompt → 'Invalid project name' forever). The owner is derived
    // lazily: spawn/exit events maintain it; a stale/missing value (older
    // callers, races) re-derives from the tree.
    let p = this.terminalOwner;
    if (!p || p.exited || (this.foreground && !this.isDescendant(p, this.foreground) && p !== this.foreground)) {
      p = this.deriveTerminalOwner();
      this.terminalOwner = p;
    }
    if (!p && this.foreground && !this.foreground.exited) p = this.foreground;
    if (!p || this.stopped) return;
    // fd 0 piped → channel; else kernel FIFO (terminal).
    // B9: an ownership GRANT also means channel routing — the kernel FIFO
    // feed is a broadcast to every live endpoint and is reserved for the
    // plain fg-root case (no grant outstanding).
    const fd0Piped = p.__stdinOwnedState === true || (p.stdioArr ? p.stdioArr[0] === 'pipe' : p.stdioMode === 'pipe');
    if (fd0Piped) {
      p.port.postMessage({ type: 'stdin-bytes', bytes }); // structured clone copies
      return;
    }
    // P2-006-008: SERIALIZE stdin-feeds through a chain. The driver's handler
    // copies bytes into the SAME kernel scratch (0x2100) then calls
    // nodine_stdin_feed — the RPC reply means "posted to the kernel", but
    // concurrent feeds (keydown bursts: 30-90 ms typing) interleave scratch
    // writes inside the driver's message loop before the kernel copies them,
    // and whole keystrokes vanish (observed live: 'NodineExpoGolden' →
    // 'eExpGold', fixed only by 250 ms delays). One at a time, each awaiting
    // its reply, preserves every keystroke at full typing speed.
    const prev = this._stdinChain || Promise.resolve();
    const run = prev.then(() => this.rpc({ type: 'stdin-feed', bytes }));
    this._stdinChain = run.then(() => {}, () => {});
    try { await run; } catch (e) { DIAG && DIAG.logs.push('stdin-feed: ' + e.message); }
  }

  // -- status bar -------------------------------------------------------------------------
  setKernel(cls, text) { this.status.kernel.textContent = text; this.status.kernel.className = 'st st-' + cls; }
  updateProcs() {
    const n = this.procs.size;
    this.status.procs.textContent = n === 0 ? 'no processes' : n + ' process' + (n > 1 ? 'es' : '') + (this.foreground ? ' · foreground pid ' + this.foreground.pid : '');
  }
  showExit(code) {
    if (this.status.exit) this.status.exit.textContent = '↳ ' + code;
    if (DIAG) DIAG.lastExit = code;
  }

  // -- shutdown ('exit' builtin) ------------------------------------------------------------
  async shutdown(code) {
    if (this.stopped) return;
    this.stopped = true;
    this.warmDrain(); // B7: terminate pooled idle workers with the rest
    this.term.meta('\n[terminal] shutting down runtime (exit ' + code + ')…\n');
    for (const p of this.procs.values()) {
      try { await this.rpc({ type: 'endpoint-died', index: p.ep.index, generation: p.ep.generation }); } catch {}
      try { p.worker.terminate(); } catch {}
    }
    this.procs.clear();
    this.foreground = null;
    this.terminalOwner = null; // B9
    try { await this.rpc({ type: 'shutdown' }); } catch {}
    this.setKernel('stopped', 'runtime stopped');
    this.updateProcs();
    if (DIAG) { DIAG.exitCode = code; DIAG.stopped = true; }
  }

  // -- B1-PREVIEW: the browser preview bridge ---------------------------------
  // Called by the page after sw-nodine.js is registered and active.
  // swPort: a MessagePort whose partner the SW holds (forwarded through
  // navigator.serviceWorker.controller). Every runtime worker spawned after
  initPreviewSW(sid, swPort) {
    this.previewSid = sid;
    this.previewSW = swPort;
    // 0.5.2 (LAN-SHARE): workers spawned BEFORE the bridge attached never got
    // a per-worker preview channel (the spawn-time initTransfer only fires
    // when previewSW is already set), so their http.Server.listen() calls
    // dark-listened. Hand every live worker its channel NOW — mirroring the
    // spawn-time pair — so running dev servers re-register on the bridge
    // instead of requiring a restart of the user's server.
    for (const proc of this.procs.values()) {
      if (!proc.port || proc.exited) continue;
      try {
        const swc = new MessageChannel();
        this.previewSW.postMessage({ type: 'preview-worker-chan', sid }, [swc.port2]);
        proc.port.postMessage({ type: 'preview-sw-port' }, [swc.port1]);
      } catch {}
    }
    // M1.5: the SW talks back on the SAME bridge port — preview-error events
    // from injected capture hooks (window.onerror / unhandledrejection /
    // console.error inside preview documents). Keep the per-port channel
    // routing untouched (worker traffic never flows here); this handler is
    // ONLY for the page-facing error stream. A message with an unknown type
    // is ignored (never fatal).
    swPort.onmessage = (ev) => {
      const m = ev.data;
      if (m && m.type === 'preview-error' && this.onPreviewMessage) {
        try { this.onPreviewMessage(m); } catch {}
      }
    };
    swPort.start && swPort.start();
  }

  // A worker announced a listen() (or close()) — registry + page event.
  previewPortOpen(port, proc) {
    this.previewPorts.set(port, { pid: proc.pid, argv: proc.argv });
    if (this.onPreviewEvent) {
      try { this.onPreviewEvent({ kind: 'open', port, pid: proc.pid, argv: proc.argv }); } catch {}
    }
  }
  previewPortClose(port, proc) {
    const owner = this.previewPorts.get(port);
    if (owner && proc && owner.pid !== proc.pid) return; // stale close from another proc
    this.previewPorts.delete(port);
    if (this.onPreviewEvent) {
      try { this.onPreviewEvent({ kind: 'close', port, pid: owner ? owner.pid : (proc ? proc.pid : null), argv: owner ? owner.argv : null }); } catch {}
    }
  }
  // Process death must close its ports (SW + registry) — otherwise the SW
  // would keep answering 503-shaped emptiness for a dead server.
  previewCloseAllForProc(proc) {
    for (const [port, owner] of [...this.previewPorts]) {
      if (owner.pid !== proc.pid) continue;
      this.previewPorts.delete(port);
      if (this.previewSW) {
        try { this.previewSW.postMessage({ type: 'preview-port-close', sid: this.previewSid, port }); } catch {}
      }
      if (this.onPreviewEvent) {
        try { this.onPreviewEvent({ kind: 'close', port, pid: owner.pid, argv: owner.argv }); } catch {}
      }
    }
  }
}
Supervisor.prototype.rpc.tag = 0;
