// Save system: Save (story.json; the server keeps the previous version in saves/auto/), autosave,
// named checkpoints (saves/checkpoints/), an Open / Restore window (checkpoints, autosaves, git history,
// browser draft, import), export, and git commit / push. Without the dev server (e.g. GitHub Pages) it
// falls back to the File System Access API / downloads, and the browser draft. In a .tuna project (?project=)
// everything goes to its working copy in projects/<slug>/, and a manual Save also writes the .tuna file
// (src/editor/project.js).
import { h, btn, download } from './dom.js';
import { dialog } from './menu.js';
import { editorAPI, PROJECT } from '../project.js';

const DRAFT_KEY = `openTuna.draft.v1${PROJECT ? `.${PROJECT}` : ''}`; // per project
const AUTO_KEY = 'openTuna.autosave';
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
// FNV-1a over the UTF-8 bytes (same as tools/serve.py) — fingerprint of the story.json on disk
export function fnv1a(text) {
  let hsh = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) hsh = Math.imul(hsh ^ b, 0x01000193) >>> 0;
  return hsh.toString(16).padStart(8, '0');
}
const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function api(path, opts) {
  const r = await fetch(editorAPI(path), { cache: 'no-store', ...opts });
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.text() : '';
  if (!r.ok) {
    let msg = r.status;
    try { msg = JSON.parse(data).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return data;
}
const apiJson = async (path, opts) => JSON.parse(await api(path, opts));
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

export class Saves {
  constructor(ed) {
    this.ed = ed;
    this.server = null; // null = unknown, then true / false
    this.git = false;
    this.branch = '';
    this.saved = ed.tl.serialize(); // what's on disk, as the editor would write it (for "dirty")
    this.baseHash = fnv1a(ed.tl.sourceText ?? this.saved); // fingerprint of the exact file on disk
    this.conflict = false;
    this.savedAt = null;
    this.lastEdit = 0;
    this.lastAuto = performance.now();
    let a = 60;
    try { a = +(localStorage.getItem(AUTO_KEY) ?? 60); } catch { /* storage unavailable */ }
    this.autosave = a; // seconds; 0 = off
  }

  get dirty() { return this.ed.current() !== this.saved; }

  async ping() {
    try {
      const r = await apiJson('ping');
      this.server = r.save === true;
      this.git = !!r.git;
      this.branch = r.branch || '';
    } catch { this.server = false; }
    this.ed.syncButtons();
  }

  setAutosave(sec) {
    this.autosave = sec;
    try { localStorage.setItem(AUTO_KEY, String(sec)); } catch { /* storage unavailable */ }
    this.ed.toast(sec ? `Autosave every ${sec < 60 ? `${sec} s` : `${sec / 60} min`}` : 'Autosave off');
    this.ed.syncButtons();
  }

  // called on every committed edit
  edited(text) {
    this.lastEdit = performance.now();
    try {
      if (text !== this.saved) localStorage.setItem(DRAFT_KEY, JSON.stringify({ text, time: Date.now() }));
      else localStorage.removeItem(DRAFT_KEY);
    } catch { /* storage unavailable */ }
  }

  // called about once a second: autosave when there are changes and the user paused editing for 2 s
  tick() {
    const now = performance.now();
    if (!this.autosave || !this.server || this.busy || this.conflict || !this.dirty) return;
    if (now - this.lastAuto < this.autosave * 1000 || now - this.lastEdit < 2000) return;
    this.lastAuto = now;
    this.save({ auto: true });
  }

  done(text, msg, auto) {
    this.saved = text;
    this.savedAt = new Date();
    this.auto = !!auto;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
    this.ed.syncButtons();
    if (msg) this.ed.toast(msg);
  }

  async save({ auto = false, force = false } = {}) {
    const text = this.ed.current();
    if (this.conflict && !force) return this.conflictDialog();
    this.busy = true;
    try {
      if (this.server !== false) {
        try {
          const r = await fetch(editorAPI('save'), { method: 'POST', body: text, headers: { 'Content-Type': 'application/json', 'X-Base-Hash': this.baseHash, ...(force ? { 'X-Force': '1' } : {}) } });
          const j = await r.json().catch(() => ({}));
          if (r.status === 409) { this.conflict = true; this.theirs = j.current; this.ed.syncButtons(); return this.conflictDialog(); }
          if (!r.ok) throw new Error(j.error || r.status);
          this.baseHash = fnv1a(text);
          this.conflict = false;
          this.done(text, auto || this.ed.project?.isFile ? '' : 'Saved story.json', auto);
          if (!auto && this.ed.project?.isFile) await this.ed.project.saveTuna(); // then the .tuna file itself
          return;
        } catch (e) {
          if (this.server) { this.ed.toast(`Save failed: ${e.message}`, true); return; }
          this.server = false;
        }
      }
      if (auto) return;
      if (window.showSaveFilePicker) {
        try {
          this.fileHandle ??= await window.showSaveFilePicker({ suggestedName: 'story.json', types: [{ description: 'Story timeline', accept: { 'application/json': ['.json'] } }] });
          const w = await this.fileHandle.createWritable();
          await w.write(text);
          await w.close();
          return this.done(text, `Saved ${this.fileHandle.name}`);
        } catch (e) { if (e.name === 'AbortError') return; }
      }
      download('story.json', text);
      this.done(text, 'Downloaded story.json — put it in the project folder');
    } finally { this.busy = false; }
  }

  // story.json was changed outside this editor (Claude, a git pull, another tab) since it was loaded
  conflictDialog() {
    if (document.querySelector('.ed-modal')) return;
    dialog({
      title: 'story.json changed outside the editor',
      body: [
        h('p', {}, 'Someone (Claude, a git pull, or another editor tab) saved a newer story.json since you opened it. Autosave is paused so nothing gets overwritten.'),
        h('p', {}, h('b', {}, 'Load theirs'), ' — open the version on disk (your changes are kept in undo: Ctrl+Z goes back to them). ',
          h('b', {}, 'Keep mine'), ' — overwrite the file with what you see (the other version is kept in File ▸ Open / Restore ▸ previous versions).'),
      ],
      buttons: [
        { label: 'Decide later' },
        { label: 'Keep mine', danger: true, onClick: () => this.save({ force: true }) },
        { label: 'Load theirs', primary: true, onClick: () => this.loadTheirs() },
      ],
    });
  }

  async loadTheirs() {
    try {
      const raw = this.theirs ?? await api('load?file=story.json');
      this.theirs = null;
      this.ed.loadText(raw, 'the newer story.json from disk');
      this.saved = this.ed.current();
      this.baseHash = fnv1a(raw);
      this.conflict = false;
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
      this.ed.syncButtons();
    } catch (e) { this.ed.toast(`Couldn’t load: ${e.message}`, true); }
  }

  status() {
    if (this.conflict) return { text: '⚠ Changed on disk — click Save', cls: 'dirty' };
    if (this.dirty) return { text: this.autosave && this.server ? 'Unsaved · autosave on' : 'Unsaved changes', cls: 'dirty' };
    if (this.ed.project?.tunaDirty) return { text: `${this.savedAt ? `${this.auto ? 'Autosaved' : 'Saved'} ${clock(this.savedAt)} · ` : ''}.tuna not saved`, cls: 'warn', title: `Changes are kept in the project’s working copy. Save (Ctrl+S) also writes ${this.ed.project.fileName}.` };
    if (this.savedAt) return { text: `${this.auto ? 'Autosaved' : 'Saved'} ${clock(this.savedAt)}`, cls: 'ok' };
    return { text: this.server === false ? 'No editor server (Save downloads)' : 'Saved', cls: '' };
  }

  // ---------------------------------------------------------------- assets
  // copy a dropped / picked file into the project's assets/ folder; returns its path (e.g. "assets/logo.png")
  async upload(file) {
    if (!this.server) throw new Error('Adding files needs the editor server — start the editor with “Open Editor”');
    const r = await fetch(editorAPI(`upload?name=${encodeURIComponent(file.name)}`), { method: 'POST', body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.status);
    return j.file;
  }

  pickFile(accept) {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', accept, style: 'display:none' });
      input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
      document.body.append(input);
      input.click();
    });
  }

  // ---------------------------------------------------------------- checkpoints
  checkpointDialog() {
    if (!this.server) return this.ed.toast('Checkpoints need the editor server (start it with “Open Editor”)', true);
    const input = h('input', { type: 'text', placeholder: 'e.g. before new camera ending', maxLength: 60 });
    const make = async () => {
      try {
        await post(`checkpoint?name=${encodeURIComponent(input.value)}`, this.ed.current());
        this.ed.toast(`Checkpoint “${input.value || 'checkpoint'}” saved`);
      } catch (e) { this.ed.toast(`Checkpoint failed: ${e.message}`, true); return false; }
      return true;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { make().then((ok) => ok && d.close()); } });
    const d = dialog({
      title: 'Save checkpoint',
      body: [h('p', {}, 'A named copy of the story as it is now (including unsaved changes). Restore it any time from File ▸ Open / Restore. Checkpoints are files in saves/checkpoints/ and are included when you commit to git.'), input],
      buttons: [{ label: 'Cancel' }, { label: 'Save checkpoint', primary: true, onClick: make }],
    });
  }

  // ---------------------------------------------------------------- open / restore
  async openDialog() {
    const body = h('div', { class: 'ed-saves' }, h('p', { class: 'muted' }, 'Loading…'));
    const d = dialog({ title: 'Open / Restore', body, wide: true, buttons: [{ label: 'Import file…', onClick: () => { this.importFile(); } }, { label: 'Close' }] });
    const load = async (label, getText) => {
      try { // loading is undoable (Ctrl+Z), so no confirmation
        this.ed.loadText(await getText(), label);
        d.close();
      } catch (e) { this.ed.toast(`Couldn’t load: ${e.message}`, true); }
    };
    const sec = (title, hint, rows) => h('section', {}, h('h4', {}, title, hint ? h('span', {}, hint) : null),
      rows.length ? h('div', { class: 'rows' }, rows) : h('div', { class: 'muted' }, 'Nothing yet.'));
    const row = (name, meta, actions) => h('div', { class: 'r' }, h('div', { class: 'nm' }, name), h('div', { class: 'mt' }, meta), h('div', { class: 'ac' }, actions));
    const parts = [];

    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* ignore */ }
    if (draft && draft.text !== this.ed.current()) {
      parts.push(sec('Browser draft', 'unsaved work kept by this browser', [row('Draft', new Date(draft.time).toLocaleString(), [btn('Load', () => load('browser draft', async () => draft.text))])]));
    }
    if (!this.server) {
      parts.push(h('p', { class: 'muted' }, 'Checkpoints, autosaves and git history need the editor server — start the editor with “Open Editor”.'));
      body.replaceChildren(...parts);
      return;
    }
    try {
      const L = await apiJson('list');
      parts.unshift(sec('Saved file', 'story.json on disk', [row('story.json', this.savedAt ? `saved ${clock(this.savedAt)}` : 'as opened', [btn('Load', () => load('story.json', () => api('load?file=story.json')))])]));
      parts.push(sec('Checkpoints', 'named, kept until you delete them', L.checkpoints.map((c) => row(c.name, `${c.time} · ${kb(c.size)}`, [
        btn('Load', () => load(`checkpoint “${c.name}”`, () => api(`load?file=${encodeURIComponent(c.file)}`))),
        btn('Delete', async (e) => {
          try { await post(`delete?file=${encodeURIComponent(c.file)}`, ''); e.target.closest('.r').remove(); this.ed.toast('Checkpoint deleted'); } catch (err) { this.ed.toast(err.message, true); }
        }, { cls: 'danger' }),
      ]))));
      parts.push(sec('Autosaves & previous versions', 'the version before each save (last 100)', L.autos.slice(0, 40).map((c) => row(c.time, kb(c.size), [
        btn('Load', () => load(`version from ${c.time}`, () => api(`load?file=${encodeURIComponent(c.file)}`))),
      ]))));
      if (this.git) {
        parts.push(sec('Git history', 'story.json in each commit', L.git.map((g) => row(g.subject, `${g.time} · ${g.author} · ${g.hash}`, [
          btn('Load', () => load(`commit ${g.hash}`, () => api(`load?git=${g.hash}`))),
        ]))));
      }
    } catch (e) { parts.push(h('p', { class: 'muted' }, `Couldn’t list saves: ${e.message}`)); }
    body.replaceChildren(...parts);
  }

  importFile() {
    const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      input.remove();
      if (!f) return;
      try { this.ed.loadText(await f.text(), `file ${f.name}`); } catch (e) { this.ed.toast(`Couldn’t import: ${e.message}`, true); }
    });
    document.body.append(input);
    input.click();
  }

  exportFile() {
    const stampName = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    download(`story-${stampName}.json`, this.ed.current());
  }

  async revert() {
    try {
      const text = this.server ? await api('load?file=story.json') : this.saved;
      this.ed.loadText(text, 'the saved story.json');
      this.saved = this.ed.current();
      if (this.server) { this.baseHash = fnv1a(text); this.conflict = false; }
      this.ed.syncButtons();
    } catch (e) { this.ed.toast(`Couldn’t revert: ${e.message}`, true); }
  }

  checkDraft() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* ignore */ }
    if (!draft || draft.text === this.saved) return;
    const el = h('span', {}, `Unsaved changes from ${new Date(draft.time).toLocaleString()}. `,
      btn('Restore', () => { this.ed.loadText(draft.text, 'browser draft'); el.closest('div')?.remove(); }),
      ' ',
      btn('Discard', () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } el.closest('div')?.remove(); }));
    this.ed.toast(el, false, 0);
  }

  // ---------------------------------------------------------------- git
  async gitDialog() {
    if (!this.server || !this.git) return this.ed.toast(this.server ? 'This folder isn’t a git repository (or git isn’t installed)' : 'Git needs the editor server', true);
    let st;
    try { st = await apiJson('git/status'); } catch (e) { return this.ed.toast(e.message, true); }
    const main = st.branch === 'main' || st.branch === 'master';
    const msg = h('input', { type: 'text', placeholder: 'What changed? e.g. “New ending camera + captions”' });
    const pushBox = h('input', { type: 'checkbox' });
    const changes = st.changes.length ? st.changes.join('\n') : '(no uncommitted story changes)';
    const body = [
      h('div', { class: 'kv' }, h('span', {}, 'Branch'), h('b', { class: main ? 'warn' : '' }, st.branch || '(detached)'),
        h('span', {}, 'Remote'), h('span', {}, st.upstream || 'not pushed yet'),
        h('span', {}, 'Not pushed'), h('span', {}, st.ahead ? `${st.ahead} commit(s)` : '—')),
      this.dirty ? h('p', { class: 'warn' }, 'You have unsaved changes — they will be saved first.') : null,
      h('pre', { class: 'changes' }, changes),
      h('label', { class: 'lbl' }, 'Commit message', msg),
      h('label', { class: 'chk' }, pushBox, ` Also push to GitHub${main ? ' — this branch is main: pushing updates the PUBLIC site' : ''}`),
      h('p', { class: 'muted' }, 'Commits only this demo’s folder (story, checkpoints, assets) — code changes are left alone.'),
    ];
    const run = async () => {
      if (this.dirty) await this.save();
      try {
        const nothing = !st.changes.length && !this.dirty;
        if (!nothing) {
          const r = JSON.parse(await post('git/commit', JSON.stringify({ message: msg.value })));
          this.ed.toast(`Committed: ${(r.output || '').split('\n')[0]}`);
        }
        if (pushBox.checked) {
          this.ed.toast('Pushing…');
          await post('git/push', '');
          this.ed.toast(`Pushed ${st.branch}${main ? ' — the public site redeploys in about a minute' : ''}`);
        } else if (nothing) { this.ed.toast('Nothing to commit'); }
      } catch (e) { this.ed.toast(`Git: ${e.message}`, true, 10000); return false; }
      return true;
    };
    dialog({ title: 'Commit to git', body, buttons: [{ label: 'Cancel' }, { label: 'Commit', primary: true, onClick: run }] });
  }
}
