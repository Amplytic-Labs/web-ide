#!/usr/bin/env node
// Stage the BROWSER-RUNTIME node_modules the built site fetches at runtime.
//
// Why: the workbench bundle (out/vs/workbench/workbench.web.main.internal.js)
// does NOT inline some runtime deps — it imports them at runtime from
// /node_modules/... via importAMDNodeModule():
//   @xterm/xterm, @xterm/addon-*, vscode-textmate, vscode-oniguruma (onig.wasm!),
//   @vscode/iconv-lite-umd, jschardet, katex, @vscode/tree-sitter-wasm, ...
// The site's own package.json (vscode-web/package.json) pins their versions.
// These files are part of the DEPLOYED SITE — missing them breaks the
// integrated terminal ("An unknown error occurred") and syntax highlighting.
//
// This script is idempotent and standalone: run it after a build, or on a
// fresh clone that already contains vscode-web/, to (re)install the deps.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SITE = path.resolve(import.meta.dirname, '..', 'vscode-web');
const NM = path.join(SITE, 'node_modules');

if (!fs.existsSync(path.join(SITE, 'package.json'))) {
	console.error(`no ${SITE}/package.json — is vscode-web built?`);
	process.exit(1);
}

// quick sanity probe: the terminal deps the workbench fetches unconditionally
const probes = [
	'@xterm/xterm/lib/xterm.js',
	'vscode-oniguruma/release/onig.wasm',
	'vscode-textmate/release/main.js',
];
const missing = probes.filter(p => !fs.existsSync(path.join(NM, p)));
if (missing.length === 0) {
	console.log('vscode-web/node_modules already staged (xterm/oniguruma/textmate present)');
	process.exit(0);
}

console.log('staging browser runtime deps:', missing.join(', '));
// --no-package-lock: never touch the site's package-lock (the repo tracks the
// tree, not the lockfile). --omit=dev: the site needs only runtime deps.
execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error', {
	cwd: SITE,
	stdio: 'inherit',
});
const stillMissing = probes.filter(p => !fs.existsSync(path.join(NM, p)));
if (stillMissing.length) {
	console.error('still missing after install:', stillMissing.join(', '));
	process.exit(1);
}
console.log('staged vscode-web/node_modules ✔  (integrated terminal + grammars deps)');
