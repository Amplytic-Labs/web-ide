// ../../../../tmp/nodine-dist-patched/errors/index.js
var NodineError = class extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "NodineError";
  }
};
var EnvironmentUnsupportedError = class extends NodineError {
  /** The list of failed environment checks. */
  failures;
  constructor(failures) {
    super("This browser environment cannot run the Nodine runtime: " + failures.join("; "), "ERR_NODINE_UNSUPPORTED_ENVIRONMENT");
    this.name = "EnvironmentUnsupportedError";
    this.failures = failures;
  }
};
var BootFailedError = class extends NodineError {
  constructor(message) {
    super(message, "ERR_NODINE_BOOT_FAILED");
    this.name = "BootFailedError";
  }
};
var NotYetImplementedError = class extends NodineError {
  /** The API member that was called. */
  api;
  constructor(api) {
    super(`${api} is defined in the Nodine API contract but is not implemented by the Nodine runtime yet (see the implementation-status report).`, "ERR_NODINE_NOT_IMPLEMENTED");
    this.name = "NotYetImplementedError";
    this.api = api;
  }
};
var UnsupportedFeatureError = class extends NodineError {
  /** The API member that was called. */
  api;
  constructor(api, reason) {
    super(`${api} is not supported by Nodine: ${reason}`, "ERR_NODINE_UNSUPPORTED_FEATURE");
    this.name = "UnsupportedFeatureError";
    this.api = api;
  }
};
var ContainerDestroyedError = class extends NodineError {
  constructor() {
    super("This container instance was torn down and can no longer be used. Call Container.boot() to create a new instance.", "ERR_NODINE_CONTAINER_DESTROYED");
    this.name = "ContainerDestroyedError";
  }
};
var FileSystemError = class extends NodineError {
  constructor(message) {
    super(message, "ERR_NODINE_FS");
    this.name = "FileSystemError";
  }
};
var SpawnError = class extends NodineError {
  constructor(message) {
    super(message, "ERR_NODINE_SPAWN");
    this.name = "SpawnError";
  }
};

// ../../../../tmp/nodine-dist-patched/environment.js
var inBrowser = typeof window !== "undefined" && typeof document !== "undefined" || typeof self !== "undefined";
function checkEnvironment() {
  const checks = [];
  const hasWindow = typeof window !== "undefined" || typeof self !== "undefined";
  const hasDocument = typeof document !== "undefined" || typeof self !== "undefined";
  checks.push({
    id: "browser-context",
    ok: hasWindow && hasDocument,
    message: "Nodine boots inside a browser page (window/document are unavailable \u2014 are you running in Node?)"
  });
  if (!inBrowser)
    return checks;
  checks.push({
    id: "cross-origin-isolated",
    ok: (typeof window !== "undefined" ? window : self).crossOriginIsolated === true,
    message: 'the page is not cross-origin isolated \u2014 serve COOP "same-origin" and COEP "require-corp" or "credentialless" headers from your application origin'
  });
  checks.push({
    id: "shared-array-buffer",
    ok: typeof SharedArrayBuffer !== "undefined",
    message: "SharedArrayBuffer is unavailable (requires cross-origin isolation)"
  });
  checks.push({
    id: "service-workers",
    ok: typeof document === "undefined" || "serviceWorker" in navigator,
    message: "Service Workers are unavailable (requires a secure context: https or localhost)"
  });
  checks.push({
    id: "wasm",
    ok: typeof WebAssembly !== "undefined",
    message: "WebAssembly is unavailable"
  });
  let wasmThreadsOk = false;
  try {
    const bytes = new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      // magic + version
      1,
      4,
      1,
      96,
      0,
      0,
      // type: () -> ()
      3,
      2,
      1,
      0,
      // func: one func, type 0
      5,
      4,
      1,
      3,
      1,
      1,
      // memory: shared, min 1, max 1
      10,
      11,
      1,
      9,
      0,
      65,
      0,
      254,
      16,
      2,
      0,
      26,
      11
      // code: atomic.i32.load; drop
    ]);
    new WebAssembly.Module(bytes);
    wasmThreadsOk = true;
  } catch {
    wasmThreadsOk = false;
  }
  checks.push({
    id: "wasm-threads-atomics",
    ok: wasmThreadsOk,
    message: "WebAssembly threads/atomics are unavailable (required by the Nodine kernel)"
  });
  return checks;
}
function environmentFailures() {
  return checkEnvironment().filter((c) => !c.ok);
}

