$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$appRoot = if ((Split-Path -Leaf $scriptDir) -ieq "scripts") { Split-Path -Parent $scriptDir } else { $scriptDir }
Set-Location -Path $appRoot

$dataRoot = if ($env:DRSO_DATA_DIR) { [System.IO.Path]::GetFullPath($env:DRSO_DATA_DIR) } else { "C:\DRSOStorage" }
$appRootFull = [System.IO.Path]::GetFullPath($appRoot).TrimEnd('\')
if ($dataRoot.TrimEnd('\').StartsWith("$appRootFull\", [System.StringComparison]::OrdinalIgnoreCase) -or $dataRoot.TrimEnd('\') -ieq $appRootFull) {
  throw "DRSO_DATA_DIR deve ficar fora da pasta do projeto. Dados: $dataRoot"
}
$env:DRSO_DATA_DIR = $dataRoot

$port = if ($env:PORT) { [int]$env:PORT } else { 3333 }
$requestedPort = $port
$openBrowser = $env:DRSO_NO_BROWSER -ne "1"
$detachServer = $env:DRSO_DETACH -eq "1"
$closeDriveWindows = $env:DRSO_CLOSE_DRIVE_WINDOWS -eq "1"
$nodeCandidates = @(
  (Join-Path $appRoot "runtime\node\node.exe"),
  (Join-Path $appRoot "node\node.exe"),
  "$env:ProgramFiles\nodejs\node.exe",
  "${env:ProgramFiles(x86)}\nodejs\node.exe"
) | Where-Object { $_ -and (Test-Path $_) }

$nodeExe = $nodeCandidates | Select-Object -First 1

if (-not $nodeExe) {
  Write-Host ""
  Write-Host "Node.js nao foi encontrado dentro do pendrive nem instalado na maquina."
  Write-Host "Deixe a pasta completa do projeto junto com a pasta runtime\node."
  Write-Host ""
  Read-Host "Pressione Enter para sair"
  exit 1
}

$logDir = Join-Path $dataRoot "logs"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

$logOut = Join-Path $logDir "server.log"
$logErr = Join-Path $logDir "server.err.log"
$pidFile = Join-Path $logDir "drsosystem-server.pid"
try {
  Set-Content -Path $logOut -Value "" -Encoding UTF8 -ErrorAction Stop
  Set-Content -Path $logErr -Value "" -Encoding UTF8 -ErrorAction Stop
} catch {
  $logStamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $logOut = Join-Path $logDir "server-$logStamp.log"
  $logErr = Join-Path $logDir "server-$logStamp.err.log"
  Set-Content -Path $logOut -Value "" -Encoding UTF8
  Set-Content -Path $logErr -Value "" -Encoding UTF8
}

function Test-DrsoLocalHostConfigured {
  $hostsPath = "$env:WINDIR\System32\drivers\etc\hosts"
  if (-not (Test-Path $hostsPath)) {
    return $false
  }
  try {
    $content = Get-Content -LiteralPath $hostsPath -Raw -ErrorAction Stop
    return $content -match '(?m)^\s*127\.0\.0\.1\s+drsosystem\.local\s*$'
  } catch {
    return $false
  }
}

function Ensure-DrsoLocalHost {
  if (Test-DrsoLocalHostConfigured) {
    return $true
  }

  $configScript = Join-Path $appRoot "scripts\configurar-drsosystem-local.ps1"
  if (-not (Test-Path $configScript)) {
    return $false
  }

  Write-Host ""
  Write-Host "Configurando endereco local drsosystem.local nesta maquina..."
  Write-Host "O Windows pode pedir permissao de administrador apenas uma vez."
  Write-Host ""

  try {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", "`"$configScript`""
    )
  } catch {
    return $false
  }

  return Test-DrsoLocalHostConfigured
}

$localHostReady = Ensure-DrsoLocalHost
$displayUrl = if ($port -ne 3333) { "http://127.0.0.1:$port" } elseif ($localHostReady) { "http://drsosystem.local" } else { "http://127.0.0.1:$port" }
$lanIp = $null
try {
  $lanIp = Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address.IPAddress -match '^192\.168\.|^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.' } |
    Select-Object -ExpandProperty IPv4Address -First 1 |
    Select-Object -ExpandProperty IPAddress
} catch {
  $lanIp = $null
}
$mobileUrl = if ($lanIp) { "http://$lanIp`:$port" } else { "" }
if (-not $localHostReady) {
  Write-Host ""
  Write-Host "Nao foi possivel configurar drsosystem.local agora."
  Write-Host "O sistema vai abrir pelo endereco antigo nesta execucao."
  Write-Host "Para corrigir, execute configurar-drsosystem-local.bat como administrador."
  Write-Host ""
}

