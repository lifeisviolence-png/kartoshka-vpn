#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, sync::Mutex, time::Instant};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use tokio::{net::TcpStream, time::{sleep, timeout, Duration}};

struct ProxyState(Mutex<Option<CommandChild>>);

#[derive(Serialize)]
struct SubscriptionResponse {
    body: String,
    userinfo: Option<String>,
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

    let response = reqwest::Client::builder()
        .user_agent("KartoshkaVPN/0.4")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| error.to_string())?
        .get(trimmed)
        .header("Accept", "text/plain, text/*, */*")
        .send()
        .await
        .map_err(|error| format!("Не удалось открыть подписку: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Сервер подписки вернул ошибку: {error}"))?;

    let userinfo = response.headers().get("subscription-userinfo")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response.text().await.map_err(|error| format!("Не удалось прочитать подписку: {error}"))?;
    Ok(SubscriptionResponse { body, userinfo })
}

#[tauri::command]
async fn test_latency(host: String, port: u16) -> Result<Option<u32>, String> {
    let started = Instant::now();
    let address = format!("{host}:{port}");
    match timeout(Duration::from_secs(5), TcpStream::connect(address)).await {
        Ok(Ok(_)) => Ok(Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32)),
        Ok(Err(_)) | Err(_) => Ok(None),
    }
}

#[tauri::command]
async fn probe_internet(mode: String) -> Result<String, String> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(12));
    if mode == "proxy" {
        builder = builder.proxy(reqwest::Proxy::all("http://127.0.0.1:2080").map_err(|error| error.to_string())?);
    }
    let client = builder.build().map_err(|error| error.to_string())?;
    for endpoint in ["https://api.ipify.org", "https://ifconfig.me/ip", "https://ipinfo.io/ip"] {
        if let Ok(response) = client.get(endpoint).send().await {
            if let Ok(body) = response.text().await {
                let ip = body.trim().to_string();
                if !ip.is_empty() && ip.len() <= 64 { return Ok(ip); }
            }
        }
    }
    Err("VPN запущен, но проверка выхода в интернет не прошла. Проверьте сервер, DNS и маршрут.".to_string())
}

#[tauri::command]
async fn start_proxy(app: AppHandle, state: State<'_, ProxyState>, config_json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&config_json)
        .map_err(|error| format!("Некорректная конфигурация sing-box: {error}"))?;

    let config_dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let config_path = config_dir.join("sing-box.json");
    fs::write(&config_path, &config_json).map_err(|error| error.to_string())?;

    if let Some(mut child) = state.0.lock().map_err(|_| "Не удалось получить состояние прокси")?.take() {
        let _ = child.kill();
    }

    let config_arg = config_path.to_string_lossy().to_string();
    let command = app.shell().sidecar("sing-box").map_err(|error| format!("Не найден sing-box: {error}"))?;
    let (mut events, mut child) = command.args(["run", "-c", &config_arg]).spawn()
        .map_err(|error| format!("Не удалось запустить sing-box: {error}"))?;

    tauri::async_runtime::spawn(async move {
        while events.recv().await.is_some() {}
    });

    let parsed_config = serde_json::from_str::<serde_json::Value>(&config_json).unwrap_or_default();
    let is_tun = parsed_config["inbounds"].get(0).and_then(|inbound| inbound["type"].as_str()) == Some("tun");
    for _ in 0..30 {
        if (is_tun && TcpStream::connect("1.1.1.1:443").await.is_ok()) || (!is_tun && TcpStream::connect("127.0.0.1:2080").await.is_ok()) {
            *state.0.lock().map_err(|_| "Не удалось сохранить состояние прокси")? = Some(child);
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }

    let _ = child.kill();
    Err("sing-box не поднял локальный прокси 127.0.0.1:2080. Проверьте конфигурацию узла и журнал приложения.".to_string())
}

#[tauri::command]
fn stop_proxy(state: State<'_, ProxyState>) -> Result<(), String> {
    if let Some(mut child) = state.0.lock().map_err(|_| "Не удалось получить состояние прокси")?.take() {
        child.kill().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(ProxyState(Mutex::new(None)))
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![fetch_subscription, test_latency, probe_internet, start_proxy, stop_proxy])
        .run(tauri::generate_context!())
        .expect("ошибка запуска КартошкаVPN");
}
