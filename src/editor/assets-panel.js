// Assets tab (left panel): every file in the project's assets/ folder, with thumbnails. Drag one onto the
// timeline (into a lane, at the drop time) or onto the viewport; double-click adds it at the playhead.
// Upload adds files from your computer; right-click for more (where it's used, copy path, delete).
import { h, btn } from './dom.js';
import { dialog } from './menu.js';
import { kindOf, MEDIA_EXT } from '../layers.js';

const ACCEPT = Object.values(MEDIA_EXT).flat().map((e) => `.${e}`).join(',');
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export class AssetsPanel {
  constructor(ed, root) {
    this.ed = ed;
    this.root = root;
    this.items = [];
    this.filter = '';
    this.$list = h('div', { class: 'ed-assets' });
    const search = h('input', { type: 'text', placeholder: 'Search assets…', class: 'ed-asearch' });
    search.addEventListener('input', () => { this.filter = search.value.toLowerCase(); this.render(); });
    const upload = btn('Upload…', () => this.upload(), { ico: 'plus', title: 'Copy files from your computer into assets/' });
    const refresh = btn('', () => this.refresh(), { ico: 'redo', title: 'Refresh' });
    root.append(h('div', { class: 'ed-abar' }, search, upload, refresh), this.$list,
      h('div', { class: 'ed-ahint' }, 'Drag onto a timeline lane or the viewport · double-click: add at the playhead · right-click: more'));
    // files dropped on the panel are uploaded
    root.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); root.classList.add('drop'); } });
    root.addEventListener('dragleave', () => root.classList.remove('drop'));
    root.addEventListener('drop', async (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      root.classList.remove('drop');
      for (const f of e.dataTransfer.files) await this.uploadOne(f);
      this.refresh();
    });
  }

  async refresh() {
    try {
      const r = await fetch('./__editor/assets', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      this.items = (await r.json()).assets;
      this.error = null;
    } catch {
      this.items = [];
      this.error = 'The asset list needs the editor server (start the editor with “Open Editor”).';
    }
    this.render();
  }

  // which layers use an asset (directly or inside HTML)
  usage(file) {
    return this.ed.tl.layers().filter((t) => t.src === file || (t.html || '').includes(file));
  }

  render() {
    const items = this.items.filter((a) => !this.filter || a.file.toLowerCase().includes(this.filter));
    if (this.error) return this.$list.replaceChildren(h('div', { class: 'ed-ahint' }, this.error));
    if (!items.length) return this.$list.replaceChildren(h('div', { class: 'ed-ahint' }, this.items.length ? 'No match.' : 'No assets yet — Upload, or drop files here.'));
    this.$list.replaceChildren(...items.map((a) => {
      const kind = kindOf(a.file);
      const used = this.usage(a.file).length;
      const thumb = kind === 'image' ? h('img', { src: a.file, loading: 'lazy', draggable: false })
        : kind === 'video' ? h('video', { src: `${a.file}#t=0.5`, muted: true, preload: 'metadata' })
          : h('div', { class: 'ico' }, kind === 'iframe' ? 'HTML' : (a.file.split('.').pop() || '?').toUpperCase());
      const el = h('div', { class: 'ed-asset', draggable: true, title: `${a.file}\n${kb(a.size)}${used ? ` · used by ${used} layer(s)` : ''}` },
        h('div', { class: 'th' }, thumb, used ? h('span', { class: 'used' }, String(used)) : null),
        h('div', { class: 'nm' }, a.file.replace(/^assets\//, '')));
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-opentuna-asset', a.file);
        e.dataTransfer.setData('text/plain', a.file);
        e.dataTransfer.effectAllowed = 'copy';
      });
      el.addEventListener('dblclick', () => this.ed.lt.addAsset(a.file));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.ed.contextMenuItems(e.clientX, e.clientY, [
          { label: 'Add at the playhead', onClick: () => this.ed.lt.addAsset(a.file) },
          kind !== 'iframe' ? { label: 'Add in the 3D world', onClick: () => this.ed.lt.addAsset(a.file, { space: 'world' }) } : null,
          { label: used ? `Used by ${used} layer(s) — select the first` : 'Not used yet', disabled: !used, onClick: () => { const t = this.usage(a.file)[0]; this.ed.select({ kind: 'track', track: t }); this.ed.setTime(t.a); } },
          { label: 'Copy path', onClick: () => navigator.clipboard?.writeText(a.file) },
          { label: 'Open ↗', onClick: () => window.open(a.file, '_blank') },
          '-',
          { label: 'Delete file…', danger: true, onClick: () => this.remove(a, used) },
        ]);
      });
      return el;
    }));
  }

  async uploadOne(f) {
    if (!kindOf(f.name)) { this.ed.toast(`Skipped ${f.name} — images, videos or .html only`, true); return; }
    try { await this.ed.saves.upload(f); } catch (e) { this.ed.toast(e.message, true); }
  }

  async upload() {
    const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, style: 'display:none' });
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.remove();
      for (const f of files) await this.uploadOne(f);
      this.refresh();
      if (files.length) this.ed.toast(`${files.length} file(s) added to assets/`);
    });
    document.body.append(input);
    input.click();
  }

  remove(a, used) {
    dialog({
      title: 'Delete asset',
      body: [h('p', {}, `Delete ${a.file} from the project?`),
        used ? h('p', { class: 'warn' }, `It is used by ${used} layer(s) — they will show nothing until you replace the file.`) : null,
        h('p', { class: 'muted' }, 'Deleted files can be recovered from git history only if they were committed.')],
      buttons: [{ label: 'Cancel' }, { label: 'Delete', danger: true, onClick: async () => {
        try {
          const r = await fetch(`./__editor/asset-delete?file=${encodeURIComponent(a.file)}`, { method: 'POST', body: '' });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
          this.ed.toast(`Deleted ${a.file}`);
          this.refresh();
        } catch (e) { this.ed.toast(`Couldn’t delete: ${e.message}`, true); return false; }
        return true;
      } }],
    });
  }
}
