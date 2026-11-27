#!/usr/bin/env python3
"""
Static file server for the vscode-web site with the cross-origin isolation
headers nodine requires (COOP: same-origin, COEP: credentialless) plus the
Service-Worker-Allowed header for the nodine preview service worker.

This mirrors what a production host must send (Cloudflare Pages: use a
`_headers` file with the same three rules — see docs/DEPLOY-CLOUDFLARE.md).

Usage: python3 serve_isolated.py [port] [root]
"""
import os
import sys
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
ROOT = sys.argv[2] if len(sys.argv) > 2 else '/home/z/my-project/vscode-web'


class IsolatedHandler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        # Cross-origin isolation — REQUIRED by nodine (SharedArrayBuffer + WASM threads)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        # nodine preview service worker is served from /nodine/ but scopes '/'
        self.send_header('Service-Worker-Allowed', '/')
        # don't cache the runtime (matches nodine's demo server)
        if self.path.startswith('/nodine/') or self.path.endswith('.html'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def do_GET(self):
        # VSCODE_WEBVIEW_ORIGIN: the workbench bundle's webview endpoint points
        # at our own origin (self-hosted webview bootstrap under
        # /out/vs/workbench/contrib/webview/browser/pre/) — rewrite the
        # placeholder per request so any host (localhost, LAN IP) works.
        path = self.translate_path(self.path)
        if path.endswith(('.js', '.html')) and os.path.isfile(path):
            with open(path, 'rb') as f:
                body = f.read()
            if b'VSCODE_WEBVIEW_ORIGIN' in body:
                host = self.headers.get('Host') or f'127.0.0.1:{PORT}'
                body = body.replace(b'VSCODE_WEBVIEW_ORIGIN', ('http://' + host).encode())
                self.send_response(200)
                ctype = 'application/javascript' if path.endswith('.js') else 'text/html; charset=utf-8'
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
                return
        super().do_GET()


if __name__ == '__main__':
    server = ThreadingHTTPServer(('0.0.0.0', PORT), partial(IsolatedHandler, directory=ROOT))
    print(f'serving {ROOT} on 0.0.0.0:{PORT} (COOP/COEP isolated)')
    sys.stderr.write('ready\n')
    server.serve_forever()
