#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod country;
mod doh;

use std::{fs, io::Write, net::TcpStream as StdTcpStream, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime}};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::{net::TcpStream, time::timeout};

const LOCAL_PROXY: &str = "127.0.0.1:2080";
// WinINet <local> means all simple hostnames without a dot, not only loopback.
// Loopback literals are listed explicitly; all other old bypass rules are suspended.
const LOCAL_BYPASS: &str = "<local>;127.0.0.1;[::1]";
const NAMES: [&str; 5] = ["ProxyServer", "ProxyOverride", "AutoConfigURL", "AutoDetect", "ProxyEnable"];
const MAX_CONFIG_BYTES: usize = 1024 * 1024;
const CONFIG_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct RawValue { kind: u32, bytes: Vec<u8> }
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Change { name: String, before: Option<RawValue>, applied: Option<RawValue>, managed: bool }
#[derive(Clone, Debug, Serialize, Deserialize)]
struct ProxySnapshot { version: u32, changes: Vec<Change>, before_flags: u32, applied_flags: u32 }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacySnapshot { values: Vec<LegacyValue> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyValue { name: String, kind: String, value: String }

struct ProxyRuntime { child: Option<Child>, watchdog: Option<Child>, snapshot_path: Option<PathBuf>, ports: Vec<u16>, generation: u64, config: Option<String> }
struct ProxyState(Arc<Mutex<ProxyRuntime>>);
#[derive(Serialize)]
struct SubscriptionResponse { body: String, userinfo: Option<String>, title: Option<String>, #[serde(rename = "supportUrl")] support_url: Option<String>, #[serde(rename = "homeUrl")] home_url: Option<String> }

#[cfg(windows)]
mod windows {
    use super::RawValue;
    use std::{ffi::c_void, io, ptr, os::windows::io::AsRawHandle, process::Child};
    type Handle = isize;
    const HKCU: Handle = 0x80000001u32 as i32 as isize;
    const KEY_READ_WRITE: u32 = 0x20019 | 0x0002;
    const NOT_FOUND: i32 = 2;
    const MORE_DATA: i32 = 234;
    const ALREADY_EXISTS: u32 = 183;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(key: Handle, subkey: *const u16, options: u32, access: u32, result: *mut Handle) -> i32;
        fn RegQueryValueExW(key: Handle, name: *const u16, reserved: *mut u32, kind: *mut u32, data: *mut u8, size: *mut u32) -> i32;
        fn RegSetValueExW(key: Handle, name: *const u16, reserved: u32, kind: u32, data: *const u8, size: u32) -> i32;
        fn RegDeleteValueW(key: Handle, name: *const u16) -> i32;
        fn RegCloseKey(key: Handle) -> i32;
    }
    #[repr(C)]
    struct PerOption { option: u32, value: usize }
    #[repr(C)]
    struct PerOptions { size: u32, connection: *mut u16, count: u32, error: u32, options: *mut PerOption }
    #[link(name = "wininet")]
    extern "system" {
        fn InternetSetOptionW(handle: Handle, option: u32, buffer: *mut c_void, len: u32) -> i32;
        fn InternetQueryOptionW(handle: Handle, option: u32, buffer: *mut c_void, len: *mut u32) -> i32;
    }
    #[link(name = "iphlpapi")]
    extern "system" { fn GetExtendedTcpTable(table: *mut c_void, size: *mut u32, order: i32, af: u32, class: u32, reserved: u32) -> u32; }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *const c_void, initial: i32, name: *const u16) -> Handle;
        fn GetLastError() -> u32;
        fn CloseHandle(handle: Handle) -> i32;
        fn OpenMutexW(access: u32, inherit: i32, name: *const u16) -> Handle;
        fn WaitForSingleObject(handle: Handle, millis: u32) -> u32;
        fn WaitForMultipleObjects(count: u32, handles: *const Handle, all: i32, millis: u32) -> u32;
        fn ReleaseMutex(handle: Handle) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn GetCurrentProcess() -> Handle;
        fn IsProcessInJob(process: Handle, job: Handle, result: *mut i32) -> i32;
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: u32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetProcessTimes(handle: Handle, creation: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn CreateEventW(attributes: *const c_void, manual: i32, initial: i32, name: *const u16) -> Handle;
        fn SetEvent(event: Handle) -> i32;
        fn TerminateProcess(handle: Handle, code: u32) -> i32;
        fn LocalFree(handle: *mut c_void) -> *mut c_void;
    }
    #[repr(C)]
    #[derive(Default)]
    struct FileTime { low: u32, high: u32 }
    #[repr(C)]
    struct Blob { size: u32, data: *mut u8 }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(input: *const Blob, desc: *const u16, entropy: *const Blob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut Blob) -> i32;
        fn CryptUnprotectData(input: *const Blob, desc: *mut *mut u16, entropy: *const Blob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut Blob) -> i32;
    }
    fn dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        if input.len() > u32::MAX as usize { return Err("Слишком большой snapshot".into()); }
        let src = Blob { size: input.len() as u32, data: input.as_ptr() as *mut u8 };
        let mut dst = Blob { size: 0, data: ptr::null_mut() };
        let ok = unsafe { if protect { CryptProtectData(&src, ptr::null(), ptr::null(), ptr::null_mut(), ptr::null_mut(), 1, &mut dst) } else { CryptUnprotectData(&src, ptr::null_mut(), ptr::null(), ptr::null_mut(), ptr::null_mut(), 1, &mut dst) } };
        if ok == 0 { return Err(format!("Ошибка DPAPI snapshot: {}", io::Error::last_os_error())); }
        let result = if dst.size == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(dst.data, dst.size as usize) }.to_vec() };
        unsafe { LocalFree(dst.data as *mut c_void); }
        Ok(result)
    }
    pub fn protect(input: &[u8]) -> Result<Vec<u8>, String> { dpapi(input, true) }
    pub fn unprotect(input: &[u8]) -> Result<Vec<u8>, String> { dpapi(input, false) }
    #[link(name = "user32")]
    extern "system" { fn MessageBoxW(window: Handle, text: *const u16, caption: *const u16, flags: u32) -> i32; }
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
    pub fn show_error(message: &str) {
        // A modal box would block an unattended test run; only an explicit env opt-in
        // disables it, so a real user always sees the error.
        if std::env::var_os("KARTOVPN_WATCHDOG_NO_MODAL").is_some() { eprintln!("{message}"); return; }
        unsafe { MessageBoxW(0, wide(message).as_ptr(), wide("КартошкаVPN: ошибка proxy").as_ptr(), 0x10); }
    }
    fn winerr(code: i32) -> String { io::Error::from_raw_os_error(code).to_string() }
    struct Key(Handle);
    impl Drop for Key { fn drop(&mut self) { unsafe { RegCloseKey(self.0); } } }
    fn key() -> Result<Key, String> {
        let mut handle = 0;
        let code = unsafe { RegOpenKeyExW(HKCU, wide(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings").as_ptr(), 0, KEY_READ_WRITE, &mut handle) };
        if code != 0 { Err(format!("Не удалось открыть Internet Settings: {}", winerr(code))) } else { Ok(Key(handle)) }
    }
    pub fn get(name: &str) -> Result<Option<RawValue>, String> {
        let key = key()?;
        let name_w = wide(name);
        for _ in 0..5 {
            let mut size = 0u32; let mut kind = 0u32;
            let code = unsafe { RegQueryValueExW(key.0, name_w.as_ptr(), ptr::null_mut(), &mut kind, ptr::null_mut(), &mut size) };
            if code == NOT_FOUND { return Ok(None); }
            if code != 0 { return Err(format!("Ошибка чтения {name}: {}", winerr(code))); }
            if size > 1024 * 1024 { return Err(format!("Слишком большое значение {name}")); }
            let mut bytes = vec![0u8; size as usize];
            let code = unsafe { RegQueryValueExW(key.0, name_w.as_ptr(), ptr::null_mut(), &mut kind, bytes.as_mut_ptr(), &mut size) };
            if code == MORE_DATA { continue; }
            if code == NOT_FOUND { return Ok(None); }
            if code != 0 { return Err(format!("Ошибка чтения {name}: {}", winerr(code))); }
            bytes.truncate(size as usize);
            return Ok(Some(RawValue { kind, bytes }));
        }
        Err(format!("{name} изменяется во время чтения"))
    }
    pub fn set(name: &str, value: &Option<RawValue>) -> Result<(), String> {
        let key = key()?;
        let name_w = wide(name);
        let code = unsafe { match value {
            Some(v) => RegSetValueExW(key.0, name_w.as_ptr(), 0, v.kind, v.bytes.as_ptr(), v.bytes.len() as u32),
            None => RegDeleteValueW(key.0, name_w.as_ptr()),
        }};
        if code == 0 || (value.is_none() && code == NOT_FOUND) { Ok(()) } else { Err(format!("Ошибка записи {name}: {}", winerr(code))) }
    }
    pub fn notify() -> Result<(), String> {
        // Both calls are required; don't clear a recovery record on failure.
        let changed = unsafe { InternetSetOptionW(0, 39, ptr::null_mut(), 0) };
        let first = if changed == 0 { Some(io::Error::last_os_error().to_string()) } else { None };
        let refreshed = unsafe { InternetSetOptionW(0, 37, ptr::null_mut(), 0) };
        let second = if refreshed == 0 { Some(io::Error::last_os_error().to_string()) } else { None };
        if first.is_some() || second.is_some() { Err(format!("Не удалось обновить WinINet: settings={first:?}, refresh={second:?}")) } else { Ok(()) }
    }
    fn option_list(option: &mut PerOption) -> PerOptions {
        PerOptions { size: std::mem::size_of::<PerOptions>() as u32, connection: ptr::null_mut(), count: 1, error: 0, options: option }
    }
    pub fn flags() -> Result<u32, String> {
        // FLAGS_UI is recommended for Windows 7+; fall back to FLAGS if unsupported.
        for kind in [10u32, 1] {
            let mut option = PerOption { option: kind, value: 0 };
            let mut list = option_list(&mut option);
            let mut len = std::mem::size_of::<PerOptions>() as u32;
            if unsafe { InternetQueryOptionW(0, 75, &mut list as *mut _ as *mut c_void, &mut len) } != 0 { return Ok(option.value as u32); }
        }
        Err(format!("Не удалось прочитать флаги WinINet: {}", io::Error::last_os_error()))
    }
    pub fn set_flags(value: u32) -> Result<(), String> {
        let mut option = PerOption { option: 1, value: value as usize };
        let mut list = option_list(&mut option);
        if unsafe { InternetSetOptionW(0, 75, &mut list as *mut _ as *mut c_void, std::mem::size_of::<PerOptions>() as u32) } == 0 {
            Err(format!("Не удалось записать флаги WinINet: {}", io::Error::last_os_error()))
        } else { Ok(()) }
    }
    pub fn owned_listener(pid: u32, port: u16) -> Result<bool, String> {
        let mut size = 0;
        unsafe { GetExtendedTcpTable(ptr::null_mut(), &mut size, 0, 2, 3, 0); } // AF_INET, TCP_TABLE_OWNER_PID_LISTENER
        for _ in 0..4 {
            if size > 16 * 1024 * 1024 { return Err("Слишком большая таблица TCP".into()); }
            let mut buf = vec![0u32; (size as usize + 3) / 4];
            let code = unsafe { GetExtendedTcpTable(buf.as_mut_ptr() as *mut c_void, &mut size, 0, 2, 3, 0) };
            if code == 122 { continue; }
            if code != 0 { return Err(format!("Не удалось проверить TCP listener: {}", winerr(code as i32))); }
            let count = *buf.first().ok_or("Пустая таблица TCP")? as usize;
            if count > (buf.len().saturating_sub(1)) / 6 { return Err("Повреждена таблица TCP".into()); }
            return Ok(buf[1..1 + count * 6].chunks_exact(6).any(|row| row[0] == 2 && row[1] == u32::from_ne_bytes([127, 0, 0, 1]) && u16::from_be(row[2] as u16) == port && row[5] == pid));
        }
        Err("Таблица TCP изменяется во время чтения".into())
    }
    const INSTANCE_NAME: &str = r"Global\ru.kartoshka.vpn.proxy-v1";
    const LOCK_NAME: &str = r"Local\ru.kartoshka.vpn.proxy-transaction-v2";
    const WAIT_OBJECT: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    pub struct ResourceLock(Handle);
    impl Drop for ResourceLock { fn drop(&mut self) { unsafe { ReleaseMutex(self.0); CloseHandle(self.0); } } }
    // Also covers an abandoned lock after a process was killed mid-transaction.
    pub fn lock() -> Result<ResourceLock, String> {
        let h = unsafe { CreateMutexW(ptr::null(), 0, wide(LOCK_NAME).as_ptr()) };
        if h == 0 { return Err(format!("Не удалось создать блокировку proxy: {}", io::Error::last_os_error())); }
        let result = unsafe { WaitForSingleObject(h, 30_000) };
        if result != WAIT_OBJECT && result != 0x80 { unsafe { CloseHandle(h); } return Err(format!("Не удалось дождаться блокировки proxy: {result}")); }
        Ok(ResourceLock(h))
    }
    fn process_time(h: Handle) -> Result<u64, String> {
        let (mut created, mut exited, mut kernel, mut user) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
        if unsafe { GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) } == 0 { return Err(format!("Не удалось проверить процесс: {}", io::Error::last_os_error())); }
        Ok(((created.high as u64) << 32) | created.low as u64)
    }
    pub fn parent_identity() -> Result<(u32, u64), String> { Ok((std::process::id(), process_time(unsafe { GetCurrentProcess() })?)) }
    pub fn child_identity(child: &Child) -> Result<(u32, u64), String> { Ok((child.id(), process_time(child.as_raw_handle() as Handle)?)) }
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits { process_time: i64, job_time: i64, flags: u32, min_working: usize, max_working: usize, active: u32, affinity: usize, priority: u32, scheduling: u32 }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters { read_ops: u64, write_ops: u64, other_ops: u64, read_bytes: u64, write_bytes: u64, other_bytes: u64 }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits { basic: BasicLimits, io: IoCounters, process_memory: usize, job_memory: usize, peak_process: usize, peak_job: usize }
    struct CoreJob(Handle);
    impl Drop for CoreJob { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    // Assign the GUI before it spawns *any* Xray. Children inherit this job at
    // creation, avoiding the post-spawn/pre-assignment crash window. The handle
    // lives until process exit; watchdog must break out and be verified separately.
    static CORE_JOB: std::sync::OnceLock<Result<CoreJob, String>> = std::sync::OnceLock::new();
    pub fn ensure_core_job() -> Result<(), String> {
        CORE_JOB.get_or_init(|| {
            let h = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if h == 0 { return Err(format!("Не удалось создать Job Object Xray: {}", io::Error::last_os_error())); }
            let job = CoreJob(h);
            let mut limits = ExtendedLimits::default();
            limits.basic.flags = 0x2000 | 0x0800; // KILL_ON_JOB_CLOSE | BREAKAWAY_OK
            if unsafe { SetInformationJobObject(h, 9, &limits as *const _ as *const c_void, std::mem::size_of::<ExtendedLimits>() as u32) } == 0 {
                return Err(format!("Не удалось настроить Job Object Xray: {}", io::Error::last_os_error()));
            }
            if unsafe { AssignProcessToJobObject(h, GetCurrentProcess()) } == 0 {
                return Err(format!("Текущий Job Object несовместим с безопасным запуском Xray: {}", io::Error::last_os_error()));
            }
            Ok(job)
        }).as_ref().map(|_| ()).map_err(Clone::clone)
    }
    pub fn core_in_job(child: &Child) -> Result<bool, String> {
        let job = CORE_JOB.get().ok_or("Job Object Xray не инициализирован")?.as_ref().map_err(Clone::clone)?;
        let mut result = 0;
        if unsafe { IsProcessInJob(child.as_raw_handle() as Handle, job.0, &mut result) } == 0 { return Err(format!("Не удалось проверить Job Object Xray: {}", io::Error::last_os_error())); }
        Ok(result != 0)
    }
    pub fn watchdog_creation_flags() -> Result<u32, String> {
        let mut in_job = 0;
        if unsafe { IsProcessInJob(GetCurrentProcess(), 0, &mut in_job) } == 0 { return Err(format!("Не удалось проверить Job Object приложения: {}", io::Error::last_os_error())); }
        Ok(0x08000000 | if in_job != 0 { 0x01000000 } else { 0 })
    }
    struct OwnedHandle(Handle);
    impl Drop for OwnedHandle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    fn open_verified(pid: u32, creation: u64, terminate: bool) -> Result<OwnedHandle, String> {
        let h = unsafe { OpenProcess(0x100000 | 0x1000 | if terminate { 1 } else { 0 }, 0, pid) }; // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
        if h == 0 { return Err(format!("Не удалось открыть процесс {pid}: {}", io::Error::last_os_error())); }
        let h = OwnedHandle(h);
        if process_time(h.0)? != creation || unsafe { WaitForSingleObject(h.0, 0) } != WAIT_TIMEOUT { return Err("Процесс завершился или PID переиспользован".into()); }
        Ok(h)
    }
    #[cfg(test)]
    pub struct TestProcess(OwnedHandle);
    #[cfg(test)]
    pub fn test_process(pid: u32, created: u64) -> Result<TestProcess, String> { open_verified(pid, created, true).map(TestProcess) }
    #[cfg(test)]
    impl TestProcess {
        pub fn wait(&self, millis: u32) -> bool { unsafe { WaitForSingleObject(self.0.0, millis) == WAIT_OBJECT } }
    }
    #[cfg(test)]
    impl Drop for TestProcess {
        fn drop(&mut self) {
            if unsafe { WaitForSingleObject(self.0.0, 0) } == WAIT_TIMEOUT {
                unsafe { TerminateProcess(self.0.0, 1); WaitForSingleObject(self.0.0, 5000); }
            }
        }
    }
    pub fn watchdog(path: &std::path::Path, parent: (u32, u64), core: (u32, u64)) -> Result<(), String> {
        use std::io::{Read, Write};
        let instance = unsafe { OpenMutexW(0x100000, 0, wide(INSTANCE_NAME).as_ptr()) };
        if instance == 0 { return Err("Не найден экземпляр приложения".into()); }
        let _instance = OwnedHandle(instance); // Keep the instance object alive until recovery finishes.
        let parent = open_verified(parent.0, parent.1, false)?;
        let core = open_verified(core.0, core.1, true)?;
        let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
        if event == 0 { return Err(format!("Не удалось создать событие watchdog: {}", io::Error::last_os_error())); }
        let event = OwnedHandle(event);
        // EOF (parent crash) is NOT disarm. Only a byte sent after successful recovery is.
        let event_value = event.0;
        std::thread::spawn(move || {
            let mut byte = [0u8; 1];
            if std::io::stdin().read_exact(&mut byte).is_ok() && byte[0] == 0x5a { unsafe { SetEvent(event_value); } }
        });
        if unsafe { WaitForSingleObject(parent.0, 0) } != WAIT_TIMEOUT || unsafe { WaitForSingleObject(core.0, 0) } != WAIT_TIMEOUT { return Err("Процесс завершился до готовности watchdog".into()); }
        std::io::stdout().write_all(b"READY\n").and_then(|_| std::io::stdout().flush()).map_err(|e| e.to_string())?;
        let result = unsafe { WaitForMultipleObjects(3, [parent.0, core.0, event.0].as_ptr(), 0, u32::MAX) };
        if result == WAIT_OBJECT + 2 { return Ok(()); }
        if result != WAIT_OBJECT && result != WAIT_OBJECT + 1 { return Err(format!("Ошибка ожидания процессов watchdog: {result}")); }
        let recovered = lock().and_then(|_lock| {
            if path.exists() { super::restore_snapshot_locked(path) }
            else if !super::points_to_local_proxy()? { Ok(()) }
            else { Err("Snapshot отсутствует, но Windows всё ещё указывает на локальный proxy".into()) }
        });
        if let Err(ref e) = recovered {
            if std::env::var_os("KARTOVPN_WATCHDOG_DIAG").is_some() {
                let _ = std::fs::write(path.with_extension("error"), e);
            }
            if unsafe { WaitForSingleObject(parent.0, 0) } != WAIT_TIMEOUT { show_error(&format!("Аварийное восстановление proxy не выполнено: {e}\nSnapshot сохранён, проверьте настройки Windows вручную.")); }
        }
        if recovered.is_ok() && result == WAIT_OBJECT && unsafe { WaitForSingleObject(core.0, 0) } == WAIT_TIMEOUT {
            // A live core is retained on recovery failure so it cannot strand the proxy.
            // The handle was verified before READY and cannot follow PID reuse.
            if unsafe { TerminateProcess(core.0, 1) } == 0 || unsafe { WaitForSingleObject(core.0, 5000) } != WAIT_OBJECT {
                show_error("Настройки proxy восстановлены, но не удалось завершить Xray. Завершите его вручную.");
                return Err("Не удалось завершить Xray после восстановления".into());
            }
        }
        recovered
    }
    pub struct Instance(Handle);
    impl Drop for Instance { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    // A named object is held for the whole process, not merely while changing values.
    pub fn one_instance() -> Result<Instance, String> {
        // A terminating instance can keep the named object alive for a moment; a
        // short retry avoids a false "already running" after a crash or update.
        for attempt in 0..20 {
            let handle = unsafe { CreateMutexW(ptr::null(), 0, wide(INSTANCE_NAME).as_ptr()) };
            if handle == 0 { return Err(format!("Не удалось заблокировать второй экземпляр: {}", io::Error::last_os_error())); }
            if unsafe { GetLastError() } != ALREADY_EXISTS { return Ok(Instance(handle)); }
            unsafe { CloseHandle(handle); }
            if attempt < 19 { std::thread::sleep(std::time::Duration::from_millis(250)); }
        }
        Err("Уже запущен другой экземпляр КартошкаVPN".into())
    }
}
#[cfg(not(windows))]
mod windows {
    use super::RawValue;
    pub struct Instance;
    pub struct ResourceLock;
    pub fn lock() -> Result<ResourceLock, String> { Err("Поддерживается только Windows".into()) }
    pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> { Err("Поддерживается только Windows".into()) }
    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> { Err("Поддерживается только Windows".into()) }
    pub fn parent_identity() -> Result<(u32, u64), String> { Err("Поддерживается только Windows".into()) }
    pub fn child_identity(_: &std::process::Child) -> Result<(u32, u64), String> { Err("Поддерживается только Windows".into()) }
    pub fn ensure_core_job() -> Result<(), String> { Err("Поддерживается только Windows".into()) }
    pub fn core_in_job(_: &std::process::Child) -> Result<bool, String> { Err("Поддерживается только Windows".into()) }
    pub fn watchdog_creation_flags() -> Result<u32, String> { Err("Поддерживается только Windows".into()) }
    pub fn watchdog(_: &std::path::Path, _: (u32, u64), _: (u32, u64)) -> Result<(), String> { Err("Поддерживается только Windows".into()) }
    pub fn show_error(message: &str) { eprintln!("{message}"); }
    pub fn one_instance() -> Result<Instance, String> { Err("Поддерживается только Windows".into()) }
    pub fn get(_: &str) -> Result<Option<RawValue>, String> { Err("Поддерживается только Windows".into()) }
    pub fn set(_: &str, _: &Option<RawValue>) -> Result<(), String> { Err("Поддерживается только Windows".into()) }
    pub fn notify() -> Result<(), String> { Err("Поддерживается только Windows".into()) }
    pub fn flags() -> Result<u32, String> { Err("Поддерживается только Windows".into()) }
    pub fn set_flags(_: u32) -> Result<(), String> { Err("Поддерживается только Windows".into()) }
    pub fn owned_listener(_: u32, _: u16) -> Result<bool, String> { Err("Поддерживается только Windows".into()) }
}

fn dword(value: u32) -> Option<RawValue> { Some(RawValue { kind: 4, bytes: value.to_le_bytes().to_vec() }) }
fn text(value: &str) -> Option<RawValue> { Some(RawValue { kind: 1, bytes: value.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect() }) }
fn capture_proxy() -> Result<ProxySnapshot, String> {
    let before_flags = windows::flags()?;
    let mut changes = Vec::new();
    for name in NAMES {
        let before = windows::get(name)?;
        let (managed, applied) = match name {
            "ProxyServer" => (true, text(LOCAL_PROXY)),
            "ProxyOverride" => (true, text(LOCAL_BYPASS)),
            "AutoConfigURL" => (true, None),
            "AutoDetect" => (true, dword(0)),
            "ProxyEnable" => (true, dword(1)),
            _ => (false, before.clone()),
        };
        changes.push(Change { name: name.into(), before, applied, managed });
    }
    let after_flags = windows::flags()?;
    if has_pac(after_flags) != has_pac(before_flags) { return Err("Флаги WinINet изменились во время создания snapshot".into()); }
    Ok(ProxySnapshot { version: 2, changes, before_flags, applied_flags: 2 })
}
fn registry_text(value: &Option<RawValue>) -> Option<String> {
    let value = value.as_ref()?;
    if value.kind != 1 { return None; }
    let units: Vec<u16> = value.bytes.chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|unit| *unit != 0)
        .collect();
    if units.is_empty() { None } else { Some(String::from_utf16_lossy(&units)) }
}
fn indicator_on(value: &Option<RawValue>) -> bool {
    matches!(value, Some(raw) if raw.kind == 4 && raw.bytes == 1u32.to_le_bytes())
}
// Refuse only when another program is actively proxying through its own server.
// Auto-detect (WPAD) is on by default on Windows and a PAC file is common on
// corporate images; both are captured, switched off for the session and restored
// afterwards, so blocking on them would make the app unusable on a clean system.
fn require_no_foreign_proxy(snapshot: &ProxySnapshot) -> Result<(), String> {
    let before = |name: &str| snapshot.changes.iter().find(|c| c.name == name).and_then(|c| c.before.clone());
    let server = registry_text(&before("ProxyServer")).unwrap_or_default();
    let server = server.trim().to_string();
    if indicator_on(&before("ProxyEnable")) && !server.is_empty() && server != LOCAL_PROXY {
        return Err(format!("В Windows уже включён другой прокси-сервер ({server}). Подключение заблокировано, чтобы не перезаписать настройки другого VPN. Отключите его в параметрах Windows и повторите."));
    }
    Ok(())
}
// WinINet normalizes zero-valued indicator DWORDs: setting FLAGS to direct can
// delete AutoDetect/ProxyEnable instead of storing an explicit 0. An absent value
// and 0 describe the same setting, so that difference alone does not prove that
// another program changed the proxy.
fn same_indicator(name: &str, a: &Option<RawValue>, b: &Option<RawValue>) -> bool {
    if a == b { return true; }
    if !matches!(name, "AutoDetect" | "ProxyEnable") { return false; }
    let zero = |value: &Option<RawValue>| match value {
        None => true,
        Some(value) => value.kind == 4 && value.bytes == 0u32.to_le_bytes(),
    };
    zero(a) && zero(b)
}
// FLAGS_UI is a derived value: with ProxyServer configured but ProxyEnable=0 it
// can report direct|proxy (3), and it can lag a write briefly. The safety property
// is the absence of PAC/auto-detect and the registry values themselves, so checks
// look at those bits instead of comparing the whole word.
const PAC_BITS: u32 = 4 | 8;
fn has_pac(flags: u32) -> bool { flags & PAC_BITS != 0 }
fn wait_no_pac(timeout: Duration) -> u32 {
    let deadline = Instant::now() + timeout;
    loop {
        let flags = windows::flags().unwrap_or(0);
        if !has_pac(flags) || Instant::now() >= deadline { return flags; }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn wait_local_proxy(timeout: Duration) -> u32 {
    let deadline = Instant::now() + timeout;
    loop {
        let flags = windows::flags().unwrap_or(0);
        if flags & 2 != 0 && !has_pac(flags) || Instant::now() >= deadline { return flags; }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn save_snapshot(path: &Path, snapshot: &ProxySnapshot) -> Result<(), String> {
    let json = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
    let mut data = b"KPV3-DPAPI\0".to_vec();
    data.extend_from_slice(&windows::protect(&json)?);
    // create_new prevents replacing an unresolved snapshot, including one from a previous crash.
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| format!("Не удалось создать snapshot (существующий нужно восстановить): {e}"))?;
    if let Err(e) = file.write_all(&data).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(path);
        return Err(format!("Не удалось записать snapshot: {e}"));
    }
    Ok(())
}
fn load_snapshot(path: &Path) -> Result<ProxySnapshot, String> {
    let bytes = fs::read(path).map_err(|e| format!("Не удалось прочитать snapshot: {e}"))?;
    // Legacy v2 JSON is read as-is, never deleted or migrated unless restoration succeeds.
    let data = if let Some(encrypted) = bytes.strip_prefix(b"KPV3-DPAPI\0") { windows::unprotect(encrypted)? } else { bytes };
    if let Ok(old) = serde_json::from_slice::<LegacySnapshot>(&data) {
        let mut names = std::collections::HashSet::new();
        if old.values.len() <= NAMES.len() && old.values.iter().all(|v|
            NAMES.contains(&v.name.as_str()) && names.insert(v.name.as_str()) && !v.kind.is_empty() && { let _ = &v.value; true }) {
            let absolute = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            return Err(format!("Обнаружен snapshot версии 0.6.3: {}. Он сохранён без изменений; старый формат не содержит флаги WinINet, поэтому автоматическое восстановление небезопасно.\n1. Сохраните оригинал и отдельную копию файла в защищённом месте (он может содержать секреты).\n2. Закройте КартошкаVPN; не отключайте и не перезаписывайте сторонний VPN без согласия.\n3. В «Параметры Windows → Сеть и Интернет → Прокси» проверьте текущие настройки; значения JSON используйте только как справку, отсутствующие поля и флаги не угадывайте. При необходимости попросите администратора вручную восстановить известную рабочую конфигурацию и проверьте доступ в интернет.\n4. Лишь после проверки и сохранения оригинала переместите snapshot из указанного пути в архив и перезапустите приложение.", absolute.display()));
        }
    }
    let snapshot: ProxySnapshot = serde_json::from_slice(&data).map_err(|e| format!("Неизвестный или повреждённый snapshot; сохранён для ручного восстановления: {e}"))?;
    if snapshot.version != 2 || snapshot.applied_flags != 2 || snapshot.changes.len() != NAMES.len() || !snapshot.changes.iter().zip(NAMES).all(|(c, n)| {
        if c.name != n { return false; }
        match n {
            "ProxyServer" => c.managed && c.applied == text(LOCAL_PROXY),
            "ProxyOverride" => if c.managed { c.applied == text(LOCAL_BYPASS) } else { c.applied == c.before },
            "AutoConfigURL" => c.managed && c.applied.is_none(),
            "AutoDetect" => c.managed && c.applied == dword(0),
            "ProxyEnable" => c.managed && c.applied == dword(1),
            _ => false,
        }
    }) { return Err("Неизвестный или повреждённый формат snapshot; требуется ручное восстановление".into()); }
    Ok(snapshot)
}
fn restore_snapshot(path: &Path) -> Result<(), String> {
    let _lock = windows::lock()?;
    restore_snapshot_locked(path)
}
fn restore_snapshot_locked(path: &Path) -> Result<(), String> {
    if !path.exists() { return Err("Snapshot исчез; восстановление невозможно, проверьте proxy Windows вручную".into()); }
    let snapshot = load_snapshot(path)?;
    let flags = windows::flags()?;
    // FLAGS is derived: a configured server adds the proxy bit even while
    // ProxyEnable=0, so only the PAC/auto-detect bits change the meaning here.
    // Activation itself clears PAC/auto-detect, therefore a PAC bit now is a
    // third-party change only when the user did not have one before connecting.
    if has_pac(flags) && !has_pac(snapshot.before_flags) {
        return Err(format!("Другой программой включён PAC или автоопределение (флаги {flags}); snapshot сохранён, настройки не перезаписаны"));
    }
    let proxy_applied = flags & 2 != 0;
    let managed: Vec<&Change> = snapshot.changes.iter().filter(|c| c.managed).collect();
    let mut expected = Vec::new();
    for c in &managed {
        let current = windows::get(&c.name)?;
        let after_flag_restore = c.name == "ProxyEnable" && flags == snapshot.before_flags && snapshot.before_flags != snapshot.applied_flags && current == dword(u32::from(snapshot.before_flags & 2 != 0));
        if !same_indicator(&c.name, &current, &c.before) && !same_indicator(&c.name, &current, &c.applied) && !after_flag_restore {
            return Err(format!("{} изменён другой программой; snapshot сохранён, настройки не перезаписаны (сейчас {:?}, было {:?}, включали {:?}, флаги {flags})", c.name, current, c.before, c.applied));
        }
        expected.push(current);
    }
    // An original server value is not proof of ownership when a third-party VPN
    // turns on the same server. Never disable its active flags in that state.
    if proxy_applied {
        let server = managed.iter().position(|c| c.name == "ProxyServer").ok_or("В snapshot отсутствует ProxyServer")?;
        if expected[server] != managed[server].applied || managed[server].before == managed[server].applied {
            return Err("Неоднозначный активный proxy: ProxyServer не подтверждает владение КартошкаVPN. Настройки не изменены, snapshot сохранён".into());
        }
    }
    // FLAGS_UI lags registry writes, and restoring a PAC/auto-detect baseline
    // brings the PAC bit back only after the notify below. Registry values are the
    // source of truth here; the flags word is compared best-effort at the end.
    let verify = |expected: &[Option<RawValue>], _expected_flags: u32| -> Result<(), String> {
        for (c, value) in managed.iter().zip(expected) {
            if !same_indicator(&c.name, &windows::get(&c.name)?, value) { return Err(format!("{} изменён другой программой во время восстановления", c.name)); }
        }
        Ok(())
    };
    let recovery = (|| -> Result<(), String> {
        verify(&expected, flags)?;
        if proxy_applied && snapshot.before_flags & 2 == 0 {
            windows::set_flags(snapshot.before_flags)?;
            let restored = wait_no_pac(Duration::from_secs(2));
            if has_pac(restored) != has_pac(snapshot.before_flags) { return Err(format!("WinINet не вернул прежние флаги: {restored}")); }
            // WinINet may update related registry fields when restoring flags. Only
            // accept unchanged values, exact originals, or its ProxyEnable form.
            for (i, c) in managed.iter().enumerate() {
                let current = windows::get(&c.name)?;
                if same_indicator(&c.name, &current, &expected[i]) || same_indicator(&c.name, &current, &c.before) || (c.name == "ProxyEnable" && current == dword(u32::from(snapshot.before_flags & 2 != 0))) {
                    expected[i] = current;
                } else { return Err(format!("{} изменён во время восстановления флагов", c.name)); }
            }
        }
        // Re-check the complete observed set before every write. Registry has no
        // compare-and-swap: an unrelated app can still race the final check/write.
        for i in (0..managed.len()).rev() {
            verify(&expected, snapshot.before_flags)?;
            if expected[i] != managed[i].before {
                windows::set(&managed[i].name, &managed[i].before)?;
                expected[i] = managed[i].before.clone();
            }
        }
        verify(&expected, snapshot.before_flags)?;
        Ok(())
    })();
    // Publish the restored values, then give WinINet up to two seconds to derive
    // the flags word again. A lagging FLAGS_UI is not a restore failure: the
    // registry already holds the exact original values.
    let _ = windows::notify();
    // Notify even if a partial recovery failed, but retain the snapshot in either
    // a write/conflict failure or a notification failure.
    let notification = windows::notify();
    if let Err(e) = recovery { return Err(format!("Восстановление не завершено; snapshot сохранён: {e}")); }
    notification.map_err(|e| format!("Восстановление не завершено; snapshot сохранён: {e}"))?;
    // Preserve legacy plaintext v2 bytes as a separate archival file, even after
    // successful recovery. New snapshots are DPAPI-encrypted and can be removed.
    let original = fs::read(path).map_err(|e| format!("Не удалось проверить snapshot: {e}"))?;
    if !original.starts_with(b"KPV3-DPAPI\0") {
        let mut saved = false;
        for index in 0..1000 {
            let archive = path.with_file_name(format!("proxy-snapshot.legacy-v2-preserved-{index}.json"));
            match fs::OpenOptions::new().write(true).create_new(true).open(archive) {
                Ok(mut f) => { f.write_all(&original).and_then(|_| f.sync_all()).map_err(|e| format!("Не удалось сохранить legacy snapshot: {e}"))?; saved = true; break; },
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("Не удалось сохранить legacy snapshot: {e}")),
            }
        }
        if !saved { return Err("Нет места для сохранения legacy snapshot".into()); }
    }
    fs::remove_file(path).map_err(|e| format!("Настройки восстановлены, но snapshot не удалён: {e}"))
}
fn apply_snapshot(snapshot: &ProxySnapshot, fail_after: Option<usize>, watchdog: &mut Child) -> Result<(), String> {
    let dump = || NAMES.iter().map(|name| format!("{name}={:?}", windows::get(name).unwrap_or(None))).collect::<Vec<_>>().join(" ");
    // Detect changes since capture, including the bypass list, before making writes.
    for c in &snapshot.changes {
        if !same_indicator(&c.name, &windows::get(&c.name)?, &c.before) { return Err(format!("{} изменился во время запуска; proxy не включён", c.name)); }
    }
    let current_flags = windows::flags()?;
    if has_pac(current_flags) != has_pac(snapshot.before_flags) { return Err(format!("Появился PAC/автоопределение до записи: {current_flags}; {}", dump())); }
    let mut writes = 0;
    let mut completed: Vec<&str> = Vec::new();
    // The PAC bits disappear as soon as AutoConfigURL/AutoDetect are written, so the
    // expected flag state follows the writes we already made instead of the capture.
    let pac_expected = |done: &[&str]| -> bool {
        if done.iter().any(|name| *name == "AutoConfigURL" || *name == "AutoDetect") { has_pac(snapshot.applied_flags) } else { has_pac(snapshot.before_flags) }
    };
    for c in snapshot.changes.iter().filter(|c| c.managed) {
        check_watchdog(watchdog)?;
        let current_flags = windows::flags()?;
        if has_pac(current_flags) != pac_expected(&completed) { return Err(format!("Появился PAC/автоопределение перед записью {}: {current_flags}; {}", c.name, dump())); }
        // Check the whole set again before each step. This narrows, but cannot eliminate,
        // races with external programs because Windows Registry has no compare-and-swap.
        for check in &snapshot.changes {
            let expected = if completed.contains(&check.name.as_str()) { &check.applied } else { &check.before };
            if !same_indicator(&check.name, &windows::get(&check.name)?, expected) { return Err(format!("{} изменился во время запуска", check.name)); }
        }
        if c.before != c.applied { windows::set(&c.name, &c.applied)?; writes += 1; }
        completed.push(&c.name);
        if fail_after == Some(writes) { return Err("Тестовая ошибка записи proxy".into()); }
    }
    let current_flags = windows::flags()?;
    // We write AutoConfigURL=None and AutoDetect=0, so the expected state after
    // the values are applied is the applied_flags word, not the captured one.
    if has_pac(current_flags) != has_pac(snapshot.applied_flags) { return Err(format!("Появился PAC/автоопределение после значений: {current_flags}; {}", dump())); }
    for c in &snapshot.changes {
        let expected = if c.managed { &c.applied } else { &c.before };
        if !same_indicator(&c.name, &windows::get(&c.name)?, expected) { return Err(format!("{} изменился до включения WinINet", c.name)); }
    }
    check_watchdog(watchdog)?;
    windows::set_flags(snapshot.applied_flags)?;
    let applied = wait_local_proxy(Duration::from_secs(2));
    if applied & 2 == 0 || has_pac(applied) { return Err(format!("WinINet не включил локальный proxy: флаги {applied}")); }
    for c in &snapshot.changes {
        let expected = if c.managed { &c.applied } else { &c.before };
        if !same_indicator(&c.name, &windows::get(&c.name)?, expected) { return Err(format!("{} изменился при включении WinINet", c.name)); }
    }
    windows::notify()?;
    check_watchdog(watchdog)
}
fn snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку настроек: {e}"))?;
    Ok(dir.join("proxy-snapshot.json"))
}
const SECURE_STATE_LIMIT: usize = 16 * 1024 * 1024;
fn secure_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку настроек: {e}"))?;
    Ok(dir.join("state.enc"))
}
// Subscription URLs, UUIDs and passwords never go to localStorage or a plain
// file: the snapshot is encrypted with DPAPI (current Windows user) and only the
// ciphertext is written. The plaintext text stays in memory and is never logged.
#[tauri::command]
fn load_secure_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = secure_state_path(&app)?;
    if !path.exists() { return Ok(None); }
    let bytes = fs::read(&path).map_err(|e| format!("Не удалось прочитать хранилище: {e}"))?;
    if bytes.is_empty() { return Ok(None); }
    let plain = if let Some(encrypted) = bytes.strip_prefix(b"KPV3-DPAPI\0") {
        windows::unprotect(encrypted).map_err(|_| "state.locked".to_string())?
    } else {
        // A plaintext file is accepted once so an interrupted upgrade can finish,
        // and is re-encrypted on the next save.
        bytes
    };
    let text = String::from_utf8(plain).map_err(|_| "state.locked".to_string())?;
    if text.len() > SECURE_STATE_LIMIT { return Err("Хранилище настроек повреждено".into()); }
    Ok(Some(text))
}
#[tauri::command]
fn save_secure_state(app: AppHandle, contents: String) -> Result<(), String> {
    if contents.len() > SECURE_STATE_LIMIT { return Err("Состояние приложения слишком велико".into()); }
    let root: serde_json::Value = serde_json::from_str(&contents).map_err(|_| "Состояние приложения повреждено".to_string())?;
    if !root.is_object() { return Err("Состояние приложения повреждено".into()); }
    let encrypted = windows::protect(contents.as_bytes()).map_err(|e| format!("Не удалось зашифровать настройки: {e}"))?;
    let path = secure_state_path(&app)?;
    let tmp = path.with_extension("enc.tmp");
    let mut data = b"KPV3-DPAPI\0".to_vec();
    data.extend_from_slice(&encrypted);
    fs::write(&tmp, &data).map_err(|e| format!("Не удалось записать настройки: {e}"))?;
    let _ = fs::remove_file(&path);
    fs::rename(&tmp, &path).map_err(|e| format!("Не удалось заменить настройки: {e}"))?;
    Ok(())
}
// A profile locked to another Windows user cannot be decrypted. The app offers
// a fresh start instead of crashing; the old file is kept next to the new one.
#[tauri::command]
fn reset_secure_state(app: AppHandle) -> Result<(), String> {
    let path = secure_state_path(&app)?;
    if !path.exists() { return Ok(()); }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let backup = path.with_extension(format!("enc.locked-{stamp}"));
    fs::rename(&path, &backup).map_err(|e| format!("Не удалось сохранить архив старого хранилища: {e}"))?;
    Ok(())
}

