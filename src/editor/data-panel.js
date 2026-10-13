// Data tab (left panel): live JSON sources (an API, a CMS, a Google Sheet as JSON…) for {{bindings}}.
// Each source is { id, url, headers?, refresh?, sample? } in story.json `sources` (src/data.js resolves them).
// The tree shows the current value; click a value to copy its binding or put it into the selected layer.
import { h, btn } from './dom.js';
import { dialog } from './menu.js';

const REFRESH = [[0, 'Load once'], [10, 'Every 10 s'], [60, 'Every minute'], [300, 'Every 5 min']];
const short = (v) => {
  const s = typeof v === 'string' ? `“${v}”` : JSON.stringify(v);
  return s.length > 48 ? `${s.slice(0, 46)}…` : s;
};
const isIdent = (k) => /^[A-Za-z_$][\w$-]*$/.test(k);
const looksLikeURL = (v) => typeof v === 'string' && /^(https?:\/\/|assets\/)\S+\.(png|jpe?g|webp|gif|svg|avif|mp4|webm|mov|m4v|glb|html?)(\?\S*)?$/i.test(v);

export class DataPanel {
  constructor(ed, root) {
    this.ed = ed;
    this.root = root;
    this.hub = ed.app.data;
    this.open = new Set(); // expanded tree paths
    this.seen = '';
    this.$list = h('div', { class: 'ed-data' });
    root.append(
      h('div', { class: 'ed-abar' },
        btn('Source', () => this.addDialog(), { ico: 'plus', title: 'Connect a JSON API / CMS endpoint' }),
        btn('', () => this.refetch(), { ico: 'redo', title: 'Fetch every source again' })),
      this.$list,
      h('div', { class: 'ed-ahint' }, 'Type ', h('code', {}, '{{source.path}}'), ' in any text, HTML or file field of a layer or caption — e.g. ',
        h('code', {}, '{{products.items[0].name | Coming soon}}'), ' (after | = fallback). Click a value below to use it.'),
    );
  }

  get sources() { return (this.ed.tl.data.sources ??= []); }

  refetch() { for (const s of this.sources) if (s.url) this.hub.fetch(s); }

  // called by the editor's UI tick; redraws when the sources or their data changed (not while typing in it)
  tick() {
    if (this.root.style.display === 'none') return;
    const key = `${this.ed.tl.version}|${this.hub.version}|${JSON.stringify(this.hub.status)}`;
    if (key === this.seen || this.root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    this.seen = key;
    this.render();
  }

  render() {
    const src = this.sources;
    if (!src.length) {
      this.$list.replaceChildren(h('div', { class: 'ed-ahint' }, 'No data sources yet. ', btn('Connect one', () => this.addDialog()),
        h('p', {}, 'Any URL that returns JSON works: a headless CMS (Contentful, Strapi, Sanity, WordPress REST…), your own API, or a JSON file in assets/. The built site loads it live; a saved sample is the fallback.')));
      return;
    }
    this.$list.replaceChildren(...src.map((s) => this.card(s)));
  }

  card(s) {
    const st = this.hub.status[s.id] ?? { state: 'sample' };
    const state = { live: ['live', 'good'], loading: ['loading…', 'warn'], error: ['error', 'bad'], sample: [s.sample !== undefined ? 'sample' : 'no data', 'dim'] }[st.state] ?? ['?', 'dim'];
    const id = h('input', { type: 'text', value: s.id, class: 'id', title: 'Name used in bindings: {{name.path}}', spellcheck: false });
    id.addEventListener('change', () => {
      const v = id.value.trim().replace(/[^\w-]/g, '_');
      if (!v || this.sources.some((o) => o !== s && o.id === v)) { id.value = s.id; return this.ed.toast('Each source needs its own name', true); }
      this.renameBindings(s.id, v);
      s.id = v;
      this.ed.commit();
    });
    const url = h('input', { type: 'text', value: s.url ?? '', placeholder: 'https://…/api/items  or  assets/data.json', spellcheck: false });
    url.addEventListener('change', () => { s.url = url.value.trim(); this.ed.commit(); });
    const every = h('select', { title: 'How often the site reloads it' }, REFRESH.map(([v, l]) => h('option', { value: v }, l)));
    every.value = String(s.refresh ?? 0);
    every.addEventListener('change', () => { s.refresh = +every.value || undefined; this.ed.commit(); });
    const more = btn('', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      this.ed.contextMenuItems(r.left, r.bottom + 2, [
        { label: 'Fetch now', onClick: () => s.url && this.hub.fetch(s) },
        { label: 'Save the current data as the sample', disabled: this.hub.values[s.id] === undefined, onClick: () => { s.sample = structuredClone(this.hub.values[s.id]); this.ed.commit(); this.ed.toast(`Sample saved — “${s.id}” shows it offline, in the editor, and if the live API fails`); } },
        { label: 'Paste sample JSON…', onClick: () => this.sampleDialog(s) },
        { label: 'Headers (public tokens only)…', onClick: () => this.headersDialog(s) },
        { label: 'Remove the sample', disabled: s.sample === undefined, onClick: () => { delete s.sample; this.ed.commit(); } },
        '-',
        { label: 'Remove source', danger: true, onClick: () => { this.sources.splice(this.sources.indexOf(s), 1); this.ed.commit(); } },
      ]);
    }, { ico: 'more', title: 'More' });
    const v = this.hub.values[s.id];
    return h('section', { class: 'src' },
      h('div', { class: 'hd' }, id, h('span', { class: `st ${state[1]}`, title: st.error || (st.at ? `at ${new Date(st.at).toLocaleTimeString()}` : '') }, state[0]), more),
      url,
      h('div', { class: 'row' }, every, s.sample !== undefined ? h('small', { class: 'dim' }, 'has sample') : h('small', { class: 'warn' }, 'no sample — save one as a fallback')),
      st.state === 'error' ? h('div', { class: 'err' }, st.error) : null,
      v === undefined ? null : h('div', { class: 'tree' }, this.node(v, s.id, s.id, 0)),
    );
  }

