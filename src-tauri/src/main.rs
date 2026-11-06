#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::{Path, PathBuf}, process::Command as ProcessCommand, sync::Mutex, time::Instant};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use tokio::{net::TcpStream, time::{sleep, timeout, Duration}};

const PROXY_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const LOCAL_PROXY_HOST: &str = "127.0.0.1";
const LOCAL_PROXY_PORT: u16 = 2080;
const LOCAL_PROXY: &str = "127.0.0.1:2080";

#[derive(Clone, Serialize, Deserialize)]
struct RegistryValue { name: String, kind: String, value: String }

#[derive(Clone, Serialize, Deserialize)]
struct ProxySnapshot { values: Vec<RegistryValue> }

struct ProxyRuntime {
    child: Option<CommandChild>,
    snapshot: Option<ProxySnapshot>,
    snapshot_path: Option<PathBuf>,
    generation: u64,
}

struct ProxyState(Mutex<ProxyRuntime>);

#[derive(Serialize)]
struct SubscriptionResponse { body: String, userinfo: Option<String> }

fn command_error(label: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() { format!("{label}: команда завершилась с кодом {}", output.status) } else { format!("{label}: {stderr}") }
}

#[cfg(windows)]
fn registry_value(name: &str) -> Result<Option<RegistryValue>, String> {
    let output = ProcessCommand::new("reg").args(["query", PROXY_KEY, "/v", name]).output().map_err(|e| format!("Не удалось запустить reg query: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("unable to find") || stderr.contains("не удается найти") || stderr.contains("the system was unable") { return Ok(None); }
        return Err(command_error("Ошибка чтения Windows Registry", &output));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|line| line.split_whitespace().next() == Some(name)).ok_or_else(|| format!("Не удалось разобрать значение Registry {name}"))?;
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 3 { return Err(format!("Некорректный формат Registry {name}")); }
    Ok(Some(RegistryValue { name: name.to_string(), kind: parts[1].to_string(), value: parts[2..].join(" ") }))
}

#[cfg(not(windows))]
fn registry_value(_name: &str) -> Result<Option<RegistryValue>, String> { Ok(None) }

fn capture_proxy() -> Result<ProxySnapshot, String> {
    let mut values = Vec::new();
    for name in ["ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL", "AutoDetect"] {
        if let Some(value) = registry_value(name)? { values.push(value); }
    }
    Ok(ProxySnapshot { values })
}

#[cfg(windows)]
fn set_registry(value: &RegistryValue) -> Result<(), String> {
    let output = ProcessCommand::new("reg").args(["add", PROXY_KEY, "/v", &value.name, "/t", &value.kind, "/d", &value.value, "/f"]).output().map_err(|e| format!("Не удалось запустить reg add: {e}"))?;
    if output.status.success() { Ok(()) } else { Err(command_error(&format!("Ошибка записи Registry {}", value.name), &output)) }
}

#[cfg(not(windows))]
fn set_registry(_value: &RegistryValue) -> Result<(), String> { Ok(()) }

#[cfg(windows)]
fn delete_registry(name: &str) -> Result<(), String> {
    let output = ProcessCommand::new("reg").args(["delete", PROXY_KEY, "/v", name, "/f"]).output().map_err(|e| format!("Не удалось запустить reg delete: {e}"))?;
    if output.status.success() { return Ok(()); }
    let text = format!("{} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)).to_lowercase();
    if text.contains("unable to find") || text.contains("не удается найти") || text.contains("cannot find") { Ok(()) } else { Err(command_error(&format!("Ошибка удаления Registry {}", name), &output)) }
}

#[cfg(not(windows))]
fn delete_registry(_name: &str) -> Result<(), String> { Ok(()) }

fn snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать защищённую папку настроек: {e}"))?;
    Ok(dir.join("proxy-snapshot.json"))
}

fn persist_snapshot(path: &Path, snapshot: &ProxySnapshot) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(snapshot).map_err(|e| e.to_string())?;
    fs::write(&temp, data).map_err(|e| format!("Не удалось сохранить snapshot proxy: {e}"))?;
    fs::rename(&temp, path).map_err(|e| format!("Не удалось атомарно сохранить snapshot proxy: {e}"))
}

fn clear_snapshot(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) { Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(e) => Err(format!("Не удалось удалить snapshot proxy: {e}")) }
}

fn restore_snapshot(snapshot: &ProxySnapshot, path: &Path) -> Result<(), String> {
    for name in ["ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL", "AutoDetect"] { delete_registry(name)?; }
    for value in &snapshot.values { set_registry(value)?; }
    clear_snapshot(path)
}