// Closing the window hides it only when the user enabled that option in settings.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);
const AUTOSTART_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[tauri::command]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Не удалось определить путь приложения: {e}"))?;
    let status = if enabled {
        let value = format!("\"{}\" --minimized", exe.display());
        std::process::Command::new("reg")
            .args(["add", AUTOSTART_KEY, "/v", "KartoshkaVPN", "/t", "REG_SZ", "/d", &value, "/f"])
            .status()
    } else {
        std::process::Command::new("reg")
            .args(["delete", AUTOSTART_KEY, "/v", "KartoshkaVPN", "/f"])
            .status()
    };
    let status = status.map_err(|e| format!("Не удалось изменить автозапуск: {e}"))?;
    if enabled && !status.success() { return Err("Windows отклонила запись автозапуска".into()); }
    Ok(enabled)
}
#[tauri::command]
fn autostart_enabled() -> bool {
    std::process::Command::new("reg")
        .args(["query", AUTOSTART_KEY, "/v", "KartoshkaVPN"])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}
#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}
#[tauri::command]
fn set_tray_active(app: AppHandle, active: bool) -> Result<(), String> {
    let bytes: &[u8] = if active { include_bytes!("../icons/tray-active.png") } else { include_bytes!("../icons/tray-idle.png") };
    let image = tauri::image::Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main") { tray.set_icon(Some(image)).map_err(|e| e.to_string())?; }
    Ok(())
}
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let url = url.trim();
    if !url.starts_with("https://") || url.len() > 2048 || url.chars().any(|c| c.is_control() || c == '"') {
        return Err("Разрешены только https-ссылки".into());
    }
    #[cfg(windows)]
    let result = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(not(windows))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|e| format!("Не удалось открыть ссылку: {e}"))
}
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}
fn append_log(app: &AppHandle, message: &str) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = fs::create_dir_all(&dir);
        let line = format!("[{}] {}\n", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(), message);
        let _ = fs::OpenOptions::new().create(true).append(true).open(dir.join("kartoshka.log")).and_then(|mut f| f.write_all(line.as_bytes()));
    }
}
fn validate_config(input: &str) -> Result<Vec<u16>, String> {
    if input.len() > MAX_CONFIG_BYTES { return Err(format!("Конфигурация Xray превышает лимит {MAX_CONFIG_BYTES} байт")); }
    let root: serde_json::Value = serde_json::from_str(input).map_err(|e| format!("Некорректный JSON Xray: {e}"))?;
    let obj = root.as_object().ok_or("Конфигурация должна быть объектом")?;
    // Xray's api, metrics, reverse and other services may open independent listeners.
    for key in obj.keys() {
        if !["log", "inbounds", "outbounds", "routing", "dns"].contains(&key.as_str()) { return Err(format!("Раздел Xray {key} не разрешён в proxy-only режиме")); }
    }
    let ins = root.get("inbounds").and_then(|v| v.as_array()).ok_or("Нет inbounds Xray")?;
    if ins.is_empty() || ins.len() > 2 { return Err("Разрешены только HTTP 2080 и необязательный SOCKS 2081".into()); }
    let mut ports = Vec::new();
    for inbound in ins {
        if inbound.get("listen").and_then(|v| v.as_str()) != Some("127.0.0.1") { return Err("Все inbounds должны слушать только 127.0.0.1".into()); }
        let pair = (inbound.get("protocol").and_then(|v| v.as_str()), inbound.get("port").and_then(|v| v.as_u64()));
        let port = match pair { (Some("http"), Some(2080)) => 2080, (Some("socks"), Some(2081)) => 2081, _ => return Err("Разрешены только HTTP 2080 и SOCKS 2081".into()) };
        if ports.contains(&port) { return Err("Повторный inbound порт".into()); }
        ports.push(port);
    }
    if !ports.contains(&2080) { return Err("Нужен HTTP proxy на 127.0.0.1:2080".into()); }
    Ok(ports)
}
fn configure_command(command: &mut Command, assets: &Path) {
    command.stdin(Stdio::null());
    command.env("XRAY_LOCATION_ASSET", assets).env("XRAY_JSON_STRICT", "true").env_remove("XRAY_LOCATION_CONFDIR");
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
}
fn stop_child(child: &mut Child) -> Result<(), String> {
    match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => { child.kill().map_err(|e| format!("Не удалось завершить Xray: {e}"))?; child.wait().map_err(|e| format!("Не удалось дождаться Xray: {e}"))?; Ok(()) },
        Err(e) => Err(format!("Не удалось проверить Xray: {e}")),
    }
}
fn send_config(child: &mut Child, config: &str, limit: Duration) -> Result<(), String> {
    if config.len() > MAX_CONFIG_BYTES { let _ = stop_child(child); return Err(format!("Конфигурация Xray превышает лимит {MAX_CONFIG_BYTES} байт")); }
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => { let _ = stop_child(child); return Err("Не удалось открыть канал конфигурации Xray".into()); }
    };
    let bytes = config.as_bytes().to_vec();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = stdin.write_all(&bytes);
        drop(stdin); // Xray needs EOF, including for an empty config.
        let _ = tx.send(result);
    });
    let error = match rx.recv_timeout(limit) {
        Ok(Ok(())) => return Ok(()),
        Ok(Err(e)) => format!("Не удалось передать конфигурацию Xray: {e}"),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => "Превышено время передачи конфигурации Xray".into(),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => "Канал передачи конфигурации Xray прерван".into(),
    };
    // Killing the reader releases a blocked writer. Do not wait on the writer:
    // another inherited pipe reader could otherwise make the timeout unbounded.
    match stop_child(child) { Ok(()) => Err(error), Err(e) => Err(format!("{error}; {e}")) }
}
fn spawn_xray(binary: &Path, assets: &Path, config: &str, check_only: bool) -> Result<Child, String> {
    if config.len() > MAX_CONFIG_BYTES { return Err(format!("Конфигурация Xray превышает лимит {MAX_CONFIG_BYTES} байт")); }
    windows::ensure_core_job()?;
    let mut command = Command::new(binary);
    configure_command(&mut command, assets);
    command.arg("run");
    if check_only { command.arg("-test"); }
    let mut child = command.args(["-config", "stdin:"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("Не удалось запустить Xray: {e}"))?;
    send_config(&mut child, config, CONFIG_WRITE_TIMEOUT)?;
    Ok(child)
}
fn test_config(binary: &Path, assets: &Path, config: &str) -> Result<(), String> {
    let mut child = spawn_xray(binary, assets, config, true)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("Xray отклонил конфигурацию ({status})")),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => { let _ = stop_child(&mut child); return Err("Проверка Xray превысила 15 секунд".into()); },
            Err(e) => { let _ = stop_child(&mut child); return Err(format!("Ошибка проверки Xray: {e}")); }
        }
    }
}
fn check_watchdog(watchdog: &mut Child) -> Result<(), String> {
    match watchdog.try_wait() { Ok(None) => Ok(()), Ok(Some(_)) => Err("Watchdog неожиданно завершился".into()), Err(e) => Err(format!("Не удалось проверить watchdog: {e}")) }
}
fn wait_watchdog(child: &mut Child, duration: Duration) -> Result<Option<std::process::ExitStatus>, String> {
    let deadline = Instant::now() + duration;
    loop {
        match child.try_wait() { Ok(Some(status)) => return Ok(Some(status)), Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)), Ok(None) => return Ok(None), Err(e) => return Err(format!("Не удалось дождаться watchdog: {e}")) }
    }
}
fn disarm_watchdog(watchdog: &mut Child) -> Result<(), String> {
    if watchdog.try_wait().map_err(|e| e.to_string())?.is_some() { return Ok(()); }
    if let Some(mut pipe) = watchdog.stdin.take() { pipe.write_all(&[0x5a]).map_err(|e| format!("Не удалось остановить watchdog: {e}"))?; }
    match wait_watchdog(watchdog, Duration::from_secs(5))? {
        Some(_) => Ok(()),
        None => { stop_child(watchdog)?; Err("Watchdog не завершился вовремя".into()) }
    }
}
fn launch_watchdog(path: &Path, core: &Child) -> Result<Child, String> {
    use std::io::BufRead;
    let (parent_pid, parent_time) = windows::parent_identity()?;
    let (core_pid, core_time) = windows::child_identity(core)?;
    #[cfg(test)]
    let exe = std::env::var_os("KARTOVPN_WATCHDOG_TEST_EXE").map(PathBuf::from).ok_or("Для тестов нужен KARTOVPN_WATCHDOG_TEST_EXE")?;
    #[cfg(not(test))]
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut command = Command::new(exe);
    // Request breakaway only when in a job. A restrictive outer job can reject
    // this; that must fail closed rather than accept an unprotected watchdog.
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(windows::watchdog_creation_flags()?); }
    let mut watcher = command.arg("--proxy-watchdog-v1").arg(path).arg(parent_pid.to_string()).arg(parent_time.to_string()).arg(core_pid.to_string()).arg(core_time.to_string())
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("Не удалось запустить независимый watchdog (внешний Job Object может запрещать выход из него): {e}; proxy не включён"))?;
    let stdout = watcher.stdout.take().ok_or("Нет канала готовности watchdog")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = std::io::BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = sender.send(result);
    });
    let ready = matches!(receiver.recv_timeout(Duration::from_secs(8)), Ok(Ok(line)) if line == "READY\n");
    if !ready || check_watchdog(&mut watcher).is_err() {
        let _ = stop_child(&mut watcher);
        return Err("Watchdog не подтвердил проверенные процессы до включения proxy".into());
    }
    // The property that matters is escaping our own KILL_ON_JOB_CLOSE job: if the
    // GUI dies, that job kills Xray and must not kill the watchdog. Membership in an
    // outer launcher job (Task Scheduler, installer, corporate launcher) is allowed;
    // such a job also outlives a GUI crash, and its own termination kills the GUI too.
    if windows::core_in_job(&watcher).unwrap_or(true) {
        let _ = stop_child(&mut watcher);
        return Err("Watchdog остался в защитном Job Object приложения; proxy не включён".into());
    }
    Ok(watcher)
}
fn stop_runtime(runtime: &mut ProxyRuntime) -> Result<(), String> {
    // If the core died first, let the watchdog finish, then verify its result before
    // interpreting a missing snapshot as a successful concurrent recovery.
    let core_dead = match runtime.child.as_mut() { Some(c) => c.try_wait().map_err(|e| e.to_string())?.is_some(), None => false };
    let mut watcher_recovered = false;
    if core_dead {
        if let Some(w) = runtime.watchdog.as_mut() {
            if let Some(status) = wait_watchdog(w, Duration::from_secs(5))? { watcher_recovered = status.success(); }
        }
    }
    if let Some(path) = &runtime.snapshot_path {
        let _lock = windows::lock()?;
        if path.exists() { restore_snapshot_locked(path)?; }
        else if !watcher_recovered { return Err("Snapshot исчез; восстановление невозможно, проверьте proxy Windows вручную".into()); }
    }
    runtime.snapshot_path = None;
    // Disarm only after restoration; waiting outside the cross-process lock prevents deadlocks.
    let watchdog_result = if let Some(w) = runtime.watchdog.as_mut() { disarm_watchdog(w) } else { Ok(()) };
    runtime.watchdog = None;
    if let Some(child) = runtime.child.as_mut() { stop_child(child)?; }
    runtime.child = None;
    runtime.ports.clear();
    runtime.generation = runtime.generation.wrapping_add(1);
    watchdog_result
}
fn points_to_local_proxy() -> Result<bool, String> {
    let server = windows::get("ProxyServer")?;
    let enabled = windows::get("ProxyEnable")? == dword(1) || windows::flags()? & 2 != 0;
    Ok(enabled && server == text(LOCAL_PROXY))
}
fn stop_checked(runtime: &mut ProxyRuntime, path: &Path) -> Result<(), String> {
    if runtime.snapshot_path.is_some() { return stop_runtime(runtime); }
    if path.exists() { restore_snapshot(path)?; }
    if runtime.child.is_none() && points_to_local_proxy()? {
        return Err("Windows указывает на 127.0.0.1:2080, но нет работающего Xray и snapshot. Безопасное автоматическое восстановление невозможно; проверьте proxy Windows вручную".into());
    }
    stop_runtime(runtime)
}
// The lock spans capture, durable snapshot, watchdog handshake and activation. If either
// monitored process dies, the watchdog takes the abandoned/released lock before recovery.
fn activate_guarded(runtime: &mut ProxyRuntime, mut child: Child, path: &Path, fail_after: Option<usize>, ports: &[u16]) -> Result<u64, String> {
    let mut watcher: Option<Child> = None;
    let mut own_snapshot = false;
    let transaction = (|| -> Result<(), String> {
        if !windows::core_in_job(&child)? { return Err("Xray не находится в защитном Job Object; proxy не включён".into()); }
        let _lock = windows::lock()?;
        let result = (|| -> Result<(), String> {
            if path.exists() { return Err("Остался невосстановленный snapshot".into()); }
            let snapshot = capture_proxy()?;
            require_no_foreign_proxy(&snapshot)?;
            save_snapshot(path, &snapshot)?;
            own_snapshot = true;
            watcher = Some(launch_watchdog(path, &child)?);
            for port in ports { if !windows::owned_listener(child.id(), *port)? { return Err("Xray потерял локальный listener до включения proxy".into()); } }
            apply_snapshot(&snapshot, fail_after, watcher.as_mut().unwrap())?;
            if child.try_wait().map_err(|e| e.to_string())?.is_some() { return Err("Xray завершился при включении proxy".into()); }
            for port in ports { if !windows::owned_listener(child.id(), *port)? { return Err("Xray потерял listener при включении proxy".into()); } }
            check_watchdog(watcher.as_mut().unwrap())?;
            Ok(())
        })();
        if let Err(e) = result {
            let rollback = if own_snapshot && path.exists() { restore_snapshot_locked(path) } else { Ok(()) };
            return match rollback { Ok(()) => Err(e), Err(r) => Err(format!("{e}; {r}")) };
        }
        Ok(())
    })();
    if let Err(error) = transaction {
        if own_snapshot && path.exists() {
            // On failed rollback keep the real core alive and keep any watchdog armed.
            runtime.generation = runtime.generation.wrapping_add(1);
            runtime.snapshot_path = Some(path.to_path_buf()); runtime.child = Some(child); runtime.watchdog = watcher; runtime.ports = ports.to_vec();
        } else {
            if let Some(w) = watcher.as_mut() { let _ = disarm_watchdog(w); }
            let _ = stop_child(&mut child);
        }
        return Err(error);
    }
    runtime.generation = runtime.generation.wrapping_add(1);
    runtime.snapshot_path = Some(path.to_path_buf()); runtime.child = Some(child); runtime.watchdog = watcher; runtime.ports = ports.to_vec();
    Ok(runtime.generation)
}

