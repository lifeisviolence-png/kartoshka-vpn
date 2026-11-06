# KartoshkaVPN Desktop v0.4

## Архитектура

Приложение использует Tauri 2 и поставляет sing-box как sidecar. Основной режим — TUN-интерфейс Windows с `auto_route`, `strict_route`, DNS hijack и MTU 1500. Альтернативный режим — локальный mixed HTTP/SOCKS proxy на `127.0.0.1:2080`. Перед отображением статуса «Подключено» приложение выполняет реальный запрос определения внешнего IP.

## Поддерживаемый импорт

- subscription URL 3x-ui;
- VLESS, включая TLS/Reality, WS и gRPC;
- VMess;
- Trojan;
- Shadowsocks;
- Hysteria2;
- несколько прямых ссылок построчно.

После импорта приложение сохраняет узлы локально, читает `subscription-userinfo`, показывает срок при наличии заголовка и выполняет TCP-ping каждого узла. TCP-ping измеряет доступность адреса/порта, а не гарантирует успешность всей VPN-сессии.

## Сборка

Для локальной сборки нужны Rust и зависимости Tauri 2:

```bash
pnpm install
pnpm tauri icon src-tauri/icons/potato-mark.svg
pnpm desktop:build
```

GitHub Actions собирает Windows x64 installer и запускает frontend/Rust/Tauri build checks. TUN требует подтверждения UAC. Если на конкретном компьютере TUN не создаётся, приложение должно показать ошибку; для диагностики используйте `diagnostics/windows-network-check.ps1`.
