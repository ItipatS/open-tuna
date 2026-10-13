// .tuna project files — the editor's document format, like a .psd: ONE file holding the story, its media and a
// preview, that you can email, keep on a drive and open again. It's a zip:
//   manifest.json            { format: "open-tuna", version, name, title, created, modified, duration }
//   story.json               the timeline (docs/story-format.md)
//   assets/**                every file in the project's assets/ (uploads, pages, models)
//   saves/checkpoints/*.json named checkpoints
//   thumb.webp               a frame of the Game view (the preview in Open recent)
// Opening one unpacks it into projects/<slug>/ through the dev server (a working copy: autosave / checkpoints /
// uploads go there, so the runtime loads plain URLs) and reloads the editor on editor.html?project=<slug>.
// Save writes the working copy, then the .tuna file itself (File System Access: the same file you opened, the
// handle is remembered per project in IndexedDB). Demo projects (demo/<id> = demos/<id>/, part of the tool) save in
// place and can be committed to git; "Save as .tuna" packages them. The standalone helpers below (unpackTuna,
// openTunaFile, blankTuna) are also used by the studio home page (index.html).
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { h, btn, download } from './dom.js';
import { dialog } from './menu.js';
import { PROJECT, BASE, IS_DEMO, editorAPI, editorURL } from '../project.js';
import { fnv1a } from './saves.js';

