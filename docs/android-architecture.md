# Android-клиент KartoshkaVPN: решение фазы 0

Статус: **spike, не релиз**. Ветка `feature/android-0.10-phase0`. Проверки на реальном телефоне не выполнялись.

## Решение

Выбран вариант **A: Tauri 2 Android + собственный Kotlin-плагин `tauri-plugin-vpn`**. Веб-интерфейс и JS-код остаются общими с десктопом; VPN-служба живёт в Kotlin и не зависит от Activity/WebView.

Для конфигурации выбран вариант **2**: JS один раз собирает полный конфиг Xray со всеми кандидатами, balancer/observatory и передаёт его службе. Служба не запускает WebView и не разбирает подписки; она только запускает/перезапускает ядро и хранит последний конфиг. Это сохраняет один источник логики с десктопом и не требует встраивать QuickJS в Android-процесс. Вариант 1 (JS в Rust через QuickJS) отложен: он добавляет движок и второй жизненный цикл JS; вариант 3 (портирование парсера) создаёт дублирование и расхождение с десктопными тестами.

Для ядра и туннеля выбран вариант **(c), исправленный после CI**: официальная библиотека **XTLS/libXray 26.10.31** (AAR, Xray-core 26.10.31) работает **в процессе приложения**, а `VpnService` передаёт TUN fd через корневой `env` конфига:

```json
"env": { "xray.tun.fd": "<fd>" }
```

Это тот же официальный Xray-core 26.10.31, что на Windows/macOS. Отдельный `tun2socks` не нужен: TUN inbound ядра принимает fd напрямую. Fork/exec и передача fd дочернему процессу не используются.

### Почему не официальный binary + `ProcessBuilder`

Первая версия spike запускала `libxray.so` как исполняемый файл из `nativeLibraryDir` через `ProcessBuilder` и передавала fd в переменной `XRAY_TUN_FD`. На CI-эмуляторе (run `44709119808`) Xray получил:

```text
KPV_PHASE0: tunnel started fd=204
KPV_PHASE0: xray: Failed to start: app/proxyman/inbound: failed to start proxy > bad file descriptor
```

Причина не в конфиге и не в `FD_CLOEXEC`. AOSP `UNIXProcess_md.c` в `childProcess()` после `fork()` вызывает `closeDescriptors()` и закрывает **все** fd, кроме stdin/stdout/stderr и fail-pipe, независимо от `FD_CLOEXEC`. Поэтому `Os.fcntlInt(F_SETFD, 0)` не помог: fd 204 закрывался до `exec`. Это подтверждает, что Java `ProcessBuilder` принципиально не подходит для передачи TUN fd отдельному процессу.

Рассмотренные варианты:

- **JNI fork/exec с сохранением fd** — снимает проблему, но добавляет свой native-launcher, обработку stdout/stderr, zombie-процессы и риск для каждой прошивки. Для spike это больше подвижных частей, чем libXray.
- **tun2socks** — требует либо in-process native-библиотеку, либо тот же fork/exec для передачи fd; плюс второй локальный SOCKS-вход и ещё один компонент.
- **libXray AAR** — официальная библиотека, тот же Xray-core, fd остаётся в процессе, нет `exec`, нет `closeDescriptors`. Выбран.

### Что является только spike-поведением

- `VpnPlugin.load()` автоматически запускает тестовый туннель, чтобы CI мог
  проверить транспорт без ручных нажатий. В фазе 1 подключение должно быть
  только по явному действию пользователя.
- Тестовый конфиг включает `logLevel: info` и access-лог, чтобы в CI было
  видно прохождение соединения. В production access-лог должен быть
  выключен (`"access": "none"`), а логи не должны содержать адреса серверов
  и секреты.
- `freedom.redirect` на `10.0.2.2:8081` — только маркер теста. В реальном
  клиенте outbound'ы строятся из подписки.
- В конфиге задаётся непустое `name`-заглушка (`kpv0`). Android-сборка Xray
  использует отдельный `AndroidTun`: значение `name` она не применяет, а
  фактическое имя читает из fd через `TUNGETIFF`. Пустое `name` использовать
  нельзя: generic-конфигуратор вызывает `net.Interfaces()`, а Android
  запрещает `NETLINK_ROUTE` (`netlinkrib: permission denied`). Это и было
  причиной падения run `44716801743`.

