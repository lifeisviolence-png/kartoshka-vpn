# Run PowerShell as Administrator.
$ErrorActionPreference = 'Continue'
Write-Host 'Stopping KartoshkaVPN and sing-box...' -ForegroundColor Yellow
Get-Process -Name 'sing-box','kartoshka-vpn','kartoshka_vpn' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Write-Host 'Disabling KartoshkaVPN adapters and removing their routes...' -ForegroundColor Yellow
Get-NetRoute -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -match 'KartoshkaVPN|sing-box|tun' } | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'KartoshkaVPN|sing-box|tun' -or $_.InterfaceDescription -match 'KartoshkaVPN|sing-box|tun' } | Disable-NetAdapter -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Resetting user and WinHTTP proxy...' -ForegroundColor Yellow
reg.exe add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings' /v ProxyEnable /t REG_DWORD /d 0 /f | Out-Null
reg.exe delete 'HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings' /v ProxyServer /f 2>$null
reg.exe delete 'HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings' /v AutoConfigURL /f 2>$null
netsh.exe winhttp reset proxy | Out-Host
Write-Host 'Refreshing DNS and Winsock...' -ForegroundColor Yellow
ipconfig.exe /flushdns | Out-Host
netsh.exe winsock reset | Out-Host
Write-Host ''
Write-Host 'Done. Restart Windows once, then test internet before launching any VPN client.' -ForegroundColor Green
