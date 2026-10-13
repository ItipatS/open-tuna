"""Live team editing for tools/serve.py: one shared story per project, an edit log, presence, rewind.

The story model (entities, changes, apply / diff / invert) is the same as src/editor/doc.js - keep them in sync.
A change is {e, set: {field: [before, after]}} | {e, add: fields} | {e, del: fields}; None / null = no such field.

Every editor tab of a project (any computer that reaches this server) is a client:
    GET  sync/state                     {text (story.json), seq, epoch}: join
    POST sync/push                      {client, user, id, label, changes} -> {seq}: one committed edit (or an undo)
    GET  sync/poll?since=&epoch=&pv=    long-poll (25 s): {ops after `since`, seq, presence (if pv changed), pv}
                                        or {reset: true} when the server restarted / the log was replaced
    POST sync/presence                  {client, user, color, t, sel, view}: who is here, where, what they selected
    GET  sync/history?before=&limit=    the log, newest first: [{seq, user, time, label, n}]
    GET  sync/at?seq=                   story.json as it was right after edit `seq` (rewind preview / compare)
    POST sync/restore?seq=              {user}: make the story what it was after `seq` (a new edit: undoable, logged)
    POST sync/revert?seq=               {user}: undo only edit `seq` (fields changed since by others are kept)
The server applies edits in arrival order (last writer wins per field), writes story.json after each one, appends
them to saves/history.jsonl, and turns outside changes of story.json (Claude, git, a text editor) into edits too.
"""
import json
import math
import os
import random
import threading
import time

ABC = 'abcdefghijklmnopqrstuvwxyz0123456789'
TOP = {'meta', 'settings', 'tracks', 'chapters', 'notes'}
KC = {'keys', 'clips'}
BACKUP_EVERY = 600  # s: keep a copy of story.json in saves/auto/ at most this often while live editing
PRESENCE_TTL = 15


def uid(n=6):
    return random.choice(ABC[:26]) + ''.join(random.choice(ABC) for _ in range(n - 1))


def clone(v):
    return json.loads(json.dumps(v)) if isinstance(v, (dict, list)) else v


def own(o, skip=()):
    return {k: v for k, v in o.items() if k not in skip}


def sig(o):
    return json.dumps(sorted([k, v] for k, v in o.items() if k not in ('id', 'locked', 'lockedBy')), separators=(',', ':'))


def ensure_ids(d, prev=None):
    """Same as doc.js ensureIds: unique ids everywhere; an item without one reuses the id of an identical item in prev."""
    n = 0
    pool = {}
    if prev:
        def put(scope, o):
            if isinstance(o, dict) and o.get('id'):
                pool.setdefault(scope, {}).setdefault(sig(o), []).append(o['id'])
        for t in prev.get('tracks') or []:
            for k in t.get('keys') or []:
                put('k' + str(t.get('id')), k)
            for c in t.get('clips') or []:
                put('c' + str(t.get('id')), c)
        for c in prev.get('chapters') or []:
            put('ch', c)
        for x in prev.get('notes') or []:
            put('n', x)
    seen = set()

    def fix(scope, o):
        nonlocal n
        if not isinstance(o, dict):
            return
        if not o.get('id') or o['id'] in seen:
            ids = pool.get(scope, {}).get(sig(o), [])
            new = None
            while ids:
                cand = ids.pop(0)
                if cand not in seen:
                    new = cand
                    break
            while not new or new in seen:
                new = uid()
            o['id'] = new
            n += 1
        seen.add(o['id'])
    tids = set()
    for t in d.get('tracks') or []:
        if not t.get('id') or t['id'] in tids:
            t['id'] = f"{t.get('type') or 'track'}-{uid()}"
            n += 1
        tids.add(t['id'])
    for t in d.get('tracks') or []:
        for k in t.get('keys') or []:
            fix('k' + t['id'], k)
        for c in t.get('clips') or []:
            fix('c' + t['id'], c)
    for c in d.get('chapters') or []:
        fix('ch', c)
    for x in d.get('notes') or []:
        fix('n', x)
    return n


