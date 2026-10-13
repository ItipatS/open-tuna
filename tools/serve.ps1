# Open Tuna dev server for Windows machines without Python. Same behaviour and endpoints as
# tools/serve.py (keep them in sync): serves the project with no caching + the editor's save system.
# Every endpoint works on the repo's story or, with ?project=<slug>, on an opened .tuna in projects/<slug>/.
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8123] [-Open]
# Shared server (docs/deploy.md; needs HTTPS in front): -BindHost + (all interfaces, needs an admin shell or a urlacl),
# -Password (HTTP Basic; the value comes from $env:OPEN_TUNA_PASSWORD), -NoGit, -Landing ("/" = studio.html).
param([int]$Port = 8123, [switch]$Open, [string]$BindHost = 'localhost', [switch]$Password, [switch]$NoGit, [switch]$Landing)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$projectsDir = Join-Path $root 'projects'
$sep = [IO.Path]::DirectorySeparatorChar
$uploadExt = @('png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'mp4', 'webm', 'mov', 'm4v', 'html', 'htm', 'mp3', 'ogg', 'wav', 'json', 'glb', 'gltf')
$keepAuto = 100
$utf8 = New-Object Text.UTF8Encoding($false)
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
  '.glb' = 'model/gltf-binary'; '.gltf' = 'model/gltf+json'; '.bin' = 'application/octet-stream'; '.wasm' = 'application/wasm'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.webp' = 'image/webp'; '.svg' = 'image/svg+xml'
  '.mp3' = 'audio/mpeg'; '.ogg' = 'audio/ogg'; '.mp4' = 'video/mp4'; '.webm' = 'video/webm'
}
$hasGitExe = [bool](Get-Command git -ErrorAction SilentlyContinue) -and -not $NoGit
$pw = ''
if ($Password) {
  $pw = $env:OPEN_TUNA_PASSWORD
  if (-not $pw) { Write-Host '-Password: set the OPEN_TUNA_PASSWORD environment variable'; exit 1 }
}
if ($BindHost -ne 'localhost' -and -not $pw) { Write-Host "`n  WARNING: listening beyond this computer WITHOUT a password - add -Password (and -NoGit).`n" }

$listener = $null
for ($p = $Port; $p -lt $Port + 20; $p++) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://${BindHost}:$p/")
    if ($pw) { $l.AuthenticationSchemes = [System.Net.AuthenticationSchemes]::Basic }
    $l.Start()
    $listener = $l; $Port = $p; break
  } catch { }
}
if (-not $listener) { Write-Host "No free port near $Port"; exit 1 }

$base = "http://localhost:$Port/"
Write-Host ""
Write-Host "  Open Tuna dev server - $root"
Write-Host ""
Write-Host "  Studio : ${base}studio.html   (home: demo, new / open projects)"
Write-Host "  Editor : ${base}index.html?edit"
Write-Host "  Site   : ${base}$(if ($Landing) { 'index.html' })"
Write-Host "  Lab    : ${base}index.html?lab"
if ($BindHost -ne 'localhost') { Write-Host "  Listening on ${BindHost}:$Port$(if ($pw) { ' - password on' })$(if ($NoGit) { ' - git off' })" }
Write-Host ""
Write-Host "  Use Chrome or Edge (WebGPU). Keep this window open; Ctrl+C to stop."
if (-not $hasGitExe) { Write-Host "  (git not found: the editor's Git menu is disabled)" }
if ($Open) { Start-Process "${base}studio.html" }

function Send($ctx, [int]$code, [byte[]]$bytes, [string]$type) {
  $res = $ctx.Response
  $res.StatusCode = $code
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-store'
  $res.ContentLength64 = $bytes.Length
  try { $res.OutputStream.Write($bytes, 0, $bytes.Length) } catch { }
  $res.OutputStream.Close()
}
function SendJson($ctx, [int]$code, $obj) { Send $ctx $code $utf8.GetBytes((ConvertTo-Json $obj -Depth 6 -Compress)) 'application/json' }
function Stamp { (Get-Date).ToString('yyyy-MM-dd_HHmmss') }
function UnixTime($item) { [int][double]::Parse((Get-Date $item.LastWriteTimeUtc -UFormat %s)) }