Почему не другие UI-варианты:

- **B, нативная Kotlin-оболочка с WebView**: пришлось бы дублировать мост, обновления, i18n и жизненный цикл UI; Tauri уже даёт WebView и Rust-команды.
- **C, полностью Compose**: максимальная стоимость и потеря общей JS-логики; для текущего продукта не оправдано.

### Сравнение A/B/C

Измеренных чисел для B и C нет: они не реализовывались в этом spike. Поэтому
сравнение ниже отделяет факты от оценки, а не выдаёт оценку за замер.

| Вариант | Что уже проверено | Цена | Решение |
|---|---|---|---|
| **A. Tauri Android + Kotlin VpnService** | debug APK x86_64 собран; Kotlin-плагин и сервис компилируются; libXray AAR загружается в APK; JS-код общий с десктопом | плагин, сервис, CI и скрипты; APK 63 411 493 байта | выбран |
| **B. Нативная Kotlin-оболочка + WebView** | не собирался | пришлось бы заново сделать bridge, i18n, обновления и жизненный цикл UI | отклонён без замера: нет причин отступать от A |
| **C. Полностью Compose** | не собирался | переписать экраны и потерять общую JS-логику | отклонён без замера: нет причин отступать от A |

Если A не пройдёт CI-проверку TUN/fd, отступление к B или C всё равно не
решает главную проблему: TUN и Xray придётся проверять в любом варианте.
Поэтому решение по ядру и способу передачи fd важнее выбора UI-фреймворка.

## Доказательства локальной сборки

Собрано на Linux (не на macOS/Windows):

| Инструмент | Версия |
|---|---|
| Tauri CLI / crate | 2.12.4 / 2.12.5 |
| Rust | 1.99.1 (CI: stable на момент прогона; точный пин — задача фазы 4) |
| Gradle / AGP / Kotlin | 9.6.1 / 9.3.1 / 2.2.10 (генерирует Tauri 2.12.4) |
| JDK | 17 (CI: Temurin 17) |
| Android NDK | 27.0.12077973 |
| Node / pnpm | 22 / 11.25.0 |
| Xray-core в libXray | 26.10.31 |
| libXray AAR | 26.10.31 |

| Проверка | Результат |
|---|---|
| Tauri Android init | `src-tauri/gen/android` создан |
| Debug APK x86_64 | собран, `app-universal-debug.apk` |
| Размер debug APK | 63 411 493 байта |
| SHA-256 debug APK | `31cc2cb615c20c8fd394e2df3c1c9d005e4d6de056caf8855dac70cf47d7268f` (локальная сборка; CI-артефакт может отличаться) |
| `minSdk` / `targetSdk` | 26 / 35 |
| `compileSdk` | 37 (требование Tauri 2.12.5) |
| `extractNativeLibs` | `true` |
| В APK | `lib/x86_64/libkartoshka_vpn_lib.so` (149 447 320 байт), `lib/x86_64/libgojni.so` (36 433 872 байта) |
| Старый `libxray.so` | отсутствует; бинарный запуск удалён |
| Rust Windows target | `cargo check --target x86_64-pc-windows-gnu --tests` успешно, только существующее предупреждение `doh.rs` |

Официальный libXray Android:

```text
release: v26.10.31
asset: libxray-android.zip
sha256: fb99f04acf379cc2957c1e1d0ce2b3c0005d3f49974a44c09a11242a0562c1ca
AAR: libXray.aar, 52 829 875 байт
native: jni/x86_64/libgojni.so, 36 433 872 байта
```

AAR не коммитится: `scripts/android-phase0-prepare.sh` скачивает его с GitHub
Release, проверяет SHA-256 и кладёт в `app/libs` и `plugins/android/libs`.
Версия AAR и Xray-core закреплена; при обновлении нужно менять обе версии и
хеш осознанно.

Локальный эмулятор без KVM не использовался как доказательство: software TCG
загружался слишком медленно, установка APK не завершилась. Это ограничение
среды, а не вывод о работоспособности. В CI используется тот же x86_64 API 34,
но с принудительным TCG (`ANDROID_I_WANT_MY_TCG=yes`) и таймаутом загрузки
1800 секунд; это медленнее аппаратного ускорения, однако функциональные
проверки не ослаблены.