fn spawn_monitor(app: AppHandle, monitor: Arc<Mutex<ProxyRuntime>>, generation: u64) {
    std::thread::spawn(move || {
        let mut reason: Option<String> = None;
        let mut check_errors = 0u32;
        let mut warned = false;
        let mut next_retry = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let result = {
                let mut guard = match monitor.lock() { Ok(g) => g, Err(_) => break };
                if guard.generation != generation { break; }
                record_health(&mut reason, &mut check_errors, inspect_runtime(&mut guard));
                if reason.is_some() && Instant::now() >= next_retry { Some(stop_runtime(&mut guard)) } else { None }
            };
            if let Some(restore) = result {
                let description = reason.as_deref().unwrap_or("Ошибка proxy");
                match restore {
                    Ok(()) => {
                        let message = format!("{description}; настройки proxy восстановлены");
                        append_log(&app, &message);
                        let _ = app.emit("proxy-exited", message);
                        break;
                    },
                    Err(e) => {
                        if !warned {
                            let message = format!("{description}. ОШИБКА восстановления proxy: {e}. Защита может отсутствовать; проверьте настройки Windows и повторите восстановление. Монитор продолжит попытки без намеренной перезаписи сторонних настроек.");
                            append_log(&app, &message);
                            let _ = app.emit("proxy-exited", message);
                            warned = true;
                        }
                        next_retry = Instant::now() + Duration::from_secs(5);
                    },
                }
            }
        }
    });
}
// A suspend or a network switch leaves the live sockets dead while the process
// is still alive, so the process monitor cannot see it. The address of the
// outgoing interface changes on a switch, and the wall clock jumps ahead of the
// monotonic clock after a suspend.
fn local_ipv4() -> Option<std::net::Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:53").ok()?;
    match socket.local_addr().ok()? { std::net::SocketAddr::V4(addr) => Some(*addr.ip()), _ => None }
}
fn clock_jumped(wall: Duration, mono: Duration) -> bool { wall.as_secs() > mono.as_secs() + 20 }
fn health_probe() -> bool {
    use std::io::{Read, Write};
    for host in ["connectivitycheck.gstatic.com", "cp.cloudflare.com"] {
        let Ok(mut stream) = StdTcpStream::connect_timeout(&([127, 0, 0, 1], 2080).into(), Duration::from_secs(2)) else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(4)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(4)));
        let request = format!("GET http://{host}/generate_204 HTTP/1.1\r\nHost: {host}\r\nUser-Agent: KartoshkaHealth/1\r\nConnection: close\r\n\r\n");
        if stream.write_all(request.as_bytes()).is_err() { continue; }
        let mut buffer = [0u8; 32];
        if let Ok(read) = stream.read(&mut buffer) {
            let head = String::from_utf8_lossy(&buffer[..read]);
            if head.starts_with("HTTP/1.1 204") || head.starts_with("HTTP/1.0 204") { return true; }
        }
    }
    false
}
fn spawn_health(app: AppHandle, runtime: Arc<Mutex<ProxyRuntime>>, generation: u64) {
    std::thread::spawn(move || {
        let mut generation = generation;
        let mut failures = 0u32;
        let mut last_wall = SystemTime::now();
        let mut last_tick = Instant::now();
        let mut last_ip = local_ipv4();
        let mut next_probe = Instant::now() + Duration::from_secs(30);
        loop {
            std::thread::sleep(Duration::from_secs(5));
            let config = {
                let guard = match runtime.lock() { Ok(g) => g, Err(_) => break };
                if guard.generation != generation || guard.child.is_none() { break; }
                guard.config.clone()
            };
            let wall = SystemTime::now();
            let wall_delta = wall.duration_since(last_wall).unwrap_or_default();
            let mono_delta = last_tick.elapsed();
            last_wall = wall; last_tick = Instant::now();
            let slept = clock_jumped(wall_delta, mono_delta);
            let ip = local_ipv4();
            let network_changed = ip != last_ip;
            last_ip = ip;
            if slept || network_changed {
                append_log(&app, if slept { "Обнаружен выход из сна; проверяю туннель" } else { "Обнаружена смена сети; проверяю туннель" });
                next_probe = Instant::now();
            }
            if Instant::now() < next_probe { continue; }
            next_probe = Instant::now() + Duration::from_secs(30);
            if health_probe() { failures = 0; continue; }
            failures += 1;
            // After a suspend or a switch the old sockets are already dead, so
            // one failed probe is enough there; otherwise three in a row.
            let threshold = if slept || network_changed { 1 } else { 3 };
            if failures < threshold { continue; }
            append_log(&app, "Health-check: туннель не отвечает; перезапускаю ядро");
            let Some(config) = config else { break };
            let restart = (|| -> Result<u64, String> {
                let binary = xray_path()?;
                let assets = app.path().resource_dir().map_err(|e| e.to_string())?.join("xray-assets");
                let path = snapshot_path(&app)?;
                let mut guard = runtime.lock().map_err(|_| "Ошибка блокировки состояния".to_string())?;
                if guard.generation != generation { return Err("Ядро уже перезапущено".into()); }
                stop_runtime(&mut guard)?;
                start_runtime(&mut guard, &binary, &assets, &path, &config, None)
            })();
            match restart {
                Ok(next) => {
                    generation = next; failures = 0;
                    append_log(&app, "Health-check: ядро перезапущено");
                    spawn_monitor(app.clone(), runtime.clone(), next);
                    let _ = app.emit("proxy-restarted", "Health-check перезапустил ядро".to_string());
                },
                Err(e) => {
                    append_log(&app, &format!("Health-check: перезапуск не удался: {e}"));
                    let _ = app.emit("proxy-unhealthy", e);
                    break;
                },
            }
        }
    });
}

