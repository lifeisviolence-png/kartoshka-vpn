const COMMANDS: &[&str] = &["ping", "start_test", "stop_test", "status"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .ios_path("ios")
    .build();
}