## Локальные проверки libXray + TUN

Проверка сделана на Linux-сборке libXray 26.10.31
(`libxray-linux-x64.zip`, SHA-256
`27b9afad1c5ad4817c8fade6861f706906d2447f6a20090a69dccfdf3959b1ff`),
не на Android. Она доказывает семантику `env.xray.tun.fd` и TUN inbound, но не
заменяет Android-эмулятор.

Сценарий:

1. Создан TUN `kpv0` (`IFF_TUN | IFF_NO_PI`), fd 3.
2. Конфиг: TUN inbound `{"name":"kpv0","mtu":1500}`, freedom outbound
   `redirect: "127.0.0.1:8081"`, `env: {"xray.tun.fd":"3"}`.
3. `CGoInvoke` с `runXray` вернул `{"success":true,"data":{},"error":""}`;
   в логе `proxy/tun: kpv0 created`, `kpv0 up`, `Xray 26.10.31 started`.
4. На TUN назначен `10.9.0.2/24`, маршрут `10.9.0.1/32`; HTTP-серверы
   слушали 8080 и 8081.
5. `curl http://10.9.0.1:8080/` вернул `200 OK` и directory listing.
6. Лог 8081 получил `GET / HTTP/1.1`; лог 8080 остался пустым.

Это подтверждает, что тест в эмуляторе не может случайно «пройти» при обходе
TUN: запрос, не попавший в Xray, придёт на 8080, а не на 8081.

## Что должен доказать CI

Workflow `.github/workflows/android-phase0.yml` на `ubuntu-latest` с эмулятором
x86_64 API 34 (TCG, без KVM):

1. APK устанавливается и Activity запускается.
2. `libgojni.so` загружается, `xrayVersion` возвращает версию Xray.
3. `VpnService` поднимает TUN, `runXray` получает fd через `env.xray.tun.fd`
   и запускается в процессе приложения.
4. `getXrayState` возвращает `true`.
5. HTTP-запрос с эмулятора к `10.0.2.2:8080` проходит через TUN/Xray,
   Xray перенаправляет его на `127.0.0.1:8081`, опубликованный на хосте
   через `adb reverse`, а ответ возвращается клиенту. Это не зависит от
   внешней сети эмулятора, которая на TCG может не подняться.
6. Служба и состояние Xray остаются живыми после ухода Activity на Home.

CI также проверяет наличие `libgojni.so` и `libkartoshka_vpn_lib.so`,
`minSdk 26`, `targetSdk 35` и печатает logcat только с меткой `KPV_PHASE0`;
конфигурация и секреты в лог не попадают.

## История CI

| Run | Где упало | Причина |
|---|---|---|
| `44703208665` | Setup pnpm | конфликт `version: 10` и `packageManager: pnpm@11.25.0` |
| `44703367125` | Setup Android SDK | `sdkmanager` licenses; перешли на предустановленный SDK |
| `44703589415` | запуск эмулятора | у `ubuntu-latest` нет `/dev/kvm`; emulator 37 отказался от `-accel off` без `ANDROID_I_WANT_MY_TCG=yes` |
| `44705873986` | `adb install` | `android-emulator-runner` выполняет строки `script` по одной, переменная `APK` не сохранялась между строками |
| `44709119808` | запуск Xray | `tunnel started fd=204`, затем `bad file descriptor`: AOSP `closeDescriptors()` закрыл fd перед `exec` |
| `44716801743` | сборка TUN inbound | пустое `name` вызвало `net.Interfaces()`; Android запретил `NETLINK_ROUTE`: `netlinkrib: permission denied` |
| `44721901490` | `adb install` | PackageManager ещё не был готов: `Failure calling service package: Broken pipe (32)`; добавлены ожидание `pm`, `--no-streaming` и три попытки |
| `44725148006` | тест трафика | HTTP-клиент образа и буферизация логов Python-серверов; добавлены отдельный клиент и `python3 -u` |
| `44729064453` | post-boot шаг action | `android-emulator-runner` вызвал `input keyevent 82`, пока `InputManager` ещё не был готов: `Broken pipe` |
| `44732153599` | запуск эмулятора | AVD создался не в том каталоге, который искал `emulator`; задан явный `ANDROID_AVD_HOME` |
| `44734668107` | жизненный цикл сервиса | `am start -W` отвалился по таймауту, сервис преждевременно остановился; убран `-W`, сервис стартует явно |
| `44739817923` | исходящее соединение Xray | у эмулятора не поднялись `eth0`/`wlan0`; `dial tcp 10.0.2.2:8081: network is unreachable` |
| `44744072111` | проверка ответа | TUN и ответ 200 уже работали, но тест ожидал `Directory listing`, а сервер отдавал `index.html` |
| `44748613879` | — | **успех**: TUN→Xray→`127.0.0.1:8081`, HTTP 200, сервис пережил Home |

