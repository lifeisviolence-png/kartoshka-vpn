# Диагностика KartoshkaVPN на Windows

Если приложение показывает ошибку подключения, откройте PowerShell от имени администратора и выполните:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\windows-network-check.ps1
```

На рабочем столе появится файл `KartoshkaVPN-diagnostic-*.txt`. Перед отправкой разработчику удалите из него публичный IP, имена сетей и другие данные, которые не хотите раскрывать. Не отправляйте subscription URL, UUID, пароли, Reality private key или полный sing-box config.

Скрипт проверяет Windows, сетевые адаптеры, IP-конфигурацию, маршруты, DNS, процессы KartoshkaVPN/sing-box, локальный proxy `127.0.0.1:2080` и текущий внешний IP.