fn start_runtime(runtime: &mut ProxyRuntime, binary: &Path, assets: &Path, path: &Path, config_json: &str, fail_after: Option<usize>) -> Result<u64, String> {
    let ports = validate_config(config_json)?;
    if path.exists() && runtime.snapshot_path.is_none() {
        if let Err(e) = load_snapshot(path) { return Err(e); }
        return Err(format!("Остался невосстановленный snapshot {}; запуск заблокирован, повторите восстановление", path.display()));
    }
    stop_runtime(runtime)?;
    if path.exists() { return Err("Остался невосстановленный snapshot: запуск заблокирован".into()); }
    if points_to_local_proxy()? { return Err("Windows уже указывает на 127.0.0.1:2080 без snapshot. Проверьте и восстановите настройки proxy вручную до подключения".into()); }
    { let _lock = windows::lock()?; require_no_foreign_proxy(&capture_proxy()?)?; }
    test_config(binary, assets, config_json)?;
    let mut child = spawn_xray(binary, assets, config_json, false)?;
    let ready = (|| -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() { return Err("Xray завершился до готовности proxy".into()); }
            let mut ready = true;
            for port in &ports {
                if !windows::owned_listener(child.id(), *port)? || StdTcpStream::connect_timeout(&([127, 0, 0, 1], *port).into(), Duration::from_millis(100)).is_err() { ready = false; }
            }
            if ready { return Ok(()); }
            if Instant::now() >= deadline { return Err("Локальные порты не принадлежат запущенному Xray или не готовы".into()); }
            std::thread::sleep(Duration::from_millis(100));
        }
    })();
    if let Err(e) = ready { let _ = stop_child(&mut child); return Err(e); }
    let generation = activate_guarded(runtime, child, path, fail_after, &ports)?;
    runtime.config = Some(config_json.to_string());
    Ok(generation)
}
#[derive(Debug, PartialEq, Eq)]
enum MonitorHealth { Healthy, Fault(String), CheckError(String) }
fn record_health(reason: &mut Option<String>, check_errors: &mut u32, health: MonitorHealth) {
    match health {
        MonitorHealth::Healthy => { *check_errors = 0; },
        MonitorHealth::Fault(e) => { reason.get_or_insert(e); },
        MonitorHealth::CheckError(e) => {
            *check_errors = check_errors.saturating_add(1);
            if *check_errors >= 3 { reason.get_or_insert(format!("Проверка защиты неоднократно не удалась: {e}")); }
        },
    }
}
fn inspect_runtime(runtime: &mut ProxyRuntime) -> MonitorHealth {
    let core = match runtime.child.as_mut() {
        Some(core) => core,
        None => return MonitorHealth::Fault("Xray отсутствует".into()),
    };
    match core.try_wait() {
        Ok(Some(_)) => return MonitorHealth::Fault("Xray неожиданно завершился".into()),
        Err(e) => return MonitorHealth::CheckError(format!("Не удалось проверить Xray: {e}")),
        Ok(None) => {},
    }
    let pid = core.id();
    for port in &runtime.ports {
        match windows::owned_listener(pid, *port) {
            Ok(true) => {},
            Ok(false) => return MonitorHealth::Fault(format!("Xray потерял собственный listener на 127.0.0.1:{port}")),
            Err(e) => return MonitorHealth::CheckError(format!("Не удалось проверить listener {port}: {e}")),
        }
    }
    match runtime.watchdog.as_mut() {
        None => MonitorHealth::Fault("Watchdog отсутствует; аварийная защита не работает".into()),
        Some(watcher) => match watcher.try_wait() {
            Ok(Some(_)) => MonitorHealth::Fault("Watchdog неожиданно завершился; аварийная защита не работает".into()),
            Err(e) => MonitorHealth::CheckError(format!("Не удалось проверить watchdog: {e}")),
            Ok(None) => MonitorHealth::Healthy,
        },
    }
}
fn xray_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.parent().ok_or("Не найдена папка приложения")?.join("xray.exe"))
}

