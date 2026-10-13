# Open Tuna dev server for Windows machines without Python (same behaviour as tools/serve.py):
# serves the project with no caching and lets the editor save story.json.
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8123] [-Open]
param([int]$Port = 8123, [switch]$Open)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$story = Join-Path $root 'story.json'
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
  '.glb' = 'model/gltf-binary'; '.gltf' = 'model/gltf+json'; '.bin' = 'application/octet-stream'; '.wasm' = 'application/wasm'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.webp' = 'image/webp'; '.svg' = 'image/svg+xml'
  '.mp3' = 'audio/mpeg'; '.ogg' = 'audio/ogg'
}

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
function SendJson($ctx, [int]$code, [string]$json) { Send $ctx $code ([Text.Encoding]::UTF8.GetBytes($json)) 'application/json' }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
      if ($path -eq '/__editor/ping') { SendJson $ctx 200 '{"ok":true,"save":true}'; continue }
      if ($path -eq '/__editor/save' -and $ctx.Request.HttpMethod -eq 'POST') {
        $reader = New-Object IO.StreamReader($ctx.Request.InputStream, [Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        try {
          $data = $body | ConvertFrom-Json
          if ($null -eq $data.tracks) { throw 'not a story.json (no "tracks" list)' }
        } catch { SendJson $ctx 400 ('{"ok":false,"error":' + (ConvertTo-Json "$_") + '}'); continue }
        $tmp = "$story.tmp"
        [IO.File]::WriteAllText($tmp, $body, (New-Object Text.UTF8Encoding($false)))
        Move-Item -Force $tmp $story
        Write-Host "  saved story.json ($($body.Length) chars)"
        SendJson $ctx 200 '{"ok":true}'
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
