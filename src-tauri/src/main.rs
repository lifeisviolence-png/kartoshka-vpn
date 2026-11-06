#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, process::Command as ProcessCommand, sync::Mutex, time::Instant};
use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use tokio::{net::TcpStream, time::{sleep, timeout, Duration}};

const PROXY_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const LOCAL_PROXY: &str = "127.0.0.1:2080";

struct ProxySnapshot {
    values: Vec<(&'static str, &'static str, String)>,
}

struct ProxyRuntime {
    child: Option<CommandChild>,
    snapshot: Option<ProxySnapshot>,
}

struct ProxyState(Mutex<ProxyRuntime>);

#[derive(Serialize)]
struct SubscriptionResponse {
    body: String,
    userinfo: Option<String>,
}

#[cfg(windows)]
fn registry_value(name: &'static str, kind: &'static str) -> Option<(&'static str, &'static str, String)> {
    let output = ProcessCommand::new("reg").args(["query", PROXY_KEY, "/v", name]).output().ok()?;
    if !output.status.success() { return None; }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|line| line.contains(name))?;
    let value = line.split_whitespace().last()?.to_string();
    Some((name, kind, value))
}

#[cfg(not(windows))]
fn registry_value(_name: &'static str, _kind: &'static str) -> Option<(&'static str, &'static str, String)> { None }

fn capture_proxy() -> ProxySnapshot {
    let mut values = Vec::new();
    for (name, kind) in [("ProxyEnable", "REG_DWORD"), ("ProxyServer", "REG_SZ"), ("ProxyOverride", "REG_SZ"), ("AutoConfigURL", "REG_SZ"), ("AutoDetect", "REG_DWORD")] {
        if let Some(value) = registry_value(name, kind) { values.push(value); }
    }
    ProxySnapshot { values }
}

#[cfg(windows)]
fn set_registry(name: &str, kind: &str, value: &str) {
    let _ = ProcessCommand::new("reg").args(["add", PROXY_KEY, "/v", name, "/t", kind, "/d", value, "/f"]).status();
}

#[cfg(not(windows))]
fn set_registry(_name: &str, _kind: &str, _value: &str) {}

#[cfg(windows)]
fn delete_registry(name: &str) {
    let _ = ProcessCommand::new("reg").args(["delete", PROXY_KEY, "/v", name, "/f"]).status();
}

#[cfg(not(windows))]
fn delete_registry(_name: &str) {}

fn enable_proxy() -> ProxySnapshot {
    let snapshot = capture_proxy();
    set_registry("ProxyServer", "REG_SZ", LOCAL_PROXY);
    set_registry("ProxyEnable", "REG_DWORD", "1");
    snapshot
}

fn restore_proxy(snapshot: Option<ProxySnapshot>) {
    if let Some(snapshot) = snapshot {
        for name in ["ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL", "AutoDetect"] {
            delete_registry(name);
        }
        for (name, kind, value) in snapshot.values {
            set_registry(name, kind, &value);
        }
    }
}

fn stop_runtime(state: &ProxyState) {
    if let Ok(mut runtime) = state.0.lock() {
        if let Some(mut child) = runtime.child.take() { let _ = child.kill(); }
        restore_proxy(runtime.snapshot.take());
    }
}

#[tauri::command]
async fn fetch_subscription(url: String) -> Result<SubscriptionResponse, String> {
    let trimmed = url.trim().to_string();
    if trimmed.starts_with("vless://") || trimmed.starts_with("vmess://") || trimmed.starts_with("trojan://") || trimmed.starts_with("ss://") || trimmed.starts_with("hysteria2://") {
        return Ok(SubscriptionResponse { body: trimmed, userinfo: None });
    }
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Ссылка должна начинаться с http:// или https://".to_string());
    }
    let response = reqwest::Client::builder().user_agent("KartoshkaVPN/0.6").redirect(reqwest::redirect::Policy::limited(5)).build()
        .map_err(|error| error.to_string())?.get(trimmed).header("Accept", "text/plain, text/*, */*").send().await
        .map_err(|error| format!("Не удалось открыть подписку: {error}"))?.error_for_status()
        .map_err(|error| format!("Сервер подписки вернул ошибку: {error}"))?;
    let userinfo = response.headers().get("subscription-userinfo").and_then(|value| value.to_str().ok()).map(str::to_owned);
    let body = response.text().await.map_err(|error| format!("Не удалось прочитать подписку: {error}"))?;
    Ok(SubscriptionResponse { body, userinfo })
}

#[tauri::command]
async fn test_latency(host: String, port: u16) -> Result<Option<u32>, String> {
    let started = Instant::now();
    match timeout(Duration::from_secs(5), TcpStream::connect(format!("{host}:{port}"))).await {
        Ok(Ok(_)) => Ok(Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32)),
        Ok(Err(_)) | Err(_) => Ok(None),
    }
}

#[tauri::command]
async fn probe_internet() -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(12))
        .proxy(reqwest::Proxy::all(format!("http://{LOCAL_PROXY}")).map_err(|error| error.to_string())?)
        .build().map_err(|error| error.to_string())?;
    for endpoint in ["https://api.ipify.org", "https://ifconfig.me/ip", "https://ipinfo.io/ip"] {
        if let Ok(response) = client.get(endpoint).send().await {
            if let Ok(body) = response.text().await {
                let ip = body.trim().to_string();
                if !ip.is_empty() && ip.len() <= 64 { return Ok(ip); }
            }
        }
    }
    Err("Соединение с сервером установлено, но интернет через него не прошёл проверку".to_string())
}

#[tauri::command]
async fn start_proxy(app: AppHandle, state: State<'_, ProxyState>, config_json: String) -> Result<(), String> {
    let parsed = serde_json::from_str::<serde_json::Value>(&config_json).map_err(|error| format!("Некорректная конфигурация: {error}"))?;
    if parsed["inbounds"].get(0).and_then(|inbound| inbound["type"].as_str()) != Some("mixed") {
        return Err("Разрешён только proxy-режим".to_string());
    }
    stop_runtime(state.inner());
    let config_dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let config_path = config_dir.join("sing-box.json");
    fs::write(&config_path, &config_json).map_err(|error| error.to_string())?;
    let config_arg = config_path.to_string_lossy().to_string();
    let command = app.shell().sidecar("sing-box").map_err(|error| format!("Не найден сетевой компонент: {error}"))?;
    let (mut events, mut child) = command.args(["run", "-c", &config_arg]).spawn().map_err(|error| format!("Не удалось запустить подключение: {error}"))?;
    tauri::async_runtime::spawn(async move { while events.recv().await.is_some() {} });
    for _ in 0..50 {
        if TcpStream::connect(LOCAL_PROXY).await.is_ok() {
            let snapshot = enable_proxy();
            let mut runtime = state.0.lock().map_err(|_| "Не удалось сохранить состояние подключения")?;
            runtime.child = Some(child);
            runtime.snapshot = Some(snapshot);
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill();
    Err("Не удалось запустить локальное подключение".to_string())
}

#[tauri::command]
fn stop_proxy(state: State<'_, ProxyState>) -> Result<(), String> {
    stop_runtime(state.inner());
    Ok(())
}

fn main() {
    tauri::Builder::default().manage(ProxyState(Mutex::new(ProxyRuntime { child: None, snapshot: None })))
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![fetch_subscription, test_latency, probe_internet, start_proxy, stop_proxy])
        .build(tauri::generate_context!()).expect("ошибка запуска КартошкаVPN")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app.try_state::<ProxyState>() { stop_runtime(state.inner()); }
            }
        });
}
