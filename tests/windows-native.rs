// Compiled into the native binary's Windows unit-test harness. These tests intentionally
// change the runner's *real* HKCU WinINet values. Run only on a disposable Windows runner.
use super::*;
use std::{io::{Read, Write}, net::TcpListener};

struct RegistryGuard { values: Vec<(&'static str, Option<RawValue>)>, flags: u32 }
impl RegistryGuard {
    fn capture() -> Self { Self { values: NAMES.into_iter().map(|name| (name, windows::get(name).unwrap())).collect(), flags: windows::flags().unwrap() } }
}
impl Drop for RegistryGuard {
    fn drop(&mut self) {
        let _lock = match windows::lock() { Ok(lock) => Some(lock), Err(e) => { eprintln!("FATAL: runner cleanup lock: {e}"); None } };
        if let Err(e) = windows::set_flags(self.flags) { eprintln!("FATAL: runner flags cleanup: {e}"); }
        for (name, value) in &self.values { if let Err(e) = windows::set(name, value) { eprintln!("FATAL: runner registry cleanup {name}: {e}"); } }
        if let Err(e) = windows::notify() { eprintln!("FATAL: runner WinINet cleanup: {e}"); }
    }
}
fn saved() -> Vec<Option<RawValue>> { NAMES.into_iter().map(|name| windows::get(name).unwrap()).collect() }
// FLAGS_UI is derived: a configured-but-disabled ProxyServer can add the proxy
// bit. Only PAC/auto-detect change the safety meaning of the state.
fn assert_same_indicator(name: &str, actual: &Option<RawValue>, expected: &Option<RawValue>) {
    assert!(same_indicator(name, actual, expected), "{name}: {actual:?} != {expected:?}");
}
fn assert_no_pac(flags: u32, context: &str) {
    assert_eq!(flags & (4 | 8), 0, "{context}: PAC/autodetect bits present: {flags}");
}
fn assert_saved(expected: &[Option<RawValue>], context: &str) {
    let actual = saved();
    // WinINet deletes zero-valued AutoDetect/ProxyEnable when FLAGS is direct.
    // That is the same setting, but its exact bytes are not preserved.
    let equal = actual.len() == expected.len() && NAMES.iter().zip(actual.iter().zip(expected.iter())).all(|(name, (a, b))| same_indicator(name, a, b));
    assert!(equal, "{context}: saved={actual:?}; expected={expected:?}");
}
fn registry_dump() -> String {
    NAMES.iter().map(|name| format!("{name}={:?}", windows::get(name).unwrap())).collect::<Vec<_>>().join(", ")
}
fn wait_direct(timeout: Duration) -> u32 {
    let deadline = Instant::now() + timeout;
    loop {
        let flags = windows::flags().unwrap();
        if flags == 1 || Instant::now() >= deadline { return flags; }
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn baseline(case: usize) {
    assert!(case < 2);
    // A nonempty AutoConfigURL makes WinINet report PROXY_TYPE_AUTO_PROXY_URL even
    // after FLAGS is written as direct (the observed CI failure: 5 instead of 1).
    // Clear PAC first, write the flags, then seed the exact raw values under test.
    let server = text("старый proxy:8181;http=пример.example:8888");
    let override_value = text("<local>;*.example.test;10.*");
    windows::set("ProxyServer", &server).unwrap();
    windows::set("ProxyOverride", &override_value).unwrap();
    windows::set("AutoConfigURL", &None).unwrap();
    windows::set_flags(1).unwrap();
    windows::set("AutoDetect", &if case == 0 { dword(0) } else { None }).unwrap();
    windows::set("ProxyEnable", &if case == 0 { dword(0) } else { None }).unwrap();
    windows::notify().unwrap();
    let flags = wait_direct(Duration::from_secs(2));
    assert_eq!(flags, 1, "baseline must be direct in FLAGS_UI; flags={flags}; {}", registry_dump());
    assert_eq!(windows::get("ProxyServer").unwrap(), server);
    assert_eq!(windows::get("ProxyOverride").unwrap(), override_value);
    assert_eq!(windows::get("AutoConfigURL").unwrap(), None, "PAC must be absent; {}", registry_dump());
    // Windows recreates a zero DWORD instead of keeping the value absent, so both
    // cases describe the same inactive indicator; exact bytes are asserted after restore.
    assert_same_indicator("AutoDetect", &windows::get("AutoDetect").unwrap(), &dword(0));
    assert_same_indicator("ProxyEnable", &windows::get("ProxyEnable").unwrap(), &dword(0));
    require_no_foreign_proxy(&capture_proxy().unwrap()).expect("baseline must pass the production conflict check");
}
fn empty_runtime() -> ProxyRuntime { ProxyRuntime { child: None, watchdog: None, snapshot_path: None, ports: Vec::new(), generation: 0 } }
fn disposable_ci() -> bool {
    let yes = std::env::var("CI").as_deref() == Ok("true")
        && std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true")
        && std::env::var("RUNNER_ENVIRONMENT").as_deref() == Ok("github-hosted")
        && std::env::var("KARTOVPN_DISPOSABLE_WINDOWS_CI").as_deref() == Ok("1");
    if !yes { eprintln!("SKIP: real HKCU tests run only on explicitly authorized disposable GitHub-hosted CI"); }
    yes
}
static ENV_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
struct NativeEnv { dir: PathBuf, path: PathBuf, binary: PathBuf, assets: PathBuf, config: String }
impl NativeEnv {
    fn new() -> Self {
        let binary = PathBuf::from(std::env::var_os("XRAY_TEST_BINARY").expect("XRAY_TEST_BINARY is required"));
        let assets = PathBuf::from(std::env::var_os("XRAY_TEST_ASSETS").expect("XRAY_TEST_ASSETS is required"));
        let config = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/xray-proxy-smoke.json")).unwrap();
        let dir = std::env::temp_dir().join(format!("kartoshka-case-{}-{}", std::process::id(), ENV_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        fs::create_dir_all(&dir).unwrap();
        Self { path: dir.join("proxy-snapshot.json"), dir, binary, assets, config }
    }
}
impl Drop for NativeEnv { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.dir); } }
fn local_http_probe() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut request = [0; 4096];
        let n = stream.read(&mut request).unwrap();
        assert!(std::str::from_utf8(&request[..n]).unwrap().contains("GET"));
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nlocal-ok").unwrap();
    });
    let mut proxy = StdTcpStream::connect("127.0.0.1:2080").unwrap();
    proxy.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(proxy, "GET http://{addr}/test HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").unwrap();
    let mut response = String::new();
    proxy.read_to_string(&mut response).unwrap();
    assert!(response.contains("local-ok"), "local proxy response: {response}");
    server.join().unwrap();
}
#[test]
fn windows_monitor_retries_transient_errors_without_losing_fault() {
    let mut reason = None;
    let mut errors = 0;
    record_health(&mut reason, &mut errors, MonitorHealth::CheckError("temporary TCP table failure".into()));
    assert!(reason.is_none());
    record_health(&mut reason, &mut errors, MonitorHealth::Healthy);
    assert_eq!(errors, 0);
    for _ in 0..2 { record_health(&mut reason, &mut errors, MonitorHealth::CheckError("temporary".into())); }
    assert!(reason.is_none());
    record_health(&mut reason, &mut errors, MonitorHealth::CheckError("persistent".into()));
    assert!(reason.as_deref().unwrap().contains("неоднократно"));
    record_health(&mut reason, &mut errors, MonitorHealth::Healthy);
    assert!(reason.is_some(), "once recovery is required, healthy checks do not cancel retries");
    let mut reason = None;
    record_health(&mut reason, &mut errors, MonitorHealth::Fault("lost listener".into()));
    assert_eq!(reason.as_deref(), Some("lost listener"));
}

// The only state that still blocks a start is another program actively proxying
// through its own server: overwriting it would silently break that VPN. A PAC file
// and auto-detect are captured, switched off for the session and restored, so they
// are exercised in the override test below instead of being refused.
fn refusal_case(mode: &str) {
    let _guard = RegistryGuard::capture();
    let env = NativeEnv::new();
    baseline(0);
    assert_eq!(mode, "proxy");
    windows::set("ProxyServer", &text("127.0.0.1:7890")).unwrap();
    windows::set("ProxyEnable", &dword(1)).unwrap();
    windows::set_flags(2).unwrap();
    windows::notify().unwrap();
    let before = saved();
    let observed = windows::flags().unwrap();
    assert_ne!(observed & 2, 0, "WinINet did not activate the proxy bit (flags={observed}); {}", registry_dump());
    let error = start_runtime(&mut empty_runtime(), &env.binary, &env.assets, &env.path, &env.config, None).unwrap_err();
    assert!(error.contains("заблокировано"), "{mode}: {error}");
    assert_saved(&before, &format!("{mode}: third-party settings must be untouched"));
    assert_eq!(windows::flags().unwrap(), observed, "{mode}: WinINet flags must be untouched");
    assert!(!env.path.exists(), "{mode}: a blocked start must not create a snapshot");
    println!("PASS refused active {mode} (flags={observed})");
}
#[test]
fn windows_refuses_active_third_party_proxy() {
    if !disposable_ci() { return; }
    let _instance = windows::one_instance().expect("another app/test holds the proxy lock");
    refusal_case("proxy");
}
// Auto-detect is on by default on Windows and a PAC file is common on corporate
// images. Both must connect and must come back exactly as they were.
fn override_baseline(mode: &str) {
    // The indicator values only survive when the FLAGS word asks for them: a
    // direct FLAGS makes WinINet delete AutoDetect on the next notify.
    windows::set("ProxyServer", &text("старый proxy:8181")).unwrap();
    windows::set("ProxyOverride", &text("<local>")).unwrap();
    windows::set("ProxyEnable", &dword(0)).unwrap();
    match mode {
        "autodetect" => {
            windows::set("AutoConfigURL", &None).unwrap();
            windows::set("AutoDetect", &dword(1)).unwrap();
            windows::set_flags(1 | 8).unwrap();
        }
        "pac" => {
            windows::set("AutoConfigURL", &text("http://127.0.0.1:39021/proxy.pac")).unwrap();
            windows::set("AutoDetect", &dword(0)).unwrap();
            windows::set_flags(1 | 4).unwrap();
        }
        _ => unreachable!(),
    }
    windows::notify().unwrap();
    let flags = windows::flags().unwrap();
    // FLAGS_UI does not reliably expose these bits, so the registry value is the
    // contract: it is what activation captures and what restore must reproduce.
    match mode {
        "autodetect" => assert_same_indicator("AutoDetect", &windows::get("AutoDetect").unwrap(), &dword(1)),
        "pac" => assert_eq!(windows::get("AutoConfigURL").unwrap(), text("http://127.0.0.1:39021/proxy.pac"), "{mode}: flags={flags}; {}", registry_dump()),
        _ => unreachable!(),
    }
    println!("baseline {mode}: flags={flags}");
}
#[test]
fn windows_overrides_pac_and_autodetect_and_restores_them() {
    if !disposable_ci() { return; }
    let _instance = windows::one_instance().expect("another app/test holds the proxy lock");
    let _guard = RegistryGuard::capture();
    for mode in ["autodetect", "pac"] {
        let env = NativeEnv::new();
        override_baseline(mode);
        let original = saved();
        require_no_foreign_proxy(&capture_proxy().unwrap()).unwrap_or_else(|e| panic!("{mode}: {e}"));
        let mut runtime = empty_runtime();
        start_runtime(&mut runtime, &env.binary, &env.assets, &env.path, &env.config, None)
            .unwrap_or_else(|e| panic!("{mode}: start must be allowed: {e}"));
        let active = windows::flags().unwrap();
        assert!(active & 2 != 0, "{mode}: local proxy must be on: {active}");
        assert_no_pac(active, mode);
        assert_eq!(windows::get("AutoConfigURL").unwrap(), None, "{mode}: PAC must be off while connected");
        assert_same_indicator("AutoDetect", &windows::get("AutoDetect").unwrap(), &dword(0));
        stop_runtime(&mut runtime).unwrap_or_else(|e| panic!("{mode}: restore failed: {e}"));
        assert_saved(&original, &format!("{mode}: baseline must be restored byte for byte"));
        assert!(!env.path.exists(), "{mode}: snapshot must be removed after restore");
        println!("PASS {mode}: connected over the baseline and restored it exactly");
    }
}
#[test]
fn windows_refuses_restore_when_another_app_changes_flags() {
    if !disposable_ci() { return; }
    let _instance = windows::one_instance().expect("another app/test holds the proxy lock");
    let _guard = RegistryGuard::capture();
    let env = NativeEnv::new();
    baseline(0);
    let original = saved();
    let snapshot = capture_proxy().unwrap();
    save_snapshot(&env.path, &snapshot).unwrap();
    // Another VPN enables a PAC while our snapshot is unresolved.
    windows::set("AutoConfigURL", &text("http://third-party.example/proxy.pac")).unwrap();
    windows::set_flags(1 | 4).unwrap();
    windows::notify().unwrap();
    let current = saved();
    let current_flags = windows::flags().unwrap();
    assert_ne!(current_flags & 4, 0, "runner must activate PAC: {current_flags}");
    let error = restore_snapshot(&env.path).unwrap_err();
    assert!(error.contains("snapshot сохранён"), "{error}");
    assert_saved(&current, "third-party settings must not be overwritten");
    assert_eq!(windows::flags().unwrap(), current_flags);
    assert!(env.path.exists(), "an unresolved snapshot must be retained");
    // Return to the exact baseline this test owns, then recovery must succeed.
    // FLAGS first: writing flags afterwards makes WinINet drop zero indicators.
    windows::set_flags(1).unwrap();
    for (name, value) in NAMES.into_iter().zip(&original) { windows::set(name, value).unwrap(); }
    windows::notify().unwrap();
    assert_eq!(windows::flags().unwrap(), 1);
    restore_snapshot(&env.path).unwrap();
    assert_saved(&original, "recovery must reproduce the baseline");
    assert!(!env.path.exists());
    println!("PASS foreign PAC refused, snapshot retained, recovery after manual cleanup");
}

#[test]
fn windows_xray_real_registry_transaction_and_rollback() {
    if !disposable_ci() { return; }
    let _instance = windows::one_instance().expect("another app/test holds the proxy lock");
    let _original = RegistryGuard::capture();
    let binary = PathBuf::from(std::env::var_os("XRAY_TEST_BINARY").expect("XRAY_TEST_BINARY is required"));
    let assets = PathBuf::from(std::env::var_os("XRAY_TEST_ASSETS").expect("XRAY_TEST_ASSETS is required"));
    let config = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/xray-proxy-smoke.json")).unwrap();
    let dir = std::env::temp_dir().join(format!("kartoshka-windows-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("proxy-snapshot.json");
    assert!(!path.exists());
    assert_eq!(validate_config(&config).unwrap(), vec![2080, 2081]);
    let geo_config = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/windows-geodata.json")).unwrap();
    test_config(&binary, &assets, &geo_config).expect("real geoip.dat and geosite.dat must load");
    let empty_assets = dir.join("empty-assets");
    fs::create_dir_all(&empty_assets).unwrap();
    assert!(test_config(&binary, &empty_assets, &geo_config).is_err(), "missing geodata must fail validation");
    println!("PASS geodata: both packaged databases read; missing databases rejected");
    let mut invalid: serde_json::Value = serde_json::from_str(&config).unwrap();
    invalid["inbounds"][0]["listen"] = serde_json::json!("0.0.0.0");
    assert!(validate_config(&invalid.to_string()).is_err());
    invalid["inbounds"][0]["listen"] = serde_json::json!("127.0.0.1");
    invalid["api"] = serde_json::json!({"tag":"bad"});
    assert!(validate_config(&invalid.to_string()).is_err());
    assert!(validate_config(&"x".repeat(MAX_CONFIG_BYTES + 1)).unwrap_err().contains("лимит"));
    // A foreign active proxy is the only blocking state; auto-detect alone must
    // pass so that a default Windows installation can connect.
    baseline(0);
    let mut snapshot = capture_proxy().unwrap();
    snapshot.changes.iter_mut().find(|change| change.name == "ProxyServer").unwrap().before = text("third.example:3128");
    snapshot.changes.iter_mut().find(|change| change.name == "ProxyEnable").unwrap().before = dword(1);
    let error = require_no_foreign_proxy(&snapshot).unwrap_err();
    assert!(error.contains("другой прокси-сервер"), "{error}");
    assert_eq!(windows::flags().unwrap(), 1, "synthetic conflict must not alter WinINet");
    let mut allowed = capture_proxy().unwrap();
    allowed.changes.iter_mut().find(|change| change.name == "AutoDetect").unwrap().before = dword(1);
    require_no_foreign_proxy(&allowed).expect("auto-detect alone must not block a start");
    allowed.changes.iter_mut().find(|change| change.name == "AutoConfigURL").unwrap().before = text("http://10.0.0.1/proxy.pac");
    require_no_foreign_proxy(&allowed).expect("a PAC file alone must not block a start");
    baseline(0);
    windows::set("ProxyServer", &text("third.example")).unwrap();
    let original = saved();
    let snapshot = capture_proxy().unwrap();
    assert_eq!(snapshot.before_flags, 1);
    save_snapshot(&path, &snapshot).unwrap();
    windows::set_flags(2).unwrap();
    windows::set("ProxyServer", &text("third.example")).unwrap();
    let third_party_values = saved();
    let third_party_flags = windows::flags().unwrap();
    let error = restore_snapshot(&path).unwrap_err();
    assert!(error.contains("Неоднозначный"), "{error}");
    assert_saved(&third_party_values, "third-party values must be untouched");
    assert_eq!(windows::flags().unwrap(), third_party_flags);
    assert!(path.exists());
    // This test owns both the synthetic VPN and snapshot; return to the exact
    // baseline before continuing. Never perform this unconditionally in product.
    // FLAGS first: writing flags afterwards makes WinINet drop zero indicators.
    windows::set_flags(1).unwrap();
    for (name, value) in NAMES.into_iter().zip(&original) { windows::set(name, value).unwrap(); }
    assert_eq!(windows::flags().unwrap(), 1);
    restore_snapshot(&path).unwrap();
    assert_saved(&original, "synthetic cleanup must reproduce the baseline");
    println!("PASS same-server active VPN preserved; snapshot not misattributed");
    for case in 0..2 {
        baseline(case);
        let original = saved();
        let original_flags = windows::flags().unwrap();
        assert_eq!(original_flags, 1, "case {case} must start direct");
        let mut runtime = empty_runtime();
        start_runtime(&mut runtime, &binary, &assets, &path, &config, None).expect("start against real registry");
        let active = windows::flags().unwrap();
        assert!(active & 2 != 0, "WinINet must use the local proxy: {active}");
        assert_no_pac(active, "activation");
        assert_eq!(windows::get("ProxyServer").unwrap(), text(LOCAL_PROXY));
        assert_eq!(windows::get("ProxyOverride").unwrap(), text(LOCAL_BYPASS));
        assert_eq!(windows::get("ProxyEnable").unwrap(), dword(1));
        assert_eq!(windows::get("AutoConfigURL").unwrap(), None);
        // WinINet may drop the zero AutoDetect value once FLAGS switches to proxy.
        assert!(same_indicator("AutoDetect", &windows::get("AutoDetect").unwrap(), &dword(0)), "AutoDetect must be disabled: {:?}", windows::get("AutoDetect"));
        assert!(windows::owned_listener(runtime.child.as_ref().unwrap().id(), 2080).unwrap());
        assert!(windows::owned_listener(runtime.child.as_ref().unwrap().id(), 2081).unwrap());
        local_http_probe();
        stop_runtime(&mut runtime).expect("restore on stop");
        assert_saved(&original, "exact original types and bytes restored");
        assert_no_pac(windows::flags().unwrap(), "restore");
        assert_eq!(original_flags & (4 | 8), 0);
        assert!(!path.exists());
        println!("PASS case={case}: real HKCU enable, owner 2080/2081, loopback HTTP, exact restore");
    }
    baseline(0);
    let original = saved();
    let mut runtime = empty_runtime();
    let error = start_runtime(&mut runtime, &binary, &assets, &path, &config, Some(2)).unwrap_err();
    assert!(error.contains("Тестовая ошибка"), "{error}");
    assert_saved(&original, "partial write rolled back");
    assert_eq!(windows::flags().unwrap(), 1, "partial write must restore direct WinINet flags");
    assert!(!path.exists());
    assert!(TcpListener::bind("127.0.0.1:2080").is_ok(), "failed startup left 2080 occupied");
    println!("PASS injected write failure: child killed and registry restored");
    let blocker = TcpListener::bind("127.0.0.1:2080").unwrap();
    assert!(start_runtime(&mut runtime, &binary, &assets, &path, &config, None).is_err());
    assert_saved(&original, "registry must keep the exact baseline");
    assert!(!path.exists());
    drop(blocker);
    println!("PASS occupied listener: no registry writes");
    start_runtime(&mut runtime, &binary, &assets, &path, &config, None).unwrap();
    let third_party = text("third-party.example:9000");
    windows::set("ProxyServer", &third_party).unwrap();
    assert!(stop_runtime(&mut runtime).is_err(), "conflict must be reported");
    assert_eq!(windows::get("ProxyServer").unwrap(), third_party);
    assert!(path.exists(), "unresolved snapshot must remain");
    assert!(runtime.child.is_some(), "child kept alive if restore failed");
    let mut other = empty_runtime();
    assert!(start_runtime(&mut other, &binary, &assets, &path, &config, None).is_err(), "unresolved snapshot must block restart");
    assert!(stop_checked(&mut other, &path).is_err(), "stop without a runtime must report unresolved snapshot");
    windows::set("ProxyServer", &text(LOCAL_PROXY)).unwrap();
    stop_runtime(&mut runtime).unwrap();
    assert_saved(&original, "registry must keep the exact baseline");
    println!("PASS third-party conflict preserved, snapshot blocks restart, retry restores");
    start_runtime(&mut runtime, &binary, &assets, &path, &config, None).unwrap();
    let snapshot_bytes = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(stop_checked(&mut runtime, &path).is_err(), "missing active snapshot must be an error");
    assert!(runtime.child.is_some(), "do not kill a working proxy if restoration is impossible");
    fs::write(&path, snapshot_bytes).unwrap();
    stop_checked(&mut runtime, &path).unwrap();
    assert_saved(&original, "registry must keep the exact baseline");
    windows::set("ProxyServer", &text(LOCAL_PROXY)).unwrap();
    windows::set("ProxyEnable", &dword(1)).unwrap();
    assert!(stop_checked(&mut other, &path).is_err(), "orphan local proxy without snapshot must be reported");
    assert!(start_runtime(&mut other, &binary, &assets, &path, &config, None).is_err(), "orphan local proxy must block start");
    println!("PASS missing snapshot and orphan local proxy are reported, never silently disabled");
    let _ = fs::remove_dir_all(dir);
}


fn wait_file(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while !path.exists() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(30)); }
    if !path.exists() {
        let log = path.parent().and_then(|p| fs::read_to_string(p.join("host.log")).ok()).unwrap_or_default();
        panic!("timed out waiting for {}; mock host log:\n{}", path.display(), log);
    }
}
struct ChildGuard(Child);
impl std::ops::Deref for ChildGuard { type Target = Child; fn deref(&self) -> &Child { &self.0 } }
impl std::ops::DerefMut for ChildGuard { fn deref_mut(&mut self) -> &mut Child { &mut self.0 } }
impl Drop for ChildGuard { fn drop(&mut self) { let _ = stop_child(&mut self.0); } }
fn kill_pid(pid: u32) {
    // Deliberately no /T: a tree kill would also kill the watchdog that must
    // survive this exact crash and restore the proxy.
    let result = Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
    assert!(result.success(), "taskkill failed for PID {pid}");
}
fn wait_child_exit(child: &mut Child, timeout: Duration, what: &str) {
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait().unwrap().is_some() { return; }
        if Instant::now() >= deadline { let _ = stop_child(child); panic!("{what} did not exit within {timeout:?}"); }
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn wait_restore(path: &Path, context: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while path.exists() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(30)); }
    if path.exists() {
        let error = fs::read_to_string(path.with_extension("error")).unwrap_or_default();
        panic!("{context}: watchdog did not restore and remove snapshot; size={:?}; watchdog error: {error}", fs::read(path).ok().map(|b| b.len()));
    }
}
fn mock_command(name: &str, dir: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", name, "--nocapture"]).env("KARTOVPN_MOCK_DIR", dir).env("KARTOVPN_WATCHDOG_DIAG", "1").env("KARTOVPN_WATCHDOG_NO_MODAL", "1").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command
}

