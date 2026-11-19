// macOS implementation of the platform surface used by the proxy transaction.
//
// macOS keeps proxy settings per network service (Wi-Fi, Ethernet, ...). The
// Windows transaction stores five registry values, which cannot represent
// heterogeneous services. This module therefore captures a complete snapshot of
// every enabled service and applies/restores it exactly. The generic transaction
// in main.rs calls this module directly for macOS snapshots.
use super::RawValue;
use serde::{Deserialize, Serialize};
use std::{
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::mpsc,
    time::{Duration, Instant},
};

const NETWORKSETUP: &str = "/usr/sbin/networksetup";
const LSOF: &str = "/usr/sbin/lsof";
const INSTANCE_LOCK: &str = "/tmp/ru.kartoshka.vpn.instance.lock";
const TRANSACTION_LOCK: &str = "/tmp/ru.kartoshka.vpn.transaction.lock";
const STATE_PREFIX: &[u8] = b"KPV3-MAC\0";
const LOCAL_HOST: &str = "127.0.0.1";
const LOCAL_PORT: u16 = 2080;
// `networksetup` takes a space-separated bypass list. `<local>` is a WinINet
// token and must never be passed to macOS. Loopback literals are enough for the
// local Xray listener; `localhost` also covers IPv6 resolution.
const LOCAL_BYPASS_DOMAINS: [&str; 2] = ["127.0.0.1", "localhost"];
const KEYCHAIN_SERVICE: &[u8] = b"ru.kartoshka.vpn";
const KEYCHAIN_ACCOUNT: &[u8] = b"secure-state";
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub server: String,
    pub port: u16,
    pub authenticated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoProxyConfig {
    pub enabled: bool,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceState {
    pub name: String,
    pub web: ProxyConfig,
    pub secure_web: ProxyConfig,
    pub bypass: Vec<String>,
    pub auto_proxy: AutoProxyConfig,
    pub auto_discovery: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub services: Vec<ServiceState>,
}

impl Snapshot {
    pub fn validate(&self) -> Result<(), String> {
        if self.services.is_empty() {
            return Err("В снимке macOS нет ни одного сетевого сервиса".into());
        }
        let mut names = std::collections::HashSet::new();
        for service in &self.services {
            if service.name.trim().is_empty() || !names.insert(service.name.as_str()) {
                return Err("В снимке macOS повторяется или пустое имя сетевого сервиса".into());
            }
            for (label, proxy) in [("HTTP", &service.web), ("HTTPS", &service.secure_web)] {
                if proxy.enabled && (proxy.server.trim().is_empty() || proxy.port == 0) {
                    return Err(format!(
                        "Некорректный {label}-proxy в сервисе «{}»: включён без адреса",
                        service.name
                    ));
                }
            }
            if service.auto_proxy.enabled && service.auto_proxy.url.trim().is_empty() {
                return Err(format!(
                    "Некорректный PAC в сервисе «{}»: включён без URL",
                    service.name
                ));
            }
        }
        Ok(())
    }
}

pub struct Instance {
    file: File,
}
pub struct ResourceLock {
    file: File,
}

fn flock(file: &File, operation: i32) -> Result<(), String> {
    if unsafe { libc::flock(file.as_raw_fd(), operation) } == 0 {
        Ok(())
    } else {
        Err(format!(
            "Не удалось заблокировать файл: {}",
            std::io::Error::last_os_error()
        ))
    }
}

fn open_lock(path: &str) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("Не удалось открыть блокировку {path}: {e}"))
}

impl Drop for Instance {
    fn drop(&mut self) {
        let _ = flock(&self.file, libc::LOCK_UN);
    }
}
impl Drop for ResourceLock {
    fn drop(&mut self) {
        let _ = flock(&self.file, libc::LOCK_UN);
    }
}

