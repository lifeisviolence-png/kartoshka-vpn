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
        if let Err(e) = windows::set_flags(self.flags) { eprintln!("FATAL: runner flags cleanup: {e}"); }
        for (name, value) in &self.values { if let Err(e) = windows::set(name, value) { eprintln!("FATAL: runner registry cleanup {name}: {e}"); } }
        if let Err(e) = windows::notify() { eprintln!("FATAL: runner WinINet cleanup: {e}"); }
    }
}
fn saved() -> Vec<Option<RawValue>> { NAMES.into_iter().map(|name| windows::get(name).unwrap()).collect() }
fn baseline(case: usize) {
    // First activate the per-connection flags, then seed exact raw registry values.
    windows::set_flags(if case == 0 { 1 | 4 | 8 } else { 1 | 2 }).unwrap();
    let server = text("старый proxy:8181;http=пример.example:8888");
    let override_value = text("<local>;*.example.test;10.*");
    windows::set("ProxyServer", &server).unwrap();
    windows::set("ProxyOverride", &override_value).unwrap();
    windows::set("AutoConfigURL", &if case == 0 { text("http://127.0.0.1:39021/proxy.pac") } else { None }).unwrap();
    windows::set("AutoDetect", &if case == 0 { dword(1) } else { None }).unwrap();
    windows::set("ProxyEnable", &if case == 0 { dword(0) } else { None }).unwrap();
    windows::notify().unwrap();
}
fn empty_runtime() -> ProxyRuntime { ProxyRuntime { child: None, watchdog: None, snapshot_path: None, generation: 0 } }
fn disposable_ci() -> bool {
    let yes = std::env::var("CI").as_deref() == Ok("true")
        && std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true")
        && std::env::var("RUNNER_ENVIRONMENT").as_deref() == Ok("github-hosted")
        && std::env::var("KARTOVPN_DISPOSABLE_WINDOWS_CI").as_deref() == Ok("1");
    if !yes { eprintln!("SKIP: real HKCU tests run only on explicitly authorized disposable GitHub-hosted CI"); }
    yes
}
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
    let geo_config = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/windows-geodata.json"));
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
    for case in 0..2 {
        baseline(case);
        let original = saved();
        let original_flags = windows::flags().unwrap();
        let mut runtime = empty_runtime();
        start_runtime(&mut runtime, &binary, &assets, &path, &config, None).expect("start against real registry");
        assert_eq!(windows::flags().unwrap(), 2, "WinINet must use only the local proxy");
        assert_eq!(windows::get("ProxyServer").unwrap(), text(LOCAL_PROXY));
        assert_eq!(windows::get("ProxyOverride").unwrap(), text(LOCAL_BYPASS));
        assert_eq!(windows::get("ProxyEnable").unwrap(), dword(1));
        assert_eq!(windows::get("AutoConfigURL").unwrap(), None);
        assert_eq!(windows::get("AutoDetect").unwrap(), dword(0));
        assert!(windows::owned_listener(runtime.child.as_ref().unwrap().id(), 2080).unwrap());
        assert!(windows::owned_listener(runtime.child.as_ref().unwrap().id(), 2081).unwrap());
        local_http_probe();
        stop_runtime(&mut runtime).expect("restore on stop");
        assert_eq!(saved(), original, "exact original types and bytes restored");
        assert_eq!(windows::flags().unwrap(), original_flags, "PAC/auto-detect flags restored");
        assert!(!path.exists());
        println!("PASS case={case}: real HKCU enable, owner 2080/2081, loopback HTTP, exact restore");
    }
    baseline(0);
    let original = saved();
    let mut runtime = empty_runtime();
    let error = start_runtime(&mut runtime, &binary, &assets, &path, &config, Some(2)).unwrap_err();
    assert!(error.contains("Тестовая ошибка"), "{error}");
    assert_eq!(saved(), original, "partial write rolled back");
    assert!(!path.exists());
    assert!(TcpListener::bind("127.0.0.1:2080").is_ok(), "failed startup left 2080 occupied");
    println!("PASS injected write failure: child killed and registry restored");
    let blocker = TcpListener::bind("127.0.0.1:2080").unwrap();
    assert!(start_runtime(&mut runtime, &binary, &assets, &path, &config, None).is_err());
    assert_eq!(saved(), original);
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
    assert_eq!(saved(), original);
    println!("PASS third-party conflict preserved, snapshot blocks restart, retry restores");
    start_runtime(&mut runtime, &binary, &assets, &path, &config, None).unwrap();
    let snapshot_bytes = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(stop_checked(&mut runtime, &path).is_err(), "missing active snapshot must be an error");
    assert!(runtime.child.is_some(), "do not kill a working proxy if restoration is impossible");
    fs::write(&path, snapshot_bytes).unwrap();
    stop_checked(&mut runtime, &path).unwrap();
    assert_eq!(saved(), original);
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
    assert!(path.exists(), "timed out waiting for {}", path.display());
}
fn kill_pid(pid: u32) {
    let result = Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
    assert!(result.success(), "taskkill failed for PID {pid}");
}
fn wait_restore(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while path.exists() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(30)); }
    assert!(!path.exists(), "watchdog did not restore and remove snapshot");
}
fn mock_command(name: &str, dir: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", name, "--nocapture"]).env("KARTOVPN_MOCK_DIR", dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command
}

