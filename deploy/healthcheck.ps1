$ErrorActionPreference = "Stop"

Write-Host "Verificando se o DRSOSystem respondeu..."

$maxTentativas = 10
$tentativa = 1

while ($tentativa -le $maxTentativas) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1" -UseBasicParsing -TimeoutSec 10

        if ($response.StatusCode -eq 200) {
            Write-Host "DRSOSystem respondeu HTTP 200. Sistema online."
            exit 0
        }
    } catch {
        Write-Host "Tentativa $tentativa/$maxTentativas falhou. Aguardando..."
        Start-Sleep -Seconds 3
    }

    $tentativa++
}

throw "DRSOSystem não respondeu depois do deploy."