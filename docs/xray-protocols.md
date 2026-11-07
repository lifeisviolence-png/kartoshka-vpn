# Импорт и конфигурация Xray v26.10.31

`parseSubscriptionDetailed(text)` возвращает `{ nodes, errors }`; `parseSubscription(text)` возвращает только узлы, `parseUserinfo(header)` — метаданные подписки. Исходный формат `node.outbound` оставлен совместимым со старым приложением. Генератор `buildXrayConfig(nodes, selectedId, routeMode)` возвращает объект Xray и не изменяет переданные узлы. Секреты присутствуют в узлах и создаваемой конфигурации; их нельзя записывать в логи или отправлять посторонним.

Поддерживаются ссылки VLESS, VMess (base64 JSON), Trojan, Shadowsocks и Hysteria2 (`hysteria2://`, `hy2://`), многострочная/base64-подписка и обёртки JSON `data`, `content`, `subscription`, `links`. VLESS Reality по TCP и XHTTP сохраняет UUID, flow, SNI, fingerprint, public key, short ID, spiderX и XHTTP host/path/mode/extra. Неподдерживаемые параметры не игнорируются: они дают ошибку в `errors`; для неподдерживаемого Hysteria2 узел также сохраняется как `unsupported: true`, `supported: false` с `unsupportedReason` и исходной `originalUri`. В исходной ссылке могут быть секреты, поэтому она должна храниться так же защищённо, как и остальные данные узла.

Реализованы Hysteria2 и Salamander на основе native `hysteria` и `hysteriaSettings` Xray. Например, неподдерживаемые варианты port hopping, Gecko и `insecure=1` сохраняются как неподдерживаемые. В Xray v26.10.31 параметр TLS `allowInsecure` удалён, а не просто имеет небезопасное значение; не следует автоматически превращать его в валидную проверку сертификата. `pinSHA256` для Hysteria2 передаётся в `pinnedPeerCertSha256`. Поддержка XHTTP `extra` ограничена проверяемыми параметрами; отдельный `downloadSettings` пока явно отклоняется. Не все параметры и плагины всех панелей поддерживаются. При частичной ошибке импорта нужно показывать пользователю сообщения `errors`, а не заявлять, что каждый узел работоспособен.

Старый парсер преобразовывал и XHTTP, и HTTP/H2 в `transport.type: "http"`, теряя исходный тип и XHTTP-параметры. Восстановить их из такого узла нельзя: генератор останавливается с просьбой повторно вставить подписку или исходную ссылку. Поддерживаемые старые узлы TCP, WebSocket, gRPC, обычные Shadowsocks, VMess, Trojan и Hysteria2 преобразуются без перезаписи хранилища.

HTTP inbound на `127.0.0.1:2080` работает как прокси, в том числе HTTP CONNECT; SOCKS5 inbound на `127.0.0.1:2081` поддерживает UDP. Это не TUN и не обеспечивает туннелирование приложений, которые игнорируют системный/настроенный прокси. В `all` единственный исходящий канал — выбранный прокси, даже для частных IP. В `split` выбранный прокси остаётся первым исходящим каналом по умолчанию, а домены `.ru`, `.рф` и `geosite:category-ru` и IP из `geoip:ru` направляются на `freedom`. `IPIfNonMatch` может вызывать локальное DNS-разрешение для сопоставления по IP; geodata и DNS не гарантируют полного охвата всех российских сайтов. Режим `manual` не реализован и отклоняется явно.

Для `split` нужны подходящие `geosite.dat` и `geoip.dat` с категориями `category-ru` и `ru`. Они должны быть доступны процессу Xray через `XRAY_LOCATION_ASSET` или стандартный каталог ресурсов Xray; без них `xray run -test` отклонит конфигурацию. Интерфейсу и упаковке нельзя объявлять split доступным, пока доставка данных не обеспечена и не проверена. При обновлении правил их содержимое может изменяться.

## Проверка

```sh
node --test tests/xray-config.test.js tests/xray-proxy.integration.test.js
XRAY_LOCATION_ASSET=/path/to/xray-assets XRAY_TEST_BIN=/path/to/xray \
  node --test tests/xray-config.test.js tests/xray-proxy.integration.test.js
```

Первая команда пропускает проверки ядром, если `XRAY_TEST_BIN` не задан. Вторая выполняет `xray run -test` для фиктивных конфигураций, локальные проверки HTTP CONNECT и SOCKS5 через VLESS, Hysteria2 + Salamander с TLS pin, а также маршрутизацию split. Для проверок нужны свободные локальные порты 2080 и 2081, `openssl` и соответствующие geodata. Это проверка локальной совместимости, а не доказательство доступности конкретного удалённого сервера или работоспособности Windows-системного прокси.

## Источники

- [Xray v26.10.31, исходник обработки транспорта](https://github.com/XTLS/Xray-core/blob/v26.10.31/infra/conf/transport_internet.go)
- [Xray v26.10.31, исходник обработки TLS и Reality](https://github.com/XTLS/Xray-core/blob/v26.10.31/infra/conf/transport_security.go)
- [Xray VLESS outbound](https://xtls.github.io/en/config/outbounds/vless.html)
- [Оригинальная спецификация XHTTP и extra](https://github.com/XTLS/Xray-core/discussions/4113)
- [Xray Hysteria outbound](https://xtls.github.io/en/config/outbounds/hysteria.html), [транспорт Hysteria](https://xtls.github.io/en/config/transports/hysteria.html), [маскировка Salamander](https://xtls.github.io/en/config/transports/finalmask.html)
- [Формат ссылок Hysteria 2](https://v2.hysteria.network/docs/developers/URI-Scheme/)
- [HTTP inbound](https://xtls.github.io/en/config/inbounds/http.html), [SOCKS inbound](https://xtls.github.io/en/config/inbounds/socks.html)
