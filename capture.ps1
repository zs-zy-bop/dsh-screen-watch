param(
  [string]$Process = "douyin",
  [string]$Out = "",
  [int]$MaxWidth = 0,
  [int]$Loop = 0,
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

if (-not $Out) { throw "missing -Out" }

$script:best = [IntPtr]::Zero
$script:bestArea = 0
$pnames = @{}
Get-Process | ForEach-Object { $pnames[[int]$_.Id] = $_.ProcessName.ToLower() }

$cb = {
  param($h, $l)
  $procId = 0
  [WinCap]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  $pname = $pnames[[int]$procId]
  if ($pname -and ($pname -like "*$Process*" -or $pname -eq "douyin")) {
    $r = New-Object WinCap+RECT
    [WinCap]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -gt 300 -and $hh -gt 300) {
      $area = $w * $hh
      if ($area -gt $script:bestArea) {
        $script:bestArea = $area
        $script:best = $h
      }
    }
  }
  return $true
}

function Get-TargetWindow {
  $script:best = [IntPtr]::Zero
  $script:bestArea = 0
  [WinCap]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:best
}

function Get-DHash($bmp, $x, $y, $wid, $hei) {
  $thumb = New-Object System.Drawing.Bitmap 9, 8
  $g = [System.Drawing.Graphics]::FromImage($thumb)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $dest = New-Object System.Drawing.Rectangle 0, 0, 9, 8
  $src = New-Object System.Drawing.Rectangle $x, $y, $wid, $hei
  $g.DrawImage($bmp, $dest, $src, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $h = [uint64]0
  $sum = 0
  for ($yy = 0; $yy -lt 8; $yy++) {
    for ($xx = 0; $xx -lt 8; $xx++) {
      $l = $thumb.GetPixel($xx, $yy).R
      $r = $thumb.GetPixel($xx + 1, $yy).R
      $sum += $l
      $h = $h -shl 1
      if ($l -gt $r) { $h = $h -bor 1 }
    }
  }
  $thumb.Dispose()
  return @{ hash = $h; brightness = [int]($sum / 64) }
}

function Capture-One {
  $hwnd = Get-TargetWindow
  if ($hwnd -eq [IntPtr]::Zero) {
    return [ordered]@{ ok = $false; error = "window not found" }
  }

  $rect = New-Object WinCap+RECT
  [WinCap]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top

  $hdc = [WinCap]::GetWindowDC($hwnd)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $hdcDest = $gfx.GetHdc()
  [WinCap]::PrintWindow($hwnd, $hdcDest, 2) | Out-Null
  $gfx.ReleaseHdc($hdcDest)
  $gfx.Dispose()
  [WinCap]::ReleaseDC($hwnd, $hdc) | Out-Null

  $dir = Split-Path $Out -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $whole = Get-DHash $bmp 0 0 $w $h
  $sw = [int]($w * 0.45)
  $sh = [int]($h * 0.13)
  $sy = [int]($h * 0.86)
  if ($sw -gt 20 -and $sh -gt 20) {
    $strip = Get-DHash $bmp 0 $sy $sw $sh
    # 顺手把底部作者/标题那条存下来，换片时用来核对是不是同一条视频
    try {
      $crop = New-Object System.Drawing.Bitmap $sw, $sh
      $gc = [System.Drawing.Graphics]::FromImage($crop)
      $dest = New-Object System.Drawing.Rectangle 0, 0, $sw, $sh
      $srcRect = New-Object System.Drawing.Rectangle 0, $sy, $sw, $sh
      $gc.DrawImage($bmp, $dest, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
      $gc.Dispose()
      $crop.Save(($Out + ".strip.jpg"), [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $crop.Dispose()
    } catch {
      [Console]::Error.WriteLine("strip failed: " + $_.Exception.Message)
    }
  } else {
    $strip = @{ hash = 0; brightness = 0 }
  }

  # 右侧那列点赞/评论/收藏/转发的数字：同一条视频里不变，换条才会变
  try {
    $rw = [int]($w * 0.09)
    $rh = [int]($h * 0.42)
    $rx = [int]($w * 0.905)
    $ry = [int]($h * 0.22)
    if ($rw -gt 20 -and $rh -gt 20 -and ($rx + $rw) -le $w) {
      $rail = New-Object System.Drawing.Bitmap $rw, $rh
      $gr = [System.Drawing.Graphics]::FromImage($rail)
      $rd = New-Object System.Drawing.Rectangle 0, 0, $rw, $rh
      $rs = New-Object System.Drawing.Rectangle $rx, $ry, $rw, $rh
      $gr.DrawImage($bmp, $rd, $rs, [System.Drawing.GraphicsUnit]::Pixel)
      $gr.Dispose()
      $rail.Save(($Out + ".rail.jpg"), [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $railHash = Get-DHash $rail 0 0 $rw $rh
      $rail.Dispose()
    }
  } catch {
    # 存不下来不影响主流程
  }

  # 左下角那行 "播放时间 / 总时长"：单独裁一条，字大、背景黑，OCR 最稳
  try {
    $tw = [int]($w * 0.13)
    $th = [int]($h * 0.05)
    $tx = [int]($w * 0.005)
    $ty = [int]($h * 0.935)
    if ($tw -gt 40 -and $th -gt 10 -and ($tx + $tw) -le $w -and ($ty + $th) -le $h) {
      $timer = New-Object System.Drawing.Bitmap $tw, $th
      $gt2 = [System.Drawing.Graphics]::FromImage($timer)
      $td = New-Object System.Drawing.Rectangle 0, 0, $tw, $th
      $ts = New-Object System.Drawing.Rectangle $tx, $ty, $tw, $th
      $gt2.DrawImage($bmp, $td, $ts, [System.Drawing.GraphicsUnit]::Pixel)
      $gt2.Dispose()
      $timer.Save(($Out + ".timer.jpg"), [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $timer.Dispose()
    }
  } catch {
    # 存不下来不影响主流程
  }

  $final = $bmp
  if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
    $nh = [int]($h * $MaxWidth / $w)
    $small = New-Object System.Drawing.Bitmap $MaxWidth, $nh
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $MaxWidth, $nh)
    $g2.Dispose()
    $final = $small
  }
  $final.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $final.Dispose()
  $bmp.Dispose()

  return [ordered]@{
    ok = $true
    file = $Out
    hash = [string]$whole.hash
    metaHash = [string]$strip.hash
    railHash = if ($railHash) { [string]$railHash.hash } else { "" }
    brightness = $whole.brightness
  }
}

if ($Loop -gt 0) {
  while ($true) {
    try {
      $r = Capture-One
    } catch {
      $r = [ordered]@{ ok = $false; error = $_.Exception.Message }
    }
    Write-Output ($r | ConvertTo-Json -Compress)
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds $IntervalMs
  }
} else {
  $r = Capture-One
  Write-Output ($r | ConvertTo-Json -Compress)
}