Write-Host "Iniciando DRSOSystem em $displayUrl ..."
if ($mobileUrl) {
  Write-Host "No celular, use: $mobileUrl"
}
Write-Host "Dados permanentes: $dataRoot"
Write-Host "Logs: $logOut e $logErr"

function Test-PortOpen {
  param(
    [string]$HostName,
    [int]$PortNumber,
    [int]$TimeoutMs = 200
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $iar = $client.BeginConnect($HostName, $PortNumber, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) {
      return $false
    }
    $client.EndConnect($iar)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Test-ServerSupportsPasswordVault {
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  try {
    Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:$port/api/auth/login" `
      -Method Post `
      -Body '{"username":"drs","password":"32083060"}' `
      -ContentType "application/json" `
      -WebSession $session `
      -TimeoutSec 2 `
      -ErrorAction Stop | Out-Null

    Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:$port/api/passwords/auth" `
      -Method Post `
      -Body '{"password":"32083060"}' `
      -ContentType "application/json" `
      -WebSession $session `
      -TimeoutSec 2 `
      -ErrorAction Stop | Out-Null
    return $true
  } catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
      return $false
    }
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 200) {
      return $true
    }
    return $true
  }
}

function Test-ServerSupportsTwofaVault {
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  try {
    Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:$port/api/auth/login" `
      -Method Post `
      -Body '{"username":"drs","password":"32083060"}' `
      -ContentType "application/json" `
      -WebSession $session `
      -TimeoutSec 2 `
      -ErrorAction Stop | Out-Null
    Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:$port/api/2fa/status" `
      -WebSession $session `
      -TimeoutSec 2 `
      -ErrorAction Stop | Out-Null
    Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:$port/api/2fa/totp" `
      -WebSession $session `
      -TimeoutSec 2 `
      -ErrorAction Stop | Out-Null
    return $true
  } catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
      return $false
    }
    return $true
  }
}

function Get-DrsoListeningProcessIds {
  $ids = @()
  $lines = netstat -ano | Select-String "LISTENING"
  foreach ($line in $lines) {
    $text = $line.ToString()
    if ($text -match "[:.]$port\s+.*LISTENING\s+(\d+)\s*$") {
      $ids += [int]$matches[1]
    }
  }
  return $ids | Select-Object -Unique
}

