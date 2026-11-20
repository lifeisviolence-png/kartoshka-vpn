// Android/mobile entry point for the Phase 0 spike. The desktop binary keeps
// using main.rs; this library target is what Tauri's Android build links.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn android_phase0_ping() -> &'static str {
    "kartoshka-android-phase0"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_vpn::init())
        .invoke_handler(tauri::generate_handler![android_phase0_ping])
        .run(tauri::generate_context!())
        .expect("ошибка запуска KartoshkaVPN Android");
}