После `44709119808` вариант с binary + `ProcessBuilder` признан негодным для
передачи fd; spike переведён на libXray AAR. Это не ослабление проверки: тест
по-прежнему требует реального TUN→Xray→8081 и падает при обходе TUN.

## Результат успешного прогона

Прогон `44748613879`, HEAD `4148e19`, workflow «Android Phase 0 spike» —
`success`.

```text
APK: 59 718 269 байт
SHA-256: aa730ce96276e872c9081cda2077e377c0064c96ceb6b85938de8f8b2b72ea74
package: ru.kartoshka.vpn, versionCode 9010, versionName 0.9.10
minSdk 26, targetSdk 35, compileSdk 37
lib/x86_64/libgojni.so: 36 433 872 байта
lib/x86_64/libkartoshka_vpn_lib.so: 139 783 560 байт
libxray.so: отсутствует
```

Ключевые строки logcat:

```text
KPV_PHASE0: service onCreate
KPV_PHASE0: service onStartCommand action=com.plugin.vpn.action.START
KPV_PHASE0: xray version: 26.10.31
KPV_PHASE0: tunnel started fd=168
KPV_PHASE0: xray state: true
```

Access-лог Xray подтвердил приём запроса из TUN:

```text
from tcp:10.8.0.2:46072 accepted tcp:10.0.2.2:8080 [tun-in >> test-out]
```

Сервер на 8081 получил `GET / HTTP/1.0` и ответил `200`; в логе 8080 нет
`GET /`, только строка запуска сервера. Клиент получил `HTTP/1.0 200 OK`.
После `input keyevent 3` (Home) проверки `dumpsys activity services` и
`ps -A` прошли, тест завершился `PHASE0_EMULATOR_OK`.

## Риски, которые нельзя скрывать

- libXray AAR добавляет Go runtime и `libgojni.so` (36,4 МБ на x86_64) в APK.
  Это влияет на размер и память; точные цифры — после CI/замера, не по оценке.
- AAR скачивается при сборке, а не лежит в git. Без сети/без GitHub Release
  сборка не начнётся; SHA-256 и версия закреплены, но доступность ассета
  зависит от GitHub.
- `specialUse` foreground service type и `BIND_VPN_SERVICE` проверяются на API 34; на API 26–33 поведение отличается.
- Нет проверки 16-КБ страниц, подписи APK, Android 15/16, real device, смены сети, Doze, always-on VPN, split tunneling, DNS/IPv6 leaks. Это следующие фазы.
- Debug APK не подписан ключом владельца и не предназначен для распространения.
- Tauri Android всё ещё требует `compileSdk 37` из-за `tauri-android`; `targetSdk` остаётся 35. Это не то же самое, что target 37.
- Сервис в spike запускает тестовый конфиг `freedom` без реального сервера. Это проверка транспорта TUN→Xray→loopback, а не VPN-подписки.
- Проверка «после Home» не равна удалению задачи из recents или убийству
  процесса: это отдельный сценарий фазы 1.
- Автозапуск туннеля при загрузке Activity и access-лог — только для spike;
  в production их быть не должно.
- libXray — сторонняя официальная библиотека XTLS, но не часть Tauri. Её API
  может меняться между релизами; версия и хеш закреплены, обновление — отдельная
  задача с проверкой.

## Следующая фаза

Фаза 1: постоянный foreground service, consent/onRevoke, always-on, IPv6/DNS leak protection, сетевые callback'и, health-check/failover, уведомление, Quick Settings, split tunneling. Только после зелёного Phase 0 CI и отчёта.
