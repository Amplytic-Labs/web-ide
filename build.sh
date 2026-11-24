# Build the web-only VS Code site and refresh this repo's artifacts
# Usage: bash build.sh   (run inside web-ide-repo; expects ../vscode to be the patched clone)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
VSCODE_DIR="${VSCODE_DIR:-$REPO_DIR/../vscode}"

cd "$VSCODE_DIR"

# apply our patches if not already applied
git apply --check "$REPO_DIR/patches/web-only-lightweight-build.diff" 2>/dev/null \
  && git apply "$REPO_DIR/patches/web-only-lightweight-build.diff" \
  || echo "(patches already applied)"

# memory-constrained build: sequential bundling + no sourcemaps (see patch)
VSCODE_WEB_NO_SOURCEMAPS=1 \
  node --experimental-strip-types --max-old-space-size=1536 \
    ./node_modules/gulp/bin/gulp.js vscode-web

# fill the workbench HTML into a serverless index.html
python3 "$REPO_DIR/scripts/static_fill.py"
echo "done → $VSCODE_DIR/../vscode-web"