#[tauri::command]
async fn fetch_subscription(url: String, protect_dns: Option<bool>) -> Result<SubscriptionResponse, String> {
    let trimmed = url.trim().to_string();
    if ["vless://", "vmess://", "trojan://", "ss://", "hysteria2://"].iter().any(|p| trimmed.starts_with(p)) { return Ok(SubscriptionResponse { body: trimmed, userinfo: None, title: None, support_url: None, home_url: None }); }
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) { return Err("Ссылка должна начинаться с http:// или https://".into()); }
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30)).user_agent("KartoshkaVPN/0.9.4").redirect(reqwest::redirect::Policy::limited(5));
    // With DNS protection the panel host is resolved over DoH; reqwest keeps the
    // hostname for SNI and Host while connecting to the pinned address.
    if protect_dns.unwrap_or(false) {
        if let Ok(parsed) = reqwest::Url::parse(&trimmed) {
            if let Some(host) = parsed.host_str() {
                if host.parse::<std::net::IpAddr>().is_err() {
                    if let Some(addr) = doh::resolve_for_client(host, parsed.port_or_known_default().unwrap_or(443)).await {
                        builder = builder.resolve(host, addr);
                    }
                }
            }
        }
    }
    let response = builder.build().map_err(|e| e.to_string())?.get(trimmed).header("Accept", "text/plain, text/*, */*").send().await.map_err(|e| format!("Не удалось открыть подписку: {}", e.without_url()))?.error_for_status().map_err(|e| format!("Сервер подписки вернул ошибку: {}", e.without_url()))?;
    let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let userinfo = header("subscription-userinfo");
    // Panels publish these headers; a base64: prefix is decoded when it is valid UTF-8.
    let title = header("profile-title").map(|value| {
        value.strip_prefix("base64:").and_then(|encoded| {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.decode(encoded.trim()).ok().and_then(|bytes| String::from_utf8(bytes).ok())
        }).unwrap_or(value)
    });
    let https_only = |value: Option<String>| value.filter(|url| url.starts_with("https://") && url.len() <= 2048 && !url.chars().any(|c| c.is_control()));
    let support_url = https_only(header("support-url"));
    let home_url = https_only(header("profile-web-page-url"));
    let body = response.text().await.map_err(|e| format!("Не удалось прочитать подписку: {}", e.without_url()))?;
    Ok(SubscriptionResponse { body, userinfo, title, support_url, home_url })
}
#[tauri::command]
async fn resolve_host(name: String) -> Result<doh::Resolution, String> {
    Ok(doh::resolve(&name).await)
}

