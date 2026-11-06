#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, sync::Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct ProxyState(Mutex<Option<CommandChild>>);

#[tauri::command]
async fn fetch_subscription(url: String) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Ссылка подписки должна начинаться с http:// или https://".to_string());
    }
    reqwest::Client::builder()
        .user_agent("KartoshkaVPN/0.2")
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .text()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_proxy(app: AppHandle, state: State<'_, ProxyState>, config_json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&config_json).map_err(|error| format!("Некорректная конфигурация sing-box: {error}"))?;

    let config_dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let config_path = config_dir.join("sing-box.json");
    fs::write(&config_path, config_json).map_err(|error| error.to_string())?;

    if let Some(mut child) = state.0.lock().map_err(|_| "Не удалось получить состояние прокси")?.take() {
        let _ = child.kill();
    }

    let config_arg = config_path.to_string_lossy().to_string();
    let command = app.shell().sidecar("sing-box").map_err(|error| error.to_string())?;
    let (mut events, child) = command.args(["run", "-c", &config_arg]).spawn().map_err(|error| error.to_string())?;
    *state.0.lock().map_err(|_| "Не удалось сохранить состояние прокси")? = Some(child);

    tauri::async_runtime::spawn(async move {
        while events.recv().await.is_some() {}
    });
    Ok(())
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
        .invoke_handler(tauri::generate_handler![fetch_subscription, start_proxy, stop_proxy])
        .run(tauri::generate_context!())
        .expect("ошибка запуска КартошкаVPN");
}
