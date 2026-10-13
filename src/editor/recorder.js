// File ▸ Record a review video: plays the story (or the In–Out range) at 1× in the Game view and records it — the
// scene plus the captions — to an .mp4 (or .webm where the browser can't write mp4) for people without WebGPU, a deck,
// or a chat thread. It records in real time, so it shows what this computer renders. Only for review: the site stays
// the real-time story. HTML / web-page layers aren't in the video (they're live web content over the canvas).
import { h, btn, download } from './dom.js';
import { dialog } from './menu.js';
import { fmtTime } from '../timeline.js';

const TYPES = ['video/mp4;codecs=avc3.640028', 'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc3.42E01E', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];

// wrap text to a width (canvas units)
function wrap(g, text, width) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const t = line ? `${line} ${word}` : word;
      if (line && g.measureText(t).width > width) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

export class Recorder {
  constructor(ed) { this.ed = ed; this.rec = null; }

  dialog() {
    const ed = this.ed;
    if (this.rec) return this.stop();
    if (typeof MediaRecorder === 'undefined') return ed.toast('This browser can’t record video', true);
    const mime = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const range = h('select', {},
      h('option', { value: 'all' }, `The whole story (${fmtTime(ed.duration, 0)})`),
      ed.range ? h('option', { value: 'range', selected: true }, `In–Out (${fmtTime(ed.range.a)}–${fmtTime(ed.range.b)})`) : null,
      h('option', { value: 'here' }, `From the playhead to the end (${fmtTime(ed.time)}–${fmtTime(ed.duration, 0)})`));
    const caps = h('input', { type: 'checkbox', checked: true });
    dialog({
      title: 'Record a review video',
      body: [
        h('label', { class: 'lbl' }, 'What', range),
        h('label', { class: 'chk' }, caps, ' Include captions'),
        h('p', { class: 'muted' }, `Plays in the Game view at 1× and records what you see, in real time (${mime?.startsWith('video/mp4') ? 'MP4' : 'WebM'}, ${ed.aspect === 'free' ? 'the viewport size' : ed.aspect}). Let it play — don’t switch tabs. HTML / web-page layers aren’t recorded. Esc or the red button stops early.`),
      ],
      buttons: [{ label: 'Cancel' }, { label: '● Record', primary: true, onClick: () => {
        const v = range.value;
        const a = v === 'range' ? ed.range.a : v === 'here' ? ed.time : 0;
        const b = v === 'range' ? ed.range.b : ed.duration;
        setTimeout(() => this.record({ a, b, captions: caps.checked, mime }), 50);
      } }],
    });
  }

  record({ a, b, captions, mime }) {
    const ed = this.ed, src = ed.app.renderer.domElement;
    ed.setView('game'); // (resizes the canvas to the Game frame first)
    const W = src.width & ~1, H = src.height & ~1;
    const cv = h('canvas', { width: W, height: H });
    const g = cv.getContext('2d');
    const stream = cv.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.min(20e6, W * H * 30 * 0.12) });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      const name = `${(ed.tl.meta.title || 'story').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}_${fmtTime(a, 0).replace(/:/g, 'm')}-${fmtTime(b, 0).replace(/:/g, 'm')}.${ext}`;
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      // saved from a click (a download started by itself, later, can be blocked by the browser)
      const url = URL.createObjectURL(blob);
      dialog({
        title: 'Your review video is ready',
        body: [h('video', { src: url, controls: true, muted: true, class: 'ed-recv' }), h('p', { class: 'muted' }, `${name} · ${(blob.size / 1048576).toFixed(1)} MB · ${fmtTime(b - a)}`)],
        buttons: [{ label: 'Discard', onClick: () => URL.revokeObjectURL(url) }, { label: 'Save video', primary: true, onClick: () => { download(name, blob); ed.toast(`Saved ${name}`); } }],
      });
    };
    this.rec = { rec, a, b };
    ed.pause();
    ed.setTime(a);
    ed.speed = 1;
    ed.$speed.value = '1';
    ed.app.onFrame(() => {
      g.drawImage(src, 0, 0, W, H);
      if (captions) this.drawCaptions(g, W, H);
    });
    // a frame of the start before playing
    setTimeout(() => {
      rec.start(500);
      ed.play('auto');
      this.badge = h('div', { class: 'ed-rec' }, h('i'), h('span', {}, 'REC'), this.$t = h('b', {}, ''), btn('Stop', () => this.stop(), { cls: 'danger' }));
      ed.$wrap.append(this.badge);
      this.timer = setInterval(() => {
        this.$t.textContent = `${fmtTime(ed.time - a, 0)} / ${fmtTime(b - a, 0)}`;
        if (ed.time >= b - 1e-3 || !ed.playing) this.stop();
      }, 100);
    }, 400);
  }

  stop() {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    clearInterval(this.timer);
    this.badge?.remove();
    this.ed.app.onFrame(null);
    this.ed.pause();
    if (r.rec.state !== 'inactive') r.rec.stop();
  }

  // the visible captions (DOM text over the canvas) drawn into the frame
  drawCaptions(g, W, H) {
    const stage = this.ed.$stage.getBoundingClientRect(), sx = W / stage.width, sy = H / stage.height;
    for (const el of document.querySelectorAll('#captions .cap')) {
      const cs0 = getComputedStyle(el), o = +cs0.opacity;
      if (o < 0.01 || cs0.visibility === 'hidden') continue;
      for (const t of el.querySelectorAll('h1, h2, p')) {
        const cs = getComputedStyle(t), r = t.getBoundingClientRect(), text = t.innerText.trim();
        if (!text) continue;
        g.save();
        g.globalAlpha = o * (+cs.opacity || 1);
        g.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * sx}px ${cs.fontFamily}`;
        g.letterSpacing = `${(parseFloat(cs.letterSpacing) || 0) * sx}px`;
        g.fillStyle = cs.color;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.shadowColor = 'rgba(0,0,0,0.35)';
        g.shadowBlur = 18 * sx;
        const lines = wrap(g, cs.textTransform === 'uppercase' ? text.toUpperCase() : text, r.width * sx + 2);
        const lh = (r.height * sy) / lines.length, cx = (r.left + r.width / 2 - stage.left) * sx;
        lines.forEach((ln, i) => g.fillText(ln, cx, (r.top - stage.top) * sy + lh * (i + 0.5)));
        g.restore();
      }
    }
  }
}
