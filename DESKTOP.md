# KartoshkaVPN Desktop v0.4

## Архитектура

Приложение использует Tauri 2 и поставляет sing-box как sidecar. Рабочий режим — локальный mixed HTTP/SOCKS proxy на `127.0.0.1:2080`; при успешном запуске sing-box сам включает системный proxy Windows. Перед отображением статуса «Подключено» native-команда проверяет, что локальный порт действительно поднялся.

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

GitHub Actions собирает Windows x64 installer и запускает frontend/Rust/Tauri build checks. В текущем этапе TUN намеренно не включён: рабочий сценарий — proxy, как в HAPP на компьютере пользователя.
