# Технические основания Windows TUN

Проверено по официальной документации sing-box:

- TUN поддерживается на Windows: https://sing-box.sagernet.org/configuration/inbound/tun/
- Для Windows `auto_route` задаёт маршрут по умолчанию через TUN.
- `strict_route` на Windows предотвращает DNS leak из-за обычного multihomed DNS resolution и делает неподдерживаемые маршруты недоступными.
- `dns_mode: hijack` добавляет перехват DNS; при `strict_route` DNS через другие интерфейсы блокируется.
- В конфигурации используются `address`, `mtu`, `auto_route`, `strict_route`, `stack: system` и `dns_mode: hijack`.
- Системный desktop-клиент sing-box также описывает TUN как платформенную функцию: https://sing-box.sagernet.org/clients/desktop/

Для Windows native-приложение запрашивает `requireAdministrator` через application manifest, потому что создание TUN-интерфейса и изменение маршрутов требуют повышенных прав. API Tauri для этого: https://docs.rs/tauri-build/latest/tauri_build/struct.WindowsAttributes.html

Ограничение проверки: фактический внешний IP, DNS и доступность сайтов можно подтвердить только на пользовательской Windows-машине с реальной подпиской. Репозиторий содержит PowerShell-диагностику в `diagnostics/windows-network-check.ps1`.