def entities(d):
    m = {}
    m['doc'] = own(d, TOP)
    m['meta'] = dict(d.get('meta') or {})
    m['settings'] = own(d.get('settings') or {}, ('params',))
    m['params'] = dict((d.get('settings') or {}).get('params') or {})
    m['order'] = {'tracks': [t.get('id') for t in d.get('tracks') or []]}
    for t in d.get('tracks') or []:
        f = own(t, KC)
        if 'keys' in t:
            f['keys'] = []
        if 'clips' in t:
            f['clips'] = []
        m[f"t:{t['id']}"] = f
        for k in t.get('keys') or []:
            m[f"k:{t['id']}:{k['id']}"] = k
        for c in t.get('clips') or []:
            m[f"c:{t['id']}:{c['id']}"] = c
    for c in d.get('chapters') or []:
        m[f"ch:{c['id']}"] = c
    for x in d.get('notes') or []:
        m[f"n:{x['id']}"] = x
    return m


def diff(A, B):
    out = []
    for e, b in B.items():
        a = A.get(e)
        if a is None:
            out.append({'e': e, 'add': clone(b)})
            continue
        s = {}
        for f in set(a) | set(b):
            x, y = a.get(f), b.get(f)
            if x != y:
                s[f] = [clone(x), clone(y)]
        if s:
            out.append({'e': e, 'set': s})
    for e, a in A.items():
        if e not in B:
            out.append({'e': e, 'del': clone(a)})
    return out


def parse_key(e):
    if ':' not in e:
        return {'kind': e}
    kind, rest = e.split(':', 1)
    if kind in ('k', 'c'):
        tr, _, i = rest.rpartition(':')
        return {'kind': kind, 'track': tr, 'id': i}
    return {'kind': kind, 'id': rest}


def locate(d, e, make=False):
    p = parse_key(e)
    k = p['kind']

    def box(o, key):
        if make and not isinstance(o.get(key), (dict, list)):
            o[key] = [] if key in ('tracks', 'keys', 'clips', 'chapters', 'notes') else {}
        return o.get(key)
    if k == 'doc':
        return d, None
    if k in ('meta', 'settings'):
        return box(d, k), None
    if k == 'params':
        s = box(d, 'settings')
        return (box(s, 'params') if isinstance(s, dict) else None), None
    if k == 't':
        arr = box(d, 'tracks')
        return next((t for t in arr or [] if t.get('id') == p['id']), None), arr
    if k in ('k', 'c'):
        t = next((q for q in d.get('tracks') or [] if q.get('id') == p['track']), None)
        arr = box(t, 'keys' if k == 'k' else 'clips') if t is not None else None
        return next((x for x in arr or [] if x.get('id') == p['id']), None), arr
    if k in ('ch', 'n'):
        arr = box(d, 'chapters' if k == 'ch' else 'notes')
        return next((x for x in arr or [] if x.get('id') == p['id']), None), arr
    return None, None


def guarded(e, f):
    return (e == 'doc' and f in TOP) or (e == 'settings' and f == 'params') or (e.startswith('t:') and f in KC) or f == 'id'


def rank(c):
    if c['e'].startswith('t:'):
        return 0 if 'add' in c else 4 if 'del' in c else 1
    return 3 if c['e'] == 'order' else 2


def set_fields(obj, e, s, out):
    r = {}
    for f, ba in s.items():
        if guarded(e, f):
            continue
        before, after = obj.get(f), ba[1]
        if before == after:
            continue
        if after is None:
            obj.pop(f, None)
        else:
            obj[f] = clone(after)
        r[f] = [clone(before), clone(after)]
    if r:
        out.append({'e': e, 'set': r})


