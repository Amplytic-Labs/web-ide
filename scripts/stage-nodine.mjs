#!/usr/bin/env node
// Stage the nodine runtime from the installed npm package (@amplytic/nodine)
// into vscode-web/nodine, then apply the worker-safety fix to supervisor.mjs
// if the installed package still ships the broken one.
//
// The web IDE consumes nodine via npm (vscode/package.json), NOT a git clone:
//   cd vscode && pnpm install
//   node ../scripts/stage-nodine.mjs
//
// FIX (applied when needed): the ext host runs inside a Worker where `window`
// is undefined; the diagnostics sink must be guarded. Remove once the
// published package >= 0.4.1 includes it (check: grep 'const DIAG').
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// node_modules is shared with the working tree (the repo copy is source-only)
const PKG_CANDIDATES = [
  path.join(REPO, 'vscode/node_modules/@amplytic/nodine'),
  '/home/z/my-project/vscode/node_modules/@amplytic/nodine',
];
const PKG = PKG_CANDIDATES.find(p => fs.existsSync(path.join(p, 'runtime/supervisor.mjs')));
const RUNTIME = PKG && path.join(PKG, 'runtime');
// the gulp task drops the built site at BUILD_ROOT (the parent of the vscode
// working tree); the repo's vscode-web/ copy is refreshed at commit time
const OUT_CANDIDATES = [
  process.env.NODINE_STAGE_OUT,
  '/home/z/my-project/vscode-web/nodine',
  path.join(REPO, 'vscode-web/nodine'),
];
const OUT = OUT_CANDIDATES.find(p => p && fs.existsSync(path.dirname(path.dirname(p))));

if (!RUNTIME) {
  console.error('nodine runtime not found — tried:\n' + CANDIDATES.join('\n'));
  console.error('run: cd vscode && pnpm install');
  process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let n = 0, bytes = 0;
const copy = (src, dst) => {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copy(s, d); }
    else { fs.copyFileSync(s, d); n++; bytes += fs.statSync(s).size; }
  }
};
copy(RUNTIME, OUT);

// worker-safety fix for supervisor.mjs (no-op if already fixed upstream)
const supPath = path.join(OUT, 'supervisor.mjs');
let sup = fs.readFileSync(supPath, 'utf8');
if (sup.includes('window.__p2007')) {
  sup = sup
    .replace(
      /^/m,
      `// Worker-safe diagnostics sink (patched by stage-nodine): window is\n` +
      `// undefined inside Workers (e.g. the VS Code web extension host).\n` +
      `const DIAG = (typeof window !== 'undefined' && window.__p2007) || undefined;\n\n`
    )
    .replace(/window\.__p2007 && window\.__p2007\.logs\.push/g, 'DIAG && DIAG.logs.push')
    .replace(/window\.__p2007\.lastExit = code/g, 'if (DIAG) DIAG.lastExit = code')
    .replace(/window\.__p2007 && \(window\.__p2007\.exitCode = code, window\.__p2007\.stopped = true\)/g,
      'if (DIAG) { DIAG.exitCode = code; DIAG.stopped = true; }')
    .replace(/if \(window\.__p2007\) if \(DIAG\) DIAG\.lastExit = code;/g, 'if (DIAG) DIAG.lastExit = code;');
  fs.writeFileSync(supPath, sup);
  console.log('applied worker-safety fix to supervisor.mjs (remove when @amplytic/nodine >= 0.4.1)');
}

