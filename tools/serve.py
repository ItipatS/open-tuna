#!/usr/bin/env python3
"""Open Tuna Studio server: serves the tool (never cached) + the editor's project / save API.

    python3 tools/serve.py            -> http://localhost:8123/   (the studio home: demos, new / open / recent projects)
    python3 tools/serve.py --open     -> also opens it in the browser
    python3 tools/serve.py 8200       -> another port

Shared / company server (see docs/deploy.md — it needs HTTPS in front, WebGPU only runs on https:// or localhost):
    --host 0.0.0.0      listen on every interface (default 127.0.0.1: this computer only)
    --password          ask for a password (HTTP Basic, any user name); the value comes from the environment
                        variable OPEN_TUNA_PASSWORD (`--password=secret` also works but shows in the process list)
    --no-git            turn off the git endpoints (commit / push with the server's credentials)

Editor endpoints (src/editor/saves.js, src/editor/project.js). Stdlib only.
tools/serve.ps1 is the same server for Windows machines without Python - keep them in sync.

Story endpoints take ?project=<id>: `demo/<id>` = demos/<id>/ (demo projects that ship with the tool, committed) or
`<slug>` = projects/<slug>/ (working copies of .tuna files, gitignored). Each holds story.json, manifest.json,
assets/, saves/. Paths in requests / replies are relative to that folder; the tool's built-in models are models/*.glb.
    GET  /__editor/ping                  {ok, save, git, branch}
    POST /__editor/save                  body = story.json; the previous story.json is kept in saves/auto/.
                                         Header X-Base-Hash = FNV-1a of the story.json the editor loaded; if the file
                                         changed on disk since (Claude / another tab), 409 {conflict, current} unless
                                         X-Force: 1. Saves without the header (old editor tabs) are refused.
    POST /__editor/checkpoint?name=...   body = story.json -> saves/checkpoints/<stamp>_<name>.json
    GET  /__editor/list                  checkpoints, autosaves, git history of story.json (demos only)
    GET  /__editor/load?file=<path>      story.json or a file in saves/  |  ?git=<commit>  (story.json at that commit)
    POST /__editor/delete?file=<path>    delete a checkpoint
    POST /__editor/upload?name=file.png  body = file bytes -> assets/<name> (never overwrites) -> {file}
    GET  /__editor/assets                every file under assets/ {file, size, mtime} + models/*.glb (builtin)
    POST /__editor/asset-delete?file=    delete one file under assets/
    GET  /__editor/files                 what a .tuna holds: story.json, assets/**, saves/checkpoints/*.json
    GET  /__editor/projects              {projects: working copies in projects/, demos: demos/} each {project, name, mtime, thumb}
    POST /__editor/project/new?name=     make projects/<slug>/ -> {project}; &from=demo/<id> fills it with a copy of that
                                         demo (story.json, assets/, saves/checkpoints/) — "open a copy of the demo"
    POST /__editor/put?project=&file=    body = bytes -> one file of a project (story.json, manifest.json, thumb.*,
                                         assets/**, saves/checkpoints/*.json); overwrites. Projects only.
    GET  /__editor/git/status            {branch, upstream, changes}                       (demos only)
    POST /__editor/git/commit            body {message} -> commits that demo's folder        (demos only)
    POST /__editor/git/push              pushes the current branch                         (demos only)
"""
import base64
import datetime
import hmac
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
PROJECTS = os.path.join(ROOT, 'projects')
DEMOS = os.path.join(ROOT, 'demos')
MODELS = os.path.join(ROOT, 'models')
UPLOAD_EXT = {'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'mp4', 'webm', 'mov', 'm4v', 'html', 'htm', 'mp3', 'ogg', 'wav', 'json', 'glb', 'gltf'}
SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,62}')
KEEP_AUTO = 100
TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
    '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
}
LOCK = threading.Lock()
OPTS = {'password': '', 'git': True}  # set from the command line in main()


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


def fnv1a(data):
    h = 0x811c9dc5
    for b in data:
        h = ((h ^ b) * 0x01000193) & 0xffffffff
    return f'{h:08x}'


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


