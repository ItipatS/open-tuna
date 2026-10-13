// The story as entities: the unit of undo, live sync, history (rewind) and compare. A story.json splits into
//   doc        top-level fields (version, sources, …) other than the ones below
//   meta       meta { title, duration, scrollPerSecond }
//   settings   settings without params              params   settings.params
//   order      { tracks: [track ids] }              (row order)
//   t:<track>  a track's own fields; its keys / clips are entities of their own (`keys: []` marks that it has them)
//   k:<track>:<id>   c:<track>:<id>                 a key / a caption clip of that track
//   ch:<id>   n:<id>                                a chapter / a note
// A change is { e, set: { field: [before, after] } } | { e, add: fields } | { e, del: fields }; null = no such field.
// Every key / clip / chapter / note carries a short random `id` (ensureIds) so a change finds its item again after
// re-sorting, other people's edits and reloads. tools/collab.py is the same model on the server: keep them in sync.

const TOP = new Set(['meta', 'settings', 'tracks', 'chapters', 'notes']);
const NO_PARAMS = new Set(['params']);
const KC = new Set(['keys', 'clips']);
const ABC = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));
const nul = (v) => (v === undefined ? null : v);
export const same = (a, b) => a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

export function uid(n = 6) {
  let s = ABC[Math.floor(Math.random() * 26)];
  for (let i = 1; i < n; i++) s += ABC[Math.floor(Math.random() * ABC.length)];
  return s;
}

function own(o, skip) {
  const r = {};
  for (const k in o) if (o[k] !== undefined && !skip?.has(k)) r[k] = o[k];
  return r;
}

// an item's content without its id / lock (to recognise the same item in another version of the story)
const sig = (o) => JSON.stringify(Object.keys(o).filter((k) => k !== 'id' && k !== 'locked' && k !== 'lockedBy').sort().map((k) => [k, o[k]]));

// give every track / key / clip / chapter / note a unique id. Items without one take the id of an identical item in
// `prev` (same track), so loading an older version or a file edited by hand doesn't look like "everything replaced".
// Returns how many ids were added or fixed.
export function ensureIds(d, prev = null) {
  let n = 0;
  const pool = new Map(); // scope -> Map(sig -> [ids])
  if (prev) {
    const put = (scope, o) => {
      if (!o.id) return;
      const m = pool.get(scope) ?? pool.set(scope, new Map()).get(scope), s = sig(o);
      (m.get(s) ?? m.set(s, []).get(s)).push(o.id);
    };
    for (const t of prev.tracks ?? []) { for (const k of t.keys ?? []) put(`k${t.id}`, k); for (const c of t.clips ?? []) put(`c${t.id}`, c); }
    for (const c of prev.chapters ?? []) put('ch', c);
    for (const x of prev.notes ?? []) put('n', x);
  }
  const seen = new Set();
  const fix = (scope, o) => {
    if (!o || typeof o !== 'object') return;
    if (!o.id || seen.has(o.id)) {
      const ids = pool.get(scope)?.get(sig(o));
      let id = null;
      while (ids?.length && (!id || seen.has(id))) id = ids.shift();
      o.id = id && !seen.has(id) ? id : (() => { let u; do u = uid(); while (seen.has(u)); return u; })();
      n++;
    }
    seen.add(o.id);
  };
  const tids = new Set();
  for (const t of d.tracks ?? []) {
    if (!t.id || tids.has(t.id)) { t.id = `${t.type || 'track'}-${uid()}`; n++; }
    tids.add(t.id);
  }
  for (const t of d.tracks ?? []) { for (const k of t.keys ?? []) fix(`k${t.id}`, k); for (const c of t.clips ?? []) fix(`c${t.id}`, c); }
  for (const c of d.chapters ?? []) fix('ch', c);
  for (const x of d.notes ?? []) fix('n', x);
  return n;
}

