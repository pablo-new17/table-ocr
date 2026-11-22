# 產生 icon-192.png 與 icon-512.png（跟 icon.svg 同樣的圖案）。
# 用法：powershell -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot

foreach ($size in 192, 512) {
    $s = $size / 512.0
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::FromArgb(0x1f, 0x6f, 0xeb))
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (22 * $s)
    $g.DrawRectangle($pen, 96 * $s, 128 * $s, 320 * $s, 256 * $s)
    $g.DrawLine($pen, 96 * $s, 213 * $s, 416 * $s, 213 * $s)
    $g.DrawLine($pen, 96 * $s, 299 * $s, 416 * $s, 299 * $s)
    $g.DrawLine($pen, 256 * $s, 128 * $s, 256 * $s, 384 * $s)
    $out = Join-Path $root "icon-$size.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $pen.Dispose()
    Write-Output "已產生 $out"
}
