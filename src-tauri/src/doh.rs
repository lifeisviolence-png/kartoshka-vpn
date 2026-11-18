//! DNS-over-HTTPS resolver for the pre-connection phase.
//!
//! Server hostnames and the subscription panel must not be resolved by the
//! system resolver while DNS protection is on. Queries use RFC 8484 wireformat
//! over POST: JSON APIs differ between providers and some reject them.
//! Provider addresses were checked against their documentation and with a real
//! query; the Russian resolver is Yandex's common.dot.dns.yandex.net.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const YANDEX: &str = "https://common.dot.dns.yandex.net/dns-query";
pub const CLOUDFLARE: &str = "https://cloudflare-dns.com/dns-query";
pub const GOOGLE: &str = "https://dns.google/dns-query";
pub const QUAD9: &str = "https://dns.quad9.net/dns-query";

const TIMEOUT: Duration = Duration::from_secs(3);
const MAX_TTL: u64 = 600;

#[derive(Debug, Clone)]
struct Entry {
    ips: Vec<IpAddr>,
    expires: Instant,
    server: String,
}

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Resolution {
    pub ip: Option<String>,
    pub source: String,
    pub server: Option<String>,
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

async fn query(provider: &'static str, name: &str) -> Result<(Vec<IpAddr>, u64), String> {
    let body = build_query(name).ok_or_else(|| "bad name".to_string())?;
    let response = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .post(provider)
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

fn remember(name: &str, ips: &[IpAddr], ttl: u64, server: &str) {
    if let Ok(mut map) = cache().lock() {
        map.insert(name.to_string(), Entry {
            ips: ips.to_vec(),
            expires: Instant::now() + Duration::from_secs(ttl.clamp(1, MAX_TTL)),
            server: server.to_string(),
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

/// DoH first, then a remembered address (even expired), then the system
/// resolver. `source` tells the UI which path was used, so a system fallback
/// is never silent.
pub async fn resolve(name: &str) -> Resolution {
    let name = name.trim().trim_end_matches('.').to_ascii_lowercase();
    if let Ok(ip) = name.parse::<IpAddr>() {
        return Resolution { ip: Some(ip.to_string()), source: "ip".into(), server: None };
    }
    let (first, second) = tokio::join!(query(YANDEX, &name), query(CLOUDFLARE, &name));
    for (provider, result) in [(YANDEX, first), (CLOUDFLARE, second)] {
        if let Ok((ips, ttl)) = result {
            remember(&name, &ips, ttl, provider);
            return Resolution { ip: Some(ips[0].to_string()), source: "doh".into(), server: Some(provider.into()) };
        }
    }
    for provider in [GOOGLE, QUAD9] {
        if let Ok((ips, ttl)) = query(provider, &name).await {
            remember(&name, &ips, ttl, provider);
            return Resolution { ip: Some(ips[0].to_string()), source: "doh".into(), server: Some(provider.into()) };
        }
    }
    if let Some(entry) = cached(&name, true) {
        return Resolution { ip: entry.ips.first().map(|ip| ip.to_string()), source: "cache".into(), server: Some(entry.server) };
    }
    match system_lookup(&name) {
        Some(ip) => Resolution { ip: Some(ip.to_string()), source: "system".into(), server: None },
        None => Resolution { ip: None, source: "failed".into(), server: None },
    }
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
        // header, question example.com A, answer 93.184.216.34 ttl 300
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
        let name = "cache.example";
        remember(name, &["10.0.0.1".parse().unwrap()], 60, CLOUDFLARE);
        let entry = cached(name, false).expect("entry");
        assert_eq!(entry.ips[0].to_string(), "10.0.0.1");
        assert_eq!(entry.server, CLOUDFLARE);
        // An expired entry is still available as a last resort.
        if let Ok(mut map) = cache().lock() {
            map.get_mut(name).unwrap().expires = Instant::now() - Duration::from_secs(1);
        }
        assert!(cached(name, false).is_none());
        assert!(cached(name, true).is_some());
    }
}
