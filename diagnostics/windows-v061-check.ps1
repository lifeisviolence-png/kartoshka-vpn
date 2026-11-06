param(
  [string]$Proxy = 'http://127.0.0.1:2080'
)
$ErrorActionPreference = 'Stop'
Write-Host 'KartoshkaVPN v0.6.1 Windows proxy check'
Write-Host "Proxy: $Proxy"
$connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 2080 -State Listen -ErrorAction SilentlyContinue
if (-not $connection) { throw '127.0.0.1:2080 не слушается' }
$process = Get-Process -Id $connection.OwningProcess -ErrorAction Stop
Write-Host "Port owner: $($process.ProcessName) PID $($process.Id)"
if ($process.ProcessName -notlike 'sing-box*') { throw 'Порт 2080 принадлежит не sing-box' }
$ip = (Invoke-WebRequest -UseBasicParsing -Proxy $Proxy -Uri 'https://api.ipify.org' -TimeoutSec 20).Content.Trim()
if ([string]::IsNullOrWhiteSpace($ip)) { throw 'Внешний IP через proxy не получен' }
Write-Host "External IP through proxy: $ip"
$internet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Write-Host "Windows ProxyEnable=$($internet.ProxyEnable) ProxyServer=$($internet.ProxyServer)"
Write-Host 'Проверка завершена. Для проверки восстановления отключите приложение штатной кнопкой и повторите вывод Registry.'