// Worker-context fix for sdk.mjs (no-op if already fixed upstream):
// Container.boot()'s environment check hard-requires window/document and
// navigator.serviceWorker — true only on the MAIN thread. When the SDK runs
// inside a Worker (the VS Code web extension host embeds it there), the
// runtime itself works (crossOriginIsolated + SharedArrayBuffer + wasm
// threads are all Worker-capable); only previewUrl's service worker is
// unavailable. Relax exactly those two checks in Worker contexts.
const sdkPath = path.join(OUT, 'sdk.mjs');
if (fs.existsSync(sdkPath)) {
  let sdk = fs.readFileSync(sdkPath, 'utf8');
  if (sdk.includes('function checkEnvironment() {') && !sdk.includes('inWorkerGlobal')) {
    sdk = sdk.replace(
      'function checkEnvironment() {\n  const checks = [];',
      'function checkEnvironment() {\n' +
      '  // patched by stage-nodine: a Worker context (VS Code web ext host)\n' +
      '  // has no window/document/navigator.serviceWorker, but CAN run the\n' +
      '  // runtime (isolation + SAB + wasm threads are Worker-capable).\n' +
      '  const inWorkerGlobal = typeof WorkerGlobalScope !== "undefined" && typeof importScripts !== "undefined" === false && typeof window === "undefined" && typeof self !== "undefined";\n' +
      '  const checks = [];'
    );
    // browser-context check: ok in a worker too
    sdk = sdk.replace(
      'checks.push({\n    id: "browser-context",\n    ok: hasWindow && hasDocument,',
      'checks.push({\n    id: "browser-context",\n    ok: (hasWindow && hasDocument) || inWorkerGlobal,'
    );
    // service-workers check: only previewUrl needs it; skip in workers
    sdk = sdk.replace(
      'checks.push({\n    id: "service-workers",\n    ok: "serviceWorker" in navigator,',
      'checks.push({\n    id: "service-workers",\n    ok: inWorkerGlobal || "serviceWorker" in navigator,'
    );
    // cross-origin-isolated check reads `window.` — make it Worker-safe
    sdk = sdk.replace(
      'ok: window.crossOriginIsolated === true,',
      'ok: (typeof window !== "undefined" ? window.crossOriginIsolated : self.crossOriginIsolated) === true,'
    );
    sdk = sdk.replace(
      'new URL(runtimeUrl, document.baseURI)',
      'new URL(runtimeUrl, (typeof document !== "undefined" ? document.baseURI : self.location.origin))'
    );
    fs.writeFileSync(sdkPath, sdk);
    console.log('applied worker-context fix to sdk.mjs (remove when @amplytic/nodine ships worker support)');
  }
}

// sdk.mjs: bundle the SDK entry from the installed package (the runtime/
// dir ships without it — the SDK is a separate dist bundle)
const sdkOut = path.join(OUT, 'sdk.mjs');
if (!fs.existsSync(sdkOut) && PKG && fs.existsSync(path.join(PKG, 'dist/index.js'))) {
  const esbuildPath = [
    '/home/z/my-project/vscode/node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js',
    '/home/z/my-project/vscode/node_modules/.pnpm/esbuild@0.27.2/node_modules/esbuild/lib/main.js',
  ].find(p => fs.existsSync(p));
  const esbuild = await import(esbuildPath);
  await esbuild.build({
    entryPoints: [path.join(PKG, 'dist/index.js')],
    outfile: sdkOut,
    platform: 'browser', format: 'esm', bundle: true, logLevel: 'warning',
  });
  console.log('bundled sdk.mjs from @amplytic/nodine/dist');
  // re-apply the worker-context fix to the freshly bundled sdk
  let fresh = fs.readFileSync(sdkOut, 'utf8');
  fresh = fresh
    .replace('function checkEnvironment() {\n  const checks = [];',
      'function checkEnvironment() {\n' +
      '  const inWorkerGlobal = typeof window === "undefined" && typeof self !== "undefined";\n' +
      '  const checks = [];')
    .replace('ok: hasWindow && hasDocument,', 'ok: (hasWindow && hasDocument) || inWorkerGlobal,')
    .replace('ok: "serviceWorker" in navigator,', 'ok: inWorkerGlobal || "serviceWorker" in navigator,')
    .replace('ok: window.crossOriginIsolated === true,',
      'ok: (typeof window !== "undefined" ? window.crossOriginIsolated : self.crossOriginIsolated) === true,')
    .replace('new URL(runtimeUrl, document.baseURI)',
      'new URL(runtimeUrl, (typeof document !== "undefined" ? document.baseURI : self.location.origin))');
  fs.writeFileSync(sdkOut, fresh);
  console.log('applied worker-context fix to sdk.mjs');
}

console.log(`staged nodine runtime: ${n} files, ${(bytes / 1048576).toFixed(1)} MB -> ${OUT}`);
