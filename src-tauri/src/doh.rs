//! DNS-over-HTTPS resolver for the pre-connection phase.
//!
//! Server hostnames and the subscription panel must not be resolved by the
//! system resolver while DNS protection is on. Provider hostnames are never
//! resolved either: every provider has literal bootstrap IPs from
//! `shared/dns-providers.json`, pinned with `ClientBuilder::resolve`, so a
//! spoofing or broken system DNS cannot redirect the DoH connection. TLS still
//! verifies the certificate against the provider hostname (SNI stays the name).
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(6);
const MAX_TTL: u64 = 600;
const PROVIDERS_JSON: &str = include_str!("../../shared/dns-providers.json");

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub url: String,
    pub ip_url: String,
    pub ru: bool,
    pub bootstrap: Vec<String>,
    #[serde(default)]
    pub bootstrap_v6: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ProvidersFile {
    providers: Vec<Provider>,
}

/// Providers in priority order: the Russian resolver first, then the rest.
pub fn providers() -> &'static [Provider] {
    static LIST: OnceLock<Vec<Provider>> = OnceLock::new();
    LIST.get_or_init(|| {
        let file: ProvidersFile = serde_json::from_str(PROVIDERS_JSON).expect("dns-providers.json is valid");
        let mut list = file.providers;
        list.sort_by_key(|provider| (!provider.ru, provider.bootstrap.is_empty()));
        list
    })
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn provider_by_id(id: &str) -> Option<&'static Provider> {
    providers().iter().find(|provider| provider.id == id)
}

/// IPv4 bootstrap addresses first, then IPv6. Only literal IPs: the list is
/// validated when the JSON is generated and again here.
pub fn bootstrap_addrs(provider: &Provider) -> Vec<IpAddr> {
    provider
        .bootstrap
        .iter()
        .chain(provider.bootstrap_v6.iter())
        .filter_map(|value| value.parse::<IpAddr>().ok())
        .collect()
}

fn provider_host(provider: &Provider) -> Option<String> {
    reqwest::Url::parse(&provider.url).ok()?.host_str().map(str::to_string)
}

#[derive(Debug, Clone)]
struct Entry {
    ips: Vec<IpAddr>,
    expires: Instant,
    server: String,
    server_ip: Option<IpAddr>,
}

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Resolution {
    pub ip: Option<String>,
    /// `doh`, `cache`, `system`, `failed` or `ip` (the input was already an address).
    pub source: String,
    /// Provider id that answered, for example `yandex`.
    pub server: Option<String>,
    /// Bootstrap address the DoH connection was pinned to.
    pub server_ip: Option<String>,
    /// `bootstrap-ip` when the provider was reached by a pinned address,
    /// `system` when the answer came from the system resolver.
    pub via: String,
}

impl Resolution {
    fn pinned(ip: &IpAddr, provider: &Provider, server_ip: IpAddr) -> Self {
        Resolution {
            ip: Some(ip.to_string()),
            source: "doh".into(),
            server: Some(provider.id.clone()),
            server_ip: Some(server_ip.to_string()),
            via: "bootstrap-ip".into(),
        }
    }
}

pub fn build_query(name: &str) -> Option<Vec<u8>> {
    let name = name.trim_end_matches('.');
    if name.is_empty() || name.len() > 253 {
        return None;
    }
    let mut out = vec![0x4b, 0x61, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    for label in name.split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // A, IN
    Some(out)
}

fn skip_name(buf: &[u8], mut pos: usize) -> Option<usize> {
    loop {
        let len = *buf.get(pos)? as usize;
        if len == 0 {
            return Some(pos + 1);
        }
        if len & 0xc0 == 0xc0 {
            return Some(pos + 2);
        }
        pos += 1 + len;
        if pos > buf.len() {
            return None;
        }
    }
}

/// Returns A/AAAA answers with the smallest TTL in the response.
pub fn parse_answer(buf: &[u8]) -> (Vec<IpAddr>, u64) {
    if buf.len() < 12 {
        return (Vec::new(), 0);
    }
    let qd = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let an = u16::from_be_bytes([buf[6], buf[7]]) as usize;
    let mut pos = 12;
    for _ in 0..qd {
        match skip_name(buf, pos) {
            Some(next) => pos = next + 4,
            None => return (Vec::new(), 0),
        }
    }
    let mut ips = Vec::new();
    let mut ttl = MAX_TTL;
    for _ in 0..an {
        let Some(next) = skip_name(buf, pos) else { break };
        pos = next;
        if pos + 10 > buf.len() {
            break;
        }
        let kind = u16::from_be_bytes([buf[pos], buf[pos + 1]]);
        let record_ttl = u32::from_be_bytes([buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]]) as u64;
        let len = u16::from_be_bytes([buf[pos + 8], buf[pos + 9]]) as usize;
        let data = pos + 10;
        if data + len > buf.len() {
            break;
        }
        match (kind, len) {
            (1, 4) => ips.push(IpAddr::from([buf[data], buf[data + 1], buf[data + 2], buf[data + 3]])),
            (28, 16) => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(&buf[data..data + 16]);
                ips.push(IpAddr::from(octets));
            }
            _ => {}
        }
        ttl = ttl.min(record_ttl.max(1));
        pos = data + len;
    }
    (ips, ttl.min(MAX_TTL))
}