class Proj:
    """A project: demo/<id> (demos/<id>/, part of the tool, committed) or <slug> (projects/<slug>/, a .tuna working copy)."""

    def __init__(self, slug=''):
        if not slug:
            raise ValueError('no project: open one from the studio home')
        self.demo = slug.startswith('demo/')
        name = slug[5:] if self.demo else slug
        if not SLUG.fullmatch(name):
            raise ValueError('bad project name')
        self.root = os.path.join(DEMOS if self.demo else PROJECTS, name)
        if not os.path.isdir(self.root):
            raise ValueError(f'no project "{slug}"' + ('' if self.demo else ' (open its .tuna file again)'))
        self.slug = slug
        self.git_rel = f'demos/{name}' if self.demo else ''
        self.story = os.path.join(self.root, 'story.json')
        self.saves = os.path.join(self.root, 'saves')
        self.auto = os.path.join(self.saves, 'auto')
        self.check = os.path.join(self.saves, 'checkpoints')
        self.assets = os.path.join(self.root, 'assets')

    def rel(self, p):
        return os.path.relpath(p, self.root).replace(os.sep, '/')

    def inside(self, rel):
        p = os.path.normpath(os.path.join(self.root, rel or ''))
        if not p.startswith(self.root + os.sep):
            raise ValueError('path outside the project')
        return p

    def safe_file(self, rel):
        """story.json or a .json inside saves/ - nothing else can be read or deleted."""
        p = os.path.normpath(os.path.join(self.root, rel or 'story.json'))
        if p == self.story or (p.startswith(self.saves + os.sep) and p.endswith('.json')):
            return p
        raise ValueError('file not allowed')

    def listing(self, folder):
        if not os.path.isdir(folder):
            return []
        out = []
        for f in sorted(os.listdir(folder), reverse=True):
            if not f.endswith('.json'):
                continue
            p = os.path.join(folder, f)
            m = re.match(r'(\d{4}-\d\d-\d\d)_(\d\d)(\d\d)(\d\d)_?(.*)\.json$', f)
            out.append({
                'file': self.rel(p),
                'name': (m.group(5).replace('-', ' ') if m and m.group(5) else '') or f[:-5],
                'time': f'{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}' if m else '',
                'size': os.path.getsize(p),
            })
        return out

    def files(self, folder):
        out = []
        for dirpath, _, names in os.walk(folder):
            for n in sorted(names):
                if n.endswith('.tmp'):
                    continue
                full = os.path.join(dirpath, n)
                out.append({'file': self.rel(full), 'size': os.path.getsize(full), 'mtime': int(os.path.getmtime(full))})
        return out

    def putable(self, rel):
        """Where a .tuna's files may be written: story.json, manifest.json, thumb.*, assets/**, saves/checkpoints/*.json."""
        rel = (rel or '').replace('\\', '/')
        p = self.inside(rel)
        r = self.rel(p)
        ext = r.rsplit('.', 1)[-1].lower() if '.' in r else ''
        if r in ('story.json', 'manifest.json', 'thumb.webp', 'thumb.png', 'thumb.jpg') \
                or (r.startswith('assets/') and ext in UPLOAD_EXT) \
                or (r.startswith('saves/checkpoints/') and ext == 'json' and r.count('/') == 2):
            return p
        raise ValueError(f'{rel} can\'t be part of a project')


def project_list(folder, prefix):
    """The projects in projects/ or demos/: {project, name (manifest), mtime, thumb}, newest first."""
    out = []
    if not os.path.isdir(folder):
        return out
    for slug in os.listdir(folder):
        d = os.path.join(folder, slug)
        if not SLUG.fullmatch(slug) or not os.path.isfile(os.path.join(d, 'story.json')):
            continue
        name = slug
        try:
            with open(os.path.join(d, 'manifest.json'), encoding='utf-8') as f:
                name = json.load(f).get('name') or slug
        except (OSError, ValueError):
            pass
        rel = os.path.relpath(d, ROOT).replace(os.sep, '/')
        thumb = next((f'{rel}/{t}' for t in ('thumb.webp', 'thumb.png', 'thumb.jpg') if os.path.isfile(os.path.join(d, t))), '')
        out.append({'project': f'{prefix}{slug}', 'name': name, 'mtime': int(os.path.getmtime(os.path.join(d, 'story.json'))), 'thumb': thumb})
    out.sort(key=lambda p: -p['mtime'])
    return out