// numbers rounded to 4 decimals in place (what serialize() writes), so the data equals the file it saves to
export function roundAll(v) {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { if (typeof v[i] === 'number') v[i] = Math.round(v[i] * 1e4) / 1e4; else if (v[i] && typeof v[i] === 'object') roundAll(v[i]); } }
  else if (v && typeof v === 'object') { for (const k in v) { if (typeof v[k] === 'number') v[k] = Math.round(v[k] * 1e4) / 1e4; else if (v[k] && typeof v[k] === 'object') roundAll(v[k]); } }
  return v;
}

// story data -> Map(entity key -> fields). Item entities are the live objects (no copy).
export function entities(d) {
  const m = new Map();
  m.set('doc', own(d, TOP));
  m.set('meta', own(d.meta ?? {}));
  m.set('settings', own(d.settings ?? {}, NO_PARAMS));
  m.set('params', own(d.settings?.params ?? {}));
  m.set('order', { tracks: (d.tracks ?? []).map((t) => t.id) });
  for (const t of d.tracks ?? []) {
    const f = own(t, KC);
    if (t.keys) f.keys = [];
    if (t.clips) f.clips = [];
    m.set(`t:${t.id}`, f);
    for (const k of t.keys ?? []) m.set(`k:${t.id}:${k.id}`, k);
    for (const c of t.clips ?? []) m.set(`c:${t.id}:${c.id}`, c);
  }
  for (const c of d.chapters ?? []) m.set(`ch:${c.id}`, c);
  for (const x of d.notes ?? []) m.set(`n:${x.id}`, x);
  return m;
}

function fieldDiff(a, b) {
  let set = null;
  for (const f in a) {
    const x = nul(a[f]), y = nul(b[f]);
    if (!same(x, y)) (set ??= {})[f] = [clone(x), clone(y)];
  }
  for (const f in b) if (!(f in a) && b[f] != null) (set ??= {})[f] = [null, clone(b[f])];
  return set;
}

// the changes that turn entities A into entities B
export function diff(A, B) {
  const out = [];
  for (const [e, b] of B) {
    const a = A.get(e);
    if (!a) out.push({ e, add: clone(own(b)) });
    else { const set = fieldDiff(a, b); if (set) out.push({ e, set }); }
  }
  for (const [e, a] of A) if (!B.has(e)) out.push({ e, del: clone(own(a)) });
  return out;
}

export const diffDocs = (a, b) => diff(entities(a), entities(b));

// "k:camera:x1y2z3" -> { kind: 'k', track: 'camera', id: 'x1y2z3' }
export function parseKey(e) {
  const i = e.indexOf(':');
  if (i < 0) return { kind: e };
  const kind = e.slice(0, i), rest = e.slice(i + 1);
  if (kind === 'k' || kind === 'c') { const j = rest.lastIndexOf(':'); return { kind, track: rest.slice(0, j), id: rest.slice(j + 1) }; }
  return { kind, id: rest };
}

// where an entity lives: { obj, arr } (obj null when it doesn't exist). `make` creates missing containers.
function locate(d, e, make = false) {
  const p = parseKey(e);
  const box = (o, k) => (make ? (o[k] ??= k === 'tracks' || k === 'keys' || k === 'clips' || k === 'chapters' || k === 'notes' ? [] : {}) : o[k]);
  switch (p.kind) {
    case 'doc': return { obj: d };
    case 'meta': return { obj: box(d, 'meta') ?? null };
    case 'settings': return { obj: box(d, 'settings') ?? null };
    case 'params': { const s = box(d, 'settings'); return { obj: (s && box(s, 'params')) ?? null }; }
    case 't': { const arr = box(d, 'tracks'); return { arr, obj: arr?.find((t) => t.id === p.id) ?? null }; }
    case 'k': case 'c': {
      const t = (d.tracks ?? []).find((q) => q.id === p.track);
      const arr = t ? box(t, p.kind === 'k' ? 'keys' : 'clips') : null;
      return { arr, obj: arr?.find((x) => x.id === p.id) ?? null };
    }
    case 'ch': case 'n': { const arr = box(d, p.kind === 'ch' ? 'chapters' : 'notes'); return { arr, obj: arr?.find((x) => x.id === p.id) ?? null }; }
    default: return { obj: null };
  }
}

