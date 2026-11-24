#!/usr/bin/env node
// Stage the nodine runtime from the installed npm package (@amplytic/nodine)
// into the built web IDE, and bundle sdk.mjs from the package dist.
//
// The web IDE consumes nodine via npm (vscode/package.json), NOT a git clone:
//   cd vscode && pnpm install
//   node ../scripts/stage-nodine.mjs
//
// Requires @amplytic/nodine >= 0.4.1 (Worker-context support in the SDK:
// checkEnvironment + baseURI resolution + guarded diagnostics sink — fixed
// in the nodine package itself, so this script applies NO patches).
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

if (!RUNTIME || !OUT) {
  if (!RUNTIME) console.error('nodine runtime not found — tried:\n' + PKG_CANDIDATES.join('\n'));
  if (!OUT) console.error('stage output dir not found — tried:\n' + OUT_CANDIDATES.join('\n'));
  console.error('run: cd vscode && pnpm install  (needs @amplytic/nodine >= 0.4.1)');
  process.exit(1);
}

// guard: refuse to stage a package that still needs the old worker patches
const sup = fs.readFileSync(path.join(RUNTIME, 'supervisor.mjs'), 'utf8');
if (/window\.__p2007 &&/.test(sup) || /window\.__p2007\.lastExit/.test(sup)) {
  console.error('installed @amplytic/nodine predates Worker support (0.4.1). Upgrade the dependency.');
  process.exit(1);
}
const env = fs.readFileSync(path.join(PKG, 'dist/environment.js'), 'utf8');
if (!env.includes('inWorker')) {
  console.error('installed @amplytic/nodine SDK lacks Worker-context support (0.4.1). Upgrade the dependency.');
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

// sdk.mjs: bundle the SDK entry from the installed package (the runtime/
// dir ships without it — the SDK is a separate dist bundle)
const sdkOut = path.join(OUT, 'sdk.mjs');
if (PKG && fs.existsSync(path.join(PKG, 'dist/index.js'))) {
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
}

console.log(`staged nodine runtime: ${n} files, ${(bytes / 1048576).toFixed(1)} MB -> ${OUT}`);
