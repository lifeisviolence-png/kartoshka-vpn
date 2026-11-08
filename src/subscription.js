import { toXrayOutbound } from './xray-config.js';

// Parsing never throws for a single bad line: the caller decides whether a
// partially readable subscription is still worth importing. Every diagnostic
// carries a code so the UI can show it in the selected language.
export class ParseIssue extends Error {
  constructor(code, params = {}) { super(code); this.code = code; this.params = params; }
}
const issue = (code, params) => { throw new ParseIssue(code, params); };

const decoder = new TextDecoder('utf-8', { fatal: true });
function decodeBase64(value) {
  const normalized = String(value).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) issue('sub.badBase64');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  try { return decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0))); }
  catch { issue('sub.badBase64Utf8'); }
}
function decoded(value) { try { return decodeURIComponent(value); } catch { issue('sub.badPercent'); } }
function cleanName(value, fallback) { const name = String(value || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim(); return name && name.toLowerCase() !== 'undefined' ? name : fallback; }
function locationFor(name) {
  // Provider names and hostnames are not a reliable geolocation service. Only an
  // explicitly supplied country flag is treated as a country, never substrings.
  const places = [
    ['🇩🇪', 'Германия', 'de'], ['🇳🇱', 'Нидерланды', 'nl'], ['🇫🇮', 'Финляндия', 'fi'],
    ['🇫🇷', 'Франция', 'fr'], ['🇺🇸', 'США', 'us'], ['🇬🇧', 'Великобритания', 'gb'],
    ['🇷🇺', 'Россия', 'ru'], ['🇺🇦', 'Украина', 'ua'], ['🇹🇷', 'Турция', 'tr'], ['🇸🇬', 'Сингапур', 'sg'],
    ['🇯🇵', 'Япония', 'jp'], ['🇰🇿', 'Казахстан', 'kz'], ['🇦🇲', 'Армения', 'am'], ['🇬🇪', 'Грузия', 'ge']
  ];
  const matches = places.filter(([flag]) => name.includes(flag));
  return matches.length === 1 ? { flag: matches[0][0], country: matches[0][1], countryCode: matches[0][2], city: '' } : { flag: '🌐', country: '', countryCode: '', city: '' };
}
function makeNode(name, outbound, index, protocol) {
  name = cleanName(name, `${protocol} ${index + 1}`);
  return { id: `node-${index}-${name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '')}`, name, protocol, ...locationFor(name), ping: null, availability: 'unknown', accent: ['amber', 'violet', 'blue'][index % 3], source: 'subscription', favorite: false, outbound: { ...outbound, tag: `proxy-${index}` } };
}
function parseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { issue('sub.badAddress'); }
  // URLSearchParams otherwise silently replaces malformed escapes and invalid UTF-8.
  for (const part of url.search.slice(1).split('&')) for (const value of part.split('=')) decoded(value.replace(/\+/g, ' '));
  return url;
}
// Parameters panels routinely attach that do not change the connection on the
// client side. They are ignored explicitly, not silently, so diagnostics stay honest.
const IGNORED_KEYS = ['ed', 'eh', 'headerType', 'remarks', 'remark'];
// `support-*` flags describe what the client can do (for example
// support-x25519mlkem768); they are not server parameters and are not warnings.
const isClientHint = key => String(key).toLowerCase().startsWith('support-');
function query(url, allowed, warnings = []) {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (params.getAll(key).length > 1 && !IGNORED_KEYS.includes(key)) issue('sub.duplicateParam', { key });
    if (allowed.includes(key) || IGNORED_KEYS.includes(key) || isClientHint(key)) continue;
    warnings.push(new ParseIssue('sub.unknownParam', { key }));
  }
  return params;
}
function get(p, ...keys) {
  const present = keys.filter(key => p.has(key));
  if (present.length > 1 && present.some(key => p.get(key) !== p.get(present[0]))) issue('sub.conflictingParams', { keys: keys.join('/') });
  return present.length ? p.get(present[0]) : undefined;
}
function bool(value, name) { if (value === undefined || value === '' || value === '0' || value === 'false') return false; if (value === '1' || value === 'true') return true; issue('sub.badBoolean', { name }); }
function hostOf(url) { return url.hostname.replace(/^\[|\]$/g, ''); }
function commonTls(url, p, defaultSecurity = 'none') {
  const security = get(p, 'security') || defaultSecurity;
  if (!['none', 'tls', 'reality'].includes(security)) issue('sub.unsupportedSecurity');
  const sni = get(p, 'sni', 'servername');
  const fp = get(p, 'fp', 'fingerprint');
  const pbk = get(p, 'pbk', 'publicKey');
  const sid = get(p, 'sid', 'shortId');
  const spider = get(p, 'spx', 'spiderX');
  const verify = get(p, 'mldsa65Verify', 'pqv');
  const insecure = bool(get(p, 'allowInsecure', 'insecure'), 'allowInsecure');
  const alpn = get(p, 'alpn');
  const pin = get(p, 'pinSHA256', 'pcs');
  const ech = get(p, 'ech');
  if (security === 'none') {
    if (sni || fp || pbk || sid || spider || verify || insecure || alpn || pin || ech) issue('sub.tlsWithoutTls');
    return undefined;
  }
  if (security !== 'reality' && (pbk || sid || spider || verify)) issue('sub.realityWithoutReality');
  if (security === 'reality' && insecure) issue('sub.realityInsecure');
  const tls = { enabled: true, server_name: sni || hostOf(url), ...(fp ? { utls: { enabled: true, fingerprint: fp } } : {}), ...(alpn ? { alpn: alpn.split(',') } : {}), ...(pin ? { pinned_peer_cert_sha256: pin } : {}), ...(ech ? { ech_config_list: ech } : {}) };
  // Xray 26 removed allowInsecure. Keep the intent and let the client pin the
  // certificate it actually receives (trust on first use) before connecting.
  if (insecure) tls.trust_on_first_use = true;
  if (security === 'reality') tls.reality = { enabled: true, public_key: pbk, short_id: sid || '', ...(spider ? { spider_x: spider } : {}), ...(verify ? { mldsa65_verify: verify } : {}) };
  return tls;
}
const TLS_KEYS = ['security', 'sni', 'servername', 'fp', 'fingerprint', 'pbk', 'publicKey', 'sid', 'shortId', 'spx', 'spiderX', 'mldsa65Verify', 'pqv', 'allowInsecure', 'insecure', 'alpn', 'pinSHA256', 'pcs', 'ech'];
const TRANSPORT_KEYS = ['type', 'net', 'headerType', 'path', 'host', 'mode', 'extra', 'serviceName', 'service', 'authority'];
function transport(p) {
  const type = (get(p, 'type', 'net') || 'tcp').toLowerCase();
  const header = get(p, 'headerType');
  if (header && header !== 'none') issue('sub.unsupportedHeaderType');
  const path = get(p, 'path'), host = get(p, 'host'), mode = get(p, 'mode'), extra = get(p, 'extra'), service = get(p, 'serviceName', 'service'), authority = get(p, 'authority');
  const allow = condition => { if (!condition) issue('sub.transportMismatch'); };
  if (['tcp', 'raw'].includes(type)) { allow(!(path || host || mode || extra || service || authority)); return undefined; }
  if (type === 'xhttp' || type === 'splithttp') {
    allow(!(service || authority));
    let extras;
    if (extra !== undefined && extra !== '') { try { extras = JSON.parse(extra); } catch { issue('sub.badXhttpExtra'); } }
    return { type: 'xhttp', ...(path !== undefined && path !== '' ? { path } : {}), ...(host !== undefined && host !== '' ? { host } : {}), ...(mode !== undefined && mode !== '' ? { mode } : {}), ...(extras !== undefined ? { extra: extras } : {}) };
  }
  if (type === 'ws' || type === 'websocket') { allow(!(extra || service || authority)); return { type: 'ws', path: path || '/', ...(host ? { headers: { Host: host } } : {}) }; }
  if (type === 'grpc') {
    // mode=gun/multi is what 3x-ui still emits; standard gRPC is "gun",
    // multiMode is the only variant Xray distinguishes.
    allow(!(host || extra || path));
    if (mode && !['gun', 'multi'].includes(String(mode).toLowerCase())) issue('sub.badGrpcMode');
    return { type: 'grpc', ...(service ? { service_name: service } : {}), ...(authority ? { authority } : {}), ...(String(mode || '').toLowerCase() === 'multi' ? { multi_mode: true } : {}) };
  }
  if (type === 'httpupgrade') { allow(!(mode || extra || service || authority)); return { type, path: path || '/', ...(host ? { host } : {}) }; }
  issue('sub.unsupportedTransport');
}
function uriNode(raw, index, protocol, warnings) {
  const url = parseUrl(raw);
  const p = query(url, [...TLS_KEYS, ...TRANSPORT_KEYS, ...(protocol === 'vless' ? ['flow', 'encryption', 'packetEncoding'] : [])], warnings);
  if (url.password) issue('sub.unexpectedPassword');
  if (url.pathname && url.pathname !== '/') issue('sub.unexpectedPath');
  const name = cleanName(decoded(url.hash.slice(1)), `${protocol === 'vless' ? 'VLESS' : 'Trojan'} ${index + 1}`);
  const o = { type: protocol, server: hostOf(url), server_port: Number(url.port || 443), tls: commonTls(url, p, protocol === 'trojan' ? 'tls' : 'none'), transport: transport(p) };
  if (protocol === 'vless') { o.uuid = decoded(url.username); o.flow = get(p, 'flow'); o.encryption = get(p, 'encryption') || 'none'; o.packet_encoding = get(p, 'packetEncoding'); }
  else o.password = decoded(url.username);
  return makeNode(name, o, index, protocol === 'vless' ? 'VLESS' : 'Trojan');
}
function parseShadowsocks(raw, index) {
  let payload = raw.slice(raw.indexOf('://') + 3), hash = '';
  const hashAt = payload.indexOf('#');
  if (hashAt >= 0) { hash = payload.slice(hashAt + 1); payload = payload.slice(0, hashAt); }
  if (!payload.includes('@')) payload = decodeBase64(payload);
  const url = parseUrl(`ss://${payload}`);
  query(url, []);
  if (url.pathname && url.pathname !== '/') issue('sub.unexpectedPath');
  let credentials;
  if (url.password) credentials = `${decoded(url.username)}:${decoded(url.password)}`;
  else { const user = decoded(url.username); credentials = user.includes(':') ? user : decodeBase64(user); }
  const split = credentials.indexOf(':');
  if (split <= 0 || !credentials.slice(split + 1)) issue('sub.ssCredentials');
  return makeNode(cleanName(decoded(hash), `Shadowsocks ${index + 1}`), { type: 'shadowsocks', server: hostOf(url), server_port: Number(url.port || 443), method: credentials.slice(0, split).toLowerCase(), password: credentials.slice(split + 1) }, index, 'Shadowsocks');
}
function parseVmess(raw, index) {
  let data;
  try { data = JSON.parse(decodeBase64(raw.slice(8))); } catch { issue('sub.vmessJson'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) issue('sub.vmessJson');
  const known = ['v', 'ps', 'add', 'address', 'port', 'id', 'aid', 'scy', 'net', 'type', 'host', 'path', 'tls', 'sni', 'alpn', 'fp'];
  for (const key of Object.keys(data)) if (!known.includes(key)) issue('sub.vmessField', { key });
  if (data.type && data.type !== 'none') issue('sub.unsupportedHeaderType');
  if (data.tls && !['tls', 'none'].includes(data.tls)) issue('sub.unsupportedSecurity');
  const network = data.net || 'tcp';
  let trans;
  if (network === 'ws') trans = { type: 'ws', path: data.path || '/', ...(data.host ? { headers: { Host: data.host } } : {}) };
  else if (network === 'grpc') trans = { type: 'grpc', service_name: data.path || '' };
  else if (network === 'xhttp' || network === 'splithttp') trans = { type: 'xhttp', ...(data.path ? { path: data.path } : {}), ...(data.host ? { host: data.host } : {}) };
  else if (network !== 'tcp' && network !== 'raw') issue('sub.unsupportedTransport');
  else if (data.path || data.host) issue('sub.transportMismatch');
  const o = { type: 'vmess', server: data.add || data.address, server_port: Number(data.port || 443), uuid: data.id, security: data.scy || 'auto', alter_id: data.aid || 0, ...(data.tls === 'tls' ? { tls: { enabled: true, server_name: data.sni || data.host || data.add || data.address, ...(data.alpn ? { alpn: String(data.alpn).split(',') } : {}), ...(data.fp ? { utls: { enabled: true, fingerprint: data.fp } } : {}) } } : {}), ...(trans ? { transport: trans } : {}) };
  if ((!data.tls || data.tls === 'none') && (data.sni || data.alpn || data.fp)) issue('sub.tlsWithoutTls');
  return makeNode(data.ps, o, index, 'VMess');
}
function parseHysteria(raw, index) {
  let url;
  try { url = parseUrl(raw); } catch {
    // In particular, WHATWG URL cannot parse Hysteria's multi-port hopping syntax.
    // Keep the original securely in node storage instead of presenting a fake endpoint.
    const node = makeNode(`Hysteria2 ${index + 1}`, { type: 'hysteria2', server: '', server_port: null }, index, 'Hysteria2');
    node.unsupported = true; node.supported = false;
    node.code = 'sub.hy2PortHopping';
    node.unsupportedReason = 'sub.hy2PortHopping';
    node.originalUri = raw;
    return node;
  }
  const name = cleanName(decoded(url.hash.slice(1)), `Hysteria2 ${index + 1}`);
  const o = { type: 'hysteria2', server: hostOf(url), server_port: Number(url.port || 443), password: decoded(url.username) + (url.password ? `:${decoded(url.password)}` : ''), tls: { enabled: true, server_name: hostOf(url) } };
  const node = makeNode(name, o, index, 'Hysteria2');
  try {
    const p = query(url, ['sni', 'insecure', 'obfs', 'obfs-password', 'pinSHA256', 'ech']);
    if (url.pathname && url.pathname !== '/') issue('sub.unexpectedPath');
    o.tls.server_name = get(p, 'sni') || hostOf(url);
    if (bool(get(p, 'insecure'), 'insecure')) o.tls.trust_on_first_use = true;
    if (get(p, 'pinSHA256')) o.tls.pinned_peer_cert_sha256 = get(p, 'pinSHA256');
    if (get(p, 'ech')) o.tls.ech_config_list = get(p, 'ech');
    const obfs = get(p, 'obfs'), password = get(p, 'obfs-password');
    if (obfs || password) { if (obfs !== 'salamander' || !password) issue('sub.hy2Obfs'); o.obfs = { type: obfs, password }; }
    node.outbound = { ...o, tag: `proxy-${index}` };
    try { toXrayOutbound(node); }
    catch (error) { if (error?.code === 'config.needsCertificatePin') node.needsPin = true; else throw error; }
  } catch (error) {
    node.outbound = { ...o, tag: `proxy-${index}` };
    node.unsupported = true; node.supported = false;
    node.code = error.code || 'sub.nodeUnsupported';
    node.unsupportedReason = node.code;
    node.originalUri = raw;
  }
  return node;
}

export function parseUserinfo(value) {
  if (!value) return null;
  const data = {}, seen = new Set();
  for (const part of String(value).split(';')) {
    const match = /^\s*(upload|download|total|expire)\s*=\s*(.*?)\s*$/i.exec(part);
    if (!match) continue;
    const key = match[1].toLowerCase(), n = Number(match[2]);
    if (seen.has(key)) { delete data[key]; continue; }
    seen.add(key);
    if (/^\d+$/.test(match[2]) && Number.isSafeInteger(n)) data[key] = n;
  }
  const sum = data.upload !== undefined && data.download !== undefined ? data.upload + data.download : null;
  const used = Number.isSafeInteger(sum) ? sum : null;
  const expires = data.expire > 0 ? new Date(data.expire * 1000) : null;
  return { ...data, total: data.total ?? null, used, expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null };
}

const SCHEMES = /(vless|vmess|trojan|ss|hysteria2|hy2):\/\//i;
// A link ends only at a newline: server names routinely contain spaces and
// even "|", so splitting on whitespace used to shred every title into pieces.
function splitLinks(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const starts = [...trimmed.matchAll(new RegExp(SCHEMES.source, 'gi'))].map(match => match.index);
    if (starts.length <= 1) { out.push(trimmed); continue; }
    // Some panels emit several links on one line; cut before every scheme, but
    // keep everything up to the next scheme as the previous link's fragment.
    starts.forEach((start, i) => {
      const part = trimmed.slice(start, i + 1 < starts.length ? starts[i + 1] : undefined).trim();
      if (part) out.push(part);
    });
  }
  return out;
}