// These helper tests do absolutely nothing unless explicitly spawned by the CI-only test.
#[test]
fn windows_watchdog_mock_core() {
    if !disposable_ci() || std::env::var_os("KARTOVPN_MOCK_CORE").is_none() { return; }
    if std::env::var_os("KARTOVPN_MOCK_LISTEN").is_some() {
        let dir = PathBuf::from(std::env::var_os("KARTOVPN_MOCK_DIR").unwrap());
        let first = TcpListener::bind("127.0.0.1:2080").unwrap();
        let _second = TcpListener::bind("127.0.0.1:2081").unwrap();
        fs::write(dir.join("listeners-ready"), b"ready").unwrap();
        while !dir.join("drop-2080").exists() { std::thread::sleep(Duration::from_millis(20)); }
        drop(first);
        fs::write(dir.join("listener-closed"), b"closed").unwrap();
    }
    // Never outlive the test run: an orphan here would keep the CI job open.
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline { std::thread::sleep(Duration::from_secs(1)); }
}
#[test]
fn windows_config_stdin_bounded_and_cleanup() {
    if !disposable_ci() { return; }
    let dir = std::env::temp_dir();
    windows::ensure_core_job().unwrap();
    let make_child = || {
        let mut command = mock_command("windows_native_tests::windows_watchdog_mock_core", &dir);
        command.env("KARTOVPN_MOCK_CORE", "1").stdin(Stdio::piped());
        ChildGuard(command.spawn().unwrap())
    };
    let huge = "x".repeat(MAX_CONFIG_BYTES + 1);
    assert!(spawn_xray(Path::new("nonexistent.exe"), &dir, &huge, false).unwrap_err().contains("лимит"));
    let mut oversized = make_child();
    assert!(send_config(&mut oversized, &huge, Duration::from_secs(1)).unwrap_err().contains("лимит"));
    assert!(oversized.try_wait().unwrap().is_some(), "oversized config must kill and wait");
    let mut blocked = make_child();
    let start = Instant::now();
    let error = send_config(&mut blocked, &"x".repeat(MAX_CONFIG_BYTES / 2), Duration::from_millis(300)).unwrap_err();
    assert!(error.contains("время"), "{error}");
    assert!(start.elapsed() < Duration::from_secs(10), "timeout must be bounded");
    assert!(blocked.try_wait().unwrap().is_some(), "timeout must kill and wait");
    let mut closed = make_child();
    stop_child(&mut closed).unwrap();
    assert!(send_config(&mut closed, "{}", Duration::from_secs(2)).is_err(), "broken pipe must be reported");
    assert!(closed.try_wait().unwrap().is_some());
}
#[test]
fn windows_watchdog_mock_host() {
    if !disposable_ci() || std::env::var_os("KARTOVPN_MOCK_HOST").is_none() { return; }
    let dir = PathBuf::from(std::env::var_os("KARTOVPN_MOCK_DIR").unwrap());
    let _instance = windows::one_instance().unwrap();
    windows::ensure_core_job().expect("mock host cannot create protective Job Object");
    let listen = std::env::var_os("KARTOVPN_MOCK_LISTEN").is_some();
    let mut core_command = mock_command("windows_native_tests::windows_watchdog_mock_core", &dir);
    core_command.env("KARTOVPN_MOCK_CORE", "1");
    if listen { core_command.env("KARTOVPN_MOCK_LISTEN", "1"); }
    let core = core_command.spawn().expect("mock core spawn failed");
    if listen { wait_file(&dir.join("listeners-ready"), Duration::from_secs(10)); }
    if std::env::var_os("KARTOVPN_MOCK_PRE_WATCHDOG").is_some() {
        let identity = windows::child_identity(&core).unwrap();
        fs::write(dir.join("ready.tmp"), format!("{} {}", identity.0, identity.1)).unwrap();
        fs::rename(dir.join("ready.tmp"), dir.join("ready")).unwrap();
        loop { std::thread::sleep(Duration::from_secs(1)); }
    }
    if std::env::var_os("KARTOVPN_MOCK_PARTIAL").is_some() {
        // Real named mutex, snapshot and watchdog; die mid-transaction while owning
        // the mutex so recovery must acquire WAIT_ABANDONED and undo partial writes.
        let _lock = windows::lock().unwrap();
        let snapshot = capture_proxy().unwrap();
        let path = dir.join("proxy-snapshot.json");
        save_snapshot(&path, &snapshot).unwrap();
        let watcher = launch_watchdog(&path, &core).unwrap();
        windows::set("ProxyServer", &text(LOCAL_PROXY)).unwrap();
        windows::set("ProxyOverride", &text(LOCAL_BYPASS)).unwrap();
        let core = windows::child_identity(&core).unwrap();
        let watcher = windows::child_identity(&watcher).unwrap();
        fs::write(dir.join("ready.tmp"), format!("{} {} {} {}", core.0, core.1, watcher.0, watcher.1)).unwrap();
        fs::rename(dir.join("ready.tmp"), dir.join("ready")).unwrap();
        loop { std::thread::sleep(Duration::from_secs(1)); }
    }
    let mut runtime = empty_runtime();
    println!("mock host: flags before activation {:?}, values {:?}", windows::flags(), saved());
    activate_guarded(&mut runtime, core, &dir.join("proxy-snapshot.json"), None, if listen { &[2080, 2081] } else { &[] }).expect("mock activation/watchdog handshake failed");
    if std::env::var_os("KARTOVPN_MOCK_RESTORED_BEFORE_DISARM").is_some() {
        let _lock = windows::lock().unwrap();
        restore_snapshot_locked(&dir.join("proxy-snapshot.json")).unwrap();
    }
    let core = windows::child_identity(runtime.child.as_ref().unwrap()).unwrap();
    let watcher = windows::child_identity(runtime.watchdog.as_ref().unwrap()).unwrap();
    fs::write(dir.join("ready.tmp"), format!("{} {} {} {}", core.0, core.1, watcher.0, watcher.1)).unwrap();
    fs::rename(dir.join("ready.tmp"), dir.join("ready")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        if listen && !dir.join("inspect-now").exists() { continue; }
        let health = inspect_runtime(&mut runtime);
        if let MonitorHealth::Fault(reason) = health {
            fs::write(dir.join("health"), &reason).unwrap();
            let result = stop_runtime(&mut runtime);
            if !dir.join("result").exists() {
                fs::write(dir.join("result.tmp"), if result.is_ok() { "restored" } else { "conflict" }).unwrap();
                fs::rename(dir.join("result.tmp"), dir.join("result")).unwrap();
            }
            if result.is_ok() { return; }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

#[test]
fn windows_watchdog_crashes_conflict_and_dpapi() {
    if !disposable_ci() { return; }
    let _original = RegistryGuard::capture();
    let dir = std::env::temp_dir().join(format!("kartoshka-watchdog-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("proxy-snapshot.json");
    // The exact legacy bytes survive successful recovery as an archive, and damaged
    // or undecryptable snapshots are not removed.
    {
        let _instance = windows::one_instance().unwrap();
        baseline(0);
        let snapshot = capture_proxy().unwrap();
        let old = br#"{"values":[{"name":"ProxyServer","kind":"REG_SZ","value":"third.example:8888"},{"name":"ProxyEnable","kind":"REG_DWORD","value":"0x1"}]}"#;
        fs::write(&path, old).unwrap();
        let before_old = saved();
        let flags_old = windows::flags().unwrap();
        let error = restore_snapshot(&path).unwrap_err();
        assert!(error.contains("0.6.3") && error.contains(&fs::canonicalize(&path).unwrap().display().to_string()), "{error}");
        assert!(error.contains("оригинал") && error.contains("WinINet"));
        assert_eq!(fs::read(&path).unwrap(), old);
        assert_saved(&before_old, "legacy rejection must not change registry");
        assert_eq!(windows::flags().unwrap(), flags_old);
        fs::remove_file(&path).unwrap();
        let json = serde_json::to_vec(&snapshot).unwrap();
        save_snapshot(&path, &snapshot).unwrap();
        let encrypted = fs::read(&path).unwrap();
        assert!(encrypted.starts_with(b"KPV3-DPAPI\0"));
        assert_ne!(encrypted, json);
        assert_eq!(serde_json::to_vec(&load_snapshot(&path).unwrap()).unwrap(), json);
        fs::write(&path, b"KPV3-DPAPI\0broken").unwrap();
        assert!(load_snapshot(&path).is_err());
        assert!(path.exists());
        fs::remove_file(&path).unwrap();
        let mut legacy = snapshot.clone();
        let old_override = legacy.changes.iter_mut().find(|c| c.name == "ProxyOverride").unwrap();
        old_override.managed = false;
        old_override.applied = old_override.before.clone();
        let legacy_json = serde_json::to_vec(&legacy).unwrap();
        fs::write(&path, &legacy_json).unwrap();
        let third_party_override = text("*.changed-by-another-app.example");
        windows::set("ProxyOverride", &third_party_override).unwrap();
        restore_snapshot(&path).unwrap();
        assert_eq!(windows::get("ProxyOverride").unwrap(), third_party_override, "legacy unmanaged bypass remains untouched");
        assert_eq!(fs::read(dir.join("proxy-snapshot.legacy-v2-preserved-0.json")).unwrap(), legacy_json);
        assert!(!path.exists());
        windows::set("ProxyOverride", &snapshot.changes.iter().find(|c| c.name == "ProxyOverride").unwrap().before).unwrap();
        // A recycled PID must never pass READY, even if its numeric PID exists.
        let (pid, created) = windows::parent_identity().unwrap();
        let mut bad = Command::new(std::env::var_os("KARTOVPN_WATCHDOG_TEST_EXE").unwrap())
            .arg("--proxy-watchdog-v1").arg(&path).arg(pid.to_string()).arg((created ^ 1).to_string())
            .arg(pid.to_string()).arg(created.to_string())
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let status = wait_watchdog(&mut bad, Duration::from_secs(5)).unwrap().expect("invalid identity watchdog must exit");
        assert!(!status.success(), "reused PID identity must be rejected");
        let mut reply = String::new(); bad.stdout.take().unwrap().read_to_string(&mut reply).unwrap();
        assert!(!reply.contains("READY"));
        assert!(!path.exists());
        // If the watcher executable cannot be started, no proxy settings are left applied.
        let before = saved();
        let flags = windows::flags().unwrap();
        let watcher_exe = std::env::var_os("KARTOVPN_WATCHDOG_TEST_EXE").unwrap();
        windows::ensure_core_job().unwrap();
        let core = mock_command("windows_native_tests::windows_watchdog_mock_core", &dir).env("KARTOVPN_MOCK_CORE", "1").spawn().unwrap();
        std::env::set_var("KARTOVPN_WATCHDOG_TEST_EXE", dir.join("nonexistent-watchdog.exe"));
        let result = activate_guarded(&mut empty_runtime(), core, &path, None, &[]);
        std::env::set_var("KARTOVPN_WATCHDOG_TEST_EXE", watcher_exe);
        assert!(result.is_err());
        assert!(!path.exists());
        assert_saved(&before, "registry must keep the baseline");
        assert_eq!(windows::flags().unwrap(), flags);
    }
    baseline(0);
    let before = saved();
    let _ = fs::remove_file(dir.join("ready"));
    let mut pre = mock_command("windows_native_tests::windows_watchdog_mock_host", &dir);
    pre.env("KARTOVPN_MOCK_HOST", "1").env("KARTOVPN_MOCK_PRE_WATCHDOG", "1");
    let log = fs::File::create(dir.join("host.log")).unwrap();
    pre.stdout(Stdio::from(log.try_clone().unwrap())).stderr(Stdio::from(log));
    let mut host = ChildGuard(pre.spawn().unwrap());
    wait_file(&dir.join("ready"), Duration::from_secs(20));
    let ids = fs::read_to_string(dir.join("ready")).unwrap().split_whitespace().map(|s| s.parse::<u64>().unwrap()).collect::<Vec<_>>();
    assert_eq!(ids.len(), 2);
    let pre_core = windows::test_process(ids[0] as u32, ids[1]).unwrap();
    kill_pid(host.id()); wait_child_exit(&mut host, Duration::from_secs(10), "mock host");
    assert!(pre_core.wait(10_000), "Job must kill core even before watchdog exists");
    assert_saved(&before, "registry must keep the baseline");
    assert_no_pac(windows::flags().unwrap(), "pre-watchdog");
    assert!(!path.exists());
    drop(pre_core); drop(host);
    for case in ["host", "partial", "core", "watchdog", "conflict", "watchdog-conflict", "listener", "after-restore"] {
        baseline(if case == "core" { 1 } else { 0 });
        let before = saved();
        let _ = fs::remove_file(dir.join("ready"));
        let _ = fs::remove_file(dir.join("result"));
        for name in ["health", "listeners-ready", "drop-2080", "listener-closed", "inspect-now"] { let _ = fs::remove_file(dir.join(name)); }
        let mut command = mock_command("windows_native_tests::windows_watchdog_mock_host", &dir);
        command.env("KARTOVPN_MOCK_HOST", "1");
        if case == "partial" { command.env("KARTOVPN_MOCK_PARTIAL", "1"); }
        if case == "listener" { command.env("KARTOVPN_MOCK_LISTEN", "1"); }
        if case == "after-restore" { command.env("KARTOVPN_MOCK_RESTORED_BEFORE_DISARM", "1"); }
        let log = fs::File::create(dir.join("host.log")).unwrap();
        println!("{case}: parent flags before spawn {:?}", windows::flags());
        command.stdout(Stdio::from(log.try_clone().unwrap())).stderr(Stdio::from(log));
        let mut host = ChildGuard(command.spawn().unwrap());
        wait_file(&dir.join("ready"), Duration::from_secs(20));
        let ids = fs::read_to_string(dir.join("ready")).unwrap().split_whitespace().map(|s| s.parse::<u64>().unwrap()).collect::<Vec<_>>();
        assert_eq!(ids.len(), 4);
        // Keep process handles opened before taskkill, so assertions do not follow PID reuse.
        let core_handle = windows::test_process(ids[0] as u32, ids[1]).unwrap();
        let watchdog_handle = windows::test_process(ids[2] as u32, ids[3]).unwrap();
        if case == "after-restore" { assert!(!path.exists()); }
        else { assert_eq!(windows::get("ProxyOverride").unwrap(), text(LOCAL_BYPASS)); assert!(path.exists()); }
        if case == "conflict" || case == "watchdog-conflict" {
            let third_party = text("third-party-changed.example:9876");
            windows::set("ProxyServer", &third_party).unwrap();
            let conflicted = saved();
            // Setting ProxyServer itself flips the derived word to 3; keep only the
            // semantic check plus the exact value assertions below.
            kill_pid(if case == "conflict" { ids[0] as u32 } else { ids[2] as u32 });
            wait_file(&dir.join("result"), Duration::from_secs(20));
            assert_eq!(fs::read_to_string(dir.join("result")).unwrap(), "conflict");
            assert!(host.try_wait().unwrap().is_none(), "host must continue monitoring after failed recovery");
            assert!(path.exists(), "conflict must retain snapshot");
            assert_saved(&conflicted, "third-party settings must remain unchanged");
            assert_no_pac(windows::flags().unwrap(), "conflict");
            if case == "watchdog-conflict" {
                assert!(!core_handle.wait(0), "core still alive during conflict");
                kill_pid(ids[0] as u32);
                assert!(core_handle.wait(5000));
                assert!(host.try_wait().unwrap().is_none(), "monitor must survive later core death");
            }
            windows::set("ProxyServer", &text(LOCAL_PROXY)).unwrap();
            wait_restore(&path, case);
            wait_child_exit(&mut host, Duration::from_secs(30), "mock host");
            assert!(core_handle.wait(5000) && watchdog_handle.wait(5000));
        } else if case == "listener" {
            fs::write(dir.join("drop-2080"), b"drop").unwrap();
            wait_file(&dir.join("listener-closed"), Duration::from_secs(10));
            let replacement = TcpListener::bind("127.0.0.1:2080").unwrap();
            fs::write(dir.join("inspect-now"), b"inspect").unwrap();
            wait_file(&dir.join("result"), Duration::from_secs(20));
            assert_eq!(fs::read_to_string(dir.join("result")).unwrap(), "restored");
            assert!(fs::read_to_string(dir.join("health")).unwrap().contains("2080"));
            wait_restore(&path, case);
            wait_child_exit(&mut host, Duration::from_secs(30), "mock host");
            assert!(core_handle.wait(5000) && watchdog_handle.wait(5000));
            drop(replacement);
        } else {
            match case {
                "host" | "partial" | "after-restore" => { kill_pid(host.id()); wait_child_exit(&mut host, Duration::from_secs(10), "mock host"); },
                "core" => kill_pid(ids[0] as u32),
                "watchdog" => kill_pid(ids[2] as u32),
                _ => unreachable!(),
            }
            wait_restore(&path, case);
            if case != "host" && case != "partial" && case != "after-restore" { wait_file(&dir.join("result"), Duration::from_secs(20)); assert_eq!(fs::read_to_string(dir.join("result")).unwrap(), "restored"); wait_child_exit(&mut host, Duration::from_secs(30), "mock host"); }
            assert!(watchdog_handle.wait(10_000), "watchdog must terminate");
            assert!(core_handle.wait(10_000), "mock core must terminate after successful recovery");
        }
        assert_saved(&before, &format!("{case}: exact raw registry values must be restored"));
        assert_no_pac(windows::flags().unwrap(), case);
        println!("PASS forced taskkill {case}: conflict-safe exact recovery");
    }
    let _ = fs::remove_dir_all(dir);
}
