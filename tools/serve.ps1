# Open Tuna dev server for Windows machines without Python. Same behaviour and endpoints as
# tools/serve.py (keep them in sync): serves the project with no caching + the editor's save system.
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8123] [-Open]
param([int]$Port = 8123, [switch]$Open)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$story = Join-Path $root 'story.json'
$savesDir = Join-Path $root 'saves'
$autoDir = Join-Path $savesDir 'auto'
$checkDir = Join-Path $savesDir 'checkpoints'
$keepAuto = 100
$utf8 = New-Object Text.UTF8Encoding($false)
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
  '.glb' = 'model/gltf-binary'; '.gltf' = 'model/gltf+json'; '.bin' = 'application/octet-stream'; '.wasm' = 'application/wasm'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.webp' = 'image/webp'; '.svg' = 'image/svg+xml'
  '.mp3' = 'audio/mpeg'; '.ogg' = 'audio/ogg'
}
$hasGitExe = [bool](Get-Command git -ErrorAction SilentlyContinue)

$listener = $null
for ($p = $Port; $p -lt $Port + 20; $p++) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l; $Port = $p; break
  } catch { }
}
if (-not $listener) { Write-Host "No free port near $Port"; exit 1 }

$base = "http://localhost:$Port/"
Write-Host ""
Write-Host "  Open Tuna dev server - $root"
Write-Host ""
Write-Host "  Editor : ${base}?edit"
Write-Host "  Site   : $base"
Write-Host "  Lab    : ${base}?lab"
Write-Host ""
Write-Host "  Use Chrome or Edge (WebGPU). Keep this window open; Ctrl+C to stop."
if (-not $hasGitExe) { Write-Host "  (git not found: the editor's Git menu is disabled)" }
if ($Open) { Start-Process "${base}?edit" }

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

function Listing($folder) {
  $items = @()
  if (-not (Test-Path $folder)) { return ,$items }
  Get-ChildItem -Path $folder -Filter *.json | Sort-Object Name -Descending | ForEach-Object {
    $name = $_.BaseName; $time = ''
    if ($_.Name -match '^(\d{4}-\d\d-\d\d)_(\d\d)(\d\d)(\d\d)_?(.*)\.json$') {
      $time = "$($Matches[1]) $($Matches[2]):$($Matches[3]):$($Matches[4])"
      $name = if ($Matches[5]) { $Matches[5] -replace '-', ' ' } else { $_.BaseName }
    }
    $rel = $_.FullName.Substring($root.Length + 1) -replace '\\', '/'
    $items += [ordered]@{ file = $rel; name = $name; time = $time; size = $_.Length }
  }
  return ,$items
}

function SafeFile([string]$rel) {
  if (-not $rel) { $rel = 'story.json' }
  $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
  if ($full -eq $story -or ($full.StartsWith($savesDir + [IO.Path]::DirectorySeparatorChar) -and $full.EndsWith('.json'))) { return $full }
  throw 'file not allowed'
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

function Editor($ctx, [string]$path) {
  $req = $ctx.Request
  $q = $req.QueryString
  $body = ''
  if ($req.HttpMethod -eq 'POST') { $body = (New-Object IO.StreamReader($req.InputStream, $utf8)).ReadToEnd() }
  switch ($path) {
    '/__editor/ping' {
      $g = HasGit
      $br = if ($g) { (Git @('branch', '--show-current')).out } else { '' }
      SendJson $ctx 200 ([ordered]@{ ok = $true; save = $true; git = $g; branch = $br }); return
    }
    '/__editor/list' {
      $hist = @()
      if (HasGit) {
        $r = Git @('log', '-n', '60', '--format=%h|%cI|%an|%s', '--', 'story.json')
        if ($r.code -eq 0 -and $r.out) {
          foreach ($line in ($r.out -split "`n")) {
            $f = $line.Trim().Split('|', 4)
            $hist += [ordered]@{ hash = $f[0]; time = ($f[1].Substring(0, [Math]::Min(19, $f[1].Length)) -replace 'T', ' '); author = $f[2]; subject = $f[3] }
          }
        }
      }
      SendJson $ctx 200 ([ordered]@{ checkpoints = (Listing $checkDir); autos = (Listing $autoDir); git = $hist }); return
    }
    '/__editor/load' {
      if ($q['git']) {
        if ($q['git'] -notmatch '^[0-9a-fA-F]{4,40}$') { throw 'bad commit' }
        $r = Git @('show', "$($q['git']):story.json")
        if ($r.code -ne 0) { throw $r.out }
        Send $ctx 200 $utf8.GetBytes($r.out) 'application/json; charset=utf-8'; return
      }
      Send $ctx 200 ([IO.File]::ReadAllBytes((SafeFile $q['file']))) 'application/json; charset=utf-8'; return
    }
    '/__editor/git/status' {
      if (-not (HasGit)) { SendJson $ctx 200 @{ git = $false }; return }
      $br = (Git @('branch', '--show-current')).out
      $up = Git @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
      $ch = (Git @('status', '--porcelain', '--', 'story.json', 'saves/checkpoints')).out
      $ahead = if ($up.code -eq 0) { (Git @('rev-list', '--count', '@{u}..HEAD')).out } else { '' }
      $changes = @($ch -split "`n" | Where-Object { $_.Trim() })
      SendJson $ctx 200 ([ordered]@{ git = $true; branch = $br; upstream = $(if ($up.code -eq 0) { $up.out } else { '' }); ahead = $ahead; changes = $changes }); return
    }
    '/__editor/save' {
      ValidStory $body
      if (Test-Path $story) {
        $old = [IO.File]::ReadAllText($story, $utf8)
        if ($old -ne $body) {
          WriteFile (Join-Path $autoDir "$(Stamp).json") $old
          Listing $autoDir | Select-Object -Skip $keepAuto | ForEach-Object { Remove-Item (Join-Path $root $_.file) }
        }
      }
      WriteFile $story $body
      SendJson $ctx 200 @{ ok = $true }; return
    }
    '/__editor/checkpoint' {
      ValidStory $body
      $slug = (($q['name'] -replace '[^A-Za-z0-9]+', '-').Trim('-'))
      if ($slug.Length -gt 60) { $slug = $slug.Substring(0, 60) }
      if (-not $slug) { $slug = 'checkpoint' }
      $file = Join-Path $checkDir "$(Stamp)_$slug.json"
      WriteFile $file $body
      SendJson $ctx 200 @{ ok = $true; file = ($file.Substring($root.Length + 1) -replace '\\', '/') }; return
    }
    '/__editor/delete' {
      $full = SafeFile $q['file']
      if (-not $full.StartsWith($checkDir + [IO.Path]::DirectorySeparatorChar)) { throw 'only checkpoints can be deleted' }
      Remove-Item $full
      SendJson $ctx 200 @{ ok = $true }; return
    }
    '/__editor/git/commit' {
      $msg = ''
      try { $msg = ($body | ConvertFrom-Json).message } catch { }
      if (-not $msg) { $msg = 'Update story' }
      $paths = @('story.json')
      if ((Test-Path $checkDir) -and (Get-ChildItem $checkDir).Count) { $paths += 'saves/checkpoints' }
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
      $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
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
      Send $ctx 200 ([IO.File]::ReadAllBytes($file)) $type
    } catch {
      try { Send $ctx 500 ([Text.Encoding]::UTF8.GetBytes("$_")) 'text/plain' } catch { }
    }
  }
} finally { $listener.Stop() }