fn recover_persisted_snapshot(app: &AppHandle) -> Result<bool, String> {
    let path = snapshot_path(app)?;
    if !path.exists() { return Ok(false); }
    let bytes = fs::read(&path).map_err(|e| format!("Не удалось прочитать сохранённый snapshot proxy: {e}"))?;
    let snapshot: ProxySnapshot = serde_json::from_slice(&bytes).map_err(|e| format!("Сохранённый snapshot proxy повреждён: {e}"))?;
    restore_snapshot(&snapshot, &path)?;
    Ok(true)
}

fn restore_runtime(runtime: &mut ProxyRuntime) -> Result<(), String> {
    if let Some(mut child) = runtime.child.take() { let _ = child.kill(); }
    if let (Some(snapshot), Some(path)) = (runtime.snapshot.take(), runtime.snapshot_path.take()) { restore_snapshot(&snapshot, &path)?; }
    Ok(())
}

fn stop_runtime(state: &ProxyState) -> Result<(), String> {
    let mut runtime = state.0.lock().map_err(|_| "Не удалось получить состояние подключения".to_string())?;
    restore_runtime(&mut runtime)
}

fn append_log(app: &AppHandle, message: &str) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("kartoshka.log");
        let line = format!("{} {}\n", chrono_like_timestamp(), message);
        let _ = fs::OpenOptions::new().create(true).append(true).open(path).and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
    }
}

fn chrono_like_timestamp() -> String { format!("[{}]", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()) }

#[cfg(windows)]
fn port_owned_by(pid: u32) -> bool {
    let output = match ProcessCommand::new("netstat").args(["-ano", "-p", "tcp"]).output() { Ok(value) => value, Err(_) => return false };
    let needle = format!("{}:{}", LOCAL_PROXY_HOST, LOCAL_PROXY_PORT);
    String::from_utf8_lossy(&output.stdout).lines().any(|line| line.contains(&needle) && line.split_whitespace().last() == Some(&pid.to_string()))
}

#[cfg(not(windows))]
fn port_owned_by(_pid: u32) -> bool { false }

#[tauri::command]
async fn fetch_subscription(url: String) -> Result<SubscriptionResponse, String> {
    let trimmed = url.trim().to_string();
    if ["vless://", "vmess://", "trojan://", "ss://", "hysteria2://"].iter().any(|prefix| trimmed.starts_with(prefix)) { return Ok(SubscriptionResponse { body: trimmed, userinfo: None }); }
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) { return Err("Ссылка должна начинаться с http:// или https://".to_string()); }
    let response = reqwest::Client::builder().user_agent("KartoshkaVPN/0.6.1").redirect(reqwest::redirect::Policy::limited(5)).build().map_err(|e| e.to_string())?.get(trimmed).header("Accept", "text/plain, text/*, */*").send().await.map_err(|e| format!("Не удалось открыть подписку: {e}"))?.error_for_status().map_err(|e| format!("Сервер подписки вернул ошибку: {e}"))?;
    let userinfo = response.headers().get("subscription-userinfo").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let body = response.text().await.map_err(|e| format!("Не удалось прочитать подписку: {e}"))?;
    Ok(SubscriptionResponse { body, userinfo })
}

#[tauri::command]
async fn test_latency(host: String, port: u16) -> Result<Option<u32>, String> {
    let started = Instant::now();
    match timeout(Duration::from_secs(5), TcpStream::connect(format!("{host}:{port}"))).await { Ok(Ok(_)) => Ok(Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32)), Ok(Err(_)) | Err(_) => Ok(None) }
}

#[tauri::command]
async fn probe_internet() -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(12)).proxy(reqwest::Proxy::all(format!("http://{LOCAL_PROXY}")).map_err(|e| e.to_string())?).build().map_err(|e| e.to_string())?;
    for endpoint in ["https://api.ipify.org", "https://ifconfig.me/ip", "https://ipinfo.io/ip"] {
        if let Ok(response) = client.get(endpoint).send().await { if let Ok(body) = response.text().await { let ip = body.trim().to_string(); if !ip.is_empty() && ip.len() <= 64 { return Ok(ip); } } }
    }
    Err("Соединение через выбранный сервер не прошло проверку внешнего IP".to_string())
}

#[tauri::command]
async fn test_proxy_latency() -> Result<Option<u32>, String> {
    let started = Instant::now();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).proxy(reqwest::Proxy::all(format!("http://{LOCAL_PROXY}")).map_err(|e| e.to_string())?).build().map_err(|e| e.to_string())?;
    match client.get("https://www.gstatic.com/generate_204").send().await {
        Ok(response) if response.status().is_success() || response.status().as_u16() == 204 => Ok(Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32)),
        _ => Ok(None)
    }
}

