fn main() {
    // Android 15+ supports 16 KiB pages. The linker flags must reach the final
    // cdylib link even when Cargo runs from the generated gen/android project,
    // where src-tauri/.cargo/config.toml is not an ancestor and is not read.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg=-Wl,-z,common-page-size=16384");
    }
    tauri_build::build();
}
