//! Обновление клиента из публичных GitHub Releases.
//!
//! Приложение не использует отдельный update-сервер и не требует токена:
//! последний стабильный релиз берётся из GitHub API, файл установщика
//! скачивается с GitHub и сверяется с SHA-256 из checksum-файла того же
//! релиза. Это проверка целостности, а не криптографическая подпись:
//! доверие к обновлению опирается на HTTPS и защищённость GitHub-аккаунта.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

const RELEASES_URL: &str = "https://api.github.com/repos/lifeisviolence-png/kartoshka-vpn/releases/latest";
const USER_AGENT: &str = concat!("KartoshkaVPN/", env!("CARGO_PKG_VERSION"), " (+https://github.com/lifeisviolence-png/kartoshka-vpn)");
pub const UPDATE_EVENT: &str = "client-update-progress";
const MAX_DOWNLOAD: usize = 160 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Platform {
    Windows,
    Macos,
}

impl Platform {
    fn current() -> Self {
        #[cfg(windows)]
        { Self::Windows }
        #[cfg(target_os = "macos")]
        { Self::Macos }
        #[cfg(not(any(windows, target_os = "macos")))]
        { Self::Windows }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Macos => "macos",
        }
    }

    fn asset_suffix(self) -> &'static str {
        match self {
            Self::Windows => "_x64-setup.exe",
            Self::Macos => "_universal.dmg",
        }
    }

    fn checksum_name(self) -> &'static str {
        match self {
            Self::Windows => "SHA256SUMS.txt",
            Self::Macos => "SHA256SUMS-macos.txt",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub notes: String,
    pub release_url: String,
    pub asset_name: Option<String>,
    pub asset_size: u64,
    pub checksum_name: Option<String>,
    pub can_install: bool,
    pub reason: Option<String>,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    stage: String,
    downloaded: u64,
    total: u64,
    message: String,
}

fn emit_progress(app: &AppHandle, stage: &str, downloaded: u64, total: u64, message: &str) {
    let _ = app.emit(
        UPDATE_EVENT,
        UpdateProgress {
            stage: stage.to_string(),
            downloaded,
            total,
            message: message.to_string(),
        },
    );
}

fn snippet(value: &str, limit: usize) -> String {
    let mut out: String = value.chars().take(limit).collect();
    if value.chars().count() > limit {
        out.push('…');
    }
    out
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Не удалось создать HTTP-клиент: {error}"))
}

async fn fetch_release(client: &reqwest::Client) -> Result<GhRelease, String> {
    let response = client
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("Не удалось обратиться к GitHub: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Не удалось прочитать ответ GitHub: {error}"))?;
    if !status.is_success() {
        return Err(format!("GitHub API вернул {status}: {}", snippet(&text, 240)));
    }
    let release: GhRelease = serde_json::from_str(&text)
        .map_err(|error| format!("Некорректный ответ GitHub API: {error}"))?;
    if release.draft || release.prerelease {
        return Err("Последний релиз GitHub помечен как draft/prerelease; обновление заблокировано".into());
    }
    Ok(release)
}

fn parse_version(value: &str) -> Result<semver::Version, String> {
    semver::Version::parse(value.trim().trim_start_matches('v'))
        .map_err(|error| format!("Некорректная версия «{value}»: {error}"))
}

fn asset_for<'a>(release: &'a GhRelease, version: &str, platform: Platform) -> Option<&'a GhAsset> {
    let prefix = format!("KartoshkaVPN_{version}_");
    release
        .assets
        .iter()
        .find(|asset| {
            asset.name.starts_with(&prefix)
                && asset.name.ends_with(platform.asset_suffix())
                && !asset.name.ends_with(".sig")
                && asset.browser_download_url.starts_with("https://")
        })
}

fn checksum_asset<'a>(release: &'a GhRelease, platform: Platform) -> Option<&'a GhAsset> {
    release
        .assets
        .iter()
        .find(|asset| asset.name == platform.checksum_name() && asset.browser_download_url.starts_with("https://"))
}

fn install_location_reason(platform: Platform) -> Option<String> {
    if platform != Platform::Macos {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        let app = match current_app_bundle() {
            Ok(path) => path,
            Err(error) => return Some(error),
        };
        let text = app.to_string_lossy();
        if text.starts_with("/Volumes/") {
            return Some("Приложение запущено из DMG. Перетащите его в Applications и повторите проверку.".into());
        }
        if text.contains("AppTranslocation") {
            return Some("macOS запустила приложение из временной папки. Переместите его в Applications и повторите.".into());
        }
        let parent = match app.parent() {
            Some(parent) => parent,
            None => return Some("Не удалось определить папку приложения.".into()),
        };
        if !parent.is_dir() {
            return Some("Папка приложения недоступна для записи.".into());
        }
    }
    None
}

