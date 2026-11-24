# Nodine Web IDE — real VS Code, web-only, serverless

A **real VS Code** (Code - OSS) built as a **fully static, client-side web build** — like vscode.dev,
but hostable anywhere static files go (Cloudflare Pages/R2, S3, GitHub Pages…). No server, no accounts,
no Copilot, no desktop code. The dev environment (terminal, Node.js, npm, GitHub import, folder upload)
is powered by **[Nodine](https://github.com/Amplytic-Labs/nodine)** — a WebContainer alternative running
real Node.js v26 in the browser tab.

Branded with the Nodine logo (mark + `#61E925`); the workbench theme is untouched VS Code.

## Current state (v0.2)

- `web` build target of the real VS Code workbench (Monaco, IntelliSense, search, themes, 70+ grammars)
- Fully static output: `index.html` + `out/` + `extensions/` — verified with a plain static server
- Stripped: Copilot, chat "Sessions" workbench, devTunnels, auth extensions (github/microsoft),
  git extensions, marketplace debuggers, telemetry deps (`@microsoft/1ds-*`, `tas-client`), simple-browser
- **Dev environment (Nodine)**: `Web IDE: Create Dev Terminal` boots real Node.js in the tab;
  line-based shell (`node`, `npm`, `npx`, coreutils), JS eval at the prompt
- **Upload local folder** (bolt.diy-style) and **Import from GitHub** — both land files in the
  File System Access workspace so every VS Code feature (editors, search, IntelliSense) works on them
- Local folder open via File System Access API, untitled file editing, command palette — all verified in headless Chromium
- Nodine branding: favicon (16/24/32/48), PWA icons 192/512, manifest `Nodine Web IDE`

## Repo layout — maintainable source

```
vscode/                  FULL VS Code source tree (this repo is self-contained: clone & build)
  └─ extensions/webide-dev/   our dev-environment extension (terminal, nodine, githubImport, folderUpload)
extensions-webide-dev/   mirror of the extension source at top level (browse without entering vscode/)
vscode-web/              BUILT static site — deploy this directory as-is
assets/                  Nodine brand assets (logo svg/png, text logo)
scripts/                 build glue (static_fill, make_nodine_icons, snapshot) + verify_*.js browser tests
docs/                    deploy guide + screenshots
```

`vscode/` IS the product: our modifications live directly in the source (search for
`// nodine:` comments). There is no patch file — clone, `pnpm install`, `bash build.sh`.
`node_modules` is gitignored — dependencies (incl. `@amplytic/nodine`) install with pnpm.

## Build

```bash
git clone https://github.com/Amplytic-Labs/web-ide.git && cd web-ide
cd vscode && pnpm install        # node_modules (gitignored) incl. @amplytic/nodine from npm
bash ../build.sh                 # gulp vscode-web -> vscode-web/, then icons + nodine staging
```

`build.sh` builds with `VSCODE_WEB_NO_SOURCEMAPS=1` (memory-constrained: sequential
bundling, no sourcemaps), then runs `scripts/static_fill.py` (serverless HTML fill),
`scripts/make_nodine_icons.py` (favicon + PWA icons from `assets/Nodine-logo.svg`) and
`scripts/stage-nodine.mjs` (copies the nodine runtime out of `node_modules/@amplytic/nodine`
into `vscode-web/nodine/`).

Serve locally (COOP/COEP headers are required for Nodine):

```bash
python3 scripts/serve_isolated.py 3000 ./vscode-web
# → http://127.0.0.1:3000
```

## Deploy

See [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md).
Static hosting must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless` (Nodine needs cross-origin isolation).

## Verification

`scripts/verify_*.js` drive the built site in headless Chromium: workbench render, command palette,
text editing (DOM-verified), find widget, status bar, terminal + Node.js eval, worker-spawn of nodine.
`scripts/serve_isolated.py` is the reference server used by these tests.

## License

Upstream VS Code is MIT (see [vscode/LICENSE.txt](vscode/LICENSE.txt)).
This repo's build glue is MIT too.
