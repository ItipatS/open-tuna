#!/usr/bin/env python3
"""Open Tuna dev server: serves the project (never cached) + the editor's save system.

    python3 tools/serve.py            -> http://localhost:8123/        (the site)
    python3 tools/serve.py --open     -> also opens http://localhost:8123/?edit  (the editor)
    python3 tools/serve.py 8200       -> another port

Editor endpoints (src/editor/saves.js). Only listens on 127.0.0.1. Stdlib only.
tools/serve.ps1 is the same server for Windows machines without Python - keep them in sync.
    GET  /__editor/ping                  {ok, save, git, branch}
    POST /__editor/save                  body = story.json; the previous story.json is kept in saves/auto/
    POST /__editor/checkpoint?name=...   body = story.json -> saves/checkpoints/<stamp>_<name>.json
    GET  /__editor/list                  checkpoints, autosaves, git history of story.json
    GET  /__editor/load?file=<path>      story.json or a file in saves/  |  ?git=<commit>  (story.json at that commit)
    POST /__editor/delete?file=<path>    delete a checkpoint
    GET  /__editor/git/status            {branch, upstream, changes}
    POST /__editor/git/commit            body {message} -> commits story.json + saves/checkpoints
    POST /__editor/git/push              pushes the current branch
"""
import datetime
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.parse
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORY = os.path.join(ROOT, 'story.json')
AUTO = os.path.join(ROOT, 'saves', 'auto')
CHECK = os.path.join(ROOT, 'saves', 'checkpoints')
KEEP_AUTO = 100
TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
    '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
}
LOCK = threading.Lock()


def stamp():
    return datetime.datetime.now().strftime('%Y-%m-%d_%H%M%S')


def git(*args, timeout=60):
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=timeout, env=env)
    return r.returncode, (r.stdout + r.stderr).strip()


def has_git():
    try:
        return git('rev-parse', '--is-inside-work-tree', timeout=10)[0] == 0
    except (OSError, subprocess.SubprocessError):
        return False


def valid_story(body):
    data = json.loads(body)
    if not isinstance(data, dict) or not isinstance(data.get('tracks'), list):
        raise ValueError('not a story.json (no "tracks" list)')


