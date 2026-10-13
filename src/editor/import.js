// File ▸ Import into this story: another .tuna (or a story.json) merged INTO the open story — not opened instead of it.
// Pick what comes in (chapters / notes, tracks, groups, lanes), where (at the playhead on top of what's there, at the
// playhead pushing the rest later, or at its original times). Its media files are copied into this project (an
// identical file is reused, a different file with the same name gets a new name). Camera keys, captions and
// curves of a parameter this story already animates merge into the existing track; everything else is added with
// new ids. One undoable edit. Also offered when a .tuna is dropped on the timeline.
import { unzipSync, strFromU8 } from 'fflate';
import { h } from './dom.js';
import { dialog } from './menu.js';
import { fmtTime, migrate } from '../timeline.js';
import { editorAPI } from '../project.js';

const TYPE = { camera: 'Camera', captions: 'Captions', curve: 'Curve', clip: 'Clip', layer: 'Layer', path: 'Path', stretch: 'Repeat', lane: 'Lane', group: 'Group' };

export class Importer {
  constructor(ed) { this.ed = ed; }

  async pick() {
    const f = await this.ed.saves.pickFile('.tuna,.json,application/json');
    if (f) this.open(f);
  }

  // a .tuna dropped on the timeline: open it, or bring it into this story?
  offer(file) {
    dialog({
      title: file.name,
      body: [h('p', {}, 'Open it as its own project, or bring its tracks into the story you have open?')],
      buttons: [{ label: 'Cancel' }, { label: 'Open it', onClick: () => this.ed.project.openTuna(file) }, { label: 'Import into this story…', primary: true, onClick: () => { this.open(file); } }],
    });
  }

  async read(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let story, files = null;
    if (/\.tuna$/i.test(file.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      let entries;
      try { entries = unzipSync(bytes); } catch { throw new Error('not a .tuna file'); }
      if (!entries['story.json']) throw new Error('no story.json inside');
      story = JSON.parse(strFromU8(entries['story.json']));
      files = new Map(Object.entries(entries).filter(([n]) => n.startsWith('assets/') && !n.endsWith('/')));
    } else story = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(story.tracks)) throw new Error('not an Open Tuna story (no tracks)');
    return { story: migrate(story), files, name: file.name.replace(/\.(tuna|json)$/i, '') };
  }

  async open(file) {
    const ed = this.ed;
    if (ed.preview) return ed.previewRefuse();
    let src;
    try { src = await this.read(file); } catch (e) { return ed.toast(`Can’t import ${file.name}: ${e.message}`, true, 7000); }
    const S = src.story, D = S.meta?.duration ?? 60;
    const boxes = new Map(); // track id -> checkbox
    const own = ed.tl;
    const fate = (t) => {
      if (t.type === 'camera') return own.tracks.some((q) => q.type === 'camera') ? 'keys merge into your camera' : 'added';
      if (t.type === 'captions') return 'captions added to yours';
      if ((t.type === 'curve' || t.type === 'clip') && own.bound.get(t.bind)) return t.type === 'clip' ? `replaces the timing of your “${t.bind}” clip` : `keys merge into your “${own.bound.get(t.bind).label}”`;
      return 'added';
    };
    const row = (t, depth) => {
      const c = h('input', { type: 'checkbox', checked: true });
      boxes.set(t.id, c);
      const n = t.keys?.length ? `${t.keys.length} keys` : t.clips?.length ? `${t.clips.length} captions` : typeof t.a === 'number' ? `${fmtTime(t.a)}–${fmtTime(t.b)}` : '';
      return h('label', { class: 'imp-r', style: `padding-left:${depth * 18}px` }, c, h('span', { class: 'tp' }, TYPE[t.type] ?? t.type), h('b', {}, t.label || t.id), h('small', {}, [n, t.type === 'group' || t.type === 'lane' ? '' : fate(t)].filter(Boolean).join(' · ')));
    };
    const rows = [];
    const tracks = S.tracks;
    const inLane = (t) => t.lane && tracks.some((q) => q.id === t.lane && q.type === 'lane');
    const kids = (id) => tracks.filter((t) => (t.parent === id && !inLane(t)) || t.lane === id);
    const add = (t, depth) => { rows.push(row(t, depth)); if (t.type === 'group' || t.type === 'lane') for (const k of kids(t.id)) add(k, depth + 1); };
    for (const t of tracks) if (!(t.parent && tracks.some((q) => q.id === t.parent)) && !inLane(t)) add(t, 0);
    // a group / lane checkbox ticks its members
    for (const t of tracks) {
      if (t.type !== 'group' && t.type !== 'lane') continue;
      boxes.get(t.id).addEventListener('change', (e) => {
        const walk = (id) => { for (const k of kids(id)) { boxes.get(k.id).checked = e.target.checked; walk(k.id); } };
        walk(t.id);
      });
    }
    const marks = h('input', { type: 'checkbox', checked: true });
    const at = ed.time;
    const place = h('select', {},
      h('option', { value: 'over' }, `at the playhead (${fmtTime(at)}), on top of what’s there`),
      h('option', { value: 'insert' }, `at the playhead, and push everything after it later by ${fmtTime(D)}`),
      h('option', { value: 'orig' }, 'at its original times'));
    const nFiles = src.files?.size ?? 0;
    dialog({
      title: `Import “${src.name}” into this story`,
      wide: true,
      body: [
        h('p', { class: 'muted' }, `${S.meta?.title ? `“${S.meta.title}” · ` : ''}${fmtTime(D)} · ${tracks.length} tracks · ${S.chapters?.length ?? 0} chapters${nFiles ? ` · ${nFiles} media files` : ''}`),
        h('label', { class: 'lbl' }, 'Place it', place),
        h('label', { class: 'chk' }, marks, ` Chapters and notes (${S.chapters?.length ?? 0} + ${S.notes?.length ?? 0})`),
        h('div', { class: 'imp-list' }, rows),
        h('p', { class: 'muted' }, `${nFiles ? 'Its media files are copied into this project (identical files are reused; a different file with the same name gets a new name). ' : ''}Data sources it uses are added if this story doesn’t have one with the same name. It’s one edit: ${ed.mod}Z takes it all back.`),
      ],
      buttons: [{ label: 'Cancel' }, { label: 'Import', primary: true, onClick: () => { this.run(src, new Set([...boxes].filter(([, c]) => c.checked).map(([id]) => id)), place.value, marks.checked, at); } }],
    });
  }

