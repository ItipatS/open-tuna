# Gotchas (each of these cost real time)

## WebGPU / three r180
- **The viewport-texture resize bug** (patched at the top of `main.js`). A `viewportTexture` copy used inside a
  render target is a clone that *shares its image* with the original. After the canvas grows it never reallocates
  its GPU texture, so the copy goes out of bounds and **every frame is dropped (black screen)**. This happened after
  a resize or fullscreen, and constantly in the editor's viewport. The patch tracks each copy's size and sets
  `needsUpdate`. Keep it until three is upgraded and the resize test passes.
- WebGPU validation errors don't reach the console. Attach `device.addEventListener('uncapturederror', …)` when a
  frame goes black.
- Don't toggle `light.castShadow` at runtime (it throws `reading 'depthTexture'` every frame). Use
  `shadow.intensity` / `autoUpdate`.
- Refraction copy textures must be `HalfFloatType` (the scene target is rgba16float).
- Changing `material.transparent` (or anything structural) after first render recompiles the shader. Decide at
  build time; model layers set `transparent` once and only change `opacity`.
- TSL: `hash()` seeds need `uint(...)`; additive materials need `fog: false` plus manual attenuation; the ocean grid
  needs a `normal` attribute even though the shader computes normals.
- The HDR sun disk is about 40× the sky. Anything screen-space that samples it must clamp, or the frame whites out.
- Changing a `FramebufferTexture`'s image size with the same object is not reliable. Rebuild instead.

## Scene
- **Draw order:** the ocean (renderOrder 10) writes depth. Additive things that don't write depth (jellies, 11) must
  draw *after* it, or the surface erases them. The water 50 is 12–14, GPU layers 15–16, gizmos 60+.
- **Waterline:** the camera is kept out of a ±0.35 m band around the surface and pushed *through* it in the
  direction of travel (`camY0`). Pushing it back the way it came made the camera "stick".
- **Leaps:** never ease a leaping fish in from wherever it was schooling (that teleports it). Keep the run-up time
  independent of the moving origin, and commit each cycle at its start (see architecture.md).
- **Story paths:** creature AI / loops run *before* `story.update` each frame. On release, put the object back at
  the driven pose before re-anchoring its loop, or it snaps (this caused a 600 m/s jump once).
- **Creature orientation:** fix it with `CONFIG` flip / yaw in main.js, never in the swim shaders.

## Editor / data
- Use `tl.muted(t)` / `tl.lockedTrack(t)`. Groups and lanes pass their mute / lock down.
- A path track's `bind` is not unique (several paths can steer the same creature), so `tl.bound` excludes paths.
- The selection is held by object reference. Re-resolve it after undo (`selPath` / `resolve`).
- CSS `display: ''` falls back to the stylesheet. Use `'block'` when the stylesheet hides an element.
- A clicked button keeps focus and also reacts to Space (play): the editor blurs buttons after clicks.
- Clicking inside an iframe moves keyboard focus into it. Same-origin pages forward Esc back out (layers.js).
- In story mode the canvas has `pointer-events: none` (so the page scrolls); pointer listeners are on `window`.
- `main.js` has a `G` (loaded GLTFs): don't shadow it.

## Projects / build / previews
- Anything that loads a story file must go through `assetURL()` (src/project.js), or it breaks in `?project=` mode
  while working fine elsewhere (and in exports, where BASE is empty).
- The build finds runtime modules by following *relative* imports from `src/main.js`. Code that loads a module or a
  model some other way (computed paths) won't be in the build. Keep model names as quoted `*.glb` literals.
- Model previews render on the live renderer between frames. Change renderer state (target, clear colour) only
  around one synchronous `render()`, never across an `await`, or the main loop renders into the wrong target. The
  readback row (`S × 8` bytes for half floats) must be a multiple of 256: keep `S` a multiple of 32.
- File System Access handles only live in IndexedDB (not localStorage). Writing needs `requestPermission` from a
  user gesture (Ctrl+S counts).

- `editor.html` and `play.html` are the same shell; `play.html` is also the template of every export. Change both.

## Tooling
- Plain `python -m http.server` refuses connections under the page's parallel module + GLB burst (backlog 5) and has
  no Range support (videos can't seek). Use `tools/serve.py`.
- On Windows, long Python / shell heredocs with quotes break in Git Bash. Write patch scripts to a file and run
  them.
- `*.json` is `eol=lf`. Git's CRLF conversion would change the bytes the save-conflict hash checks.