// ../../../../tmp/nodine-dist-patched/version.js
var SDK_VERSION = "0.4.0";

// ../../../../tmp/nodine-dist-patched/runtime-adapter.js
var HeadlessTermSink = class {
  buffer = "";
  subscribers = /* @__PURE__ */ new Set();
  write(text) {
    this.buffer += text;
    for (const fn of this.subscribers) {
      try {
        fn(text);
      } catch {
      }
    }
  }
  meta(text) {
    this.write(text);
  }
  /** Everything written so far (raw, ANSI sequences included). */
  dump() {
    return this.buffer;
  }
  /** Subscribe to future chunks. Returns an unsubscribe function. */
  onTap(fn) {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
};
async function loadRuntimeModule(runtimeUrl) {
  let mod;
  try {
    mod = await import(
      /* @vite-ignore */
      String(runtimeUrl)
    );
  } catch (e) {
    throw new Error(`Could not load the Nodine runtime module from ${String(runtimeUrl)}: ` + (e instanceof Error ? e.message : String(e)));
  }
  if (typeof mod.Supervisor !== "function") {
    throw new Error(`The module at ${String(runtimeUrl)} does not export a Supervisor class; it is not a Nodine runtime bundle.`);
  }
  return mod;
}
function assertRuntimeSurface(sup) {
  const s = sup;
  const missing = [];
  const need = [
    "boot",
    "seed",
    "spawnProcess",
    "signalTree",
    "shutdown",
    "initPreviewSW",
    "kstat",
    "klstat",
    "mkdirP",
    "kmkdirOne",
    "kunlink",
    "krmdir",
    "ksymlink",
    "kwriteFile",
    "kreadWhole",
    "kreaddir",
    "resolveSymlinks",
    "abs",
    "normalizePath",
    "parentOf",
    "baseEnv",
    "stopped",
    "setKernel",
    "status"
  ];
  for (const k of need) {
    if (s && s[k] === void 0)
      missing.push(k);
  }
  if (missing.length > 0) {
    throw new Error("The Nodine runtime module is missing required members: " + missing.join(", ") + ". The SDK and runtime versions are incompatible.");
  }
}

// ../../../../tmp/nodine-dist-patched/types/filesystem.js
var Dirent = class {
  name;
  _kind;
  constructor(name, _kind) {
    this.name = name;
    this._kind = _kind;
  }
  /** Whether this entry is a directory. */
  isDirectory() {
    return this._kind === "directory";
  }
  /** Whether this entry is a regular file. */
  isFile() {
    return this._kind === "file";
  }
  /** Whether this entry is a symbolic link. */
  isSymbolicLink() {
    return this._kind === "symlink";
  }
};

// ../../../../tmp/nodine-dist-patched/fs-adapter.js
var dec = new TextDecoder();
function decodeBytes(u8, encoding) {
  switch (encoding) {
    case "utf8":
    case "utf-8":
    case "ascii":
    case "latin1":
    case "binary":
    case "ucs2":
    case "ucs-2":
    case "utf16le":
      return dec.decode(u8);
    case "hex":
      return Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
    case "base64": {
      let bin = "";
      const CHUNK = 32768;
      for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
      }
      return btoa(bin);
    }
    case "base64url": {
      let bin = "";
      const CHUNK = 32768;
      for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
      }
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    default:
      throw new FileSystemError(`unsupported encoding: ${encoding}`);
  }
}
function toUint8(data, encoding) {
  if (typeof data !== "string")
    return data;
  const enc = new TextEncoder();
  if (encoding === "hex") {
    const clean = data.replace(/[^0-9a-fA-F]/g, "");
    const out = new Uint8Array(clean.length >> 1);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
  }
  if (encoding === "base64" || encoding === "base64url") {
    const b64 = encoding === "base64url" ? data.replace(/-/g, "+").replace(/_/g, "/") : data;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
      out[i] = bin.charCodeAt(i);
    return out;
  }
  return enc.encode(data);
}
function errnoMessage(status, path, op) {
  switch (status) {
    case -2:
      return `${op}: ${path}: no such file or directory (ENOENT)`;
    case -13:
      return `${op}: ${path}: permission denied (EACCES)`;
    case -17:
      return `${op}: ${path}: file already exists (EEXIST)`;
    case -20:
      return `${op}: ${path}: not a directory (ENOTDIR)`;
    case -21:
      return `${op}: ${path}: is a directory (EISDIR)`;
    case -39:
      return `${op}: ${path}: directory not empty (ENOTEMPTY)`;
    default:
      return `${op}: ${path}: errno ${status}`;
  }
}
function createFileSystem(sup, resolve) {
  async function readdirImpl(path, options) {
    const abs = resolve(path);
    const st = await sup.klstat(abs);
    if (!st.ok)
      throw new FileSystemError(errnoMessage(st.status ?? -2, path, "readdir"));
    if (!st.isDir)
      throw new FileSystemError(errnoMessage(-20, path, "readdir"));
    const names = await sup.kreaddir(abs);
    if (names === null)
      throw new FileSystemError(errnoMessage(-5, path, "readdir"));
    if (options?.withFileTypes) {
      const out = [];
      for (const name of names) {
        const est = await sup.klstat(abs === "/" ? "/" + name : abs + "/" + name);
        out.push(new Dirent(options.encoding && options.encoding !== "utf-8" && options.encoding !== "utf8" ? new TextEncoder().encode(name) : name, est.ok ? est.isDir ? "directory" : est.isSymlink ? "symlink" : "file" : "file"));
      }
      return out;
    }
    return names;
  }
  const fs = {
    async mkdir(path, options) {
      const abs = resolve(path);
      if (options?.recursive) {
        await sup.mkdirP(abs);
        return;
      }
      const st = await sup.kmkdirOne(abs, 511);
      if (st !== 0)
        throw new FileSystemError(errnoMessage(st, path, "mkdir"));
    },
    readdir: readdirImpl,
    async readFile(path, options) {
      const abs = resolve(path);
      const st = await sup.kstat(abs);
      if (!st.ok)
        throw new FileSystemError(errnoMessage(st.status ?? -2, path, "readFile"));
      if (st.isDir)
        throw new FileSystemError(errnoMessage(-21, path, "readFile"));
      const bytes = await sup.kreadWhole(abs);
      if (bytes === null)
        throw new FileSystemError(errnoMessage(-5, path, "readFile"));
      const enc = options?.encoding ?? null;
      if (enc)
        return decodeBytes(bytes, enc);
      return bytes;
    },
    async writeFile(path, data, options) {
      const abs = resolve(path);
      await sup.kwriteFile(abs, toUint8(data, options?.encoding ?? "utf-8"), 420);
    },
    async rename(oldPath, newPath) {
      const absOld = resolve(oldPath);
      const absNew = resolve(newPath);
      const st = await sup.klstat(absOld);
      if (!st.ok)
        throw new FileSystemError(errnoMessage(st.status ?? -2, oldPath, "rename"));
      if (st.isDir)
        throw new FileSystemError("rename: directory rename is not supported by the Nodine kernel ABI");
      const bytes = await sup.kreadWhole(absOld);
      if (bytes === null)
        throw new FileSystemError(errnoMessage(-5, oldPath, "rename"));
      await sup.kwriteFile(absNew, bytes, st.mode ?? 420);
      const rc = await sup.kunlink(absOld);
      if (rc !== 0)
        throw new FileSystemError(errnoMessage(rc, oldPath, "rename"));
    },
    async rm(path, options) {
      const abs = resolve(path);
      const st = await sup.klstat(abs);
      if (!st.ok) {
        if (options?.force)
          return;
        throw new FileSystemError(errnoMessage(st.status ?? -2, path, "rm"));
      }
      if (st.isDir) {
        if (!options?.recursive) {
          throw new FileSystemError(`rm: ${path}: is a directory (EISDIR)`);
        }
        await rmRecursive(abs, sup);
        return;
      }
      const rc = await sup.kunlink(abs);
      if (rc !== 0)
        throw new FileSystemError(errnoMessage(rc, path, "rm"));
    },
    watch(path, ...rest) {
      void path;
      void rest;
      throw new NotYetImplementedError("container.fs.watch (kernel change journal is milestone M4)");
    }
  };
  return fs;
}
async function rmRecursive(abs, sup) {
  const st = await sup.klstat(abs);
  if (!st.ok)
    return;
  if (!st.isDir) {
    await sup.kunlink(abs);
    return;
  }
  const names = await sup.kreaddir(abs);
  if (names) {
    for (const name of names) {
      await rmRecursive(abs === "/" ? "/" + name : abs + "/" + name, sup);
    }
  }
  const rc = await sup.krmdir(abs);
  if (rc !== 0)
    throw new FileSystemError(errnoMessage(rc, abs, "rmdir"));
}

