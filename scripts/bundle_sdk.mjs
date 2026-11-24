#!/usr/bin/env node
// Bundle the nodine SDK into a single sdk.mjs for static hosting.
// Patches applied to the built SDK files before bundling (worker support —
// the VS Code extension host runs extensions inside a Worker):
//   environment.js: browser-context check accepts worker contexts
//                   (no window/document); crossOriginIsolated via self;
//                   service-worker check skipped in workers
//   container.js:   runtimeUrl base falls back to self.location in workers
import esbuild from '/home/z/my-project/vscode/node_modules/.pnpm/esbuild@0.27.2/node_modules/esbuild/lib/main.js';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';

const OUT = process.argv[2] || '/home/z/my-project/vscode-web/nodine/sdk.mjs';
const DIST = '/home/z/my-project/nodine/dist';
const PATCHED = '/tmp/nodine-dist-patched';

// copy the dist tree so relative imports still resolve, then patch in the copy
await mkdir(PATCHED, { recursive: true });
await cp(DIST, PATCHED, { recursive: true });

// ---- environment.js patches ----
const envPath = `${PATCHED}/environment.js`;
let envSrc = await readFile(envPath, 'utf8');
const patches = [
  [
    "const inBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';",
    "const inBrowser = (typeof window !== 'undefined' && typeof document !== 'undefined') || typeof self !== 'undefined';",
  ],
  [
    "const hasWindow = typeof window !== 'undefined';",
    "const hasWindow = typeof window !== 'undefined' || typeof self !== 'undefined';",
  ],
  [
    "const hasDocument = typeof document !== 'undefined';",
    "const hasDocument = typeof document !== 'undefined' || typeof self !== 'undefined';",
  ],
  [
    "ok: window.crossOriginIsolated === true,",
    "ok: (typeof window !== 'undefined' ? window : self).crossOriginIsolated === true,",
  ],
  [
    "ok: 'serviceWorker' in navigator,",
    "ok: typeof document === 'undefined' || 'serviceWorker' in navigator,",
  ],
];
let applied = 0;
for (const [from, to] of patches) {
  if (envSrc.includes(from)) {
    envSrc = envSrc.replace(from, to);
    applied++;
  } else {
    console.error('WARN: environment patch not found:', from.slice(0, 60));
  }
}
await writeFile(envPath, envSrc);
console.log(`environment.js: ${applied}/${patches.length} patches applied`);

// ---- container.js patch ----
const containerPath = `${PATCHED}/container.js`;
let containerSrc = await readFile(containerPath, 'utf8');
const from = 'new URL(runtimeUrl, document.baseURI)';
const to = 'new URL(runtimeUrl, (typeof document !== \'undefined\' ? document.baseURI : self.location.origin))';
if (containerSrc.includes(from)) {
  containerSrc = containerSrc.replace(from, to);
  console.log('container.js: base URI patch applied');
} else {
  console.error('WARN: container patch not found');
}
await writeFile(containerPath, containerSrc);

// ---- bundle from the patched tree ----
await esbuild.build({
  entryPoints: [`${PATCHED}/index.js`],
  outfile: OUT,
  platform: 'browser',
  format: 'esm',
  bundle: true,
  logLevel: 'warning',
});

console.log('sdk.mjs bundled (worker-patched) →', OUT);
