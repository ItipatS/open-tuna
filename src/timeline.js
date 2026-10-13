// The story timeline: the data model behind story.json, shared by the site (scroll / play) and the
// editor (?edit). The whole story is a pure function of one progress value p (0..1).
//
// Track types (story.json `tracks`, drawn top to bottom in the editor):
//   camera    keys {p, pos[3], look[3], follow 0..1 (look at the school instead), fov}; Hermite spline in p.
//             `drift` scales a slow hand-held sway.
//   curve     keys {p, v, ease} driving one scalar parameter (`bind`, see PARAMS in story.js).
//             `ease` shapes the segment that starts at that key.
//   clip      one clip [a, b] driving a story beat (`bind`, see DRIVERS in story.js): ramps 0 -> 1 across
//             the clip with `ease`, or with ease "gate" is 1 inside the clip and 0 outside.
//   captions  clips {a, b, title, sub, size, y} shown over the canvas.
// `mute: true` on a track disables it. `chapters` [{p, name}] and `notes` [{p, text}] are markers for
// people (the editor shows them; notes are a way to leave instructions for whoever edits next).

export const EASES = {
  linear: (k) => k,
  smooth: (k) => k * k * (3 - 2 * k),
  in: (k) => k * k,
  out: (k) => 1 - (1 - k) * (1 - k),
  hold: (k) => (k < 1 ? 0 : 1),
};
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// index pair around p (keys sorted by p) and the local parameter s in [0, 1]
function segment(keys, p) {
  const n = keys.length;
  if (p <= keys[0].p) return [0, 0, 0];
  if (p >= keys[n - 1].p) return [n - 1, n - 1, 0];
  let i = 0;
  while (i < n - 2 && p >= keys[i + 1].p) i++;
  const dp = keys[i + 1].p - keys[i].p;
  return [i, i + 1, dp > 0 ? (p - keys[i].p) / dp : 1];
}

// cubic Hermite through the keys, parametrised by p (finite-difference tangents, flat at both ends)
function hermite(keys, p, field, out) {
  const [i, j, s] = segment(keys, p);
  const A = keys[i][field], B = keys[j][field];
  if (i === j) { for (let c = 0; c < out.length; c++) out[c] = A[c]; return out; }
  const h = keys[j].p - keys[i].p;
  const slope = (k, c) => {
    if (k <= 0 || k >= keys.length - 1) return 0;
    const dp = keys[k + 1].p - keys[k - 1].p;
    return dp > 0 ? (keys[k + 1][field][c] - keys[k - 1][field][c]) / dp : 0;
  };
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  for (let c = 0; c < out.length; c++) out[c] = h00 * A[c] + h10 * h * slope(i, c) + h01 * B[c] + h11 * h * slope(j, c);
  return out;
}

export function evalCurve(keys, p) {
  if (!keys.length) return undefined;
  const [i, j, s] = segment(keys, p);
  if (i === j) return keys[i].v;
  return keys[i].v + (keys[j].v - keys[i].v) * (EASES[keys[i].ease] || EASES.smooth)(s);
}

export function evalClip(t, p) {
  if (t.ease === 'gate') return p >= t.a && (p < t.b || t.b >= 1) ? 1 : 0;
  return (EASES[t.ease] || EASES.linear)(clamp01((p - t.a) / Math.max(t.b - t.a, 1e-6)));
}

// caption opacity: fades over `fade` at each end (none at the very start / end of the story)
export function captionOpacity(c, p) {
  const f = c.fade ?? 0.04;
  const sm = (a, b, x) => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k); };
  const fin = c.a <= 0 ? (p >= c.a ? 1 : 0) : sm(c.a, c.a + f, p);
  const fout = c.b >= 1 ? (p <= c.b ? 1 : 0) : 1 - sm(c.b - f, c.b, p);
  return Math.min(fin, fout);
}

export class Timeline {
  constructor(data) { this.version = 0; this.set(data); }

  set(data) {
    data.meta ??= {};
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
      if (t.keys) t.keys.sort((x, y) => x.p - y.p);
      if (t.clips) t.clips.sort((x, y) => x.a - y.a);
    }
    d.chapters.sort((x, y) => x.p - y.p);
    d.notes.sort((x, y) => x.p - y.p);
    this.bound = new Map(d.tracks.filter((t) => t.bind).map((t) => [t.bind, t]));
    this.version++;
  }

  get meta() { return this.data.meta; }
  get tracks() { return this.data.tracks; }
  track(id) { return this.data.tracks.find((t) => t.id === id); }
  ofType(type) { return this.data.tracks.find((t) => t.type === type && !t.mute); }

  // clip driver value (0 when there is no such track or it is muted)
  clip(bind, p) {
    const t = this.bound.get(bind);
    return t && !t.mute && t.type === 'clip' ? evalClip(t, p) : 0;
  }

  // scalar parameter: animated by a curve track, else the constant in settings.params, else `def`
  param(bind, p, def) {
    const t = this.bound.get(bind);
    if (t && !t.mute && t.type === 'curve' && t.keys.length) return evalCurve(t.keys, p);
    return this.data.settings.params[bind] ?? def;
  }

  // camera pose at p into out = {pos:[3], look:[3], follow, fov}; false when there is no camera track
  camera(p, out) {
    const t = this.ofType('camera');
    if (!t || !t.keys.length) return false;
    hermite(t.keys, p, 'pos', out.pos);
    hermite(t.keys, p, 'look', out.look);
    const [i, j, s] = segment(t.keys, p), e = EASES.smooth(s);
    const A = t.keys[i], B = t.keys[j];
    out.follow = (A.follow ?? 0) + ((B.follow ?? 0) - (A.follow ?? 0)) * e;
    out.fov = (A.fov ?? 50) + ((B.fov ?? 50) - (A.fov ?? 50)) * e;
    out.drift = t.drift ?? 1;
    return true;
  }

  captions() { return this.ofType('captions')?.clips ?? []; }

  chapter(p) {
    let c = null;
    for (const ch of this.data.chapters) if (ch.p <= p + 1e-9) c = ch;
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
