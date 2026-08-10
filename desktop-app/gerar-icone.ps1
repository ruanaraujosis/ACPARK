# Gera o icone do aplicativo (icone.ico) a partir da logo do sistema.
# Uso: powershell -ExecutionPolicy Bypass -File gerar-icone.ps1
Add-Type -AssemblyName System.Drawing

$srcPath = Join-Path $PSScriptRoot "..\public\logo-print.png"
$outPath = Join-Path $PSScriptRoot "icone.ico"
$sizes = @(16, 24, 32, 48, 64, 128, 256)

$srcImage = [System.Drawing.Image]::FromFile((Resolve-Path $srcPath))

# Redimensiona mantendo proporcao, centralizado num quadrado transparente
function Resize-Square($image, $size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $ratio = [Math]::Min($size / $image.Width, $size / $image.Height)
    $w = [int]($image.Width * $ratio)
    $h = [int]($image.Height * $ratio)
    $x = [int](($size - $w) / 2)
    $y = [int](($size - $h) / 2)
    $g.DrawImage($image, $x, $y, $w, $h)
    $g.Dispose()
    return $bmp
}

$pngFrames = @()
foreach ($size in $sizes) {
    $bmp = Resize-Square $srcImage $size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngFrames += ,@{ Size = $size; Bytes = $ms.ToArray() }
    $bmp.Dispose()
}

# Monta o arquivo .ico manualmente (ICONDIR + ICONDIRENTRY[] + dados PNG de cada frame)
$fs = [System.IO.File]::Open($outPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)

$bw.Write([UInt16]0)      # reservado
$bw.Write([UInt16]1)      # tipo = icone
$bw.Write([UInt16]$pngFrames.Count)

$offset = 6 + (16 * $pngFrames.Count)
foreach ($frame in $pngFrames) {
    $dim = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
    $bw.Write([byte]$dim)          # largura (0 = 256)
    $bw.Write([byte]$dim)          # altura
    $bw.Write([byte]0)             # paleta de cores
    $bw.Write([byte]0)             # reservado
    $bw.Write([UInt16]1)           # planos de cor
    $bw.Write([UInt16]32)          # bits por pixel
    $bw.Write([UInt32]$frame.Bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $frame.Bytes.Length
}
foreach ($frame in $pngFrames) {
    $bw.Write($frame.Bytes)
}

$bw.Close()
$fs.Close()
$srcImage.Dispose()

Write-Output "Icone criado: $outPath"
