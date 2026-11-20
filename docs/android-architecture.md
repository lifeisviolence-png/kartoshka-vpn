# Android-клиент KartoshkaVPN: решение фазы 0

Статус: **spike, не релиз**. Ветка `feature/android-0.10-phase0`. Проверки на реальном телефоне не выполнялись.

## Решение

Выбран вариант **A: Tauri 2 Android + собственный Kotlin-плагин `tauri-plugin-vpn`**. Веб-интерфейс и JS-код остаются общими с десктопом; VPN-служба живёт в Kotlin и не зависит от Activity/WebView.

Для конфигурации выбран вариант **2**: JS один раз собирает полный конфиг Xray со всеми кандидатами, balancer/observatory и передаёт его службе. Служба не запускает WebView и не разбирает подписки; она только запускает/перезапускает ядро и хранит последний конфиг. Это сохраняет один источник логики с десктопом и не требует встраивать QuickJS в Android-процесс. Вариант 1 (JS в Rust через QuickJS) отложен: он добавляет движок и второй жизненный цикл JS; вариант 3 (портирование парсера) создаёт дублирование и расхождение с десктопными тестами.

Для ядра и туннеля выбран вариант **(c): официальный Xray Android binary + TUN inbound с `XRAY_TUN_FD`**. `VpnService` создаёт TUN и передаёт fd ядру; отдельный tun2socks не нужен. Это минимум подвижных частей и ровно та же версия Xray 26.10.31, что на Windows/macOS. Официальная документация Xray подтверждает передачу fd через `XRAY_TUN_FD` на Android.

Почему не другие варианты:

- **B, нативная Kotlin-оболочка с WebView**: пришлось бы дублировать мост, обновления, i18n и жизненный цикл UI; Tauri уже даёт WebView и Rust-команды.
- **C, полностью Compose**: максимальная стоимость и потеря общей JS-логики; для текущего продукта не оправдано.
- **libXray/gomobile AAR**: требует отдельной сборки Go-библиотеки и ABI-матрицы; официальный binary проще проверить по SHA-256 и версии.
- **tun2socks**: лишний native-компонент и лишний локальный SOCKS-вход; TUN inbound ядра уже поддерживает Android fd.

## Доказательства локальной сборки

Собрано на Linux (не на macOS/Windows):

| Проверка | Результат |
|---|---|
| Tauri Android init | `src-tauri/gen/android` создан |
| Debug APK x86_64 | собран, `app-universal-debug.apk` |
| Размер debug APK | около 62 МБ |
| `minSdk` / `targetSdk` | 26 / 35 |
| `compileSdk` | 37 (требование Tauri 2.12.5) |
| В APK | `lib/x86_64/libkartoshka_vpn_lib.so`, `lib/x86_64/libxray.so` |
| Rust Windows target | `cargo check --target x86_64-pc-windows-gnu --tests` успешно, только существующее предупреждение `doh.rs` |

Официальный Xray Android x86_64:

```text
asset: Xray-android-amd64.zip
sha256: 077f2f768de2356cea4a32598d333837fe0fa33ab540c4d508d9f17e2eb9e5b4
binary: xray, ELF 64-bit PIE, Android linker64, 38 993 624 bytes
```

Локальный эмулятор без KVM не использовался как доказательство: software TCG загружался слишком медленно, установка APK не завершилась. Это ограничение среды, а не вывод о работоспособности.

## Что должен доказать CI

Workflow `.github/workflows/android-phase0.yml` на `ubuntu-latest` с аппаратным эмулятором x86_64 API 34:

1. APK устанавливается и Activity запускается.
2. Из `nativeLibraryDir` выполняется `libxray.so version`.
3. `VpnService` поднимает TUN, `XRAY_TUN_FD` передаётся Xray.
4. HTTP-запрос с эмулятора к локальному стенду `10.0.2.2:8080` проходит через TUN/Xray и возвращается.
5. Служба остаётся живой после ухода Activity на Home.

CI также проверяет наличие обоих `.so`, `minSdk 26`, `targetSdk 35` и печатает logcat только с меткой `KPV_PHASE0`; конфигурация и секреты в лог не попадают.

## Риски, которые нельзя скрывать

- Наследование fd дочерним процессом Xray нужно подтвердить на эмуляторе. Если Android закроет fd при `fork/exec`, вариант (c) не годится и придётся перейти на libXray/tun2socks. Это главный блокер spike.
- `specialUse` foreground service type и `BIND_VPN_SERVICE` проверяются на API 34; на API 26–33 поведение отличается.
- `libxray.so` — исполняемый файл, а не разделяемая библиотека. Android может запретить exec из `nativeLibraryDir` на отдельных прошивках; это проверяется только на реальном устройстве.
- Нет проверки 16-КБ страниц, подписи APK, Android 15/16, real device, смены сети, Doze, always-on VPN, split tunneling, DNS/IPv6 leaks. Это следующие фазы.
- Debug APK не подписан ключом владельца и не предназначен для распространения.
- Tauri Android всё ещё требует `compileSdk 37` из-за `tauri-android`; `targetSdk` остаётся 35. Это не то же самое, что target 37.
- Сервис в spike запускает тестовый конфиг `freedom` без реального сервера. Это проверка транспорта TUN→Xray→loopback, а не VPN-подписки.

## Следующая фаза

Фаза 1: постоянный foreground service, consent/onRevoke, always-on, IPv6/DNS leak protection, сетевые callback'и, health-check/failover, уведомление, Quick Settings, split tunneling. Только после зелёного Phase 0 CI и отчёта.
