$ErrorActionPreference = "Stop"

$hostsPath = "$env:WINDIR\System32\drivers\etc\hosts"
$entry = "127.0.0.1 drsosystem.local"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host ""
  Write-Host "Abra este arquivo como Administrador para configurar o endereco local."
  Write-Host "Depois de configurar uma vez, o start.bat e o start.ps1 ja abrem em:"
  Write-Host "http://drsosystem.local:3333"
  Write-Host ""
  Read-Host "Pressione Enter para sair"
  exit 1
}

$content = Get-Content -LiteralPath $hostsPath -Raw -ErrorAction Stop
if ($content -notmatch '(?m)^\s*127\.0\.0\.1\s+drsosystem\.local\s*$') {
  Add-Content -LiteralPath $hostsPath -Value "`r`n# DRSOSystem local`r`n$entry"
  Write-Host "Endereco configurado com sucesso:"
} else {
  Write-Host "Endereco ja estava configurado:"
}

try {
  ipconfig /flushdns | Out-Null
} catch {}

try {
  netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=80 | Out-Null
  netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=80 connectaddress=127.0.0.1 connectport=3333 | Out-Null
  Write-Host "Redirecionamento local configurado:"
  Write-Host "http://drsosystem.local"
} catch {
  Write-Host "Endereco local configurado, mas nao foi possivel configurar a porta 80."
  Write-Host "Use:"
  Write-Host "http://drsosystem.local:3333"
}

Write-Host ""
Read-Host "Pressione Enter para sair"