def slugify(name):
    return re.sub(r'[^a-z0-9]+', '-', (name or '').lower()).strip('-')[:48] or 'project'


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128  # the page fetches many modules / models at once (default 5 -> refused connections)
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')  # always serve the latest modules / story.json
        self.send_header('Accept-Ranges', 'bytes')
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

    def ranged(self):
        """Byte-range GET (206): browsers need it to seek in videos. Returns False to fall back to a full GET."""
        fs_path = self.translate_path(self.path)
        m = re.match(r'bytes=(\d*)-(\d*)$', self.headers.get('Range', '').strip())
        if not m or not os.path.isfile(fs_path):
            return False
        size = os.path.getsize(fs_path)
        if m.group(1):
            start, end = int(m.group(1)), int(m.group(2)) if m.group(2) else size - 1
        else:
            start, end = max(0, size - int(m.group(2) or 0)), size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.end_headers()
            return True
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(fs_path))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        with open(fs_path, 'rb') as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                left -= len(chunk)
        return True

    def body(self):
        return self.rfile.read(int(self.headers.get('Content-Length', 0)))

    def route(self):
        u = urllib.parse.urlparse(self.path)
        return u.path, {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}

    def authorized(self):
        """--password: HTTP Basic (any user name). Sends the 401 challenge and returns False when it doesn't match."""
        if not OPTS['password']:
            return True
        h = self.headers.get('Authorization', '')
        try:
            pw = base64.b64decode(h[6:]).decode('utf-8').split(':', 1)[1] if h.startswith('Basic ') else ''
        except (ValueError, IndexError):
            pw = ''
        if hmac.compare_digest(pw.encode(), OPTS['password'].encode()):
            return True
        body = b'Password required'
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="Open Tuna Studio", charset="UTF-8"')
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    def do_HEAD(self):
        if self.authorized():
            super().do_HEAD()

    def do_GET(self):
        if not self.authorized():
            return None
        path, q = self.route()
        if not path.startswith('/__editor/'):
            if self.headers.get('Range') and self.ranged():
                return None
            return super().do_GET()
        try:
            if path == '/__editor/projects':
                return self.reply(200, {'projects': project_list(PROJECTS, ''), 'demos': project_list(DEMOS, 'demo/')})
            if path == '/__editor/ping':
                P = Proj(q['project']) if q.get('project') else None
                g = OPTS['git'] and bool(P and P.demo) and has_git()
                return self.reply(200, {'ok': True, 'save': True, 'git': g, 'branch': git('branch', '--show-current')[1] if g else ''})
            P = Proj(q.get('project', ''))
            if path == '/__editor/list':
                hist = []
                if P.demo and has_git():
                    code, out = git('log', '-n', '60', '--format=%h|%cI|%an|%s', '--', f'{P.git_rel}/story.json')
                    if code == 0:
                        for line in out.splitlines():
                            h, d, a, s = (line.split('|', 3) + ['', '', ''])[:4]
                            hist.append({'hash': h, 'time': d[:19].replace('T', ' '), 'author': a, 'subject': s})
                return self.reply(200, {'checkpoints': P.listing(P.check), 'autos': P.listing(P.auto), 'git': hist})
            if path == '/__editor/load':
                if 'git' in q:
                    if not P.demo or not re.fullmatch(r'[0-9a-fA-F]{4,40}', q['git']):
                        raise ValueError('bad commit')
                    code, out = git('show', f"{q['git']}:{P.git_rel}/story.json")
                    if code:
                        raise ValueError(out)
                    return self.raw(out.encode('utf-8'))
                with open(P.safe_file(q.get('file', 'story.json')), 'rb') as f:
                    return self.raw(f.read())
            if path == '/__editor/assets':
                out = sorted(P.files(P.assets), key=lambda a: -a['mtime'])
                # the tool's own creature / reef models (models/) are assets too, but can't be deleted
                for n in sorted(os.listdir(MODELS)) if os.path.isdir(MODELS) else []:
                    if n.lower().endswith(('.glb', '.gltf')):
                        full = os.path.join(MODELS, n)
                        out.append({'file': f'models/{n}', 'size': os.path.getsize(full), 'mtime': int(os.path.getmtime(full)), 'builtin': True})
                return self.reply(200, {'assets': out})
            if path == '/__editor/files':
                out = P.files(P.assets) + P.files(P.check)
                if os.path.isfile(P.story):
                    out.insert(0, {'file': 'story.json', 'size': os.path.getsize(P.story), 'mtime': int(os.path.getmtime(P.story))})
                return self.reply(200, {'files': out})
            if path == '/__editor/git/status':
                if not P.demo or not OPTS['git'] or not has_git():
                    return self.reply(200, {'git': False})
                br = git('branch', '--show-current')[1]
                up = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
                ch = git('status', '--porcelain', '--', P.git_rel)[1]
                ahead = git('rev-list', '--count', '@{u}..HEAD')[1] if up[0] == 0 else ''
                return self.reply(200, {'git': True, 'branch': br, 'upstream': up[1] if up[0] == 0 else '', 'ahead': ahead, 'changes': [l for l in ch.splitlines() if l.strip()]})
        except Exception as e:  # noqa: BLE001 - report to the editor
            return self.reply(400, {'ok': False, 'error': str(e)})
        return self.reply(404, {'ok': False, 'error': 'unknown endpoint'})

    def do_POST(self):
        if not self.authorized():
            return None
        path, q = self.route()
        try:
            with LOCK:
                if path == '/__editor/project/new':
                    base = slugify(q.get('name', ''))
                    slug, n = base, 1
                    while os.path.exists(os.path.join(PROJECTS, slug)):
                        n += 1
                        slug = f'{base}-{n}'
                    src = Proj(q['from']) if q.get('from') else None
                    if src and not src.demo:
                        raise ValueError('only demos can be copied this way (open the .tuna instead)')
                    d = os.path.join(PROJECTS, slug)
                    os.makedirs(d)
                    if src:  # a copy of a demo to play with
                        shutil.copyfile(src.story, os.path.join(d, 'story.json'))  # a fresh date: it's a new project
                        if os.path.isdir(src.assets):
                            shutil.copytree(src.assets, os.path.join(d, 'assets'))
                        if os.path.isdir(src.check):
                            shutil.copytree(src.check, os.path.join(d, 'saves', 'checkpoints'))
                        for t in ('thumb.webp', 'thumb.png', 'thumb.jpg'):  # its picture on the home page until the first save
                            if os.path.isfile(os.path.join(src.root, t)):
                                shutil.copyfile(os.path.join(src.root, t), os.path.join(d, t))
                        write(os.path.join(d, 'manifest.json'), json.dumps({'format': 'open-tuna', 'version': 1, 'name': q.get('name') or slug, 'created': datetime.datetime.now().isoformat(timespec='seconds')}, indent=2).encode())
                    return self.reply(200, {'ok': True, 'project': slug})
                P = Proj(q.get('project', ''))
                if path == '/__editor/put':
                    if P.demo:
                        raise ValueError('put only writes into projects/')
                    p = P.putable(q.get('file', ''))
                    body = self.body()
                    if P.rel(p) == 'story.json':
                        valid_story(body)
                    write(p, body)
                    return self.reply(200, {'ok': True, 'file': P.rel(p)})
                if path == '/__editor/save':
                    body = self.body()
                    valid_story(body)
                    if os.path.exists(P.story):
                        with open(P.story, 'rb') as f:
                            old = f.read()
                        base = self.headers.get('X-Base-Hash')
                        if self.headers.get('X-Force') != '1' and base != fnv1a(old):
                            return self.reply(409, {'ok': False, 'conflict': True, 'error': 'story.json changed on disk since the editor loaded it' if base else 'this editor tab is out of date - reload it', 'current': old.decode('utf-8', 'replace')})
                        if old != body:  # keep the previous version
                            write(os.path.join(P.auto, f'{stamp()}.json'), old)
                            for f in P.listing(P.auto)[KEEP_AUTO:]:
                                os.remove(os.path.join(P.root, f['file']))
                    write(P.story, body)
                    return self.reply(200, {'ok': True})
                if path == '/__editor/checkpoint':
                    body = self.body()
                    valid_story(body)
                    slug = re.sub(r'[^A-Za-z0-9]+', '-', q.get('name', '')).strip('-')[:60] or 'checkpoint'
                    p = os.path.join(P.check, f'{stamp()}_{slug}.json')
                    write(p, body)
                    return self.reply(200, {'ok': True, 'file': P.rel(p)})
                if path == '/__editor/upload':
                    name = os.path.basename(q.get('name', 'file'))
                    stem, ext = os.path.splitext(name)
                    ext = ext.lower().lstrip('.')
                    if ext not in UPLOAD_EXT:
                        raise ValueError(f'.{ext} files are not allowed')
                    stem = re.sub(r'[^A-Za-z0-9_-]+', '-', stem).strip('-')[:60] or 'file'
                    p, n = os.path.join(P.assets, f'{stem}.{ext}'), 1
                    body = self.body()
                    while os.path.exists(p):
                        with open(p, 'rb') as f:
                            if f.read() == body:  # same file uploaded again: reuse it
                                break
                        n += 1
                        p = os.path.join(P.assets, f'{stem}-{n}.{ext}')
                    else:
                        write(p, body)
                    return self.reply(200, {'ok': True, 'file': P.rel(p)})
                if path == '/__editor/asset-delete':
                    p = os.path.normpath(os.path.join(P.root, q.get('file', '')))
                    if not p.startswith(P.assets + os.sep) or not os.path.isfile(p):
                        raise ValueError('not a file in assets/')
                    os.remove(p)
                    return self.reply(200, {'ok': True})
                if path == '/__editor/delete':
                    p = P.safe_file(q.get('file'))
                    if not p.startswith(P.check + os.sep):
                        raise ValueError('only checkpoints can be deleted')
                    os.remove(p)
                    return self.reply(200, {'ok': True})
                if path in ('/__editor/git/commit', '/__editor/git/push') and not P.demo:
                    raise ValueError('a .tuna project is saved as a file, not to git')
                if path in ('/__editor/git/commit', '/__editor/git/push') and not OPTS['git']:
                    raise ValueError('git is turned off on this server (--no-git)')
                if path == '/__editor/git/commit':
                    msg = (json.loads(self.body() or b'{}').get('message') or '').strip() or 'Update story'
                    paths = [P.git_rel]
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
    argv = sys.argv[1:]
    host = '127.0.0.1'
    if '--host' in argv:
        host = argv[argv.index('--host') + 1]
        del argv[argv.index('--host'):argv.index('--host') + 2]
    pw = next((a.split('=', 1)[1] for a in argv if a.startswith('--password=')), None)
    if pw is None and '--password' in argv:
        pw = os.environ.get('OPEN_TUNA_PASSWORD', '')
        if not pw:
            sys.exit('--password: set the OPEN_TUNA_PASSWORD environment variable')
    OPTS.update(password=pw or '', git='--no-git' not in argv)
    if host not in ('127.0.0.1', 'localhost') and not OPTS['password']:
        print('\n  WARNING: listening beyond this computer WITHOUT a password: anyone who can reach it can change the\n'
              '  story, upload files and use git. Add --password (and --no-git).\n')
    args = [a for a in argv if not a.startswith('--')]
    port = int(args[0]) if args else 8123
    for p in range(port, port + 20):
        try:
            server = Server((host, p), Handler)
            break
        except OSError:
            continue
    else:
        sys.exit(f'No free port between {port} and {port + 19}')
    base = f'http://localhost:{p}/'
    print(f'\n  Open Tuna dev server - {ROOT}\n')
    print(f'  Studio : {base}   (demos, new / open / recent projects)')
    print(f'  Demo   : {base}play.html?project=demo/thai-union')
    print(f'  Lab    : {base}play.html?lab')
    if host not in ('127.0.0.1', 'localhost'):
        print(f'  Listening on {host}:{p}{" · password on" if OPTS["password"] else ""}{" · git off" if not OPTS["git"] else ""}')
    print()
    print('  Use Chrome or Edge (WebGPU). Keep this window open; Ctrl+C to stop.\n')
    if not shutil.which('git'):
        print('  (git not found: the editor\'s Git menu is disabled)\n')
    if '--open' in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(base)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
