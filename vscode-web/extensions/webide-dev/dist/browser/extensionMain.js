"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// ../../../tmp/web-ide/vscode/extensions/webide-dev/src/extensionMain.ts
var extensionMain_exports = {};
__export(extensionMain_exports, {
  activate: () => activate,
  getProjectCwd: () => getProjectCwd,
  projectCwd: () => projectCwd,
  setProjectCwd: () => setProjectCwd
});
module.exports = __toCommonJS(extensionMain_exports);
var vscode6 = __toESM(require("vscode"));

// ../../../tmp/web-ide/vscode/extensions/webide-dev/src/nodine.ts
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

// ../../../tmp/web-ide/vscode/extensions/webide-dev/src/fsProvider.ts
var vscode2 = __toESM(require("vscode"));
var SCHEME = "nodine";
var NodineFileSystemProvider = class {
  constructor(container) {
    this.container = container;
  }
  toContainerPath(uri) {
    const rel = uri.path.replace(/^\/+/, "");
    return rel ? `/${rel}` : "/";
  }
  stat(uri) {
    return this._stat(this.toContainerPath(uri));
  }
  async _stat(p) {
    try {
      await this.container.fs.readdir(p);
      return { type: vscode2.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0 };
    } catch {
      try {
        const data = await this.container.fs.readFile(p);
        return { type: vscode2.FileType.File, ctime: 0, mtime: Date.now(), size: data.length };
      } catch {
        throw vscode2.FileSystemError.FileNotFound(p);
      }
    }
  }
  readDirectory(uri) {
    return (async () => {
      const p = this.toContainerPath(uri);
      try {
        const raw = await this.container.fs.readdir(p, { withFileTypes: true });
        const out = [];
        for (const e of raw) {
          const name = typeof e === "string" ? e : e.name ?? String(e);
          const isDir = typeof e === "object" && (e.isDirectory ?? (e.type ?? 2) === 2);
          out.push([name, isDir ? vscode2.FileType.Directory : vscode2.FileType.File]);
        }
        if (out.length > 0 && out.every(([, t]) => t === vscode2.FileType.File) && out.some(([n]) => !n.includes("."))) {
          const detailed = [];
          for (const [name] of out) {
            try {
              await this.container.fs.readdir(`${p}/${name}`);
              detailed.push([name, vscode2.FileType.Directory]);
            } catch {
              detailed.push([name, vscode2.FileType.File]);
            }
          }
          return detailed;
        }
        return out;
      } catch (err) {
        throw vscode2.FileSystemError.FileNotFound(uri);
      }
    })();
  }
  readFile(uri) {
    return this.container.fs.readFile(this.toContainerPath(uri)).catch(() => {
      throw vscode2.FileSystemError.FileNotFound(uri);
    });
  }
  writeFile(uri, content, options) {
    const p = this.toContainerPath(uri);
    return (async () => {
      if (!options.overwrite) {
        try {
          await this.container.fs.readFile(p);
          if (!options.overwrite) {
            throw vscode2.FileSystemError.FileExists(uri);
          }
        } catch (e) {
          if (e instanceof vscode2.FileSystemError && e.code === "FileExists") {
            throw e;
          }
        }
      }
      await this.container.fs.writeFile(p, content);
      this._fireDidChange(uri);
    })();
  }
  /** VS Code FileSystemProvider API: create a directory. */
  createDirectory(uri) {
    const p = this.toContainerPath(uri);
    return (async () => {
      await this.container.fs.mkdir(p, { recursive: true });
      this._fireFileCreated(uri);
    })();
  }
  async exists(p) {
    try {
      await this.container.fs.readdir(p);
      return true;
    } catch {
      try {
        await this.container.fs.readFile(p);
        return true;
      } catch {
        return false;
      }
    }
  }
  delete(uri, options) {
    const p = this.toContainerPath(uri);
    return (async () => {
      if (!await this.exists(p)) {
        throw vscode2.FileSystemError.FileNotFound(uri);
      }
      await this.container.fs.rm(p, { recursive: options.recursive, force: true });
      this._fireFileDeleted(uri);
    })();
  }
  rename(oldUri, newUri, options) {
    return (async () => {
      const from = this.toContainerPath(oldUri);
      const to = this.toContainerPath(newUri);
      if (!options.overwrite && await this.exists(to)) {
        throw vscode2.FileSystemError.FileExists(newUri);
      }
      await this.container.fs.rename(from, to);
      this._fireFileDeleted(oldUri);
      this._fireFileCreated(newUri);
    })();
  }
  watch(uri) {
    const p = this.toContainerPath(uri);
    let watcher;
    try {
      watcher = this.container.fs.watch(p, (_event, filename) => {
        const rel = filename.startsWith("/") ? filename : `/${filename}`;
        this._fireDidChange(vscode2.Uri.joinPath(uri, rel.replace(/^\/+/, "")));
      });
    } catch {
    }
    return new vscode2.Disposable(() => watcher?.close());
  }
  // change events
  _onDidChangeFile = new vscode2.EventEmitter();
  onDidChangeFile = this._onDidChangeFile.event;
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
  const folderUri = vscode2.Uri.parse(`${SCHEME}:/`);
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

// ../../../tmp/web-ide/vscode/extensions/webide-dev/src/terminal.ts
var vscode3 = __toESM(require("vscode"));
var NodineTerminal = class {
  constructor(runtimeUrl) {
    this.runtimeUrl = runtimeUrl;
  }
  writeEmitter = new vscode3.EventEmitter();
  onDidWrite = this.writeEmitter.event;
  closeEmitter = new vscode3.EventEmitter();
  onDidClose = this.closeEmitter.event;
  container = null;
  current = null;
  inputWriter = null;
  buffer = "";
  running = false;
  /** cwd for spawned commands — the project folder once one is uploaded. */
  cwd = null;
  /** Point the shell at a project folder (e.g. "/my-app"). */
  cd(path) {
    this.cwd = path;
    this.writeEmitter.fire(`\x1B[90mcd ${path}\x1B[0m\r
`);
    this.prompt();
  }
  /** Absolute directory commands run in: project folder if set, else workdir. */
  resolveCwd(container) {
    return this.cwd ?? container.workdir;
  }
  async open(_initialDimensions) {
    this.writeEmitter.fire("Booting dev environment (nodine: real Node.js in your browser)\u2026\r\n");
    try {
      this.container = await bootContainer(this.runtimeUrl);
      console.log("[webide-dev] terminal: container ready");
    } catch (err) {
      console.error("[webide-dev] runtime boot failed:", err);
      this.writeEmitter.fire(`\x1B[31mFailed to boot runtime: ${err}\x1B[0m\r
`);
      this.writeEmitter.fire("The host must send COOP: same-origin + COEP: credentialless headers.\r\n");
      this.closeEmitter.fire(1);
      return;
    }
    const version = await this.nodeVersion();
    console.log("[webide-dev] terminal: node version =", version);
    this.writeEmitter.fire(`\x1B[32mready\x1B[0m \u2014 Node.js ${version} dev environment in ${this.resolveCwd(this.container)}\r
`);
    this.writeEmitter.fire("Line-based shell: type JS to evaluate, or run `npm <cmd>`, `node <file>`.\r\n\r\n");
    this.prompt();
  }
  nodeVersionCache = null;
  async nodeVersion() {
    if (this.nodeVersionCache) {
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
        this.nodeVersionCache = "(probe timed out)";
      } else {
        this.nodeVersionCache = out.trim() || "(no output)";
      }
      console.log("[webide-dev] nodeVersion probe:", JSON.stringify(this.nodeVersionCache), "code:", code);
    } catch (err) {
      console.error("[webide-dev] nodeVersion probe failed:", err);
      this.nodeVersionCache = "(unknown)";
    }
    return this.nodeVersionCache;
  }
  prompt() {
    const where = this.cwd ?? (this.container ? this.resolveCwd(this.container) : "");
    this.writeEmitter.fire(`\x1B[36m${where || "node"}>\x1B[0m `);
  }
  /** `cd <dir>` builtin: resolve relative to the current cwd and switch. */
  changeDir(arg) {
    if (!this.container) {
      return;
    }
    const base = this.resolveCwd(this.container);
    if (!arg || arg === "~") {
      this.cwd = this.container.workdir;
    } else if (arg.startsWith("/")) {
      this.cwd = arg.replace(/\/+$/, "") || "/";
    } else {
      this.cwd = `${base}/${arg}`.replace(/\/+$/, "");
    }
    this.prompt();
  }
  handleInput(data) {
    if (!this.container) {
      return;
    }
    if (this.running && this.inputWriter) {
      void this.inputWriter.write(data.replace(/\r/g, "\n"));
      return;
    }
    for (const ch of data) {
      if (ch === "\r") {
        const line = this.buffer;
        this.buffer = "";
        this.writeEmitter.fire("\r\n");
        void this.runLine(line);
        return;
      } else if (ch === "\x7F") {
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          this.writeEmitter.fire("\b \b");
        }
      } else if (ch === "") {
        this.buffer = "";
        this.writeEmitter.fire("^C\r\n");
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
    const argv = tokenize(line);
    if (argv.length === 0) {
      this.prompt();
      return;
    }
    if (argv[0] === "clear") {
      this.writeEmitter.fire("\x1B[2J\x1B[H");
      this.prompt();
      return;
    }
    if (argv[0] === "cd") {
      this.changeDir(argv[1]);
      return;
    }
    if (argv[0] === "pwd") {
      this.writeEmitter.fire(`${this.resolveCwd(container)}\r
`);
      this.prompt();
      return;
    }
    if (argv[0] === "exit") {
      this.closeEmitter.fire(0);
      return;
    }
    this.running = true;
    try {
      let proc;
      const evalCode = (code2) => `(function(){const __r=eval(${JSON.stringify(code2)});if(__r!==undefined)console.log(__r)})()`;
      if (argv[0] === "node") {
        if (argv.length > 1 && !argv[1].startsWith("-")) {
          proc = await container.spawn("node", argv.slice(1), {
            cwd: this.resolveCwd(container),
            env: { ...container.baseEnv }
          });
        } else {
          const code2 = argv.slice(1).join(" ");
          if (!code2) {
            this.prompt();
            this.running = false;
            return;
          }
          proc = await container.spawn("node", ["-e", evalCode(code2)], {
            cwd: this.resolveCwd(container),
            env: { ...container.baseEnv }
          });
        }
      } else if (argv[0] === "npm" || argv[0] === "npx") {
        proc = await container.spawn(argv[0], argv.slice(1), {
          cwd: this.resolveCwd(container),
          env: { ...container.baseEnv, npm_config_progress: "false", npm_config_loglevel: "info" }
        });
      } else if (argv[0] === "ls" || argv[0] === "cat" || argv[0] === "pwd" || argv[0] === "mkdir" || argv[0] === "grep" || argv[0] === "wc" || argv[0] === "head" || argv[0] === "sh") {
        proc = await container.spawn(argv[0], argv.slice(1), {
          cwd: this.resolveCwd(container),
          env: { ...container.baseEnv }
        });
      } else {
        proc = await container.spawn("node", ["-e", evalCode(line)], {
          cwd: this.resolveCwd(container),
          env: { ...container.baseEnv }
        });
      }
      this.current = proc;
      this.inputWriter = proc.input ? proc.input.getWriter() : null;
      if (proc.output) {
        const reader = proc.output.getReader();
        try {
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            this.writeEmitter.fire(value);
          }
        } catch {
        }
      }
      const code = await proc.exit;
      if (code !== 0) {
        this.writeEmitter.fire(`\x1B[90m(exit ${code})\x1B[0m\r
`);
      }
    } catch (err) {
      this.writeEmitter.fire(`\x1B[31m${err}\x1B[0m\r
`);
    } finally {
      this.running = false;
      this.current = null;
      if (this.inputWriter) {
        try {
          await this.inputWriter.close();
        } catch {
        }
        this.inputWriter = null;
      }
      this.prompt();
    }
  }
  setDimensions(_dimensions) {
  }
  async close() {
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
  runtimeUrl;
  constructor(runtimeUrl) {
    this.runtimeUrl = runtimeUrl;
  }
  provideTerminalProfile(_token) {
    const pty = new NodineTerminal(this.runtimeUrl);
    pty.cd(getProjectCwd() ?? "");
    return { name: "node (nodine)", options: { pty } };
  }
};

// ../../../tmp/web-ide/vscode/extensions/webide-dev/src/githubImport.ts
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
            if (dir && !dirs.has(dir)) {
              await ensureDir(dir);
              dirs.add(dir);
            }
            await writeFile(node.path, contents);
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

// ../../../tmp/web-ide/vscode/extensions/webide-dev/src/folderUpload.ts
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

// ../../../tmp/web-ide/vscode/extensions/webide-dev/src/extensionMain.ts
var RunOnceTerminal = class {
  constructor(container, relPath) {
    this.container = container;
    this.relPath = relPath;
  }
  writeEmitter = new vscode6.EventEmitter();
  onDidWrite = this.writeEmitter.event;
  closeEmitter = new vscode6.EventEmitter();
  onDidClose = this.closeEmitter.event;
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
          const container = await bootContainer(runtimeUrl);
          const provider = new NodineFileSystemProvider(container);
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
          globalThis.__webideDevTest = { simulateUpload };
          _context.subscriptions.push(vscode6.workspace.registerFileSystemProvider("nodine", provider, { isCaseSensitive: true }));
          return container;
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
  const openNodineWorkspaceOnce = async () => {
    const existing = vscode6.workspace.workspaceFolders?.find((f) => f.uri.scheme === "nodine");
    if (existing) {
      return;
    }
    await openNodineWorkspace(await ensureRuntime());
  };
  openNodineWorkspaceOnce().then(() => {
    const setDefaultProfile = (target) => Promise.allSettled([
      vscode6.workspace.getConfiguration("terminal.integrated").update("defaultProfile.linux", "Nodine (Node.js)", target),
      vscode6.workspace.getConfiguration("terminal.integrated").update("defaultProfile.osx", "Nodine (Node.js)", target)
    ]);
    void setDefaultProfile(vscode6.ConfigurationTarget.Workspace).then((results) => {
      const failed = results.some((r) => r.status === "rejected");
      if (failed) {
        void setDefaultProfile(vscode6.ConfigurationTarget.Global);
      }
    });
  });
  const getFs = async () => {
    const container = await ensureRuntime();
    if (!container) {
      return null;
    }
    return {
      // p is a project-relative path ("<folderName>/src/a.js"); write it
      // at the container root: /<folderName>/src/a.js
      writeFile: async (p, contents) => {
        const dir = p.split("/").slice(0, -1).join("/");
        if (dir) {
          await container.fs.mkdir(`/${dir}`, { recursive: true }).catch(() => {
          });
        }
        await container.fs.writeFile(`/${p}`, contents);
      },
      ensureDir: async (p) => {
        await container.fs.mkdir(`/${p}`, { recursive: true }).catch(() => {
        });
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
  const reveal = async (_folderName) => {
    await vscode6.commands.executeCommand("revealInExplorer", vscode6.Uri.parse("nodine:/"));
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
  _context.subscriptions.push(
    vscode6.commands.registerCommand("webide-dev.createTerminal", () => {
      createDevTerminal(_context);
    }),
    // Terminal-profile entry point: invoked by the workbench whenever a
    // DEFAULT terminal is created (the + button, Ctrl+`, menu) because
    // this profile is the only shell in the static web build — no local
    // process support exists. Falls through to the same nodine-backed
    // pseudoterminal the "Create Dev Terminal" command uses.
    vscode6.commands.registerCommand("webide-dev.createNodineTerminal", () => {
      return focusDevTerminal(_context);
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
