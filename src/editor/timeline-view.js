// Timeline panel: ruler (chapters, notes, playhead, story end), one lane per story.json track, and a
// performance lane that records the fps measured at each moment. All in story time (seconds); the visible
// range zooms from a fraction of a second to hours. Drawn on one canvas; hit-tested by hand.
import { h } from './dom.js';
import { evalCurve, evalClip, fmtTime } from '../timeline.js';
import { PARAMS } from '../story.js';

const HEAD = 210; // track header width (px)
const CH = 20; // chapter band height
const RULER = 48; // ruler height (chapter band + ticks + notes)
const ROW = { camera: 32, captions: 32, curve: 30, clip: 26, layer: 30 };
const PERF_H = 34;
const COL = { camera: '#4fb8ff', captions: '#c792ea', curve: '#ffcb6b', clip: '#5fd4a0', layer: '#f78fb3', note: '#ffd166', play: '#ff9f43', end: '#ff5d8f' };
const TYPE = { camera: 'CAM', captions: 'TXT', curve: 'CRV', clip: 'CLIP', layer: 'LYR' };
const KIND = { image: 'IMG', video: 'VID', html: 'HTML', iframe: 'WEB' };
const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export class TimelineView {
  constructor(ed, wrap) {
    this.ed = ed;
    this.wrap = wrap;
    this.cv = h('canvas');
    wrap.append(this.cv);
    this.ctx = this.cv.getContext('2d');
    this.scrollY = 0;
    this.drag = null;
    this.hover = null;
    this.fit(false);
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.resize();

    const cv = this.cv;
    cv.addEventListener('pointerdown', (e) => this.down(e));
    cv.addEventListener('pointermove', (e) => this.move(e));
    cv.addEventListener('pointerup', (e) => this.up(e));
    cv.addEventListener('pointercancel', (e) => this.up(e));
    cv.addEventListener('dblclick', (e) => this.dbl(e));
    cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    cv.addEventListener('contextmenu', (e) => this.context(e));
    cv.addEventListener('pointerleave', () => { this.hover = null; });
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    this.dpr = devicePixelRatio || 1;
    this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.cv.width = Math.round(this.W * this.dpr); this.cv.height = Math.round(this.H * this.dpr);
    if (!this.sized) { this.sized = true; this.fit(false); }
    this.draw();
  }

  get D() { return this.ed.duration; }
  get k() { return (this.W - HEAD - 14) / (this.v1 - this.v0); } // px per second
  X(t) { return HEAD + (t - this.v0) * this.k; }
  T(x) { return this.v0 + (x - HEAD) / this.k; }
  // whole story in view, with room after the end for its END label
  fit(redraw = true) {
    const avail = Math.max(200, (this.W || 1000) - HEAD - 14);
    this.v0 = -this.D * 0.012;
    this.v1 = this.v0 + (this.D * 1.012) / Math.max(0.5, 1 - 78 / avail);
    if (redraw) this.draw();
  }
  zoomTo(a, b) { this.v0 = Math.max(-this.D * 0.05, a); this.v1 = Math.max(this.v0 + 0.2, b); this.draw(); }

  // keep the playhead in view while playing (page-flip like a video editor)
  follow() {
    const x = this.X(this.ed.time);
    if (x > this.W - 30 || x < HEAD) {
      const span = this.v1 - this.v0;
      this.v0 = this.ed.time - span * 0.1;
      this.v1 = this.v0 + span;
    }
  }

  layout() {
    let y = RULER;
    const rows = this.ed.tl.tracks.map((t) => { const r = { t, y, h: ROW[t.type] || 26 }; y += r.h; return r; });
    rows.push({ perf: true, y, h: PERF_H });
    y += PERF_H;
    this.contentH = y;
    this.scrollY = clamp(this.scrollY, 0, Math.max(0, y - this.H + 6));
    return rows;
  }

  locked(track, item) { return !!(track?.locked || item?.locked); }

  // ------------------------------------------------------------------ drawing
  draw() {
    const { ctx, W, H, ed } = this;
    if (!ctx) return;
    const rows = this.rows = this.layout();
    const tl = ed.tl, sel = ed.sel, D = this.D;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#1b1e23';
    ctx.fillRect(0, 0, W, H);
    ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // ---- lanes
    ctx.save();
    ctx.beginPath(); ctx.rect(0, RULER, W, H - RULER); ctx.clip();
    tl.data.chapters.forEach((c, i) => {
      const x0 = Math.max(HEAD, this.X(c.t)), x1 = this.X(tl.data.chapters[i + 1]?.t ?? D);
      if (i % 2) { ctx.fillStyle = 'rgba(255,255,255,0.018)'; ctx.fillRect(x0, RULER, x1 - x0, H); }
    });
    for (const r of rows) {
      const y = r.y - this.scrollY;
      if (y > H || y + r.h < RULER) continue;
      const selTrack = sel && sel.track === r.t;
      if (selTrack) { ctx.fillStyle = 'rgba(79,184,255,0.07)'; ctx.fillRect(HEAD, y, W - HEAD, r.h); }
      if (r.t?.locked) this.hatch(HEAD, y, W - HEAD, r.h);
      ctx.fillStyle = '#2a2e35'; ctx.fillRect(0, y + r.h - 1, W, 1);
      ctx.save();
      ctx.beginPath(); ctx.rect(HEAD, y, W - HEAD, r.h); ctx.clip();
      ctx.globalAlpha = r.t?.mute ? 0.35 : 1;
      if (r.perf) this.drawPerf(y, r.h);
      else if (r.t.type === 'camera') this.drawKeys(r.t, y, r.h);
      else if (r.t.type === 'curve') this.drawCurve(r.t, y, r.h);
      else if (r.t.type === 'clip') this.drawClip(r.t, y, r.h);
      else if (r.t.type === 'captions') this.drawCaptions(r.t, y, r.h);
      else if (r.t.type === 'layer') this.drawLayer(r.t, y, r.h);
      ctx.restore();
      this.drawHeader(r, y, selTrack);
    }
    // beyond the end of the story
    const xe = this.X(D);
    if (xe < W) { ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fillRect(Math.max(HEAD, xe), RULER, W, H); }
    if (xe > HEAD && xe < W) { ctx.fillStyle = COL.end; ctx.fillRect(xe - 0.5, RULER, 1.5, H); }
    for (const c of tl.data.chapters) { const x = this.X(c.t); if (x > HEAD) { ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x, RULER, 1, H); } }
    for (const n of tl.data.notes) { const x = this.X(n.t); if (x > HEAD) { ctx.fillStyle = 'rgba(255,209,102,0.22)'; ctx.fillRect(x, RULER, 1, H); } }
    const px = this.X(ed.time);
    if (px >= HEAD) { ctx.fillStyle = COL.play; ctx.fillRect(px - 0.5, RULER, 1.5, H); }
    ctx.restore();

    this.drawRuler();
  }

  hatch(x, y, w, hh) {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, hh); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.045)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = x - hh; i < x + w; i += 9) { ctx.moveTo(i, y + hh); ctx.lineTo(i + hh, y); }
    ctx.stroke();
    ctx.restore();
  }

  lockIcon(x, y, color = '#c9d1db') {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.arc(x, y - 2.5, 2.6, Math.PI, 0); ctx.stroke();
    ctx.fillRect(x - 3.8, y - 2.5, 7.6, 6);
    ctx.restore();
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
    const t = r.t, c = COL[t.type] || '#aaa', my = y + r.h / 2;
    ctx.fillStyle = c; ctx.fillRect(0, y, 3, r.h - 1);
    ctx.globalAlpha = t.mute ? 0.45 : 1;
    ctx.fillStyle = '#5d6470'; ctx.font = '600 9px Inter, system-ui, sans-serif';
    ctx.fillText(TYPE[t.type] || '', 10, my);
    ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#d9dee6';
    ctx.fillText(this.ellipsis(t.label || t.id, HEAD - 92), 40, my);
    ctx.globalAlpha = 1;
    // lock toggle
    const lx = HEAD - 38;
    if (t.locked) this.lockIcon(lx, my + 1, '#ffb35c');
    else { ctx.globalAlpha = 0.28; this.lockIcon(lx, my + 1, '#8b93a0'); ctx.globalAlpha = 1; }
    // mute toggle
    const mx = HEAD - 16;
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
    if (t.keys.length > 1) { ctx.fillStyle = 'rgba(79,184,255,0.25)'; ctx.fillRect(this.X(t.keys[0].t), cy - 1, this.X(t.keys.at(-1).t) - this.X(t.keys[0].t), 2); }
    const labels = t.keys.length < 2 || (this.X(t.keys[1].t) - this.X(t.keys[0].t)) > 22 || this.k * 2 > 22;
    t.keys.forEach((k, i) => {
      const x = this.X(k.t);
      if (x < HEAD - 10 || x > this.W + 10) return;
      const s = ed.sel?.item === k;
      this.diamond(x, cy, s ? 7 : 6, s ? '#ffffff' : k.locked ? '#7d8a99' : COL.camera, s ? COL.play : '#0d1a26');
      if (k.locked) this.lockIcon(x, cy - 12, '#ffb35c');
      if (labels) { ctx.fillStyle = '#8b93a0'; ctx.fillText(String(i + 1), x + 9, cy); }
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
      const v = evalCurve(t.keys, clamp(this.T(x), 0, this.D));
      x === HEAD ? ctx.moveTo(x, Y(v)) : ctx.lineTo(x, Y(v));
    }
    ctx.strokeStyle = 'rgba(255,203,107,0.7)'; ctx.lineWidth = 1.5; ctx.stroke();
    for (const k of t.keys) {
      const s = ed.sel?.item === k, x = this.X(k.t);
      this.diamond(x, Y(k.v), s ? 6.5 : 5, s ? '#ffffff' : k.locked ? '#9a8d6b' : COL.curve, s ? COL.play : '#2a2000');
      if (k.locked) this.lockIcon(x + 9, Y(k.v) - 6, '#ffb35c');
    }
    if (PARAMS[t.bind]) { ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillText(`${+evalCurve(t.keys, ed.time).toFixed(2)}`, Math.max(HEAD + 4, this.X(ed.time) + 6), y + 9); }
  }

  bar(x0, x1, y, hgt, color, selected, locked) {
    const { ctx } = this;
    const w = Math.max(2, x1 - x0);
    ctx.beginPath(); ctx.roundRect(x0, y, w, hgt, 4);
    ctx.fillStyle = `${color}33`; ctx.fill();
    ctx.strokeStyle = selected ? '#ffffff' : locked ? '#ffb35c99' : `${color}aa`;
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.setLineDash(locked && !selected ? [4, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawClip(t, y, hgt) {
    const { ctx, ed } = this, c = COL.clip;
    const x0 = this.X(t.a), x1 = this.X(t.b), top = y + 4, bh = hgt - 8;
    const selected = ed.sel?.kind === 'track' && ed.sel.track === t;
    this.bar(x0, x1, top, bh, c, selected, t.locked);
    ctx.beginPath();
    ctx.moveTo(x0, top + bh);
    const step = Math.max(2, (x1 - x0) / 400);
    for (let x = Math.max(x0, HEAD); x <= Math.min(x1, this.W + 2); x += step) ctx.lineTo(x, top + bh - evalClip(t, this.T(x), this.D) * bh);
    ctx.lineTo(Math.min(x1, this.W + 2), top + bh - evalClip(t, Math.min(t.b - 1e-6, this.T(this.W + 2)), this.D) * bh);
    ctx.lineTo(Math.min(x1, this.W + 2), top + bh); ctx.closePath();
    ctx.fillStyle = `${c}40`; ctx.fill();
    ctx.fillStyle = '#d9dee6';
    const label = `${t.bind}${t.ease === 'gate' ? '' : ` · ${t.ease || 'linear'}`}`;
    if (x1 - x0 > 40) ctx.fillText(this.ellipsis(label, Math.min(x1, this.W) - Math.max(x0, HEAD) - 12), Math.max(x0, HEAD) + 6, y + hgt / 2);
  }

  drawCaptions(t, y, hgt) {
    const { ctx, ed } = this, c = COL.captions;
    for (const cl of t.clips) {
      const x0 = this.X(cl.a), x1 = this.X(cl.b);
      if (x1 < HEAD || x0 > this.W) continue;
      this.bar(x0, x1, y + 4, hgt - 8, c, ed.sel?.item === cl, cl.locked || t.locked);
      let tx = Math.max(x0, HEAD) + 6;
      if (cl.locked) { this.lockIcon(tx + 3, y + hgt / 2 + 1, '#ffb35c'); tx += 12; }
      ctx.fillStyle = '#e8dcf5';
      if (x1 - x0 > 30) ctx.fillText(this.ellipsis((cl.title || '(empty)').replace(/\n/g, ' '), Math.min(x1, this.W) - tx - 6), tx, y + hgt / 2);
    }
  }

  drawLayer(t, y, hgt) {
    const { ctx, ed } = this, c = COL.layer, cy = y + hgt / 2;
    const x0 = this.X(t.a), x1 = this.X(t.b);
    const selected = ed.sel?.kind === 'track' && ed.sel.track === t;
    this.bar(x0, x1, y + 4, hgt - 8, c, selected, t.locked);
    // fades
    const f = t.fade ?? 2.4, fw = Math.min((x1 - x0) / 2, f * this.k);
    ctx.fillStyle = `${c}30`;
    ctx.beginPath(); ctx.moveTo(x0, y + hgt - 4); ctx.lineTo(x0 + fw, y + 4); ctx.lineTo(x0, y + 4); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x1, y + hgt - 4); ctx.lineTo(x1 - fw, y + 4); ctx.lineTo(x1, y + 4); ctx.fill();
    let tx = Math.max(x0, HEAD) + 6;
    ctx.fillStyle = '#fbd3e3';
    ctx.font = '600 9px Inter, system-ui, sans-serif';
    const tag = `${KIND[t.kind] || ''}${t.space === 'world' ? ' 3D' : ''}`;
    if (x1 - x0 > 60) { ctx.fillText(tag, tx, cy); tx += ctx.measureText(tag).width + 6; }
    ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif';
    if (x1 - x0 > 70) ctx.fillText(this.ellipsis(t.label || '', Math.min(x1, this.W) - tx - 6), tx, cy);
    if (t.keys.length > 1) {
      for (const k of t.keys) {
        const s = ed.sel?.item === k, kx = this.X(k.t);
        this.diamond(kx, cy, s ? 6.5 : 5, s ? '#ffffff' : k.locked ? '#9a7d88' : c, s ? COL.play : '#2a0d18');
      }
    }
  }

  drawPerf(y, hgt) {
    const { ctx, ed } = this, N = ed.perf.length, step = 0.5, w = Math.max(1, this.k * step);
    const i0 = Math.max(0, Math.floor(this.v0 / step)), i1 = Math.min(N - 1, Math.ceil(this.v1 / step));
    for (let i = i0; i <= i1; i++) {
      const f = ed.perf[i];
      if (!f) continue;
      const x = this.X(i * step);
      const bh = (Math.min(f, 60) / 60) * (hgt - 8);
      ctx.fillStyle = f >= 55 ? '#4cd17a' : f >= 40 ? '#f5c542' : '#ff5d5d';
      ctx.fillRect(x, y + hgt - 4 - bh, w + 0.5, bh);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(HEAD, y + hgt - 4 - ((45 / 60) * (hgt - 8)), this.W, 1); // 45 fps line
  }

  drawRuler() {
    const { ctx, W, ed } = this, tl = ed.tl, D = this.D;
    ctx.fillStyle = '#20232a'; ctx.fillRect(0, 0, W, RULER);
    ctx.fillStyle = '#2a2e35'; ctx.fillRect(0, RULER - 1, W, 1);
    ctx.save();
    ctx.beginPath(); ctx.rect(HEAD, 0, W - HEAD, RULER); ctx.clip();
    // chapters
    tl.data.chapters.forEach((c, i) => {
      const x0 = this.X(c.t), x1 = this.X(tl.data.chapters[i + 1]?.t ?? D);
      if (x1 < HEAD || x0 > W) return;
      const s = ed.sel?.item === c;
      ctx.fillStyle = s ? '#2d6fa3' : i % 2 ? '#2a3a4a' : '#24323f';
      ctx.fillRect(x0, 2, Math.max(1, x1 - x0 - 1), CH - 3);
      ctx.fillStyle = s ? '#4fb8ff' : '#3d5973'; ctx.fillRect(x0, 2, 2, CH - 3);
      let tx = Math.max(x0, HEAD) + 6;
      if (c.locked) { this.lockIcon(tx + 3, 2 + (CH - 3) / 2 + 1, '#ffb35c'); tx += 12; }
      ctx.fillStyle = '#cfe3f5';
      if (x1 - x0 > 30) ctx.fillText(this.ellipsis(c.name, Math.min(x1, W) - tx - 6), tx, 2 + (CH - 3) / 2);
    });
    // ticks: major step gives labels >= 72 px apart
    const major = STEPS.find((s) => s * this.k >= 72) ?? 3600;
    const minor = [...STEPS].reverse().find((s) => s < major && s * this.k >= 9 && Math.abs(major / s - Math.round(major / s)) < 1e-6) ?? major;
    const dec = major < 1 ? 2 : 0;
    ctx.fillStyle = '#4a515c';
    for (let t = Math.ceil(Math.max(0, this.v0) / minor) * minor; t <= Math.min(D, this.v1) + 1e-9; t += minor) ctx.fillRect(this.X(t), RULER - 6, 1, 5);
    ctx.fillStyle = '#8b93a0';
    for (let t = Math.ceil(Math.max(0, this.v0) / major) * major; t <= Math.min(D, this.v1) + 1e-9; t += major) {
      const x = this.X(t);
      ctx.fillRect(x, RULER - 11, 1, 10);
      if (this.X(D) - x > 64 || t === 0) ctx.fillText(fmtTime(t, dec), x + 3, CH + 10); // leave room for the END flag
    }
    // outside the story
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    if (this.v0 < 0) ctx.fillRect(HEAD, 0, this.X(0) - HEAD, RULER);
    if (this.v1 > D) ctx.fillRect(this.X(D), 0, W, RULER);
    // notes
    for (const n of tl.data.notes) {
      const x = this.X(n.t), s = ed.sel?.item === n;
      ctx.beginPath(); ctx.moveTo(x, RULER - 1); ctx.lineTo(x, RULER - 15); ctx.lineTo(x + 9, RULER - 11); ctx.lineTo(x, RULER - 7);
      ctx.fillStyle = s ? '#ffffff' : n.locked ? '#c9a24d' : COL.note; ctx.fill();
      if (s || this.hover?.item === n) {
        const txt = this.ellipsis(`${n.locked ? '🔒 ' : ''}${n.text || 'note'}`, 260), tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(20,22,26,0.95)'; ctx.fillRect(x + 12, RULER - 19, tw + 10, 15);
        ctx.fillStyle = COL.note; ctx.fillText(txt, x + 17, RULER - 11.5);
      }
    }
    // story end: a draggable flag
    const xe = this.X(D);
    ctx.fillStyle = COL.end;
    ctx.fillRect(xe - 0.5, 0, 1.5, RULER);
    ctx.beginPath(); ctx.moveTo(xe, CH + 2); ctx.lineTo(xe + 10, CH + 6); ctx.lineTo(xe, CH + 10); ctx.closePath(); ctx.fill();
    ctx.fillText(`END ${fmtTime(D, 0)}`, xe + 13, CH + 6);
    // playhead
    const x = this.X(ed.time);
    ctx.fillStyle = COL.play;
    ctx.beginPath(); ctx.moveTo(x - 6, CH + 2); ctx.lineTo(x + 6, CH + 2); ctx.lineTo(x + 6, RULER - 10); ctx.lineTo(x, RULER - 3); ctx.lineTo(x - 6, RULER - 10); ctx.closePath(); ctx.fill();
    ctx.fillRect(x - 0.5, 0, 1.5, RULER);
    ctx.restore();
    // corner: current time
    ctx.fillStyle = '#20232a'; ctx.fillRect(0, 0, HEAD - 1, RULER - 1);
    ctx.fillStyle = COL.play; ctx.font = '600 14px Inter, system-ui, sans-serif';
    ctx.fillText(fmtTime(ed.time, 2), 12, 15);
    ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#8b93a0';
    ctx.fillText(this.ellipsis(`of ${fmtTime(D, 0)} · ${tl.chapter(ed.time)?.name ?? ''}`, HEAD - 20), 12, 34);
  }

  ellipsis(s, w) {
    const { ctx } = this;
    if (w <= 8) return '';
    if (ctx.measureText(s).width <= w) return s;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > w) s = s.slice(0, -1);
    return `${s}…`;
  }

  // ------------------------------------------------------------------ hit testing
  hit(x, y) {
    const tl = this.ed.tl, D = this.D;
    if (y < RULER) {
      if (x < HEAD) return { type: 'ruler' };
      if (Math.abs(x - this.X(D)) < 7 && y > CH) return { type: 'end' };
      if (y > RULER - 17) {
        const n = tl.data.notes.find((m) => x >= this.X(m.t) - 3 && x <= this.X(m.t) + 10);
        if (n) return { type: 'note', item: n };
      }
      if (y < CH + 1) {
        const edge = tl.data.chapters.find((c) => Math.abs(this.X(c.t) - x) < 5 && c.t > 0);
        if (edge) return { type: 'chapter', item: edge, edge: true };
        const cs = tl.data.chapters;
        for (let i = cs.length - 1; i >= 0; i--) if (x >= this.X(cs[i].t)) return { type: 'chapter', item: cs[i] };
      }
      return { type: 'ruler' };
    }
    const cy = y + this.scrollY;
    const r = this.rows.find((q) => cy >= q.y && cy < q.y + q.h);
    if (!r) return null;
    if (r.perf) return { type: x < HEAD ? 'perfHead' : 'ruler' };
    const t = r.t;
    if (x < HEAD) return { type: 'header', track: t, mute: x > HEAD - 27, lock: x > HEAD - 48 && x <= HEAD - 27 };
    if (t.keys && (t.type !== 'layer' || t.keys.length > 1)) {
      let best = null, bd = 8;
      for (const k of t.keys) { const d = Math.abs(this.X(k.t) - x); if (d < bd) { bd = d; best = k; } }
      if (best) return { type: 'key', track: t, item: best };
    }
    if (t.type === 'clip' || t.type === 'layer') {
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

  // snap to the playhead, chapters, notes, other keys / clip edges, else to a zoom-dependent grid
  snap(t, e, self) {
    const D = this.D;
    if (!this.ed.snap || e.shiftKey) return clamp(t, 0, D);
    const tl = this.ed.tl, cand = [0, D];
    if (this.drag?.type !== 'scrub') cand.push(this.ed.time);
    for (const c of tl.data.chapters) if (c !== self) cand.push(c.t);
    for (const n of tl.data.notes) if (n !== self) cand.push(n.t);
    for (const tr of tl.tracks) {
      if (tr.keys) for (const k of tr.keys) if (k !== self) cand.push(k.t);
      if ((tr.type === 'clip' || tr.type === 'layer') && tr !== self) cand.push(tr.a, tr.b);
      if (tr.clips) for (const c of tr.clips) if (c !== self) cand.push(c.a, c.b);
    }
    let best = null, bd = 7 / this.k;
    for (const c of cand) { const d = Math.abs(c - t); if (d < bd) { bd = d; best = c; } }
    if (best !== null) return best;
    const grid = STEPS.find((s) => s * this.k >= 7) ?? 60;
    return clamp(Math.round(t / grid) * grid, 0, D);
  }

  // ------------------------------------------------------------------ pointer
  xy(e) { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  down(e) {
    const [x, y] = this.xy(e), ed = this.ed;
    if (e.button === 2) return; // context menu
    this.cv.setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && e.altKey)) { this.drag = { type: 'pan', x, v0: this.v0, v1: this.v1 }; return; }
    if (e.button !== 0) return;
    const hit = this.hit(x, y);
    if (!hit) return;
    const t = this.T(x);
    switch (hit.type) {
      case 'ruler': case 'perfHead':
        ed.pause();
        this.drag = { type: 'scrub' };
        ed.setTime(t);
        break;
      case 'end':
        this.drag = { type: 'end', old: this.D };
        break;
      case 'chapter':
        ed.select({ kind: 'chapter', item: hit.item });
        if (hit.edge && !hit.item.locked) this.drag = { type: 'marker', item: hit.item, off: hit.item.t - t };
        else if (!hit.edge) ed.setTime(hit.item.t);
        break;
      case 'note':
        ed.select({ kind: 'note', item: hit.item });
        if (!hit.item.locked) this.drag = { type: 'marker', item: hit.item, off: hit.item.t - t };
        break;
      case 'header':
        if (hit.mute) {
          if (hit.track.mute) delete hit.track.mute; else hit.track.mute = true;
          ed.commit();
        }
        ed.select({ kind: 'track', track: hit.track });
        if (hit.lock) ed.toggleLock();
        break;
      case 'key':
        ed.select({ kind: 'key', track: hit.track, item: hit.item });
        this.drag = this.locked(hit.track, hit.item) ? { type: 'locked', x } : { type: 'key', item: hit.item, off: hit.item.t - t };
        break;
      case 'edgeA': case 'edgeB': case 'body': {
        const it = hit.item;
        ed.select(hit.track.type === 'captions' ? { kind: 'clip', track: hit.track, item: it } : { kind: 'track', track: hit.track });
        this.drag = this.locked(hit.track, hit.track.type === 'captions' ? it : null) ? { type: 'locked', x } : { type: hit.type, item: it, off: t, a: it.a, b: it.b };
        if (hit.type === 'body' && it.type === 'layer') this.drag.keys0 = it.keys.map((k) => k.t); // a layer's keys move with it
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
      const lk = hit && this.locked(hit.track, hit.track?.type === 'captions' || hit.type === 'key' ? hit.item : null);
      this.cv.style.cursor = !hit ? 'default'
        : hit.type === 'end' ? 'ew-resize'
          : lk && /edge|key|body/.test(hit.type) ? 'not-allowed'
            : /edge|key/.test(hit.type) || (hit.type === 'chapter' && hit.edge) || hit.type === 'note' ? 'ew-resize'
              : hit.type === 'body' ? 'grab' : hit.type === 'ruler' ? 'col-resize' : 'pointer';
      if (prev !== hit?.item) this.draw();
      return;
    }
    const t = this.T(x), D = this.D;
    d.moved = true;
    if (d.type === 'locked') {
      if (!d.warned && Math.abs(x - d.x) > 4) { d.warned = true; ed.toast('Locked — right-click ▸ Unlock (or press L) to move it', true); }
      d.moved = false;
    } else if (d.type === 'pan') {
      const dt = (x - d.x) / this.k;
      this.v0 = d.v0 - dt; this.v1 = d.v1 - dt;
    } else if (d.type === 'scrub') ed.setTime(t);
    else if (d.type === 'end') {
      // drag past the right edge to keep extending
      const v = Math.max(t, ed.tl.contentEnd(), 1);
      ed.tl.meta.duration = Math.round(v * 10) / 10;
      if (x > this.W - 20) { this.v1 = Math.max(this.v1, ed.tl.meta.duration * 1.05); }
      ed.changed();
    } else if (d.type === 'marker' || d.type === 'key') {
      d.item.t = this.snap(t + d.off, e, d.item);
      ed.changed();
    } else if (d.type === 'edgeA') {
      d.item.a = Math.min(this.snap(t, e, d.item), d.item.b - 0.05);
      ed.changed();
    } else if (d.type === 'edgeB') {
      d.item.b = Math.max(this.snap(t, e, d.item), d.item.a + 0.05);
      ed.changed();
    } else if (d.type === 'body') {
      const w = d.b - d.a;
      let a = clamp(d.a + (t - d.off), 0, D - w);
      const sa = this.snap(a, e, d.item), sb = this.snap(a + w, e, d.item);
      a = Math.abs(sa - a) <= Math.abs(sb - (a + w)) ? sa : sb - w;
      d.item.a = clamp(a, 0, D - w); d.item.b = d.item.a + w;
      if (d.keys0) d.item.keys.forEach((k, i) => { k.t = Math.round((d.keys0[i] + d.item.a - d.a) * 1e4) / 1e4; });
      ed.changed();
    }
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    if (this.cv.hasPointerCapture(e.pointerId)) this.cv.releasePointerCapture(e.pointerId);
    if (d?.type === 'end') {
      if (d.moved) { const nd = this.ed.tl.meta.duration; this.ed.tl.meta.duration = d.old; this.ed.setDuration(nd); }
      return;
    }
    if (d && d.moved && !['scrub', 'pan', 'locked'].includes(d.type)) this.ed.commit();
  }

  context(e) {
    e.preventDefault();
    const [x, y] = this.xy(e), ed = this.ed, hit = this.hit(x, y);
    if (!hit) return;
    const t = this.snap(this.T(x), e);
    const at = { x: e.clientX, y: e.clientY };
    if (hit.track?.type === 'layer' && /edge|body/.test(hit.type)) return ed.contextMenu(at.x, at.y, { kind: 'layer', track: hit.track });
    const map = {
      key: { kind: 'key', track: hit.track, item: hit.item },
      edgeA: { kind: 'clip', track: hit.track, item: hit.item },
      edgeB: { kind: 'clip', track: hit.track, item: hit.item },
      body: { kind: 'clip', track: hit.track, item: hit.item },
      header: { kind: 'track', track: hit.track },
      lane: { kind: 'lane', track: hit.track, t },
      chapter: { kind: 'chapter', item: hit.item },
      note: { kind: 'note', item: hit.item },
      ruler: { kind: 'ruler', t },
      end: { kind: 'ruler', t },
      perfHead: { kind: 'ruler', t },
    };
    if (map[hit.type]) ed.contextMenu(at.x, at.y, map[hit.type]);
  }

  dbl(e) {
    const [x, y] = this.xy(e), ed = this.ed, hit = this.hit(x, y);
    if (!hit) return;
    const t = this.snap(this.T(x), e);
    if (y < CH + 1 && x > HEAD) { ed.setTime(t); ed.addChapter(); return; }
    if (y < RULER && x > HEAD) { ed.setTime(t); ed.addNote(); return; }
    if (hit.type === 'lane' || hit.type === 'body') {
      const tr = hit.track;
      if (tr.type === 'camera' || tr.type === 'curve' || tr.type === 'layer') { ed.setTime(t); ed.addKey(tr); }
      if (tr.type === 'captions' && hit.type === 'lane') { ed.setTime(t); ed.addCaption(); }
    }
  }

  wheel(e) {
    e.preventDefault();
    const [x] = this.xy(e);
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(e.deltaY * 0.0018), tc = this.T(Math.max(x, HEAD));
      const span = clamp((this.v1 - this.v0) * f, 0.3, this.D * 1.3 + 10);
      this.v0 = tc - (tc - this.v0) * (span / (this.v1 - this.v0));
      this.v1 = this.v0 + span;
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dt = (e.shiftKey ? e.deltaY : e.deltaX) / this.k;
      this.v0 += dt; this.v1 += dt;
    } else {
      this.scrollY += e.deltaY * 0.5;
    }
    this.draw();
  }
}
