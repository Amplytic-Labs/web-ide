"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/extensionMain.ts
var extensionMain_exports = {};
__export(extensionMain_exports, {
  activate: () => activate,
  getProjectCwd: () => getProjectCwd,
  projectCwd: () => projectCwd,
  setProjectCwd: () => setProjectCwd
});
module.exports = __toCommonJS(extensionMain_exports);
var vscode6 = __toESM(require("vscode"));

// src/nodine.ts
var vscode = __toESM(require("vscode"));
var containerPromise = null;
var currentContainer = null;
function getContainer() {
  return currentContainer;
}
function isCrossOriginIsolated() {
  const g = typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis;
  return g.crossOriginIsolated === true;
}
async function bootContainer(runtimeUrl, workdirName = "project") {
  if (currentContainer) {
    return currentContainer;
  }
  if (!containerPromise) {
    containerPromise = (async () => {
      if (!isCrossOriginIsolated()) {
        throw new Error(
          "This page is not cross-origin isolated. The dev environment needs the hosting server to send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless headers."
        );
      }
      const ext = vscode.extensions.getExtension("amplytic.webide-dev") ?? vscode.extensions.getExtension("webide-dev");
      const extUri = ext?.extensionUri?.toString();
      const baseUri = typeof document !== "undefined" ? document.baseURI : extUri ? extUri.replace(/\/+$/, "") + "/" : void 0;
      if (!baseUri) {
        throw new Error("Cannot resolve the app origin for the nodine runtime URL from this worker context.");
      }
      const absRuntimeUrl = new URL(runtimeUrl, baseUri).href;
      const sdkUrl = new URL("./sdk.mjs", absRuntimeUrl).href;
      const mod = await import(
        /* @vite-ignore */
        sdkUrl
      );
      const container = await mod.Container.boot({ runtimeUrl: absRuntimeUrl, coep: "credentialless", workdirName });
      currentContainer = container;
      return container;
    })().catch((err) => {
      containerPromise = null;
      throw err;
    });
  }
  return containerPromise;
}

// src/fsProvider.ts
var vscode2 = __toESM(require("vscode"));
var SCHEME = "nodine";
var NODINE_ROOT = "nodine://nodine/Nodine/";
var WORKSPACE_PREFIX = "/Nodine";
function nodineRoot() {
  return vscode2.Uri.parse(NODINE_ROOT);
}
var NodineFileSystemProvider = class {
  /**
   * bolt.diy-style wiring: the provider is registered BEFORE the runtime
   * boots and resolves the container lazily on every call. Any nodine:/
   * request that arrives during the boot window waits for the container
   * instead of failing with ENOPRO ("no file system provider found").
   */
  constructor(getContainer2) {
    __publicField(this, "getContainer", getContainer2);
    /** E2E diagnostic: how many times VS Code asked us to watch. */
    __publicField(this, "watchCalls", 0);
    // change events
    __publicField(this, "_onDidChangeFile", new vscode2.EventEmitter());
    __publicField(this, "onDidChangeFile", this._onDidChangeFile.event);
  }
  /** Resolve the container, or throw a VS Code-level "unavailable" error. */
  async ready() {
    const c = await this.getContainer();
    if (!c) {
      throw vscode2.FileSystemError.Unavailable("Dev environment is still booting (nodine runtime)");
    }
    return c;
  }
  /** workspace URI /Nodine[/x] → container path /[/x]; raw paths pass through */
  toContainerPath(uri) {
    const p = uri.path;
    if (p === WORKSPACE_PREFIX) {
      return "/";
    }
    if (p.startsWith(`${WORKSPACE_PREFIX}/`)) {
      return p.slice(WORKSPACE_PREFIX.length);
    }
    return p.startsWith("/") ? p : `/${p}`;
  }
  /** container path /x → workspace URI nodine://nodine/Nodine/x */
  toWorkspaceUri(containerPath) {
    const rel = containerPath.replace(/^\/+/, "");
    return vscode2.Uri.parse(`${NODINE_ROOT}${rel}`);
  }
  stat(uri) {
    return this._stat(this.toContainerPath(uri));
  }
  async _stat(p) {
    const c = await this.ready();
    try {
      await c.fs.readdir(p);
      return { type: vscode2.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0 };
    } catch {
      try {
        const data = await c.fs.readFile(p);
        return { type: vscode2.FileType.File, ctime: 0, mtime: Date.now(), size: data.length };
      } catch {
        throw vscode2.FileSystemError.FileNotFound(p);
      }
    }
  }
  readDirectory(uri) {
    return (async () => {
      const c = await this.ready();
      const p = this.toContainerPath(uri);
      let raw;
      try {
        raw = await c.fs.readdir(p, { withFileTypes: true });
      } catch (err) {
        throw vscode2.FileSystemError.FileNotFound(uri);
      }
      const out = [];
      const unknown = [];
      for (const e of raw) {
        const name = typeof e === "string" ? e : e.name ?? String(e);
        const kind = typeof e === "object" && e !== null ? typeof e.isDirectory === "function" ? e.isDirectory() ? "directory" : "file" : e._kind ?? (e.type === 2 ? "directory" : e.type === 1 ? "file" : void 0) : void 0;
        if (kind === "directory") {
          out.push([name, vscode2.FileType.Directory]);
        } else if (kind === "file") {
          out.push([name, vscode2.FileType.File]);
        } else {
          unknown.push(name);
        }
      }
      for (const name of unknown) {
        try {
          await c.fs.readdir(`${p}/${name}`);
          out.push([name, vscode2.FileType.Directory]);
        } catch {
          out.push([name, vscode2.FileType.File]);
        }
      }
      return out;
    })();
  }
  readFile(uri) {
    return (async () => {
      const c = await this.ready();
      return c.fs.readFile(this.toContainerPath(uri)).catch(() => {
        throw vscode2.FileSystemError.FileNotFound(uri);
      });
    })();
  }
  writeFile(uri, content, options) {
    return (async () => {
      const c = await this.ready();
      const p = this.toContainerPath(uri);
      if (!options.overwrite) {
        try {
          await c.fs.readFile(p);
          if (!options.overwrite) {
            throw vscode2.FileSystemError.FileExists(uri);
          }
        } catch (e) {
          if (e instanceof vscode2.FileSystemError && e.code === "FileExists") {
            throw e;
          }
        }
      }
      await c.fs.writeFile(p, content);
      this._fireDidChange(uri);
    })();
  }
  /** VS Code FileSystemProvider API: create a directory. */
  createDirectory(uri) {
    return (async () => {
      const c = await this.ready();
      await c.fs.mkdir(this.toContainerPath(uri), { recursive: true });
      this._fireFileCreated(uri);
    })();
  }
  /**
   * bolt.diy-style event bridge: writes that bypass this provider (the
   * upload/import helpers and the terminal write straight to the container
   * FS) still must reach the workbench — without these events the Explorer
   * tree keeps its cached root listing and never shows the new files.
   */
  fireExternalChange(type, containerPath) {
    this._onDidChangeFile.fire([{ type, uri: this.toWorkspaceUri(containerPath) }]);
  }
  async exists(p) {
    const c = await this.ready();
    try {
      await c.fs.readdir(p);
      return true;
    } catch {
      try {
        await c.fs.readFile(p);
        return true;
      } catch {
        return false;
      }
    }
  }
  delete(uri, options) {
    return (async () => {
      const c = await this.ready();
      const p = this.toContainerPath(uri);
      if (!await this.exists(p)) {
        throw vscode2.FileSystemError.FileNotFound(uri);
      }
      await c.fs.rm(p, { recursive: options.recursive, force: true });
      this._fireFileDeleted(uri);
    })();
  }
  rename(oldUri, newUri, options) {
    return (async () => {
      const c = await this.ready();
      const from = this.toContainerPath(oldUri);
      const to = this.toContainerPath(newUri);
      if (!options.overwrite && await this.exists(to)) {
        throw vscode2.FileSystemError.FileExists(newUri);
      }
      await c.fs.rename(from, to);
      this._fireFileDeleted(oldUri);
      this._fireFileCreated(newUri);
    })();
  }
  watch(uri) {
    this.watchCalls++;
    const p = this.toContainerPath(uri);
    let watcher;
    this.ready().then((c) => {
      try {
        watcher = c.fs.watch(p, (_event, filename) => {
          const dirty = (filename ?? "").startsWith("/") ? filename : `${p}/${filename ?? ""}`;
          const parts = dirty.replace(/\/+$/, "").split("/");
          parts.pop();
          const parent = parts.join("/") || "/";
          this._fireDidChange(this.toWorkspaceUri(parent));
          this._fireDidChange(this.toWorkspaceUri(dirty));
        });
      } catch {
      }
    }).catch(() => {
    });
    return new vscode2.Disposable(() => watcher?.close());
  }
  _fireDidChange(uri) {
    this._onDidChangeFile.fire([{ type: vscode2.FileChangeType.Changed, uri }]);
  }
  _fireFileCreated(uri) {
    this._onDidChangeFile.fire([{ type: vscode2.FileChangeType.Created, uri }]);
  }
  _fireFileDeleted(uri) {
    this._onDidChangeFile.fire([{ type: vscode2.FileChangeType.Deleted, uri }]);
  }
  get scheme() {
    return SCHEME;
  }
};
async function openNodineWorkspace(_container) {
  const folderUri = nodineRoot();
  const existing = vscode2.workspace.workspaceFolders;
  const already = existing?.some((f) => f.uri.scheme === SCHEME);
  if (already) {
    return;
  }
  const ok = vscode2.workspace.updateWorkspaceFolders(
    0,
    existing?.length ?? 0,
    { uri: folderUri, name: "Nodine" }
  );
  if (!ok) {
    console.error("[webide-dev] updateWorkspaceFolders returned false (workspace change rejected)");
  }
}

