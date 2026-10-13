// The story timeline: the data model behind story.json, shared by the site (scroll / play) and the
// editor (?edit). The whole story is a pure function of the story time `x` (seconds, 0..meta.duration).
// On the site, scroll progress p (0..1) maps to x = p · duration.
//
// story.json (version 2):
//   meta      { title, duration (s), scrollPerSecond (vh of page per second of story) }
//   settings  { tunaCount, params: { [param]: constant } }
//   chapters  [{ t, name }]           markers for people (the editor shows them)
//   notes     [{ t, text }]           feedback left at a moment — read them when asked to act on feedback
//   tracks (drawn top to bottom in the editor):
//     camera    keys { t, pos[3], look[3], follow 0..1 (look at the school instead), fov }; Hermite spline in t.
//               `drift` scales a slow hand-held sway.
//     curve     keys { t, v, ease } driving one scalar parameter (`bind`, see PARAMS in story.js);
//               `ease` shapes the segment that starts at that key.
//     clip      one clip [a, b] (s) driving a story beat (`bind`, see DRIVERS in story.js): ramps 0 -> 1 across
//               the clip with `ease`, or with ease "gate" is 1 inside the clip and 0 outside.
//     captions  clips { a, b, title, sub, size, y, fade } shown over the canvas.
//     layer     one media layer (see layers.js): { kind image|video|html|iframe, src, html, space screen|world,
//               a, b, fade, z, w, h, fit, interactive, loop, scrub, rate, billboard,
//               keys: [{ t, ease, x, y, s, r, o }] (screen: x / y in % of the view) or [{ t, ease, pos[3], s, r, o }] (world, m) }
//   Any track / key / clip / chapter / note may carry `locked: true` (editor won't change it);
//   a track may carry `mute: true` (ignored by the story).

export const VERSION = 2;

export const EASES = {
  linear: (k) => k,
  smooth: (k) => k * k * (3 - 2 * k),
  in: (k) => k * k,
  out: (k) => 1 - (1 - k) * (1 - k),
  hold: (k) => (k < 1 ? 0 : 1),
};
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// v1 stored positions as progress 0..1; v2 stores seconds. Convert in place.
export function migrate(data) {
  data.meta ??= {};
  if ((data.version ?? 1) >= 2) return data;
  const D = data.meta.playDuration ?? 60;
  const s = (p) => Math.round(p * D * 1e4) / 1e4;
  const withT = ({ p, ...rest }) => ({ t: s(p), ...rest });
  const { playDuration, scrollLength, ...meta } = data.meta;
  data.meta = { ...meta, duration: D, scrollPerSecond: Math.round(((scrollLength ?? 900) / D) * 100) / 100 };
  data.chapters = (data.chapters ?? []).map(withT);
  data.notes = (data.notes ?? []).map(withT);
  for (const t of data.tracks ?? []) {
    if (t.keys) t.keys = t.keys.map(withT);
    if (t.clips) t.clips = t.clips.map((c) => ({ ...c, a: s(c.a), b: s(c.b), ...(c.fade !== undefined ? { fade: s(c.fade) } : {}) }));
    if (t.type === 'clip') { t.a = s(t.a); t.b = s(t.b); }
  }
  data.version = VERSION;
  return data;
}

// index pair around x (keys sorted by t) and the local parameter s in [0, 1]
export function segment(keys, x) {
  const n = keys.length;
  if (x <= keys[0].t) return [0, 0, 0];
  if (x >= keys[n - 1].t) return [n - 1, n - 1, 0];
  let lo = 0, hi = n - 1; // binary search: hour-long stories can have many keys
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m].t <= x) lo = m; else hi = m; }
  const dt = keys[hi].t - keys[lo].t;
  return [lo, hi, dt > 0 ? (x - keys[lo].t) / dt : 1];
}

// cubic Hermite through the keys, parametrised by t (finite-difference tangents, flat at both ends)
function hermite(keys, x, field, out) {
  const [i, j, s] = segment(keys, x);
  const A = keys[i][field], B = keys[j][field];
  if (i === j) { for (let c = 0; c < out.length; c++) out[c] = A[c]; return out; }
  const h = keys[j].t - keys[i].t;
  const slope = (k, c) => {
    if (k <= 0 || k >= keys.length - 1) return 0;
    const dt = keys[k + 1].t - keys[k - 1].t;
    return dt > 0 ? (keys[k + 1][field][c] - keys[k - 1][field][c]) / dt : 0;
  };
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  for (let c = 0; c < out.length; c++) out[c] = h00 * A[c] + h10 * h * slope(i, c) + h01 * B[c] + h11 * h * slope(j, c);
  return out;
}

export function evalCurve(keys, x) {
  if (!keys.length) return undefined;
  const [i, j, s] = segment(keys, x);
  if (i === j) return keys[i].v;
  return keys[i].v + (keys[j].v - keys[i].v) * (EASES[keys[i].ease] || EASES.smooth)(s);
}

// interpolate every numeric / array field of keyframes (layer keys); `ease` of a key shapes the segment after it
export function evalKeys(keys, x, out = {}) {
  if (!keys.length) return out;
  const [i, j, s] = segment(keys, x), A = keys[i], B = keys[j];
  const e = (EASES[A.ease] || EASES.smooth)(s);
  for (const f in A) {
    if (f === 't' || f === 'ease' || f === 'locked') continue;
    const va = A[f], vb = B[f] ?? va;
    if (typeof va === 'number') out[f] = va + (vb - va) * e;
    else if (Array.isArray(va)) out[f] = va.map((v, c) => v + ((vb[c] ?? v) - v) * e);
  }
  return out;
}