// ../../../../tmp/nodine-dist-patched/container.js
var DEFAULT_RUNTIME_URL = "/nodine/supervisor.mjs";
var Container = class _Container {
  supervisor;
  term;
  workdirPath;
  runtimeBase;
  /** The SDK package version. */
  static sdkVersion = SDK_VERSION;
  /** Live instance counter (single-boot runtime: 1 while booted). */
  static bootedInstance = null;
  constructor(supervisor, term, workdirPath, runtimeBase) {
    this.supervisor = supervisor;
    this.term = term;
    this.workdirPath = workdirPath;
    this.runtimeBase = runtimeBase;
  }
  /**
   * Boots a Nodine runtime instance.
   *
   * @param options - Boot configuration. `runtimeUrl` optionally points at
   * the `supervisor.mjs` module of the Nodine runtime bundle; when omitted,
   * {@link DEFAULT_RUNTIME_URL} is used — the URL the official Vite plugin
   * (`nodine/vite`) and `npx nodine-stage` serve. The runtime resolves all
   * of its assets relative to that URL, so the bundle can live in any
   * directory the host serves; for preview service-worker registration it
   * should sit at the origin root, or the server must send a
   * `Service-Worker-Allowed: /` header for `sw-nodine.js` (see the
   * README).
   *
   * @throws {@link EnvironmentUnsupportedError} when the browser cannot host
   * the runtime (no cross-origin isolation, no SharedArrayBuffer, …).
   * @throws {@link BootFailedError} when the runtime module cannot be loaded
   * or the kernel fails to boot.
   */
  static async boot(options = {}) {
    const failures = environmentFailures();
    if (failures.length > 0) {
      throw new EnvironmentUnsupportedError(failures.map((f) => f.message));
    }
    if (_Container.bootedInstance && !_Container.bootedInstance.destroyed) {
      throw new BootFailedError("A Nodine container is already booted in this page. Call teardown() on the existing instance before booting a new one.");
    }
    if (options.coep === "none") {
      throw new EnvironmentUnsupportedError([
        'coep: "none" \u2014 Nodine requires cross-origin isolation (SharedArrayBuffer + WASM threads); there is no non-isolated fallback mode'
      ]);
    }
    const runtimeUrl = options.runtimeUrl == null ? DEFAULT_RUNTIME_URL : String(options.runtimeUrl);
    const term = new HeadlessTermSink();
    const statusEls = {
      kernel: { textContent: "" },
      procs: { textContent: "" },
      cwd: { textContent: "" },
      exit: { textContent: "" },
      seed: { textContent: "" }
    };
    let mod;
    try {
      mod = await loadRuntimeModule(runtimeUrl);
    } catch (e) {
      throw new BootFailedError(e instanceof Error ? e.message : String(e));
    }
    const supervisor = new mod.Supervisor(term, statusEls, options.perf ? { perf: true } : void 0);
    if (options.env) {
      for (const [k, v] of Object.entries(options.env))
        supervisor.baseEnv[k] = v;
    }
    try {
      assertRuntimeSurface(supervisor);
      await supervisor.boot();
    } catch (e) {
      throw new BootFailedError("The Nodine kernel failed to boot: " + (e instanceof Error ? e.message : String(e)));
    }
    if (options.seedLibSources !== false) {
      try {
        await supervisor.seed();
      } catch (e) {
        term.meta("[nodine] libsource seeding failed: " + (e instanceof Error ? e.message : String(e)) + "\n");
      }
    }
    const workdirName = options.workdirName ?? "project";
    const workdirPath = `/home/user/${workdirName}`;
    try {
      await supervisor.mkdirP(workdirPath);
    } catch {
    }
    const container = new _Container(supervisor, term, workdirPath, new URL(runtimeUrl, typeof document !== "undefined" ? document.baseURI : self.location.origin));
    container.__sup = supervisor;
    if (options.enablePreview !== false) {
      await container.initPreviewBridge(options.forwardPreviewErrors);
    }
    _Container.bootedInstance = container;
    return container;
  }
  destroyed = false;
  /** Debug/back-reference to the runtime supervisor (internal, browser devtools). */
  __sup = null;
  /** Preview session id, set once the preview SW bridge is established. */
  previewSid = null;
  handlers = {
    "server-ready": /* @__PURE__ */ new Set(),
    port: /* @__PURE__ */ new Set(),
    error: /* @__PURE__ */ new Set(),
    "preview-message": /* @__PURE__ */ new Set()
  };
  processes = /* @__PURE__ */ new Set();
  async initPreviewBridge(forwardPreviewErrors) {
    if (!("serviceWorker" in navigator))
      return;
    try {
      const swUrl = new URL("sw-nodine.js", this.runtimeBase).href;
      const reg = await navigator.serviceWorker.register(swUrl, { scope: "/" });
      await navigator.serviceWorker.ready;
      let sw = navigator.serviceWorker.controller || reg.active || reg.installing || reg.waiting;
      for (let i = 0; i < 50 && !sw; i++) {
        await new Promise((r) => setTimeout(r, 100));
        sw = reg.active || navigator.serviceWorker.controller;
      }
      if (!sw)
        return;
      const sid = crypto.randomUUID();
      const { port1, port2 } = new MessageChannel();
      this.supervisor.initPreviewSW(sid, port1);
      const forwardErrors = forwardPreviewErrors === true ? "all" : forwardPreviewErrors === "exceptions-only" ? "exceptions" : forwardPreviewErrors === false || forwardPreviewErrors === void 0 ? null : null;
      sw.postMessage({ type: "preview-bridge", sid, forwardErrors }, [port2]);
      this.previewSid = sid;
      this.supervisor.onPreviewEvent = (ev) => {
        const url = this.previewUrl(ev.port);
        if (ev.kind === "open") {
          for (const fn of this.handlers["server-ready"]) {
            try {
              fn(ev.port, url);
            } catch {
            }
          }
        }
        for (const fn of this.handlers.port) {
          try {
            fn(ev.port, ev.kind, url);
          } catch {
          }
        }
      };
      this.supervisor.onPreviewMessage = (m) => {
        if (!m || m.sid !== this.previewSid)
          return;
        const base = {
          previewId: this.previewSid ?? "",
          port: m.port,
          pathname: typeof m.pathname === "string" ? m.pathname : "",
          search: typeof m.search === "string" ? m.search : "",
          hash: typeof m.hash === "string" ? m.hash : ""
        };
        let msg = null;
        if (m.kind === "uncaught") {
          msg = {
            ...base,
            type: "PREVIEW_UNCAUGHT_EXCEPTION",
            message: String(m.message ?? ""),
            stack: typeof m.stack === "string" ? m.stack : ""
          };
        } else if (m.kind === "rejection") {
          msg = {
            ...base,
            type: "PREVIEW_UNHANDLED_REJECTION",
            message: String(m.message ?? ""),
            stack: typeof m.stack === "string" ? m.stack : ""
          };
        } else if (m.kind === "console") {
          msg = {
            ...base,
            type: "PREVIEW_CONSOLE_ERROR",
            message: String(m.message ?? "")
          };
        }
        if (!msg)
          return;
        for (const fn of this.handlers["preview-message"]) {
          try {
            fn(msg);
          } catch {
          }
        }
      };
    } catch {
    }
  }
  /** Absolute URL for a preview port (same-origin gateway path). */
  previewUrl(port) {
    if (!this.previewSid)
      return `/preview/unavailable/${port}/`;
    return `/preview/${this.previewSid}/${port}/`;
  }
  assertLive() {
    if (this.destroyed)
      throw new ContainerDestroyedError();
  }
  resolvePath(p) {
    this.assertLive();
    if (!p)
      return this.workdirPath;
    return p.startsWith("/") ? this.supervisor.normalizePath(p) : this.supervisor.abs(this.workdirPath, p);
  }
  /** The default value of the PATH environment variable for spawned processes. */
  get path() {
    this.assertLive();
    return this.supervisor.baseEnv.PATH ?? "/usr/bin:/bin";
  }
  /**
   * The runtime's base environment (HOME, PATH, …) as a plain record.
   * Additive public API (batch 3 validation): hosts layer their session
   * env over this without touching private supervisor internals. Returns
   * a copy — mutating it has no effect on the runtime.
   */
  get baseEnv() {
    this.assertLive();
    return { ...this.supervisor.baseEnv };
  }
  /** The full path of the container's working directory. */
  get workdir() {
    this.assertLive();
    return this.workdirPath;
  }
  fsInstance = null;
  /** Access to the container filesystem. */
  get fs() {
    this.assertLive();
    if (!this.fsInstance) {
      this.fsInstance = createFileSystem(this.supervisor, (p) => this.resolvePath(p));
    }
    return this.fsInstance;
  }
  /** Subscribe to raw terminal output (all processes, ANSI included). */
  onOutput(fn) {
    this.assertLive();
    return this.term.onTap(fn);
  }
  /**
   * Mounts a tree of files into the container filesystem relative to the
   * container working directory.
   */
  async mount(tree) {
    this.assertLive();
    const errors = [];
    await this.mountNode(tree, this.workdirPath, errors);
    if (errors.length > 0) {
      throw new FileSystemError("mount failed: " + errors.join("; "));
    }
  }
  async mountNode(node, dir, errors) {
    for (const [name, value] of Object.entries(node)) {
      const target = dir === "/" ? "/" + name : dir + "/" + name;
      try {
        if ("file" in value) {
          const data = typeof value.file.contents === "string" ? new TextEncoder().encode(value.file.contents) : value.file.contents;
          await this.supervisor.kwriteFile(target, data, 420);
        } else if ("symlink" in value) {
          await this.supervisor.mkdirP(this.supervisor.parentOf(target));
          await this.supervisor.ksymlink(value.symlink, target);
        } else if ("directory" in value) {
          await this.supervisor.mkdirP(target);
          await this.mountNode(value.directory, target, errors);
        }
      } catch (e) {
        errors.push(`${target}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  /**
   * Spawns a process inside the container.
   *
   * @remarks
   * The process runs with piped IO: feed its stdin through `input`, read
   * stdout/stderr through `output`. Output contains only this process's
   * bytes: its own piped writes plus inherit-mode descendants, which the
   * runtime re-emits onto this process's pipe (dup semantics). Output from
   * other processes never appears here — the container-wide terminal view
   * is {@link Container.onOutput}.
   */
  async spawn(command, args = [], options = {}) {
    this.assertLive();
    const argv = [command, ...args];
    const env = { ...this.supervisor.baseEnv };
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        env[k] = String(v);
      }
    }
    const cwd = options.cwd ? options.cwd.startsWith("/") ? this.supervisor.normalizePath(options.cwd) : this.supervisor.abs(this.workdirPath, options.cwd) : this.workdirPath;
    const stdioMode = options.stdio === "inherit" ? "inherit" : options.output === false ? ["ignore", "ignore", "ignore"] : ["pipe", "pipe", "pipe"];
    const { port1, port2 } = new MessageChannel();
    const syntheticParent = {
      pid: -1,
      worker: null,
      port: port2,
      ep: { index: -1, generation: -1 },
      parent: null,
      children: /* @__PURE__ */ new Set(),
      stdioMode: "pipe",
      argv: [],
      entry: null,
      env,
      cwd,
      ready: true,
      exited: false,
      parentPid: null
    };
    let spawnError = null;
    port1.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "spawn-result" && m.error)
        spawnError = m.error;
    };
    let proc = null;
    try {
      proc = await this.supervisor.spawnProcess({
        argv,
        env,
        cwd,
        stdioMode,
        parent: syntheticParent,
        viaPort: port2
      });
    } catch (e) {
      port1.close();
      port2.close();
      throw new SpawnError(`spawn ${command}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!proc) {
      port1.close();
      port2.close();
      throw new SpawnError(spawnError ?? `spawn ${command}: command could not be resolved (command not found or exec format error)`);
    }
    const impl = new ContainerProcessImpl(proc, this.supervisor, this.term, port1, port2);
    this.processes.add(impl);
    void impl.exit.then(() => this.processes.delete(impl));
    return impl;
  }
  /**
   * Destroys the container, releasing its resources. All derived entities
   * (processes, the filesystem view) become unusable.
   */
  async teardown() {
    if (this.destroyed)
      return;
    this.destroyed = true;
    for (const p of this.processes) {
      try {
        p.kill();
      } catch {
      }
    }
    try {
      await this.supervisor.shutdown(0);
    } catch {
    }
    this.supervisor.onPreviewEvent = null;
    this.supervisor.onPreviewMessage = null;
    if (this.previewSid && "serviceWorker" in navigator) {
      try {
        const sw = navigator.serviceWorker.controller;
        if (sw)
          sw.postMessage({ type: "preview-bridge-end", sid: this.previewSid });
      } catch {
      }
    }
    if (_Container.bootedInstance === this) {
      _Container.bootedInstance = null;
    }
  }
  on(event, listener) {
    this.assertLive();
    const set = this.handlers[event];
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
};
var ContainerProcessImpl = class {
  proc;
  supervisor;
  exit;
  input;
  output;
  killed = false;
  constructor(proc, supervisor, _term, port1, port2) {
    this.proc = proc;
    this.supervisor = supervisor;
    let resolveExit;
    this.exit = new Promise((res) => {
      resolveExit = res;
    });
    let controller;
    this.output = new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
      }
    });
    const pushText = (text) => {
      try {
        controller.enqueue(text);
      } catch {
      }
    };
    port1.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "child-stdout" || m.type === "child-stderr") {
        if (m.bytes) {
          const u8 = m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes);
          pushText(new TextDecoder().decode(u8));
        }
        return;
      }
      if (m.type === "child-exit") {
        this.lastKnownCode = m.code ?? 0;
        settleExit(this.lastKnownCode);
        return;
      }
      if (m.type === "spawn-result" && m.error) {
        pushText(`[nodine] spawn failed: ${m.error}
`);
      }
    };
    let exitSettled = false;
    const settleExit = (code) => {
      if (exitSettled)
        return;
      exitSettled = true;
      resolveExit(code);
    };
    const poll = setInterval(() => {
      if (this.proc.exited) {
        clearInterval(poll);
        settleExit(this.lastKnownCode ?? 0);
      }
    }, 250);
    void this.exit.then(() => {
      clearInterval(poll);
      setTimeout(() => {
        this.closePorts();
        try {
          controller.close();
        } catch {
        }
      }, 50);
    });
    this.input = new WritableStream({
      write: (chunk) => {
        if (this.proc.exited)
          return;
        this.proc.port.postMessage({ type: "stdin-bytes", bytes: new TextEncoder().encode(chunk) });
      },
      close: () => {
        if (!this.proc.exited) {
          try {
            this.proc.port.postMessage({ type: "stdin-eof" });
          } catch {
          }
        }
      }
    });
    this.port1 = port1;
    this.port2 = port2;
  }
  port1;
  port2;
  lastKnownCode = null;
  closedPorts = false;
  closePorts() {
    if (this.closedPorts)
      return;
    this.closedPorts = true;
    try {
      this.port1.close();
    } catch {
    }
    try {
      this.port2.close();
    } catch {
    }
  }
  /** Kills the process (SIGTERM to the process tree). */
  kill() {
    if (this.proc.exited || this.killed)
      return;
    this.killed = true;
    try {
      this.supervisor.signalTree(this.proc, "SIGTERM");
    } catch {
    }
    setTimeout(() => {
      if (!this.proc.exited) {
        try {
          this.supervisor.signalTree(this.proc, "SIGKILL");
        } catch {
        }
      }
    }, 3e3);
  }
  /**
   * Sends SIGINT to the process tree (Ctrl+C semantics: the foreground
   * process group gets a chance to exit cleanly, handlers run). Unlike
   * kill() this is NOT fatal-by-design and does not escalate — a process
   * that ignores SIGINT keeps running. Additive public API (batch 3
   * validation): the website terminal needs real Ctrl+C without touching
   * private supervisor internals.
   */
  interrupt() {
    if (this.proc.exited)
      return;
    try {
      this.supervisor.signalTree(this.proc, "SIGINT");
    } catch {
    }
  }
  /** Resizes the attached terminal. Not yet backed by the runtime. */
  resize(_dimensions) {
    throw new NotYetImplementedError("process.resize (real PTY sizing arrives with the TTY milestone; the kernel is currently fixed at 80\xD724)");
  }
};
export {
  BootFailedError,
  Container,
  ContainerDestroyedError,
  DEFAULT_RUNTIME_URL,
  Dirent,
  EnvironmentUnsupportedError,
  FileSystemError,
  NodineError,
  NotYetImplementedError,
  SDK_VERSION,
  SpawnError,
  UnsupportedFeatureError
};
