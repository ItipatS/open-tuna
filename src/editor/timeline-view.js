// Timeline panel: ruler (chapters, notes, playhead), one lane per story.json track, and a performance
// lane that records the fps measured at each point of the story. Drawn on one canvas; hit-tested by hand.
import { h } from './dom.js';
import { evalCurve, evalClip } from '../timeline.js';
import { PARAMS } from '../story.js';

const HEAD = 200; // track header width (px)
const CH = 20; // chapter band height
const RULER = 48; // ruler height (chapter band + ticks + notes)
const ROW = { camera: 32, captions: 32, curve: 30, clip: 26 };
const PERF_H = 34;
const COL = { camera: '#4fb8ff', captions: '#c792ea', curve: '#ffcb6b', clip: '#5fd4a0', note: '#ffd166', play: '#ff9f43' };
const TYPE = { camera: 'CAM', captions: 'TXT', curve: 'CRV', clip: 'CLIP' };

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export class TimelineView {
  constructor(ed, wrap) {
    this.ed = ed;
    this.wrap = wrap;
    this.cv = h('canvas');
    wrap.append(this.cv);
    this.ctx = this.cv.getContext('2d');
    this.v0 = -0.015; this.v1 = 1.015; // visible p range
    this.scrollY = 0;
    this.drag = null;
    this.hover = null;
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.resize();

    const cv = this.cv;
    cv.addEventListener('pointerdown', (e) => this.down(e));
    cv.addEventListener('pointermove', (e) => this.move(e));
    cv.addEventListener('pointerup', (e) => this.up(e));
    cv.addEventListener('pointercancel', (e) => this.up(e));
    cv.addEventListener('dblclick', (e) => this.dbl(e));
    cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerleave', () => { this.hover = null; });
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    this.dpr = devicePixelRatio || 1;
    this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.cv.width = Math.round(this.W * this.dpr); this.cv.height = Math.round(this.H * this.dpr);
    this.draw();
  }

  get k() { return (this.W - HEAD - 14) / (this.v1 - this.v0); } // px per unit p
  X(p) { return HEAD + (p - this.v0) * this.k; }
  P(x) { return this.v0 + (x - HEAD) / this.k; }
  fit() { this.v0 = -0.015; this.v1 = 1.015; }

  layout() {
    let y = RULER;
    const rows = this.ed.tl.tracks.map((t) => { const r = { t, y, h: ROW[t.type] || 26 }; y += r.h; return r; });
    rows.push({ perf: true, y, h: PERF_H });
    y += PERF_H;
    this.contentH = y;
    this.scrollY = clamp(this.scrollY, 0, Math.max(0, y - this.H + 6));
    return rows;
  }

  // ------------------------------------------------------------------ drawing
  draw() {
    const { ctx, W, H, ed } = this;
    if (!ctx) return;
    const rows = this.rows = this.layout();
    const tl = ed.tl, sel = ed.sel;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#1b1e23';
    ctx.fillRect(0, 0, W, H);
    ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // ---- lanes
    ctx.save();
    ctx.beginPath(); ctx.rect(0, RULER, W, H - RULER); ctx.clip();
    // chapter tint across the lanes
    tl.data.chapters.forEach((c, i) => {
      const x0 = Math.max(HEAD, this.X(c.p)), x1 = this.X(tl.data.chapters[i + 1]?.p ?? 1);
      if (i % 2) { ctx.fillStyle = 'rgba(255,255,255,0.018)'; ctx.fillRect(x0, RULER, x1 - x0, H); }
    });
    for (const r of rows) {
      const y = r.y - this.scrollY;
      if (y > H || y + r.h < RULER) continue;
      const selTrack = sel && sel.track === r.t;
      ctx.fillStyle = selTrack ? 'rgba(79,184,255,0.07)' : 'transparent';
      ctx.fillRect(HEAD, y, W - HEAD, r.h);
      ctx.fillStyle = '#2a2e35'; ctx.fillRect(0, y + r.h - 1, W, 1);
      ctx.save();
      ctx.beginPath(); ctx.rect(HEAD, y, W - HEAD, r.h); ctx.clip();
      ctx.globalAlpha = r.t?.mute ? 0.35 : 1;
      if (r.perf) this.drawPerf(y, r.h);
      else if (r.t.type === 'camera') this.drawKeys(r.t, y, r.h);
      else if (r.t.type === 'curve') this.drawCurve(r.t, y, r.h);
      else if (r.t.type === 'clip') this.drawClip(r.t, y, r.h);
      else if (r.t.type === 'captions') this.drawCaptions(r.t, y, r.h);
      ctx.restore();
      this.drawHeader(r, y, selTrack);
    }
    // chapter boundaries + playhead through the lanes
    for (const c of tl.data.chapters) { const x = this.X(c.p); if (x > HEAD) { ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x, RULER, 1, H); } }
    for (const n of tl.data.notes) { const x = this.X(n.p); if (x > HEAD) { ctx.fillStyle = 'rgba(255,209,102,0.22)'; ctx.fillRect(x, RULER, 1, H); } }
    const px = this.X(ed.p);
    if (px >= HEAD) { ctx.fillStyle = COL.play; ctx.fillRect(px - 0.5, RULER, 1.5, H); }
    ctx.restore();

    this.drawRuler();
  }

  drawHeader(r, y, selTrack) {
    const { ctx } = this;
    ctx.fillStyle = selTrack ? '#23384d' : '#20232a';
    ctx.fillRect(0, y, HEAD, r.h - 1);
    ctx.fillStyle = '#2a2e35'; ctx.fillRect(HEAD - 1, y, 1, r.h);
    if (r.perf) {
      ctx.fillStyle = '#8b93a0';
      ctx.fillText('Performance (fps)', 12, y + r.h / 2);
      return;
    }
    const t = r.t, c = COL[t.type] || '#aaa';
    ctx.fillStyle = c; ctx.fillRect(0, y, 3, r.h - 1);
    ctx.globalAlpha = t.mute ? 0.45 : 1;
    ctx.fillStyle = '#5d6470'; ctx.font = '600 9px Inter, system-ui, sans-serif';
    ctx.fillText(TYPE[t.type] || '', 10, y + r.h / 2);
    ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#d9dee6';
    ctx.fillText(this.ellipsis(t.label || t.id, HEAD - 72), 40, y + r.h / 2);
    ctx.globalAlpha = 1;
    // mute toggle
    const mx = HEAD - 16, my = y + r.h / 2;
    ctx.beginPath(); ctx.arc(mx, my, 4.5, 0, Math.PI * 2);
    ctx.strokeStyle = t.mute ? '#5d6470' : c; ctx.lineWidth = 1.5; ctx.stroke();
    if (!t.mute) { ctx.fillStyle = c; ctx.fill(); }
  }

  diamond(x, y, s, fill, stroke) {
    const { ctx } = this;
    ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  }

  drawKeys(t, y, hgt) {
    const { ctx, ed } = this, cy = y + hgt / 2;
    if (t.keys.length > 1) { ctx.fillStyle = 'rgba(79,184,255,0.25)'; ctx.fillRect(this.X(t.keys[0].p), cy - 1, this.X(t.keys.at(-1).p) - this.X(t.keys[0].p), 2); }
    t.keys.forEach((k, i) => {
      const s = ed.sel?.item === k;
      this.diamond(this.X(k.p), cy, s ? 7 : 6, s ? '#ffffff' : COL.camera, s ? COL.play : '#0d1a26');
      if (this.k * 0.03 > 26) { ctx.fillStyle = '#8b93a0'; ctx.fillText(String(i + 1), this.X(k.p) + 9, cy); }
    });
  }

  drawCurve(t, y, hgt) {
    const { ctx, ed } = this;
    if (!t.keys.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const k of t.keys) { lo = Math.min(lo, k.v); hi = Math.max(hi, k.v); }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const Y = (v) => y + hgt - 6 - ((v - lo) / (hi - lo)) * (hgt - 12);
    ctx.beginPath();
    for (let x = HEAD; x <= this.W; x += 2) {
      const v = evalCurve(t.keys, clamp(this.P(x), 0, 1));
      x === HEAD ? ctx.moveTo(x, Y(v)) : ctx.lineTo(x, Y(v));
    }
    ctx.strokeStyle = 'rgba(255,203,107,0.7)'; ctx.lineWidth = 1.5; ctx.stroke();
    for (const k of t.keys) {
      const s = ed.sel?.item === k;
      this.diamond(this.X(k.p), Y(k.v), s ? 6.5 : 5, s ? '#ffffff' : COL.curve, s ? COL.play : '#2a2000');
    }
    const P = PARAMS[t.bind];
    if (P) { ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillText(`${+evalCurve(t.keys, ed.p).toFixed(2)}`, Math.max(HEAD + 4, this.X(ed.p) + 6), y + 9); }
  }

  bar(x0, x1, y, hgt, color, selected) {
    const { ctx } = this, r = 4;
    const w = Math.max(2, x1 - x0);
    ctx.beginPath(); ctx.roundRect(x0, y, w, hgt, r);
    ctx.fillStyle = `${color}33`; ctx.fill();
    ctx.strokeStyle = selected ? '#ffffff' : `${color}aa`; ctx.lineWidth = selected ? 1.5 : 1; ctx.stroke();
  }

  drawClip(t, y, hgt) {
    const { ctx, ed } = this, c = COL.clip;
    const x0 = this.X(t.a), x1 = this.X(t.b), top = y + 4, bh = hgt - 8;
    const selected = ed.sel?.kind === 'track' && ed.sel.track === t;
    this.bar(x0, x1, top, bh, c, selected);
    // the ramp's shape (or a solid gate)
    ctx.beginPath();
    ctx.moveTo(x0, top + bh);
    for (let x = x0; x <= x1; x += 2) ctx.lineTo(x, top + bh - evalClip(t, this.P(x)) * bh);
    ctx.lineTo(x1, top + bh - evalClip(t, t.b - 1e-6) * bh);
    ctx.lineTo(x1, top + bh); ctx.closePath();
    ctx.fillStyle = `${c}40`; ctx.fill();
    ctx.fillStyle = '#d9dee6';
    const label = `${t.bind}${t.ease === 'gate' ? '' : ` · ${t.ease || 'linear'}`}`;
    if (x1 - x0 > 40) ctx.fillText(this.ellipsis(label, x1 - x0 - 12), Math.max(x0, HEAD) + 6, y + hgt / 2);
  }

  drawCaptions(t, y, hgt) {
    const { ctx, ed } = this, c = COL.captions;
    for (const cl of t.clips) {
      const x0 = this.X(cl.a), x1 = this.X(cl.b);
      this.bar(x0, x1, y + 4, hgt - 8, c, ed.sel?.item === cl);
      ctx.fillStyle = '#e8dcf5';
      if (x1 - x0 > 30) ctx.fillText(this.ellipsis((cl.title || '(empty)').replace(/\n/g, ' '), x1 - x0 - 12), Math.max(x0, HEAD) + 6, y + hgt / 2);
    }
  }

  drawPerf(y, hgt) {
    const { ctx, ed } = this, N = ed.perf.length, w = Math.max(1, this.k / N);
    for (let i = 0; i < N; i++) {
      const f = ed.perf[i];
      if (!f) continue;
      const x = this.X(i / N);
      if (x + w < HEAD || x > this.W) continue;
      const bh = (Math.min(f, 60) / 60) * (hgt - 8);
      ctx.fillStyle = f >= 55 ? '#4cd17a' : f >= 40 ? '#f5c542' : '#ff5d5d';
      ctx.fillRect(x, y + hgt - 4 - bh, w + 0.5, bh);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(HEAD, y + hgt - 4 - ((45 / 60) * (hgt - 8)), this.W, 1); // 45 fps line
  }

  drawRuler() {
    const { ctx, W, ed } = this, tl = ed.tl;
    ctx.fillStyle = '#20232a'; ctx.fillRect(0, 0, W, RULER);
    ctx.fillStyle = '#2a2e35'; ctx.fillRect(0, RULER - 1, W, 1);
    ctx.save();
    ctx.beginPath(); ctx.rect(HEAD, 0, W - HEAD, RULER); ctx.clip();
    // chapters
    tl.data.chapters.forEach((c, i) => {
      const x0 = this.X(c.p), x1 = this.X(tl.data.chapters[i + 1]?.p ?? 1);
      const s = ed.sel?.item === c;
      ctx.fillStyle = s ? '#2d6fa3' : i % 2 ? '#2a3a4a' : '#24323f';
      ctx.fillRect(x0, 2, x1 - x0 - 1, CH - 3);
      ctx.fillStyle = s ? '#4fb8ff' : '#3d5973'; ctx.fillRect(x0, 2, 2, CH - 3);
      ctx.fillStyle = '#cfe3f5';
      if (x1 - x0 > 30) ctx.fillText(this.ellipsis(c.name, x1 - x0 - 12), Math.max(x0, HEAD) + 6, 2 + (CH - 3) / 2);
    });
    // ticks
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2];
    const major = steps.find((s) => s * this.k >= 64) ?? 0.2;
    const minor = major / (String(major).includes('2') ? 4 : 5);
    const dec = Math.max(1, Math.ceil(-Math.log10(major) - 1e-9));
    ctx.fillStyle = '#4a515c';
    for (let p = Math.ceil(Math.max(0, this.v0) / minor) * minor; p <= Math.min(1, this.v1) + 1e-9; p += minor) ctx.fillRect(this.X(p), RULER - 6, 1, 5);
    ctx.fillStyle = '#8b93a0';
    for (let p = Math.ceil(Math.max(0, this.v0) / major) * major; p <= Math.min(1, this.v1) + 1e-9; p += major) {
      const x = this.X(p);
      ctx.fillRect(x, RULER - 11, 1, 10);
      ctx.fillText(p.toFixed(dec), x + 3, CH + 10);
    }
    // out-of-range shading
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    if (this.v0 < 0) ctx.fillRect(HEAD, 0, this.X(0) - HEAD, RULER);
    if (this.v1 > 1) ctx.fillRect(this.X(1), 0, W, RULER);
    // notes
    for (const n of tl.data.notes) {
      const x = this.X(n.p), s = ed.sel?.item === n;
      ctx.beginPath(); ctx.moveTo(x, RULER - 1); ctx.lineTo(x, RULER - 15); ctx.lineTo(x + 9, RULER - 11); ctx.lineTo(x, RULER - 7);
      ctx.fillStyle = s ? '#ffffff' : COL.note; ctx.fill();
      if (s || this.hover?.item === n) {
        const txt = this.ellipsis(n.text || 'note', 260), tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(20,22,26,0.95)'; ctx.fillRect(x + 12, RULER - 19, tw + 10, 15);
        ctx.fillStyle = COL.note; ctx.fillText(txt, x + 17, RULER - 11.5);
      }
    }
    // playhead
    const x = this.X(ed.p);
    ctx.fillStyle = COL.play;
    ctx.beginPath(); ctx.moveTo(x - 6, CH + 2); ctx.lineTo(x + 6, CH + 2); ctx.lineTo(x + 6, RULER - 10); ctx.lineTo(x, RULER - 3); ctx.lineTo(x - 6, RULER - 10); ctx.closePath(); ctx.fill();
    ctx.fillRect(x - 0.5, 0, 1.5, RULER);
    ctx.restore();
    // corner: current position
    ctx.fillStyle = '#20232a'; ctx.fillRect(0, 0, HEAD - 1, RULER - 1);
    ctx.fillStyle = COL.play; ctx.font = '600 13px Inter, system-ui, sans-serif';
    ctx.fillText(`p ${ed.p.toFixed(3)}`, 12, 15);
    ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#8b93a0';
    ctx.fillText(this.ellipsis(`${(ed.p * (tl.meta.playDuration ?? 60)).toFixed(1)} s · ${tl.chapter(ed.p)?.name ?? ''}`, HEAD - 20), 12, 34);
  }

  ellipsis(s, w) {
    const { ctx } = this;
    if (ctx.measureText(s).width <= w) return s;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > w) s = s.slice(0, -1);
    return `${s}…`;
  }

  // ------------------------------------------------------------------ hit testing
  hit(x, y) {
    const tl = this.ed.tl;
    if (y < RULER) {
      if (x < HEAD) return { type: 'ruler' };
      if (y > RULER - 17) {
        const n = tl.data.notes.find((m) => x >= this.X(m.p) - 3 && x <= this.X(m.p) + 10);
        if (n) return { type: 'note', item: n };
      }
      if (y < CH + 1) {
        const edge = tl.data.chapters.find((c) => Math.abs(this.X(c.p) - x) < 5 && c.p > 0);
        if (edge) return { type: 'chapter', item: edge, edge: true };
        const cs = tl.data.chapters;
        for (let i = cs.length - 1; i >= 0; i--) if (x >= this.X(cs[i].p)) return { type: 'chapter', item: cs[i] };
      }
      return { type: 'ruler' };
    }
    const cy = y + this.scrollY;
    const r = this.rows.find((q) => cy >= q.y && cy < q.y + q.h);
    if (!r) return null;
    if (r.perf) return { type: x < HEAD ? 'perfHead' : 'ruler' };
    const t = r.t;
    if (x < HEAD) return { type: 'header', track: t, mute: x > HEAD - 28 };
    if (t.keys) {
      let best = null, bd = 8;
      for (const k of t.keys) { const d = Math.abs(this.X(k.p) - x); if (d < bd) { bd = d; best = k; } }
      if (best) return { type: 'key', track: t, item: best };
    }
    if (t.type === 'clip') {
      const x0 = this.X(t.a), x1 = this.X(t.b);
      if (Math.abs(x - x0) < 6) return { type: 'edgeA', track: t, item: t };
      if (Math.abs(x - x1) < 6) return { type: 'edgeB', track: t, item: t };
      if (x > x0 && x < x1) return { type: 'body', track: t, item: t };
    }
    if (t.type === 'captions') {
      for (let i = t.clips.length - 1; i >= 0; i--) {
        const c = t.clips[i], x0 = this.X(c.a), x1 = this.X(c.b);
        if (Math.abs(x - x0) < 6) return { type: 'edgeA', track: t, item: c };
        if (Math.abs(x - x1) < 6) return { type: 'edgeB', track: t, item: c };
        if (x > x0 && x < x1) return { type: 'body', track: t, item: c };
      }
    }
    return { type: 'lane', track: t };
  }

  // snap p to the playhead, chapters, notes, other keys / clip edges, else to a zoom-dependent grid
  snap(p, e, self) {
    if (!this.ed.snap || e.shiftKey) return clamp(p, 0, 1);
    const tl = this.ed.tl, cand = [0, 1];
    if (this.drag?.type !== 'scrub') cand.push(this.ed.p);
    for (const c of tl.data.chapters) if (c !== self) cand.push(c.p);
    for (const n of tl.data.notes) if (n !== self) cand.push(n.p);
    for (const t of tl.tracks) {
      if (t.keys) for (const k of t.keys) if (k !== self) cand.push(k.p);
      if (t.type === 'clip' && t !== self) cand.push(t.a, t.b);
      if (t.clips) for (const c of t.clips) if (c !== self) cand.push(c.a, c.b);
    }
    let best = null, bd = 7 / this.k;
    for (const c of cand) { const d = Math.abs(c - p); if (d < bd) { bd = d; best = c; } }
    if (best !== null) return best;
    const grid = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05].find((s) => s * this.k >= 7) ?? 0.05;
    return clamp(Math.round(p / grid) * grid, 0, 1);
  }

  // ------------------------------------------------------------------ pointer
  xy(e) { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  down(e) {
    const [x, y] = this.xy(e), ed = this.ed;
    this.cv.setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && e.altKey)) { this.drag = { type: 'pan', x, v0: this.v0, v1: this.v1 }; return; }
    if (e.button !== 0) return;
    const hit = this.hit(x, y);
    if (!hit) return;
    const p = this.P(x);
    switch (hit.type) {
      case 'ruler': case 'perfHead':
        ed.pause();
        this.drag = { type: 'scrub' };
        ed.setP(clamp(p, 0, 1));
        break;
      case 'chapter':
        ed.select({ kind: 'chapter', item: hit.item });
        if (hit.edge) this.drag = { type: 'marker', item: hit.item, off: hit.item.p - p };
        else ed.setP(hit.item.p);
        break;
      case 'note':
        ed.select({ kind: 'note', item: hit.item });
        this.drag = { type: 'marker', item: hit.item, off: hit.item.p - p };
        break;
      case 'header':
        if (hit.mute) {
          if (hit.track.mute) delete hit.track.mute; else hit.track.mute = true;
          ed.changed(); ed.commit();
        }
        ed.select({ kind: 'track', track: hit.track });
        break;
      case 'key':
        ed.select({ kind: 'key', track: hit.track, item: hit.item });
        this.drag = { type: 'key', item: hit.item, off: hit.item.p - p };
        break;
      case 'edgeA': case 'edgeB': case 'body': {
        const it = hit.item;
        ed.select(hit.track.type === 'captions' ? { kind: 'clip', track: hit.track, item: it } : { kind: 'track', track: hit.track });
        this.drag = { type: hit.type, item: it, off: p, a: it.a, b: it.b };
        break;
      }
      case 'lane':
        ed.select({ kind: 'track', track: hit.track });
        break;
    }
    if (this.drag) this.drag.moved = false;
  }

  move(e) {
    const [x, y] = this.xy(e), d = this.drag, ed = this.ed;
    if (!d) {
      const hit = this.hit(x, y);
      const prev = this.hover?.item;
      this.hover = hit;
      this.cv.style.cursor = !hit ? 'default'
        : /edge|key|marker/.test(hit.type) || (hit.type === 'chapter' && hit.edge) || hit.type === 'note' ? 'ew-resize'
          : hit.type === 'body' ? 'grab' : hit.type === 'ruler' ? 'col-resize' : 'pointer';
      if (prev !== hit?.item) this.draw();
      return;
    }
    const p = this.P(x);
    d.moved = true;
    if (d.type === 'pan') {
      const dp = (x - d.x) / this.k;
      this.v0 = d.v0 - dp; this.v1 = d.v1 - dp;
    } else if (d.type === 'scrub') ed.setP(clamp(p, 0, 1));
    else if (d.type === 'marker' || d.type === 'key') {
      d.item.p = this.snap(p + d.off, e, d.item);
      ed.changed();
    } else if (d.type === 'edgeA') {
      d.item.a = Math.min(this.snap(p, e, d.item), d.item.b - 0.002);
      ed.changed();
    } else if (d.type === 'edgeB') {
      d.item.b = Math.max(this.snap(p, e, d.item), d.item.a + 0.002);
      ed.changed();
    } else if (d.type === 'body') {
      const w = d.b - d.a;
      let a = clamp(d.a + (p - d.off), 0, 1 - w);
      const sa = this.snap(a, e, d.item), sb = this.snap(a + w, e, d.item);
      a = Math.abs(sa - a) <= Math.abs(sb - (a + w)) ? sa : sb - w;
      d.item.a = clamp(a, 0, 1 - w); d.item.b = d.item.a + w;
      ed.changed();
    }
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    if (this.cv.hasPointerCapture(e.pointerId)) this.cv.releasePointerCapture(e.pointerId);
    if (d && d.moved && d.type !== 'scrub' && d.type !== 'pan') this.ed.commit();
  }

  dbl(e) {
    const [x, y] = this.xy(e), ed = this.ed, hit = this.hit(x, y);
    if (!hit) return;
    const p = this.snap(this.P(x), e);
    if (y < CH + 1 && x > HEAD) { ed.setP(p); ed.addChapter(); return; }
    if (y < RULER && x > HEAD) { ed.setP(p); ed.addNote(); return; }
    if (hit.type === 'lane' || hit.type === 'body') {
      const t = hit.track;
      if (t.type === 'camera' || t.type === 'curve') { ed.setP(p); ed.addKey(t); }
      if (t.type === 'captions' && hit.type === 'lane') { ed.setP(p); ed.addCaption(); }
    }
  }

  wheel(e) {
    e.preventDefault();
    const [x] = this.xy(e);
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(e.deltaY * 0.0018), pc = this.P(Math.max(x, HEAD));
      let span = clamp((this.v1 - this.v0) * f, 0.004, 1.3);
      this.v0 = pc - (pc - this.v0) * (span / (this.v1 - this.v0));
      this.v1 = this.v0 + span;
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dp = (e.shiftKey ? e.deltaY : e.deltaX) / this.k;
      this.v0 += dp; this.v1 += dp;
    } else {
      this.scrollY += e.deltaY * 0.5;
    }
    this.draw();
  }
}
