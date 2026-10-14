// Where the studio's /__editor/* API comes from. With tools/serve.py (the launchers, a team server) it's that server.
// Hosted as plain files (a web host, a bucket, GitHub Pages) there's no server, so the browser studio (../sw.js, a
// service worker) answers instead: projects and their media live in this browser, Save writes the .tuna file.
// Every page awaits `backendReady` before its first request. Built sites (File ▸ Build site) never use it.
//   'server'   tools/serve.py
//   'browser'  the service worker
//   'none'     no API (a built site, a browser without service workers, or file://)
async function detect() {
  if (window.OPEN_TUNA_BUILD || !('serviceWorker' in navigator) || !isSecureContext) return 'none';
  try {
    const r = await fetch('./__editor/ping', { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json') && !(await r.json()).local) {
      // a real server: an old browser-studio worker must not stand in its way
      for (const reg of await navigator.serviceWorker.getRegistrations()) if (reg.active?.scriptURL.endsWith('/sw.js')) await reg.unregister();
      return 'server';
    }
  } catch { /* nothing answered */ }
  try {
    await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 3000); });
    }
    if (!navigator.serviceWorker.controller) return 'none';
    navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict the projects
    return 'browser';
  } catch (e) {
    console.warn('Browser studio unavailable:', e);
    return 'none';
  }
}

export const backendReady = detect();
