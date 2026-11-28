#!/usr/bin/env bash
# Build the Nodine Web IDE (real VS Code, web-only static build).
# The source in vscode/ is modified directly — no patches to apply.
# Usage: bash build.sh   (from the repo root)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
VSCODE_DIR="${VSCODE_DIR:-/home/z/my-project/vscode}"   # working tree (node_modules lives here)

cd "$VSCODE_DIR"

# node deps (including @amplytic/nodine from npm)
if [ ! -d node_modules/@amplytic/nodine ]; then
  pnpm install --no-frozen-lockfile
fi

# memory-constrained build: sequential bundling + no sourcemaps
VSCODE_WEB_NO_SOURCEMAPS=1 \
  node --experimental-strip-types --max-old-space-size=1536 \
    ./node_modules/gulp/bin/gulp.js vscode-web

# post-build steps (run from the repo so scripts resolve paths)
cd "$REPO_DIR"
python3 scripts/static_fill.py                 # fill placeholders -> serverless index.html
python3 scripts/make_nodine_icons.py           # favicon + PWA icons from assets/Nodine-logo.svg
node scripts/stage-nodine.mjs                  # stage runtime from node_modules -> vscode-web/nodine
node scripts/stage-sitedeps.mjs                # xterm/oniguruma/textmate the site fetches at runtime

echo "done -> $REPO_DIR/vscode-web"