  async run(src, ids, place, withMarks, at) {
    const ed = this.ed, S = src.story;
    const picked = S.tracks.filter((t) => ids.has(t.id));
    if (!picked.length && !withMarks) return ed.toast('Nothing selected to import', true);
    // media: copy what the picked tracks use (keeping sub-folders)
    const map = new Map();
    const refs = new Set(JSON.stringify(picked).match(/assets\/[^"'\s)<>]+/g) ?? []);
    let missing = 0;
    if (refs.size && src.files) {
      const busy = ed.project.busy('Copying media…');
      try {
        let i = 0;
        for (const r of refs) {
          busy.set(`Copying ${r} (${++i}/${refs.size})`);
          const bytes = src.files.get(r);
          if (!bytes) { missing++; continue; }
          const dir = r.slice(0, r.lastIndexOf('/'));
          const res = await fetch(editorAPI(`upload?name=${encodeURIComponent(r.split('/').pop())}&dir=${encodeURIComponent(dir)}`), { method: 'POST', body: bytes });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(`${r}: ${j.error || res.status}`);
          if (j.file !== r) map.set(r, j.file);
        }
      } catch (e) { busy.close(); return ed.toast(`Import stopped: ${e.message}`, true, 8000); }
      busy.close();
      ed.assets?.refresh();
    }
    const fix = (o) => (map.size ? JSON.parse(JSON.stringify(o).replace(/assets\/[^"'\s)<>]+/g, (m) => map.get(m) ?? m)) : o);
    const clip = {
      app: 'open-tuna', v: 3, t0: 0,
      items: withMarks ? [...(S.chapters ?? []).map((c) => ({ kind: 'chapter', item: c })), ...(S.notes ?? []).map((n) => ({ kind: 'note', item: n }))] : [],
      tracks: fix(picked),
    };
    // data sources it binds to
    const d = ed.tl.data, have = new Set((d.sources ?? []).map((q) => q.id));
    const clash = [];
    for (const q of S.sources ?? []) {
      if (!have.has(q.id)) (d.sources ??= []).push(structuredClone(q));
      else if (JSON.stringify(d.sources.find((x) => x.id === q.id)) !== JSON.stringify(q)) clash.push(q.id);
    }
    if (place === 'insert') ed.insertTime(at, S.meta?.duration ?? 60, { commit: false });
    await ed.paste(null, { clip, at: place === 'orig' ? 0 : at, original: place === 'orig', label: `Imported “${src.name}”` });
    ed.timeline.fit();
    if (missing || clash.length) ed.toast(`${missing ? `${missing} media file${missing === 1 ? ' was' : 's were'} not in the file — check the Assets tab. ` : ''}${clash.length ? `Kept your data source${clash.length === 1 ? '' : 's'} ${clash.join(', ')} (the imported one${clash.length === 1 ? '' : 's'} had the same name).` : ''}`, true, 9000);
  }
}