def apply(d, changes):
    """Same as doc.js apply: changes into d in place -> what really changed (with the real before values)."""
    out = []
    for c in sorted(changes, key=rank):
        e = c.get('e')
        if not isinstance(e, str):
            continue
        if e == 'order':
            after = (c.get('set') or {}).get('tracks', [None, None])[1]
            if not isinstance(after, list):
                continue
            before = [t.get('id') for t in d.get('tracks') or []]
            pos = {i: n for n, i in enumerate(after)}
            tr = d.get('tracks') or []
            d['tracks'] = sorted((t for t in tr if t.get('id') in pos), key=lambda t: pos[t['id']]) + [t for t in tr if t.get('id') not in pos]
            now = [t.get('id') for t in d['tracks']]
            if now != before:
                out.append({'e': 'order', 'set': {'tracks': [before, now]}})
            continue
        make = 'add' in c or ('set' in c and e in ('meta', 'settings', 'params'))
        obj, arr = locate(d, e, make)
        if 'set' in c:
            if isinstance(obj, dict):
                set_fields(obj, e, c['set'], out)
        elif 'add' in c:
            add = c['add'] or {}
            if isinstance(obj, dict):
                s = {f: [None, None] for f in obj if not guarded(e, f) and f not in add}
                s.update({f: [None, v] for f, v in add.items()})
                set_fields(obj, e, s, out)
            elif isinstance(arr, list):
                o = clone(add)
                o['id'] = parse_key(e)['id']
                arr.append(o)
                out.append({'e': e, 'add': clone(add)})
        elif 'del' in c and isinstance(obj, dict) and isinstance(arr, list):
            if e.startswith('t:'):
                for k in obj.get('keys') or []:
                    out.append({'e': f"k:{obj['id']}:{k['id']}", 'del': clone(k)})
                for k in obj.get('clips') or []:
                    out.append({'e': f"c:{obj['id']}:{k['id']}", 'del': clone(k)})
                f = own(obj, KC)
                if 'keys' in obj:
                    f['keys'] = []
                if 'clips' in obj:
                    f['clips'] = []
            else:
                f = dict(obj)
            arr.remove(obj)
            out.append({'e': e, 'del': clone(f)})
    sort_items(d)
    return out


def sort_items(d):
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0  # noqa: E731
    for t in d.get('tracks') or []:
        if isinstance(t.get('keys'), list):
            t['keys'].sort(key=lambda k: num(k.get('t')))
        if isinstance(t.get('clips'), list):
            t['clips'].sort(key=lambda k: num(k.get('a')))
    for k in ('chapters', 'notes'):
        if isinstance(d.get(k), list):
            d[k].sort(key=lambda x: num(x.get('t')))


def invert(changes):
    out = []
    for c in reversed(changes):
        if 'add' in c:
            out.append({'e': c['e'], 'del': c['add']})
        elif 'del' in c:
            out.append({'e': c['e'], 'add': c['del']})
        else:
            out.append({'e': c['e'], 'set': {f: [b, a] for f, (a, b) in c['set'].items()}})
    return out


def still_valid(changes, cur):
    """Same as doc.js stillValid: only what nobody changed since."""
    keep = []
    for c in changes:
        now = cur.get(c['e'])
        if 'set' in c:
            if now is None:
                continue
            s = {f: v for f, v in c['set'].items() if c['e'] == 'order' or now.get(f) == v[0]}
            if s:
                keep.append({'e': c['e'], 'set': s})
        elif 'add' in c:
            if now is None:
                keep.append(c)
        elif 'del' in c and now is not None:
            keep.append(c)
    return keep


# ---------------------------------------------------------------------------------------------
# story.json text exactly like Timeline.serialize() (src/timeline.js): one line per key / clip, 4 decimals
# ---------------------------------------------------------------------------------------------
def _u16(s):
    return len(s.encode('utf-16-le')) // 2


def _num(v):
    r = math.floor(v * 1e4 + 0.5) / 1e4
    if r == int(r) and abs(r) < 1e21:
        return str(int(r))
    return repr(r)


def _flat(x):
    return not isinstance(x, (dict, list)) or (isinstance(x, list) and all(not isinstance(y, (dict, list)) for y in x))


def fmt(v, ind=''):
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return _num(v) if math.isfinite(v) else 'null'
    if isinstance(v, list):
        if all(not isinstance(x, (dict, list)) for x in v):
            return '[' + ', '.join(fmt(x, ind) for x in v) + ']'
        return '[\n' + ',\n'.join(f'{ind}  {fmt(x, ind + "  ")}' for x in v) + f'\n{ind}]'
    if isinstance(v, dict):
        parts = [f'{json.dumps(k, ensure_ascii=False)}: {fmt(x, ind + "  ")}' for k, x in v.items()]
        one = '{ ' + ', '.join(parts) + ' }'
        if all(_flat(x) for x in v.values()) and _u16(one) + len(ind) < 150:
            return one
        return '{\n' + ',\n'.join(f'{ind}  {p}' for p in parts) + f'\n{ind}}}'
    return json.dumps(v, ensure_ascii=False)


def serialize(d):
    return fmt(d) + '\n'


