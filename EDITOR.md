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
| **Top bar** | File / Edit / View / Help menus · ⏮ start · ▶ **Play** · ⏹ Stop · ▶▶ **Auto-play** + speed · the big **SCENE / GAME** switch · time · save status · Copy ref · Save |
| **Scene** (left) | Every part of the world. Click the eye to hide something while you work (not saved). Right-click for *Show only this* / *Show all*. |
| **Viewport** (middle) | The coloured frame tells you where you are: **blue = SCENE** (free camera, for placing camera keys), **green = GAME** (exactly what a visitor sees), **orange = PLAYING**. Press **1** / **2** to switch. |
| **Inspector** (right) | Settings of whatever you selected. With nothing selected, it shows the project and scene settings. |
| **Timeline** (bottom) | The whole story in real time (m:ss). The orange line is the playhead; the pink **END** flag is the end of the story. |

Drag the thin edge between the left panel and the viewport, or between the viewport and the Inspector, to make
a panel wider or narrower. Double-click the edge to reset it. The sizes are remembered.

## Play vs Auto-play

- **▶ Play (Space)** works like the real website. Nothing moves until you scroll: use the mouse wheel over
  the viewport, the arrow keys / Page Up / Page Down, drag the page, or drag the scrollbar on the right. The
  scroll has the same smoothing as the website. Clickable layers (buttons, links, web pages) work as they
  do for a visitor.
- **▶▶ Auto-play** runs the story by itself at the chosen speed (¼× to 8×), which is handy for watching a
  long story.
- **⏹ Stop (Esc)** goes back to where you pressed Play. Pause (Space again) stays where you are.

## Time and story length

The story has a real length (it starts at 1:00). Make it as long as you need: an hour is fine.
- Drag the pink **END** flag on the ruler, or
- Right-click the ruler ▸ **Make the story longer**, or
- Click **Length** in the timeline bar (or Edit ▸ Story length…) and type `5:00` or `1:00:00`.

Keys keep their times when the length changes. Things that ran "until the end" keep running to the new end.
On the website, scrolling the whole page plays the whole story. Set *Scroll vh / s* in the Project
inspector to make scrolling faster or slower.

## Organising the timeline: lanes, groups, collapse

- **Lanes** work like tracks in a video editor. One lane holds many clips side by side: layers (images, text,
  glass, HTML…) and creature paths. When clips overlap in time, the lane grows a second row for them. You decide
  what goes where:
  - **+ Lane** makes a new lane.
  - Drag a clip **up or down** to move it into another lane.
  - Or right-click a clip ▸ **Move to lane**.
- **Groups** are folders. **+ Group** makes one, and right-click any track or lane ▸ **Move to group** adds it.
  Muting or locking a group or lane applies to everything inside.
- **Collapse:** click the small triangle at the left of any row. A collapsed group or row shows a thin overview
  of what's inside.
- **Drop files straight onto a lane.** Drag images, videos or `.html` files from your computer onto a lane in
  the timeline. They start where you drop them. Drop several at once and they're placed one after another.
  Dropping on empty space or on a group makes a new lane.

## Assets

The **Assets** tab on the left (next to *Scene*) shows everything in the project's `assets/` folder, with
thumbnails. The pink number on a thumbnail is how many layers use that file.
- **Drag** an asset onto a lane in the timeline (it starts at the drop time), or onto the viewport.
- **Double-click** an asset to add it at the playhead.
- Right-click an asset to add it in the 3D world, see which layer uses it, copy its path, or delete it. Deleting
  warns you if the file is in use.
- **Upload…**, or drop files onto the panel, to add files without placing them yet.
- The project's **3D models** (`.glb`: shark, turtle, whales, tuna, coral…) are listed too, marked *built-in*.
  You can place them, but not delete them. Uploaded `.glb` / `.gltf` files work the same way.

### 3D model clips

