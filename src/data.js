// Live data for the story: JSON from APIs / a CMS, bound into layers and captions with {{bindings}}.
//   story.json  "sources": [{ id: "products", url: "https://cms.example.com/api/products", headers?: {…},
//                             refresh?: seconds, sample?: <JSON> }]
//   any layer text / title / body / kicker / html / src and caption title / sub can say
//     {{products.items[0].name}}            (source id, then a path: .key and [index])
//     {{products.items[0].name | Coming soon}}   (text after | = fallback while loading / on error)
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

  // "products.items[0].name" -> value (undefined if missing)
  get(path) {
    const parts = String(path).trim().match(/[^.[\]]+/g) ?? [];
    let v = this.values;
    for (const p of parts) {
      if (v == null || typeof v !== 'object') return undefined;
      v = v[p];
    }
    return v;
  }

  // replace every {{path | fallback}} in a string
  resolve(str) {
    if (typeof str !== 'string' || !str.includes('{{')) return str;
    return str.replace(/\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_, path, fb) => {
      const v = this.get(path);
      if (v == null || v === '') return fb ?? '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
}

export const hasBinding = (s) => typeof s === 'string' && s.includes('{{');