# ---------------------------------------------------------------------------------------------
# One project's live state
# ---------------------------------------------------------------------------------------------
class Live:
    def __init__(self, P, fnv1a, write, stamp):
        self.P, self.fnv1a, self.write, self.stamp = P, fnv1a, write, stamp
        self.cv = threading.Condition()
        self.epoch = uid(8)
        self.log_path = os.path.join(P.saves, 'history.jsonl')
        self.ops = []
        self.ids = {}  # (client, op id) -> seq: a retried push is answered, not applied twice
        if os.path.isfile(self.log_path):
            with open(self.log_path, encoding='utf-8') as f:
                for line in f:
                    try:
                        op = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(op, dict) and isinstance(op.get('seq'), int):
                        self.ops.append(op)
        self.ops.sort(key=lambda o: o['seq'])
        self.seq = self.ops[-1]['seq'] if self.ops else 0
        self.presence = {}
        self.pv = 0
        self.last_backup = 0
        self.doc = None
        self.disk = None  # (mtime, size, hash) of the story.json we last read / wrote
        self.load_disk(initial=True)

    # ---- story.json on disk
    def read_disk(self):
        with open(self.P.story, 'rb') as f:
            raw = f.read()
        st = os.stat(self.P.story)
        return raw, (st.st_mtime_ns, st.st_size, self.fnv1a(raw))

    def load_disk(self, initial=False):
        raw, stamp = self.read_disk()
        doc = json.loads(raw)
        if not isinstance(doc, dict) or not isinstance(doc.get('tracks'), list):
            raise ValueError('story.json is not a story')
        if initial:
            ensure_ids(doc)
            self.doc = doc
            self.disk = stamp
            if serialize(doc).encode() != raw:  # ids added: write them so every client sees the same ones
                self.save_doc(backup=False)
            return
        ensure_ids(doc, self.doc)
        self.disk = stamp
        changes = diff(entities(self.doc), entities(doc))
        if changes:
            done = apply(self.doc, changes)
            self.append(done, 'disk', 'Story file', 'Changed outside the editor (Claude, git or a text editor)', client='disk')
        if serialize(self.doc).encode() != raw:
            self.save_doc(backup=False)

    def check_disk(self):
        """story.json changed by someone else (Claude, git, an old editor tab)? -> an edit in the log."""
        try:
            st = os.stat(self.P.story)
        except OSError:
            return
        if self.disk and (st.st_mtime_ns, st.st_size) == self.disk[:2]:
            return
        try:
            raw, stamp = self.read_disk()
        except OSError:
            return
        if self.disk and stamp[2] == self.disk[2]:
            self.disk = stamp
            return
        try:
            self.load_disk()
        except ValueError:
            self.disk = stamp  # half-written / broken file: wait for the next change
        self.cv.notify_all()

    def save_doc(self, backup=True):
        text = serialize(self.doc).encode()
        now = time.time()
        if backup and now - self.last_backup > BACKUP_EVERY and os.path.isfile(self.P.story):
            with open(self.P.story, 'rb') as f:
                old = f.read()
            if old != text:
                self.write(os.path.join(self.P.auto, f'{self.stamp()}.json'), old)
                self.last_backup = now
        self.write(self.P.story, text)
        st = os.stat(self.P.story)
        self.disk = (st.st_mtime_ns, st.st_size, self.fnv1a(text))

    # ---- the log
    def append(self, changes, user, color, label, client='', opid=''):
        self.seq += 1
        op = {'seq': self.seq, 'time': int(time.time() * 1000), 'user': user or 'Someone', 'client': client, 'id': opid,
              'label': label or 'Edit', 'changes': changes}
        if color:
            op['color'] = color
        self.ops.append(op)
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        with open(self.log_path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(op, ensure_ascii=False, separators=(',', ':')) + '\n')
        if client and opid:
            self.ids[(client, opid)] = self.seq
        self.cv.notify_all()
        return op

    def since(self, seq):
        lo, hi = 0, len(self.ops)
        while lo < hi:
            mid = (lo + hi) // 2
            if self.ops[mid]['seq'] <= seq:
                lo = mid + 1
            else:
                hi = mid
        return self.ops[lo:]

    # ---- requests (called with self.cv held)
    def state(self):
        self.check_disk()
        return {'text': serialize(self.doc), 'seq': self.seq, 'epoch': self.epoch}

    def push(self, body):
        self.check_disk()
        client, opid = str(body.get('client') or ''), str(body.get('id') or '')
        if (client, opid) in self.ids:
            return {'seq': self.ids[(client, opid)], 'dup': True}
        changes = body.get('changes')
        if not isinstance(changes, list):
            raise ValueError('no changes')
        done = apply(self.doc, changes)
        if not done:
            self.ids[(client, opid)] = self.seq
            return {'seq': self.seq, 'empty': True}
        self.save_doc()
        op = self.append(done, str(body.get('user') or ''), str(body.get('color') or ''), str(body.get('label') or ''), client, opid)
        return {'seq': op['seq']}

    def light(self, op, full):
        out = {k: op.get(k) for k in ('seq', 'time', 'user', 'client', 'id', 'label', 'color')}
        if full:
            out['changes'] = op['changes']
        else:
            out['n'] = len(op.get('changes') or [])
        return out

    def poll(self, since, epoch, pv, timeout=25.0):
        end = time.time() + timeout
        while True:
            self.check_disk()
            self.expire()
            if epoch != self.epoch:
                return {'reset': True, 'epoch': self.epoch, 'seq': self.seq}
            ops = self.since(since)
            if ops or pv != self.pv or time.time() >= end:
                out = {'ops': [self.light(o, True) for o in ops[:500]], 'seq': self.seq, 'pv': self.pv}
                if pv != self.pv:
                    out['presence'] = list(self.presence.values())
                return out
            self.cv.wait(min(1.0, max(0.05, end - time.time())))

    def expire(self):
        now = time.time()
        gone = [c for c, p in self.presence.items() if now - p['seen'] > PRESENCE_TTL]
        for c in gone:
            del self.presence[c]
        if gone:
            self.pv += 1

    def hello(self, body):
        c = str(body.get('client') or '')
        if not c:
            raise ValueError('no client')
        if body.get('bye'):
            if self.presence.pop(c, None):
                self.pv += 1
                self.cv.notify_all()
            return {'ok': True}
        p = {k: body.get(k) for k in ('client', 'user', 'color', 't', 'sel', 'view', 'playing', 'preview')}
        p['seen'] = time.time()
        old = self.presence.get(c)
        self.presence[c] = p
        if not old or any(old.get(k) != p.get(k) for k in p if k != 'seen'):
            self.pv += 1
            self.cv.notify_all()
        return {'ok': True}

    def history(self, before, limit):
        ops = [o for o in self.ops if before is None or o['seq'] < before]
        return {'ops': [self.light(o, False) for o in reversed(ops[-limit:])], 'seq': self.seq, 'first': self.ops[0]['seq'] if self.ops else 0}

    def doc_at(self, seq):
        d = clone(self.doc)
        for op in reversed(self.since(seq)):
            apply(d, invert(op['changes']))
        return d

    def at(self, seq):
        return {'text': serialize(self.doc_at(seq)), 'seq': seq}

    def op(self, seq):
        o = next((o for o in self.ops if o['seq'] == seq), None)
        if not o:
            raise ValueError(f'no edit #{seq}')
        return o

    def restore(self, seq, user, color):
        old = self.doc_at(seq)
        ensure_ids(old, self.doc)
        done = apply(self.doc, diff(entities(self.doc), entities(old)))
        if not done:
            return {'seq': self.seq, 'empty': True}
        self.save_doc()
        o = self.op(seq) if seq else None
        when = time.strftime('%H:%M', time.localtime(o['time'] / 1000)) if o else 'the start'
        op = self.append(done, user, color, f"Rewound to {when}" + (f" (after “{o['label']}”)" if o else ''), client='server')
        return {'seq': op['seq']}

    def revert(self, seq, user, color):
        o = self.op(seq)
        keep = still_valid(invert(o['changes']), entities(self.doc))
        done = apply(self.doc, keep)
        if not done:
            return {'seq': self.seq, 'empty': True}
        self.save_doc()
        op = self.append(done, user, color, f"Undid {o['user']}’s “{o['label']}”", client='server')
        return {'seq': op['seq'], 'partial': len(keep) < len(o['changes'])}


LIVE = {}
LIVE_LOCK = threading.Lock()


def live(P, fnv1a, write, stamp):
    with LIVE_LOCK:
        key = P.root
        if key not in LIVE:
            LIVE[key] = Live(P, fnv1a, write, stamp)
        return LIVE[key]


def drop(P):
    """The project's files were replaced (e.g. a .tuna re-opened into it): forget its live state."""
    with LIVE_LOCK:
        LIVE.pop(P.root, None)
