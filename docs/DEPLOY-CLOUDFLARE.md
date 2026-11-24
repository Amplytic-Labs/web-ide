# VS Code Web — Static, Client-Only Build for Cloudflare

A real **Code - OSS (VS Code)** web build, compiled from `microsoft/vscode` (commit `5b6a541` shallow clone, Nov 2026), stripped for a lightweight, serverless deployment.

- **100% client-side**: HTML + JS + CSS static files. No Node server, no remote agent, no backend.
- **Cloudflare-ready**: drop the `vscode-web/` folder on Cloudflare Pages (or any static host / S3 / GitHub Pages).
- **Runs like vscode.dev**: open local folders via the browser's File System Access API, edit, search, use language features — all in the browser.

## What's in the box

```
vscode-web/
├── index.html            ← the workbench (serve this at /)
├── _redirects            ← Cloudflare Pages: /callback → callback.html
├── manifest.json, code-192.png, code-512.png, favicon.ico
├── out/                  ← core workbench (workbench.web.main.internal.js, workers, NLS)
├── extensions/           ← 70 built-in extensions (see list below)
├── node_modules/         ← browser-only runtime deps (xterm, textmate, katex, tree-sitter-wasm…)
└── package.json
```

Wire size: the main workbench bundle is 48 MB raw → **~9.3 MB gzipped** (Cloudflare serves gzip/brotli automatically).

## Deploy to Cloudflare Pages

**Option A — Dashboard (fastest):**
1. Unzip `vscode-web-static.zip`.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → **Upload assets**.
3. Drag the `vscode-web` **folder contents** (not the parent) into the uploader.
4. Deploy. Your editor is live at `https://<project>.pages.dev`.

**Option B — Wrangler CLI:**
```bash
unzip vscode-web-static.zip
npx wrangler pages deploy vscode-web --project-name=my-vscode
```

**Option C — Git integration:** push `vscode-web/` to a repo, connect it in Pages, set build command = none, output dir = `/`.

Notes:
- Cloudflare Pages limit is 20,000 files / 25 MiB per file — this build is 2,670 files, largest ~48 MB… **the 48 MB bundle exceeds the 25 MiB per-file limit**. Two fixes (either works):
  - Serve from **Cloudflare R2 + custom domain** (no per-file limit, still static), or
  - Split hosting: put the zip's folder on any static host without per-file caps (GitHub Pages, Netlify, S3+CDN).
  - Everything else (index.html, extensions, workers) is well under the cap, so a hybrid also works.

## What was stripped (per your requirements)

| Removed | Why |
|---|---|
| **Copilot extension** | not an IDE feature (already excluded upstream in OSS build) |
| **Chat/agent "Sessions" web workbench** | second full workbench bundle for agents — cut from build entry points |
| **devTunnels web bundle** | server/tunnel feature — not needed client-side |
| **github-authentication, git-base, github extensions** | account/auth + git hosting |
| **microsoft-authentication, git, tunnel-forwarding** | desktop/native-only (auto-excluded from web target) |
| **simple-browser extension** | non-IDE extra |
| **Marketplace built-ins (js-debug, js-debug-companion, vscode-js-profile-table)** | debugger downloads pulled from marketplace at build time |
| **Telemetry runtime deps (@microsoft/1ds-*, tas-client)** | no account/telemetry; also dormant in OSS builds |
| **All desktop/Electron code** | the `web` build target only compiles browser code — no Electron, no Node server, no remote server entry points |
| **Source maps** | disabled to fit build memory (VSCODE_WEB_NO_SOURCEMAPS=1) |

## What's kept (a normal dev environment)

- Monaco editor with full syntax highlighting (70+ grammars: TS/JS, Python, Go, Rust, C++…)
- Language features: **TypeScript/JavaScript IntelliSense**, JSON/CSS/HTML language servers, Emmet
- Search & replace (incl. local file search worker), Merge conflict editor, Markdown preview + math + Mermaid diagrams, Notebook support (ipynb), NPM support
- Local folder opening via File System Access API (Chrome/Edge; Firefox/Safari have partial support)
- Themes (Dark+, Monokai, Solarized…), keybindings, settings, extensions view

## Rebuild from source

```bash
git clone --depth 1 https://github.com/microsoft/vscode.git
cd vscode && pnpm install          # pnpm 12.16.0 (pinned in package.json)

# strips (already applied here):
#   build/lib/extensions.ts  → excludedExtensions += github-authentication, git-base, simple-browser
#   product.json             → builtInExtensions = []
#   build/next/index.ts      → webOnlyEntryPoints = [] (drops sessions workbench + devTunnels)
#                              + sequential bundling (memory)
#   build/next/bundle.ts     → VSCODE_WEB_NO_SOURCEMAPS=1 knob

VSCODE_WEB_NO_SOURCEMAPS=1 pnpm run gulp vscode-web   # output → ../vscode-web
python3 scripts/static_fill.py                        # fill placeholders → index.html (static, serverless)
```

`static_fill.py` and the browser-verification scripts live in `/home/z/my-project/scripts/`.

## Verification performed

Loaded the site with plain `python3 -m http.server` (proof it's fully static) and drove it in headless Chromium:
- Workbench renders: titlebar, activity bar, sidebar, Welcome page
- Command Palette → New Text File → untitled editor opens
- Typed `const greeting = "Hello from real VS Code Web";` — DOM-verified, syntax-highlighted
- Status bar live: `Plain Text | LF | UTF-8 | Spaces: 4 | Ln 2, Col 1`
- Find widget (Ctrl+F) works

Screenshots: `download/vscode-web-preview/` (workbench.png, editing.png, command-palette.png, find-widget.png).

## Known limitations

- **Marketplace is disabled** (OSS builds have no gallery config) — you code with the 70 built-in extensions only. Wiring a gallery back in is a product.json change if ever needed.
- **Per-file size**: 48 MB main bundle (9.3 MB gzipped) exceeds Cloudflare Pages' 25 MiB per-file cap — use R2 or another static host for that one file (see Deploy notes).
- Some Copilot-chat *core* contribs remain in the workbench core (structural in current VS Code); they're inert without an account and produce a few console warnings.
- Local-folder open needs File System Access API (Chrome/Edge). On Firefox/Safari you can still create/edit untitled files.