pub fn one_instance() -> Result<Instance, String> {
    let file = open_lock(INSTANCE_LOCK)?;
    for _ in 0..20 {
        match flock(&file, libc::LOCK_EX | libc::LOCK_NB) {
            Ok(()) => return Ok(Instance { file }),
            Err(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    }
    Err("Уже запущен другой экземпляр КартошкаVPN".into())
}

pub fn lock() -> Result<ResourceLock, String> {
    let file = open_lock(TRANSACTION_LOCK)?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match flock(&file, libc::LOCK_EX | libc::LOCK_NB) {
            Ok(()) => return Ok(ResourceLock { file }),
            Err(_) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(e) => return Err(format!("Не удалось дождаться блокировки proxy: {e}")),
        }
    }
}

// Proxy snapshot contains only proxy endpoints, not subscription credentials.
// It is written with mode 0600 and marked as a macOS-format file. Secrets live in
// the login Keychain (see keychain_* below), not in this file.
pub fn protect(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = STATE_PREFIX.to_vec();
    out.extend_from_slice(input);
    Ok(out)
}

pub fn unprotect(input: &[u8]) -> Result<Vec<u8>, String> {
    input
        .strip_prefix(STATE_PREFIX)
        .map(|value| value.to_vec())
        .ok_or_else(|| "state.locked".to_string())
}

pub fn parent_identity() -> Result<(u32, u64), String> {
    // PID identity is checked again by proc_pidpath before the watchdog sends a
    // signal. macOS does not expose the Windows creation-time tuple through this
    // small platform surface.
    Ok((std::process::id(), 0))
}

pub fn child_identity(child: &Child) -> Result<(u32, u64), String> {
    Ok((child.id(), 0))
}

pub fn ensure_core_job() -> Result<(), String> {
    // macOS has no Windows Job Object. The watchdog below is the containment
    // mechanism: it restores proxy settings and terminates an orphaned Xray.
    Ok(())
}

pub fn core_in_job(_: &Child) -> Result<bool, String> {
    // Kept for the shared transaction API. The actual macOS safety property is
    // the independent watchdog, not a Job Object.
    Ok(true)
}

#[allow(dead_code)]
pub fn watchdog_creation_flags() -> Result<u32, String> {
    Ok(0)
}

pub fn show_error(message: &str) {
    if std::env::var_os("KARTOVPN_WATCHDOG_NO_MODAL").is_none() {
        let escaped = message
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', " ");
        let script = format!(
            "display alert \"КартошкаVPN\" message \"{escaped}\" as critical buttons {{\"OK\"}} default button \"OK\""
        );
        let _ = Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .status();
    }
    eprintln!("{message}");
}

fn services() -> Result<Vec<String>, String> {
    let output = Command::new(NETWORKSETUP)
        .arg("-listallnetworkservices")
        .output()
        .map_err(|e| format!("Не удалось получить список сетевых сервисов macOS: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "networksetup не вернул список сервисов: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut result = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.contains("asterisk") {
            continue;
        }
        // Disabled services are prefixed with an asterisk.
        if line.starts_with('*') {
            continue;
        }
        result.push(line.to_string());
    }
    if result.is_empty() {
        return Err("В macOS нет включённых сетевых сервисов для настройки proxy".into());
    }
    Ok(result)
}

fn run(args: &[&str]) -> Result<String, String> {
    let output = Command::new(NETWORKSETUP)
        .args(args)
        .output()
        .map_err(|e| format!("Не удалось выполнить networksetup: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "networksetup {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn normalized_server(server: &str) -> String {
    let server = server.trim();
    if server.eq_ignore_ascii_case("(null)") || server == "0.0.0.0" {
        String::new()
    } else {
        server.to_string()
    }
}

fn parse_proxy(output: &str) -> ProxyConfig {
    let mut enabled = false;
    let mut server = String::new();
    let mut port = 0u16;
    let mut authenticated = false;
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Enabled" => enabled = value.eq_ignore_ascii_case("Yes"),
            "Server" => server = normalized_server(value),
            "Port" => port = value.parse().unwrap_or(0),
            "Authenticated Proxy Enabled" => {
                authenticated = matches!(value, "1" | "Yes" | "true")
            }
            _ => {}
        }
    }
    if server.is_empty() {
        port = 0;
    }
    ProxyConfig {
        enabled,
        server,
        port,
        authenticated,
    }
}

fn get_proxy(service: &str, secure: bool) -> Result<ProxyConfig, String> {
    let option = if secure {
        "-getsecurewebproxy"
    } else {
        "-getwebproxy"
    };
    run(&[option, service]).map(|out| parse_proxy(&out))
}

fn get_bypass(service: &str) -> Result<Vec<String>, String> {
    let output = run(&["-getproxybypassdomains", service])?;
    let mut domains = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.contains("aren't any") || line.contains("are no") {
            continue;
        }
        domains.push(line.to_string());
    }
    Ok(normalize_domains(domains))
}

fn normalize_domains(mut domains: Vec<String>) -> Vec<String> {
    for domain in &mut domains {
        *domain = domain.trim().to_lowercase();
    }
    domains.sort();
    domains.dedup();
    domains
}

fn get_auto_proxy(service: &str) -> Result<AutoProxyConfig, String> {
    let output = run(&["-getautoproxyurl", service])?;
    let mut url = String::new();
    let mut enabled = false;
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "URL" => {
                let value = value.trim();
                if !value.eq_ignore_ascii_case("(null)") {
                    url = value.to_string();
                }
            }
            "Enabled" => enabled = value.trim().eq_ignore_ascii_case("Yes"),
            _ => {}
        }
    }
    if url.is_empty() {
        enabled = false;
    }
    Ok(AutoProxyConfig { enabled, url })
}

fn get_auto_discovery(service: &str) -> Result<bool, String> {
    let output = run(&["-getproxyautodiscovery", service])?;
    Ok(output
        .lines()
        .any(|line| line.contains("Auto Proxy Discovery: On")))
}

fn capture_service(name: &str) -> Result<ServiceState, String> {
    Ok(ServiceState {
        name: name.to_string(),
        web: get_proxy(name, false)?,
        secure_web: get_proxy(name, true)?,
        bypass: get_bypass(name)?,
        auto_proxy: get_auto_proxy(name)?,
        auto_discovery: get_auto_discovery(name)?,
    })
}

pub fn capture() -> Result<Snapshot, String> {
    let mut result = Vec::new();
    for service in services()? {
        result.push(capture_service(&service)?);
    }
    let snapshot = Snapshot { services: result };
    snapshot.validate()?;
    Ok(snapshot)
}

fn local_proxy() -> ProxyConfig {
    ProxyConfig {
        enabled: true,
        server: LOCAL_HOST.into(),
        port: LOCAL_PORT,
        authenticated: false,
    }
}

fn applied_service(before: &ServiceState) -> ServiceState {
    ServiceState {
        name: before.name.clone(),
        web: local_proxy(),
        secure_web: local_proxy(),
        bypass: normalize_domains(
            LOCAL_BYPASS_DOMAINS.iter().map(|s| s.to_string()).collect(),
        ),
        // We only switch PAC/auto-discovery off; the configured PAC URL is left
        // untouched so restoring it does not depend on a URL write succeeding.
        auto_proxy: AutoProxyConfig {
            enabled: false,
            url: before.auto_proxy.url.clone(),
        },
        auto_discovery: false,
    }
}

fn applied_snapshot(before: &Snapshot) -> Snapshot {
    Snapshot {
        services: before.services.iter().map(applied_service).collect(),
    }
}

pub fn require_no_foreign_proxy(snapshot: &Snapshot) -> Result<(), String> {
    for service in &snapshot.services {
        for (label, proxy) in [("HTTP", &service.web), ("HTTPS", &service.secure_web)] {
            if proxy.authenticated {
                return Err(format!(
                    "В macOS для сервиса «{}» настроен {label}-proxy с авторизацией. Подключение заблокировано, чтобы не потерять учётные данные. Отключите его в «Системных настройках → Сеть → Прокси» и повторите.",
                    service.name
                ));
            }
            if proxy.enabled
                && (proxy.server != LOCAL_HOST || proxy.port != LOCAL_PORT)
            {
                return Err(format!(
                    "В macOS уже включён другой {label}-proxy ({}) для сервиса «{}». Подключение заблокировано, чтобы не перезаписать настройки другого VPN. Отключите его в «Системных настройках → Сеть → Прокси» и повторите.",
                    if proxy.server.is_empty() {
                        "без адреса".to_string()
                    } else {
                        format!("{}:{}", proxy.server, proxy.port)
                    },
                    service.name
                ));
            }
        }
    }
    Ok(())
}

fn verify(expected: &Snapshot) -> Result<(), String> {
    let current = capture()?;
    if current != *expected {
        return Err("Настройки proxy изменились во время запуска; изменения не применены".into());
    }
    Ok(())
}

fn check(watchdog: &mut Child) -> Result<(), String> {
    super::check_watchdog(watchdog)
}

fn write_counted(
    expected: &Snapshot,
    watchdog: &mut Child,
    writes: &mut usize,
    fail_after: Option<usize>,
    args: &[&str],
) -> Result<(), String> {
    check(watchdog)?;
    verify(expected)?;
    run(args)?;
    *writes += 1;
    if fail_after == Some(*writes) {
        return Err("Тестовая ошибка записи proxy".into());
    }
    Ok(())
}

pub fn apply(
    before: &Snapshot,
    fail_after: Option<usize>,
    watchdog: &mut Child,
) -> Result<(), String> {
    before.validate()?;
    require_no_foreign_proxy(before)?;
    let mut expected = before.clone();
    let mut writes = 0usize;

    // 1. Set both proxy endpoints before enabling anything.
    for index in 0..expected.services.len() {
        let name = expected.services[index].name.clone();
        write_counted(
            &expected,
            watchdog,
            &mut writes,
            fail_after,
            &["-setwebproxy", &name, LOCAL_HOST, "2080"],
        )?;
        expected.services[index].web = local_proxy();
        write_counted(
            &expected,
            watchdog,
            &mut writes,
            fail_after,
            &["-setsecurewebproxy", &name, LOCAL_HOST, "2080"],
        )?;
        expected.services[index].secure_web = local_proxy();
    }

    // 2. Set the bypass list.
    for index in 0..expected.services.len() {
        let name = expected.services[index].name.clone();
        let mut args = vec!["-setproxybypassdomains", name.as_str()];
        args.extend(LOCAL_BYPASS_DOMAINS);
        write_counted(&expected, watchdog, &mut writes, fail_after, &args)?;
        expected.services[index].bypass =
            normalize_domains(LOCAL_BYPASS_DOMAINS.iter().map(|s| s.to_string()).collect());
    }

    // 3. Turn off PAC and auto-discovery, then enable the local proxy.
    for index in 0..expected.services.len() {
        let name = expected.services[index].name.clone();
        if expected.services[index].auto_proxy.enabled {
            write_counted(
                &expected,
                watchdog,
                &mut writes,
                fail_after,
                &["-setautoproxystate", &name, "off"],
            )?;
            expected.services[index].auto_proxy.enabled = false;
        }
        if expected.services[index].auto_discovery {
            write_counted(
                &expected,
                watchdog,
                &mut writes,
                fail_after,
                &["-setproxyautodiscovery", &name, "off"],
            )?;
            expected.services[index].auto_discovery = false;
        }
        write_counted(
            &expected,
            watchdog,
            &mut writes,
            fail_after,
            &["-setwebproxystate", &name, "on"],
        )?;
        expected.services[index].web = local_proxy();
        write_counted(
            &expected,
            watchdog,
            &mut writes,
            fail_after,
            &["-setsecurewebproxystate", &name, "on"],
        )?;
        expected.services[index].secure_web = local_proxy();
    }

    let applied = applied_snapshot(before);
    let current = capture()?;
    if current != applied {
        return Err("Системный proxy macOS не включился полностью; проверьте настройки сети".into());
    }
    check(watchdog)
}

fn compatible(current: &ServiceState, before: &ServiceState) -> bool {
    let applied = applied_service(before);
    let proxy_ok = |now: &ProxyConfig, was: &ProxyConfig, target: &ProxyConfig| {
        now == was || now == target
    };
    current.name == before.name
        && proxy_ok(&current.web, &before.web, &applied.web)
        && proxy_ok(&current.secure_web, &before.secure_web, &applied.secure_web)
        && (current.bypass == before.bypass || current.bypass == applied.bypass)
        && (current.auto_proxy == before.auto_proxy
            || current.auto_proxy == applied.auto_proxy)
        && (current.auto_discovery == before.auto_discovery
            || current.auto_discovery == applied.auto_discovery)
}

fn restore_service(service: &ServiceState) -> Result<(), String> {
    let name = &service.name;
    // Disable before changing endpoints so a half-restored service never points
    // at a stale local listener.
    let _ = run(&["-setwebproxystate", name, "off"]);
    let _ = run(&["-setsecurewebproxystate", name, "off"]);

    if !service.auto_proxy.url.is_empty() {
        run(&["-setautoproxyurl", name, &service.auto_proxy.url])?;
    }
    run(&[
        "-setautoproxystate",
        name,
        if service.auto_proxy.enabled { "on" } else { "off" },
    ])?;
    run(&[
        "-setproxyautodiscovery",
        name,
        if service.auto_discovery { "on" } else { "off" },
    ])?;

    if service.bypass.is_empty() {
        // The documented sentinel for clearing the list is the literal "Empty".
        // Passing no domain at all is rejected by some macOS releases.
        run(&["-setproxybypassdomains", name, "Empty"])?;
    } else {
        let mut args = vec!["-setproxybypassdomains", name.as_str()];
        args.extend(service.bypass.iter().map(String::as_str));
        run(&args)?;
    }

    if service.web.server.is_empty() {
        // `-setwebproxy` both sets the server and turns the proxy on. 0.0.0.0:0
        // is normalized back to an empty server; the state is restored below.
        let _ = run(&["-setwebproxy", name, "0.0.0.0", "0"]);
    } else {
        run(&[
            "-setwebproxy",
            name,
            &service.web.server,
            &service.web.port.to_string(),
        ])?;
    }
    if !service.web.enabled {
        run(&["-setwebproxystate", name, "off"])?;
    }
    if service.secure_web.server.is_empty() {
        let _ = run(&["-setsecurewebproxy", name, "0.0.0.0", "0"]);
    } else {
        run(&[
            "-setsecurewebproxy",
            name,
            &service.secure_web.server,
            &service.secure_web.port.to_string(),
        ])?;
    }
    if !service.secure_web.enabled {
        run(&["-setsecurewebproxystate", name, "off"])?;
    }
    run(&[
        "-setwebproxystate",
        name,
        if service.web.enabled { "on" } else { "off" },
    ])?;
    run(&[
        "-setsecurewebproxystate",
        name,
        if service.secure_web.enabled { "on" } else { "off" },
    ])?;
    Ok(())
}

pub fn restore(before: &Snapshot) -> Result<(), String> {
    before.validate()?;
    let current = capture()?;
    if current.services.len() != before.services.len()
        || !current
            .services
            .iter()
            .zip(&before.services)
            .all(|(now, was)| compatible(now, was))
    {
        return Err("Настройки proxy изменены другой программой; snapshot сохранён, настройки не перезаписаны".into());
    }
    for service in &before.services {
        restore_service(service)?;
    }
    let final_state = capture()?;
    if final_state != *before {
        return Err("Не удалось вернуть точные настройки proxy macOS; snapshot сохранён для ручного восстановления".into());
    }
    Ok(())
}

pub fn dump(snapshot: &Snapshot) -> String {
    serde_json::to_string_pretty(snapshot).unwrap_or_else(|e| format!("<ошибка снимка proxy: {e}>"))
}

pub fn dump_current() -> String {
    capture()
        .map(|snapshot| dump(&snapshot))
        .unwrap_or_else(|e| format!("<ошибка чтения proxy macOS: {e}>"))
}

pub fn points_to_local_proxy() -> Result<bool, String> {
    let snapshot = capture()?;
    Ok(snapshot.services.iter().any(|service| {
        [&service.web, &service.secure_web]
            .iter()
            .any(|proxy| proxy.enabled && proxy.server == LOCAL_HOST && proxy.port == LOCAL_PORT)
    }))
}

pub fn flags() -> Result<u32, String> {
    let snapshot = capture()?;
    let mut value = 0;
    if snapshot.services.iter().any(|service| {
        service.web.enabled || service.secure_web.enabled
    }) {
        value |= 2;
    }
    if snapshot
        .services
        .iter()
        .any(|service| service.auto_proxy.enabled && !service.auto_proxy.url.is_empty())
    {
        value |= 4;
    }
    if snapshot
        .services
        .iter()
        .any(|service| service.auto_discovery)
    {
        value |= 8;
    }
    Ok(value)
}

pub fn set_flags(_: u32) -> Result<(), String> {
    Ok(())
}

pub fn notify() -> Result<(), String> {
    Ok(())
}

pub fn get(name: &str) -> Result<Option<RawValue>, String> {
    let snapshot = capture()?;
    let first = |f: &dyn Fn(&ServiceState) -> Option<String>| {
        snapshot.services.iter().find_map(f)
    };
    let value = match name {
        "ProxyServer" => first(&|service| {
            let proxy = if service.web.server.is_empty() {
                &service.secure_web
            } else {
                &service.web
            };
            (!proxy.server.is_empty()).then(|| format!("{}:{}", proxy.server, proxy.port))
        }),
        "ProxyOverride" => first(&|service| {
            (!service.bypass.is_empty()).then(|| service.bypass.join(";"))
        }),
        "AutoConfigURL" => first(&|service| {
            (service.auto_proxy.enabled && !service.auto_proxy.url.is_empty())
                .then(|| service.auto_proxy.url.clone())
        }),
        "AutoDetect" => Some(
            u32::from(snapshot.services.iter().any(|service| service.auto_discovery)).to_string(),
        ),
        "ProxyEnable" => Some(
            u32::from(
                snapshot
                    .services
                    .iter()
                    .any(|service| service.web.enabled || service.secure_web.enabled),
            )
            .to_string(),
        ),
        other => return Err(format!("Неизвестный параметр proxy: {other}")),
    };
    Ok(value.and_then(|value| {
        if name == "AutoDetect" || name == "ProxyEnable" {
            value.parse::<u32>().ok().map(super::dword).flatten()
        } else {
            super::text(&value)
        }
    }))
}

pub fn set(_: &str, _: &Option<RawValue>) -> Result<(), String> {
    Err("На macOS proxy изменяется только транзакционным путём".into())
}

pub fn owned_listener(pid: u32, port: u16) -> Result<bool, String> {
    let output = Command::new(LSOF)
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .map_err(|e| format!("Не удалось проверить TCP listener: {e}"))?;
    if !output.status.success() {
        return Ok(false);
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.trim().parse::<u32>().ok() == Some(pid)))
}