  // one level of the JSON tree; `path` is the binding path so far
  node(v, label, path, depth) {
    if (v === null || typeof v !== 'object') {
      const el = h('div', { class: 'leaf', title: `{{${path}}}\nclick: use it` }, h('span', { class: 'k' }, label), h('span', { class: 'v' }, short(v)));
      el.addEventListener('click', (e) => this.leafMenu(e, path, v));
      return el;
    }
    const arr = Array.isArray(v), keys = arr ? v.map((_, i) => i) : Object.keys(v);
    const open = depth < 1 || this.open.has(path);
    const head = h('div', { class: `br${open ? ' open' : ''}`, title: `{{${path}}}` }, h('span', { class: 'tw' }, open ? '▾' : '▸'), h('span', { class: 'k' }, label), h('span', { class: 'v dim' }, arr ? `[${v.length}]` : `{${keys.length}}`));
    head.addEventListener('click', () => { if (this.open.has(path)) this.open.delete(path); else this.open.add(path); this.render(); });
    if (!open) return head;
    const shown = keys.slice(0, 40);
    return h('div', {}, head, h('div', { class: 'kids' },
      ...shown.map((k) => this.node(v[k], arr ? `[${k}]` : k, arr ? `${path}[${k}]` : isIdent(k) ? `${path}.${k}` : `${path}[${k}]`, depth + 1)),
      keys.length > shown.length ? h('div', { class: 'dim' }, `… ${keys.length - shown.length} more`) : null));
  }