fn evaluate_release(
    release: &GhRelease,
    current_version: &str,
    platform: Platform,
) -> Result<ClientUpdateInfo, String> {
    let current = parse_version(current_version)?;
    let latest = parse_version(&release.tag_name)?;
    let available = latest > current;
    let asset = asset_for(release, &latest.to_string(), platform);
    let checksum = checksum_asset(release, platform);
    let mut reason = None;
    if available && asset.is_none() {
        reason = Some(format!(
            "В релизе {} нет подходящего файла {}.",
            latest,
            platform.asset_suffix()
        ));
    } else if available && checksum.is_none() {
        reason = Some(format!("В релизе {} нет файла контрольных сумм {}.", latest, platform.checksum_name()));
    } else if available {
        reason = install_location_reason(platform);
    }
    let can_install = available && asset.is_some() && checksum.is_some() && reason.is_none();
    Ok(ClientUpdateInfo {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        available,
        notes: release
            .body
            .as_deref()
            .unwrap_or("")
            .trim()
            .chars()
            .take(6000)
            .collect(),
        release_url: release.html_url.clone(),
        asset_name: asset.map(|item| item.name.clone()),
        asset_size: asset.map(|item| item.size).unwrap_or(0),
        checksum_name: checksum.map(|item| item.name.clone()),
        can_install,
        reason,
        platform: platform.label().to_string(),
    })
}

fn checksum_for(text: &str, asset_name: &str) -> Option<String> {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(hash), Some(name)) = (parts.next(), parts.next()) else {
            continue;
        };
        let name = name.trim_start_matches('*');
        if name == asset_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

fn hex_sha256(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

async fn download_asset(
    app: &AppHandle,
    client: &reqwest::Client,
    asset: &GhAsset,
) -> Result<Vec<u8>, String> {
    emit_progress(app, "downloading", 0, asset.size, "Скачиваем обновление с GitHub…");
    let response = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|error| format!("Не удалось скачать обновление: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GitHub вернул {status} при скачивании обновления"));
    }
    let total = response.content_length().unwrap_or(asset.size);
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Не удалось прочитать обновление: {error}"))?;
    if bytes.len() > MAX_DOWNLOAD {
        return Err("Файл обновления слишком большой".into());
    }
    if asset.size > 0 && bytes.len() as u64 != asset.size {
        return Err(format!(
            "Размер обновления не совпал: получено {}, ожидалось {}",
            bytes.len(),
            asset.size
        ));
    }
    emit_progress(app, "verifying", bytes.len() as u64, total, "Проверяем SHA-256…");
    Ok(bytes.to_vec())
}

async fn download_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Не удалось скачать контрольные суммы: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GitHub вернул {status} при скачивании контрольных сумм"));
    }
    response
        .text()
        .await
        .map_err(|error| format!("Не удалось прочитать контрольные суммы: {error}"))
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes).map_err(|error| format!("Не удалось сохранить обновление: {error}"))
}

fn update_log(message: &str) {
    let Some(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("kartoshka-update.log"))
        .ok()
    else {
        return;
    };
    let _ = writeln!(file, "{message}");
}

#[cfg(target_os = "macos")]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub async fn check_client_update(app: AppHandle) -> Result<ClientUpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let client = http_client(Duration::from_secs(20))?;
    let release = fetch_release(&client).await?;
    let info = evaluate_release(&release, &current, Platform::current())?;
    super::append_log(
        &app,
        &format!(
            "Проверка обновления клиента: установлено {}, на GitHub {}",
            info.current_version, info.latest_version
        ),
    );
    Ok(info)
}

