// File ▸ Build site: a standalone copy of the story for any static host (Netlify drop, S3, GitHub Pages, a CDN…):
// no editor, no lab, no dev server. The build holds
//   index.html          play.html (the player shell), marked window.OPEN_TUNA_BUILD (main.js then ignores ?lab / ?project)
//   src/**              the runtime modules, found by following imports from src/main.js (src/editor/ left out), and the
//                       stylesheets the shell links (src/page.css)
//   models/*.glb        the scene's models (quoted *.glb names in the runtime) + built-in models used by model clips
//   story.json          the story as it is now in the editor (unsaved changes included), with its data samples
//   assets/**           the files the story uses (also files referenced from its .html pages)
//   .nojekyll, README.txt
// three.js and the fonts still come from their CDNs (the import map in index.html), so visitors need internet.
import { zipSync, strToU8 } from 'fflate';
import { h, download } from './dom.js';
import { dialog } from './menu.js';
import { BASE } from '../project.js';

const STORED = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'mp4', 'webm', 'mov', 'm4v', 'mp3', 'ogg', 'glb']);
const mb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|import\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const GLB_RE = /['"`]\.?\/?((?:models\/)?[\w.-]+\.(?:glb|gltf))['"`]/g;
const ASSET_RE = /assets\/[^"'\s)\\<>`]+/g;
const REF_RE = /(?:src|href|poster)\s*=\s*["']([^"'#]+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/g;
const resolve = (from, rel) => new URL(rel, `http://x/${from}`).pathname.slice(1);
const slug = (s) => String(s || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';

async function bytes(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export class SiteBuilder {
  constructor(ed) { this.ed = ed; }

  // -> { files: Map(path -> Uint8Array), notes: [string] }
  async collect(progress = () => {}) {
    const ed = this.ed, files = new Map(), notes = [];
    const dec = new TextDecoder();
    const story = ed.current();
    const data = JSON.parse(story);

    // runtime modules + the models they load
    const models = new Set(), todo = ['src/main.js'];
    while (todo.length) {
      const p = todo.pop();
      if (files.has(p)) continue;
      progress(`Code: ${p}`);
      const b = await bytes(`./${p}`);
      files.set(p, b);
      const txt = dec.decode(b);
      for (const m of txt.matchAll(IMPORT_RE)) {
        const dep = resolve(p, m[1] || m[2] || m[3]);
        if (!dep.startsWith('src/editor/')) todo.push(dep);
      }
      for (const m of txt.matchAll(GLB_RE)) models.add(m[1].includes('/') ? m[1] : `models/${m[1]}`);
    }

    // the story's files: assets/ paths anywhere in it, built-in models used by model clips
    const assets = new Set(story.match(ASSET_RE) ?? []);
    for (const t of data.tracks) if (t.type === 'layer' && t.src && !/^(assets\/|https?:|data:)/.test(t.src) && /\.(glb|gltf)$/i.test(t.src)) models.add(t.src.replace(/^\.\//, ''));
    // …and what its .html / .svg / .css pages reference (relative to the page)
    const pages = [...assets].filter((a) => /\.(html?|svg|css)$/i.test(a));
    for (let i = 0; i < pages.length; i++) {
      let txt = '';
      try { txt = dec.decode(await bytes(`./${BASE}${pages[i]}`)); } catch { continue; }
      for (const m of txt.matchAll(REF_RE)) {
        const ref = (m[1] || m[2] || '').trim();
        if (!ref || /^([a-z]+:|\/\/|#|\/)/i.test(ref)) continue;
        const p = resolve(pages[i], ref.split('?')[0]);
        if (p.startsWith('assets/') && !assets.has(p)) { assets.add(p); if (/\.(html?|svg|css)$/i.test(p)) pages.push(p); }
      }
    }
    for (const a of [...assets].sort()) {
      progress(`Media: ${a}`);
      try { files.set(a, await bytes(`./${BASE}${a}`)); } catch { notes.push(`Missing file: ${a} (used by the story, not found — it will not show)`); }
    }
    for (const m of [...models].sort()) {
      progress(`Model: ${m}`);
      try { files.set(m, await bytes(`./${m}`)); } catch { notes.push(`Missing model: ${m}`); }
    }

    // the page: build flag, the story's title
    progress('Page');
    let html = dec.decode(await bytes('./play.html'));
    for (const m of html.matchAll(/<link[^>]+href="\.?\/?(src\/[^"]+\.css)"/g)) files.set(m[1], await bytes(`./${m[1]}`));
    const title = (data.meta?.title || 'Open Tuna').replace(/[<&]/g, '');
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace(/<!--[^]*?-->\n/, '')
      .replace('<script type="importmap">', '<script>window.OPEN_TUNA_BUILD = true;</script>\n<script type="importmap">');
    files.set('index.html', strToU8(html));
    files.set('story.json', strToU8(story));
    files.set('.nojekyll', new Uint8Array(0));
    files.set('README.txt', strToU8([
      `${title} — built with the Open Tuna editor on ${new Date().toLocaleString()}.`,
      '',
      'Upload this whole folder to any static web host (Netlify, Vercel, S3 / CloudFront, GitHub Pages, your own server).',
      '- It must be served over HTTPS (WebGPU only runs on secure pages; http://localhost works for testing).',
      '- Visitors need Chrome / Edge / a browser with WebGPU, and internet (three.js and fonts load from CDNs).',
      '- Open it from a web server, not by double-clicking index.html (file:// can\'t load the models).',
      '- Test locally: python3 -m http.server 8080   then open http://localhost:8080',
      '',
    ].join('\n')));

    for (const s of data.sources ?? []) {
      if (s.url && /^https?:/.test(s.url)) notes.push(`Data “${s.id}” loads live from ${new URL(s.url).host} — that API must allow requests from the site’s domain (CORS).`);
      if (s.sample === undefined && /^https?:/.test(s.url || '')) notes.push(`Data “${s.id}” has no saved sample: if the API is down, its bindings show their fallback text.`);
      if (s.headers) notes.push(`Data “${s.id}” sends headers — they are public in the built site.`);
    }
    const external = new Set((story.match(/https?:\/\/[^"'\s)\\]+/g) ?? []).filter((u) => !(data.sources ?? []).some((s) => s.url === u)).map((u) => new URL(u).host));
    if (external.size) notes.push(`Loads from other sites: ${[...external].join(', ')} (not copied into the build).`);
    return { files, notes };
  }

  async dialog() {
    const ed = this.ed;
    const body = h('div', { class: 'ed-build' }, h('p', { class: 'muted' }, 'Collecting files…'));
    const d = dialog({ title: 'Build site', body, wide: true, buttons: [{ label: 'Close' }] });
    let res;
    try { res = await this.collect((t) => { body.firstChild.textContent = t; }); } catch (e) { body.replaceChildren(h('p', { class: 'warn' }, `Couldn’t collect the files: ${e.message}`)); return; }
    const { files, notes } = res;
    const total = [...files.values()].reduce((n, b) => n + b.length, 0);
    const groups = { Code: [], Models: [], Media: [], Page: [] };
    for (const [p, b] of files) (p.startsWith('src/') ? groups.Code : /\.(glb|gltf)$/i.test(p) && !p.startsWith('assets/') ? groups.Models : p.startsWith('assets/') ? groups.Media : groups.Page).push([p, b.length]);
    const name = `${slug(ed.tl.meta.title)}-site`;
    const zip = async () => {
      const out = {};
      for (const [p, b] of files) out[p] = [b, { level: STORED.has(p.split('.').pop().toLowerCase()) ? 0 : 6 }];
      const z = zipSync(out);
      if (window.showSaveFilePicker) {
        try {
          const fh = await window.showSaveFilePicker({ suggestedName: `${name}.zip`, types: [{ description: 'Zip', accept: { 'application/zip': ['.zip'] } }] });
          const w = await fh.createWritable();
          await w.write(z);
          await w.close();
          ed.toast(`Built ${fh.name} · ${mb(z.length)}`);
          return true;
        } catch (e) { if (e.name === 'AbortError') return false; }
      }
      download(`${name}.zip`, new Blob([z], { type: 'application/zip' }));
      ed.toast(`Downloaded ${name}.zip · ${mb(z.length)}`);
      return true;
    };
    const folder = async () => {
      let dir;
      try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'open-tuna-build' }); } catch (e) { if (e.name === 'AbortError') return false; throw e; }
      let n = 0;
      for (const [p, b] of files) {
        const parts = p.split('/');
        let dh = dir;
        for (const part of parts.slice(0, -1)) dh = await dh.getDirectoryHandle(part, { create: true });
        const w = await (await dh.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(b);
        await w.close();
        n++;
      }
      ed.toast(`Built ${n} files into “${dir.name}”`);
      return true;
    };
    const chk = await ed.checker.summary().catch(() => null);
    body.replaceChildren(
      chk && (chk.errors || chk.warns) ? h('p', { class: chk.errors ? 'warn' : 'muted' }, `Project check: ${chk.errors} problem${chk.errors === 1 ? '' : 's'}, ${chk.warns} warning${chk.warns === 1 ? '' : 's'} `,
        h('button', { class: 'ed-btn', onclick: () => { d.close(); ed.checker.dialog(); } }, 'Show them')) : null,
      h('p', {}, `${files.size} files · ${mb(total)} — the story as it is now (unsaved changes included). Upload the folder (or the unzipped zip) to any static host over HTTPS.`),
      notes.length ? h('ul', { class: 'notes' }, notes.map((n) => h('li', {}, n))) : null,
      h('div', { class: 'groups' }, Object.entries(groups).filter(([, l]) => l.length).map(([g, l]) => h('details', {},
        h('summary', {}, `${g} · ${l.length} file(s) · ${mb(l.reduce((n, [, s]) => n + s, 0))}`),
        h('div', { class: 'fl' }, l.sort().map(([p, s]) => h('div', {}, h('span', {}, p), h('small', {}, mb(s)))))))),
      h('div', { class: 'acts' },
        h('button', { class: 'ed-btn primary', onclick: async () => { if (await zip()) d.close(); } }, 'Download .zip'),
        window.showDirectoryPicker ? h('button', { class: 'ed-btn', onclick: async () => { try { if (await folder()) d.close(); } catch (e) { ed.toast(`Couldn’t write the folder: ${e.message}`, true); } } }, 'Build into a folder…') : null),
    );
  }
}