fn alive(pid: u32) -> bool {
    pid > 1 && unsafe { libc::kill(pid as i32, 0) } == 0
}

fn process_path(pid: u32) -> Option<String> {
    let mut buffer = vec![0u8; 4096];
    let result = unsafe {
        proc_pidpath(
            pid as i32,
            buffer.as_mut_ptr() as *mut c_void,
            buffer.len() as u32,
        )
    };
    if result <= 0 {
        return None;
    }
    let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
    Some(String::from_utf8_lossy(&buffer[..end]).to_string())
}

fn is_xray(pid: u32) -> bool {
    process_path(pid)
        .map(|path| path.ends_with("/xray"))
        .unwrap_or(false)
}

pub fn watchdog(path: &Path, parent: (u32, u64), core: (u32, u64)) -> Result<(), String> {
    if !alive(parent.0) || !alive(core.0) {
        return Err("Процесс завершился до готовности watchdog".into());
    }
    // PID alone is not an identity: macOS can reuse it. Remember the executable
    // paths and treat a different path as process death before restoring.
    let parent_path = process_path(parent.0);
    let core_path = process_path(core.0);
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut byte = [0u8; 1];
        if std::io::stdin().read_exact(&mut byte).is_ok() && byte[0] == 0x5a {
            let _ = sender.send(());
        }
    });
    std::io::stdout()
        .write_all(b"READY\n")
        .and_then(|_| std::io::stdout().flush())
        .map_err(|e| e.to_string())?;
    loop {
        if receiver.try_recv().is_ok() {
            return Ok(());
        }
        let parent_gone = !alive(parent.0)
            || parent_path
                .as_ref()
                .map(|path| process_path(parent.0).as_ref() != Some(path))
                .unwrap_or(false);
        let core_gone = !alive(core.0)
            || core_path
                .as_ref()
                .map(|path| process_path(core.0).as_ref() != Some(path))
                .unwrap_or(false);
        if parent_gone || core_gone {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let parent_alive = alive(parent.0)
        && parent_path
            .as_ref()
            .map(|path| process_path(parent.0).as_ref() == Some(path))
            .unwrap_or(true);
    let recovered = lock().and_then(|_lock| {
        if path.exists() {
            super::restore_snapshot_locked(path)
        } else if !super::points_to_local_proxy()? {
            Ok(())
        } else {
            Err("Snapshot отсутствует, но macOS всё ещё указывает на локальный proxy".into())
        }
    });
    if !parent_alive && alive(core.0) && is_xray(core.0) {
        // No Windows Job Object on macOS: an orphaned core would otherwise keep
        // listening after the GUI crash. Only signal a verified Xray executable.
        unsafe {
            libc::kill(core.0 as i32, libc::SIGTERM);
        }
    }
    if let Err(ref error) = recovered {
        if parent_alive {
            show_error(&format!(
                "Аварийное восстановление proxy не выполнено: {error}\nSnapshot сохранён, проверьте настройки прокси macOS вручную."
            ));
        }
    }
    recovered
}

// LaunchAgent path is used by the frontend's "start at login" switch.
pub fn autostart_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("Не найден домашний каталог")?;
    Ok(PathBuf::from(home).join("Library/LaunchAgents/ru.kartoshka.vpn.plist"))
}

pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    let path = autostart_path()?;
    if enabled {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Не удалось определить путь приложения: {e}"))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Не удалось создать LaunchAgents: {e}"))?;
        }
        let escaped = exe
            .display()
            .to_string()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>ru.kartoshka.vpn</string><key>ProgramArguments</key><array><string>{escaped}</string><string>--minimized</string></array><key>RunAtLoad</key><true/></dict></plist>\n"
        );
        fs::write(&path, plist).map_err(|e| format!("Не удалось записать LaunchAgent: {e}"))?;
        let _ = Command::new("/bin/launchctl")
            .args(["load", "-w"])
            .arg(&path)
            .status();
    } else {
        let _ = Command::new("/bin/launchctl")
            .args(["unload", "-w"])
            .arg(&path)
            .status();
        let _ = fs::remove_file(&path);
    }
    Ok(enabled)
}

pub fn autostart_enabled() -> bool {
    autostart_path().map(|path| path.exists()).unwrap_or(false)
}

// ---- Keychain-backed application state -----------------------------------
//
// Windows uses DPAPI. macOS has no DPAPI equivalent; a plain 0600 file is not
// enough for subscription URLs, UUIDs and passwords. The login Keychain is the
// platform facility designed for this data. These are the small, stable
// SecKeychain generic-password APIs; the app never writes the secret to disk.
#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainAddGenericPassword(
        keychain: *const c_void,
        service_name_length: u32,
        service_name: *const u8,
        account_name_length: u32,
        account_name: *const u8,
        password_length: u32,
        password_data: *const c_void,
        item_ref: *mut *mut c_void,
    ) -> i32;
    fn SecKeychainFindGenericPassword(
        keychain: *const c_void,
        service_name_length: u32,
        service_name: *const u8,
        account_name_length: u32,
        account_name: *const u8,
        password_length: *mut u32,
        password_data: *mut *mut c_void,
        item_ref: *mut *mut c_void,
    ) -> i32;
    fn SecKeychainItemDelete(item_ref: *const c_void) -> i32;
    fn SecKeychainItemFreeContent(attr_list: *mut c_void, data: *mut c_void) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: *const c_void);
}

