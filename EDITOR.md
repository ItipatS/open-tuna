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
| **Top bar** | File / Edit / View / Help menus · ⏮ ▶ ⏹ and play speed · the big **SCENE / GAME** switch · time · save status · Copy ref · Save |
| **Scene** (left) | Every part of the world. Click the eye to hide something while you work (not saved). Right-click for *Show only this* / *Show all*. |
| **Viewport** (middle) | The coloured frame tells you where you are: **blue = SCENE** (free camera, for placing camera keys), **green = GAME** (exactly what a visitor sees), **orange = PLAYING**. Press **1** / **2** to switch. |
| **Inspector** (right) | Settings of whatever you selected. With nothing selected, it shows the project and scene settings. |
| **Timeline** (bottom) | The whole story in real time (m:ss). The orange line is the playhead; the pink **END** flag is the end of the story. |

## Time and story length

The story has a real length (it starts at 1:00). Make it as long as you need: an hour is fine.
- Drag the pink **END** flag on the ruler, or
- Right-click the ruler ▸ **Make the story longer**, or
- Click **Length** in the timeline bar (or Edit ▸ Story length…) and type `5:00` or `1:00:00`.

Keys keep their times when the length changes. Things that ran "until the end" keep running to the new end.
On the website, scrolling the whole page plays the whole story. Set *Scroll vh / s* in the Project
inspector to make scrolling faster or slower.

## Timeline basics

- **Scrub:** drag in the ruler. Chapters are the coloured bands at the top.
- **Zoom:** Ctrl + mouse wheel (or pinch). **Pan:** Shift + wheel. **F** fits the whole story.
- **Keys** (diamonds): drag to change *when*; select one to edit its values in the Inspector.
- **Clips** (bars): drag the middle to move them, drag an end to change start / end.
- **Snap** is on by default (to keys, chapters, the playhead). Hold **Shift** while dragging to turn it off.
- **Double-click** a lane to add a key there (or a caption, on the Captions lane).
- The bottom lane, **Performance**, fills in as you play: green ≥ 55 fps, yellow ≥ 40, red below.
  Red patches show where the story will stutter on slower laptops.

## Right-click menus

Right-click works on **anything**: keys, captions, clip bars, track names, empty lanes, the ruler,
chapters, notes, objects in the Scene list, and the camera balls in the Scene view. You get the options
that fit, for example:
- **Cut / Copy / Paste / Duplicate.** Paste and Duplicate drop the copy at the playhead.
- **Lock / Unlock** and **Delete**.
- On captions and clip bars: **Set start / end to playhead**, **Split at playhead**, change the ease.
- On track names: **Mute**, **Lock track**, **Move up / down**, **Rename**.

## Locking

Lock things you're happy with so nobody drags them by accident. Use right-click ▸ **Lock**, press **L**,
or click the small padlock next to a track's name to lock the whole track. Locked items show a padlock
and an orange outline. They can't be moved, edited or deleted until you unlock them. Locks are saved
in `story.json`, so they apply to everyone.

## Common jobs

**Change a camera shot.** Go to the **Scene** view (press **1**). Fly with the mouse (drag = orbit,
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
want. The reference says exactly where you are (time, chapter, which beats are active, camera keys,
caption on screen, fps), so Claude knows which part of the code or which keys to edit.

## Saving: you can't really lose work

| What | How |
|---|---|
| **Save** | **Ctrl+S** (or Save). Writes `story.json`. The top bar says *Saved 3:15 PM* or *Unsaved changes*. |
| **Autosave** | On by default (every minute, after you stop editing for 2 s). Change it in File ▸ Autosave. |
| **Previous versions** | Every save keeps the version it replaced (last 100) in `saves/auto/`. |
| **Checkpoints** | **Ctrl+Shift+S** saves a *named* copy ("before new ending"). Kept until you delete them. They're included when you commit. |
| **Open / Restore** | **Ctrl+O** lists the saved file, checkpoints, previous versions, every version in **git history**, and the browser draft. Click Load. Loading can be undone with Ctrl+Z. |
| **Browser draft** | If the browser closes, your unsaved work is offered back next time you open the editor. |
| **Import / Export** | File ▸ Import / Export a story JSON, to send one by chat or try someone else's. |
| **Git** | File ▸ **Commit to git…** commits `story.json` and checkpoints (never code) with your message. Tick *Also push* to upload to GitHub. Pushing the **main** branch updates the **public** website, and the dialog warns you about that. |

Undo / redo: **Ctrl+Z / Ctrl+Y** (300 steps).

## Shortcuts

`Space` play/pause · `Esc` stop / deselect · `← →` one frame (Shift: 1 s) · `Home / End` ·
`, .` previous / next key · `K` add key · `L` lock · `Del` delete · `Ctrl C / X / V` copy / cut / paste ·
`Ctrl D` duplicate · `Ctrl Z / Y` undo / redo · `Ctrl S` save · `Ctrl Shift S` checkpoint · `Ctrl O` open ·
`1 / 2` Scene / Game · `F` fit timeline. Help ▸ Keyboard shortcuts shows them all.

## What the editor doesn't do (yet)

It edits the story's **timing, camera, captions and parameters**. It can't add new 3D models, or change
how the water 50, fish or ocean *look* or behave. Those are code changes: leave a note and ask a developer
or Claude. Past the original 1:00, nothing new happens in the scene until you add keys and captions
there. New *kinds* of beats (a new creature moment, a new effect) need code first.
