// History tab (left panel): every edit to the shared story, newest first — who, when, what. Click an edit to rewind:
// the timeline and viewport show the story as it was right after it (read-only, with what changed since outlined);
// "Restore this version" makes that the story again, "Undo just this" takes back only that edit (what others changed
// since stays). The slider scrubs through the history. Needs the live studio server (src/editor/sync.js); without it
// the tab lists this session's own undo steps.
import { h, btn } from './dom.js';
import { initials } from './sync.js';

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

export class HistoryPanel {
  constructor(ed, root) {
    this.ed = ed;
    this.root = root;
    this.ops = []; // newest first
    this.seen = -1;
    this.current = null; // seq on screen while rewinding
    this.visible = false;
    setInterval(() => this.tick(), 1000);
  }

  open() {
    this.visible = true;
    this.load();
  }

  tick() {
    this.visible = this.root.style.display !== 'none';
    if (this.visible && this.ed.sync.live && this.ed.sync.seq !== this.seen && !this.loading) this.load();
    if (this.visible && !this.ed.sync.live && this.ed.undoStack.length !== this.localN) this.render();
  }

  async load(more = false) {
    const S = this.ed.sync;
    if (!S.live) return this.render();
    this.loading = true;
    try {
      const r = await S.history(more ? this.ops.at(-1)?.seq : undefined);
      this.ops = more ? [...this.ops, ...r.ops] : r.ops;
      this.first = r.first;
      this.seen = S.seq;
    } catch (e) { this.err = e.message; } finally { this.loading = false; }
    this.render();
  }

  async show(op) {
    const ed = this.ed;
    try {
      const r = await ed.sync.at(op.seq);
      this.current = op.seq;
      ed.enterPreview(r.text, {
        label: `the story at ${clock(op.time)}`,
        sub: `right after ${op.user}’s “${op.label}”`,
        restore: async () => {
          try { await ed.sync.restore(op.seq); ed.toast(`Restored the story as it was at ${clock(op.time)} — ${ed.mod}Z won’t undo this (it’s in the History: undo it there)`); } catch (e) { ed.toast(`Couldn’t restore: ${e.message}`, true); }
        },
      });
      this.mark();
    } catch (e) { ed.toast(`Couldn’t load that version: ${e.message}`, true); }
  }

  async revert(op) {
    const ed = this.ed;
    if (!(await ed.confirm('Undo just this edit?', `Takes back ${op.user}’s “${op.label}” (${clock(op.time)}). Anything changed after it by anyone stays as it is.`, 'Undo it'))) return;
    try {
      const r = await ed.sync.revert(op.seq);
      ed.toast(r.empty ? 'Nothing to undo — it was all changed again since' : r.partial ? 'Undone — partly: some of it was changed again since (kept)' : `Undone: ${op.label}`, !!r.empty);
    } catch (e) { ed.toast(`Couldn’t undo it: ${e.message}`, true); }
  }

  // highlight the row on screen
  mark() {
    const cur = this.ed.preview ? this.current : null;
    this.root.querySelectorAll('.hr').forEach((r) => r.classList.toggle('on', +r.dataset.seq === cur));
    this.root.querySelector('.hnow')?.classList.toggle('on', cur === null);
  }

  render() {
    const ed = this.ed, S = ed.sync;
    if (!S.live) {
      const st = ed.undoStack;
      this.localN = st.length;
      this.root.replaceChildren(h('div', { class: 'ed-hist' },
        h('p', { class: 'muted' }, 'The shared History (every edit by everyone, rewind to any moment) needs the studio server — start the editor with “Open Editor” (tools/serve.py).'),
        h('div', { class: 'sec' }, 'This session (your undo steps)'),
        st.length ? h('div', { class: 'rows' }, [...st].reverse().map((s, i) => h('div', { class: 'hr local' }, h('span', { class: 'lb' }, s.label), h('small', {}, i === 0 ? `${ed.mod}Z` : '')))) : h('p', { class: 'muted' }, 'Nothing yet.')));
      return;
    }
    const n = this.ops.length;
    const slider = h('input', { type: 'range', min: '0', max: String(Math.max(0, n)), value: String(n), title: 'Scrub through the history' });
    let timer = 0;
    slider.addEventListener('input', () => {
      clearTimeout(timer);
      const k = +slider.value;
      timer = setTimeout(() => (k >= n ? ed.exitPreview() : this.show(this.ops[n - 1 - k] ?? this.ops.at(-1))), 160);
    });
    const rows = [];
    let lastDay = '';
    rows.push(h('div', { class: `hr hnow${ed.preview ? '' : ' on'}`, onclick: () => ed.exitPreview() },
      h('i', { class: 'dot', style: 'background:var(--good)' }), h('div', { class: 'tx' }, h('b', {}, 'Now'), h('small', {}, `${S.others.length ? `live with ${S.others.map((p) => p.user).join(', ')}` : 'the shared story'}`))));
    for (const op of this.ops) {
      const d = day(op.time);
      if (d !== lastDay) { rows.push(h('div', { class: 'sec' }, d)); lastDay = d; }
      const undo = btn('Undo', (e) => { e.stopPropagation(); this.revert(op); }, { title: 'Undo just this edit (later edits by anyone stay)' });
      const color = op.color || (op.client === 'disk' ? '#9aa4b2' : '#8b93a0');
      rows.push(h('div', { class: 'hr', 'data-seq': String(op.seq), title: `#${op.seq} · ${op.n} change${op.n === 1 ? '' : 's'} — click to see the story right after it`, onclick: () => this.show(op) },
        h('i', { class: 'dot', style: `background:${color}` }, initials(op.user)),
        h('div', { class: 'tx' }, h('span', { class: 'lb' }, op.label), h('small', {}, `${op.user} · ${clock(op.time)}`)),
        undo));
    }
    if (this.ops.length && this.ops.at(-1).seq > (this.first ?? 0)) rows.push(h('div', { class: 'more' }, btn('Older…', () => this.load(true))));
    if (!this.ops.length) rows.push(h('p', { class: 'muted' }, 'No edits yet. Every change anyone makes shows up here.'));
    this.root.replaceChildren(h('div', { class: 'ed-hist' },
      h('div', { class: 'hd' }, h('b', {}, 'History'), h('span', { class: 'muted' }, `${S.seq} edit${S.seq === 1 ? '' : 's'}`)),
      n ? h('label', { class: 'scrub' }, h('span', {}, 'Rewind'), slider) : null,
      h('div', { class: 'rows' }, rows)));
    this.mark();
  }
}
