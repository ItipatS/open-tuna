// Snippets: the team's library of reusable pieces of timeline (a logo reveal, a leap beat, a caption pair…). Save the
// selection as a snippet (its media files are kept with it on the studio server, in library/snippets/), insert one at
// the playhead in any project — the media is copied in. Edit ▸ Snippets, or right-click a selection.
import { h, btn } from './dom.js';
import { dialog } from './menu.js';
import { fmtTime } from '../timeline.js';
import { PROJECT } from '../project.js';

const ago = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

async function call(path, opts) {
  const r = await fetch(`./__editor/${path}`, { cache: 'no-store', ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export class Library {
  constructor(ed) {
    this.ed = ed;
    this.list = [];
  }

  async refresh() {
    try { this.list = (await call('library')).snippets; } catch { this.list = []; }
    return this.list;
  }

  // Edit ▸ Snippets ▸ (the list is fetched when the menu opens; a stale list is fine)
  menuItems() {
    this.refresh();
    const ed = this.ed;
    return [
      { label: 'Save the selection as a snippet…', disabled: !ed.sel || ed.sel.kind === 'object' || !ed.saves.server, onClick: () => this.saveDialog() },
      '-',
      ...(this.list.length ? this.list.slice(0, 20).map((s) => ({ label: `${s.name}${s.author ? ` · ${s.author}` : ''}`, onClick: () => this.insert(s) })) : [{ label: 'No snippets yet', disabled: true }]),
      '-',
      { label: 'All snippets…', disabled: !ed.saves.server, onClick: () => this.dialog() },
    ];
  }

  saveDialog() {
    const ed = this.ed;
    const list = (ed.multi ? ed.sels : [ed.sel]).filter((s) => ed.copyable(s));
    if (!list.length) return ed.toast('Select what to keep as a snippet first', true);
    const clip = ed.clipboardOf(list);
    const sp = ed.selSpan();
    const input = h('input', { type: 'text', placeholder: 'e.g. Logo reveal with bubbles', maxLength: 80 });
    const save = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return false; }
      try {
        await call(`library/save?project=${encodeURIComponent(PROJECT)}&name=${encodeURIComponent(name)}&author=${encodeURIComponent(ed.user.name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...clip, span: sp ? sp.b - sp.a : 0 }),
        });
        ed.toast(`Snippet “${name}” saved — anyone on this studio can insert it (Edit ▸ Snippets)`);
        this.refresh();
      } catch (e) { ed.toast(`Couldn’t save the snippet: ${e.message}`, true); return false; }
      return true;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save().then((ok) => ok && d.close()); });
    const d = dialog({
      title: `Save ${list.length > 1 ? `${list.length} items` : ed.describe(list[0])} as a snippet`,
      body: [h('label', { class: 'lbl' }, 'Name', input), h('p', { class: 'muted' }, 'The media files it uses are kept with it. Inserting it later puts it at the playhead, with the same timing.')],
      buttons: [{ label: 'Cancel' }, { label: 'Save snippet', primary: true, onClick: save }],
    });
  }

  async insert(s) {
    const ed = this.ed;
    try {
      const clip = await call(`library/get?id=${encodeURIComponent(s.id)}`);
      clip.project = `lib:${s.id}`; // its media comes from the library (edit-ops.js importAssets)
      await ed.paste(null, { clip, label: `Inserted snippet “${s.name}”` });
    } catch (e) { ed.toast(`Couldn’t insert “${s.name}”: ${e.message}`, true); }
  }

  async dialog() {
    const body = h('div', { class: 'ed-saves' }, h('p', { class: 'muted' }, 'Loading…'));
    const d = dialog({ title: 'Snippets', body, wide: true, buttons: [{ label: 'Close' }] });
    const list = await this.refresh();
    const row = (s) => h('div', { class: 'r' },
      h('div', { class: 'nm' }, s.name),
      h('div', { class: 'mt' }, [s.author, ago(s.time), `${s.items + s.tracks} item${s.items + s.tracks === 1 ? '' : 's'}`, s.span ? fmtTime(s.span) : '', s.from ? `from ${s.from}` : ''].filter(Boolean).join(' · ')),
      h('div', { class: 'ac' },
        btn(`Insert at ${fmtTime(this.ed.time)}`, () => { d.close(); this.insert(s); }, { cls: 'primary' }),
        btn('Delete', async (e) => {
          if (!(await this.ed.confirm('Delete snippet?', `“${s.name}” is removed from the team’s library (projects that used it keep their copy).`, 'Delete', true))) return;
          try { await call(`library/delete?id=${encodeURIComponent(s.id)}`, { method: 'POST', headers: { 'Content-Length': '0' } }); e.target.closest('.r').remove(); } catch (err) { this.ed.toast(err.message, true); }
        }, { cls: 'danger' })));
    body.replaceChildren(
      h('p', { class: 'muted' }, 'Reusable pieces of timeline shared by everyone on this studio server. Save one: select things on the timeline ▸ right-click ▸ Save as snippet.'),
      list.length ? h('section', {}, h('div', { class: 'rows' }, list.map(row))) : h('p', { class: 'muted' }, 'No snippets yet.'),
    );
  }
}
