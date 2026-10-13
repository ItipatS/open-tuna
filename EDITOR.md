# Open Tuna editor — quick guide

The editor lets you change **when** things happen in the story (camera moves, captions, sun, the
water 50, tuna leaps) and see the result immediately, like Unity's Timeline. Everything you edit is
saved in one file: **`story.json`**.

## Open it

1. Get the project: `git clone https://github.com/ItipatS/open-tuna` (or pull the latest).
2. Double-click the launcher in the project folder:
   - **Windows:** `Open Editor.bat`
   - **Mac:** `Open Editor.command` (first time: right-click → Open, to get past Gatekeeper)
3. Chrome or Edge opens at `http://localhost:8123/?edit`. Keep the black server window open while
   you work; closing it stops the editor.

The Mac launcher needs Python 3 (`xcode-select --install`). On Windows it uses Python if it's
installed, otherwise a built-in PowerShell server, so there's nothing to install.

## The screen

| Area | What it is |
|---|---|
| **Top bar** | ⏮ start · ▶ Play / ⏸ Pause · ⏹ Stop (goes back to where Play began) · current position · sim speed · undo / redo · **Copy ref** · snapshot · **Open site** · **Save** |
| **Scene** (left) | Every part of the world. Click the eye to hide something while you work; this isn't saved. |
| **Viewport** (middle) | **Game** tab = exactly what a visitor sees (choose 16:9, 21:9, phone…). **Scene** tab = a free camera with the camera path drawn in. |
| **Inspector** (right) | Settings of whatever you selected. With nothing selected, it shows the project and scene settings. |
| **Timeline** (bottom) | The whole story from **0** (top of the page) to **1** (bottom). The orange line is the playhead. |

## Timeline basics

- **Scrub:** drag in the ruler. Chapters are the coloured bands at the top.
- **Zoom:** Ctrl + mouse wheel (or pinch). **Pan:** Shift + wheel. **F** fits the whole story.
- **Keys** (diamonds): drag to change *when*; select one to edit its values in the Inspector.
- **Clips** (bars): drag the middle to move them, drag an end to change start / end.
- **Snap** is on by default (to keys, chapters, the playhead). Hold **Shift** while dragging to turn it off.
- **Double-click** a lane to add a key there (or a caption, on the Captions lane).
- The bottom lane, **Performance**, fills in as you play: green ≥ 55 fps, yellow ≥ 40, red below.
  Red patches show where the story will stutter on slower laptops.

## Common jobs

**Change a camera shot.** Go to the **Scene** tab (press **1**). Fly with the mouse (drag = orbit,
right-drag = pan, wheel = zoom) or WASD + Q/E (hold Shift for fast). When the framing looks right, move
the playhead to the moment and press **K**. That adds a camera key from your view. To fine-tune an
existing key, click its blue ball and drag the arrows. "Gizmo moves" in the Inspector switches to
the orange *look-at* ball.

**Edit captions.** Click a purple caption bar. Type the text in the Inspector (line breaks are kept)
and set its size and height. Drag the bar to time it. Use **+ Caption** to add one at the playhead.

**Animate the sun / exposure / bloom / sea…** Use **+ Track…** and pick the parameter. Then add keys (K)
at the moments you want and set each key's value.

**Leave feedback.** Press **+ Note** at the moment something should change ("tentacle pops in here,
should grow smoothly"). Notes are saved in `story.json`, so a developer or Claude can read them.

**Ask Claude for a change.** Go to the moment, click **Copy ref**, paste it into Claude, and say what you
want. The reference says exactly where you are (position, chapter, which beats are active, camera keys,
caption on screen, fps), so Claude knows which part of the code or which keys to edit.

## Saving and sharing

- **Ctrl+S** (or Save) writes `story.json`. The Save button shows an orange dot when there are unsaved changes.
  If the browser closes, your unsaved work comes back as a draft the next time you open the editor.
- Undo / redo: **Ctrl+Z / Ctrl+Y**.
- To share your changes, commit and push `story.json` with git. Pushing to `main` updates the
  **public** site, so use a branch if it isn't ready.
- **Open site** opens the real scrolling page at the current moment, in a new tab.

## Shortcuts

`Space` play/pause · `Esc` stop / deselect · `← →` step (Shift ×10) · `Home / End` · `, .` previous / next key ·
`K` add key · `Del` delete · `Ctrl D` duplicate · `Ctrl Z / Y` undo / redo · `Ctrl S` save ·
`1 / 2` Scene / Game · `F` fit timeline

## What the editor doesn't do (yet)

It edits the story's **timing, camera, captions and parameters**. It can't add new 3D models, or change
how the water 50, fish or ocean *look* or behave. Those are code changes: leave a note and ask a developer
or Claude.