// fields an entity may not set through `set` (they belong to other entities)
const guarded = (e, f) => (e === 'doc' && TOP.has(f)) || (e === 'settings' && f === 'params') || (e.startsWith('t:') && (KC.has(f) || f === 'id')) || f === 'id';

function reorder(d, list) {
  const pos = new Map(list.map((id, i) => [id, i]));
  const tr = d.tracks ?? [];
  const listed = tr.filter((t) => pos.has(t.id)).sort((p, q) => pos.get(p.id) - pos.get(q.id));
  const rest = tr.filter((t) => !pos.has(t.id));
  d.tracks = [...listed, ...rest];
}

function setFields(obj, e, set, skip, out) {
  let r = null;
  for (const f in set) {
    if (guarded(e, f) || skip?.(e, f)) continue;
    const before = nul(obj[f]), after = set[f][1];
    if (same(before, after)) continue;
    if (after === null) delete obj[f]; else obj[f] = clone(after);
    (r ??= {})[f] = [clone(before), clone(after)];
  }
  if (r) out.push({ e, set: r });
}

const rank = (c) => (c.e.startsWith('t:') ? (c.add ? 0 : c.del ? 4 : 1) : c.e === 'order' ? 3 : 2);

// apply changes to story data in place; `skip(e, field)` leaves a field alone. Returns what actually changed
// (with the real `before` values): the server logs that.
export function apply(d, changes, { skip } = {}) {
  const out = [];
  for (const c of [...changes].sort((p, q) => rank(p) - rank(q))) {
    if (c.e === 'order') {
      const after = c.set?.tracks?.[1];
      if (!after || skip?.('order', 'tracks')) continue;
      const before = (d.tracks ?? []).map((t) => t.id);
      reorder(d, after);
      const now = d.tracks.map((t) => t.id);
      if (!same(before, now)) out.push({ e: 'order', set: { tracks: [before, now] } });
      continue;
    }
    const { obj, arr } = locate(d, c.e, !!c.add || (!!c.set && (c.e === 'meta' || c.e === 'settings' || c.e === 'params')));
    if (c.set) { if (obj) setFields(obj, c.e, c.set, skip, out); continue; }
    if (c.add) {
      if (obj) { // already there: becomes a set of every field
        const set = {};
        for (const f in obj) if (!guarded(c.e, f) && !(f in c.add)) set[f] = [null, null];
        for (const f in c.add) set[f] = [null, c.add[f]];
        setFields(obj, c.e, set, skip, out);
        continue;
      }
      if (!arr) continue; // its track is gone
      const o = clone(c.add);
      o.id = parseKey(c.e).id;
      arr.push(o);
      out.push({ e: c.e, add: clone(c.add) });
      continue;
    }
    if (c.del && obj) {
      if (c.e.startsWith('t:')) { // what's still on the track goes with it (logged, so a rewind brings it back)
        for (const k of obj.keys ?? []) out.push({ e: `k:${obj.id}:${k.id}`, del: clone(own(k)) });
        for (const k of obj.clips ?? []) out.push({ e: `c:${obj.id}:${k.id}`, del: clone(own(k)) });
      }
      const f = own(obj, c.e.startsWith('t:') ? KC : null);
      if (c.e.startsWith('t:')) { if (obj.keys) f.keys = []; if (obj.clips) f.clips = []; }
      arr.splice(arr.indexOf(obj), 1);
      out.push({ e: c.e, del: clone(f) });
    }
  }
  return out;
}

// the changes that undo `changes`
export function invert(changes) {
  return [...changes].reverse().map((c) => (c.add ? { e: c.e, del: c.add } : c.del ? { e: c.e, add: c.del }
    : { e: c.e, set: Object.fromEntries(Object.entries(c.set).map(([f, [a, b]]) => [f, [b, a]])) }));
}

