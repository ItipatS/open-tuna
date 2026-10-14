// The browser studio: a service worker that stands in for tools/serve.py when the tool is hosted as plain files (a web
// host, a bucket, GitHub Pages). It answers the same /__editor/* API and serves projects/<slug>/… from IndexedDB, so the
// editor, the player and Build site work unchanged. Projects and their media live in this browser; the .tuna file
// (Ctrl+S) is the real file to keep and share. Registered by src/backend.js only when no studio server answers.
// With a real studio server on the same address it steps aside (everything goes to the network).
// Not supported here: git, live team editing. Demos (demos/<id>/) are read from the host, read-only.
const DB = 'open-tuna-studio';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UPLOAD_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'mp4', 'webm', 'mov', 'm4v', 'html', 'htm', 'mp3', 'ogg', 'wav', 'json', 'glb', 'gltf']);
const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg',
  ogg: 'audio/ogg', wav: 'audio/wav', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
};
const KEEP_AUTO = 30;
const ASSET_RE = /assets\/[^"'\s)\\<>`]+/g;
const REF_RE = /(?:src|href|poster)\s*=\s*["']([^"'#]+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/g;

const base = new URL(self.registration.scope).pathname; // e.g. /my-dir/
const ext = (p) => (p.split('?')[0].split('.').pop() || '').toLowerCase();
const typeOf = (p) => TYPES[ext(p)] || 'application/octet-stream';
const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';
const resolve = (from, rel) => new URL(rel, `http://x/${from}`).pathname.slice(1);

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------------------------
// IndexedDB: files { k: "<slug>/<path>", slug, path, blob, mtime }, projects { slug, name, mtime }
// ---------------------------------------------------------------------------------------------
let dbp = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('files', { keyPath: 'k' });
      r.result.createObjectStore('projects', { keyPath: 'slug' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), st = t.objectStore(store);
    let out;
    Promise.resolve(fn(st)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const getFile = (slug, path) => tx('files', 'readonly', (st) => req(st.get(`${slug}/${path}`)));
const putFile = (slug, path, blob) => tx('files', 'readwrite', (st) => { st.put({ k: `${slug}/${path}`, slug, path, blob, mtime: Date.now() }); });
const delFile = (slug, path) => tx('files', 'readwrite', (st) => { st.delete(`${slug}/${path}`); });
const listFiles = (slug, prefix = '') => tx('files', 'readonly', (st) => req(st.getAll(IDBKeyRange.bound(`${slug}/${prefix}`, `${slug}/${prefix}￿`))));
const getProject = (slug) => tx('projects', 'readonly', (st) => req(st.get(slug)));
const putProject = (p) => tx('projects', 'readwrite', (st) => { st.put(p); });
const allProjects = () => tx('projects', 'readonly', (st) => req(st.getAll()));
const touch = async (slug) => { const p = await getProject(slug); if (p) await putProject({ ...p, mtime: Date.now() }); };

// ---------------------------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------------------------
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (msg, status = 400) => json({ ok: false, error: msg }, status);

// a stored file, with byte ranges (video seeking needs 206)
function serveBlob(blob, path, request) {
  const type = typeOf(path), size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') || '');
  if (m) {
    let a = m[1] ? +m[1] : Math.max(0, size - +(m[2] || 0)), b = m[1] && m[2] ? +m[2] : size - 1;
    b = Math.min(b, size - 1);
    if (a > b) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(blob.slice(a, b + 1), { status: 206, headers: { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': String(b - a + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' } });
  }
  return new Response(blob, { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------------------------
// "demo/<id>" (read-only, from the host) or "<slug>" (this browser)
function proj(id) {
  if (!id) throw new Error('no project: open one from the studio home');
  if (id.startsWith('demo/')) {
    const name = id.slice(5);
    if (!SLUG.test(name)) throw new Error('bad project name');
    return { id, demo: true, root: `demos/${name}/` };
  }
  if (!SLUG.test(id)) throw new Error('bad project name');
  return { id, demo: false };
}
const net = (path) => fetch(new URL(path, self.registration.scope), { cache: 'no-store' });
async function readText(P, path) {
  if (P.demo) { const r = await net(P.root + path); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.text(); }
  const f = await getFile(P.id, path);
  if (!f) throw new Error(`${path}: not found`);
  return f.blob.text();
}
const readOnly = (P) => { if (P.demo) throw new Error('Demos can’t be changed on this host — start a project from it (Studio home ▸ ⋯ ▸ New project from this demo)'); };

// where a .tuna's files may be written (same rule as serve.py)
function putable(path) {
  const p = path.replace(/\\/g, '/');
  if (p.split('/').some((s) => s === '..' || s === '')) throw new Error('bad path');
  if (['story.json', 'manifest.json', 'thumb.webp', 'thumb.png', 'thumb.jpg'].includes(p)) return p;
  if (p.startsWith('assets/') && UPLOAD_EXT.has(ext(p))) return p;
  if (/^saves\/checkpoints\/[^/]+\.json$/.test(p)) return p;
  throw new Error(`${path} can't be part of a project`);
}

function listing(files) {
  return files.filter((f) => f.path.endsWith('.json')).sort((a, b) => (a.path < b.path ? 1 : -1)).map((f) => {
    const name = f.path.split('/').pop();
    const m = /^(\d{4}-\d\d-\d\d)_(\d\d)(\d\d)(\d\d)_?(.*)\.json$/.exec(name);
    return { file: f.path, name: (m && m[5] ? m[5].replace(/-/g, ' ') : '') || name.slice(0, -5), time: m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : '', size: f.blob.size };
  });
}

async function builtinModels() {
  try { return (await (await net('models/index.json')).json()).models.map((m) => ({ ...m, mtime: 0, builtin: true })); } catch { return []; }
}

// a demo's files: its story, manifest, preview, and every asset the story (or its .html / .svg / .css pages) uses
async function demoFiles(P) {
  const out = new Map();
  const add = async (path) => { const r = await net(P.root + path); if (r.ok) out.set(path, await r.blob()); };
  await add('story.json');
  await add('manifest.json');
  for (const t of ['thumb.webp', 'thumb.png', 'thumb.jpg']) await add(t);
  const story = out.get('story.json') ? await out.get('story.json').text() : '';
  const assets = new Set(story.match(ASSET_RE) ?? []);
  const pages = [...assets].filter((a) => /\.(html?|svg|css)$/i.test(a));
  for (let i = 0; i < pages.length; i++) {
    let txt = '';
    try { const r = await net(P.root + pages[i]); if (!r.ok) continue; txt = await r.text(); } catch { continue; }
    for (const m of txt.matchAll(REF_RE)) {
      const ref = (m[1] || m[2] || '').trim();
      if (!ref || /^([a-z]+:|\/\/|#|\/)/i.test(ref)) continue;
      const p = resolve(pages[i], ref.split('?')[0]);
      if (p.startsWith('assets/') && !assets.has(p)) { assets.add(p); if (/\.(html?|svg|css)$/i.test(p)) pages.push(p); }
    }
  }
  for (const a of assets) await add(a);
  return out;
}

// the first free name for a file (an identical file is reused)
async function place(slug, dir, stem, extn, blob) {
  let n = 1, path = `${dir}/${stem}.${extn}`;
  for (;;) {
    const f = await getFile(slug, path);
    if (!f) { await putFile(slug, path, blob); return path; }
    if (f.blob.size === blob.size && fnv1a(new Uint8Array(await f.blob.arrayBuffer())) === fnv1a(new Uint8Array(await blob.arrayBuffer()))) return path;
    n++;
    path = `${dir}/${stem}-${n}.${extn}`;
  }
}

// ---------------------------------------------------------------------------------------------
// the API
// ---------------------------------------------------------------------------------------------
async function api(op, q, request) {
  const body = () => request.blob();
  if (op === 'ping') return json({ ok: true, save: true, git: false, branch: '', local: true });
  if (op === 'projects') {
    const list = (await allProjects()).sort((a, b) => b.mtime - a.mtime).map((p) => ({ project: p.slug, name: p.name, mtime: Math.floor(p.mtime / 1000), thumb: p.thumb ? `projects/${p.slug}/${p.thumb}` : '' }));
    let demos = [];
    try { demos = (await (await net('demos/index.json')).json()).demos.map((d) => ({ project: d.project, name: d.name, mtime: 0, thumb: d.thumb || '' })); } catch { /* no list */ }
    return json({ projects: list, demos, local: true });
  }
  if (op === 'project/new') {
    if (request.method !== 'POST') return fail('POST only', 405);
    const base0 = slugify(q.get('name'));
    let slug = base0, n = 1;
    while (await getProject(slug)) { n++; slug = `${base0}-${n}`; }
    const from = q.get('from');
    let thumb = '';
    if (from) {
      const src = proj(from);
      if (!src.demo) return fail('only demos can be copied this way (open the .tuna instead)');
      for (const [p, b] of await demoFiles(src)) { if (p.startsWith('thumb.')) thumb = p; if (p !== 'manifest.json') await putFile(slug, p, b); }
      await putFile(slug, 'manifest.json', new Blob([JSON.stringify({ format: 'open-tuna', version: 1, name: q.get('name') || slug, created: new Date().toISOString() }, null, 2)], { type: 'application/json' }));
    }
    await putProject({ slug, name: q.get('name') || slug, mtime: Date.now(), thumb });
    return json({ ok: true, project: slug });
  }

  const P = proj(q.get('project') || '');
  const ro = () => readOnly(P);
  switch (op) {
    case 'list': {
      if (P.demo) return json({ checkpoints: [], autos: [], git: [] });
      return json({ checkpoints: listing(await listFiles(P.id, 'saves/checkpoints/')), autos: listing(await listFiles(P.id, 'saves/auto/')), git: [] });
    }
    case 'load': {
      if (q.get('git')) return fail('git history needs the studio server');
      const file = q.get('file') || 'story.json';
      if (file !== 'story.json' && !/^saves\/.+\.json$/.test(file)) return fail('file not allowed');
      return new Response(await readText(P, file), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    case 'save': {
      ro();
      const text = await (await body()).text();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.tracks)) return fail('not a story.json (no "tracks" list)');
      const old = await getFile(P.id, 'story.json');
      if (old) {
        const oldBytes = new Uint8Array(await old.blob.arrayBuffer());
        const baseHash = request.headers.get('X-Base-Hash');
        if (request.headers.get('X-Force') !== '1' && baseHash !== fnv1a(oldBytes)) {
          return json({ ok: false, conflict: true, error: baseHash ? 'story.json changed since the editor loaded it (another tab?)' : 'this editor tab is out of date - reload it', current: new TextDecoder().decode(oldBytes) }, 409);
        }
        if (await old.blob.text() !== text) {
          await putFile(P.id, `saves/auto/${stamp()}.json`, old.blob);
          const autos = listing(await listFiles(P.id, 'saves/auto/'));
          for (const f of autos.slice(KEEP_AUTO)) await delFile(P.id, f.file);
        }
      }
      await putFile(P.id, 'story.json', new Blob([text], { type: 'application/json' }));
      await touch(P.id);
      return json({ ok: true });
    }
    case 'checkpoint': {
      ro();
      const text = await (await body()).text();
      JSON.parse(text);
      const name = (q.get('name') || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'checkpoint';
      const path = `saves/checkpoints/${stamp()}_${name}.json`;
      await putFile(P.id, path, new Blob([text], { type: 'application/json' }));
      return json({ ok: true, file: path });
    }
    case 'delete': {
      ro();
      const f = q.get('file') || '';
      if (!/^saves\/checkpoints\/[^/]+\.json$/.test(f)) return fail('only checkpoints can be deleted');
      await delFile(P.id, f);
      return json({ ok: true });
    }
    case 'put': {
      ro();
      const path = putable(q.get('file') || '');
      const blob = await body();
      if (path === 'story.json') { const d = JSON.parse(await blob.text()); if (!Array.isArray(d?.tracks)) return fail('not a story.json'); }
      await putFile(P.id, path, blob);
      if (/^thumb\./.test(path)) { const p = await getProject(P.id); if (p) await putProject({ ...p, thumb: path, mtime: Date.now() }); }
      return json({ ok: true, file: path });
    }
    case 'upload': {
      ro();
      const name = (q.get('name') || 'file').split(/[\\/]/).pop();
      const e = ext(name);
      if (!UPLOAD_EXT.has(e)) return fail(`.${e} files are not allowed`);
      const stem = name.slice(0, name.length - e.length - 1).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'file';
      let dir = 'assets';
      if (q.get('dir')) {
        dir = q.get('dir').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!(dir === 'assets' || dir.startsWith('assets/')) || dir.split('/').some((s) => s === '..' || s === '')) return fail('dir must be inside assets/');
      }
      const path = await place(P.id, dir, stem, e, await body());
      await touch(P.id);
      return json({ ok: true, file: path });
    }
    case 'asset-import': {
      ro();
      const file = q.get('file') || '';
      if (!file.startsWith('assets/') || file.includes('..')) return fail('not an asset path');
      const src = proj(q.get('from') || '');
      let blob;
      if (src.demo) { const r = await net(src.root + file); if (!r.ok) return fail(`${file} is not a file of ${src.id}`); blob = await r.blob(); } else { const f = await getFile(src.id, file); if (!f) return fail(`${file} is not a file of ${src.id}`); blob = f.blob; }
      const dir = file.slice(0, file.lastIndexOf('/')), name = file.slice(file.lastIndexOf('/') + 1), e = ext(name);
      return json({ ok: true, file: await place(P.id, dir, name.slice(0, name.length - e.length - 1), e, blob) });
    }
    case 'assets': {
      const own = P.demo ? [...(await demoFiles(P))].filter(([p]) => p.startsWith('assets/')).map(([p, b]) => ({ file: p, size: b.size, mtime: 0 }))
        : (await listFiles(P.id, 'assets/')).map((f) => ({ file: f.path, size: f.blob.size, mtime: Math.floor(f.mtime / 1000) }));
      own.sort((a, b) => b.mtime - a.mtime);
      return json({ assets: [...own, ...(await builtinModels())] });
    }
    case 'asset-delete': {
      ro();
      const f = q.get('file') || '';
      if (!f.startsWith('assets/') || !(await getFile(P.id, f))) return fail('not a file in assets/');
      await delFile(P.id, f);
      return json({ ok: true });
    }
    case 'files': {
      if (P.demo) return json({ files: [...(await demoFiles(P))].filter(([p]) => p === 'story.json' || p.startsWith('assets/')).map(([p, b]) => ({ file: p, size: b.size, mtime: 0 })) });
      const all = await listFiles(P.id);
      const keep = all.filter((f) => f.path === 'story.json' || f.path.startsWith('assets/') || f.path.startsWith('saves/checkpoints/'));
      return json({ files: keep.map((f) => ({ file: f.path, size: f.blob.size, mtime: Math.floor(f.mtime / 1000) })) });
    }
    default:
      if (op.startsWith('git/')) return op === 'git/status' ? json({ git: false }) : fail('git needs the studio server');
      if (op.startsWith('sync/') || op.startsWith('library')) return fail('needs the studio server', 404);
      return fail('unknown endpoint', 404);
  }
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------
// a real studio server on this address? then stay out of the way
let real = null;
const realServer = () => (real ??= fetch(new URL('__editor/ping', self.registration.scope), { cache: 'no-store' })
  .then(async (r) => r.ok && /json/.test(r.headers.get('content-type') || '') && !(await r.json()).local)
  .catch(() => false));

async function handle(event) {
  const { request } = event, url = new URL(request.url);
  if (await realServer()) return fetch(request);
  const rel = decodeURIComponent(url.pathname.slice(base.length));
  try {
    if (rel.startsWith('__editor/')) return await api(rel.slice(9), url.searchParams, request);
    // projects/<slug>/<file>: a project's own files
    const m = /^projects\/([a-z0-9][a-z0-9-]{0,62})\/(.+)$/.exec(rel);
    const f = m && await getFile(m[1], m[2]);
    if (!f) return new Response('Not found', { status: 404 });
    return serveBlob(f.blob, m[2], request);
  } catch (e) {
    return fail(e.message || String(e));
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(base)) return;
  const rel = url.pathname.slice(base.length);
  if (!rel.startsWith('__editor/') && !rel.startsWith('projects/')) return; // everything else: the host, as usual
  event.respondWith(handle(event));
});
