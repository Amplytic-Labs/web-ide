# Web IDE v0.2 — Dev Environment Integration Status

Real VS Code (Code - OSS) web build + nodine runtime + bolt.diy-inspired import features.
**Live preview: port 3000 (Preview Panel → Open in New Tab).**

## What's verified working (DOM/OCR/browser-verified)

1. **Real VS Code workbench, fully static** (v0.1, unchanged): editing, palette, find — all working
2. **`webide-dev` extension loads in the workbench** — all 5 commands in the Command Palette:
   - Web IDE: Create Dev Terminal / Import from GitHub… / Upload Local Folder… / Run Current File with Node / Open Preview Port…
3. **nodine boots inside the VS Code extension host** (a Worker — required SDK worker-compat patches, see below)
4. **nodine workspace mounted in Explorer** (`project (nodine)` folder, `nodine:` FileSystemProvider — read/write through the container FS)
5. **Terminal panel boots nodine** — OCR-verified: "ready — Node.js dev environment in /home/user/project"
6. **Node.js + npm run in the browser** (verified from page context AND a plain Worker):
   - `node -p process.version` → `'v26.13.0'` (exit 0)
   - `npm --version` → `12.2.2` (exit 0)
   - boot in ~2.1s

## What's NOT finished (known issue, one fix away)

**Process spawn from the extension-host worker hangs.** The terminal prompt appears and
line input is captured, but running a command (`40+2` → `node -e`) doesn't return output.
Verified boundaries:
- Page context spawn: ✅ works (1s)
- Plain module Worker spawn: ✅ works (after the supervisor DIAG fix below)
- Extension-host Worker (sandboxed iframe + blob worker) spawn: ❌ hangs

Probable cause: the ext host worker is created from a **blob:** URL inside a sandboxed
iframe; nodine's runtime worker pool resolves `WORKER_URL` relative to `import.meta.url`
(correct), but the spawned nested worker's fetch of `libsources.json`/`npm-seed-blob`
or its WASM compile may stall in that context. Next step: instrument
`runtime/supervisor.mjs` `onWorkerError`/`spawn` path inside the ext host and check the
`GET /nodine/…` request log (my server logs every hit) to see which request never arrives.

## Nodine fix applied (in /home/z/my-project/nodine)

`runtime/supervisor.mjs`: 17 `window.__p2007` diagnostic references replaced with a
worker-safe `DIAG` sink (`const DIAG = (typeof window !== 'undefined' && window.__p2007) || undefined`).
Bare `window` throws ReferenceError inside any Worker — this crashed every process spawn
from worker contexts. **Worth upstreaming to Amplytic-Labs/nodine.** (Uncommitted — review then commit.)

## SDK bundling (scripts/bundle_sdk.mjs)

`@amplytic/nodine` dist is bundled to a single `vscode-web/nodine/sdk.mjs` with worker
patches: browser-context check accepts Workers (`self`), `crossOriginIsolated` via self,
service-worker check skipped in workers, `document.baseURI` → `self.location.origin`.

## Architecture

```
vscode-web/                       ← static site (COOP/COEP host required)
├── index.html                    (static fill: serverless config)
├── nodine/                       ← runtime bundle + sdk.mjs (worker-patched)
├── extensions/webide-dev/        ← the dev-environment extension
│   ├── terminal  — line-based shell over nodine (node -e, npm, coreutils)
│   ├── fsProvider— nodine: FileSystemProvider (Explorer ↔ container FS)
│   ├── githubImport — zipball fetch + in-browser unzip (bolt.diy-style ignores)
│   ├── folderUpload — webkitdirectory picker (bolt.diy-style)
│   └── extensionMain — auto-boot, workspace mount, commands
└── out/…                         ← workbench
```

Hosting requirement: `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: credentialless`, `Service-Worker-Allowed: /`
(see scripts/serve_isolated.py — the reference server; Cloudflare `_headers` equivalent
in docs/DEPLOY-CLOUDFLARE.md).

## Rebuild / continue

```bash
# serve (reference isolated server)
python3 scripts/serve_isolated.py 3000 /home/z/my-project/vscode-web

# rebuild the extension after edits
cd vscode/extensions/webide-dev
node ../../node_modules/.pnpm/esbuild@0.27.2/node_modules/esbuild/bin… # (see build.sh)
# → see web-ide-repo/build.sh for the full pipeline

# re-stage nodine after runtime changes
cd nodine && node scripts/stage-runtime.mjs ../vscode-web/nodine
node ../scripts/bundle_sdk.mjs
```

Files: [vscode-web-static-v02.zip](/home/z/my-project/download/vscode-web-static-v02.zip) (83 MB — full site incl. nodine),
repo at `/home/z/my-project/web-ide-repo/` (pushed to Amplytic-Labs/web-ide).