// the part of `changes` that still applies to `cur` (entities): a field is only set back if it still has the value
// `changes` gave it — someone else's later edit wins. Returns { keep, dropped }.
export function stillValid(changes, cur) {
  const keep = [];
  let dropped = 0;
  for (const c of changes) {
    const now = cur.get(c.e);
    if (c.set) {
      if (!now) { dropped++; continue; }
      const set = {};
      let any = false;
      for (const f in c.set) {
        if (c.e === 'order' || same(nul(now[f]), c.set[f][0])) { set[f] = c.set[f]; any = true; } else dropped++;
      }
      if (any) keep.push({ e: c.e, set });
    } else if (c.add) { if (!now) keep.push(c); else dropped++; }
    else if (c.del) { if (now) keep.push(c); }
  }
  return { keep, dropped };
}

// ---------------------------------------------------------------------------------------------
// A short human label for a set of changes ("Moved 3 keys on Camera", "Edited caption “Hello”")
// ---------------------------------------------------------------------------------------------
const NOUN = { k: 'key', c: 'caption', t: 'track', ch: 'chapter', n: 'note' };
const TIME = new Set(['t', 'a', 'b']);

export function summarize(changes, d) {
  if (!changes.length) return 'No change';
  const tr = (id) => (d?.tracks ?? []).find((t) => t.id === id);
  const groups = new Map();
  for (const c of changes) {
    const p = parseKey(c.e);
    if (p.kind === 'order') { groups.set('order', { verb: 'Reordered', noun: 'tracks', n: 1, single: true }); continue; }
    if (['doc', 'meta', 'settings', 'params'].includes(p.kind)) {
      const f = Object.keys(c.set ?? {});
      const what = p.kind === 'meta' && f.includes('duration') ? 'story length' : p.kind === 'params' ? `${f.join(', ')}` : p.kind === 'doc' && f.includes('sources') ? 'data sources' : p.kind === 'settings' ? 'settings' : 'story settings';
      groups.set(`${p.kind}`, { verb: 'Changed', noun: what, n: 1, single: true });
      continue;
    }
    const verb = c.add ? 'Added' : c.del ? 'Deleted' : Object.keys(c.set).every((f) => TIME.has(f)) ? 'Moved'
      : Object.keys(c.set).some((f) => f === 'locked') ? (c.set.locked[1] ? 'Locked' : 'Unlocked')
        : Object.keys(c.set).some((f) => f === 'mute') ? (c.set.mute[1] ? 'Muted' : 'Unmuted') : 'Edited';
    let noun = NOUN[p.kind] ?? p.kind;
    const t = p.track ? tr(p.track) : p.kind === 't' ? tr(p.id) ?? { label: (c.add ?? c.del)?.label, type: (c.add ?? c.del)?.type } : null;
    if (p.kind === 't') noun = t?.type === 'layer' ? 'layer' : t?.type === 'path' ? 'path' : t?.type === 'lane' ? 'lane' : t?.type === 'group' ? 'group' : 'track';
    if (p.kind === 'k' && t?.type === 'path') noun = 'waypoint';
    const where = p.kind === 'k' && t ? ` on ${t.label || t.id}` : '';
    const key = `${verb}|${noun}|${where}`;
    const g = groups.get(key) ?? groups.set(key, { verb, noun, where, n: 0, names: [] }).get(key);
    g.n++;
    const item = c.add ?? c.del ?? (p.kind === 't' ? t : null);
    const name = p.kind === 't' ? (t?.label ?? item?.label) : p.kind === 'c' ? (findItem(d, c.e)?.title ?? item?.title) : p.kind === 'ch' ? (findItem(d, c.e)?.name ?? item?.name) : null;
    if (name) g.names.push(String(name).replace(/\s+/g, ' ').slice(0, 28));
  }
  const parts = [...groups.values()].sort((a, b) => b.n - a.n).map((g) => {
    if (g.single) return `${g.verb} ${g.noun}`;
    const nm = g.n === 1 && g.names[0] ? ` “${g.names[0]}”` : '';
    return `${g.verb} ${g.n > 1 ? `${g.n} ${g.noun}s` : g.noun}${nm}${g.where ?? ''}`;
  });
  const s = parts.slice(0, 2).join(', ') + (parts.length > 2 ? ` +${parts.length - 2} more` : '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function findItem(d, e) {
  try { return d ? locate(d, e).obj : null; } catch { return null; }
}
export const itemOf = findItem;
