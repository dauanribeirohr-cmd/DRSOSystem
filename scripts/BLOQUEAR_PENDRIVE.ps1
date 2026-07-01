$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

Set-Location -Path $PSScriptRoot
$drive = Split-Path -Qualifier $PSScriptRoot

if (-not (Test-IsAdmin)) {
  Write-Host ""
  Write-Host "O Windows vai pedir permissao de administrador para bloquear o pendrive."
  Start-Process powershell -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`""
  )
  exit 0
}

Write-Host ""
Write-Host "Bloqueando pendrive $drive ..."
Write-Host "Primeiro vou encerrar o DRSOSystem para evitar problema no banco de dados."

$stopScript = Join-Path $PSScriptRoot "PARAR_SISTEMA.ps1"
if (Test-Path $stopScript) {
  & $stopScript
}

Start-Sleep -Seconds 1

$manageBde = Join-Path $env:WINDIR "System32\manage-bde.exe"
if (-not (Test-Path $manageBde)) {
  throw "Nao encontrei o manage-bde.exe neste Windows."
}

& $manageBde -lock $drive -ForceDismount
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0) {
  Write-Host "Pendrive bloqueado com sucesso."
  Write-Host "Para usar novamente, abra a unidade $drive e digite a senha do BitLocker."
} else {
  Write-Host "Nao consegui bloquear automaticamente. Codigo: $exitCode"
  Write-Host "Feche janelas abertas do pendrive e tente novamente."
  exit $exitCode
}
