#!/usr/bin/env python3
"""Open Tuna dev server: serves the project (never cached) + lets the editor save story.json.

    python3 tools/serve.py            -> http://localhost:8123/        (the site)
    python3 tools/serve.py --open     -> also opens http://localhost:8123/?edit  (the editor)
    python3 tools/serve.py 8200       -> another port

Endpoints used by the editor (src/editor/editor.js):
    GET  /__editor/ping   {"ok": true, "save": true}
    POST /__editor/save   body = story.json text -> written atomically to <project>/story.json
Only listens on 127.0.0.1. Stdlib only. tools/serve.ps1 is the same server for Windows without Python.
"""
import http.server
import json
import os
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORY = os.path.join(ROOT, 'story.json')
TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
    '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
}


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128  # the page fetches many modules / models at once (default 5 -> refused connections)
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')  # always serve the latest modules / story.json
        super().end_headers()

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split('?')[0] == '/__editor/ping':
            return self.reply(200, {'ok': True, 'save': True})
        super().do_GET()

    def do_POST(self):
        if self.path.split('?')[0] != '/__editor/save':
            return self.reply(404, {'ok': False, 'error': 'unknown endpoint'})
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        try:
            data = json.loads(body)
            if not isinstance(data, dict) or not isinstance(data.get('tracks'), list):
                raise ValueError('not a story.json (no "tracks" list)')
        except Exception as e:  # noqa: BLE001 - report any parse problem to the editor
            return self.reply(400, {'ok': False, 'error': str(e)})
        tmp = STORY + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(body)
        os.replace(tmp, STORY)
        print(f'  saved story.json ({len(body)} bytes)')
        self.reply(200, {'ok': True})

    def log_message(self, fmt, *args):
        if len(args) > 1 and str(args[1])[:1] in '45':  # only log errors
            super().log_message(fmt, *args)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    port = int(args[0]) if args else 8123
    for p in range(port, port + 20):
        try:
            server = Server(('127.0.0.1', p), Handler)
            break
        except OSError:
            continue
    else:
        sys.exit(f'No free port between {port} and {port + 19}')
    base = f'http://localhost:{p}/'
    print(f'\n  Open Tuna dev server - {ROOT}\n')
    print(f'  Editor : {base}?edit')
    print(f'  Site   : {base}')
    print(f'  Lab    : {base}?lab\n')
    print('  Use Chrome or Edge (WebGPU). Keep this window open; Ctrl+C to stop.\n')
    if '--open' in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(f'{base}?edit')).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
