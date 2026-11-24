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

// src/extensionMain.ts
var extensionMain_exports = {};
__export(extensionMain_exports, {
  activate: () => activate
});
module.exports = __toCommonJS(extensionMain_exports);
var vscode5 = __toESM(require("vscode"));

// src/nodine.ts
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
      let sdkUrl;
      if (typeof document !== "undefined") {
        sdkUrl = new URL("./sdk.mjs", new URL(runtimeUrl, document.baseURI)).href;
      } else {
        const abs = new URL(runtimeUrl, self.location.origin).href;
        sdkUrl = new URL("./sdk.mjs", abs).href;
      }
      const mod = await import(
        /* @vite-ignore */
        sdkUrl
      );
      const container = await mod.Container.boot({ runtimeUrl, coep: "credentialless", workdirName });
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
var vscode = __toESM(require("vscode"));
var SCHEME = "nodine";
var NodineFileSystemProvider = class {
  constructor(container) {
    this.container = container;
    this.root = container.workdir;
  }
  container;
  root;
  toContainerPath(uri) {
    const rel = uri.path.replace(/^\/+/, "");
    return rel ? `${this.root}/${rel}` : this.root;
  }
  stat(uri) {
    return this._stat(this.toContainerPath(uri));
  }
  async _stat(p) {
    try {
      await this.container.fs.readdir(p);
      return { type: vscode.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0 };
    } catch {
      try {
        const data = await this.container.fs.readFile(p);
        return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: data.length };
      } catch {
        throw vscode.FileSystemError.FileNotFound(p);
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
          out.push([name, isDir ? vscode.FileType.Directory : vscode.FileType.File]);
        }
        if (out.length > 0 && out.every(([, t]) => t === vscode.FileType.File) && out.some(([n]) => !n.includes("."))) {
          const detailed = [];
          for (const [name] of out) {
            try {
              await this.container.fs.readdir(`${p}/${name}`);
              detailed.push([name, vscode.FileType.Directory]);
            } catch {
              detailed.push([name, vscode.FileType.File]);
            }
          }
          return detailed;
        }
        return out;
      } catch (err) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
    })();
  }
  readFile(uri) {
    return this.container.fs.readFile(this.toContainerPath(uri)).catch(() => {
      throw vscode.FileSystemError.FileNotFound(uri);
    });
  }
  writeFile(uri, content, options) {
    const p = this.toContainerPath(uri);
    return (async () => {
      if (!options.overwrite) {
        try {
          await this.container.fs.readFile(p);
          if (!options.overwrite) {
            throw vscode.FileSystemError.FileExists(uri);
          }
        } catch (e) {
          if (e instanceof vscode.FileSystemError && e.code === "FileExists") {
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
        throw vscode.FileSystemError.FileNotFound(uri);
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
        throw vscode.FileSystemError.FileExists(newUri);
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
        const rel = filename.startsWith(this.root) ? filename.slice(this.root.length) : `/${filename}`;
        this._fireDidChange(vscode.Uri.joinPath(uri, rel.replace(/^\/+/, "")));
      });
    } catch {
    }
    return new vscode.Disposable(() => watcher?.close());
  }
  // change events
  _onDidChangeFile = new vscode.EventEmitter();
  onDidChangeFile = this._onDidChangeFile.event;
  _fireDidChange(uri) {
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
  _fireFileCreated(uri) {
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }
  _fireFileDeleted(uri) {
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }
  get scheme() {
    return SCHEME;
  }
};
async function openNodineWorkspace(_container) {
  const folderUri = vscode.Uri.parse(`${SCHEME}:/`);
  const existing = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
  if (!existing) {
    if (vscode.workspace.workspaceFolders?.length) {
      vscode.workspace.updateWorkspaceFolders(1, 0, { uri: folderUri, name: "project (nodine)" });
    } else {
      vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, { uri: folderUri, name: "project (nodine)" });
    }
  }
}

// src/terminal.ts
var vscode2 = __toESM(require("vscode"));
var NodineTerminal = class {
  constructor(runtimeUrl) {
    this.runtimeUrl = runtimeUrl;
  }
  runtimeUrl;
  writeEmitter = new vscode2.EventEmitter();
  onDidWrite = this.writeEmitter.event;
  closeEmitter = new vscode2.EventEmitter();
  onDidClose = this.closeEmitter.event;
  container = null;
  current = null;
  inputWriter = null;
  buffer = "";
  running = false;
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
    this.writeEmitter.fire(`\x1B[32mready\x1B[0m \u2014 Node.js ${version} dev environment in ${this.container.workdir}\r
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
    this.writeEmitter.fire(`\x1B[36mnode>\x1B[0m `);
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
            cwd: container.workdir,
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
            cwd: container.workdir,
            env: { ...container.baseEnv }
          });
        }
      } else if (argv[0] === "npm" || argv[0] === "npx") {
        proc = await container.spawn(argv[0], argv.slice(1), {
          cwd: container.workdir,
          env: { ...container.baseEnv, npm_config_progress: "false", npm_config_loglevel: "info" }
        });
      } else if (argv[0] === "ls" || argv[0] === "cat" || argv[0] === "pwd" || argv[0] === "mkdir" || argv[0] === "grep" || argv[0] === "wc" || argv[0] === "head" || argv[0] === "sh") {
        proc = await container.spawn(argv[0], argv.slice(1), {
          cwd: container.workdir,
          env: { ...container.baseEnv }
        });
      } else {
        proc = await container.spawn("node", ["-e", evalCode(line)], {
          cwd: container.workdir,
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
  const config = vscode2.workspace.getConfiguration("webide-dev");
  const runtimeUrl = config.get("runtimeUrl", "/nodine/supervisor.mjs");
  const pty = new NodineTerminal(runtimeUrl);
  const terminal = vscode2.window.createTerminal({
    name: "node (nodine)",
    pty,
    iconPath: new vscode2.ThemeIcon("terminal")
  });
  context.subscriptions.push(terminal);
  terminal.show();
  return terminal;
}

// src/githubImport.ts
var vscode3 = __toESM(require("vscode"));
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
  "out",
  ".parcel-cache"
]);
var MAX_CONCURRENT = 6;
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
async function ghApi(path, token) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 404) {
    throw new Error("repo, ref or path not found (404)");
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    if (body?.message?.includes("rate limit")) {
      throw new Error("GitHub rate limit exceeded. Set webide-dev.githubToken (PAT) for 5000 req/hr.");
    }
    throw new Error(String(body?.message || "HTTP 403 (forbidden \u2014 private repo? add a token)"));
  }
  if (!res.ok) {
    throw new Error(`GitHub returned HTTP ${res.status}`);
  }
  return res.json();
}
async function importFromGithub(writeFile, ensureDir, reveal) {
  const input = await vscode3.window.showInputBox({
    prompt: "GitHub repository (owner/repo, full URL, or URL#branch)",
    placeHolder: "e.g. expressjs/express",
    ignoreFocusOut: true
  });
  if (!input) {
    return;
  }
  const parsed = parseRepoInput(input);
  if (!parsed) {
    vscode3.window.showErrorMessage(`Not a GitHub repository: ${input}`);
    return;
  }
  const { owner, repo, ref } = parsed;
  const config = vscode3.workspace.getConfiguration("webide-dev");
  const maxKb = config.get("githubMaxFileKb", 512);
  const token = config.get("githubToken", "") || void 0;
  await vscode3.window.withProgress({
    location: vscode3.ProgressLocation.Notification,
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
      progress.report({ message: "listing files\u2026" });
      const tree = await ghApi(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, token);
      if (tree.truncated) {
        vscode3.window.showWarningMessage("Repo tree truncated by GitHub (very large repo) \u2014 importing a subset.");
      }
      const blobs = tree.tree.filter((n) => n.type === "blob" && !n.path.split("/").some((s) => IGNORE_DIRS.has(s)) && (n.size ?? 0) <= maxKb * 1024);
      const dirs = /* @__PURE__ */ new Set();
      let imported = 0, skipped = 0;
      let done = 0;
      const queue = [...blobs];
      const workers = Array.from({ length: MAX_CONCURRENT }, async () => {
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
            skipped++;
            console.warn(`[webide-dev] blob fetch failed for ${node.path}:`, err);
          }
          done++;
          if (done % 20 === 0) {
            progress.report({ message: `${done}/${blobs.length} files\u2026` });
          }
        }
      });
      await Promise.all(workers);
      await reveal(`${owner}-${repo}`);
      vscode3.window.showInformationMessage(
        `Imported ${imported} files from ${owner}/${repo}` + (skipped ? ` \u2014 skipped ${skipped} (failed or oversized)` : "") + "."
      );
    } catch (err) {
      vscode3.window.showErrorMessage(`GitHub import failed: ${err instanceof Error ? err.message : String(err)}`);
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
var vscode4 = __toESM(require("vscode"));
var IGNORE_DIRS2 = /* @__PURE__ */ new Set([
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
async function copyDir(src, destPath, writeFile, ensureDir, onProgress) {
  let copied = 0;
  let entries;
  try {
    entries = await vscode4.workspace.fs.readDirectory(src);
  } catch {
    return 0;
  }
  await ensureDir(destPath);
  for (const [name, type] of entries) {
    if (type === vscode4.FileType.Directory) {
      if (IGNORE_DIRS2.has(name)) {
        continue;
      }
      copied += await copyDir(vscode4.Uri.joinPath(src, name), `${destPath}/${name}`, writeFile, ensureDir, onProgress);
    } else if (type === vscode4.FileType.File) {
      if (name.endsWith(".map") || name === ".DS_Store") {
        continue;
      }
      try {
        const stat = await vscode4.workspace.fs.stat(vscode4.Uri.joinPath(src, name));
        if (stat.size > MAX_FILE_KB * 1024) {
          continue;
        }
        const bytes = await vscode4.workspace.fs.readFile(vscode4.Uri.joinPath(src, name));
        await writeFile(`${destPath}/${name}`, bytes);
        copied++;
        if (copied % 10 === 0) {
          onProgress(`${copied} files\u2026`);
        }
      } catch (err) {
        console.warn(`[webide-dev] upload: failed to read ${name}:`, err);
      }
    }
  }
  return copied;
}
async function uploadFolder(writeFile, ensureDir, reveal) {
  const picked = await vscode4.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Upload Folder",
    title: "Choose a local folder to upload into the dev environment"
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const root = picked[0];
  const folderName = root.path.split("/").filter(Boolean).pop() || "uploaded-folder";
  await vscode4.window.withProgress({
    location: vscode4.ProgressLocation.Notification,
    title: `Uploading ${folderName}`,
    cancellable: false
  }, async (progress) => {
    try {
      progress.report({ message: "reading files\u2026" });
      const copied = await copyDir(
        root,
        folderName,
        writeFile,
        ensureDir,
        (msg) => progress.report({ message: msg })
      );
      await reveal(folderName);
      if (copied === 0) {
        vscode4.window.showWarningMessage(`No files uploaded from ${folderName} (empty, or all filtered by ignore rules).`);
      } else {
        vscode4.window.showInformationMessage(`Uploaded ${copied} files from ${folderName} into the dev environment.`);
      }
    } catch (err) {
      vscode4.window.showErrorMessage(`Folder upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// src/extensionMain.ts
var RunOnceTerminal = class {
  constructor(container, relPath) {
    this.container = container;
    this.relPath = relPath;
  }
  container;
  relPath;
  writeEmitter = new vscode5.EventEmitter();
  onDidWrite = this.writeEmitter.event;
  closeEmitter = new vscode5.EventEmitter();
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
async function activate(_context) {
  const config = vscode5.workspace.getConfiguration("webide-dev");
  const runtimeUrl = config.get("runtimeUrl", "/nodine/supervisor.mjs");
  const readyPromise = (async () => {
    if (!isCrossOriginIsolated()) {
      return null;
    }
    try {
      const container = await bootContainer(runtimeUrl);
      const provider = new NodineFileSystemProvider(container);
      _context.subscriptions.push(vscode5.workspace.registerFileSystemProvider("nodine", provider, { isCaseSensitive: true }));
      await openNodineWorkspace(container);
      return container;
    } catch (err) {
      console.error("[webide-dev] runtime boot failed:", err);
      vscode5.window.showWarningMessage(`Dev environment boot failed: ${err instanceof Error ? err.message : err}. Terminal and imports are unavailable.`);
      return null;
    }
  })();
  const getFs = async () => {
    const container = await readyPromise;
    if (!container) {
      return null;
    }
    return {
      writeFile: async (p, contents) => {
        const dir = p.split("/").slice(0, -1).join("/");
        if (dir) {
          await container.fs.mkdir(`${container.workdir}/${dir}`, { recursive: true }).catch(() => {
          });
        }
        await container.fs.writeFile(`${container.workdir}/${p}`, contents);
      },
      ensureDir: async (p) => {
        await container.fs.mkdir(`${container.workdir}/${p}`, { recursive: true }).catch(() => {
        });
      }
    };
  };
  const reveal = async (_folderName) => {
    await vscode5.commands.executeCommand("revealInExplorer", vscode5.Uri.parse("nodine:/"));
    vscode5.commands.executeCommand("workbench.view.explorer");
  };
  _context.subscriptions.push(
    vscode5.commands.registerCommand("webide-dev.createTerminal", () => {
      createDevTerminal(_context);
    }),
    vscode5.commands.registerCommand("webide-dev.importGithub", async () => {
      const fs = await getFs();
      if (!fs) {
        vscode5.window.showErrorMessage("Dev environment is not running (needs cross-origin isolated host with the nodine runtime).");
        return;
      }
      await importFromGithub(fs.writeFile, fs.ensureDir, reveal);
    }),
    vscode5.commands.registerCommand("webide-dev.uploadFolder", async () => {
      const fs = await getFs();
      if (!fs) {
        vscode5.window.showErrorMessage("Dev environment is not running (needs cross-origin isolated host with the nodine runtime).");
        return;
      }
      await uploadFolder(fs.writeFile, fs.ensureDir, reveal);
    }),
    vscode5.commands.registerCommand("webide-dev.runFile", async (uri) => {
      const target = uri ?? vscode5.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== "nodine") {
        vscode5.window.showErrorMessage("Open a file from the nodine workspace to run it.");
        return;
      }
      const container = getContainer();
      if (!container) {
        return;
      }
      const rel = target.path.replace(/^\/+/, "");
      const terminal = vscode5.window.createTerminal({ name: `node ${rel}`, pty: new RunOnceTerminal(container, rel) });
      _context.subscriptions.push(terminal);
      terminal.show();
    }),
    vscode5.commands.registerCommand("webide-dev.previewPort", async () => {
      const container = getContainer();
      if (!container) {
        return;
      }
      const portStr = await vscode5.window.showInputBox({ prompt: "Port number", placeHolder: "3000" });
      const port = Number(portStr);
      if (!Number.isFinite(port)) {
        return;
      }
      const url = container.previewUrl(port);
      await vscode5.env.openExternal(vscode5.Uri.parse(url));
    })
  );
}
