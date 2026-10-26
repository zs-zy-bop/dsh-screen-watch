param(
  [string]$ImagePath = "D:\dsh-video-tools\striptest\m.jpg.strip.jpg",
  [switch]$NoBinary
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8


Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

# 小图（比如右侧那列数字）先在内存里放大，OCR 才认得清
if ($bitmap.PixelWidth -lt 400) {
  $scale = [Math]::Min(6.0, 1200.0 / [Math]::Max(1, $bitmap.PixelWidth))
  $src = [System.Drawing.Image]::FromFile($ImagePath)
  $big = New-Object System.Drawing.Bitmap ([int]($src.Width * $scale)), ([int]($src.Height * $scale))
  $gfx = [System.Drawing.Graphics]::FromImage($big)
  $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gfx.DrawImage($src, 0, 0, $big.Width, $big.Height)
  $gfx.Dispose()
  $src.Dispose()

  # 二值化：把压在画面上的半透明字抠成黑白，OCR 才不会把一个字拆两半
  if (-not $NoBinary) {
  $lumaSum = 0.0
  for ($yy = 0; $yy -lt $big.Height; $yy += 2) {
    for ($xx = 0; $xx -lt $big.Width; $xx += 2) {
      $c = $big.GetPixel($xx, $yy)
      $lumaSum += (0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
    }
  }
  $count = [Math]::Max(1, [int]([Math]::Ceiling($big.Width / 2.0) * [Math]::Ceiling($big.Height / 2.0)))
  $mean = $lumaSum / $count
  $threshold = [Math]::Max(70, [Math]::Min(200, $mean + 25))
  for ($yy = 0; $yy -lt $big.Height; $yy++) {
    for ($xx = 0; $xx -lt $big.Width; $xx++) {
      $c = $big.GetPixel($xx, $yy)
      $luma = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
      if ($luma -ge $threshold) { $big.SetPixel($xx, $yy, [System.Drawing.Color]::White) }
      else { $big.SetPixel($xx, $yy, [System.Drawing.Color]::Black) }
    }
  }
  }
  $tmpPath = [System.IO.Path]::ChangeExtension($ImagePath, ".big.jpg")
  $big.Save($tmpPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $big.Dispose()
  $file2 = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmpPath)) ([Windows.Storage.StorageFile])
  $stream2 = Await ($file2.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $decoder2 = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream2)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder2.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
}

$langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
Write-Output ("可用 OCR 语言: " + (($langs | ForEach-Object { $_.LanguageTag }) -join ', '))

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Output '{"ok":false,"error":"no ocr engine"}'; exit 0 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$text = ($result.Lines | ForEach-Object { $_.Text }) -join ' | '
$out = [ordered]@{ ok = $true; text = $text; lines = $result.Lines.Count }
Write-Output ($out | ConvertTo-Json -Compress)
