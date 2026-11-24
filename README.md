# Web IDE — real VS Code, web-only, serverless

A **real VS Code** (Code - OSS) built from [`microsoft/vscode`](https://github.com/microsoft/vscode) as a
**fully static, client-side web build** — like vscode.dev, but hostable anywhere static files go
(Cloudflare Pages/R2, S3, GitHub Pages…). No server, no accounts, no Copilot, no desktop code.

## Current state (v0.1)

- `web` build target of the real VS Code workbench (Monaco, IntelliSense, search, themes, 70+ grammars)
- Fully static output: `index.html` + `out/` + `extensions/` — verified with a plain `python3 -m http.server`
- Stripped: Copilot, chat "Sessions" workbench, devTunnels, auth extensions (github/microsoft),
  git extensions, marketplace debuggers, telemetry deps (`@microsoft/1ds-*`, `tas-client`), simple-browser
- Local folder open via File System Access API, untitled file editing, command palette — all verified in headless Chromium

### Roadmap (v0.2) — dev environment

- [ ] **Nodine runtime** ([Amplytic-Labs/nodine](https://github.com/Amplytic-Labs/nodine)): real Node.js v26 in
      the browser tab (Rust/WASM microkernel, working `npm`, dev servers on same-origin preview URLs) →
      integrated as the IDE's terminal/process backend
- [ ] **Import from GitHub** (bolt.diy-style): clone any repo straight into the workspace
- [ ] **Upload local folder**: drop a folder into the IDE

## Repo layout

```
patches/   diff against microsoft/vscode (web-only lightweight build: strips + OOM fixes)
scripts/   static_fill.py (serverless HTML fill) + browser verification scripts
docs/      deploy guide + screenshots
```

## Build

```bash
git clone --depth 1 https://github.com/microsoft/vscode.git
cd vscode && pnpm install
git apply ../web-ide/patches/web-only-lightweight-build.diff
VSCODE_WEB_NO_SOURCEMAPS=1 pnpm run gulp vscode-web    # → ../vscode-web (static site)
python3 ../web-ide/scripts/static_fill.py               # fill placeholders → index.html
python3 -m http.server -d ../vscode-web 3000            # it's just static files
```

## Deploy

See [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md).

## Verification

`scripts/verify_*.js` drive the built site in headless Chromium:
workbench render, command palette, text editing (DOM-verified), find widget, status bar.

## License

Upstream VS Code is MIT (see [microsoft/vscode](https://github.com/microsoft/vscode)).
This repo's build glue is MIT too.
