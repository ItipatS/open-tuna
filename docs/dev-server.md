# Dev servers and the editor API

`tools/serve.py` (stdlib Python 3) and `tools/serve.ps1` (Windows PowerShell, for machines without Python) are the
**same server**. Change both together. They listen on `127.0.0.1` from port 8123 upward (the first free one), and
`--open` / `-Open` launches the editor. The double-click launchers are `Open Editor.bat` / `Open Editor.command`.

Every response is `Cache-Control: no-store`, so editors and tests always see the latest modules and story.json.
Static GETs support **byte ranges (206)**, which Chrome needs to seek in videos (scrubbed videos). The listen backlog
is 128 (the page fetches many modules and models at once).

## Endpoints (`/__editor/…`)

Every endpoint takes an optional **`project=<slug>`**: it then works on `projects/<slug>/` (an opened .tuna, same
layout: `story.json`, `assets/`, `saves/`) instead of the repo root, and paths in requests / replies are relative
to that folder. Git endpoints refuse projects. See [projects-build-data.md](projects-build-data.md).

| Method | Path | Does |
|---|---|---|
| GET | `ping` | `{ok, save:true, git, branch}`: the editor checks whether in-place saving works |
| POST | `save` | body = story.json. Requires `X-Base-Hash` = FNV-1a (hex, over the UTF-8 bytes) of the story.json the editor loaded. On mismatch, or a missing header, it answers **409** `{conflict, current}` unless `X-Force: 1`. The previous story.json goes to `saves/auto/<stamp>.json` (keeps 100) |
| POST | `checkpoint?name=` | body = story.json → `saves/checkpoints/<stamp>_<slug>.json` |
| GET | `list` | `{checkpoints, autos, git}` (git = `git log -- story.json`, last 60) |
| GET | `load?file=` / `load?git=<hash>` | story.json, a file under `saves/`, or story.json at a commit |
| POST | `delete?file=` | deletes a checkpoint (only) |
| POST | `upload?name=` | body = file bytes → `assets/<slug>.<ext>` (whitelisted extensions; never overwrites; an identical re-upload reuses the file) |
| GET | `assets` | every file under `assets/` + the root `*.glb` models (`builtin: true`), newest first |
| POST | `asset-delete?file=` | deletes one file under `assets/` (built-ins can't be deleted) |
| GET | `files` | what a .tuna holds: `story.json`, `assets/**`, `saves/checkpoints/*.json` with size / mtime |
| GET | `projects` | working copies in `projects/`: `{project, name (manifest), mtime, thumb}`, newest first |
| POST | `project/new?name=` | creates `projects/<slug>/` (slug from the name, `-2`… if taken) → `{project}`. `&from=repo` fills it with a copy of the repo story (story.json, assets/, checkpoints) + a manifest: the home page's *Open a copy of the demo* |
| POST | `put?project=&file=` | body = bytes → one file of a project (only `story.json`, `manifest.json`, `thumb.webp/png`, `assets/**` with an allowed extension, `saves/checkpoints/*.json`); overwrites. Projects only |
| GET | `git/status` | `{branch, upstream, ahead, changes}` for story.json / saves/checkpoints / assets |
| POST | `git/commit` | body `{message}`: commits **only** story.json, saves/checkpoints, assets |
| POST | `git/push` | pushes the current branch (`-u origin HEAD` if no upstream); `GIT_TERMINAL_PROMPT=0` |

**Options** (shared servers, see [deploy.md](deploy.md)): `--host`, `--password` (env `OPEN_TUNA_PASSWORD`; HTTP
Basic on every request), `--no-git` (git endpoints refuse; ping reports `git: false`), `--landing` (`/` serves
`studio.html`). PowerShell: `-BindHost`, `-Password`, `-NoGit`, `-Landing`. `--open` / `-Open` open `studio.html`.

**Safety.** Reads and deletes are limited to `story.json`, `saves/**/*.json` and `assets/**`. Nothing else can be
written except through `save` / `checkpoint` / `upload` / `put` (projects only, whitelisted paths, no `..`).
Project slugs must match `[a-z0-9][a-z0-9-]{0,62}`.

**Editing story.json from outside the editor** (Claude, a git pull): an open editor tab's next save gets a 409 and
asks the designer *Load theirs / Keep mine*. Out-of-date tabs (with no hash header) can't save at all.
