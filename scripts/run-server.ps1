param(
  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [Parameter(Mandatory = $true)]
  [string]$AppRoot,

  [Parameter(Mandatory = $true)]
  [int]$Port,

  [Parameter(Mandatory = $true)]
  [string]$LogOut,

  [Parameter(Mandatory = $true)]
  [string]$LogErr
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $AppRoot
$env:PORT = [string]$Port

try {
  & $NodePath --no-warnings "server/index.mjs" 1>> $LogOut 2>> $LogErr
} catch {
  $_ | Out-String | Add-Content -LiteralPath $LogErr -Encoding UTF8
  exit 1
}
