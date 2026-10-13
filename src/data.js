// Live data for the story: JSON from APIs / a CMS, bound into layers and captions with {{bindings}}.
//   story.json  "sources": [{ id: "products", url: "https://cms.example.com/api/products", headers?: {…},
//                             refresh?: seconds, sample?: <JSON> }]
//   any layer text / title / body / kicker / html / src and caption title / sub can say
//     {{products.items[0].name}}            (source id, then a path: .key and [index])
//     {{products.items[0].name | Coming soon}}   (text after | = fallback while loading / on error)
//   {{item.name}} {{item.number}} {{item.count}}   the current item of a `stretch` region (story.json), set by Story
//   {{#each partners.items}}<li>{{name}}</li>{{/each}}   repeats the inside once per list item (inside: the item's
//     fields, {{this}}, {{@index}}, {{@number}}) — an element that grows with the CMS
// Each source shows its `sample` (a saved snapshot) at once, then the live response once it arrives. A failed fetch
// (offline, CORS) keeps the sample, so a built site never shows empty bindings. Everything here is public: never put
// secret keys in `headers` (only read-only / public delivery tokens). A relative url ("assets/data.json") is a file of
// the story, like any other asset.
import { assetURL } from './project.js';
export class DataHub {
  constructor() {
    this.values = {}; // id -> JSON (live, else sample)
    this.status = {}; // id -> { state: 'sample' | 'loading' | 'live' | 'error', error, at }
    this.version = 0; // bumps whenever a value changes (layers / captions re-resolve)
    this.sig = null;
    this.timers = [];
    this.item = null; // { list, k, n, value } while the story is inside a stretch region
    this.itemKey = '';
  }

  // the stretch region's current item (Story calls this every frame; bumps version when it changes)
  setItem(ctx) {
    const value = ctx ? this.get(ctx.list)?.[ctx.k] : undefined;
    const key = ctx ? `${ctx.list}#${ctx.k}/${ctx.n}|${value === undefined ? '' : JSON.stringify(value)}` : '';
    if (key === this.itemKey) return;
    this.itemKey = key;
    this.item = ctx ? { ...ctx, value } : null;
    this.version++;
  }

  // the item scope for item k of a list (to resolve ahead, e.g. preloading the next item's image)
  itemFor(list, k, n) { return { list, k, n, value: this.get(list)?.[k] }; }

  // how many items a list has right now (1 if it isn't a list yet: one cycle with fallbacks)
  count(list) {
    const v = this.get(list);
    return Array.isArray(v) ? v.length : 1;
  }

  // (re)load when the source list changed
  sync(sources = []) {
    const sig = JSON.stringify(sources.map((s) => [s.id, s.url, s.headers, s.refresh, s.sample]));
    if (sig === this.sig) return;
    this.sig = sig;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.values = {};
    this.status = {};
    for (const s of sources) {
      if (!s.id) continue;
      if (s.sample !== undefined) this.values[s.id] = s.sample;
      this.status[s.id] = { state: 'sample' };
      if (s.url) {
        this.fetch(s);
        if (s.refresh > 0) this.timers.push(setInterval(() => this.fetch(s), Math.max(5, s.refresh) * 1000));
      }
    }
    this.version++;
  }

  async fetch(s) {
    const st = this.status[s.id] ??= {};
    st.state = 'loading';
    try {
      const r = await fetch(assetURL(s.url), { headers: s.headers || {}, cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (this.status[s.id] !== st) return; // the sources changed meanwhile
      const same = JSON.stringify(j) === JSON.stringify(this.values[s.id]);
      this.values[s.id] = j;
      Object.assign(st, { state: 'live', error: '', at: Date.now() });
      if (!same) this.version++;
    } catch (e) {
      // a CORS refusal surfaces as a bare TypeError ("Failed to fetch")
      Object.assign(st, { state: 'error', error: e instanceof TypeError ? 'blocked — offline, or the API doesn’t allow this site (CORS)' : e.message, at: Date.now() });
      this.version++;
    }
  }

  // "products.items[0].name" -> value (undefined if missing). `item…` = the current stretch item; inside
  // {{#each}} a scope holds the element: its fields, `this`, `@index`, `@number`.
  get(path, scope = null, item = this.item) {
    const parts = String(path).trim().match(/[^.[\]]+/g) ?? [];
    if (!parts.length) return undefined;
    let v = this.values;
    if (scope && parts[0][0] === '@') return scope[parts[0]];
    if (scope && parts[0] === 'this') { v = scope.value; parts.shift(); }
    else if (scope && scope.value && typeof scope.value === 'object' && parts[0] in scope.value) v = scope.value;
    else if (parts[0] === 'item') {
      if (!item) return undefined;
      parts.shift();
      if (parts.length === 1 && ['index', 'number', 'count'].includes(parts[0]) && !(item.value && typeof item.value === 'object' && parts[0] in item.value)) {
        return { index: item.k, number: item.k + 1, count: item.n }[parts[0]];
      }
      v = item.value;
    }
    for (const p of parts) {
      if (v == null || typeof v !== 'object') return undefined;
      v = v[p];
    }
    return v;
  }

  // replace every {{#each}} block and {{path | fallback}} in a string. opts: { html: escape values (HTML layers),
  // item: resolve against another stretch item than the current one }
  resolve(str, opts = {}) {
    if (typeof str !== 'string' || !str.includes('{{')) return str;
    const item = opts.item === undefined ? this.item : opts.item;
    const esc = opts.html ? (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) : (s) => s;
    const one = (s, scope) => s.replace(/\{\{\s*([^}|#/]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_, path, fb) => {
      const v = this.get(path, scope, item);
      if (v == null || v === '') return fb ?? '';
      return esc(typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
    const blocks = str.replace(/\{\{\s*#each\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\s*\/each\s*\}\}/g, (_, path, inner) => {
      const list = this.get(path, null, item);
      if (!Array.isArray(list)) return '';
      return list.map((value, i) => one(inner, { value, '@index': i, '@number': i + 1 })).join('');
    });
    return one(blocks, null);
  }
}

export const hasBinding = (s) => typeof s === 'string' && s.includes('{{');

// every list in the loaded data ("products.items", …), for the stretch / binding pickers
export function listPaths(data, max = 3) {
  const out = [];
  const walk = (v, path, depth) => {
    if (Array.isArray(v)) { out.push(path); return; }
    if (!v || typeof v !== 'object' || depth >= max) return;
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(data?.values ?? {}, '', 0);
  return out;
}