#[tauri::command]
async fn dns_check(names: Vec<String>) -> Result<Vec<doh::Resolution>, String> {
    let mut out = Vec::new();
    for name in names.into_iter().take(3) {
        out.push(doh::resolve(&name).await);
    }
    Ok(out)
}

#[tauri::command]
async fn test_latency(host: String, port: u16) -> Result<Option<u32>, String> {
    let started = Instant::now();
    match timeout(Duration::from_secs(5), TcpStream::connect((host.as_str(), port))).await { Ok(Ok(_)) => Ok(Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32)), _ => Ok(None) }
}

// Xray 26 removed allowInsecure: a node that relied on it stays usable only if
// the certificate is pinned. Pinning happens on first connect (TOFU): the
// handshake below records the leaf certificate and never sends data. The pin is
// stored with the node, so later connections cannot be silently redirected.
#[derive(Debug)]
struct CertCapture(std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>>);
impl rustls::client::danger::ServerCertVerifier for CertCapture {
    fn verify_server_cert(&self, end_entity: &rustls::pki_types::CertificateDer<'_>, _intermediates: &[rustls::pki_types::CertificateDer<'_>], _server_name: &rustls::pki_types::ServerName<'_>, _ocsp: &[u8], _now: rustls::pki_types::UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if let Ok(mut slot) = self.0.lock() { *slot = Some(end_entity.as_ref().to_vec()); }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, _message: &[u8], _cert: &rustls::pki_types::CertificateDer<'_>, _dss: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(&self, _message: &[u8], _cert: &rustls::pki_types::CertificateDer<'_>, _dss: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}
#[tauri::command]
async fn pin_peer_certificate(host: String, port: u16, server_name: String) -> Result<String, String> {
    let host = host.trim().trim_matches(['[', ']']).to_string();
    if host.is_empty() || host.len() > 253 || host.chars().any(|c| c.is_whitespace() || matches!(c, '/' | '@' | '#' | '?')) { return Err("Некорректный адрес сервера для проверки сертификата".into()); }
    if port == 0 { return Err("Некорректный порт для проверки сертификата".into()); }
    let name = if server_name.trim().is_empty() { host.clone() } else { server_name.trim().to_string() };
    let server = rustls::pki_types::ServerName::try_from(name.clone()).map_err(|_| "Некорректное имя сервера для проверки сертификата".to_string())?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let captured = std::sync::Arc::new(std::sync::Mutex::new(None));
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(CertCapture(captured.clone())))
        .with_no_client_auth();
    let stream = tokio::time::timeout(Duration::from_secs(10), tokio::net::TcpStream::connect((host.as_str(), port))).await
        .map_err(|_| "Сервер не ответил за 10 секунд при проверке сертификата".to_string())?
        .map_err(|e| format!("Не удалось подключиться для проверки сертификата: {e}"))?;
    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
    let _tls = tokio::time::timeout(Duration::from_secs(10), connector.connect(server, stream)).await
        .map_err(|_| "TLS-соединение не установлено за 10 секунд".to_string())?
        .map_err(|e| format!("Сервер не принял TLS-соединение: {e}"))?;
    let cert = captured.lock().map_err(|_| "Ошибка состояния проверки сертификата".to_string())?.clone()
        .ok_or_else(|| "Сервер не передал сертификат".to_string())?;
    Ok(format_pin(&cert))
}
// Xray expects the certificate hash as colon-separated lowercase hex, the same
// shape `openssl x509 -fingerprint -sha256` prints.
fn format_pin(der: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(der).iter().map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(":")
}
#[cfg(test)]
mod pin_tests {
    use super::format_pin;
    #[test]
    fn pin_is_sha256_with_colons() {
        assert_eq!(format_pin(b"abc"), "ba:78:16:bf:8f:01:cf:ea:41:41:40:de:5d:ae:22:23:b0:03:61:a3:96:17:7a:9c:b4:10:ff:61:f2:00:15:ad");
        assert_eq!(format_pin(b""), "e3:b0:c4:42:98:fc:1c:14:9a:fb:f4:c8:99:6f:b9:24:27:ae:41:e4:64:9b:93:4c:a4:95:99:1b:78:52:b8:55");
    }
}
#[tauri::command]
async fn probe_internet() -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(12)).proxy(reqwest::Proxy::all(format!("http://{LOCAL_PROXY}")).map_err(|e| e.to_string())?).build().map_err(|e| e.to_string())?;
    for endpoint in ["https://api.ipify.org", "https://ifconfig.me/ip", "https://ipinfo.io/ip"] {
        if let Ok(response) = client.get(endpoint).send().await { if response.status().is_success() { if let Ok(body) = response.text().await { if let Ok(ip) = body.trim().parse::<std::net::IpAddr>() { return Ok(ip.to_string()); } } } }
    }
    Err("Соединение через выбранный сервер не прошло проверку внешнего IP".into())
}
#[tauri::command]
async fn test_proxy_latency() -> Result<Option<u32>, String> {
    let started = Instant::now();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).proxy(reqwest::Proxy::all(format!("http://{LOCAL_PROXY}")).map_err(|e| e.to_string())?).build().map_err(|e| e.to_string())?;
    match client.get("https://www.gstatic.com/generate_204").send().await { Ok(r) if r.status().is_success() => Ok(Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32)), _ => Ok(None) }
}
#[tauri::command]
fn read_logs(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut text = fs::read_to_string(dir.join("kartoshka.log")).unwrap_or_default();
    // The core log only exists while debug mode has been used at least once.
    if let Ok(core) = fs::read_to_string(dir.join("core.log")) {
        let tail: Vec<&str> = core.lines().rev().take(400).collect();
        if !tail.is_empty() {
            text.push_str("\n--- Xray core (debug) ---\n");
            text.push_str(&tail.into_iter().rev().collect::<Vec<_>>().join("\n"));
            text.push('\n');
        }
    }
    Ok(text)
}
#[tauri::command]
async fn start_proxy(app: AppHandle, state: State<'_, ProxyState>, config_json: String, debug: Option<bool>) -> Result<(), String> {
    let path = snapshot_path(&app)?;
    let binary = xray_path()?;
    let assets = app.path().resource_dir().map_err(|e| format!("Не найдены ресурсы Xray: {e}"))?.join("xray-assets");
    // Debug mode only changes where the core writes its own diagnostics: the
    // process still receives the configuration over stdin and never logs secrets.
    let mut config_json = config_json;
    if debug == Some(true) {
        let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку настроек: {e}"))?;
        let mut root: serde_json::Value = serde_json::from_str(&config_json).map_err(|e| format!("Некорректный JSON Xray: {e}"))?;
        let log = root.as_object_mut().ok_or("Конфигурация должна быть объектом")?.entry("log").or_insert_with(|| serde_json::json!({}));
        if let Some(log) = log.as_object_mut() {
            log.insert("loglevel".into(), serde_json::json!("debug"));
            log.insert("access".into(), serde_json::json!("none"));
            log.insert("error".into(), serde_json::json!(dir.join("core.log").to_string_lossy()));
        }
        config_json = root.to_string();
    }
    let runtime = state.0.clone();
    let (result, generation) = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = runtime.lock().map_err(|_| "Ошибка блокировки состояния".to_string())?;
        let result = start_runtime(&mut guard, &binary, &assets, &path, &config_json, None);
        let generation = guard.child.as_ref().map(|_| guard.generation);
        Ok::<_, String>((result, generation))
    }).await.map_err(|e| e.to_string())??;
    if result.is_ok() { append_log(&app, "Xray и watchdog запущены; обход WinINet: <local>, 127.0.0.1, [::1]."); }
    if let Some(generation) = generation {
        spawn_monitor(app.clone(), state.0.clone(), generation);
        spawn_health(app.clone(), state.0.clone(), generation);
    }
    result.map(|_| ())
}
#[tauri::command]
async fn stop_proxy(app: AppHandle, state: State<'_, ProxyState>) -> Result<(), String> {
    let path = snapshot_path(&app)?;
    let runtime = state.0.clone();
    let result = tauri::async_runtime::spawn_blocking(move || { let mut guard = runtime.lock().map_err(|_| "Ошибка блокировки состояния".to_string())?; stop_checked(&mut guard, &path) }).await.map_err(|e| e.to_string())?;
    append_log(&app, &format!("Остановка proxy: {result:?}"));
    result
}