  leafMenu(e, path, v) {
    const ed = this.ed, b = `{{${path}}}`, sel = ed.sel, t = sel?.kind === 'track' && sel.track.type === 'layer' ? sel.track : null;
    const set = (obj, field, label) => ({ label, disabled: !obj || ed.isLocked(sel), onClick: () => { obj[field] = b; ed.commit(); ed.toast(`${label.replace(/^Set /, '')} now follows ${b}`); } });
    const items = [{ label: `Copy ${b}`, onClick: () => { navigator.clipboard?.writeText(b); ed.toast(`Copied ${b}`); } }, '-'];
    if (t?.kind === 'text') items.push(set(t, 'title', 'Set the title of the selected text layer'), set(t, 'kicker', 'Set its kicker (small line)'), set(t, 'body', 'Set its body text'));
    else if (t && ['image', 'video', 'iframe', 'model'].includes(t.kind)) items.push({ ...set(t, 'src', `Set the file / URL of “${t.label}”`), disabled: !looksLikeURL(v) && typeof v !== 'string' });
    else if (t?.kind === 'html') items.push({ label: `Add to the HTML of “${t.label}”`, onClick: () => { t.html = `${t.html ?? ''}\n<p>${b}</p>`; ed.commit(); } });
    else if (sel?.kind === 'clip' && sel.track.type === 'captions') items.push(set(sel.item, 'title', 'Set the selected caption’s title'), set(sel.item, 'sub', 'Set its subtitle'));
    else items.push({ label: 'Select a layer or caption to put it there', disabled: true });
    items.push('-', { label: `Value: ${short(v)}`, disabled: true });
    ed.contextMenuItems(e.clientX, e.clientY, items);
  }

  // keep bindings working when a source is renamed
  renameBindings(from, to) {
    const re = new RegExp(`\\{\\{(\\s*)${from.replace(/[-]/g, '\\-')}(?=[.[\\s|}])`, 'g');
    const fix = (o) => {
      for (const k of Object.keys(o)) {
        if (typeof o[k] === 'string' && o[k].includes('{{')) o[k] = o[k].replace(re, `{{$1${to}`);
        else if (o[k] && typeof o[k] === 'object') fix(o[k]);
      }
    };
    fix(this.ed.tl.data.tracks);
  }

  addDialog() {
    const id = h('input', { type: 'text', placeholder: 'products', spellcheck: false });
    const url = h('input', { type: 'text', placeholder: 'https://cms.example.com/api/products', spellcheck: false });
    const go = () => {
      const name = (id.value.trim() || 'data').replace(/[^\w-]/g, '_');
      if (this.sources.some((s) => s.id === name)) { this.ed.toast(`There is already a source “${name}”`, true); return false; }
      this.sources.push({ id: name, url: url.value.trim() });
      this.open.clear();
      this.ed.commit();
      this.ed.showTab?.('data');
      return true;
    };
    dialog({
      title: 'Connect a data source',
      body: [
        h('label', { class: 'lbl' }, 'Name (used in bindings)', id),
        h('label', { class: 'lbl' }, 'URL returning JSON', url),
        h('p', { class: 'muted' }, 'The website calls this URL from the visitor’s browser, so the API must allow it (CORS) and must not need a secret key. Read-only / public delivery tokens are fine (Headers…). After it loads, use “Save the current data as the sample” so the story still works offline.'),
      ],
      buttons: [{ label: 'Cancel' }, { label: 'Connect', primary: true, onClick: go }],
    });
  }

  sampleDialog(s) {
    const ta = h('textarea', { rows: 12, spellcheck: false, placeholder: '{ "items": [ { "name": "…" } ] }' }, s.sample !== undefined ? JSON.stringify(s.sample, null, 2) : '');
    dialog({
      title: `Sample data for “${s.id}”`,
      body: [h('p', { class: 'muted' }, 'Shown in the editor and on the site until (or if not) the live URL answers. Paste a response from the API, or any JSON to design with.'), ta],
      wide: true,
      buttons: [{ label: 'Cancel' }, { label: 'Save sample', primary: true, onClick: () => {
        try { s.sample = JSON.parse(ta.value); } catch (e) { this.ed.toast(`Not valid JSON: ${e.message}`, true); return false; }
        this.ed.commit();
        return true;
      } }],
    });
  }

  headersDialog(s) {
    const ta = h('textarea', { rows: 5, spellcheck: false, placeholder: 'Authorization: Bearer <public delivery token>' }, Object.entries(s.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
    dialog({
      title: `Request headers for “${s.id}”`,
      body: [h('p', { class: 'warn' }, 'Everything here is visible to every visitor of the site. Only use public, read-only tokens (e.g. a CMS “delivery” / “preview” key) — never an admin or write key.'), ta],
      buttons: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => {
        const hd = {};
        for (const line of ta.value.split('\n')) { const i = line.indexOf(':'); if (i > 0) hd[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
        s.headers = Object.keys(hd).length ? hd : undefined;
        this.ed.commit();
        return true;
      } }],
    });
  }
}
