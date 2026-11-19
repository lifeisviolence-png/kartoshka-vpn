// macOS implementation of the small platform surface used by the proxy
// transaction in main.rs. The transaction itself stays platform-neutral; this
// module maps the five proxy "values" onto `networksetup` for every enabled
// network service.
use super::{RawValue, LOCAL_BYPASS, LOCAL_PROXY};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const NETWORKSETUP: &str = "/usr/sbin/networksetup";
const LSOF: &str = "/usr/sbin/lsof";
const INSTANCE_LOCK: &str = "/tmp/ru.kartoshka.vpn.instance.lock";
const TRANSACTION_LOCK: &str = "/tmp/ru.kartoshka.vpn.transaction.lock";
const STATE_PREFIX: &[u8] = b"KPV3-MAC\0";

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
        Err(format!("Не удалось заблокировать файл: {}", std::io::Error::last_os_error()))
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
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("Не удалось дождаться блокировки proxy: {e}")),
        }
    }
}

// The Windows build uses DPAPI. macOS has no drop-in equivalent that works for
// an unsigned local app without a Keychain prompt; the state file is therefore
// kept at mode 0600 and marked explicitly. This is recorded as a limitation in
// the release notes rather than pretending it is equivalent to DPAPI.
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
    Ok((std::process::id(), 0))
}
pub fn child_identity(child: &Child) -> Result<(u32, u64), String> {
    Ok((child.id(), 0))
}
pub fn ensure_core_job() -> Result<(), String> {
    Ok(())
}
pub fn core_in_job(_: &Child) -> Result<bool, String> {
    Ok(true)
}
pub fn watchdog_creation_flags() -> Result<u32, String> {
    Ok(0)
}
pub fn show_error(message: &str) {
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
    let mut result = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines().skip(1) {
        let line = line.trim();
        // Disabled services are prefixed with an asterisk; changing them would
        // produce errors and is not needed for the active connection.
        if line.is_empty() || line.starts_with('*') {
            continue;
        }
        result.push(line.to_string());
    }
    if result.is_empty() {
        result.push("Wi-Fi".into());
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

fn parse_proxy(output: &str) -> (bool, String, u16) {
    let mut enabled = false;
    let mut server = String::new();
    let mut port = 0u16;
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match key.trim() {
            "Enabled" => enabled = value.eq_ignore_ascii_case("Yes"),
            "Server" => server = value.to_string(),
            "Port" => port = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    (enabled, server, port)
}

fn get_proxy(service: &str, secure: bool) -> (bool, String, u16) {
    let option = if secure { "-getsecurewebproxy" } else { "-getwebproxy" };
    run(&[option, service]).map(|out| parse_proxy(&out)).unwrap_or((false, String::new(), 0))
}

fn proxy_server() -> Option<String> {
    let services = services().ok()?;
    for service in &services {
        for secure in [false, true] {
            let (_, server, port) = get_proxy(service, secure);
            if !server.is_empty() && server != "0.0.0.0" && port > 0 {
                return Some(format!("{server}:{port}"));
            }
        }
    }
    None
}

fn proxy_enabled() -> bool {
    let Ok(services) = services() else { return false };
    services.iter().any(|service| get_proxy(service, false).0 || get_proxy(service, true).0)
}

fn proxy_bypass() -> Option<String> {
    let Ok(services) = services() else { return None };
    for service in &services {
        let Ok(output) = run(&["-getproxybypassdomains", service]) else { continue };
        let domains: Vec<&str> = output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("There are no"))
            .collect();
        if !domains.is_empty() {
            return Some(domains.join(";"));
        }
    }
    None
}

fn pac_url() -> Option<String> {
    let services = services().ok()?;
    for service in &services {
        let Ok(output) = run(&["-getautoproxyurl", service]) else { continue };
        let mut url = String::new();
        let mut enabled = false;
        for line in output.lines() {
            if let Some((key, value)) = line.split_once(':') {
                match key.trim() {
                    "URL" => url = value.trim().to_string(),
                    "Enabled" => enabled = value.trim().eq_ignore_ascii_case("Yes"),
                    _ => {}
                }
            }
        }
        if enabled && !url.is_empty() {
            return Some(url);
        }
    }
    None
}

fn auto_detect() -> bool {
    let Ok(services) = services() else { return false };
    services.iter().any(|service| {
        run(&["-getproxyautodiscovery", service])
            .map(|out| out.lines().any(|line| line.contains("Auto Proxy Discovery: On")))
            .unwrap_or(false)
    })
}

pub fn flags() -> Result<u32, String> {
    let mut value = 0;
    if proxy_enabled() {
        value |= 2;
    }
    if pac_url().is_some() {
        value |= 4;
    }
    if auto_detect() {
        value |= 8;
    }
    Ok(value)
}
pub fn set_flags(_: u32) -> Result<(), String> {
    // The macOS state is represented by the five values themselves. The flag
    // word is derived, so there is no separate WinINet-style write to perform.
    Ok(())
}
pub fn notify() -> Result<(), String> {
    Ok(())
}

fn text_value(value: &Option<RawValue>) -> Option<String> {
    let value = value.as_ref()?;
    if value.kind != 1 {
        return None;
    }
    let units: Vec<u16> = value
        .bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|unit| *unit != 0)
        .collect();
    if units.is_empty() {
        None
    } else {
        Some(String::from_utf16_lossy(&units))
    }
}
fn dword_value(value: &Option<RawValue>) -> Option<u32> {
    let value = value.as_ref()?;
    (value.kind == 4 && value.bytes.len() == 4)
        .then(|| u32::from_le_bytes([value.bytes[0], value.bytes[1], value.bytes[2], value.bytes[3]]))
}

fn bypass_domains(raw: &str) -> Vec<String> {
    raw.split(';')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .filter(|item| !item.eq_ignore_ascii_case("<local>"))
        .map(|item| item.trim_start_matches('[').trim_end_matches(']').to_string())
        .collect()
}

fn set_server(server: &str) -> Result<(), String> {
    let Some((host, port)) = server.rsplit_once(':') else {
        return Err(format!("Некорректный адрес proxy: {server}"));
    };
    if host.is_empty() || port.is_empty() {
        return Err(format!("Некорректный адрес proxy: {server}"));
    }
    for service in services()? {
        run(&["-setwebproxy", &service, host, port])?;
        run(&["-setsecurewebproxy", &service, host, port])?;
    }
    Ok(())
}

fn set_bypass(raw: Option<&str>) -> Result<(), String> {
    let domains = raw.map(bypass_domains).unwrap_or_default();
    for service in services()? {
        let mut args = vec!["-setproxybypassdomains", service.as_str()];
        args.extend(domains.iter().map(String::as_str));
        // Clearing an already empty bypass list can return a non-zero status on
        // some macOS releases; only the apply path (non-empty LOCAL_BYPASS) is
        // safety-critical, so a clear failure is ignored.
        if let Err(error) = run(&args) {
            if !domains.is_empty() {
                return Err(error);
            }
        }
    }
    Ok(())
}

fn set_enabled(enabled: bool) -> Result<(), String> {
    let state = if enabled { "on" } else { "off" };
    for service in services()? {
        run(&["-setwebproxystate", &service, state])?;
        run(&["-setsecurewebproxystate", &service, state])?;
    }
    Ok(())
}

fn set_pac(url: Option<&str>) -> Result<(), String> {
    for service in services()? {
        if let Some(url) = url {
            run(&["-setautoproxyurl", &service, url])?;
            run(&["-setautoproxystate", &service, "on"])?;
        } else {
            run(&["-setautoproxystate", &service, "off"])?;
        }
    }
    Ok(())
}

fn set_auto_detect(enabled: bool) -> Result<(), String> {
    let state = if enabled { "on" } else { "off" };
    for service in services()? {
        run(&["-setproxyautodiscovery", &service, state])?;
    }
    Ok(())
}

pub fn get(name: &str) -> Result<Option<RawValue>, String> {
    match name {
        "ProxyServer" => Ok(proxy_server().map(|value| super::text(&value)).flatten()),
        "ProxyOverride" => Ok(proxy_bypass().map(|value| super::text(&value)).flatten()),
        "AutoConfigURL" => Ok(pac_url().map(|value| super::text(&value)).flatten()),
        "AutoDetect" => Ok(Some(super::dword(u32::from(auto_detect()))).flatten()),
        "ProxyEnable" => Ok(Some(super::dword(u32::from(proxy_enabled()))).flatten()),
        other => Err(format!("Неизвестный параметр proxy: {other}")),
    }
}

pub fn set(name: &str, value: &Option<RawValue>) -> Result<(), String> {
    match name {
        "ProxyServer" => match text_value(value) {
            Some(server) => set_server(&server),
            None => Ok(()),
        },
        "ProxyOverride" => set_bypass(text_value(value).as_deref()),
        "AutoConfigURL" => set_pac(text_value(value).as_deref()),
        "AutoDetect" => set_auto_detect(dword_value(value).unwrap_or(0) != 0),
        "ProxyEnable" => set_enabled(dword_value(value).unwrap_or(0) != 0),
        other => Err(format!("Неизвестный параметр proxy: {other}")),
    }
}

pub fn owned_listener(pid: u32, port: u16) -> Result<bool, String> {
    let output = Command::new(LSOF)
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .map_err(|e| format!("Не удалось проверить TCP listener: {e}"))?;
    if !output.status.success() {
        // lsof exits 1 when no socket matches, which is a normal negative.
        return Ok(false);
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.trim().parse::<u32>().ok() == Some(pid)))
}