export const TUNA_VERSION = 1;
const STORED = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'mp4', 'webm', 'mov', 'm4v', 'mp3', 'ogg', 'glb']); // already compressed
const PUTABLE = /^(story\.json|manifest\.json|thumb\.(webp|png)|assets\/.+\.[a-z0-9]+|saves\/checkpoints\/[^/]+\.json)$/i;
const mb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ago = (sec) => new Date(sec * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const apiFor = (slug, path) => `./__editor/${path}${slug ? `${path.includes('?') ? '&' : '?'}project=${slug}` : ''}`;

// a tiny IndexedDB key-value store: file handles survive reloads there (localStorage can't hold them)
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('open-tuna', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function kv(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const st = db.transaction('kv', val === undefined ? 'readonly' : 'readwrite').objectStore('kv');
    const r = val === undefined ? st.get(key) : val === null ? st.delete(key) : st.put(val, key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// a blank story for File ▸ New project ▸ Blank
function blankStory(title) {
  return `${JSON.stringify({
    version: 2,
    meta: { title, duration: 60, scrollPerSecond: 15 },
    settings: { tunaCount: 2000, params: {} },
    chapters: [{ t: 0, name: 'Start' }],
    notes: [],
    tracks: [
      { id: 'camera', type: 'camera', label: 'Camera', keys: [
        { t: 0, pos: [0, -9, 26], look: [0, -6, 0], fov: 50 },
        { t: 60, pos: [18, -8, 20], look: [0, -6, 0], fov: 50 },
      ] },
      { id: 'captions', type: 'captions', label: 'Captions', clips: [] },
    ],
    sources: [],
  }, null, 2)}\n`;
}

// a .tuna holding a blank story
export function blankTuna(name) {
  return zipSync({ 'story.json': strToU8(blankStory(name)), 'manifest.json': strToU8(JSON.stringify({ format: 'open-tuna', version: TUNA_VERSION, name, created: new Date().toISOString() }, null, 2)) });
}

// .tuna bytes -> a new projects/<slug>/ working copy (through the dev server) -> { slug, story }
export async function unpackTuna(bytes, fallbackName, { progress, warn } = {}) {
  let entries;
  try { entries = unzipSync(bytes); } catch { throw new Error('this isn’t a .tuna file (not a zip)'); }
  if (!entries['story.json']) throw new Error('this .tuna has no story.json inside');
  const story = strFromU8(entries['story.json']);
  if (!Array.isArray(JSON.parse(story).tracks)) throw new Error('the story.json inside is not an Open Tuna story');
  let manifest = {};
  try { manifest = entries['manifest.json'] ? JSON.parse(strFromU8(entries['manifest.json'])) : {}; } catch { /* keep going */ }
  if (manifest.version > TUNA_VERSION) warn?.(`This .tuna was made by a newer editor (v${manifest.version}) — some things may not show`);
  const name = manifest.name || fallbackName || 'Untitled';
  if (!entries['manifest.json']) entries['manifest.json'] = strToU8(JSON.stringify({ format: 'open-tuna', version: TUNA_VERSION, name }, null, 2));
  const made = await fetch(`./__editor/project/new?name=${encodeURIComponent(name)}`, { method: 'POST', body: '' });
  const j = await made.json().catch(() => ({}));
  if (!made.ok) throw new Error(j.error || `HTTP ${made.status}`);
  const names = Object.keys(entries).filter((n) => !n.endsWith('/') && PUTABLE.test(n));
  let i = 0;
  for (const n of names) {
    progress?.(`Unpacking ${n} (${++i}/${names.length})`);
    const r = await fetch(apiFor(j.project, `put?file=${encodeURIComponent(n)}`), { method: 'POST', body: entries[n] });
    if (!r.ok) throw new Error(`${n}: ${(await r.json().catch(() => ({}))).error || r.status}`);
  }
  return { slug: j.project, story };
}

// a File (input / drop) or a FileSystemFileHandle (picker: Save later writes back to it) -> working copy slug
export async function openTunaFile(fileOrHandle, opts = {}) {
  const handle = fileOrHandle.getFile ? fileOrHandle : null;
  const file = handle ? await handle.getFile() : fileOrHandle;
  const { slug, story } = await unpackTuna(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.tuna$/i, ''), opts);
  try {
    if (handle) await kv(`handle:${slug}`, handle);
    await kv(`saved:${slug}`, fnv1a(story));
  } catch { /* IndexedDB unavailable: Save will ask where to save */ }
  return slug;
}

export class ProjectFiles {
  constructor(ed) {
    this.ed = ed;
    this.slug = PROJECT;
    this.name = IS_DEMO ? PROJECT.slice(5) : PROJECT;
    this.manifest = null;
    this.handle = null; // FileSystemFileHandle of the .tuna (when opened / saved through the picker)
    this.savedHash = null; // fnv1a of the story last written to the .tuna file
    if (PROJECT) this.loadMeta();
  }

  get isFile() { return !!this.slug && !IS_DEMO; } // a .tuna project (demos save in place, like code)
  get isDemo() { return IS_DEMO; }
  get fileName() { return `${this.name.replace(/[\\/:*?"<>|]+/g, '-')}.tuna`; }
  // the story differs from what's in the .tuna file on disk
  get tunaDirty() { return this.isFile && this.savedHash !== fnv1a(this.ed.current()); }

  async loadMeta() {
    try {
      const r = await fetch(`./${BASE}manifest.json`, { cache: 'no-store' });
      if (r.ok) this.manifest = await r.json();
    } catch { /* no manifest */ }
    if (this.manifest?.name) this.name = this.manifest.name;
    try {
      this.handle = (await kv(`handle:${this.slug}`)) ?? null;
      this.savedHash = (await kv(`saved:${this.slug}`)) ?? null;
    } catch { /* IndexedDB unavailable */ }
    this.ed.syncTitle?.();
  }

  // ---------------------------------------------------------------- pack / unpack
  // story text + every project file (+ preview) -> .tuna bytes
  async pack(storyText, { name = this.name, thumb = true, progress } = {}) {
    const r = await fetch(editorAPI('files'), { cache: 'no-store' });
    if (!r.ok) throw new Error('packing needs the editor server (start it with “Open Editor”)');
    const files = (await r.json()).files.filter((f) => f.file !== 'story.json');
    const meta = this.ed.tl.meta, now = new Date().toISOString();
    const manifest = { format: 'open-tuna', version: TUNA_VERSION, name, title: meta.title ?? name, created: this.manifest?.created ?? now, modified: now, duration: meta.duration };
    const out = {
      'manifest.json': [strToU8(`${JSON.stringify(manifest, null, 2)}\n`), { level: 6 }],
      'story.json': [strToU8(storyText), { level: 6 }],
    };
    let i = 0;
    for (const f of files) {
      progress?.(`Packing ${f.file} (${++i}/${files.length})`);
      const res = await fetch(`./${BASE}${f.file}`, { cache: 'no-store' });
      if (!res.ok) continue;
      out[f.file] = [new Uint8Array(await res.arrayBuffer()), { level: STORED.has(f.file.split('.').pop().toLowerCase()) ? 0 : 6 }];
    }
    if (thumb) {
      const t = await this.thumb();
      if (t) out['thumb.webp'] = [t, { level: 0 }];
    }
    progress?.('Compressing…');
    await new Promise((res) => setTimeout(res, 0));
    return zipSync(out);
  }

  // a 640 px webp of the viewport
  async thumb() {
    try {
      const png = await this.ed.app.capture();
      if (!png) return null;
      const bmp = await createImageBitmap(png);
      const w = 640, hgt = Math.round((bmp.height / bmp.width) * w);
      const c = new OffscreenCanvas(w, hgt);
      c.getContext('2d').drawImage(bmp, 0, 0, w, hgt);
      return new Uint8Array(await (await c.convertToBlob({ type: 'image/webp', quality: 0.82 })).arrayBuffer());
    } catch { return null; }
  }

  // .tuna bytes -> a new projects/<slug>/ working copy -> its slug
  unpack(bytes, fallbackName, progress) {
    return unpackTuna(bytes, fallbackName, { progress, warn: (m) => this.ed.toast(m, true, 8000) });
  }

  // ---------------------------------------------------------------- open
  async pickAndOpen() {
    if (window.showOpenFilePicker) {
      let handle;
      try { [handle] = await window.showOpenFilePicker({ types: [{ description: 'Open Tuna project', accept: { 'application/octet-stream': ['.tuna'] } }] }); } catch (e) { if (e.name === 'AbortError') return; }
      if (handle) return this.openTuna(handle);
    }
    const f = await this.ed.saves.pickFile('.tuna');
    if (f) this.openTuna(f);
  }

  // a File (input / drop) or a FileSystemFileHandle (picker: saving later writes back to it)
  async openTuna(fileOrHandle) {
    if (!this.ed.saves.server) return this.ed.toast('Opening a .tuna needs the editor server — start the editor with “Open Editor”', true, 6000);
    const name = fileOrHandle.name;
    const busy = this.busy(`Opening ${name}…`);
    try {
      await this.leave();
      this.go(await openTunaFile(fileOrHandle, { progress: busy.set, warn: (m) => this.ed.toast(m, true, 8000) }));
    } catch (e) {
      busy.close();
      this.ed.toast(`Couldn’t open ${name}: ${e.message}`, true, 8000);
    }
  }

  // save the current story before switching projects (the working copy / repo keep it)
  async leave() {
    if (this.ed.saves.dirty && this.ed.saves.server) await this.ed.saves.save({ auto: true, quiet: true });
  }

  go(slug) {
    this.ed.leaving = true; // no "unsaved changes" prompt: just saved
    location.href = slug ? editorURL(slug) : './';
  }

  // ---------------------------------------------------------------- save
  // write the .tuna file (Save in a project; Save as… / Save as .tuna anywhere)
  async saveTuna({ as = false } = {}) {
    if (!this.ed.saves.server) return this.ed.toast('Saving a .tuna needs the editor server', true);
    let handle = as || !this.isFile ? null : this.handle;
    if (handle) {
      try {
        let perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') handle = null;
      } catch { handle = null; }
    }
    if (!handle && window.showSaveFilePicker) {
      try {
        handle = await window.showSaveFilePicker({ suggestedName: this.fileName, types: [{ description: 'Open Tuna project', accept: { 'application/octet-stream': ['.tuna'] } }] });
      } catch (e) { if (e.name === 'AbortError') return false; handle = null; }
    }
    const text = this.ed.current();
    const name = handle && !this.isFile ? handle.name.replace(/\.tuna$/i, '') : this.name;
    const busy = this.busy('Saving…');
    try {
      const bytes = await this.pack(text, { name, progress: busy.set });
      if (handle) {
        const w = await handle.createWritable();
        await w.write(bytes);
        await w.close();
      } else download(this.fileName, new Blob([bytes], { type: 'application/octet-stream' }));
      if (this.isFile) {
        this.savedHash = fnv1a(text);
        if (handle) this.handle = handle;
        try {
          await kv(`saved:${this.slug}`, this.savedHash);
          if (handle) await kv(`handle:${this.slug}`, handle);
        } catch { /* IndexedDB unavailable */ }
      }
      this.ed.toast(`${handle ? `Saved ${handle.name}` : `Downloaded ${this.fileName}`} · ${mb(bytes.length)}`);
      this.ed.syncButtons();
      return true;
    } catch (e) {
      this.ed.toast(`Couldn’t save the .tuna: ${e.message}`, true, 8000);
      return false;
    } finally { busy.close(); }
  }

  // ---------------------------------------------------------------- new / recent
  newDialog() {
    if (!this.ed.saves.server) return this.ed.toast('Projects need the editor server', true);
    const input = h('input', { type: 'text', placeholder: 'e.g. Thai Union — Japan market', maxLength: 60 });
    const blank = h('input', { type: 'radio', name: 'tpl', checked: true });
    const copy = h('input', { type: 'radio', name: 'tpl' });
    const make = async () => {
      const name = input.value.trim() || 'Untitled';
      const busy = this.busy(`Creating ${name}…`);
      try {
        await this.leave();
        const bytes = copy.checked
          ? await this.pack(this.ed.current(), { name, progress: busy.set })
          : blankTuna(name);
        const { slug } = await this.unpack(bytes, name, busy.set);
        this.go(slug);
      } catch (e) { busy.close(); this.ed.toast(`Couldn’t create it: ${e.message}`, true, 8000); return false; }
      return true;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') make(); });
    dialog({
      title: 'New project',
      body: [
        h('label', { class: 'lbl' }, 'Name', input),
        h('label', { class: 'chk' }, blank, ' Blank — just the ocean, a camera and an empty timeline'),
        h('label', { class: 'chk' }, copy, ` A copy of “${this.name}” (story + its assets)`),
        h('p', { class: 'muted' }, 'Save (Ctrl+S) asks where to keep the .tuna file the first time.'),
      ],
      buttons: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: make }],
    });
    setTimeout(() => input.focus(), 0);
  }

  async recentDialog() {
    const body = h('div', { class: 'ed-projects' }, h('p', { class: 'muted' }, 'Loading…'));
    const d = dialog({
      title: 'Projects', body, wide: true,
      buttons: [{ label: 'New project…', onClick: () => { d.close(); this.newDialog(); } }, { label: 'Open .tuna file…', primary: true, onClick: () => { this.pickAndOpen(); } }, { label: 'Close' }],
    });
    const card = (name, sub, thumb, current, open) => {
      const el = h('div', { class: `pc${current ? ' cur' : ''}`, title: current ? 'Open now' : `Open ${name}` },
        h('div', { class: 'pt' }, thumb ? h('img', { src: thumb, draggable: false }) : h('span', {}, 'no preview')),
        h('b', {}, name), h('small', {}, current ? `${sub} · open now` : sub));
      if (!current) el.addEventListener('click', async () => { d.close(); await this.leave(); open(); });
      return el;
    };
    let list = [], demos = [];
    try {
      const r = await fetch('./__editor/projects', { cache: 'no-store' });
      if (r.ok) ({ projects: list = [], demos = [] } = await r.json());
    } catch { /* server down */ }
    body.replaceChildren(
      h('p', { class: 'muted' }, 'Your projects (working copies in projects/ — each saves back to its .tuna file) and the demos that come with the studio (team only: they save in place and go to git).'),
      h('div', { class: 'grid' },
        ...list.map((p) => card(p.name, ago(p.mtime), p.thumb ? `./${p.thumb}?v=${p.mtime}` : '', p.project === this.slug, () => this.go(p.project))),
        ...demos.map((p) => card(`${p.name} (demo)`, 'edits the original', p.thumb ? `./${p.thumb}` : '', p.project === this.slug, () => this.go(p.project)))),
      h('p', {}, h('a', { href: './' }, '← Studio home')),
    );
  }

  // a modal progress note for long packs / unpacks
  busy(text) {
    const msg = h('p', {}, text);
    const d = dialog({ title: 'Working…', body: [msg], buttons: [] });
    return { set: (t) => { msg.textContent = t; }, close: () => d.close() };
  }
}
