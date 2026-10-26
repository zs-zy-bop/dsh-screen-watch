param(
  [string]$Files = "",
  [string]$Out = "",
  [int]$Cols = 5,
  [int]$Rows = 6,
  [int]$TileWidth = 320
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not $Files) { throw "missing -Files" }
if (-not $Out) { throw "missing -Out" }

$list = Get-Content $Files -Encoding UTF8 | Where-Object { $_ -and (Test-Path $_) }
if (-not $list) { Write-Output '{"ok":false,"error":"no frames"}'; exit 0 }

$per = $Cols * $Rows
$sheets = @()
$index = 0
$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$base = [System.IO.Path]::GetFileNameWithoutExtension($Out)

for ($start = 0; $start -lt $list.Count; $start += $per) {
  $chunk = $list[$start..([Math]::Min($start + $per - 1, $list.Count - 1))]
  $first = [System.Drawing.Image]::FromFile($chunk[0])
  $tw = [int]($TileWidth)
  $th = [int]($first.Height * $tw / $first.Width)
  $first.Dispose()

  $canvas = New-Object System.Drawing.Bitmap ($tw * $Cols), ($th * $Rows)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.Clear([System.Drawing.Color]::FromArgb(14, 14, 16))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $font = New-Object System.Drawing.Font "Consolas", 10
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $back = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 0, 0, 0))

  for ($i = 0; $i -lt $chunk.Count; $i++) {
    $img = [System.Drawing.Image]::FromFile($chunk[$i])
    $x = ($i % $Cols) * $tw
    $y = [Math]::Floor($i / $Cols) * $th
    $g.DrawImage($img, $x, $y, $tw, $th)
    $img.Dispose()
    $name = [System.IO.Path]::GetFileNameWithoutExtension($chunk[$i])
    $label = $name
    if ($name -match '^\d+$') {
      $label = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$name).ToLocalTime().ToString("HH:mm:ss")
    }
    $g.FillRectangle($back, $x + 4, $y + 4, 62, 18)
    $g.DrawString($label, $font, $brush, ($x + 6), ($y + 5))
  }

  $index++
  $path = Join-Path $dir ("{0}_{1:d2}.jpg" -f $base, $index)
  $canvas.Save($path, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $g.Dispose()
  $canvas.Dispose()
  $sheets += $path
}

$result = [ordered]@{ ok = $true; sheets = $sheets; tiles = $list.Count }
Write-Output ($result | ConvertTo-Json -Compress)