// src/terminal.ts
var vscode3 = __toESM(require("vscode"));
var afterCommandHook = null;
var hookFireCount = 0;
function setAfterCommandHook(fn) {
  afterCommandHook = fn;
}
function getHookFireCount() {
  return hookFireCount;
}
var NodineTerminal = class {
  constructor(runtimeUrl) {
    __publicField(this, "runtimeUrl", runtimeUrl);
    __publicField(this, "writeEmitter", new vscode3.EventEmitter());
    __publicField(this, "onDidWrite", this.writeEmitter.event);
    __publicField(this, "closeEmitter", new vscode3.EventEmitter());
    __publicField(this, "onDidClose", this.closeEmitter.event);
    __publicField(this, "container", null);
    __publicField(this, "current", null);
    __publicField(this, "inputWriter", null);
    /** true when the foreground process was spawned stdio:inherit (tree output via onOutput, stdin via __sup.sendStdin). */
    __publicField(this, "inheritSpawn", false);
    __publicField(this, "outSub", null);
    __publicField(this, "outDecoder", null);
    /** epoch ms until which late tty chunks are still accepted — the driver drains the kernel tty FIFO on a 50 ms timer, so a fast command's output can land AFTER exit (running already false). */
    __publicField(this, "acceptUntil", 0);
    __publicField(this, "buffer", "");
    __publicField(this, "running", false);
    /** cwd for spawned commands — starts at the container root (Explorer root). */
    __publicField(this, "cwd", null);
    /** whether the last fired output ended with a newline (prompt placement) */
    __publicField(this, "atLineStart", true);
    /** one-time hint shown when a running program doesn't read stdin */
    __publicField(this, "stdinHintShown", false);
    /**
     * Output coalescing: process output arrives as many tiny chunks (clack
     * writes each cursor sequence separately, npm per line). Fired as-is,
     * escape sequences split across xterm writes mis-render (stale prompt
     * frames). Buffer for ~12 ms and fire ONE atomic chunk — a real PTY does
     * the same, and atomic delivery is proven to render correctly.
     */
    __publicField(this, "outBuf", "");
    __publicField(this, "outTimer", null);
    __publicField(this, "nodeVersionCache", null);
  }
  /** Point the shell at a project folder (e.g. "/my-app"). Silent pre-boot. */
  cd(path) {
    if (path) {
      this.cwd = path.replace(/\/+$/, "") || "/";
    } else {
      this.cwd = "/";
    }
    if (this.container) {
      this.prompt();
    }
  }
  /** Absolute directory commands run in: cwd (default the container root). */
  resolveCwd(container) {
    return this.cwd ?? "/";
  }
  /** All output goes through here: bare \n → \r\n (no staircase output). */
  write(data) {
    this.outBuf += data.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
    if (this.outTimer === null) {
      this.outTimer = setTimeout(() => this.flushOut(), 12);
    }
  }
  flushOut() {
    if (this.outTimer !== null) {
      clearTimeout(this.outTimer);
      this.outTimer = null;
    }
    if (!this.outBuf) {
      return;
    }
    const buf = this.outBuf;
    this.outBuf = "";
    this.atLineStart = buf.endsWith("\r\n") || buf.endsWith("\n");
    this.writeEmitter.fire(buf);
  }
  /** ANSI: clear viewport + scrollback + home (real `clear`). */
  clearScreen() {
    this.flushOut();
    this.writeEmitter.fire("\x1B[2J\x1B[3J\x1B[H");
    this.atLineStart = true;
  }
  async open(_initialDimensions) {
    this.clearScreen();
    this.write("\x1B[90mstarting dev environment\u2026\x1B[0m\r\n");
    try {
      this.container = await bootContainer(this.runtimeUrl);
    } catch (err) {
      console.error("[webide-dev] runtime boot failed:", err);
      this.write("\x1B[31mfailed to start the dev environment (the host must send cross-origin isolation headers).\x1B[0m\r\n");
      this.closeEmitter.fire(1);
      return;
    }
    this.outDecoder = new TextDecoder();
    this.outSub = this.container.onOutput((chunk) => {
      if (!this.running && Date.now() > this.acceptUntil) {
        return;
      }
      const text = typeof chunk === "string" ? chunk : this.outDecoder.decode(chunk, { stream: true });
      this.write(text);
    });
    const version = await this.nodeVersion();
    this.clearScreen();
    if (version) {
      this.write(`Node.js ${version}\r
\r
`);
    }
    this.prompt();
  }
  async nodeVersion() {
    if (this.nodeVersionCache !== null) {
      return this.nodeVersionCache;
    }
    try {
      const proc = await this.container.spawn("node", ["-p", "process.version"]);
      let out = "";
      const readAll = (async () => {
        if (!proc.output) {
          return;
        }
        const reader = proc.output.getReader();
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          out += value;
        }
      })();
      const code = await Promise.race([
        proc.exit,
        new Promise((r) => setTimeout(() => r(null), 2e4))
      ]);
      await Promise.race([readAll, new Promise((r) => setTimeout(r, 2e3))]);
      if (code === null) {
        try {
          await proc.kill();
        } catch {
        }
        this.nodeVersionCache = null;
      } else {
        this.nodeVersionCache = out.trim().replace(/^['"]|['"]$/g, "") || null;
      }
    } catch {
      this.nodeVersionCache = null;
    }
    return this.nodeVersionCache;
  }
  /** "/" renders as the workspace root name — Nodine/ (like C:\). */
  displayCwd() {
    const where = this.cwd ?? "/";
    return where === "/" ? "Nodine/" : `Nodine${where}`;
  }
  prompt() {
    this.flushOut();
    if (!this.atLineStart) {
      this.writeEmitter.fire("\r\n");
      this.atLineStart = true;
    }
    this.writeEmitter.fire(`\x1B[36m${this.displayCwd()}\x1B[0m \u276F `);
  }
  /** `cd <dir>` builtin: resolve relative to the current cwd and switch. */
  changeDir(arg) {
    if (!this.container) {
      return;
    }
    const base = this.resolveCwd(this.container);
    let next;
    if (!arg || arg === "~") {
      next = this.container.workdir;
    } else if (arg === "/" || arg === "-") {
      next = "/";
    } else if (arg.startsWith("/")) {
      next = arg;
    } else {
      next = `${base}/${arg}`;
    }
    const segs = [];
    for (const part of next.split("/")) {
      if (!part || part === ".") {
        continue;
      }
      if (part === "..") {
        segs.pop();
        continue;
      }
      segs.push(part);
    }
    this.cwd = "/" + segs.join("/");
  }
  /**
   * The supervisor's terminal-owner stdin FIFO (`__sup.sendStdin`) — the
   * same surface the old Nodine site used for interactive prompts. Routes
   * to the supervisor's FOREGROUND process at any tree depth (the SDK's
   * proc.input only exists for piped spawns and only reaches the root),
   * and converts a leading \x03 into SIGINT for the whole tree.
   */
  supStdin() {
    const sup = this.container.__sup;
    if (sup?.sendStdin && sup.foreground && !sup.foreground.exited) {
      return (bytes) => {
        try {
          sup.sendStdin(bytes);
        } catch {
        }
      };
    }
    return null;
  }
  handleInput(data) {
    if (!this.container) {
      return;
    }
    if (this.running) {
      if (data.includes("")) {
        const sup = this.supStdin();
        if (sup) {
          sup(new Uint8Array([3]));
        } else {
          if (this.inputWriter) {
            void this.inputWriter.write("");
          }
          try {
            void this.current?.kill();
          } catch {
          }
        }
        this.write("^C\r\n");
        this.atLineStart = true;
        return;
      }
      for (const ch of data) {
        const feed = this.inheritSpawn ? this.supStdin() : null;
        const bytes = new TextEncoder().encode(ch);
        if (feed) {
          feed(bytes);
        } else if (this.inputWriter) {
          if (ch === "\r") {
            this.writeEmitter.fire("\r\n");
          }
          void this.inputWriter.write(ch);
        }
      }
      return;
    }
    for (const ch of data) {
      if (ch === "\r") {
        const line = this.buffer;
        this.buffer = "";
        this.write("\r\n");
        void this.runLine(line);
        return;
      } else if (ch === "\x7F") {
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          this.writeEmitter.fire("\b \b");
        }
      } else if (ch === "") {
        this.buffer = "";
        this.write("^C\r\n");
        this.prompt();
      } else if (ch >= " ") {
        this.buffer += ch;
        this.writeEmitter.fire(ch);
      }
    }
  }
  async runLine(line) {
    const container = this.container;
    if (!container) {
      return;
    }
    const segments = splitAndSeq(line);
    if (segments.every((s) => tokenize(s).length === 0)) {
      this.prompt();
      return;
    }
    this.running = true;
    try {
      for (const seg of segments) {
        const code = await this.runSegment(seg, container);
        if (code !== 0) {
          break;
        }
      }
    } finally {
      this.finishCommand();
    }
  }
  /**
   * One &&-segment: builtins or a spawned process. Returns the exit code.
   * Honors `> file` / `>> file` redirection (stdout → container file).
   */
  async runSegment(seg, container) {
    const argv = tokenize(seg);
    if (argv.length === 0) {
      return 0;
    }
    let redirect = null;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === ">" || argv[i] === ">>") {
        const target = argv[i + 1];
        if (!target) {
          this.write("\x1B[31msyntax error: expected file after redirect\x1B[0m\r\n");
          return 2;
        }
        redirect = { path: target, append: argv[i] === ">>" };
        argv.length = i;
        break;
      }
    }
    if (argv[0] === "clear") {
      this.clearScreen();
      return 0;
    }
    if (argv[0] === "cd") {
      this.changeDir(argv[1]);
      return 0;
    }
    if (argv[0] === "pwd") {
      const out = `${this.resolveCwd(container)}\r
`;
      if (redirect) {
        await this.writeContainerFile(container, redirect, out.replace("\r\n", "\n"));
      } else {
        this.write(out);
      }
      return 0;
    }
    if (argv[0] === "echo") {
      const text = `${argv.slice(1).join(" ")}\r
`;
      if (redirect) {
        await this.writeContainerFile(container, redirect, argv.slice(1).join(" ") + "\n");
      } else {
        this.write(text);
      }
      return 0;
    }
    if (argv[0] === "exit") {
      this.closeEmitter.fire(0);
      return 0;
    }
    if (argv[0] === ">") {
      const code = seg.replace(/^\s*>\s*/, "");
      if (!code) {
        return 0;
      }
      const proc = await container.spawn("node", ["-e", replWrap(code)], {
        cwd: this.resolveCwd(container),
        env: { ...container.baseEnv }
      });
      this.current = proc;
      this.inheritSpawn = false;
      return await this.pump(proc, container);
    }
    try {
      let proc;
      const spawnOpts = {
        cwd: this.resolveCwd(container),
        // progress:false — the kernel tty is isTTY, so npm would draw
        // spinner frames into the scrollback. NO loglevel override:
        // npm's default 'notice' keeps the 'http fetch' debug spam out
        // of the terminal (the old site passed no npm env either).
        env: { ...container.baseEnv, ...argv[0] === "npm" || argv[0] === "npx" ? { npm_config_progress: "false" } : {} },
        stdio: redirect ? "pipe" : "inherit"
      };
      if (argv[0] === "node") {
        if (argv.length === 1) {
          this.write('\x1B[90musage: node <file.js> \xB7 node -v \xB7 node -e "<code>"\x1B[0m\r\n');
          return 0;
        }
        proc = await container.spawn("node", argv.slice(1), spawnOpts);
      } else {
        proc = await container.spawn(argv[0], argv.slice(1), spawnOpts);
      }
      this.current = proc;
      this.inheritSpawn = !redirect;
      this.inputWriter = proc.input ? proc.input.getWriter() : null;
      return await this.pump(proc, container, redirect);
    } catch (err) {
      const msg = String(err).split("\n")[0].replace(/^FileSystemError:\s*/, "");
      this.write(`\x1B[31m${msg}\x1B[0m\r
`);
      return 1;
    }
  }
  /** `> file` / `>> file` sink: write (or append) text in the container FS. */
  async writeContainerFile(container, redirect, data) {
    const base = this.resolveCwd(container);
    const p = redirect.path.startsWith("/") ? redirect.path : `${base}/${redirect.path}`;
    let content = data;
    if (redirect.append) {
      try {
        content = new TextDecoder().decode(await container.fs.readFile(p)) + data;
      } catch {
      }
    } else {
      const dir = p.slice(0, p.lastIndexOf("/")) || "/";
      try {
        await container.fs.mkdir(dir, { recursive: true });
      } catch {
      }
    }
    await container.fs.writeFile(p, content);
  }
  /**
   * Stream a process's output into the terminal, CR-normalized. With a
   * redirect, output is captured into the target file instead and the
   * `(exit N)` line is suppressed (like a real shell).
   */
  async pump(proc, container, redirect) {
    let captured = "";
    if (proc.output) {
      const reader = proc.output.getReader();
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (redirect) {
            captured += value;
          } else {
            this.write(value);
          }
        }
      } catch {
      }
    }
    const code = await proc.exit;
    if (redirect) {
      try {
        await this.writeContainerFile(container, redirect, captured);
      } catch (err) {
        this.write(`\x1B[31mwrite failed: ${String(err).split("\n")[0]}\x1B[0m\r
`);
        return 1;
      }
      return code === 0 ? 0 : code;
    }
    if (code !== 0) {
      this.write(`\x1B[90m(exit ${code})\x1B[0m\r
`);
    }
    return code;
  }
  finishCommand() {
    this.running = false;
    this.current = null;
    this.stdinHintShown = false;
    this.inheritSpawn = false;
    this.acceptUntil = Date.now() + 600;
    this.flushOut();
    if (this.inputWriter) {
      try {
        void this.inputWriter.close();
      } catch {
      }
      this.inputWriter = null;
    }
    try {
      hookFireCount++;
      afterCommandHook?.();
    } catch {
    }
    setTimeout(() => {
      this.flushOut();
      if (this.container) {
        this.prompt();
      }
    }, 160);
  }
  setDimensions(_dimensions) {
  }
  async close() {
    if (this.outSub) {
      try {
        this.outSub();
      } catch {
      }
      this.outSub = null;
    }
    if (this.inputWriter) {
      try {
        await this.inputWriter.close();
      } catch {
      }
      this.inputWriter = null;
    }
    if (this.current) {
      try {
        await this.current.kill();
      } catch {
      }
    }
  }
};
function replWrap(code) {
  return `(function(){const __r=eval(${JSON.stringify(code)});if(__r!==undefined)console.log(__r)})()`;
}
function splitAndSeq(line) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "&" && line[i + 1] === "&") {
      out.push(cur);
      cur = "";
      i++;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function tokenize(line) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (cur || has) {
    out.push(cur);
  }
  return out;
}
function createDevTerminal(context) {
  const config = vscode3.workspace.getConfiguration("webide-dev");
  const runtimeUrl = config.get("runtimeUrl", "/nodine/supervisor.mjs");
  const pty = new NodineTerminal(runtimeUrl);
  const terminal = vscode3.window.createTerminal({
    name: "node (nodine)",
    pty,
    iconPath: new vscode3.ThemeIcon("terminal")
  });
  context.subscriptions.push(terminal);
  terminal.show();
  return terminal;
}
var devTerminal = null;
var devPty = null;
function focusDevTerminal(context) {
  if (devTerminal && devTerminal.exitStatus === void 0) {
    if (devPty) {
      devPty.cd(getProjectCwd() ?? "");
    }
    devTerminal.show();
    return devTerminal;
  }
  const config = vscode3.workspace.getConfiguration("webide-dev");
  const runtimeUrl = config.get("runtimeUrl", "/nodine/supervisor.mjs");
  const pty = new NodineTerminal(runtimeUrl);
  pty.cd(getProjectCwd() ?? "");
  const terminal = vscode3.window.createTerminal({
    name: "node (nodine)",
    pty,
    iconPath: new vscode3.ThemeIcon("terminal")
  });
  devTerminal = terminal;
  devPty = pty;
  context.subscriptions.push(terminal);
  terminal.show();
  return terminal;
}
var NodineProfileProvider = class {
  constructor(runtimeUrl) {
    __publicField(this, "runtimeUrl");
    this.runtimeUrl = runtimeUrl;
  }
  provideTerminalProfile(_token) {
    const pty = new NodineTerminal(this.runtimeUrl);
    pty.cd(getProjectCwd() ?? "");
    return { name: "node (nodine)", options: { pty } };
  }
};

