$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "Liberando DRSOSystem para acesso pelo celular..."
Write-Host ""

try {
  New-NetFirewallRule `
    -DisplayName "DRSOSystem porta 3334" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 3334 `
    -Profile Any `
    -ErrorAction SilentlyContinue | Out-Null
} catch {
  netsh advfirewall firewall add rule name="DRSOSystem porta 3334" dir=in action=allow protocol=TCP localport=3334 profile=any | Out-Null
}

try {
  Get-NetConnectionProfile |
    Where-Object { $_.InterfaceAlias -like "Ethernet*" -and $_.IPv4Connectivity -ne "NoTraffic" } |
    Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue
} catch {
}

$ip = $null
try {
  $ip = Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address.IPAddress -match '^192\.168\.|^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.' } |
    Select-Object -ExpandProperty IPv4Address -First 1 |
    Select-Object -ExpandProperty IPAddress
} catch {
}

Write-Host ""
Write-Host "Pronto."
if ($ip) {
  Write-Host "No celular, abra: http://$ip`:3334"
} else {
  Write-Host "No celular, abra o IP do computador na porta 3334."
}
Write-Host ""
Read-Host "Pressione Enter para fechar"