// Country flags are resolved offline: the subscription name first, then this
// database. Nothing about the node is sent to an external geolocation service.
static COUNTRY_DB: std::sync::OnceLock<Option<country::CountryDb>> = std::sync::OnceLock::new();
fn country_db(app: &AppHandle) -> Option<&'static country::CountryDb> {
    COUNTRY_DB.get_or_init(|| {
        let mut candidates = Vec::new();
        if let Ok(dir) = app.path().resource_dir() { candidates.push(dir.join("country-ipv4.bin.gz")); }
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/country-ipv4.bin.gz"));
        candidates.into_iter().find_map(|path| country::CountryDb::load(&path).ok())
    }).as_ref()
}

#[derive(Serialize)]
struct CountryLookup { host: String, code: Option<String> }

#[tauri::command]
async fn lookup_countries(app: AppHandle, hosts: Vec<String>) -> Vec<CountryLookup> {
    let Some(db) = country_db(&app) else { return Vec::new(); };
    let mut unique: Vec<String> = Vec::new();
    for host in hosts {
        let host = host.trim().trim_matches(['[', ']']).to_string();
        if !host.is_empty() && !unique.iter().any(|item| item.eq_ignore_ascii_case(&host)) { unique.push(host); }
    }
    if unique.is_empty() { return Vec::new(); }
    // A subscription can carry a hundred hostnames. Resolving them one by one
    // would freeze the flag column for minutes, so the lookups run in small
    // batches under one shared deadline; unresolved hosts simply stay unknown.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut queue = unique.into_iter();
    let mut result = Vec::new();
    let mut tasks = tokio::task::JoinSet::new();
    let spawn = |tasks: &mut tokio::task::JoinSet<CountryLookup>, host: String| {
        tasks.spawn(async move {
            let address = match host.parse::<std::net::IpAddr>() {
                Ok(std::net::IpAddr::V4(address)) => Some(address),
                Ok(std::net::IpAddr::V6(_)) => None,
                Err(_) => match timeout(Duration::from_secs(3), tokio::net::lookup_host((host.as_str(), 0))).await {
                    Ok(Ok(addresses)) => addresses.filter_map(|item| match item.ip() { std::net::IpAddr::V4(address) => Some(address), _ => None }).next(),
                    _ => None,
                },
            };
            let code = address.and_then(|address| db.lookup(address)).map(str::to_owned);
            CountryLookup { host, code }
        });
    };
    for _ in 0..8 { if let Some(host) = queue.next() { spawn(&mut tasks, host); } }
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => { tasks.abort_all(); break; }
            joined = tasks.join_next() => {
                match joined {
                    Some(Ok(item)) => result.push(item),
                    Some(Err(_)) => {},
                    None => break,
                }
                if let Some(host) = queue.next() { spawn(&mut tasks, host); }
            }
        }
    }
    result
}