// src/githubImport.ts
var vscode4 = __toESM(require("vscode"));
var IGNORE_SEGMENTS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".github",
  ".vscode",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".idea",
  "out",
  ".parcel-cache",
  "target"
]);
var IGNORE_EXTENSIONS = /* @__PURE__ */ new Set([".log", ".map"]);
var ALWAYS_ALLOW = /* @__PURE__ */ new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
var MAX_FILES = 1e3;
var MAX_FILE_KB_DEFAULT = 512;
function parseRepoInput(input) {
  input = input.trim().replace(/\.git$/, "");
  let ref;
  const hash = input.match(/#([\w./-]+)$/);
  if (hash) {
    ref = hash[1];
    input = input.slice(0, hash.index);
  }
  let m = input.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?/i);
  if (m) {
    return { owner: m[1], repo: m[2], ref: m[3] || ref };
  }
  m = input.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m) {
    return { owner: m[1], repo: m[2], ref };
  }
  return null;
}
function shouldInclude(path) {
  const name = path.split("/").pop() || "";
  if (ALWAYS_ALLOW.has(name)) {
    return true;
  }
  if (path.split("/").some((seg) => IGNORE_SEGMENTS.has(seg))) {
    return false;
  }
  const dot = path.lastIndexOf(".");
  if (dot >= 0 && IGNORE_EXTENSIONS.has(path.slice(dot))) {
    return false;
  }
  return true;
}
async function ghApi(path, token) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 404) {
    throw new Error("repo, ref or path not found (404) \u2014 check the URL" + (token ? "" : " and whether the repo is private (a token is needed for that)"));
  }
  if (res.status === 401) {
    throw new Error("GitHub rejected the token (401).");
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    if (body?.message?.includes("rate limit")) {
      throw new Error("GitHub rate limit exceeded. Provide a PAT (raises it to 5000/hr).");
    }
    throw new Error(String(body?.message || "HTTP 403 (forbidden \u2014 private repo? a token is needed)"));
  }
  if (!res.ok) {
    throw new Error(`GitHub returned HTTP ${res.status}`);
  }
  return res.json();
}
var sessionToken;
async function importFromGithub(inputs, writeFile, ensureDir, reveal) {
  const { repoInput, tokenInput } = inputs;
  const parsed = parseRepoInput(repoInput);
  if (!parsed) {
    vscode4.window.showErrorMessage(`Not a GitHub repository: ${repoInput}`);
    return;
  }
  const { owner, repo, ref } = parsed;
  const token = tokenInput.trim() || sessionToken;
  const maxKb = vscode4.workspace.getConfiguration("webide-dev").get("githubMaxFileKb", MAX_FILE_KB_DEFAULT);
  await vscode4.window.withProgress({
    location: vscode4.ProgressLocation.Notification,
    title: `Importing ${owner}/${repo}${ref ? `#${ref}` : ""}`,
    cancellable: false
  }, async (progress) => {
    try {
      progress.report({ message: "resolving ref\u2026" });
      let sha;
      if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
        sha = ref;
      } else {
        const commit = await ghApi(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref ?? "HEAD")}`, token);
        sha = commit.sha;
      }
      if (tokenInput.trim()) {
        sessionToken = tokenInput.trim();
      }
      progress.report({ message: "listing files\u2026" });
      const tree = await ghApi(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, token);
      if (tree.truncated) {
        vscode4.window.showWarningMessage("Repo tree truncated by GitHub (very large repo) \u2014 importing a subset.");
      }
      const blobs = tree.tree.filter((n) => n.type === "blob" && shouldInclude(n.path) && (n.size ?? 0) <= maxKb * 1024);
      if (blobs.length > MAX_FILES) {
        vscode4.window.showWarningMessage(`Repo has ${blobs.length} importable files \u2014 importing the first ${MAX_FILES} (large-repo cap).`);
      }
      const queue = blobs.slice(0, MAX_FILES);
      const dirs = /* @__PURE__ */ new Set();
      let imported = 0, failed = 0;
      let done = 0;
      const BATCH = 6;
      const workers = Array.from({ length: BATCH }, async () => {
        for (; ; ) {
          const node = queue.shift();
          if (!node) {
            return;
          }
          try {
            const blob = await ghApi(`/repos/${owner}/${repo}/git/blobs/${node.sha}`, token);
            const contents = blob.encoding === "base64" ? base64ToBytes(blob.content) : new TextEncoder().encode(blob.content);
            const dir = node.path.split("/").slice(0, -1).join("/");
            const destDir = dir ? `${owner}-${repo}/${dir}` : `${owner}-${repo}`;
            if (!dirs.has(destDir)) {
              await ensureDir(destDir);
              dirs.add(destDir);
            }
            await writeFile(`${owner}-${repo}/${node.path}`, contents);
            imported++;
          } catch (err) {
            failed++;
            console.warn(`[webide-dev] blob fetch failed for ${node.path}:`, err);
          }
          done++;
          const total = Math.min(blobs.length, MAX_FILES);
          if (done % (total < 50 ? 1 : 10) === 0 || done === total) {
            const pct = total > 0 ? Math.round(done / total * 100) : 100;
            progress.report({ message: `${done}/${total} files \xB7 ${pct}%`, increment: 100 / total });
          }
        }
      });
      await Promise.all(workers);
      await reveal(`${owner}-${repo}`);
      vscode4.window.showInformationMessage(
        `Imported ${imported} files from ${owner}/${repo}` + (failed ? ` \u2014 ${failed} failed` : "") + ". node_modules and build artifacts were skipped."
      );
    } catch (err) {
      vscode4.window.showErrorMessage(`GitHub import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

// src/folderUpload.ts
var vscode5 = __toESM(require("vscode"));
var IGNORE_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".github",
  ".vscode",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".idea",
  ".turbo",
  "out"
]);
var MAX_FILE_KB = 512;
async function countFiles(src, stats) {
  let entries;
  try {
    entries = await vscode5.workspace.fs.readDirectory(src);
  } catch {
    return 0;
  }
  let n = 0;
  for (const [name, type] of entries) {
    if (type === vscode5.FileType.Directory) {
      if (IGNORE_DIRS.has(name)) {
        continue;
      }
      n += await countFiles(vscode5.Uri.joinPath(src, name), stats);
    } else if (type === vscode5.FileType.File) {
      if (name.endsWith(".map") || name === ".DS_Store") {
        continue;
      }
      n++;
    }
  }
  return n;
}
async function copyDir(src, destPath, writeFile, ensureDir, onProgress, stats) {
  let entries;
  try {
    entries = await vscode5.workspace.fs.readDirectory(src);
  } catch {
    return 0;
  }
  await ensureDir(destPath);
  let copied = 0;
  for (const [name, type] of entries) {
    if (type === vscode5.FileType.Directory) {
      if (IGNORE_DIRS.has(name)) {
        continue;
      }
      copied += await copyDir(vscode5.Uri.joinPath(src, name), `${destPath}/${name}`, writeFile, ensureDir, onProgress, stats);
    } else if (type === vscode5.FileType.File) {
      if (name.endsWith(".map") || name === ".DS_Store") {
        continue;
      }
      try {
        const stat = await vscode5.workspace.fs.stat(vscode5.Uri.joinPath(src, name));
        if (stat.size > MAX_FILE_KB * 1024) {
          stats.skipped++;
          continue;
        }
        const bytes = await vscode5.workspace.fs.readFile(vscode5.Uri.joinPath(src, name));
        await writeFile(`${destPath}/${name}`, bytes);
        copied++;
        stats.copied++;
        if (stats.copied % (stats.copied < 50 ? 1 : 10) === 0) {
          onProgress(0, `${stats.copied} files copied${stats.skipped ? ` \xB7 ${stats.skipped} skipped` : ""}`);
        }
      } catch (err) {
        stats.skipped++;
        console.warn(`[webide-dev] upload: failed to read ${name}:`, err);
      }
    }
  }
  return copied;
}
async function uploadFolder(writeFile, ensureDir, reveal, prepareRuntime) {
  const picked = await vscode5.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Upload Folder",
    title: "Choose a local folder to upload into the dev environment"
  });
  console.log("[webide-dev] upload: picker returned", picked?.map((u) => u.toString()));
  if (!picked || picked.length === 0) {
    return;
  }
  const root = picked[0];
  const folderName = root.path.split("/").filter(Boolean).pop() || "uploaded-folder";
  await vscode5.window.withProgress({
    location: vscode5.ProgressLocation.Notification,
    title: `Uploading ${folderName}`,
    cancellable: false
  }, async (progress) => {
    try {
      progress.report({ message: "booting dev environment\u2026" });
      await prepareRuntime();
      progress.report({ message: "scanning files\u2026" });
      const stats = { copied: 0, skipped: 0 };
      const total = await countFiles(root, stats);
      if (total === 0) {
        vscode5.window.showWarningMessage(`No uploadable files found in ${folderName} (node_modules and build artifacts are skipped).`);
        return;
      }
      progress.report({ message: `copying ${total} files\u2026`, increment: 0 });
      const copied = await copyDir(
        root,
        folderName,
        writeFile,
        ensureDir,
        (_inc, message) => progress.report({ message }),
        stats
      );
      if (copied === 0) {
        vscode5.window.showWarningMessage(`No files uploaded from ${folderName} (empty, or all filtered by ignore rules).`);
        return;
      }
      progress.report({ message: "preparing workspace\u2026", increment: 100 });
      await reveal(folderName);
      const skippedNote = stats.skipped ? ` (${stats.skipped} skipped \u2014 ignored dirs or >${MAX_FILE_KB} KB)` : "";
      vscode5.window.showInformationMessage(`Uploaded ${copied} of ${total} files from ${folderName}${skippedNote} \u2014 dev terminal is booting at /${folderName}.`);
    } catch (err) {
      vscode5.window.showErrorMessage(`Folder upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// src/extensionMain.ts
var RunOnceTerminal = class {
  constructor(container, relPath) {
    __publicField(this, "container", container);
    __publicField(this, "relPath", relPath);
    __publicField(this, "writeEmitter", new vscode6.EventEmitter());
    __publicField(this, "onDidWrite", this.writeEmitter.event);
    __publicField(this, "closeEmitter", new vscode6.EventEmitter());
    __publicField(this, "onDidClose", this.closeEmitter.event);
  }
  async open() {
    try {
      const proc = await this.container.spawn("node", [this.relPath], {
        cwd: this.container.workdir,
        env: this.container.baseEnv
      });
      if (proc.output) {
        const reader = proc.output.getReader();
        (async () => {
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            this.writeEmitter.fire(value);
          }
        })();
      }
      const code = await proc.exit;
      this.writeEmitter.fire(`\r
\x1B[90mexited with code ${code}\x1B[0m\r
`);
    } catch (err) {
      this.writeEmitter.fire(`\r
\x1B[31m${err}\x1B[0m\r
`);
    }
    this.closeEmitter.fire(0);
  }
  handleInput() {
  }
  close() {
  }
};
var projectCwd = null;
function setProjectCwd(p) {
  projectCwd = p;
}
function getProjectCwd() {
  return projectCwd;
}
async function activate(_context) {
  const syncNoProject = () => {
    const loaded = vscode6.workspace.workspaceFolders?.some((f) => f.uri.scheme === "nodine") ?? false;
    vscode6.commands.executeCommand("setContext", "webide-dev.noProject", !loaded);
  };
  syncNoProject();
  _context.subscriptions.push(vscode6.workspace.onDidChangeWorkspaceFolders(syncNoProject));
  const tree = vscode6.window.createTreeView("webide-dev.welcome", {
    treeDataProvider: {
      getChildren: () => [],
      getTreeItem: () => ({ label: "" })
    }
  });
  _context.subscriptions.push(tree);
  tree.description = "Upload \xB7 Import \xB7 Terminal";
  setTimeout(() => {
    vscode6.commands.executeCommand("webide-dev.welcome.focus").then(() => void 0, () => void 0);
  }, 1500);
  const config = vscode6.workspace.getConfiguration("webide-dev");
  const runtimeUrl = config.get("runtimeUrl", "/nodine/supervisor.mjs");
  let readyPromise = null;
  const ensureRuntime = () => {
    if (!readyPromise) {
      readyPromise = (async () => {
        if (!isCrossOriginIsolated()) {
          vscode6.window.showErrorMessage(
            "Dev environment needs a cross-origin isolated host: the server must send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless headers."
          );
          return null;
        }
        try {
          return await bootContainer(runtimeUrl);
        } catch (err) {
          console.error("[webide-dev] runtime boot failed:", err);
          readyPromise = null;
          vscode6.window.showErrorMessage(`Dev environment boot failed: ${err instanceof Error ? err.message : err}`);
          return null;
        }
      })();
    }
    return readyPromise;
  };
  const runtimeReady = ensureRuntime();
  const provider = new NodineFileSystemProvider(async () => {
    await runtimeReady;
    return getContainer();
  });
  let providerRegistered = false;
  _context.subscriptions.push(vscode6.workspace.registerFileSystemProvider("nodine", provider, { isCaseSensitive: true }));
  providerRegistered = true;
  runtimeReady.then(() => {
    provider.fireExternalChange(vscode6.FileChangeType.Created, "/.nodine-sync");
  }).catch(() => {
  });
  setAfterCommandHook(() => {
    provider.fireExternalChange(vscode6.FileChangeType.Created, "/.nodine-sync");
  });
  const getFs = async () => {
    const container = await ensureRuntime();
    if (!container) {
      return null;
    }
    const fire = (type, p) => provider.fireExternalChange(type, `/${p}`);
    return {
      // p is a project-relative path ("<folderName>/src/a.js"); write it
      // at the container root: /<folderName>/src/a.js
      writeFile: async (p, contents) => {
        const dir = p.split("/").slice(0, -1).join("/");
        if (dir) {
          try {
            await container.fs.mkdir(`/${dir}`, { recursive: true });
            fire(vscode6.FileChangeType.Created, dir);
          } catch {
          }
        }
        await container.fs.writeFile(`/${p}`, contents);
        fire(vscode6.FileChangeType.Changed, p);
        fire(vscode6.FileChangeType.Changed, dir);
      },
      ensureDir: async (p) => {
        try {
          await container.fs.mkdir(`/${p}`, { recursive: true });
          fire(vscode6.FileChangeType.Created, p);
        } catch {
        }
      }
    };
  };
  const requireFs = async () => {
    const fs = await getFs();
    if (!fs) {
      throw new Error("Dev environment is not running (needs cross-origin isolated host with the nodine runtime).");
    }
    return fs;
  };
  const simulateUpload = async (folderName) => {
    const fs = await getFs();
    if (!fs) {
      return "no-runtime";
    }
    await fs.ensureDir(folderName);
    await fs.writeFile(`${folderName}/package.json`, new TextEncoder().encode(
      JSON.stringify({ name: folderName, version: "1.0.0", scripts: { start: "node index.js" } }, null, 2)
    ));
    await fs.writeFile(`${folderName}/index.js`, new TextEncoder().encode('console.log("hello from ' + folderName + '");\n'));
    await projectReady(folderName);
    return "ok";
  };
  vscode6.commands.registerCommand("webide-dev._simulateUpload", simulateUpload);
  globalThis.__webideDevTest = {
    simulateUpload,
    provider,
    state: async () => ({
      activated: true,
      providerRegistered,
      watchCalls: provider.watchCalls,
      hookFired: getHookFireCount(),
      activationEvents: vscode6.extensions.getExtension("amplytic.webide-dev")?.packageJSON?.activationEvents ?? null,
      folders: (vscode6.workspace.workspaceFolders ?? []).map((f) => ({ uri: f.uri.toString(), name: f.name })),
      readdirViaFs: await (async () => {
        try {
          const ents = await vscode6.workspace.fs.readDirectory(nodineRoot());
          return ents.map(([n, t]) => n + (t === vscode6.FileType.Directory ? "/" : "")).join(",");
        } catch (e) {
          return "ERR:" + String(e).slice(0, 90);
        }
      })(),
      readdirRoot: await (async () => {
        try {
          const c = await ensureRuntime();
          return c ? (await c.fs.readdir("/")).join(",") : "no-container";
        } catch (e) {
          return "err:" + String(e).slice(0, 80);
        }
      })()
    })
  };
  const openNodineWorkspaceOnce = async () => {
    const existing = vscode6.workspace.workspaceFolders?.find((f) => f.uri.scheme === "nodine");
    if (existing) {
      return;
    }
    await openNodineWorkspace();
  };
  const seedExplorerSettings = async () => {
    const settingsUri = vscode6.Uri.joinPath(nodineRoot(), ".vscode/settings.json");
    try {
      await vscode6.workspace.fs.readFile(settingsUri);
      return;
    } catch {
    }
    const payload = JSON.stringify({
      "files.exclude": {
        "bin": true,
        "home": true,
        "project": true,
        "root": true,
        "tmp": true,
        "usr": true,
        ".vscode": true
      },
      // the + button must create a Nodine terminal DIRECTLY (no profile
      // picker). Provider-written workspace settings DO apply (this same
      // files.exclude hides the runtime's system dirs) — the config-
      // service route produced a null workspace override instead.
      "terminal.integrated.defaultProfile.linux": "Nodine (Node.js)",
      "terminal.integrated.defaultProfile.osx": "Nodine (Node.js)",
      "terminal.integrated.defaultProfile.windows": "Nodine (Node.js)"
    }, null, 2);
    await vscode6.workspace.fs.writeFile(settingsUri, new TextEncoder().encode(payload + "\n"));
  };
  const reveal = async (_folderName) => {
    await vscode6.commands.executeCommand("revealInExplorer", nodineRoot());
    provider.fireExternalChange(vscode6.FileChangeType.Created, "/.nodine-sync");
    vscode6.commands.executeCommand("workbench.view.explorer");
  };
  const collectGithubInputs = async () => {
    const repoInput = await vscode6.window.showInputBox({
      prompt: "GitHub repository \u2014 paste the URL or owner/repo",
      placeHolder: "https://github.com/owner/repo (add #branch for a specific branch)",
      ignoreFocusOut: true
    });
    if (!repoInput) {
      return null;
    }
    const tokenInput = await vscode6.window.showInputBox({
      prompt: "GitHub PAT \u2014 optional for public repos, required for private repos",
      placeHolder: "github_pat_\u2026 or ghp_\u2026 (kept for this session only, empty for public)",
      password: true,
      ignoreFocusOut: true
    });
    if (tokenInput === void 0) {
      return null;
    }
    return { repoInput, tokenInput };
  };
  const projectReady = async (folderName) => {
    setProjectCwd(`/${folderName}`);
    await openNodineWorkspaceOnce();
    await focusDevTerminal(_context);
    await reveal(folderName);
  };
  runtimeReady.then(async (container) => {
    if (!container) {
      return;
    }
    try {
      await openNodineWorkspaceOnce();
      syncNoProject();
      await seedExplorerSettings();
      const termCfg = vscode6.workspace.getConfiguration("terminal.integrated");
      void Promise.allSettled([
        termCfg.update("defaultProfile.linux", void 0, vscode6.ConfigurationTarget.Workspace),
        termCfg.update("defaultProfile.osx", void 0, vscode6.ConfigurationTarget.Workspace),
        termCfg.update("defaultProfile.windows", void 0, vscode6.ConfigurationTarget.Workspace)
      ]).then(() => {
        void Promise.allSettled([
          termCfg.update("defaultProfile.linux", "Nodine (Node.js)", vscode6.ConfigurationTarget.Global),
          termCfg.update("defaultProfile.osx", "Nodine (Node.js)", vscode6.ConfigurationTarget.Global),
          termCfg.update("defaultProfile.windows", "Nodine (Node.js)", vscode6.ConfigurationTarget.Global)
        ]);
      });
      await focusDevTerminal(_context);
      const bornAt = /* @__PURE__ */ new WeakMap();
      _context.subscriptions.push(vscode6.window.onDidOpenTerminal((t) => bornAt.set(t, Date.now())));
      _context.subscriptions.push(vscode6.window.onDidCloseTerminal((t) => {
        if (vscode6.window.terminals.length > 0) {
          return;
        }
        if (Date.now() - (bornAt.get(t) ?? 0) < 3e3) {
          return;
        }
        setTimeout(() => {
          if (vscode6.window.terminals.length === 0) {
            createDevTerminal(_context);
          }
        }, 500);
      }));
    } catch (err) {
      console.error("[webide-dev] auto workspace/terminal failed:", err);
    }
  });
  _context.subscriptions.push(
    vscode6.commands.registerCommand("webide-dev.createTerminal", () => {
      createDevTerminal(_context);
    }),
    // Terminal-profile entry point: invoked by the workbench whenever a
    // DEFAULT terminal is created (the + button, Ctrl+`, menu) because
    // this profile is the only shell in the static web build — no local
    // process support exists. Creates a FRESH terminal every time so
    // multiple terminals work (the pty instances share one container,
    // like bolt.diy's terminals share one WebContainer).
    vscode6.commands.registerCommand("webide-dev.createNodineTerminal", () => {
      return createDevTerminal(_context);
    }),
    // The profile PROVIDER: without this registration the manifest's
    // terminal profile shows in the picker but cannot create terminals.
    // The workbench creates default terminals from the returned profile
    // (which carries our nodine-backed pty).
    vscode6.window.registerTerminalProfileProvider("webide-dev.nodine", new NodineProfileProvider(runtimeUrl)),
    vscode6.commands.registerCommand("webide-dev.importGithub", async () => {
      const inputs = await collectGithubInputs();
      if (!inputs) {
        return;
      }
      const fs = await getFs();
      if (!fs) {
        vscode6.window.showErrorMessage("Dev environment is not running (needs cross-origin isolated host with the nodine runtime).");
        return;
      }
      await importFromGithub(inputs, fs.writeFile, fs.ensureDir, projectReady);
    }),
    vscode6.commands.registerCommand("webide-dev.uploadFolder", async () => {
      await uploadFolder(
        async (p, c) => (await requireFs()).writeFile(p, c),
        async (p) => (await requireFs()).ensureDir(p),
        projectReady,
        async () => {
          await requireFs();
        }
      );
    }),
    vscode6.commands.registerCommand("webide-dev.runFile", async (uri) => {
      const target = uri ?? vscode6.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== "nodine") {
        vscode6.window.showErrorMessage("Open a file from the nodine workspace to run it.");
        return;
      }
      const container = getContainer();
      if (!container) {
        return;
      }
      const rel = target.path.replace(/^\/+/, "");
      const terminal = vscode6.window.createTerminal({ name: `node ${rel}`, pty: new RunOnceTerminal(container, rel) });
      _context.subscriptions.push(terminal);
      terminal.show();
    }),
    vscode6.commands.registerCommand("webide-dev.previewPort", async () => {
      const container = getContainer();
      if (!container) {
        return;
      }
      const portStr = await vscode6.window.showInputBox({ prompt: "Port number", placeHolder: "3000" });
      const port = Number(portStr);
      if (!Number.isFinite(port)) {
        return;
      }
      const url = container.previewUrl(port);
      await vscode6.env.openExternal(vscode6.Uri.parse(url));
    })
  );
}
//# sourceMappingURL=extensionMain.js.map