// Xray JSON profiles (Happ Plus, Hiddify, panels) can carry both servers and
// routing rules. Only rules this build can express are applied; every other
// rule is reported by number and field, because silently dropping a rule sends
// traffic through the wrong outbound.
const ROUTE_TARGETS = { direct: 'direct', block: 'block', proxy: 'proxy' };
const ROUTE_FIELDS = new Set(['type', 'outboundTag', 'outbound_tag', 'domain', 'ip', 'port', 'network', 'source', 'domainStrategy', 'domainMatcher', 'ruleTag']);
function routeList(value) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []; }
function validPortSpec(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text === '' || /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(text);
}
export function parseRoutingProfile(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const rules = payload.routing?.rules;
  if (!Array.isArray(rules)) return null;
  const clean = [], unsupported = [];
  rules.forEach((rule, index) => {
    const number = index + 1;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) { unsupported.push({ index: number, reason: 'shape' }); return; }
    const unknown = Object.keys(rule).filter((key) => !ROUTE_FIELDS.has(key));
    if (unknown.length) { unsupported.push({ index: number, reason: 'fields', fields: unknown }); return; }
    if (rule.type !== undefined && String(rule.type) !== 'field') { unsupported.push({ index: number, reason: 'type', fields: [String(rule.type)] }); return; }
    const rawTarget = String(rule.outboundTag || rule.outbound_tag || '');
    const target = ROUTE_TARGETS[rawTarget];
    if (!target) { unsupported.push({ index: number, reason: 'target', target: rawTarget }); return; }
    const domains = routeList(rule.domain);
    if (domains.some((item) => item.startsWith('ext:'))) { unsupported.push({ index: number, reason: 'extDomain' }); return; }
    const ips = routeList(rule.ip), sources = routeList(rule.source);
    const ports = rule.port === undefined || rule.port === null ? '' : String(rule.port);
    if (!validPortSpec(ports)) { unsupported.push({ index: number, reason: 'port' }); return; }
    const network = rule.network === undefined ? '' : String(rule.network).toLowerCase();
    if (network && !['tcp', 'udp', 'tcp,udp'].includes(network)) { unsupported.push({ index: number, reason: 'network' }); return; }
    if (!domains.length && !ips.length && !sources.length && !ports) { unsupported.push({ index: number, reason: 'empty' }); return; }
    clean.push({
      target, domains, ips,
      ...(sources.length ? { sources } : {}),
      ...(ports ? { ports } : {}),
      ...(network ? { network } : {}),
      ...(rule.domainStrategy ? { domainStrategy: String(rule.domainStrategy) } : {}),
      ...(rule.domainMatcher ? { domainMatcher: String(rule.domainMatcher) } : {})
    });
  });
  // A global domainStrategy changes how *other* rules resolve domains; without
  // the full profile semantics it is safer to ignore it and say so.
  const globalStrategy = payload.routing?.domainStrategy ? String(payload.routing.domainStrategy) : '';
  if (globalStrategy) unsupported.push({ index: 0, reason: 'globalStrategy', target: globalStrategy });
  // `dns` from a profile is never applied: the tunnel has no DNS interception.
  return { rules: clean, unsupported, dns: payload.dns ?? null, dnsApplied: false, total: rules.length, source: payload.source || null, globalStrategy: globalStrategy || null };
}