// Hysteria2 is UDP-based, so a TCP handshake says nothing about it. A short-lived
// core instance on a random loopback port carries one real request instead; it
// never touches the system proxy and is always killed.
fn validate_probe_config(input: &str) -> Result<u16, String> {
    if input.len() > MAX_CONFIG_BYTES { return Err(format!("Конфигурация Xray превышает лимит {MAX_CONFIG_BYTES} байт")); }
    let root: serde_json::Value = serde_json::from_str(input).map_err(|e| format!("Некорректный JSON Xray: {e}"))?;
    let obj = root.as_object().ok_or("Конфигурация должна быть объектом")?;
    for key in obj.keys() { if !["log", "inbounds", "outbounds"].contains(&key.as_str()) { return Err(format!("Раздел Xray {key} не разрешён в режиме замера")); } }
    let inbounds = root.get("inbounds").and_then(|v| v.as_array()).ok_or("Нет inbounds Xray")?;
    if inbounds.len() != 1 { return Err("Для замера нужен ровно один inbound".into()); }
    let inbound = &inbounds[0];
    if inbound.get("listen").and_then(|v| v.as_str()) != Some("127.0.0.1") { return Err("Замер разрешён только на 127.0.0.1".into()); }
    if inbound.get("protocol").and_then(|v| v.as_str()) != Some("http") { return Err("Для замера нужен HTTP inbound".into()); }
    let port = inbound.get("port").and_then(|v| v.as_u64()).ok_or("Не указан порт замера")?;
    if !(20000..=60000).contains(&port) { return Err("Порт замера вне разрешённого диапазона".into()); }
    let outbounds = root.get("outbounds").and_then(|v| v.as_array()).ok_or("Нет outbounds Xray")?;
    if outbounds.len() != 1 { return Err("Для замера нужен ровно один outbound".into()); }
    Ok(port as u16)
}

async fn probe_through(child: &mut Child, port: u16) -> Result<u32, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() { Ok(Some(status)) => return Err(format!("Ядро завершилось до замера ({status})")), Ok(None) => {}, Err(e) => return Err(format!("Не удалось проверить ядро: {e}")) }
        if matches!(timeout(Duration::from_millis(200), TcpStream::connect(("127.0.0.1", port))).await, Ok(Ok(_))) { break; }
        if Instant::now() >= deadline { return Err("Ядро не открыло локальный порт за 10 секунд".into()); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?).build().map_err(|e| e.to_string())?;
    let started = Instant::now();
    match client.get("https://www.gstatic.com/generate_204").send().await {
        Ok(response) if response.status().is_success() => Ok(started.elapsed().as_millis().min(u32::MAX as u128) as u32),
        Ok(response) => Err(format!("Пробный запрос вернул HTTP {}", response.status())),
        Err(e) => Err(format!("Пробный запрос не прошёл: {}", e.without_url())),
    }
}

#[tauri::command]
async fn probe_node_latency(app: AppHandle, config_json: String) -> Result<u32, String> {
    let port = validate_probe_config(&config_json)?;
    let binary = xray_path()?;
    let assets = app.path().resource_dir().map_err(|e| format!("Не найдены ресурсы Xray: {e}"))?.join("xray-assets");
    let mut child = tauri::async_runtime::spawn_blocking(move || spawn_xray(&binary, &assets, &config_json, false)).await.map_err(|e| e.to_string())??;
    let result = probe_through(&mut child, port).await;
    let _ = stop_child(&mut child);
    result
}

fn main() {
    // The watchdog is the same installed executable, dispatched before Tauri or GUI init.
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).map(|s| s == "--proxy-watchdog-v1").unwrap_or(false) {
        let result = (|| -> Result<(), String> {
            if args.len() != 7 { return Err("Неверные параметры watchdog".into()); }
            let num = |n: usize| args[n].to_str().ok_or("Неверный параметр watchdog")?.parse::<u64>().map_err(|_| "Неверный параметр watchdog");
            let parent = (u32::try_from(num(3)?).map_err(|_| "Неверный PID")?, num(4)?);
            let core = (u32::try_from(num(5)?).map_err(|_| "Неверный PID")?, num(6)?);
            windows::watchdog(Path::new(&args[2]), parent, core)
        })();
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    let _instance = match windows::one_instance() { Ok(v) => v, Err(e) => { windows::show_error(&e); return; } };
    tauri::Builder::default().manage(ProxyState(Arc::new(Mutex::new(ProxyRuntime { child: None, watchdog: None, snapshot_path: None, ports: Vec::new(), generation: 0, config: None })))).invoke_handler(tauri::generate_handler![open_external, set_autostart, autostart_enabled, set_close_to_tray, set_tray_active, quit_app, load_secure_state, save_secure_state, reset_secure_state, fetch_subscription, resolve_host, dns_check, pin_peer_certificate, test_latency, test_proxy_latency, probe_internet, read_logs, lookup_countries, probe_node_latency, start_proxy, stop_proxy]).setup(|app| {
        let handle = app.handle();
        match snapshot_path(handle).and_then(|path| {
            if path.exists() { restore_snapshot(&path).map(|_| true) }
            else if points_to_local_proxy()? { Err("Windows указывает на 127.0.0.1:2080 без snapshot; источник и исходные настройки неизвестны".into()) }
            else { Ok(false) }
        }) {
            Ok(true) => append_log(handle, "Сохранённые настройки Windows proxy восстановлены"),
            Ok(false) => {},
            Err(e) => {
                append_log(handle, &format!("ОШИБКА восстановления proxy: {e}; запуск соединения заблокирован"));
                windows::show_error(&format!("Не удалось восстановить системный proxy: {e}\n\nПодключение заблокировано. Проверьте настройки Windows вручную и не меняйте настройки другого VPN без проверки. Если snapshot существует, он сохранён."));
            },
        }
        let open = tauri::menu::MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
        let toggle = tauri::menu::MenuItem::with_id(app, "toggle", "Подключить / Отключить", true, None::<&str>)?;
        let quit = tauri::menu::MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
        let menu = tauri::menu::Menu::with_items(app, &[&open, &toggle, &quit])?;
        let icon = app.default_window_icon().cloned().ok_or("В приложении нет иконки окна")?;
        tauri::tray::TrayIconBuilder::with_id("main")
            .icon(icon)
            .tooltip("КартошкаVPN")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "toggle" => { let _ = app.emit("tray-toggle", ()); }
                "quit" => { let _ = app.emit("tray-quit", ()); }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            })
            .build(app)?;
        if let Some(window) = app.get_webview_window("main") {
            let handle = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = handle.hide();
                    }
                }
            });
            if std::env::args().any(|arg| arg == "--minimized") { let _ = window.hide(); }
        }
        Ok(())
    }).build(tauri::generate_context!()).expect("ошибка запуска КартошкаVPN").run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(state) = app.try_state::<ProxyState>() { match state.0.lock() { Ok(mut guard) => {
                let result = snapshot_path(app).and_then(|path| stop_checked(&mut guard, &path));
                if let Err(e) = result {
                    let prevent = guard.child.is_some() && matches!(event, RunEvent::ExitRequested { .. });
                    if prevent { if let RunEvent::ExitRequested { api, .. } = &event { api.prevent_exit(); } }
                    append_log(app, &format!("ОШИБКА восстановления при выходе: {e}"));
                    windows::show_error(&format!("Не удалось восстановить proxy при выходе: {e}\n\n{}Проверьте настройки Windows вручную, не перезаписывая чужой VPN.", if prevent { "Выход отменён: завершение Xray может оставить Windows без связи. Устраните конфликт и повторите отключение. " } else { "" }));
                }
            }, Err(_) => {
                if let RunEvent::ExitRequested { api, .. } = &event { api.prevent_exit(); }
                append_log(app, "ОШИБКА блокировки при выходе");
                windows::show_error("Не удалось проверить и восстановить proxy при выходе. Выход отменён; проверьте настройки Windows вручную.");
            } } }
        }
    });
}

#[cfg(test)]
mod perf_tests {
    use super::*;
    #[test]
    fn suspend_is_detected_by_the_clock_jump() {
        // Wall clock 120 s ahead of the monotonic clock: the machine was asleep.
        assert!(clock_jumped(Duration::from_secs(120), Duration::from_secs(5)));
        // Normal scheduling jitter must not look like a suspend.
        assert!(!clock_jumped(Duration::from_secs(6), Duration::from_secs(5)));
        assert!(!clock_jumped(Duration::from_secs(25), Duration::from_secs(5)));
    }
}
#[cfg(all(test, windows))]
#[path = "../../tests/windows-native.rs"]
mod windows_native_tests;