fn alive(pid: u32) -> bool {
    pid > 1 && unsafe { libc::kill(pid as i32, 0) } == 0
}

pub fn watchdog(path: &Path, parent: (u32, u64), core: (u32, u64)) -> Result<(), String> {
    if !alive(parent.0) || !alive(core.0) {
        return Err("Процесс завершился до готовности watchdog".into());
    }
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
        if !alive(parent.0) || !alive(core.0) {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let recovered = lock().and_then(|_lock| {
        if path.exists() {
            super::restore_snapshot_locked(path)
        } else if !super::points_to_local_proxy()? {
            Ok(())
        } else {
            Err("Snapshot отсутствует, но macOS всё ещё указывает на локальный proxy".into())
        }
    });
    if let Err(ref error) = recovered {
        if alive(parent.0) {
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
        let exe = std::env::current_exe().map_err(|e| format!("Не удалось определить путь приложения: {e}"))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Не удалось создать LaunchAgents: {e}"))?;
        }
        let escaped = exe.display().to_string().replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>ru.kartoshka.vpn</string><key>ProgramArguments</key><array><string>{escaped}</string><string>--minimized</string></array><key>RunAtLoad</key><true/></dict></plist>\n"
        );
        fs::write(&path, plist).map_err(|e| format!("Не удалось записать LaunchAgent: {e}"))?;
        let _ = Command::new("/bin/launchctl").args(["load", "-w"]).arg(&path).status();
    } else {
        let _ = Command::new("/bin/launchctl").args(["unload", "-w"]).arg(&path).status();
        let _ = fs::remove_file(&path);
    }
    Ok(enabled)
}

pub fn autostart_enabled() -> bool {
    autostart_path().map(|path| path.exists()).unwrap_or(false)
}