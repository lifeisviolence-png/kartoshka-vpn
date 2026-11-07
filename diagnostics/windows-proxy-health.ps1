# KartoshkaVPN: read-only diagnostic. Does not change proxy, DNS, routes, or registry.
# Run as the affected Windows user (no administrator privileges needed):
# powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-proxy-health.ps1
# Add -CheckInternet only while connected to perform an HTTPS request through the local proxy.
param([switch]$CheckInternet)
$ErrorActionPreference = 'Stop'
$settingsPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Write-Output 'KartoshkaVPN — проверка системного прокси (только чтение)'
Write-Output "Время: $((Get-Date).ToString('s'))"
try {
  $settings = Get-ItemProperty -Path $settingsPath
  $server = [string]$settings.ProxyServer
  $isLocal = $server -match '(^|[=; ])127\.0\.0\.1:2080($|[; ])'
  Write-Output "Системный прокси включён: $([bool]$settings.ProxyEnable)"
  Write-Output "Адрес системного прокси KartoshkaVPN: $isLocal"
  Write-Output "Автоконфигурация прокси (PAC) задана: $(-not [string]::IsNullOrWhiteSpace([string]$settings.AutoConfigURL))"
  Write-Output "Автообнаружение прокси: $([bool]$settings.AutoDetect)"
} catch {
  Write-Output "Не удалось прочитать параметры Windows: $($_.Exception.Message)"
}
try {
  $listeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 2080 -State Listen -ErrorAction SilentlyContinue)
  Write-Output "Локальный порт 2080 слушается: $($listeners.Count -gt 0)"
  foreach ($listener in $listeners) {
    $p = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($p) { Write-Output "Процесс-владелец порта: $($p.ProcessName), PID $($p.Id)" }
  }
} catch { Write-Output "Не удалось проверить владельца порта: $($_.Exception.Message)" }
if ($CheckInternet) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Proxy 'http://127.0.0.1:2080' -Uri 'https://api.ipify.org' -TimeoutSec 12
    [System.Net.IPAddress]$parsed = $null
    $valid = ($response.StatusCode -eq 200) -and [System.Net.IPAddress]::TryParse($response.Content.Trim(), [ref]$parsed)
    Write-Output "HTTPS-запрос через локальный прокси выполнен: $valid"
    Write-Output 'Внешний IP не выводится в отчёт.'
  } catch { Write-Output "HTTPS-запрос через локальный прокси не прошёл: $($_.Exception.GetType().Name)" }
}
Write-Output 'Диагностика не записывает subscription URL, адреса серверов, имена сетей, внешний IP или пароли.'