function fromJsonProfile(text) {
  let payload;
  try { payload = JSON.parse(text); } catch { return null; }
  const candidate = payload.data || payload.content || payload.subscription || payload.links;
  if (Array.isArray(candidate) && candidate.every(item => typeof item === 'string')) return { links: candidate.join('\n'), routing: parseRoutingProfile(payload) };
  if (typeof candidate === 'string' && SCHEMES.test(candidate)) return { links: candidate, routing: parseRoutingProfile(payload) };
  const outbounds = payload.outbounds;
  if (Array.isArray(outbounds)) {
    const links = [];
    for (const outbound of outbounds) {
      const protocol = String(outbound?.protocol || '').toLowerCase();
      if (!['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria'].includes(protocol)) continue;
      const built = outboundToLink(outbound);
      if (built) links.push(built);
    }
    return { links: links.join('\n'), routing: parseRoutingProfile(payload), format: 'xray-json' };
  }
  return null;
}

// Converts a JSON outbound back into the normalized node the app stores. Done
// directly instead of through a URI so REALITY/XHTTP fields survive intact.
function outboundToLink(outbound) {
  const settings = outbound.settings || {};
  const stream = outbound.streamSettings || {};
  const vnext = settings.vnext?.[0] || settings.servers?.[0] || {};
  const address = vnext.address || settings.address, port = vnext.port || settings.port;
  if (!address || !port) return null;
  const network = stream.network || 'tcp';
  const tls = stream.security === 'tls' || stream.security === 'reality' ? {
    enabled: true,
    server_name: stream.tlsSettings?.serverName || stream.realitySettings?.serverName,
    ...(stream.tlsSettings?.fingerprint || stream.realitySettings?.fingerprint ? { utls: { enabled: true, fingerprint: stream.tlsSettings?.fingerprint || stream.realitySettings?.fingerprint } } : {}),
    ...(stream.tlsSettings?.alpn ? { alpn: stream.tlsSettings.alpn } : {}),
    ...(stream.tlsSettings?.pinnedPeerCertSha256 ? { pinned_peer_cert_sha256: stream.tlsSettings.pinnedPeerCertSha256 } : {}),
    ...(stream.security === 'reality' ? { reality: { enabled: true, public_key: stream.realitySettings?.password, short_id: stream.realitySettings?.shortId || '', ...(stream.realitySettings?.spiderX ? { spider_x: stream.realitySettings.spiderX } : {}) } } : {})
  } : undefined;
  let transport;
  if (network === 'ws') transport = { type: 'ws', path: stream.wsSettings?.path || '/', ...(stream.wsSettings?.headers ? { headers: stream.wsSettings.headers } : {}) };
  else if (network === 'grpc') transport = { type: 'grpc', service_name: stream.grpcSettings?.serviceName || '', ...(stream.grpcSettings?.authority ? { authority: stream.grpcSettings.authority } : {}), ...(stream.grpcSettings?.multiMode ? { multi_mode: true } : {}) };
  else if (network === 'xhttp') transport = { type: 'xhttp', ...(stream.xhttpSettings?.path ? { path: stream.xhttpSettings.path } : {}), ...(stream.xhttpSettings?.host ? { host: stream.xhttpSettings.host } : {}), ...(stream.xhttpSettings?.mode ? { mode: stream.xhttpSettings.mode } : {}), ...(stream.xhttpSettings?.extra ? { extra: stream.xhttpSettings.extra } : {}) };
  else if (network === 'httpupgrade') transport = { type: 'httpupgrade', ...(stream.httpupgradeSettings?.path ? { path: stream.httpupgradeSettings.path } : {}), ...(stream.httpupgradeSettings?.host ? { host: stream.httpupgradeSettings.host } : {}) };
  const o = { type: outbound.protocol === 'hysteria' ? 'hysteria2' : outbound.protocol, server: address, server_port: Number(port), tls, transport };
  if (outbound.protocol === 'vless') Object.assign(o, { uuid: vnext.id, flow: vnext.flow, encryption: 'none' });
  else if (outbound.protocol === 'vmess') Object.assign(o, { uuid: vnext.id, security: vnext.security || 'auto', alter_id: vnext.alterId || 0 });
  else if (outbound.protocol === 'trojan') o.password = settings.password;
  else if (outbound.protocol === 'shadowsocks') Object.assign(o, { method: settings.method, password: settings.password });
  else if (outbound.protocol === 'hysteria') o.password = settings.auth;
  const tag = String(outbound.tag || '').replace(/^(proxy|out)-?/, '');
  return { name: tag, outbound: o };
}