#[tauri::command]
fn read_logs(app: AppHandle) -> Result<String, String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("kartoshka.log");
    Ok(fs::read_to_string(path).unwrap_or_default())
}

#[tauri::command]
async fn start_proxy(app: AppHandle, state: State<'_, ProxyState>, config_json: String) -> Result<(), String> {
    let parsed = serde_json::from_str::<serde_json::Value>(&config_json).map_err(|e| format!("Некорректная конфигурация JSON: {e}"))?;
    if parsed["inbounds"].get(0).and_then(|inbound| inbound["type"].as_str()) != Some("mixed") { return Err("Разрешён только proxy-режим".to_string()); }
    stop_runtime(state.inner())?;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let config_path = config_dir.join("sing-box.json");
    fs::write(&config_path, &config_json).map_err(|e| format!("Не удалось записать конфигурацию: {e}"))?;
    let config_arg = config_path.to_string_lossy().to_string();
    let command = app.shell().sidecar("sing-box").map_err(|e| format!("Не найден сетевой компонент: {e}"))?;
    let checked = command.args(["check", "-c", &config_arg]).output().await.map_err(|e| format!("Не удалось проверить конфигурацию sing-box: {e}"))?;
    if !checked.status.success() {
        let stderr = String::from_utf8_lossy(&checked.stderr).trim().to_string();
        return Err(if stderr.is_empty() { "sing-box отклонил конфигурацию".to_string() } else { format!("sing-box отклонил конфигурацию: {stderr}") });
    }
    let command = app.shell().sidecar("sing-box").map_err(|e| format!("Не найден сетевой компонент: {e}"))?;
    let (mut events, child) = command.args(["run", "-c", &config_arg]).spawn().map_err(|e| format!("Не удалось запустить подключение: {e}"))?;
    let child_pid = child.pid();
    for _ in 0..50 { if TcpStream::connect((LOCAL_PROXY_HOST, LOCAL_PROXY_PORT)).await.is_ok() && port_owned_by(child_pid) { break; } sleep(Duration::from_millis(100)).await; }
    if !port_owned_by(child_pid) { let mut child = child; let _ = child.kill(); return Err("Порт 127.0.0.1:2080 не принадлежит запущенному KartoshkaVPN sing-box".to_string()); }
    let snapshot = capture_proxy()?;
    let path = snapshot_path(&app)?;
    persist_snapshot(&path, &snapshot)?;
    let proxy_values = [RegistryValue { name: "ProxyServer".into(), kind: "REG_SZ".into(), value: LOCAL_PROXY.into() }, RegistryValue { name: "ProxyEnable".into(), kind: "REG_DWORD".into(), value: "1".into() }];
    if let Err(error) = proxy_values.iter().try_for_each(set_registry) { let _ = restore_snapshot(&snapshot, &path); let mut child = child; let _ = child.kill(); return Err(error); }
    let generation = { let mut runtime = state.0.lock().map_err(|_| "Не удалось сохранить состояние подключения".to_string())?; runtime.generation += 1; runtime.child = Some(child); runtime.snapshot = Some(snapshot); runtime.snapshot_path = Some(path); runtime.generation };
    append_log(&app, &format!("proxy started, sing-box pid={child_pid}"));
    let monitor_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while events.recv().await.is_some() {}
        if let Some(state) = monitor_app.try_state::<ProxyState>() {
            let mut runtime = state.0.lock().ok();
            if let Some(ref mut runtime) = runtime { if runtime.generation == generation { let _ = restore_runtime(runtime); append_log(&monitor_app, "sing-box exited unexpectedly; proxy restored"); let _ = monitor_app.emit("proxy-exited", "Подключение неожиданно завершилось"); } }
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_proxy(app: AppHandle, state: State<'_, ProxyState>) -> Result<(), String> { append_log(&app, "proxy stopped by user"); stop_runtime(state.inner()) }

fn main() {
    tauri::Builder::default().manage(ProxyState(Mutex::new(ProxyRuntime { child: None, snapshot: None, snapshot_path: None, generation: 0 }))).plugin(tauri_plugin_shell::init()).invoke_handler(tauri::generate_handler![fetch_subscription, test_latency, test_proxy_latency, probe_internet, read_logs, start_proxy, stop_proxy]).setup(|app| { match recover_persisted_snapshot(&app.handle()) { Ok(true) => append_log(&app.handle(), "recovered persisted Windows proxy snapshot"), Ok(false) => {}, Err(error) => append_log(&app.handle(), &format!("proxy recovery error: {error}")) }; Ok(()) }).build(tauri::generate_context!()).expect("ошибка запуска КартошкаVPN").run(|app, event| { if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) { if let Some(state) = app.try_state::<ProxyState>() { let _ = stop_runtime(state.inner()); } } });
}
