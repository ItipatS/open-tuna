# Deploying the studio on a company server

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

- **Team editing is live.** Everyone who opens the same project edits one shared story in real time (presence,
  *Locked by …*, per-person undo, a History of every edit with rewind, review notes from `play.html?…&review`
  links). It needs `tools/serve.py` (the PowerShell server has no live editing). The editor keeps a long-poll
  request open for up to 25 s: the proxy must not buffer it or time out sooner (nginx: `proxy_buffering off` as
  above, `proxy_read_timeout` ≥ 60s — the default).
- **No user accounts.** Everyone with the password can open and change every project on that server. Names in the
  editor (locks, notes, History) are what each person typed in — a courtesy, not a login.
- **Where work lives:** `projects/<slug>/` holds the working copy of every project opened or created on the server,
  with its edit log in `saves/history.jsonl`; the team's snippets are in `library/`. Ctrl+S also writes the `.tuna`
  to the designer's own computer. **Back up `projects/`, `library/` and the demos' `saves/`**: they're gitignored.
- **Demos** (`demos/<id>/`) are part of the tool. The home page's *Open a copy* never touches them; *edit the
  original demo* does. Consider `--no-git` plus file permissions if the demos must stay fixed.
- **It's a small threaded stdlib server** made for a team, not for public traffic. Serve built sites from a real
  static host / CDN, not from the studio.
- Updating the studio = `git pull` in its folder (then restart the service when `tools/serve.py` changed).
