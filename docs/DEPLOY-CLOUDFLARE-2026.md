# Deploying Nodine Web IDE in 2026 — Cloudflare reference

Site: `vscode-web/` — 2,670 files, ~251 MB, one **48 MB** JS bundle
(`out/vs/workbench/workbench.web.main.internal.js`). 100% static; no server code.

**Required response headers (Nodine runtime needs cross-origin isolation):**

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
Service-Worker-Allowed: /     (at least on /nodine/*)
```

## Where Cloudflare stands (verified Nov 2026)

| | Pages | Workers Static Assets | R2 + custom domain |
|---|---|---|---|
| Per-file limit | **25 MiB hard** | **25 MiB hard** | 5 TiB |
| File count | 20k free / 100k paid | 20k free / 100k paid (wrangler ≥ 4.34) | unlimited |
| Custom headers | `_headers` file | `_headers` file (native) | zone Transform Rules only |
| 48 MB bundle | **deploy fails client-side** ("Pages only supports files up to 25 MiB") | same 25 MiB limit | works |
| gzip/brotli | automatic | not documented | not documented for R2 |
| node_modules upload | wrangler **silently excludes `**/node_modules`** | verify before relying on it | you control keys |
| Egress cost | free | free, unlimited asset requests | **zero egress fees** (confirmed) |

Key doc URLs:
- Pages limits: https://developers.cloudflare.com/pages/platform/limits/
- Pages headers: https://developers.cloudflare.com/pages/configuration/headers/
- Workers assets limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers assets `_headers`: https://developers.cloudflare.com/workers/static-assets/headers/
- R2 limits/pricing: https://developers.cloudflare.com/r2/platform/limits/ , https://developers.cloudflare.com/r2/pricing/
- Public buckets: https://developers.cloudflare.com/r2/buckets/public-buckets/

## Recommended: split hosting

1. **Everything except the 48 MB bundle → Workers Static Assets** (or Pages):

```jsonc
// wrangler.jsonc
{
  "name": "nodine-web-ide",
  "compatibility_date": "2026-11-28",
  "assets": { "directory": "./vscode-web" }
}
```
   `_headers` in `vscode-web/`:
```
/nodine/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  Service-Worker-Allowed: /
```
   `npx wrangler deploy`

2. **The 48 MB bundle → R2 bucket + custom domain** (zero egress, ~$0.004/mo storage):
```sh
npx wrangler r2 bucket create nodine-ide
npx wrangler r2 object put nodine-ide/workbench.js \
  --file vscode-web/out/vs/workbench/workbench.web.main.internal.js \
  --content-type application/javascript
npx wrangler r2 bucket domain add nodine-ide --domain static.example.com --zone-id <ZONE_ID>
```
   Then either point the HTML at the R2 URL, or front the whole site on the R2
   domain (needs zone-level Response Header Transform Rules for the 3 headers —
   R2 itself cannot set arbitrary response headers).

**Alternative if you refuse to split**: chunk the 48 MB bundle below 25 MiB each
at build time (esbuild code-splitting) — then ONE host (Workers assets + `_headers`)
serves everything. This is the cleanest long-term fix.

## Gotchas verified from wrangler source

- Pages upload silently ignores `**/node_modules` — the site's runtime
  `node_modules/` (xterm, oniguruma…) would NOT deploy. This repo now ships
  them in git (commit 399ec021) — verify what actually uploads, or use Workers
  assets, or rename the dir + rewrite the `nodeModulesPath` in the bundle.
- Range requests: Pages/Workers assets return `200` with the full file (no 206).
- `_headers` max 100 rules / 2,000 chars per line — this site needs 1 rule.

## Automating with an API token (no browser interaction)

`wrangler login` is OAuth (unusable headless). With an API token it is fully
non-interactive:

```sh
export CLOUDFLARE_API_TOKEN=...   # + CLOUDFLARE_ACCOUNT_ID
npx wrangler pages project create nodine-ide --production-branch main
npx wrangler pages deploy vscode-web --project-name=nodine-ide --branch=main
# or
npx wrangler deploy               # workers assets, wrangler.jsonc above
# or R2:
npx wrangler r2 bucket create nodine-ide
npx wrangler r2 object put nodine-ide/<key> --file <file>
```

Token permissions:
- Pages deploys: Account → **Cloudflare Pages → Edit** (per
  https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
- Workers deploys: create from the **"Edit Cloudflare Workers"** template
  (https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- R2: Account → R2 → Edit.

So yes — an agent with a scoped API token + account id can deploy this fully
automatically. Give it the two env vars above and it needs nothing else.
Token creation: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
(the secret is shown once). Do NOT paste tokens into chat/repo — pass them as
env vars when you're ready to run the deploy.

## Local serving (what this sandbox does)

```sh
cd web-ide && python3 scripts/serve_isolated.py 3000 ./vscode-web
# → http://127.0.0.1:3000  (COOP/COEP + SW-allowed headers on every response)
```

## Fresh-clone checklist (bugs fixed in this copy)

1. `vscode-web/node_modules/` must exist — shipped in git now; if missing:
   `node web-ide/scripts/stage-sitedeps.mjs` (also wired into `build.sh`).
   Without it the terminal dies with "An unknown error occurred" (xterm 404).
2. Loading screen: shows loader from 0 s; error only on real script failure.