#[link(name = "System")]
extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_void, buffer_size: u32) -> i32;
}

struct KeychainItem {
    item: *mut c_void,
    data: Vec<u8>,
}

impl Drop for KeychainItem {
    fn drop(&mut self) {
        if !self.item.is_null() {
            unsafe { CFRelease(self.item) };
        }
    }
}

fn keychain_find() -> Result<Option<KeychainItem>, String> {
    let mut length = 0u32;
    let mut data: *mut c_void = std::ptr::null_mut();
    let mut item: *mut c_void = std::ptr::null_mut();
    let status = unsafe {
        SecKeychainFindGenericPassword(
            std::ptr::null(),
            KEYCHAIN_SERVICE.len() as u32,
            KEYCHAIN_SERVICE.as_ptr(),
            KEYCHAIN_ACCOUNT.len() as u32,
            KEYCHAIN_ACCOUNT.as_ptr(),
            &mut length,
            &mut data,
            &mut item,
        )
    };
    if status == ERR_SEC_ITEM_NOT_FOUND {
        return Ok(None);
    }
    if status != 0 {
        return Err(format!("macOS Keychain: ошибка чтения ({status})"));
    }
    let bytes = if length == 0 || data.is_null() {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(data as *const u8, length as usize).to_vec() }
    };
    unsafe {
        SecKeychainItemFreeContent(std::ptr::null_mut(), data);
    }
    Ok(Some(KeychainItem { item, data: bytes }))
}

