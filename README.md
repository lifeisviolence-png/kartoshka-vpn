# KartoshkaVPN

KartoshkaVPN — нативный Windows-клиент на Tauri 2 с bundled sing-box. Интерфейс выполнен в фиолетовом стиле, похожем по структуре на HAPP: боковая навигация, список серверов и отдельная панель подключения.

## Что реализовано

- импорт subscription URL 3x-ui и прямых VLESS/VMess/Trojan/Shadowsocks/Hysteria2 ссылок;
- сохранение импортированных серверов и выбранного узла локально;
- реальные TCP-ping проверки в native-сборке;
- генерация конфигурации sing-box для выбранного узла;
- запуск bundled sing-box с проверкой, что локальный прокси `127.0.0.1:2080` действительно поднялся;
- включение системного proxy Windows через sing-box;
- чтение заголовка `subscription-userinfo` при его наличии;
- фиолетовый интерфейс со списком серверов, поиском, импортом и логикой подключения.

## Запуск Preview

```bash
pnpm install
pnpm run dev
```

Preview показывает интерфейс, но не может изменить системный proxy компьютера. Для реального подключения нужна native Windows-сборка с bundled sing-box.

## Native-разработка

Нужны Node.js/pnpm, Rust и системные зависимости Tauri 2:

```bash
pnpm install
pnpm tauri icon src-tauri/icons/potato-mark.svg
pnpm desktop:dev
```

## Ограничения текущего этапа

Рабочий режим — системный HTTP/SOCKS proxy через sing-box, не TUN. Это сознательно соответствует вашему сценарию HAPP, где proxy-режим работает стабильнее. TUN, geoip/geosite rule-sets, tray и macOS-сборка являются следующими отдельными этапами, а не фиктивно заявленными функциями текущего релиза.
