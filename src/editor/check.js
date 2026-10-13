// File ▸ Check project: what would look broken on the site, or trip up a teammate — missing media files, references to
// data sources that don't exist, things placed after the story's end, empty / backwards clips, two tracks driving the
// same parameter, overlapping repeat regions, invisible layers, empty captions, slow moments (measured fps), open
// notes and what's locked. Each problem has "Go to" (selects it, moves the playhead) and, where it's
// obvious, a fix. Also shown before File ▸ Build site.
import { h, btn } from './dom.js';
import { dialog } from './menu.js';
import { fmtTime } from '../timeline.js';
import { kindOf } from '../layers.js';
import { editorAPI } from '../project.js';

const ICON = { error: '⛔', warn: '⚠️', info: 'ℹ️' };
const REF = /assets\/[^"'\s)<>]+/g;
const NOT_SOURCES = new Set(['item', 'this']);

export class Checker {
  constructor(ed) { this.ed = ed; }

  async assets() {
    try {
      const r = await fetch(editorAPI('assets'), { cache: 'no-store' });
      if (!r.ok) return null;
      return new Set((await r.json()).assets.map((a) => a.file));
    } catch { return null; }
  }

  async run() {
    const ed = this.ed, tl = ed.tl, d = tl.data, D = tl.duration, out = [];
    const add = (level, text, sel, fix) => out.push({ level, text, sel, fix });
    const name = (t) => `“${t.label || t.id}”`;
    const tsel = (t) => ({ kind: 'track', track: t });
    const files = await this.assets();

    // media files
    if (files) {
      for (const t of tl.tracks) {
        for (const ref of new Set(JSON.stringify(t).match(REF) ?? [])) {
          if (files.has(ref)) continue;
          const kind = kindOf(ref);
          const alts = [...files].filter((f) => f.startsWith('assets/') && kindOf(f) === kind);
          add('error', `${name(t)} uses ${ref} — that file is missing (the site shows nothing there)`, tsel(t),
            alts.length ? { label: 'Relink…', run: () => this.relink(ref, alts) } : null);
        }
        if (t.type === 'layer' && t.kind === 'model' && t.src?.startsWith('models/') && !files.has(t.src)) add('error', `${name(t)} uses the model ${t.src}, which isn’t on this server`, tsel(t));
      }
    } else add('info', 'Media files weren’t checked (that needs the studio server)');

    // data bindings
    const ids = new Set((d.sources ?? []).map((q) => q.id));
    const bad = new Map();
    const scan = (s, where) => {
      for (const m of String(s).matchAll(/\{\{\s*(?:#each\s+)?([^}|#/\s]+)/g)) {
        const path = m[1];
        if (!/[.[]/.test(path)) continue; // {{name}} inside an each block: relative
        const id = path.split(/[.[]/)[0];
        if (NOT_SOURCES.has(id) || id.startsWith('@') || ids.has(id)) continue;
        if (!bad.has(id)) bad.set(id, where);
      }
    };
    for (const t of tl.tracks) for (const k of ['src', 'html', 'title', 'body', 'kicker', 'text']) if (typeof t[k] === 'string' && t[k].includes('{{')) scan(t[k], t);
    for (const c of tl.captions()) for (const k of ['title', 'sub']) if (typeof c[k] === 'string' && c[k].includes('{{')) scan(c[k], null);
    for (const [id, t] of bad) add('error', `{{${id}.…}} is used${t ? ` by ${name(t)}` : ' in a caption'} but there is no data source “${id}” (Data tab)`, t ? tsel(t) : null);
    for (const q of d.sources ?? []) {
      const st = ed.app.data?.status?.[q.id];
      if (st?.state === 'error') add('warn', `Data source “${q.id}” can’t be loaded (${st.error}) — the site shows its saved sample`);
    }

    // timing
    for (const t of tl.tracks) {
      if (typeof t.a === 'number' && typeof t.b === 'number') {
        if (t.b <= t.a) add('error', `${name(t)} ends before it starts (${fmtTime(t.a)} → ${fmtTime(t.b)})`, tsel(t));
        else if (t.a >= D - 1e-6) add('warn', `${name(t)} starts after the end of the story (${fmtTime(t.a)}) — never seen`, tsel(t));
      }
      const late = (t.keys ?? []).filter((k) => k.t > D + 1e-6);
      if (late.length) add('warn', `${late.length} key${late.length === 1 ? '' : 's'} of ${name(t)} are after the end of the story`, { kind: 'key', track: t, item: late[0] }, { label: 'Delete them', run: () => { t.keys = t.keys.filter((k) => k.t <= D + 1e-6); ed.commit(`Deleted ${late.length} keys after the end`); } });
      for (const c of t.clips ?? []) {
        if (c.a >= D - 1e-6) add('warn', `Caption “${(c.title || '').slice(0, 30)}” starts after the end of the story`, { kind: 'clip', track: t, item: c });
        if (!String(c.title ?? '').trim() && !String(c.sub ?? '').trim()) add('warn', `An empty caption at ${fmtTime(c.a)}`, { kind: 'clip', track: t, item: c });
      }
      if (t.type === 'path' && (t.keys?.length ?? 0) < 2) add('warn', `${name(t)} has ${t.keys?.length ?? 0} waypoint — a path needs at least two`, tsel(t));
      if (t.type === 'layer' && t.keys?.length && t.keys.every((k) => (k.o ?? 1) <= 0.001)) add('warn', `${name(t)} is fully transparent in every key — never visible`, tsel(t));
    }
    // two tracks for the same parameter / beat: only one plays
    const byBind = new Map();
    for (const t of tl.tracks) if ((t.type === 'curve' || t.type === 'clip') && t.bind) (byBind.get(t.bind) ?? byBind.set(t.bind, []).get(t.bind)).push(t);
    for (const [bind, list] of byBind) if (list.length > 1) add('warn', `${list.length} tracks drive “${bind}” (${list.map(name).join(', ')}) — only ${name(list.at(-1))} plays`, tsel(list[0]));
    const used = new Set(tl.stretches());
    for (const t of tl.tracks) if (t.type === 'stretch' && !tl.muted(t) && t.b > t.a && !used.has(t)) add('warn', `${name(t)} overlaps an earlier repeat region and is ignored`, tsel(t));

    // performance (measured in this editor)
    const P = ed.perf, step = 0.5;
    const seen = P.filter((f) => f > 0).length / Math.max(1, Math.ceil(D / step));
    let s0 = -1, worst = 99;
    for (let i = 0; i <= P.length; i++) {
      const f = P[i];
      if (f > 0 && f < 40) { if (s0 < 0) { s0 = i; worst = 99; } worst = Math.min(worst, f); } else if (s0 >= 0) {
        const a = s0 * step, b = i * step;
        if (b - a >= 1) add('warn', `Slow from ${fmtTime(a)} to ${fmtTime(b)} — about ${Math.round(worst)} fps on this computer`, null, { label: 'Go to', run: () => { ed.setTime(a); ed.timeline.zoomTo(a - 5, b + 5); } });
        s0 = -1;
      }
    }
    if (seen < 0.6) add('info', `Performance was measured for ${Math.round(seen * 100)}% of the story — play it through once (▶▶ at 1×) to see slow moments everywhere`);

    // the team
    const open = d.notes.filter((n) => String(n.text ?? '').trim());
    for (const n of open.slice(0, 30)) add('info', `Note at ${fmtTime(n.t)}: “${String(n.text).slice(0, 70)}”`, { kind: 'note', item: n });
    let locked = 0;
    const lk = (o) => { if (o.locked) locked++; };
    for (const t of tl.tracks) { lk(t); (t.keys ?? []).forEach(lk); (t.clips ?? []).forEach(lk); }
    d.chapters.forEach(lk); d.notes.forEach(lk);
    if (locked) add('info', `${locked} locked item${locked === 1 ? '' : 's'}`);
    const muted = tl.tracks.filter((t) => t.mute);
    if (muted.length) add('info', `${muted.length} muted track${muted.length === 1 ? '' : 's'} (not on the site): ${muted.slice(0, 5).map(name).join(', ')}${muted.length > 5 ? '…' : ''}`);
    const order = { error: 0, warn: 1, info: 2 };
    return out.sort((p, q) => order[p.level] - order[q.level]);
  }

  // point every use of a missing file at another one
  relink(ref, alts) {
    const sel = h('select', {}, alts.map((f) => h('option', { value: f }, f.replace(/^assets\//, ''))));
    dialog({
      title: `Relink ${ref.replace(/^assets\//, '')}`,
      body: [h('p', {}, 'Use this file instead (everywhere the missing one is used):'), sel],
      buttons: [{ label: 'Cancel' }, { label: 'Relink', primary: true, onClick: () => { this.ed.replaceAsset(ref, sel.value); this.dialog(); } }],
    });
  }

  async summary() {
    const list = await this.run();
    return { errors: list.filter((i) => i.level === 'error').length, warns: list.filter((i) => i.level === 'warn').length, list };
  }

  async dialog() {
    const body = h('div', { class: 'ed-check' }, h('p', { class: 'muted' }, 'Checking…'));
    const d = dialog({ title: 'Check project', body, wide: true, buttons: [{ label: 'Check again', onClick: () => { this.fill(body, d); return false; } }, { label: 'Close', primary: true }] });
    this.fill(body, d);
  }

  async fill(body, d) {
    const ed = this.ed, list = await this.run();

    const n = (l) => list.filter((i) => i.level === l).length;
    const go = (i) => {
      d.close();
      if (i.sel) {
        ed.select(i.sel);
        const o = i.sel.item ?? i.sel.track;
        const t = o.t ?? o.a;
        if (typeof t === 'number') ed.setTime(t);
      }
    };
    body.replaceChildren(
      h('p', { class: n('error') ? 'warn' : 'muted' }, list.length
        ? `${n('error')} problem${n('error') === 1 ? '' : 's'} · ${n('warn')} warning${n('warn') === 1 ? '' : 's'} · ${n('info')} note${n('info') === 1 ? '' : 's'}`
        : 'All good — nothing to fix.'),
      h('div', { class: 'rows' }, list.map((i) => h('div', { class: `ck ${i.level}` },
        h('span', { class: 'ic' }, ICON[i.level]), h('span', { class: 'tx' }, i.text),
        h('span', { class: 'ac' },
          i.sel ? btn('Go to', () => go(i)) : null,
          i.fix ? btn(i.fix.label, () => { if (i.fix.label === 'Go to') d.close(); i.fix.run(); if (i.fix.label !== 'Go to' && !i.fix.label.endsWith('…')) this.fill(body, d); }) : null)))),
    );
  }
}