export function parseSubscriptionDetailed(raw) {
  const result = { nodes: [], errors: [], warnings: [], routing: null, format: 'links' };
  let text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!text) { result.errors.push({ key: 'sub.empty' }); return result; }
  if (text.startsWith('happ://')) {
    const link = parseHappRouting(text);
    if (link) { result.routing = link; result.format = 'happ-routing'; }
    else result.errors.push({ key: 'sub.badHappRouting' });
    return result;
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    const profile = fromJsonProfile(text);
    if (!profile) { result.errors.push({ key: 'sub.jsonNoLinks' }); return result; }
    text = profile.links;
    result.routing = profile.routing;
    result.format = profile.format || 'json';
  }
  if (!SCHEMES.test(text)) {
    try { text = decodeBase64(decoded(text)); }
    catch { result.errors.push({ key: 'sub.notLinks' }); return result; }
    if (!SCHEMES.test(text)) {
      result.errors.push({ key: /^\s*proxies\s*:/m.test(text) ? 'sub.clashYaml' : 'sub.notLinks' });
      return result;
    }
    result.format = 'base64';
  }
  const lines = splitLinks(text);
  lines.forEach((line, index) => {
    const warnings = [];
    try {
      const scheme = (line.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [])[1]?.toLowerCase();
      let node;
      if (scheme === 'vless' || scheme === 'trojan') node = uriNode(line, index, scheme, warnings);
      else if (scheme === 'vmess') node = parseVmess(line, index, warnings);
      else if (scheme === 'ss' || scheme === 'shadowsocks') node = parseShadowsocks(line, index, warnings);
      else if (scheme === 'hysteria2' || scheme === 'hy2') node = parseHysteria(line, index);
      else issue('sub.unsupportedScheme', { scheme: scheme || '' });
      if (!node.unsupported) {
        try { toXrayOutbound(node); }
        catch (error) {
          // Xray 26 removed allowInsecure. Such nodes stay usable: the client
          // pins the certificate on first connect instead of rejecting them.
          if (error?.code === 'config.needsCertificatePin') node.needsPin = true;
          else throw error;
        }
      }
      result.nodes.push(node);
      if (node.unsupported) result.warnings.push({ line: index + 1, key: node.code || 'sub.nodeUnsupported', params: { name: node.name } });
      for (const warning of warnings) result.warnings.push({ line: index + 1, key: warning.code, params: warning.params });
    } catch (error) {
      const code = error?.code || 'sub.nodeUnsupported';
      const params = { ...(error?.params || {}), ...(code === 'sub.unknownParam' ? {} : {}) };
      if (code === 'sub.unknownParam') { result.warnings.push({ line: index + 1, key: code, params }); }
      else result.errors.push({ line: index + 1, key: code, params });
    }
  });
  return result;
}
export function parseSubscription(raw) { return parseSubscriptionDetailed(raw).nodes; }

// Happ routing profiles: happ://routing/onadd/<base64 json> carries Xray rules.
export function parseHappRouting(raw) {
  const match = /^happ:\/\/routing\/(?:onadd|add)\/(.+)$/i.exec(String(raw).trim());
  if (!match) return null;
  try {
    const payload = JSON.parse(decodeBase64(decodeURIComponent(match[1])));
    const rules = parseRoutingProfile(payload);
    if (!rules) return null;
    return { ...rules, source: 'happ' };
  } catch { return null; }
}
