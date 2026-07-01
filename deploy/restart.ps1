$ErrorActionPreference = "Stop"

Write-Host "Reiniciando DRSOSystem..."

schtasks /End /TN "DRSOSystem" | Out-Null
Start-Sleep -Seconds 3

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

Start-Sleep -Seconds 2

schtasks /Run /TN "DRSOSystem" | Out-Null

Start-Sleep -Seconds 5

Write-Host "DRSOSystem reiniciado com sucesso."