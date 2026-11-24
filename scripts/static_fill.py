#!/usr/bin/env python3
"""
Post-process the vscode-web static build into a fully static, serverless site:
- Fill the {{...}} placeholders in workbench.html with a static configuration
  (no remote authority, no auth session, empty workspace → welcome screen).
- Write it as index.html at the site root (Cloudflare Pages serves /).
- Add a _redirects file so /callback routes cleanly on Pages.
- Keep everything client-side: no server, no telemetry endpoints.

The vscode-web layout is:  out/...  extensions/...  node_modules/...  resources at root
The workbench.html references {{WORKBENCH_WEB_BASE_URL}}/out/... so base URL is ''.
"""
import json
import re
import shutil
from pathlib import Path

SITE = Path('/home/z/my-project/vscode-web')
WORKBENCH_HTML = SITE / 'out/vs/code/browser/workbench/workbench.html'
INDEX_HTML = SITE / 'index.html'
CALLBACK_HTML = SITE / 'out/vs/code/browser/workbench/callback.html'

# Static workbench configuration (mirrors webClientServer.ts workbenchWebConfiguration
# for a serverless deployment: no remoteAuthority → everything runs in the browser)
workbench_web_configuration = {
    'remoteAuthority': None,
    'serverBasePath': '',
    'canShortCircuitIfEmbedded': None,
    '_wrapWebWorkerExtHostInIframe': False,
    'developmentOptions': None,
    'settingsSyncOptions': None,
    'enableWorkspaceTrust': True,
    'enabledExtensionProposedApi': [],  # must be an array (readonly ExtensionId[])
    'folderUri': None,
    'workspaceUri': None,
    'productConfiguration': {
        'embedderIdentifier': 'vscode-web-static',
    },
    'callbackRoute': '/callback',
}

def html_attr_encode(value: str) -> str:
    """Same as VS Code's htmlAttributeEncodeValue: placeholders only appear as
    quoted HTML attribute values, so attribute encoding is sufficient."""
    return (value
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('"', '&quot;')
            .replace("'", '&apos;'))

def main():
    html = WORKBENCH_HTML.read_text()

    values = {
        'WORKBENCH_SCRIPT_NONCE': '',  # static hosting: no CSP nonce injection
        'WORKBENCH_WEB_BASE_URL': '',
        'WORKBENCH_WEB_CONFIGURATION': html_attr_encode(json.dumps(workbench_web_configuration, separators=(',', ':'))),
        'WORKBENCH_AUTH_SESSION': '',  # no account / auth in this build
        'WORKBENCH_NLS_FALLBACK_URL': '/out/nls.messages.js',
        'WORKBENCH_NLS_URL': '',       # empty → browser falls back to english bundle
    }
    for key, val in values.items():
        html = html.replace('{{' + key + '}}', val)

    # The web target bundles the workbench as a library (workbench.web.main.internal.js);
    # the browser shell lives in our ESM shim (out/browser/esm/main.js). Point the HTML
    # at the shim + the real CSS file.
    html = html.replace(
        '<link rel="stylesheet" href="/out/vs/code/browser/workbench/workbench.css">',
        '<link rel="stylesheet" href="/out/vs/workbench/workbench.web.main.internal.css">'
    )
    html = html.replace(
        '<script type="module" src="/out/vs/code/browser/workbench/workbench.js"></script>',
        '<script type="module" src="/out/browser/esm/main.js"></script>'
    )

    # Icons live at the site root (packaging copies them there), not under /resources/server/
    html = html.replace('/resources/server/', '/')

    # Remaining placeholder sanity check
    leftovers = re.findall(r'\{\{[A-Z_]+\}\}', html)
    assert not leftovers, f'unfilled placeholders: {leftovers}'

    # The manifest.json references icons at /resources/server/... but our site has them at root.
    # manifest.json is copied to the site root by packaging, fix its icon paths if needed.
    INDEX_HTML.write_text(html)
    print(f'wrote {INDEX_HTML} ({len(html)} bytes)')

    # Cloudflare Pages: /callback serves the callback page
    redirects = SITE / '_redirects'
    redirects.write_text('/callback /out/vs/code/browser/workbench/callback.html 200\n')
    print(f'wrote {redirects}')

    # Fix manifest.json icon paths (packaging puts icons at site root)
    manifest_path = SITE / 'manifest.json'
    if manifest_path.exists():
        m = json.loads(manifest_path.read_text())
        icons = m.get('icons', [])
        for icon in icons:
            if 'resources/server/' in icon.get('src', ''):
                icon['src'] = '/' + icon['src'].split('/')[-1]
        manifest_path.write_text(json.dumps(m, indent=2))
        print('fixed manifest.json icon paths')

    # Install the browser shell shim (the build wipes out/browser/)
    shim_src = Path('/home/z/my-project/web-ide-repo/assets/main.js')
    shim_dst = SITE / 'out/browser/esm/main.js'
    shim_dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(shim_src, shim_dst)
    print(f'installed browser shell shim → {shim_dst}')

    # Stage the nodine runtime + SDK (the build wipes /nodine too)
    nodine_dir = SITE / 'nodine'
    if not (nodine_dir / 'supervisor.mjs').exists():
        import subprocess
        subprocess.run(['node', 'scripts/stage-runtime.mjs', str(nodine_dir)],
                       cwd='/home/z/my-project/nodine', check=True, capture_output=True)
        subprocess.run(['node', '-e', STAGE_SDK_SCRIPT], check=True)
        print('staged nodine runtime + sdk.mjs')

    print('done')

STAGE_SDK_SCRIPT = """
const esbuild = require('/home/z/my-project/vscode/node_modules/.pnpm/esbuild@0.27.2/node_modules/esbuild');
esbuild.build({
  entryPoints: ['/home/z/my-project/nodine/dist/index.js'],
  outfile: '/home/z/my-project/vscode-web/nodine/sdk.mjs',
  platform: 'browser', format: 'esm', bundle: true, logLevel: 'warning',
}).then(() => console.log('sdk.mjs staged'));
"""

if __name__ == '__main__':
    main()
