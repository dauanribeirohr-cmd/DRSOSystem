$ErrorActionPreference = "Stop"
$dataRoot = if ($env:DRSO_DATA_DIR) { [System.IO.Path]::GetFullPath($env:DRSO_DATA_DIR) } else { "C:\DRSOStorage" }
$env:DRSO_DATA_DIR = $dataRoot

@("data", "uploads", "gallery", "backups", "logs") | ForEach-Object {
    $directory = Join-Path $dataRoot $_
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
}

Write-Host "Reiniciando DRSOSystem..."
Write-Host "Dados permanentes: $dataRoot"

schtasks /End /TN "DRSOSystem" | Out-Null
Start-Sleep -Seconds 3

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

Start-Sleep -Seconds 2

schtasks /Run /TN "DRSOSystem" | Out-Null

Start-Sleep -Seconds 5

Write-Host "DRSOSystem reiniciado com sucesso."