pub async fn install_client_update(app: AppHandle, version: String) -> Result<(), String> {
    let expected = version.trim().trim_start_matches('v').to_string();
    let current = app.package_info().version.to_string();
    let client = http_client(Duration::from_secs(15 * 60))?;
    let release = fetch_release(&client).await?;
    let platform = Platform::current();
    let info = evaluate_release(&release, &current, platform)?;
    if !info.available {
        return Err("Обновление больше не доступно".into());
    }
    if info.latest_version.trim_start_matches('v') != expected {
        return Err("Версия релиза изменилась. Проверьте обновление ещё раз.".into());
    }
    if !info.can_install {
        return Err(info.reason.unwrap_or_else(|| "Установка обновления недоступна".into()));
    }
    let latest = parse_version(&info.latest_version)?;
    let asset = asset_for(&release, &latest.to_string(), platform)
        .ok_or("В релизе нет установщика для этой платформы")?;
    let checksum_asset = checksum_asset(&release, platform)
        .ok_or("В релизе нет файла контрольных сумм")?;
    let checksum_text = download_text(&client, &checksum_asset.browser_download_url).await?;
    let expected_hash = checksum_for(&checksum_text, &asset.name)
        .ok_or_else(|| format!("В контрольных суммах нет записи для {}", asset.name))?;
    let bytes = download_asset(&app, &client, asset).await?;
    let actual_hash = hex_sha256(&bytes);
    if actual_hash != expected_hash {
        return Err("SHA-256 скачанного обновления не совпал. Установка отменена.".into());
    }
    if let Some(digest) = asset.digest.as_deref().and_then(|value| value.strip_prefix("sha256:")) {
        if digest.to_ascii_lowercase() != actual_hash {
            return Err("SHA-256 не совпал с digest GitHub. Установка отменена.".into());
        }
    }
    let ext = match platform {
        Platform::Windows => "exe",
        Platform::Macos => "dmg",
    };
    let artifact = std::env::temp_dir().join(format!(
        "KartoshkaVPN-update-{}-{}.{}",
        latest,
        std::process::id(),
        ext
    ));
    write_private_file(&artifact, &bytes)?;
    emit_progress(&app, "verified", bytes.len() as u64, bytes.len() as u64, "SHA-256 совпал");

    let current_exe = std::env::current_exe().map_err(|error| format!("Не удалось найти исполняемый файл: {error}"))?;
    let helper = std::env::temp_dir().join(format!(
        "KartoshkaVPN-update-helper-{}{}",
        std::process::id(),
        if cfg!(windows) { ".exe" } else { "" }
    ));
    fs::copy(&current_exe, &helper).map_err(|error| format!("Не удалось подготовить helper обновления: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&helper, fs::Permissions::from_mode(0o700));
    }
    let target = match platform {
        Platform::Windows => current_exe,
        Platform::Macos => {
            #[cfg(target_os = "macos")]
            { current_app_bundle()? }
            #[cfg(not(target_os = "macos"))]
            { return Err("Установка macOS-обновления доступна только на macOS".into()); }
        }
    };
    let mut command = Command::new(&helper);
    command
        .arg("--client-update-install")
        .arg(&artifact)
        .arg(std::process::id().to_string())
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map_err(|error| format!("Не удалось запустить helper обновления: {error}"))?;
    update_log(&format!(
        "helper запущен: версия {}, файл {}, цель {}",
        latest,
        artifact.display(),
        target.display()
    ));
    super::append_log(&app, &format!("Обновление клиента {} скачано и проверено; helper запущен", latest));
    emit_progress(&app, "ready", bytes.len() as u64, bytes.len() as u64, "Обновление готово к установке");
    Ok(())
}

fn process_alive(pid: u32) -> bool {
    #[cfg(target_os = "macos")]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        if result == 0 {
            return true;
        }
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }
    #[cfg(windows)]
    {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output();
        return output
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")))
            .unwrap_or(true);
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        Command::new("kill").args(["-0", &pid.to_string()]).status().map(|status| status.success()).unwrap_or(true)
    }
}