def write(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(body)
    os.replace(tmp, path)


def listing(folder):
    if not os.path.isdir(folder):
        return []
    out = []
    for f in sorted(os.listdir(folder), reverse=True):
        if not f.endswith('.json'):
            continue
        p = os.path.join(folder, f)
        m = re.match(r'(\d{4}-\d\d-\d\d)_(\d\d)(\d\d)(\d\d)_?(.*)\.json$', f)
        out.append({
            'file': os.path.relpath(p, ROOT).replace(os.sep, '/'),
            'name': (m.group(5).replace('-', ' ') if m and m.group(5) else '') or f[:-5],
            'time': f'{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}' if m else '',
            'size': os.path.getsize(p),
        })
    return out


def safe_file(rel):
    """story.json or a .json inside saves/ - nothing else can be read or deleted."""
    p = os.path.normpath(os.path.join(ROOT, rel or ''))
    saves = os.path.join(ROOT, 'saves') + os.sep
    if p == STORY or (p.startswith(saves) and p.endswith('.json')):
        return p
    raise ValueError('file not allowed')


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

    def raw(self, body):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        return self.rfile.read(int(self.headers.get('Content-Length', 0)))

    def route(self):
        u = urllib.parse.urlparse(self.path)
        return u.path, {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}

    def do_GET(self):
        path, q = self.route()
        if not path.startswith('/__editor/'):
            return super().do_GET()
        try:
            if path == '/__editor/ping':
                g = has_git()
                return self.reply(200, {'ok': True, 'save': True, 'git': g, 'branch': git('branch', '--show-current')[1] if g else ''})
            if path == '/__editor/list':
                hist = []
                if has_git():
                    code, out = git('log', '-n', '60', '--format=%h|%cI|%an|%s', '--', 'story.json')
                    if code == 0:
                        for line in out.splitlines():
                            h, d, a, s = (line.split('|', 3) + ['', '', ''])[:4]
                            hist.append({'hash': h, 'time': d[:19].replace('T', ' '), 'author': a, 'subject': s})
                return self.reply(200, {'checkpoints': listing(CHECK), 'autos': listing(AUTO), 'git': hist})
            if path == '/__editor/load':
                if 'git' in q:
                    if not re.fullmatch(r'[0-9a-fA-F]{4,40}', q['git']):
                        raise ValueError('bad commit')
                    code, out = git('show', f"{q['git']}:story.json")
                    if code:
                        raise ValueError(out)
                    return self.raw(out.encode('utf-8'))
                with open(safe_file(q.get('file', 'story.json')), 'rb') as f:
                    return self.raw(f.read())
            if path == '/__editor/git/status':
                if not has_git():
                    return self.reply(200, {'git': False})
                br = git('branch', '--show-current')[1]
                up = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
                ch = git('status', '--porcelain', '--', 'story.json', 'saves/checkpoints')[1]
                ahead = git('rev-list', '--count', '@{u}..HEAD')[1] if up[0] == 0 else ''
                return self.reply(200, {'git': True, 'branch': br, 'upstream': up[1] if up[0] == 0 else '', 'ahead': ahead, 'changes': [l for l in ch.splitlines() if l.strip()]})
        except Exception as e:  # noqa: BLE001 - report to the editor
            return self.reply(400, {'ok': False, 'error': str(e)})
        return self.reply(404, {'ok': False, 'error': 'unknown endpoint'})

    def do_POST(self):
        path, q = self.route()
        try:
            with LOCK:
                if path == '/__editor/save':
                    body = self.body()
                    valid_story(body)
                    if os.path.exists(STORY):
                        with open(STORY, 'rb') as f:
                            old = f.read()
                        if old != body:  # keep the previous version
                            write(os.path.join(AUTO, f'{stamp()}.json'), old)
                            for f in listing(AUTO)[KEEP_AUTO:]:
                                os.remove(os.path.join(ROOT, f['file']))
                    write(STORY, body)
                    return self.reply(200, {'ok': True})
                if path == '/__editor/checkpoint':
                    body = self.body()
                    valid_story(body)
                    slug = re.sub(r'[^A-Za-z0-9]+', '-', q.get('name', '')).strip('-')[:60] or 'checkpoint'
                    p = os.path.join(CHECK, f'{stamp()}_{slug}.json')
                    write(p, body)
                    return self.reply(200, {'ok': True, 'file': os.path.relpath(p, ROOT).replace(os.sep, '/')})
                if path == '/__editor/delete':
                    p = safe_file(q.get('file'))
                    if not p.startswith(CHECK + os.sep):
                        raise ValueError('only checkpoints can be deleted')
                    os.remove(p)
                    return self.reply(200, {'ok': True})
                if path == '/__editor/git/commit':
                    msg = (json.loads(self.body() or b'{}').get('message') or '').strip() or 'Update story'
                    paths = ['story.json'] + (['saves/checkpoints'] if os.path.isdir(CHECK) and os.listdir(CHECK) else [])
                    code, out = git('add', '--', *paths)
                    if code == 0:
                        code, out = git('commit', '-m', msg, '--', *paths)
                    return self.reply(200 if code == 0 else 400, {'ok': code == 0, 'output': out, 'error': '' if code == 0 else out})
                if path == '/__editor/git/push':
                    up = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
                    code, out = git('push') if up[0] == 0 else git('push', '-u', 'origin', 'HEAD')
                    return self.reply(200 if code == 0 else 400, {'ok': code == 0, 'output': out, 'error': '' if code == 0 else out})
        except Exception as e:  # noqa: BLE001 - report to the editor
            return self.reply(400, {'ok': False, 'error': str(e)})
        return self.reply(404, {'ok': False, 'error': 'unknown endpoint'})

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
    if not shutil.which('git'):
        print('  (git not found: the editor\'s Git menu is disabled)\n')
    if '--open' in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(f'{base}?edit')).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
