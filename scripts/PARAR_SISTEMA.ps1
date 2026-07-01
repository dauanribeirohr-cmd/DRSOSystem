$ErrorActionPreference = "SilentlyContinue"
$scriptDir = $PSScriptRoot
$appRoot = if ((Split-Path -Leaf $scriptDir) -ieq "scripts") { Split-Path -Parent $scriptDir } else { $scriptDir }
Set-Location -Path $appRoot

$port = if ($env:PORT) { [int]$env:PORT } else { 3334 }
$dataRoot = if ($env:DRSO_DATA_DIR) { [System.IO.Path]::GetFullPath($env:DRSO_DATA_DIR) } else { "C:\DRSOStorage" }
$pidFile = Join-Path $dataRoot "logs\drsosystem-server.pid"

Write-Host ""
Write-Host "Encerrando DRSOSystem..."

$processIds = New-Object System.Collections.Generic.HashSet[int]

if (Test-Path $pidFile) {
  $savedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($savedPid -match '^\d+$') {
    [void]$processIds.Add([int]$savedPid)
  }
}

try {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { [void]$processIds.Add([int]$_.OwningProcess) }
} catch {
  netstat -ano | Select-String "LISTENING" | ForEach-Object {
    $text = $_.ToString()
    if ($text -match "[:.]$port\s+.*LISTENING\s+(\d+)\s*$") {
      [void]$processIds.Add([int]$matches[1])
    }
  }
}

if ($processIds.Count -eq 0) {
  Write-Host "Nenhum servidor DRSOSystem rodando na porta $port."
  if (Test-Path $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force
  }
  Write-Host "Voce ja pode tentar ejetar o pendrive com seguranca."
  exit 0
}

foreach ($id in $processIds) {
  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $process) { continue }

  Write-Host "Parando processo $id..."
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

if (Test-Path $pidFile) {
  Remove-Item -LiteralPath $pidFile -Force
}

$stillOpen = $false
try {
  $stillOpen = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
} catch {
  $stillOpen = [bool](netstat -ano | Select-String "[:.]$port\s+.*LISTENING")
}

if ($stillOpen) {
  Write-Host ""
  Write-Host "Ainda existe algo usando a porta $port."
  Write-Host "Feche janelas antigas do sistema ou tente executar este arquivo novamente."
  exit 1
}

Write-Host ""
Write-Host "DRSOSystem encerrado."
Write-Host "Agora voce pode ejetar o pendrive com seguranca."
