# КартошкаVPN

Лёгкий desktop-клиент VPN для Windows/macOS на Tauri 2 с ядром sing-box. Основной режим — локальный mixed HTTP/SOCKS-прокси с автоматическим включением системного прокси; TUN намеренно не включён.

## Запуск

```bash
pnpm install
pnpm run dev
```

Для браузерного Preview приложение открывается на `http://localhost:3000`. Для native-клиента используйте `pnpm desktop:dev` после установки Rust и системных зависимостей Tauri.

## Важно

Desktop-версия принимает ссылку подписки 3x-ui, распознаёт `vless://`, `vmess://`, `trojan://` и `ss://`, генерирует конфигурацию sing-box и запускает bundled sidecar. GitHub Actions собирает Windows x64, macOS Intel и macOS Apple Silicon; инструкция находится в [DESKTOP.md](./DESKTOP.md).