// These helper tests do absolutely nothing unless explicitly spawned by the CI-only test.
#[test]
fn windows_watchdog_mock_core() {
    if !disposable_ci() || std::env::var_os("KARTOVPN_MOCK_CORE").is_none() { return; }
    loop { std::thread::sleep(Duration::from_secs(1)); }
}
#[test]
fn windows_watchdog_mock_host() {
    if !disposable_ci() || std::env::var_os("KARTOVPN_MOCK_HOST").is_none() { return; }
    let dir = PathBuf::from(std::env::var_os("KARTOVPN_MOCK_DIR").unwrap());
    let _instance = windows::one_instance().unwrap();
    let core = mock_command("windows_native_tests::windows_watchdog_mock_core", &dir).env("KARTOVPN_MOCK_CORE", "1").spawn().unwrap();
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
    activate_guarded(&mut runtime, core, &dir.join("proxy-snapshot.json"), None, &[]).unwrap();
    let core = windows::child_identity(runtime.child.as_ref().unwrap()).unwrap();
    let watcher = windows::child_identity(runtime.watchdog.as_ref().unwrap()).unwrap();
    fs::write(dir.join("ready.tmp"), format!("{} {} {} {}", core.0, core.1, watcher.0, watcher.1)).unwrap();
    fs::rename(dir.join("ready.tmp"), dir.join("ready")).unwrap();
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let dead = !matches!(runtime.child.as_mut().unwrap().try_wait(), Ok(None)) || !matches!(runtime.watchdog.as_mut().unwrap().try_wait(), Ok(None));
        if dead {
            let result = stop_runtime(&mut runtime);
            fs::write(dir.join("result.tmp"), if result.is_ok() { "restored" } else { "conflict" }).unwrap();
            fs::rename(dir.join("result.tmp"), dir.join("result")).unwrap();
            return;
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
        let core = mock_command("windows_native_tests::windows_watchdog_mock_core", &dir).env("KARTOVPN_MOCK_CORE", "1").spawn().unwrap();
        std::env::set_var("KARTOVPN_WATCHDOG_TEST_EXE", dir.join("nonexistent-watchdog.exe"));
        let result = activate_guarded(&mut empty_runtime(), core, &path, None, &[]);
        std::env::set_var("KARTOVPN_WATCHDOG_TEST_EXE", watcher_exe);
        assert!(result.is_err());
        assert!(!path.exists());
        assert_eq!(saved(), before);
        assert_eq!(windows::flags().unwrap(), flags);
    }
    for case in ["host", "partial", "core", "watchdog", "conflict"] {
        baseline(if case == "core" { 1 } else { 0 });
        let before = saved();
        let flags = windows::flags().unwrap();
        let _ = fs::remove_file(dir.join("ready"));
        let _ = fs::remove_file(dir.join("result"));
        let mut command = mock_command("windows_native_tests::windows_watchdog_mock_host", &dir);
        command.env("KARTOVPN_MOCK_HOST", "1");
        if case == "partial" { command.env("KARTOVPN_MOCK_PARTIAL", "1"); }
        let mut host = command.spawn().unwrap();
        wait_file(&dir.join("ready"), Duration::from_secs(20));
        let ids = fs::read_to_string(dir.join("ready")).unwrap().split_whitespace().map(|s| s.parse::<u64>().unwrap()).collect::<Vec<_>>();
        assert_eq!(ids.len(), 4);
        // Keep process handles opened before taskkill, so assertions do not follow PID reuse.
        let core_handle = windows::test_process(ids[0] as u32, ids[1]).unwrap();
        let watchdog_handle = windows::test_process(ids[2] as u32, ids[3]).unwrap();
        assert_eq!(windows::get("ProxyOverride").unwrap(), text(LOCAL_BYPASS));
        assert!(path.exists());
        if case == "conflict" {
            let third_party = text("third-party-changed.example:9876");
            windows::set("ProxyServer", &third_party).unwrap();
            let conflicted = saved();
            let conflicted_flags = windows::flags().unwrap();
            kill_pid(ids[0] as u32);
            wait_file(&dir.join("result"), Duration::from_secs(20));
            assert_eq!(fs::read_to_string(dir.join("result")).unwrap(), "conflict");
            host.wait().unwrap();
            assert!(core_handle.wait(5000) && watchdog_handle.wait(5000));
            assert!(path.exists(), "conflict must retain snapshot");
            assert_eq!(saved(), conflicted, "third-party settings must remain unchanged");
            assert_eq!(windows::flags().unwrap(), conflicted_flags);
            windows::set("ProxyServer", &text(LOCAL_PROXY)).unwrap();
            restore_snapshot(&path).unwrap();
        } else {
            match case {
                "host" | "partial" => { kill_pid(host.id()); host.wait().unwrap(); },
                "core" => kill_pid(ids[0] as u32),
                "watchdog" => kill_pid(ids[2] as u32),
                _ => unreachable!(),
            }
            wait_restore(&path);
            if case != "host" && case != "partial" { wait_file(&dir.join("result"), Duration::from_secs(20)); assert_eq!(fs::read_to_string(dir.join("result")).unwrap(), "restored"); host.wait().unwrap(); }
            assert!(watchdog_handle.wait(10_000), "watchdog must terminate");
            assert!(core_handle.wait(10_000), "mock core must terminate after successful recovery");
        }
        assert_eq!(saved(), before, "{case}: exact raw registry values must be restored");
        assert_eq!(windows::flags().unwrap(), flags, "{case}: exact WinINet flags must be restored");
        println!("PASS forced taskkill {case}: conflict-safe exact recovery");
    }
    let _ = fs::remove_dir_all(dir);
}
