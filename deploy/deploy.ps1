$ErrorActionPreference = "Stop"

$appPath = "C:\DRSOSystem\DRSOSystem"

Write-Host "Iniciando deploy do DRSOSystem..."
cd $appPath

Write-Host "Atualizando codigo..."
git fetch origin main
git reset --hard origin/main

Write-Host "Instalando dependencias..."
npm install

Write-Host "Reiniciando aplicacao..."
powershell -ExecutionPolicy Bypass -File "$appPath\deploy\restart.ps1"

Write-Host "Executando healthcheck..."
powershell -ExecutionPolicy Bypass -File "$appPath\deploy\healthcheck.ps1"

Write-Host "Deploy finalizado com sucesso."