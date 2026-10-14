# Deploying the studio on a company server

**Plain file hosting works too.** Upload the repository as it is (no build step) to any HTTPS web host or bucket,
in any sub-folder, leaving out `.git/`, `node_modules/`, `projects/` and `saves/auto/`. With no studio server
answering, the pages start the **browser studio** (`sw.js`, a service worker registered by `src/backend.js`): it
answers the same `/__editor/*` API from IndexedDB, so creating / opening projects, uploads, checkpoints, `.tuna`
files and Build site all work — per browser, with no autosave (Ctrl+S writes the working copy and the .tuna file).
Git and live team editing need the real server below. The host must serve `sw.js` from the tool's folder (any static
host does). When you add a built-in model, add it to `models/index.json` too.


The studio is this repository served by `tools/serve.py` (the same server the launchers start). The home page is
`/`, the editor `editor.html?project=…`, the player `play.html?project=…`. Built sites (File ▸ Build site) don't need
any of this: they're static files for any host — that's what customers get.

## What it needs

- **HTTPS.** WebGPU only runs in secure contexts: `https://…`, or `http://localhost` on your own machine. At
  `http://studio-server:8123` the editor and the stories don't run at all. Put a reverse proxy with a certificate in
  front (Caddy, nginx, the company load balancer).
- **Python 3.9+** (stdlib only) and **git** if you want the editor's commit / push. On Windows without Python,
  `tools/serve.ps1` is equivalent.
- Internet access for visitors' browsers (three.js and the fonts come from CDNs).

## Server options

| Python | PowerShell | Does |
|---|---|---|
| `--host 0.0.0.0` | `-BindHost +` (admin shell or urlacl) | listen beyond this machine. Behind a proxy on the same host, keep the default `127.0.0.1` |
| `--password` + env `OPEN_TUNA_PASSWORD` | `-Password` + `$env:OPEN_TUNA_PASSWORD` | HTTP Basic login for everything (any user name) |
| `--no-git` | `-NoGit` | turn off commit / push: otherwise the editor pushes **with the server's git credentials** |
| port as first argument | `-Port` | default 8123 (the next free port up to +19) |

Example (Linux, proxy on the same machine):

```sh
cd /srv/open-tuna
OPEN_TUNA_PASSWORD='…' python3 tools/serve.py 8123 --password --no-git
```

Caddy (automatic HTTPS for a public name, or `tls internal` on an intranet):

```
studio.example.com {
    reverse_proxy 127.0.0.1:8123
    request_body { max_size 2GB }   # video uploads
}
```

nginx:

```
server {
    listen 443 ssl;  server_name studio.example.com;
    ssl_certificate …;  ssl_certificate_key …;
    client_max_body_size 2g;          # video uploads
    location / { proxy_pass http://127.0.0.1:8123; proxy_set_header Host $host; proxy_buffering off; }
}
```

If the proxy already does the login (SSO, basic auth), `--password` can be left off.

Keep it running as a service (systemd example):

```
[Service]
WorkingDirectory=/srv/open-tuna
Environment=OPEN_TUNA_PASSWORD=…
ExecStart=/usr/bin/python3 tools/serve.py 8123 --password --no-git
Restart=always
```

## Things to know

- **No user accounts.** Everyone with the password can open and change every project on that server. Two people
  editing the same project are protected by the save-conflict check (*Load theirs / Keep mine*), but it isn't
  real-time collaboration.
- **Where work lives:** `projects/<slug>/` holds the working copy of every project opened or created on the server.
  Ctrl+S also writes the `.tuna` to the designer's own computer. **Back up `projects/`** (and `saves/`): they're
  gitignored.
- **Demos** (`demos/<id>/`) are part of the tool. The home page's *Open a copy* never touches them; *edit the
  original demo* does. Consider `--no-git` plus file permissions if the demos must stay fixed.
- **It's a small threaded stdlib server** made for a team, not for public traffic. Serve built sites from a real
  static host / CDN, not from the studio.
- Updating the studio = `git pull` in its folder (then restart the service when `tools/serve.py` changed).
