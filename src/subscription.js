import { toXrayOutbound } from './xray-config.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
function decodeBase64(value) {
  const normalized = String(value).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) throw new Error('Некорректный base64');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}
function decoded(value) { try { return decodeURIComponent(value); } catch { throw new Error('Некорректное percent-кодирование'); } }
function cleanName(value, fallback) { const name = String(value || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim(); return name && name.toLowerCase() !== 'undefined' ? name : fallback; }
function locationFor(name, host) {
  const value = `${name} ${host}`.toLowerCase();
  const places = [
    ['🇩🇪', 'Германия', ['герм', 'germany', 'de-', 'de1', 'frankfurt', 'берлин', 'berlin']],
    ['🇳🇱', 'Нидерланды', ['нидер', 'nether', 'nl-', 'nl1', 'amsterdam']],
    ['🇫🇮', 'Финляндия', ['фин', 'finland', 'fi-', 'helsinki']],
    ['🇫🇷', 'Франция', ['франц', 'france', 'fr-', 'paris']],
    ['🇺🇸', 'США', ['сша', 'usa', 'us-', 'new york', 'virginia']],
    ['🇬🇧', 'Великобритания', ['брит', 'uk', 'gb-', 'london']],
    ['🇷🇺', 'Россия', ['росс', 'russia', 'ru-', 'moscow', 'москва']]
  ];
  const match = places.find(([, , aliases]) => aliases.some(alias => value.includes(alias)));
  return match ? { flag: match[0], country: match[1], city: (match[2].find(alias => value.includes(alias)) || host || 'Авто').replace(/[-_]/g, ' ') } : { flag: '🌐', country: 'Сервер', city: host || 'Неизвестно' };
}
function makeNode(name, outbound, index, protocol) {
  name = cleanName(name, `${protocol} ${index + 1}`);
  return { id: `node-${index}-${name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '')}`, name, protocol, ...locationFor(name, outbound.server), ping: null, availability: 'unknown', accent: ['amber', 'violet', 'blue'][index % 3], source: 'subscription', favorite: false, outbound: { ...outbound, tag: `proxy-${index}` } };
}
function parseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Некорректный адрес или порт'); }
  // URLSearchParams otherwise silently replaces malformed escapes and invalid UTF-8.
  for (const part of url.search.slice(1).split('&')) for (const value of part.split('=')) decoded(value.replace(/\+/g, ' '));
  return url;
}
function query(url, allowed) {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!allowed.includes(key)) throw new Error(`Неподдерживаемый параметр: ${/^[\w-]{1,40}$/.test(key) ? key : '(некорректный ключ)'}`);
    if (params.getAll(key).length > 1) throw new Error(`Повторный параметр: ${key}`);
  }
  return params;
}
function get(p, ...keys) {
  const present = keys.filter(key => p.has(key));
  if (present.length > 1 && present.some(key => p.get(key) !== p.get(present[0]))) throw new Error(`Противоречивые параметры: ${keys.join('/')}`);
  return present.length ? p.get(present[0]) : undefined;
}
function bool(value, name) { if (value === undefined || value === '' || value === '0' || value === 'false') return false; if (value === '1' || value === 'true') return true; throw new Error(`Некорректный ${name}`); }
function hostOf(url) { return url.hostname.replace(/^\[|\]$/g, ''); }
function commonTls(url, p, defaultSecurity = 'none') {
  const security = get(p, 'security') || defaultSecurity;
  if (!['none', 'tls', 'reality'].includes(security)) throw new Error('Неподдерживаемый security');
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
    if (sni || fp || pbk || sid || spider || verify || insecure || alpn || pin || ech) throw new Error('TLS-параметры без TLS/REALITY');
    return undefined;
  }
  if (security !== 'reality' && (pbk || sid || spider || verify)) throw new Error('Параметры REALITY без REALITY');
  if (security === 'reality' && (insecure || alpn || pin || ech)) throw new Error('Несовместимые параметры REALITY');
  const tls = { enabled: true, server_name: sni || hostOf(url), ...(fp ? { utls: { enabled: true, fingerprint: fp } } : {}), ...(insecure ? { insecure: true } : {}), ...(alpn ? { alpn: alpn.split(',') } : {}), ...(pin ? { pinned_peer_cert_sha256: pin } : {}), ...(ech ? { ech_config_list: ech } : {}) };
  if (security === 'reality') tls.reality = { enabled: true, public_key: pbk, short_id: sid || '', ...(spider ? { spider_x: spider } : {}), ...(verify ? { mldsa65_verify: verify } : {}) };
  return tls;
}
const TLS_KEYS = ['security', 'sni', 'servername', 'fp', 'fingerprint', 'pbk', 'publicKey', 'sid', 'shortId', 'spx', 'spiderX', 'mldsa65Verify', 'pqv', 'allowInsecure', 'insecure', 'alpn', 'pinSHA256', 'pcs', 'ech'];
const TRANSPORT_KEYS = ['type', 'net', 'headerType', 'path', 'host', 'mode', 'extra', 'serviceName', 'service', 'authority'];
function transport(p) {
  const type = (get(p, 'type', 'net') || 'tcp').toLowerCase();
  const header = get(p, 'headerType');
  if (header && header !== 'none') throw new Error('Неподдерживаемый headerType');
  const path = get(p, 'path'), host = get(p, 'host'), mode = get(p, 'mode'), extra = get(p, 'extra'), service = get(p, 'serviceName', 'service'), authority = get(p, 'authority');
  const reject = condition => { if (condition) throw new Error('Параметры не соответствуют выбранному транспорту'); };
  if (['tcp', 'raw'].includes(type)) { reject(path || host || mode || extra || service || authority); return undefined; }
  if (type === 'xhttp' || type === 'splithttp') {
    reject(service || authority);
    let extras;
    if (extra !== undefined && extra !== '') { try { extras = JSON.parse(extra); } catch { throw new Error('Некорректный JSON в XHTTP extra'); } }
    return { type: 'xhttp', ...(path !== undefined && path !== '' ? { path } : {}), ...(host !== undefined && host !== '' ? { host } : {}), ...(mode !== undefined && mode !== '' ? { mode } : {}), ...(extras !== undefined ? { extra: extras } : {}) };
  }
  if (type === 'ws' || type === 'websocket') { reject(mode || extra || service || authority); return { type: 'ws', path: path || '/', ...(host ? { headers: { Host: host } } : {}) }; }
  if (type === 'grpc') { reject(host || mode || extra || path); return { type: 'grpc', ...(service ? { service_name: service } : {}), ...(authority ? { authority } : {}) }; }
  if (type === 'httpupgrade') { reject(mode || extra || service || authority); return { type, path: path || '/', ...(host ? { host } : {}) }; }
  throw new Error('Неподдерживаемый транспорт');
}
function uriNode(raw, index, protocol) {
  const url = parseUrl(raw);
  const p = query(url, [...TLS_KEYS, ...TRANSPORT_KEYS, ...(protocol === 'vless' ? ['flow', 'encryption', 'packetEncoding'] : [])]);
  if (url.password) throw new Error('Неожиданное поле password в ссылке');
  if (url.pathname && url.pathname !== '/') throw new Error('Неожиданный путь URL');
  const name = cleanName(decoded(url.hash.slice(1)), `${protocol === 'vless' ? 'VLESS' : 'Trojan'} ${index + 1}`);
  const o = { type: protocol, server: hostOf(url), server_port: Number(url.port || 443), tls: commonTls(url, p, protocol === 'trojan' ? 'tls' : 'none'), transport: transport(p) };
  if (protocol === 'vless') { o.uuid = decoded(url.username); o.flow = get(p, 'flow'); o.encryption = get(p, 'encryption') || 'none'; o.packet_encoding = get(p, 'packetEncoding'); }
  else o.password = decoded(url.username);
  return makeNode(name, o, index, protocol === 'vless' ? 'VLESS' : 'Trojan');
}
function parseShadowsocks(raw, index) {
  let payload = raw.slice(5), hash = '';
  const hashAt = payload.indexOf('#');
  if (hashAt >= 0) { hash = payload.slice(hashAt + 1); payload = payload.slice(0, hashAt); }
  if (!payload.includes('@')) payload = decodeBase64(payload);
  const url = parseUrl(`ss://${payload}`);
  query(url, []);
  if (url.pathname && url.pathname !== '/') throw new Error('Неожиданный путь Shadowsocks');
  let credentials;
  if (url.password) credentials = `${decoded(url.username)}:${decoded(url.password)}`;
  else { const user = decoded(url.username); credentials = user.includes(':') ? user : decodeBase64(user); }
  const split = credentials.indexOf(':');
  if (split <= 0 || !credentials.slice(split + 1)) throw new Error('Shadowsocks требует метод и пароль');
  return makeNode(cleanName(decoded(hash), `Shadowsocks ${index + 1}`), { type: 'shadowsocks', server: hostOf(url), server_port: Number(url.port || 443), method: credentials.slice(0, split).toLowerCase(), password: credentials.slice(split + 1) }, index, 'Shadowsocks');
}
function parseVmess(raw, index) {
  let data;
  try { data = JSON.parse(decodeBase64(raw.slice(8))); } catch { throw new Error('Некорректный VMess base64/JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Некорректный VMess JSON');
  const known = ['v', 'ps', 'add', 'address', 'port', 'id', 'aid', 'scy', 'net', 'type', 'host', 'path', 'tls', 'sni', 'alpn', 'fp'];
  for (const key of Object.keys(data)) if (!known.includes(key)) throw new Error(`Неподдерживаемый параметр VMess: ${/^[\w-]{1,40}$/.test(key) ? key : '(некорректный ключ)'}`);
  if (data.type && data.type !== 'none') throw new Error('Неподдерживаемый VMess header type');
  if (data.tls && !['tls', 'none'].includes(data.tls)) throw new Error('Неподдерживаемая безопасность VMess');
  const network = data.net || 'tcp';
  let trans;
  if (network === 'ws') trans = { type: 'ws', path: data.path || '/', ...(data.host ? { headers: { Host: data.host } } : {}) };
  else if (network === 'grpc') trans = { type: 'grpc', service_name: data.path || '' };
  else if (network === 'xhttp' || network === 'splithttp') trans = { type: 'xhttp', ...(data.path ? { path: data.path } : {}), ...(data.host ? { host: data.host } : {}) };
  else if (network !== 'tcp' && network !== 'raw') throw new Error('Неподдерживаемый транспорт VMess');
  else if (data.path || data.host) throw new Error('Параметры VMess не соответствуют TCP');
  const o = { type: 'vmess', server: data.add || data.address, server_port: Number(data.port || 443), uuid: data.id, security: data.scy || 'auto', alter_id: data.aid || 0, ...(data.tls === 'tls' ? { tls: { enabled: true, server_name: data.sni || data.host || data.add || data.address, ...(data.alpn ? { alpn: String(data.alpn).split(',') } : {}), ...(data.fp ? { utls: { enabled: true, fingerprint: data.fp } } : {}) } } : {}), ...(trans ? { transport: trans } : {}) };
  if ((!data.tls || data.tls === 'none') && (data.sni || data.alpn || data.fp)) throw new Error('TLS-параметры VMess без TLS');
  return makeNode(data.ps, o, index, 'VMess');
}
function parseHysteria(raw, index) {
  let url;
  try { url = parseUrl(raw); } catch {
    // In particular, WHATWG URL cannot parse Hysteria's multi-port hopping syntax.
    // Keep the original securely in node storage instead of presenting a fake endpoint.
    const node = makeNode(`Hysteria2 ${index + 1}`, { type: 'hysteria2', server: '', server_port: null }, index, 'Hysteria2');
    node.unsupported = true; node.supported = false;
    node.unsupportedReason = 'Неподдерживаемый или некорректный адрес Hysteria2; проверьте параметры и перевставьте ссылку';
    node.originalUri = raw;
    return node;
  }
  const name = cleanName(decoded(url.hash.slice(1)), `Hysteria2 ${index + 1}`);
  const o = { type: 'hysteria2', server: hostOf(url), server_port: Number(url.port || 443), password: decoded(url.username) + (url.password ? `:${decoded(url.password)}` : ''), tls: { enabled: true, server_name: hostOf(url) } };
  const node = makeNode(name, o, index, 'Hysteria2');
  try {
    const p = query(url, ['sni', 'insecure', 'obfs', 'obfs-password', 'pinSHA256', 'ech']);
    if (url.pathname && url.pathname !== '/') throw new Error('Неподдерживаемый путь Hysteria2');
    o.tls.server_name = get(p, 'sni') || hostOf(url);
    o.tls.insecure = bool(get(p, 'insecure'), 'insecure');
    if (get(p, 'pinSHA256')) o.tls.pinned_peer_cert_sha256 = get(p, 'pinSHA256');
    if (get(p, 'ech')) o.tls.ech_config_list = get(p, 'ech');
    const obfs = get(p, 'obfs'), password = get(p, 'obfs-password');
    if (obfs || password) { if (obfs !== 'salamander' || !password) throw new Error('Неподдерживаемая маскировка Hysteria2'); o.obfs = { type: obfs, password }; }
    node.outbound = { ...o, tag: `proxy-${index}` };
    toXrayOutbound(node);
  } catch (error) {
    node.outbound = { ...o, tag: `proxy-${index}` };
    node.unsupported = true; node.supported = false; node.unsupportedReason = error.message; node.originalUri = raw;
  }
  return node;
}

export function parseUserinfo(value) {
  if (!value) return null;
  const data = {};
  for (const part of String(value).split(';')) {
    const match = /^\s*(upload|download|total|expire)\s*=\s*(\d+)\s*$/.exec(part);
    if (match) { const n = Number(match[2]); if (Number.isSafeInteger(n)) data[match[1]] = n; }
  }
  const total = data.total || 0, used = (data.upload || 0) + (data.download || 0);
  const expires = data.expire ? new Date(data.expire * 1000) : null;
  return { ...data, total, used, expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null };
}
export function parseSubscriptionDetailed(raw) {
  let text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (text.startsWith('{')) {
    try { const payload = JSON.parse(text); const candidate = payload.data || payload.content || payload.subscription || payload.links; if (Array.isArray(candidate)) text = candidate.join('\n'); else if (typeof candidate === 'string') text = candidate.trim(); else return { nodes: [], errors: ['JSON не содержит ссылок подписки'] }; }
    catch { return { nodes: [], errors: ['Некорректный JSON подписки'] }; }
  }
  if (!text.includes('://')) {
    try { text = decodeBase64(decoded(text)); } catch { return { nodes: [], errors: ['Ответ не является ссылками или корректным base64'] }; }
  }
  const lines = text.split(/\r?\n|\s+/).map(line => line.trim()).filter(Boolean), nodes = [], errors = [];
  lines.forEach((line, index) => {
    try {
      const scheme = (line.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [])[1]?.toLowerCase();
      let node;
      if (scheme === 'vless' || scheme === 'trojan') node = uriNode(line, index, scheme);
      else if (scheme === 'vmess') node = parseVmess(line, index);
      else if (scheme === 'ss') node = parseShadowsocks(line, index);
      else if (scheme === 'hysteria2' || scheme === 'hy2') node = parseHysteria(line, index);
      else throw new Error('Неподдерживаемая схема');
      if (!node.unsupported) toXrayOutbound(node);
      nodes.push(node);
      if (node.unsupported) errors.push(`Строка ${index + 1}: узел сохранён как неподдерживаемый: ${node.unsupportedReason}`);
    } catch (error) { errors.push(`Строка ${index + 1}: ${error.message || 'Некорректная конфигурация'}`); }
  });
  return { nodes, errors };
}
export function parseSubscription(raw) { return parseSubscriptionDetailed(raw).nodes; }
