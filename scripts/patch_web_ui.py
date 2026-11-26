#!/usr/bin/env python3
"""
Post-build patches for the Nodine Web IDE static site.

Run after `bash build.sh` regenerates vscode-web/ (the build wipes these
files). Idempotent: every patch checks its marker before applying.

  1. UI: smaller top-left text logo (132px → 96px) and <Menu icon> <Logo>
     order in the title bar (CSS overrides appended to the workbench CSS).
  2. FS activation: add "onFileSystem:nodine" to BOTH embedded copies of the
     webide-dev manifest inside the workbench bundle. This makes the
     workbench WAIT for the extension (and its nodine: FileSystemProvider)
     before resolving the boot folder nodine://nodine/ — without it the
     folder is resolved pre-activation, the Explorer tree is left in a
     poisoned error state (grayed root, no children) and the folder watcher
     never attaches.

Usage: python3 scripts/patch_web_ui.py [site-root]
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'vscode-web'
CSS_PATH = SITE / 'out/vs/workbench/workbench.web.main.internal.css'
JS_PATH = SITE / 'out/vs/workbench/workbench.web.main.internal.js'

CSS_MARKER = '===== Nodine UI overrides (patch_web_ui.py) ====='

CSS_OVERRIDES = """

/* ===== Nodine UI overrides (patch_web_ui.py) ===== */
/* 1. smaller top-left text logo (was 132px wide) */
.monaco-workbench .part.titlebar > .titlebar-container > .titlebar-left > .window-appicon {
  width: 96px !important;
  order: 2 !important;
}
/* 2. application-menu hamburger first, then the logo */
.monaco-workbench .part.titlebar > .titlebar-container > .titlebar-left > .menubar {
  order: 1 !important;
}
"""

# the webide-dev manifest is embedded in the workbench bundle TWICE:
#  a. the static-extensions list (keyed by "extensionPath")
#  b. the builtin-extensions manifest list (keyed by its browser entry point)
MANIFEST_PATCHES = [
    ('"extensionPath":"webide-dev","packageJSON":{"name":"webide-dev",',
     '"extensionPath":"webide-dev","packageJSON":{"name":"webide-dev","activationEvents":["onStartupFinished","onFileSystem:nodine"],'),
    ('"activationEvents":["onStartupFinished"],"browser":"./dist/browser/extensionMain"',
     '"activationEvents":["onStartupFinished","onFileSystem:nodine"],"browser":"./dist/browser/extensionMain"'),
]


def patch_css() -> None:
    css = CSS_PATH.read_text(encoding='utf-8')
    if CSS_MARKER in css:
        print('css: already patched')
        return
    with open(CSS_PATH, 'a', encoding='utf-8') as f:
        f.write(CSS_OVERRIDES)
    print(f'css: patched {CSS_PATH}')


def patch_manifest() -> None:
    js = JS_PATH.read_text(encoding='utf-8')
    changed = False
    for old, new in MANIFEST_PATCHES:
        if new in js:
            print(f'manifest: {old[:60]}… already patched')
            continue
        if old not in js:
            print(f'manifest: WARNING marker not found: {old[:70]}…')
            continue
        js = js.replace(old, new)
        changed = True
        print(f'manifest: patched {old[:60]}…')
    if changed:
        JS_PATH.write_text(js, encoding='utf-8')


def main() -> None:
    patch_css()
    patch_manifest()
    print('done')


if __name__ == '__main__':
    main()
