# Testing

There's no test suite: verify in a real (headless) browser. **Don't pop up windows on the owner's screen.** Run ONE
persistent headless Chrome and reuse it. Headless WebGPU works on macOS (Metal) and Windows (D3D12).

```sh
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --enable-unsafe-webgpu \
  --remote-debugging-port=9333 --user-data-dir=<scratch>/chrome-profile --window-size=1600,900 about:blank
# Windows (Git Bash)
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --enable-unsafe-webgpu \
  --remote-debugging-port=9333 --user-data-dir=<scratch>/chrome-profile --window-size=1600,900 about:blank
python3 tools/serve.py 8123        # the dev server (needed for the editor endpoints and video ranges)
```

Install `puppeteer-core` in your scratch directory (`npm i puppeteer-core`; v19 works with Node 16, v23 with
Node 20).

## Skeleton

```js
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null });
const [page] = await browser.pages();
await page.setCacheEnabled(false);                       // otherwise stale ES modules are served
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:8123/play.html?project=demo/thai-union&noauto');   // or editor.html?project=…&noauto
await page.waitForFunction(() => window.__ocean && document.getElementById('loader').classList.contains('hidden'));
// WebGPU validation errors do NOT reach the console — catch them:
await page.evaluate(() => { window.__gpuErr = []; __ocean.renderer.backend.device.addEventListener('uncapturederror', (e) => __gpuErr.push(e.error.message)); });
await page.evaluate(() => { __ocean.story.forceP = 97 / 150; });   // story time 97 s
await new Promise((r) => setTimeout(r, 3000));                      // creatures / school settle
await page.screenshot({ path: 'shot.png' });
// … then ALWAYS: await page.goto('about:blank'); browser.disconnect();
```

`window.__ocean` exposes:
- `camera`, `controls`, `renderer`, `scene`;
- the systems: `tuna`, `reef`, `sharks`, `turtles`, `hump`, `blue`, `jellies`, `splash`;
- `story` (`forceP`, `x`, `cam`, `look`, `actors`, `schoolControl`), `timeline`, `layers`, `tentacles`;
- `opts`, `buildPost`, `director`;
- in `editor.html`, `editor`: `setTime(s)`, `setView('scene'|'game')`, `select(sel)`, `addKey()`, `lt` (layer tools),
  `assets`, `saves`, `play('site'|'auto')`, `stop()`, `undo()`, `reference()`, `contextItems(target)`, `perf`,
  `timeline` (the view: `rows`, `X(t)`, `T(x)`).

## Useful checks

- **Positions on the GPU:** `new Float32Array(await __ocean.renderer.getArrayBufferAsync(__ocean.tuna.pos.value))`
  (xyz + phase per fish). Sample every 100 ms to find teleports (speed spikes) or fish in the air.
- **Creature speeds through path transitions:** auto-play in the editor and sample
  `story.actors[bind].obj.position`.
- **fps:** median frame time over 120 rAF frames. **Warm up for about 7 s first**, and A/B in the same page
  (feature on / off / on). The designer's editor tab shares the GPU, so single numbers are noise.
- **Resize regression:** load at 1600×900, then `page.setViewport` to 2000×860. The frame must not go black.
- **Editor interaction:** drive it with real mouse / keyboard events (`page.mouse`, `page.keyboard`) on the timeline
  canvas (`#ed-tlwrap canvas`). Row positions come from `__ocean.editor.timeline.rows` / `.X(t)`. Simulate file
  drops with a `DataTransfer` + `DragEvent` dispatched on the target.

## Hygiene (important)

- **The editor autosaves into the project's story.json.** A test that edits a demo in the editor must undo everything
  (`while (ed.undoStack.length) ed.undo()`) and **navigate to `about:blank` before finishing**. Don't pipe test output
  through `head` / anything that can kill the script while a tab is open. Back up story.json in your scratch space
  before such tests, and `cmp` it afterwards.
- Delete only files your test created (`assets/<test>.svg`, checkpoints named "test …"). **Never delete
  `saves/auto/*`**: the designer's backups land there too.
- `localStorage.clear()` in the test tab (drafts, clipboard, panel sizes) — only in the headless profile.
- Test .tuna / data / build features in a **throwaway project**: `P.unpack(await P.pack(ed.current(), {name:'Test'}))`
  → load `editor.html?project=<slug>` (or `POST project/new?from=demo/thai-union`). Then the demo is never touched. Delete only the `projects/<slug>` you
  created. To capture downloads (`.tuna` / build zip), `delete window.showSaveFilePicker` (the download fallback)
  and use CDP `Page.setDownloadBehavior` into your scratch dir. Serve an unzipped build with
  `python -m http.server` on another port to check it.
- Restart the dev server after changing `tools/serve.py`. Test `serve.ps1` on another port (`-Port 8140`) with
  curl (use `-H "Content-Length: 0"` for empty POSTs: HTTP.sys rejects them otherwise).
- Before claiming a visual change works: screenshot the affected moments, and check zero console errors and zero
  `uncapturederror`s.