Drop a model on a lane (or use **Layer ▾ ▸ 3D model (.glb)**) to get a **model clip**: the model placed in the 3D
world for that stretch of time. You can key it like any layer:
- Select the clip, move the playhead, and drag the model in the **Scene** view. Use the gizmo's **Move / Rotate**
  buttons in the Inspector. Each change becomes a key at the playhead.
- Inspector: **Size**, **Flip facing** (if it swims backwards), **Animation** (choose the model's clip),
  **Scrub** (the animation follows the scroll, so it rewinds when you scroll back) and **Anim speed**. You can
  also use opacity, reveal effects and fade like other layers.
- *Copy ref* includes model clips, so you can ask Claude things like "make the shark clip at 1:40 circle the can".

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

## Creature paths: steer the school, whales, sharks, turtles

While a path is active it has **priority** over the creature's own behaviour:
- The creature swims to the route at its own speed. It doesn't slide or teleport.
- A tuna school on a path ignores sharks, whales and the mouse.
- When the path ends, the creature carries on with its own swimming from exactly where it is.

Two scene parameters (Project inspector, or animate them with **+ Track…**) control the school the rest of the
time: **Fish flee the cursor** (off by default) and **Fish flee predators** (on).

Normally the creatures swim by themselves. A **path** track makes one of them follow your route for a while:
**+ Track… ▸ Move a creature along a path** (tuna school, blue whale, humpback, shark 1 / 2, turtle 1 / 2).

- The teal bar is *when* it follows the path. Outside the bar it does its own thing, and *Blend* is how many
  seconds it takes to ease in and out.
- **Waypoints** are the diamonds. In the **Scene** view the path is the bright green line. Click a green
  ball and drag the arrows to move a waypoint, or look somewhere and press **K** to drop a waypoint where the
  Scene camera is looking.
- Heights: the sea surface is at 0 and the seabed is around −20. Whales just below 0 swim *at* the surface.
- The tuna school follows its path as a school: it tightens up and trails the waypoints a little.
- Combine a path with camera keys that have **Follow school** = 1 to make the camera track the school.

The demo chapter **The Journey (1:00–2:30)** uses all of this: a school route, a blue whale passing, a humpback
at the surface, parallax cards, 3D medallions and products along the route, and clickable panels at the end.
Everything in it is placeholder art (`assets/demo/`). Change it or delete it freely.

## Layers: images, video, text, glass, HTML, web pages, parallax

There are two kinds of layer, and the difference matters for how impressive it looks:

- **In the scene (shader) layers:** images, videos, **Text** and **Glass panels** are drawn *inside* the 3D
  scene. They get the same light, bloom and colour grade as the ocean, plus shader effects:
  - **Reveal:** water dissolve, current wipe, ripple from the centre, or a plain fade.
  - **Water flow:** the image ripples like it's under water.
  - **Caustic light:** dancing light patterns over it.
  - **Colour split:** grows when the visitor scrolls fast.
  - **Glow:** makes it shine.
  - **Frosted glass:** shows the live ocean behind it, blurred.

  They float at a **Depth** in front of the camera, so fish closer than that swim *in front of* them. Pick a
  **Look** preset (Underwater card, Liquid reveal, Glowing, Current wipe, Clean), then fine-tune the sliders.
- **HTML overlays:** HTML blocks and web pages (iframes) sit on top of everything, like a normal website. Use
  them for real buttons, links and forms, and turn on **Clickable**. A good pattern is a **Glass panel**
  (shader) behind an HTML button or page.

New images, videos, text and glass start as shader layers. The Inspector's **Render** setting switches an
image or video to a plain HTML overlay.

- **Add:** drag files from your computer onto the viewport (Game view: placed where you drop them; Scene
  view: placed in 3D). Or use **Layer ▾** in the timeline bar: *from file*, *from a URL*, *web page (iframe)*,
  *HTML / text / button block*, or *in the 3D world*. Files are copied into the project's `assets/` folder.
- **Each layer is a pink bar on the timeline.** Drag it to change *when* it shows, and drag its ends to change
  start / end. *Fade* in the Inspector sets how long it fades in and out.
- **Move it:** in the **Game** view, drag the layer itself (shader layers show a pink box when selected); drag the
  pink corner handle to scale it.
  3D layers: in the **Scene** view, click the picture and drag the arrows.
- **Animate it:** a layer with one key just sits there. Press **K** (or *Key at playhead*) to add keys, then drag
  the layer at different moments. Once it has 2+ keys, dragging at a new moment adds a key automatically.
  Each key holds position, scale, rotation and opacity.
- **Parallax:** right-click a layer ▸ **Make parallax…** and pick a direction and a depth (far background moves
  a little, foreground a lot). Give several layers different depths for a parallax stack as the visitor scrolls.
- **Stacking:** *Stack order* in the Inspector (captions are at 10; higher goes over them). Right-click ▸
  Bring forward / Send backward.
- **Video:** loops while visible, muted. Tick **Scrub with story** to make the video follow the scroll
  (scrolling forwards / back plays it forwards / back).
- **Web pages / buttons:** tick **Clickable** so visitors can click links, buttons or use the page. Scrolling
  pauses while the mouse is over a clickable layer. Some websites refuse to be shown inside another site; your
  own `.html` files always work.
- On screen, sizes are in **% of the view**, so layers scale with the window and phone screens.

## Saving: you can't really lose work

| What | How |
|---|---|
| **Save** | **Ctrl+S** (or Save). Writes `story.json`. The top bar says *Saved 3:15 PM* or *Unsaved changes*. |
| **Changed elsewhere** | If `story.json` changed on disk since you opened the editor (Claude edited it, a git pull, another tab), saving is paused and you're asked: **Load theirs** (your version stays in undo) or **Keep mine**. Nothing gets overwritten silently. |
| **Autosave** | On by default (every minute, after you stop editing for 2 s). Change it in File ▸ Autosave. |
| **Previous versions** | Every save keeps the version it replaced (last 100) in `saves/auto/`. |
| **Checkpoints** | **Ctrl+Shift+S** saves a *named* copy ("before new ending"). Kept until you delete them. They're included when you commit. |
| **Open / Restore** | **Ctrl+O** lists the saved file, checkpoints, previous versions, every version in **git history**, and the browser draft. Click Load. Loading can be undone with Ctrl+Z. |
| **Browser draft** | If the browser closes, your unsaved work is offered back next time you open the editor. |
| **Import / Export** | File ▸ Import / Export a story JSON, to send one by chat or try someone else's. |
| **Git** | File ▸ **Commit to git…** commits `story.json`, checkpoints and your `assets/` files (never code) with your message. Tick *Also push* to upload to GitHub. Pushing the **main** branch updates the **public** website, and the dialog warns you about that. |

Undo / redo: **Ctrl+Z / Ctrl+Y** (300 steps).

## Shortcuts

`Space` play (scroll like the website) / pause · wheel, `↑ ↓`, `PgUp PgDn` scroll while playing · `Esc` stop / deselect · `← →` one frame (Shift: 1 s) · `Home / End` ·
`, .` previous / next key · `K` add key · `L` lock · `Del` delete · `Ctrl C / X / V` copy / cut / paste ·
`Ctrl D` duplicate · `Ctrl Z / Y` undo / redo · `Ctrl S` save · `Ctrl Shift S` checkpoint · `Ctrl O` open ·
`1 / 2` Scene / Game · `F` fit timeline. Help ▸ Keyboard shortcuts shows them all.

## What the editor doesn't do (yet)

It edits the story's **timing, camera, captions, parameters and media layers**. It can't add new 3D models, or change
how the water 50, fish or ocean *look* or behave. Those are code changes: leave a note and ask a developer
or Claude. Past the original 1:00, nothing new happens in the scene until you add keys and captions
there. New *kinds* of beats (a new creature moment, a new effect) need code first.