fn wait_for_parent(pid: u32, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    while process_alive(pid) {
        if started.elapsed() > timeout {
            return Err("Приложение не закрылось за отведённое время".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_checked(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("Не удалось запустить {program}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} завершился с ошибкой {}: {}",
            output.status,
            snippet(&String::from_utf8_lossy(&output.stderr), 300)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(windows)]
fn install_windows(artifact: &Path, target: &Path) -> Result<(), String> {
    update_log(&format!("Windows: запускаем {}", artifact.display()));
    let silent = Command::new(artifact).arg("/S").status();
    if !matches!(silent, Ok(status) if status.success()) {
        update_log("Windows: тихая установка не удалась, открываем обычный установщик");
        Command::new(artifact)
            .status()
            .map_err(|error| format!("Не удалось запустить установщик: {error}"))?;
    }
    std::thread::sleep(Duration::from_secs(4));
    if target.exists() {
        Command::new(target)
            .spawn()
            .map_err(|error| format!("Не удалось перезапустить приложение: {error}"))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn find_app(mount: &Path) -> Result<PathBuf, String> {
    let entries = fs::read_dir(mount).map_err(|error| format!("Не удалось прочитать DMG: {error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("app") {
            if path.join("Contents/MacOS").is_dir() {
                return Ok(path);
            }
        }
    }
    Err("В DMG не найден .app".into())
}

#[cfg(target_os = "macos")]
fn admin_replace(staging: &Path, target: &Path) -> Result<(), String> {
    let script = std::env::temp_dir().join(format!("kartoshka-update-{}.sh", std::process::id()));
    let next = target.with_extension("app.kartoshka-new");
    let body = format!(
        "#!/bin/sh\nset -e\nrm -rf -- {}\nditto {} {}\nrm -rf -- {}\nmv {} {}\n",
        shell_quote(&next.to_string_lossy()),
        shell_quote(&staging.to_string_lossy()),
        shell_quote(&next.to_string_lossy()),
        shell_quote(&target.to_string_lossy()),
        shell_quote(&next.to_string_lossy()),
        shell_quote(&target.to_string_lossy())
    );
    fs::write(&script, body).map_err(|error| format!("Не удалось создать скрипт обновления: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&script, fs::Permissions::from_mode(0o700));
    }
    let apple = format!(
        "do shell script \"/bin/sh {}\" with administrator privileges",
        shell_quote(&script.to_string_lossy())
    );
    let status = Command::new("/usr/bin/osascript")
        .args(["-e", &apple])
        .status()
        .map_err(|error| format!("Не удалось запросить права администратора: {error}"))?;
    let _ = fs::remove_file(&script);
    if status.success() {
        Ok(())
    } else {
        Err("Установка отменена или не разрешена администратором".into())
    }
}

#[cfg(target_os = "macos")]
fn replace_app(staging: &Path, target: &Path) -> Result<(), String> {
    let backup = target.with_extension("app.kartoshka-old");
    let _ = fs::remove_dir_all(&backup);
    fs::rename(target, &backup).map_err(|error| format!("Не удалось подготовить замену приложения: {error}"))?;
    let staging_string = staging.to_string_lossy().to_string();
    let target_string = target.to_string_lossy().to_string();
    match run_checked(
        "/usr/bin/ditto",
        &[&staging_string, &target_string],
    ) {
        Ok(_) => {
            let _ = fs::remove_dir_all(&backup);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_dir_all(target);
            let _ = fs::rename(&backup, target);
            Err(format!("Не удалось заменить приложение: {error}"))
        }
    }
}

#[cfg(target_os = "macos")]
fn install_macos(artifact: &Path, target: &Path) -> Result<(), String> {
    let mount = std::env::temp_dir().join(format!("kartoshka-dmg-{}", std::process::id()));
    let _ = fs::remove_dir_all(&mount);
    fs::create_dir_all(&mount).map_err(|error| format!("Не удалось создать точку монтирования: {error}"))?;
    update_log(&format!("macOS: монтируем {}", artifact.display()));
    let mount_string = mount.to_string_lossy().to_string();
    let artifact_string = artifact.to_string_lossy().to_string();
    run_checked("/usr/bin/hdiutil", &["attach", "-nobrowse", "-readonly", "-mountpoint", &mount_string, &artifact_string])?;
    let result = (|| -> Result<(), String> {
        let mounted_app = find_app(&mount)?;
        let staging = std::env::temp_dir().join(format!(".KartoshkaVPN-update-{}.app", std::process::id()));
        let _ = fs::remove_dir_all(&staging);
        update_log(&format!("macOS: копируем {} в staging", mounted_app.display()));
        let mounted_string = mounted_app.to_string_lossy().to_string();
        let staging_string = staging.to_string_lossy().to_string();
        run_checked("/usr/bin/ditto", &[&mounted_string, &staging_string])?;
        if !staging.join("Contents/MacOS").is_dir() {
            return Err("Скопированное приложение повреждено".into());
        }
        match replace_app(&staging, target) {
            Ok(()) => {}
            Err(direct_error) => {
                update_log(&format!("macOS: прямая замена не удалась ({direct_error}); пробуем администратора"));
                admin_replace(&staging, target)?;
            }
        }
        let _ = fs::remove_dir_all(&staging);
        Ok(())
    })();
    let _ = run_checked("/usr/bin/hdiutil", &["detach", &mount_string, "-force"]);
    let _ = fs::remove_dir_all(&mount);
    result?;
    let _ = Command::new("/usr/bin/open").arg(target).spawn();
    update_log("macOS: новая версия установлена и запущена");
    Ok(())
}

#[cfg(target_os = "macos")]
fn current_app_bundle() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| format!("Не удалось найти приложение: {error}"))?;
    let macos_dir = executable.parent().ok_or("Не удалось найти Contents/MacOS")?;
    let contents = macos_dir.parent().ok_or("Не удалось найти Contents")?;
    let app = contents.parent().ok_or("Не удалось найти .app")?;
    if app.extension().and_then(|value| value.to_str()) != Some("app") {
        return Err("Приложение запущено не из .app".into());
    }
    Ok(app.to_path_buf())
}

pub fn run_install_helper(args: &[OsString]) -> Result<(), String> {
    if args.len() != 5 {
        return Err("Неверные параметры установки обновления".into());
    }
    let artifact = PathBuf::from(&args[2]);
    let parent_pid = args[3]
        .to_str()
        .ok_or("Неверный PID")?
        .parse::<u32>()
        .map_err(|_| "Неверный PID")?;
    let target = PathBuf::from(&args[4]);
    update_log(&format!("helper стартовал; parent={parent_pid}, artifact={}", artifact.display()));
    wait_for_parent(parent_pid, Duration::from_secs(180))?;
    #[cfg(windows)]
    let result = install_windows(&artifact, &target);
    #[cfg(target_os = "macos")]
    let result = install_macos(&artifact, &target);
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let result: Result<(), String> = Err("Установка обновлений поддерживается только в Windows и macOS".into());
    let _ = fs::remove_file(&artifact);
    #[cfg(not(windows))]
    let _ = fs::remove_file(std::env::current_exe().unwrap_or_default());
    if let Err(error) = &result {
        update_log(&format!("helper ошибка: {error}"));
        #[cfg(target_os = "macos")]
        {
            if target.exists() {
                let _ = Command::new("/usr/bin/open").arg(&target).spawn();
            } else {
                let _ = Command::new("/usr/bin/open").arg(&artifact).spawn();
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release() -> GhRelease {
        serde_json::from_value(serde_json::json!({
            "tag_name": "v0.9.9",
            "html_url": "https://github.com/lifeisviolence-png/kartoshka-vpn/releases/tag/v0.9.9",
            "body": "Что нового",
            "prerelease": false,
            "draft": false,
            "assets": [
                {"name": "KartoshkaVPN_0.9.9_x64-setup.exe", "browser_download_url": "https://example.test/app.exe", "size": 10},
                {"name": "SHA256SUMS.txt", "browser_download_url": "https://example.test/SHA256SUMS.txt", "size": 100},
                {"name": "KartoshkaVPN_0.9.9_universal.dmg", "browser_download_url": "https://example.test/app.dmg", "size": 20},
                {"name": "SHA256SUMS-macos.txt", "browser_download_url": "https://example.test/SHA256SUMS-macos.txt", "size": 100}
            ]
        }))
        .expect("fixture")
    }

    #[test]
    fn version_comparison_is_semver_based() {
        assert!(parse_version("v0.9.10").unwrap() > parse_version("0.9.9").unwrap());
        assert!(parse_version("1.0.0").unwrap() > parse_version("0.99.99").unwrap());
    }

    #[test]
    fn selects_windows_and_macos_assets() {
        let release = release();
        let windows = evaluate_release(&release, "0.9.8", Platform::Windows).unwrap();
        assert!(windows.available);
        assert_eq!(windows.asset_name.as_deref(), Some("KartoshkaVPN_0.9.9_x64-setup.exe"));
        assert_eq!(windows.checksum_name.as_deref(), Some("SHA256SUMS.txt"));
        assert!(windows.can_install);
        let mac = evaluate_release(&release, "0.9.8", Platform::Macos).unwrap();
        assert_eq!(mac.asset_name.as_deref(), Some("KartoshkaVPN_0.9.9_universal.dmg"));
        assert_eq!(mac.checksum_name.as_deref(), Some("SHA256SUMS-macos.txt"));
    }

    #[test]
    fn refuses_without_checksum() {
        let mut release = release();
        release.assets.retain(|asset| asset.name != "SHA256SUMS.txt");
        let info = evaluate_release(&release, "0.9.8", Platform::Windows).unwrap();
        assert!(info.available);
        assert!(!info.can_install);
        assert!(info.reason.unwrap().contains("контрольных сумм"));
    }

    #[test]
    fn same_version_is_not_an_update() {
        let info = evaluate_release(&release(), "0.9.9", Platform::Windows).unwrap();
        assert!(!info.available);
        assert!(!info.can_install);
    }

    #[test]
    fn parses_checksum_file() {
        let hash = "a".repeat(64);
        assert_eq!(checksum_for(&format!("{hash}  app.exe\n"), "app.exe").as_deref(), Some(hash.as_str()));
        assert!(checksum_for("bad  app.exe\n", "app.exe").is_none());
        assert!(checksum_for(&format!("{hash}  other.exe\n"), "app.exe").is_none());
    }

    #[test]
    fn hashes_bytes() {
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