/// Client pinned to one bootstrap address. `no_proxy` keeps the query away from
/// environment proxies, which would resolve the provider name through the system
/// resolver again.
fn pinned_client(host: &str, addr: SocketAddr) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .no_proxy()
        .resolve(host, addr)
        .build()
        .map_err(|e| e.to_string())
}

async fn query_with(provider: &Provider, name: &str, addr: SocketAddr) -> Result<(Vec<IpAddr>, u64), String> {
    let host = provider_host(provider).ok_or_else(|| "provider url has no host".to_string())?;
    let body = build_query(name).ok_or_else(|| "bad name".to_string())?;
    let response = pinned_client(&host, addr)?
        .post(&provider.url)
        .header("content-type", "application/dns-message")
        .header("accept", "application/dns-message")
        .body(body)
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if !response.status().is_success() {
        return Err(format!("status {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| e.without_url().to_string())?;
    let (ips, ttl) = parse_answer(&bytes);
    if ips.is_empty() {
        return Err("no addresses".to_string());
    }
    Ok((ips, ttl))
}

/// Tries every bootstrap address of the provider in order. The provider name is
/// never handed to the system resolver.
async fn query(provider: &Provider, name: &str) -> Result<(Vec<IpAddr>, u64, IpAddr), String> {
    let addresses = bootstrap_addrs(provider);
    if addresses.is_empty() {
        return Err("no bootstrap addresses".to_string());
    }
    let mut errors = Vec::new();
    for ip in addresses {
        match query_with(provider, name, SocketAddr::new(ip, 443)).await {
            Ok((ips, ttl)) => return Ok((ips, ttl, ip)),
            Err(error) => errors.push(format!("{ip}: {error}")),
        }
    }
    Err(errors.join("; "))
}

fn remember(name: &str, ips: &[IpAddr], ttl: u64, provider: &Provider, server_ip: IpAddr) {
    if let Ok(mut map) = cache().lock() {
        map.insert(name.to_string(), Entry {
            ips: ips.to_vec(),
            expires: Instant::now() + Duration::from_secs(ttl.clamp(1, MAX_TTL)),
            server: provider.id.clone(),
            server_ip: Some(server_ip),
        });
    }
}

fn cached(name: &str, allow_expired: bool) -> Option<Entry> {
    let map = cache().lock().ok()?;
    let entry = map.get(name)?.clone();
    if allow_expired || entry.expires > Instant::now() {
        Some(entry)
    } else {
        None
    }
}

fn system_lookup(name: &str) -> Option<IpAddr> {
    let addrs = (name, 0u16).to_socket_addrs().ok()?;
    addrs.map(|addr| addr.ip()).next()
}

/// Resolves through DoH only, then a remembered address, then `system`.
/// The injected resolver exists so tests can prove the DoH path never calls it.
pub async fn resolve_using(name: &str, system: impl Fn(&str) -> Option<IpAddr>) -> Resolution {
    let name = name.trim().trim_end_matches('.').to_ascii_lowercase();
    if let Ok(ip) = name.parse::<IpAddr>() {
        return Resolution { ip: Some(ip.to_string()), source: "ip".into(), server: None, server_ip: None, via: "ip".into() };
    }
    let list = providers();
    // All providers are queried at once: a slow one must not delay the answer,
    // and the priority order still decides which answer wins.
    let mut set = tokio::task::JoinSet::new();
    for (index, provider) in list.iter().enumerate() {
        let name = name.clone();
        set.spawn(async move { (index, query(provider, &name).await) });
    }
    let mut outcomes: Vec<(usize, Result<(Vec<IpAddr>, u64, IpAddr), String>)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(item) = joined {
            outcomes.push(item);
        }
    }
    outcomes.sort_by_key(|(index, _)| *index);
    for (index, result) in outcomes {
        let provider = &list[index];
        if let Ok((ips, ttl, used)) = result {
            remember(&name, &ips, ttl, provider, used);
            return Resolution::pinned(&ips[0], provider, used);
        }
    }
    if let Some(entry) = cached(&name, true) {
        return Resolution {
            ip: entry.ips.first().map(|ip| ip.to_string()),
            source: "cache".into(),
            server: Some(entry.server),
            server_ip: entry.server_ip.map(|ip| ip.to_string()),
            via: "cache".into(),
        };
    }
    match system(&name) {
        Some(ip) => Resolution { ip: Some(ip.to_string()), source: "system".into(), server: None, server_ip: None, via: "system".into() },
        None => Resolution { ip: None, source: "failed".into(), server: None, server_ip: None, via: "none".into() },
    }
}

pub async fn resolve(name: &str) -> Resolution {
    resolve_using(name, system_lookup).await
}

/// Resolves a host and returns the address for `Client::resolve`, keeping the
/// original hostname for TLS SNI and the Host header.
pub async fn resolve_for_client(host: &str, port: u16) -> Option<SocketAddr> {
    let resolution = resolve(host).await;
    let ip: IpAddr = resolution.ip?.parse().ok()?;
    Some(SocketAddr::new(ip, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_have_literal_bootstrap_addresses() {
        assert!(providers().len() >= 4);
        let yandex = provider_by_id("yandex").expect("yandex provider");
        assert!(yandex.ru);
        for provider in providers() {
            assert!(!provider.bootstrap.is_empty(), "{} has no bootstrap IPv4", provider.id);
            for value in provider.bootstrap.iter().chain(provider.bootstrap_v6.iter()) {
                assert!(value.parse::<IpAddr>().is_ok(), "{} bootstrap {value} is not an IP", provider.id);
            }
            let url = reqwest::Url::parse(&provider.ip_url).expect("ip url");
            assert!(url.host_str().expect("host").parse::<IpAddr>().is_ok(), "{} ipUrl must be an IP", provider.id);
        }
    }

    #[test]
    fn pinned_client_targets_the_bootstrap_address() {
        let provider = provider_by_id("cloudflare").expect("cloudflare");
        let host = provider_host(provider).expect("host");
        let addrs = bootstrap_addrs(provider);
        assert!(addrs.contains(&"1.1.1.1".parse().unwrap()));
        // Building the client must work without touching the system resolver.
        for ip in addrs {
            assert!(pinned_client(&host, SocketAddr::new(ip, 443)).is_ok());
        }
    }

    #[test]
    fn builds_a_wire_query() {
        let query = build_query("example.com").unwrap();
        assert_eq!(&query[0..2], &[0x4b, 0x61]);
        assert_eq!(&query[12..], b"\x07example\x03com\x00\x00\x01\x00\x01");
    }

    #[test]
    fn rejects_bad_names() {
        assert!(build_query("").is_none());
        assert!(build_query("a..b").is_none());
    }

    #[test]
    fn parses_an_a_answer_and_ttl() {
        let mut buf = vec![0x4b, 0x61, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00];
        buf.extend_from_slice(b"\x07example\x03com\x00\x00\x01\x00\x01");
        buf.extend_from_slice(b"\xc0\x0c\x00\x01\x00\x01");
        buf.extend_from_slice(&300u32.to_be_bytes());
        buf.extend_from_slice(&4u16.to_be_bytes());
        buf.extend_from_slice(&[93, 184, 216, 34]);
        let (ips, ttl) = parse_answer(&buf);
        assert_eq!(ips, vec!["93.184.216.34".parse::<IpAddr>().unwrap()]);
        assert_eq!(ttl, 300);
    }

    #[test]
    fn cache_keeps_the_last_answer() {
        let provider = provider_by_id("cloudflare").expect("cloudflare");
        let name = "cache.example";
        remember(name, &["10.0.0.1".parse().unwrap()], 60, provider, "1.1.1.1".parse().unwrap());
        let entry = cached(name, false).expect("entry");
        assert_eq!(entry.ips[0].to_string(), "10.0.0.1");
        assert_eq!(entry.server, "cloudflare");
        if let Ok(mut map) = cache().lock() {
            map.get_mut(name).unwrap().expires = Instant::now() - Duration::from_secs(1);
        }
        assert!(cached(name, false).is_none());
        assert!(cached(name, true).is_some());
    }

    /// Live check used by the bootstrap audit: a system resolver that panics must
    /// never be called, and the answer must come from a pinned bootstrap address.
    /// Run with DOH_LIVE=1 and network access.
    #[tokio::test]
    async fn live_doh_works_with_a_broken_system_resolver() {
        if std::env::var("DOH_LIVE").is_err() {
            return;
        }
        let mut answered = Vec::new();
        for provider in providers() {
            match query(provider, "example.com").await {
                Ok((ips, _ttl, used)) => {
                    assert!(!ips.is_empty());
                    assert!(bootstrap_addrs(provider).contains(&used), "{} answered from a non-bootstrap address {used}", provider.id);
                    answered.push(provider.id.clone());
                }
                Err(error) => eprintln!("{} did not answer: {error}", provider.id),
            }
        }
        assert!(answered.len() >= 2, "at least two providers must answer, got {answered:?}");
        let resolution = resolve_using("example.com", |_| panic!("system resolver must not be used for DoH providers")).await;
        assert_eq!(resolution.source, "doh");
        assert_eq!(resolution.via, "bootstrap-ip");
    }
}