export function evalClip(t, x, duration = Infinity) {
  if (t.ease === 'gate') return x >= t.a && (x < t.b || t.b >= duration) ? 1 : 0;
  return (EASES[t.ease] || EASES.linear)(clamp01((x - t.a) / Math.max(t.b - t.a, 1e-6)));
}

// caption opacity: fades over `fade` seconds at each end (none at the very start / end of the story)
export function captionOpacity(c, x, duration) {
  const f = c.fade ?? 2.4;
  const sm = (a, b, v) => { const k = clamp01((v - a) / (b - a)); return k * k * (3 - 2 * k); };
  const fin = c.a <= 0 ? (x >= c.a ? 1 : 0) : sm(c.a, c.a + f, x);
  const fout = c.b >= duration ? (x <= c.b ? 1 : 0) : 1 - sm(c.b - f, c.b, x);
  return Math.min(fin, fout);
}

// "1:05.3", "12:00", "1:02:03"
export function fmtTime(x, dec = 1) {
  const neg = x < 0 ? '-' : '';
  x = Math.abs(x);
  const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x % 60;
  const ss = s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0');
  return h ? `${neg}${h}:${String(m).padStart(2, '0')}:${ss}` : `${neg}${m}:${ss}`;
}

export class Timeline {
  constructor(data) { this.version = 0; this.set(data); }

  set(data) {
    migrate(data);
    data.meta.duration ??= 60;
    data.meta.scrollPerSecond ??= 15;
    data.settings ??= {};
    data.settings.params ??= {};
    data.chapters ??= [];
    data.notes ??= [];
    data.tracks ??= [];
    this.data = data;
    this.changed();
  }

  // call after any edit: re-sorts keys/clips/markers and bumps `version` (views redraw on it)
  changed() {
    const d = this.data;
    for (const t of d.tracks) {
      if (t.keys) t.keys.sort((x, y) => x.t - y.t);
      if (t.clips) t.clips.sort((x, y) => x.a - y.a);
    }
    d.chapters.sort((x, y) => x.t - y.t);
    d.notes.sort((x, y) => x.t - y.t);
    this.bound = new Map(d.tracks.filter((t) => t.bind).map((t) => [t.bind, t]));
    this.version++;
  }

  get meta() { return this.data.meta; }
  get duration() { return this.data.meta.duration; }
  get tracks() { return this.data.tracks; }
  track(id) { return this.data.tracks.find((t) => t.id === id); }
  ofType(type) { return this.data.tracks.find((t) => t.type === type && !t.mute); }

  // the latest time anything is placed at (the story can't be shortened past it)
  contentEnd() {
    let e = 0;
    const d = this.data;
    for (const c of d.chapters) e = Math.max(e, c.t);
    for (const n of d.notes) e = Math.max(e, n.t);
    for (const t of d.tracks) {
      if (t.keys) for (const k of t.keys) e = Math.max(e, k.t);
      if (t.clips) for (const c of t.clips) e = Math.max(e, Math.min(c.b, c.a + 0.5));
      if (t.type === 'clip' || t.type === 'layer') e = Math.max(e, Math.min(t.b, t.a + 0.5));
    }
    return e;
  }

  // clip driver value (0 when there is no such track or it is muted)
  clip(bind, x) {
    const t = this.bound.get(bind);
    return t && !t.mute && t.type === 'clip' ? evalClip(t, x, this.duration) : 0;
  }

  // scalar parameter: animated by a curve track, else the constant in settings.params, else `def`
  param(bind, x, def) {
    const t = this.bound.get(bind);
    if (t && !t.mute && t.type === 'curve' && t.keys.length) return evalCurve(t.keys, x);
    return this.data.settings.params[bind] ?? def;
  }

  // camera pose at x into out = {pos:[3], look:[3], follow, fov, drift}; false when there is no camera track
  camera(x, out) {
    const t = this.ofType('camera');
    if (!t || !t.keys.length) return false;
    hermite(t.keys, x, 'pos', out.pos);
    hermite(t.keys, x, 'look', out.look);
    const [i, j, s] = segment(t.keys, x), e = EASES.smooth(s);
    const A = t.keys[i], B = t.keys[j];
    out.follow = (A.follow ?? 0) + ((B.follow ?? 0) - (A.follow ?? 0)) * e;
    out.fov = (A.fov ?? 50) + ((B.fov ?? 50) - (A.fov ?? 50)) * e;
    out.drift = t.drift ?? 1;
    return true;
  }

  captions() { return this.ofType('captions')?.clips ?? []; }
  layers() { return this.data.tracks.filter((t) => t.type === 'layer'); }

  chapter(x) {
    let c = null;
    for (const ch of this.data.chapters) if (ch.t <= x + 1e-9) c = ch;
    return c;
  }

  // readable, diff-friendly JSON: one line per key / clip, numbers rounded to 4 decimals
  serialize() { return fmt(this.data, '') + '\n'; }
}

const flatVal = (x) => typeof x !== 'object' || x === null || (Array.isArray(x) && x.every((y) => typeof y !== 'object' || y === null));
function fmt(v, ind) {
  if (typeof v === 'number') return String(Math.round(v * 1e4) / 1e4);
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object' || x === null)) return `[${v.map((x) => fmt(x, ind)).join(', ')}]`;
    return `[\n${v.map((x) => `${ind}  ${fmt(x, `${ind}  `)}`).join(',\n')}\n${ind}]`;
  }
  if (v && typeof v === 'object') {
    const parts = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${fmt(x, `${ind}  `)}`);
    const one = `{ ${parts.join(', ')} }`;
    if (Object.values(v).every(flatVal) && one.length + ind.length < 150) return one;
    return `{\n${parts.map((s) => `${ind}  ${s}`).join(',\n')}\n${ind}}`;
  }
  return JSON.stringify(v);
}