pub fn keychain_load() -> Result<Option<Vec<u8>>, String> {
    Ok(keychain_find()?.map(|item| item.data.clone()))
}

pub fn keychain_save(contents: &[u8]) -> Result<(), String> {
    if let Some(existing) = keychain_find()? {
        let status = unsafe { SecKeychainItemDelete(existing.item) };
        if status != 0 {
            return Err(format!("macOS Keychain: ошибка замены ({status})"));
        }
    }
    let mut item: *mut c_void = std::ptr::null_mut();
    let status = unsafe {
        SecKeychainAddGenericPassword(
            std::ptr::null(),
            KEYCHAIN_SERVICE.len() as u32,
            KEYCHAIN_SERVICE.as_ptr(),
            KEYCHAIN_ACCOUNT.len() as u32,
            KEYCHAIN_ACCOUNT.as_ptr(),
            contents.len() as u32,
            contents.as_ptr() as *const c_void,
            &mut item,
        )
    };
    if !item.is_null() {
        unsafe { CFRelease(item) };
    }
    if status != 0 {
        return Err(format!("macOS Keychain: ошибка сохранения ({status})"));
    }
    Ok(())
}

pub fn keychain_delete() -> Result<(), String> {
    if let Some(existing) = keychain_find()? {
        let status = unsafe { SecKeychainItemDelete(existing.item) };
        if status != 0 {
            return Err(format!("macOS Keychain: ошибка удаления ({status})"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> ServiceState {
        ServiceState {
            name: "Wi-Fi".into(),
            web: ProxyConfig {
                enabled: false,
                server: "corp.example".into(),
                port: 3128,
                authenticated: false,
            },
            secure_web: ProxyConfig {
                enabled: false,
                server: String::new(),
                port: 0,
                authenticated: false,
            },
            bypass: vec!["*.corp.example".into()],
            auto_proxy: AutoProxyConfig {
                enabled: true,
                url: "https://pac.example/proxy.pac".into(),
            },
            auto_discovery: true,
        }
    }

    #[test]
    fn parses_networksetup_proxy_output() {
        let parsed = parse_proxy(
            "Enabled: Yes\nServer: 127.0.0.1\nPort: 2080\nAuthenticated Proxy Enabled: 0\n",
        );
        assert!(parsed.enabled);
        assert_eq!(parsed.server, "127.0.0.1");
        assert_eq!(parsed.port, 2080);
        assert!(!parsed.authenticated);
    }

    #[test]
    fn normalizes_empty_server_and_zero_port() {
        let parsed = parse_proxy("Enabled: No\nServer: 0.0.0.0\nPort: 0\n");
        assert!(!parsed.enabled);
        assert!(parsed.server.is_empty());
        assert_eq!(parsed.port, 0);
    }

    #[test]
    fn applied_state_is_exactly_the_local_proxy() {
        let before = Snapshot {
            services: vec![service()],
        };
        let applied = applied_snapshot(&before);
        let actual = &applied.services[0];
        assert_eq!(actual.web, local_proxy());
        assert_eq!(actual.secure_web, local_proxy());
        assert_eq!(actual.bypass, vec!["127.0.0.1", "localhost"]);
        assert!(!actual.auto_proxy.enabled);
        assert_eq!(actual.auto_proxy.url, before.services[0].auto_proxy.url);
        assert!(!actual.auto_discovery);
        assert!(compatible(&applied.services[0], &before.services[0]));
        assert!(compatible(&before.services[0], &before.services[0]));
    }

    #[test]
    fn foreign_proxy_is_not_compatible() {
        let before = Snapshot {
            services: vec![service()],
        };
        let mut foreign = applied_snapshot(&before);
        foreign.services[0].web.server = "10.0.0.1".into();
        assert!(!compatible(&foreign.services[0], &before.services[0]));
    }

    #[test]
    fn rejects_duplicate_or_incomplete_services() {
        let mut snapshot = Snapshot {
            services: vec![service()],
        };
        assert!(snapshot.validate().is_ok());
        snapshot.services.push(service());
        assert!(snapshot.validate().is_err());

        let mut incomplete = Snapshot {
            services: vec![service()],
        };
        incomplete.services[0].auto_proxy.url.clear();
        assert!(incomplete.validate().is_err());
    }
}
