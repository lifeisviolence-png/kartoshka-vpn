$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $env:USERPROFILE "Desktop\KartoshkaVPN-diagnostic-$stamp.txt"
"KartoshkaVPN network diagnostic $(Get-Date -Format o)" | Out-File $out -Encoding utf8
"`n--- OS ---" | Tee-Object -FilePath $out -Append
Get-ComputerInfo -Property WindowsProductName,WindowsVersion,OsArchitecture | Out-String | Tee-Object -FilePath $out -Append
"`n--- Adapters ---" | Tee-Object -FilePath $out -Append
Get-NetAdapter | Where-Object Status -eq 'Up' | Format-Table -AutoSize | Out-String | Tee-Object -FilePath $out -Append
"`n--- IP configuration ---" | Tee-Object -FilePath $out -Append
Get-NetIPConfiguration | Format-List | Out-String | Tee-Object -FilePath $out -Append
"`n--- Routes ---" | Tee-Object -FilePath $out -Append
Get-NetRoute -AddressFamily IPv4 | Sort-Object RouteMetric | Format-Table -AutoSize | Out-String | Tee-Object -FilePath $out -Append
"`n--- DNS ---" | Tee-Object -FilePath $out -Append
Get-DnsClientServerAddress | Format-Table -AutoSize | Out-String | Tee-Object -FilePath $out -Append
"`n--- Kartoshka / sing-box processes ---" | Tee-Object -FilePath $out -Append
Get-Process kartoshka-vpn,sing-box -ErrorAction SilentlyContinue | Format-Table Id,ProcessName,Path | Out-String | Tee-Object -FilePath $out -Append
"`n--- Local proxy ---" | Tee-Object -FilePath $out -Append
Test-NetConnection 127.0.0.1 -Port 2080 | Format-List | Out-String | Tee-Object -FilePath $out -Append
"`n--- External IP ---" | Tee-Object -FilePath $out -Append
try { Invoke-RestMethod 'https://api.ipify.org' -TimeoutSec 15 | Tee-Object -FilePath $out -Append } catch { $_ | Out-String | Tee-Object -FilePath $out -Append }
Write-Host "Diagnostic saved to $out"
