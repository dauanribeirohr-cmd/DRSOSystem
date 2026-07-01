$ErrorActionPreference = "Stop"

$appPath = "C:\DRSOSystem\DRSOSystem"
$dataRoot = if ($env:DRSO_DATA_DIR) { [System.IO.Path]::GetFullPath($env:DRSO_DATA_DIR) } else { "C:\DRSOStorage" }
$appPathFull = [System.IO.Path]::GetFullPath($appPath).TrimEnd('\')
$dataRootFull = [System.IO.Path]::GetFullPath($dataRoot).TrimEnd('\')

if ($dataRootFull -ieq $appPathFull -or $dataRootFull.StartsWith("$appPathFull\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "DRSO_DATA_DIR deve ficar fora do repositorio. Projeto: $appPathFull. Dados: $dataRootFull."
}

$env:DRSO_DATA_DIR = $dataRootFull
@("data", "uploads", "gallery", "backups", "logs") | ForEach-Object {
    $directory = Join-Path $dataRootFull $_
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
}

Write-Host "Iniciando deploy do DRSOSystem..."
Write-Host "Codigo: $appPathFull"
Write-Host "Dados permanentes: $dataRootFull"
Set-Location -LiteralPath $appPathFull

Write-Host "Atualizando codigo..."
git fetch origin main
git reset --hard origin/main

Write-Host "Parando aplicacao antes de migrar dados..."
schtasks /End /TN "DRSOSystem" 2>$null | Out-Null
Start-Sleep -Seconds 2
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host "Migrando dados legados com backup previo..."
node --no-warnings "$appPathFull\scripts\migrate-storage.mjs"

Write-Host "Instalando dependencias..."
npm install

Write-Host "Reiniciando aplicacao..."
powershell -ExecutionPolicy Bypass -File "$appPathFull\deploy\restart.ps1"

Write-Host "Executando healthcheck..."
powershell -ExecutionPolicy Bypass -File "$appPathFull\deploy\healthcheck.ps1"

Write-Host "Deploy finalizado com sucesso."