function Close-DrsoExplorerWindows {
  $root = (Resolve-Path -LiteralPath $appRoot).Path.TrimEnd("\")
  $rootPrefix = "$root\"
  $driveRoot = [System.IO.Path]::GetPathRoot($root)
  if (-not $driveRoot) { return }
  $closedAny = $false

  function Convert-ExplorerLocationToPath {
    param([object]$Window)
    $paths = @()
    try {
      $folderPath = [string]$Window.Document.Folder.Self.Path
      if ($folderPath) { $paths += $folderPath }
    } catch {}
    try {
      $locationUrl = [string]$Window.LocationURL
      if ($locationUrl -and $locationUrl.StartsWith("file:///", [System.StringComparison]::OrdinalIgnoreCase)) {
        $localPath = [System.Uri]::UnescapeDataString($locationUrl.Replace("file:///", "").Replace("/", "\"))
        if ($localPath -match "^[A-Za-z]:\\") { $paths += $localPath }
      }
    } catch {}
    return $paths | Where-Object { $_ } | Select-Object -Unique
  }

  function Test-PathShouldClose {
    param([string]$Path)
    if (-not $Path) { return $false }
    $normalized = $Path.TrimEnd("\")
    $driveNormalized = $driveRoot.TrimEnd("\")
    return $normalized.Equals($root, [System.StringComparison]::OrdinalIgnoreCase) -or
      $normalized.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
      $normalized.Equals($driveNormalized, [System.StringComparison]::OrdinalIgnoreCase) -or
      $normalized.Equals($driveRoot, [System.StringComparison]::OrdinalIgnoreCase)
  }

  try {
    $shell = New-Object -ComObject Shell.Application
    foreach ($window in @($shell.Windows())) {
      try {
        $paths = Convert-ExplorerLocationToPath -Window $window
        if ($paths | Where-Object { Test-PathShouldClose -Path $_ }) {
          $window.Quit()
          $closedAny = $true
        }
      } catch {
        continue
      }
    }
  } catch {
    $closedAny = $false
  }

  if (-not $closedAny) {
    try {
      Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 700
      Start-Process explorer.exe | Out-Null
    } catch {
      Write-Host "Nao foi possivel fechar automaticamente as pastas abertas."
    }
  }
}

if (Test-PortOpen -HostName "127.0.0.1" -PortNumber $port -TimeoutMs 500) {
  if ((-not (Test-ServerSupportsPasswordVault)) -or (-not (Test-ServerSupportsTwofaVault))) {
    Write-Host "Servidor antigo detectado. Reiniciando para carregar os cofres..."
    Get-DrsoListeningProcessIds | ForEach-Object {
      Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    if (Test-PortOpen -HostName "127.0.0.1" -PortNumber $port -TimeoutMs 500) {
      $oldPort = $port
      foreach ($candidatePort in (($oldPort + 1)..($oldPort + 20))) {
        if (-not (Test-PortOpen -HostName "127.0.0.1" -PortNumber $candidatePort -TimeoutMs 200)) {
          $port = $candidatePort
          $env:PORT = [string]$port
          Write-Host "Nao foi possivel fechar a porta $oldPort. Abrindo uma nova execucao em http://127.0.0.1:$port ..."
          break
        }
      }
    }
  } else {
  $appUrl = if ($port -ne 3333) {
    "http://127.0.0.1:$port"
  } elseif ($localHostReady -and (Test-PortOpen -HostName "drsosystem.local" -PortNumber 80 -TimeoutMs 600)) {
    "http://drsosystem.local"
  } elseif ($localHostReady) {
    "http://drsosystem.local:$port"
  } else {
    "http://127.0.0.1:$port"
  }
  if ($openBrowser) {
    Write-Host "DRSOSystem ja esta rodando. Abrindo $appUrl ..."
  } else {
    Write-Host "DRSOSystem ja esta rodando."
    Write-Host "Sistema esta no ar: $appUrl"
  }
  if ($mobileUrl) {
    Write-Host "No celular, use: $mobileUrl"
  }
  if ($openBrowser) {
    Start-Process $appUrl | Out-Null
  }
  if ($closeDriveWindows) {
    Close-DrsoExplorerWindows
  }
  exit 0
  }
}

try {
  $server = Start-Process -FilePath $nodeExe `
    -ArgumentList @("--no-warnings", "server/index.mjs") `
    -WorkingDirectory $appRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr `
    -PassThru
} catch {
  if ($_.Exception.Message -notmatch "Path|PATH") {
    throw
  }
  Write-Host "Aviso: Windows retornou variavel Path duplicada. Iniciando com metodo alternativo..."
  $runner = Join-Path $appRoot "scripts\run-server.ps1"
  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = "powershell.exe"
  $processInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -NodePath `"$nodeExe`" -AppRoot `"$appRoot`" -Port $port -LogOut `"$logOut`" -LogErr `"$logErr`""
  $processInfo.WorkingDirectory = $appRoot
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $server = [System.Diagnostics.Process]::new()
  $server.StartInfo = $processInfo
  [void]$server.Start()
}

Set-Content -Path $pidFile -Value ([string]$server.Id) -Encoding ASCII

$deadline = (Get-Date).AddSeconds(30)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if ($server.HasExited) {
    break
  }
  if (Test-PortOpen -HostName "127.0.0.1" -PortNumber $port) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 300
}

if (-not $ready) {
  if (-not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }

  Write-Host ""
  Write-Host "O servidor nao chegou a abrir a porta $port."
  Write-Host "Veja o conteudo de $logErr para o motivo."
  Write-Host ""
  Get-Content -Path $logErr -ErrorAction SilentlyContinue | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
  Read-Host "Pressione Enter para sair"
  exit 1
}

$appUrl = if ($port -ne 3333) {
  "http://127.0.0.1:$port"
} elseif ($localHostReady -and (Test-PortOpen -HostName "drsosystem.local" -PortNumber 80 -TimeoutMs 600)) {
  "http://drsosystem.local"
} elseif ($localHostReady) {
  "http://drsosystem.local:$port"
} else {
  "http://127.0.0.1:$port"
}

if ($openBrowser) {
  Start-Process $appUrl | Out-Null
} else {
  Write-Host ""
  Write-Host "Sistema esta no ar."
  Write-Host "No computador: $appUrl"
  if ($mobileUrl) {
    Write-Host "No celular: $mobileUrl"
  }
  if (-not $detachServer) {
    Write-Host "Deixe esta janela aberta enquanto estiver usando o DRSOSystem."
  }
  Write-Host ""
}

if ($detachServer) {
  if ($closeDriveWindows) {
    Close-DrsoExplorerWindows
  }
  Write-Host "Servidor iniciado em segundo plano. Esta janela sera fechada."
  exit 0
}

try {
  Wait-Process -Id $server.Id
} finally {
  if (Test-Path $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
}

$server.Refresh()
if ($server.ExitCode -ne 0) {
  Write-Host ""
  Write-Host "O servidor foi encerrado com erro."
  Write-Host "Veja o conteudo de $logErr para o motivo."
  Write-Host ""
  Get-Content -Path $logErr -ErrorAction SilentlyContinue | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
}