function Git([string[]]$gitArgs) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = 'git'
  $psi.Arguments = ($gitArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.WorkingDirectory = $root
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $psi.StandardOutputEncoding = $utf8; $psi.StandardErrorEncoding = $utf8
  $psi.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
  $proc = [Diagnostics.Process]::Start($psi)
  $out = $proc.StandardOutput.ReadToEnd() + $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  return @{ code = $proc.ExitCode; out = $out.Trim() }
}
function HasGit { if (-not $hasGitExe) { return $false }; return (Git @('rev-parse', '--is-inside-work-tree')).code -eq 0 }

# the story being edited: the repo root (slug '') or an unpacked .tuna in projects/<slug>/
function Proj([string]$slug) {
  $r = $root
  if ($slug) {
    if ($slug -cnotmatch '^[a-z0-9][a-z0-9-]{0,62}$') { throw 'bad project name' }
    $r = Join-Path $projectsDir $slug
    if (-not (Test-Path -LiteralPath $r -PathType Container)) { throw "no project `"$slug`" (open its .tuna file again)" }
  }
  $saves = Join-Path $r 'saves'
  return @{ slug = $slug; root = $r; story = (Join-Path $r 'story.json'); saves = $saves; auto = (Join-Path $saves 'auto'); check = (Join-Path $saves 'checkpoints'); assets = (Join-Path $r 'assets') }
}
function Rel($P, [string]$full) { return ($full.Substring($P.root.Length + 1) -replace '\\', '/') }

function Listing($P, $folder) {
  $items = @()
  if (-not (Test-Path $folder)) { return ,$items }
  Get-ChildItem -Path $folder -Filter *.json | Sort-Object Name -Descending | ForEach-Object {
    $name = $_.BaseName; $time = ''
    if ($_.Name -match '^(\d{4}-\d\d-\d\d)_(\d\d)(\d\d)(\d\d)_?(.*)\.json$') {
      $time = "$($Matches[1]) $($Matches[2]):$($Matches[3]):$($Matches[4])"
      $name = if ($Matches[5]) { $Matches[5] -replace '-', ' ' } else { $_.BaseName }
    }
    $items += [ordered]@{ file = (Rel $P $_.FullName); name = $name; time = $time; size = $_.Length }
  }
  return ,$items
}

function Files($P, $folder) {
  $items = @()
  if (-not (Test-Path $folder)) { return ,$items }
  Get-ChildItem -Path $folder -File -Recurse | Where-Object { $_.Extension -ne '.tmp' } | Sort-Object FullName | ForEach-Object {
    $items += [ordered]@{ file = (Rel $P $_.FullName); size = $_.Length; mtime = (UnixTime $_) }
  }
  return ,$items
}

function SafeFile($P, [string]$rel) {
  if (-not $rel) { $rel = 'story.json' }
  $full = [IO.Path]::GetFullPath((Join-Path $P.root $rel))
  if ($full -eq $P.story -or ($full.StartsWith($P.saves + $sep) -and $full.EndsWith('.json'))) { return $full }
  throw 'file not allowed'
}

# where a .tuna's files may be written: story.json, manifest.json, thumb.*, assets/**, saves/checkpoints/*.json
function Putable($P, [string]$rel) {
  $full = [IO.Path]::GetFullPath((Join-Path $P.root ($rel -replace '/', '\')))
  if (-not $full.StartsWith($P.root + $sep)) { throw 'path outside the project' }
  $r = Rel $P $full
  $ext = [IO.Path]::GetExtension($r).TrimStart('.').ToLower()
  if ($r -in @('story.json', 'manifest.json', 'thumb.webp', 'thumb.png') -or ($r.StartsWith('assets/') -and $uploadExt -contains $ext) -or
      ($r.StartsWith('saves/checkpoints/') -and $ext -eq 'json' -and ($r.Split('/').Count -eq 3))) { return $full }
  throw "$rel can't be part of a project"
}

function Fnv1a([byte[]]$data) {
  [uint64]$h = 2166136261
  foreach ($b in $data) { $h = (($h -bxor $b) * 16777619) % 4294967296 }
  return '{0:x8}' -f $h
}

function ValidStory([string]$body) {
  $data = $body | ConvertFrom-Json
  if ($null -eq $data.tracks) { throw 'not a story.json (no "tracks" list)' }
}

function WriteFile([string]$path, [string]$text) {
  New-Item -ItemType Directory -Force (Split-Path -Parent $path) | Out-Null
  [IO.File]::WriteAllText("$path.tmp", $text, $utf8)
  Move-Item -Force "$path.tmp" $path
}

function ReadBytes($req) {
  $ms = New-Object IO.MemoryStream
  $req.InputStream.CopyTo($ms)
  return ,$ms.ToArray()
}

function Editor($ctx, [string]$path) {
  $req = $ctx.Request
  $q = $req.QueryString
  $body = ''
  if ($path -eq '/__editor/project/new') {
    $slugBase = (("$($q['name'])".ToLower() -replace '[^a-z0-9]+', '-').Trim('-'))
    if ($slugBase.Length -gt 48) { $slugBase = $slugBase.Substring(0, 48).Trim('-') }
    if (-not $slugBase) { $slugBase = 'project' }
    $slug = $slugBase; $n = 1
    while (Test-Path (Join-Path $projectsDir $slug)) { $n++; $slug = "$slugBase-$n" }
    $d = Join-Path $projectsDir $slug
    New-Item -ItemType Directory -Force $d | Out-Null
    if ($q['from'] -eq 'repo') {
      # a copy of the repo story (the demo) to play with
      $repo = Proj ''
      Copy-Item -LiteralPath $repo.story (Join-Path $d 'story.json')
      (Get-Item (Join-Path $d 'story.json')).LastWriteTime = Get-Date  # a fresh date: it's a new project
      if (Test-Path $repo.assets) { Copy-Item -Recurse -LiteralPath $repo.assets (Join-Path $d 'assets') }
      if (Test-Path $repo.check) { New-Item -ItemType Directory -Force (Join-Path $d 'saves') | Out-Null; Copy-Item -Recurse -LiteralPath $repo.check (Join-Path $d 'saves\checkpoints') }
      $nm = if ($q['name']) { $q['name'] } else { $slug }
      WriteFile (Join-Path $d 'manifest.json') (ConvertTo-Json ([ordered]@{ format = 'open-tuna'; version = 1; name = $nm; created = (Get-Date).ToString('s') }))
    }
    SendJson $ctx 200 @{ ok = $true; project = $slug }; return
  }
  $P = Proj $q['project']
  if ($path -eq '/__editor/put') {
    if (-not $P.slug) { throw 'put only writes into projects/' }
    $file = Putable $P $q['file']
    $bytes = ReadBytes $req
    if ((Rel $P $file) -eq 'story.json') { ValidStory ($utf8.GetString($bytes)) }
    New-Item -ItemType Directory -Force (Split-Path -Parent $file) | Out-Null
    [IO.File]::WriteAllBytes("$file.tmp", $bytes)
    Move-Item -Force "$file.tmp" $file
    SendJson $ctx 200 @{ ok = $true; file = (Rel $P $file) }; return
  }
  if ($path -eq '/__editor/upload') {
    $name = [IO.Path]::GetFileName($q['name'])
    $ext = [IO.Path]::GetExtension($name).TrimStart('.').ToLower()
    if ($uploadExt -notcontains $ext) { throw ".$ext files are not allowed" }
    $stem = ([IO.Path]::GetFileNameWithoutExtension($name) -replace '[^A-Za-z0-9_-]+', '-').Trim('-')
    if ($stem.Length -gt 60) { $stem = $stem.Substring(0, 60) }
    if (-not $stem) { $stem = 'file' }
    $bytes = ReadBytes $req
    New-Item -ItemType Directory -Force $P.assets | Out-Null
    $file = Join-Path $P.assets "$stem.$ext"; $n = 1
    while (Test-Path $file) {
      $old = [IO.File]::ReadAllBytes($file)
      if ($old.Length -eq $bytes.Length -and [Linq.Enumerable]::SequenceEqual([byte[]]$old, [byte[]]$bytes)) { break }
      $n++; $file = Join-Path $P.assets "$stem-$n.$ext"
    }
    if (-not (Test-Path $file)) { [IO.File]::WriteAllBytes($file, $bytes) }
    SendJson $ctx 200 @{ ok = $true; file = (Rel $P $file) }; return
  }
  if ($req.HttpMethod -eq 'POST') { $body = (New-Object IO.StreamReader($req.InputStream, $utf8)).ReadToEnd() }
  if ($P.slug -and $path.StartsWith('/__editor/git/') -and $path -ne '/__editor/git/status') { throw 'a .tuna project is saved as a file, not to git' }
  if ($NoGit -and ($path -eq '/__editor/git/commit' -or $path -eq '/__editor/git/push')) { throw 'git is turned off on this server (-NoGit)' }
  switch ($path) {
    '/__editor/ping' {
      $g = HasGit
      $br = if ($g) { (Git @('branch', '--show-current')).out } else { '' }
      SendJson $ctx 200 ([ordered]@{ ok = $true; save = $true; git = ($g -and -not $P.slug); branch = $br }); return
    }
    '/__editor/list' {
      $hist = @()
      if (-not $P.slug -and (HasGit)) {
        $r = Git @('log', '-n', '60', '--format=%h|%cI|%an|%s', '--', 'story.json')
        if ($r.code -eq 0 -and $r.out) {
          foreach ($line in ($r.out -split "`n")) {
            $f = $line.Trim().Split('|', 4)
            $hist += [ordered]@{ hash = $f[0]; time = ($f[1].Substring(0, [Math]::Min(19, $f[1].Length)) -replace 'T', ' '); author = $f[2]; subject = $f[3] }
          }
        }
      }
      SendJson $ctx 200 ([ordered]@{ checkpoints = (Listing $P $P.check); autos = (Listing $P $P.auto); git = $hist }); return
    }
    '/__editor/load' {
      if ($q['git']) {
        if ($P.slug -or $q['git'] -notmatch '^[0-9a-fA-F]{4,40}$') { throw 'bad commit' }
        $r = Git @('show', "$($q['git']):story.json")
        if ($r.code -ne 0) { throw $r.out }
        Send $ctx 200 $utf8.GetBytes($r.out) 'application/json; charset=utf-8'; return
      }
      Send $ctx 200 ([IO.File]::ReadAllBytes((SafeFile $P $q['file']))) 'application/json; charset=utf-8'; return
    }
    '/__editor/assets' {
      $list = @()
      if (Test-Path $P.assets) {
        Get-ChildItem -Path $P.assets -File -Recurse | Where-Object { $_.Extension -ne '.tmp' } | Sort-Object LastWriteTime -Descending | ForEach-Object {
          $list += [ordered]@{ file = (Rel $P $_.FullName); size = $_.Length; mtime = (UnixTime $_) }
        }
      }
      Get-ChildItem -Path $root -File | Where-Object { $_.Extension -in '.glb', '.gltf' } | Sort-Object Name | ForEach-Object {
        $list += [ordered]@{ file = $_.Name; size = $_.Length; mtime = (UnixTime $_); builtin = $true }
      }
      SendJson $ctx 200 @{ assets = $list }; return
    }
    '/__editor/files' {
      $list = @()
      if (Test-Path $P.story) { $it = Get-Item $P.story; $list += [ordered]@{ file = 'story.json'; size = $it.Length; mtime = (UnixTime $it) } }
      $list += (Files $P $P.assets)
      $list += (Files $P $P.check)
      SendJson $ctx 200 @{ files = $list }; return
    }
    '/__editor/projects' {
      $list = @()
      if (Test-Path $projectsDir) {
        Get-ChildItem -Path $projectsDir -Directory | ForEach-Object {
          $d = $_.FullName; $slug = $_.Name
          $st = Join-Path $d 'story.json'
          if ($slug -cnotmatch '^[a-z0-9][a-z0-9-]{0,62}$' -or -not (Test-Path $st)) { return }
          $name = $slug
          try { $m = [IO.File]::ReadAllText((Join-Path $d 'manifest.json'), $utf8) | ConvertFrom-Json; if ($m.name) { $name = $m.name } } catch { }
          $thumb = ''
          foreach ($t in @('thumb.webp', 'thumb.png')) { if (-not $thumb -and (Test-Path (Join-Path $d $t))) { $thumb = "projects/$slug/$t" } }
          $list += [ordered]@{ project = $slug; name = $name; mtime = (UnixTime (Get-Item $st)); thumb = $thumb }
        }
      }
      $sorted = @($list | Sort-Object { - $_.mtime })
      SendJson $ctx 200 @{ projects = $sorted }; return
    }
    '/__editor/asset-delete' {
      $full = [IO.Path]::GetFullPath((Join-Path $P.root $q['file']))
      if (-not $full.StartsWith($P.assets + $sep) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'not a file in assets/' }
      Remove-Item -LiteralPath $full
      SendJson $ctx 200 @{ ok = $true }; return
    }
    '/__editor/git/status' {
      if ($P.slug -or -not (HasGit)) { SendJson $ctx 200 @{ git = $false }; return }
      $br = (Git @('branch', '--show-current')).out
      $up = Git @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
      $ch = (Git @('status', '--porcelain', '--', 'story.json', 'saves/checkpoints', 'assets')).out
      $ahead = if ($up.code -eq 0) { (Git @('rev-list', '--count', '@{u}..HEAD')).out } else { '' }
      $changes = @($ch -split "`n" | Where-Object { $_.Trim() })
      SendJson $ctx 200 ([ordered]@{ git = $true; branch = $br; upstream = $(if ($up.code -eq 0) { $up.out } else { '' }); ahead = $ahead; changes = $changes }); return
    }
    '/__editor/save' {
      ValidStory $body
      if (Test-Path $P.story) {
        $oldBytes = [IO.File]::ReadAllBytes($P.story)
        $baseHash = $req.Headers['X-Base-Hash']
        if ($req.Headers['X-Force'] -ne '1' -and $baseHash -ne (Fnv1a $oldBytes)) {
          $msg = if ($baseHash) { 'story.json changed on disk since the editor loaded it' } else { 'this editor tab is out of date - reload it' }
          SendJson $ctx 409 ([ordered]@{ ok = $false; conflict = $true; error = $msg; current = $utf8.GetString($oldBytes) }); return
        }
        $old = [IO.File]::ReadAllText($P.story, $utf8)
        if ($old -ne $body) {
          WriteFile (Join-Path $P.auto "$(Stamp).json") $old
          Listing $P $P.auto | Select-Object -Skip $keepAuto | ForEach-Object { Remove-Item (Join-Path $P.root $_.file) }
        }
      }
      WriteFile $P.story $body
      SendJson $ctx 200 @{ ok = $true }; return
    }
    '/__editor/checkpoint' {
      ValidStory $body
      $slug = (($q['name'] -replace '[^A-Za-z0-9]+', '-').Trim('-'))
      if ($slug.Length -gt 60) { $slug = $slug.Substring(0, 60) }
      if (-not $slug) { $slug = 'checkpoint' }
      $file = Join-Path $P.check "$(Stamp)_$slug.json"
      WriteFile $file $body
      SendJson $ctx 200 @{ ok = $true; file = (Rel $P $file) }; return
    }
    '/__editor/delete' {
      $full = SafeFile $P $q['file']
      if (-not $full.StartsWith($P.check + $sep)) { throw 'only checkpoints can be deleted' }
      Remove-Item $full
      SendJson $ctx 200 @{ ok = $true }; return
    }
    '/__editor/git/commit' {
      $msg = ''
      try { $msg = ($body | ConvertFrom-Json).message } catch { }
      if (-not $msg) { $msg = 'Update story' }
      $paths = @('story.json')
      if ((Test-Path $P.check) -and (Get-ChildItem $P.check).Count) { $paths += 'saves/checkpoints' }
      if ((Test-Path $P.assets) -and (Get-ChildItem $P.assets).Count) { $paths += 'assets' }
      $r = Git (@('add', '--') + $paths)
      if ($r.code -eq 0) { $r = Git (@('commit', '-m', $msg, '--') + $paths) }
      SendJson $ctx $(if ($r.code -eq 0) { 200 } else { 400 }) ([ordered]@{ ok = ($r.code -eq 0); output = $r.out; error = $(if ($r.code -eq 0) { '' } else { $r.out }) }); return
    }
    '/__editor/git/push' {
      $up = Git @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
      $r = if ($up.code -eq 0) { Git @('push') } else { Git @('push', '-u', 'origin', 'HEAD') }
      SendJson $ctx $(if ($r.code -eq 0) { 200 } else { 400 }) ([ordered]@{ ok = ($r.code -eq 0); output = $r.out; error = $(if ($r.code -eq 0) { '' } else { $r.out }) }); return
    }
  }
  SendJson $ctx 404 @{ ok = $false; error = 'unknown endpoint' }
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      if ($pw -and ($null -eq $ctx.User -or $ctx.User.Identity.Password -ne $pw)) {
        try { $ctx.Response.AddHeader('WWW-Authenticate', 'Basic realm="Open Tuna Studio"') } catch { }
        Send $ctx 401 ([Text.Encoding]::UTF8.GetBytes('Password required')) 'text/plain'; continue
      }
      $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
      if ($Landing -and $path -eq '/') { $path = '/studio.html' }
      if ($path.StartsWith('/__editor/')) {
        try { Editor $ctx $path } catch { SendJson $ctx 400 @{ ok = $false; error = "$_" } }
        continue
      }
      if ($path.EndsWith('/')) { $path += 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
      if (-not $file.StartsWith($root) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        Send $ctx 404 ([Text.Encoding]::UTF8.GetBytes('Not found')) 'text/plain'; continue
      }
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $type = $types[$ext]; if (-not $type) { $type = 'application/octet-stream' }
      $range = $ctx.Request.Headers['Range']
      if ($range -match '^bytes=(\d*)-(\d*)$') {
        # byte ranges (206): browsers need them to seek in videos
        $size = (Get-Item -LiteralPath $file).Length
        if ($Matches[1]) { $start = [long]$Matches[1]; $end = if ($Matches[2]) { [long]$Matches[2] } else { $size - 1 } }
        else { $start = [Math]::Max(0, $size - [long]$Matches[2]); $end = $size - 1 }
        $end = [Math]::Min($end, $size - 1)
        $res = $ctx.Response
        if ($start -gt $end) { $res.StatusCode = 416; $res.Headers['Content-Range'] = "bytes */$size"; $res.Close(); continue }
        $len = $end - $start + 1
        $res.StatusCode = 206; $res.ContentType = $type; $res.ContentLength64 = $len
        $res.Headers['Content-Range'] = "bytes $start-$end/$size"; $res.Headers['Accept-Ranges'] = 'bytes'; $res.Headers['Cache-Control'] = 'no-store'
        $fs = [IO.File]::OpenRead($file)
        try {
          $fs.Seek($start, 'Begin') | Out-Null
          $buf = New-Object byte[] 1048576
          while ($len -gt 0) {
            $n = $fs.Read($buf, 0, [int][Math]::Min($buf.Length, $len))
            if ($n -le 0) { break }
            $res.OutputStream.Write($buf, 0, $n); $len -= $n
          }
        } catch { } finally { $fs.Close(); try { $res.OutputStream.Close() } catch { } }
        continue
      }
      $ctx.Response.Headers['Accept-Ranges'] = 'bytes'
      Send $ctx 200 ([IO.File]::ReadAllBytes($file)) $type
    } catch {
      try { Send $ctx 500 ([Text.Encoding]::UTF8.GetBytes("$_")) 'text/plain' } catch { }
    }
  }
} finally { $listener.Stop() }
