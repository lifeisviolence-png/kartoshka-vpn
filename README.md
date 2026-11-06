# KartoshkaVPN

KartoshkaVPN — нативный Windows-клиент на Tauri 2 с bundled sing-box. Интерфейс выполнен в фиолетовом стиле, похожем по структуре на HAPP: боковая навигация, список серверов и отдельная панель подключения.

## Что реализовано

- импорт subscription URL 3x-ui и прямых VLESS/VMess/Trojan/Shadowsocks/Hysteria2 ссылок;
- сохранение импортированных серверов и выбранного узла локально;
- реальные TCP-ping проверки в native-сборке;
- генерация конфигурации sing-box для выбранного узла;
- TUN-режим Windows с `auto_route`, `strict_route`, DNS hijack и MTU 1500;
- отдельный proxy-режим для сценариев, где TUN недоступен;
- проверка внешнего IP после запуска перед показом статуса «Подключено»;
- чтение заголовка `subscription-userinfo` при его наличии;
- фиолетовый интерфейс со списком серверов, поиском, импортом и логикой подключения.

## Запуск Preview

```bash
pnpm install
pnpm run dev
```

Preview показывает интерфейс, но не может создать TUN или изменить сетевые маршруты. Для реального подключения нужна native Windows-сборка с bundled sing-box и подтверждением UAC.

## Native-разработка

Нужны Node.js/pnpm, Rust и системные зависимости Tauri 2:

```bash
pnpm install
pnpm tauri icon src-tauri/icons/potato-mark.svg
pnpm desktop:dev
```

## Важное ограничение проверки

Сборка включает настоящий TUN-конфиг и проверку выхода в интернет, но внешний IP, DNS и доступность сайтов необходимо подтвердить на Windows-компьютере с вашей реальной подпиской. Для сбора сетевой диагностики используйте `diagnostics/windows-network-check.ps1`. Не отправляйте subscription URL или секреты.
