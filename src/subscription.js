const decoder = new TextDecoder();

function decodeBase64(value) {
  const normalized = String(value).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function cleanName(value, fallback) {
  const name = safeDecode(String(value || '')).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  return name && name.toLowerCase() !== 'undefined' ? name : fallback;
}

function fragmentName(url, fallback) {
  return cleanName(url.hash.slice(1), fallback);
}

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
  const match = places.find(([, , aliases]) => aliases.some((alias) => value.includes(alias)));
  if (!match) return { flag: '🌐', country: 'Сервер', city: host || 'Неизвестно' };
  const city = match[2].find((alias) => value.includes(alias)) || host || 'Авто';
  return { flag: match[0], country: match[1], city: city.replace(/[-_]/g, ' ') };
}

function tlsConfig(url) {
  const security = url.searchParams.get('security');
  if (!security || security === 'none') return undefined;
  const tls = { enabled: true };
  tls.server_name = url.searchParams.get('sni') || url.searchParams.get('servername') || url.hostname;
  const fingerprint = url.searchParams.get('fp') || url.searchParams.get('fingerprint');
  if (fingerprint) tls.utls = { enabled: true, fingerprint };
  if (security === 'reality') {
    tls.reality = { enabled: true };
    const publicKey = url.searchParams.get('pbk') || url.searchParams.get('publicKey');
    const shortId = url.searchParams.get('sid') || url.searchParams.get('shortId');
    if (publicKey) tls.reality.public_key = publicKey;
    if (shortId) tls.reality.short_id = shortId;
  }
  if (url.searchParams.get('allowInsecure') === '1' || url.searchParams.get('insecure') === '1') tls.insecure = true;
  return tls;
}

function transportConfig(url) {
  const type = (url.searchParams.get('type') || url.searchParams.get('net') || '').toLowerCase();
  if (!type || type === 'tcp') return undefined;
  if (type === 'ws') {
    const transport = { type: 'ws', path: url.searchParams.get('path') || '/' };
    const host = url.searchParams.get('host');
    if (host) transport.headers = { Host: host };
    return transport;
  }
  if (type === 'grpc') {
    const transport = { type: 'grpc' };
    const serviceName = url.searchParams.get('serviceName') || url.searchParams.get('service');
    if (serviceName) transport.service_name = serviceName;
    return transport;
  }
  if (type === 'http' || type === 'h2' || type === 'xhttp') {
    const transport = { type: 'http', path: url.searchParams.get('path') || '/' };
    const host = url.searchParams.get('host');
    if (host) transport.host = host.split(',');
    return transport;
  }
  return undefined;
}

function parseVless(raw, index) {
  const url = new URL(raw);
  const fallback = `VLESS ${index + 1}`;
  const name = fragmentName(url, fallback);
  const outbound = {
    type: 'vless', tag: name, server: url.hostname, server_port: Number(url.port || 443), uuid: decodeURIComponent(url.username),
    packet_encoding: url.searchParams.get('packetEncoding') || undefined,
    flow: url.searchParams.get('flow') || undefined,
    tls: tlsConfig(url), transport: transportConfig(url)
  };
  return makeNode(name, outbound, index, 'VLESS');
}

function parseTrojan(raw, index) {
  const url = new URL(raw);
  const name = fragmentName(url, `Trojan ${index + 1}`);
  return makeNode(name, { type: 'trojan', tag: name, server: url.hostname, server_port: Number(url.port || 443), password: decodeURIComponent(url.username), tls: tlsConfig(url), transport: transportConfig(url) }, index, 'Trojan');
}

function parseShadowsocks(raw, index) {
  let source = raw;
  const payload = raw.slice('ss://'.length).split('#')[0];
  if (!payload.includes('@')) {
    try {
      const decoded = decodeBase64(payload);
      if (decoded.includes('@')) source = `ss://${decoded}${raw.includes('#') ? `#${raw.split('#').slice(1).join('#')}` : ''}`;
    } catch { /* regular URL parser below */ }
  }
  const url = new URL(source);
  const name = fragmentName(url, `Shadowsocks ${index + 1}`);
  let method = '';
  let password = '';
  if (url.username) {
    const credentials = decodeBase64(url.username).split(':');
    method = credentials.shift() || '';
    password = credentials.join(':');
  }
  return makeNode(name, { type: 'shadowsocks', tag: name, server: url.hostname, server_port: Number(url.port || 443), method: method || 'aes-128-gcm', password: password || decodeURIComponent(url.password || '') }, index, 'Shadowsocks');
}

function parseVmess(raw, index) {
  const data = JSON.parse(decodeBase64(raw.slice('vmess://'.length)));
  const host = data.add || data.address || data.host;
  const name = cleanName(data.ps, `VMess ${index + 1}`);
  if (!host || !data.id) throw new Error('VMess без адреса или UUID');
  const outbound = { type: 'vmess', tag: name, server: host, server_port: Number(data.port || 443), uuid: data.id, security: data.scy || 'auto' };
  if (data.tls && data.tls !== 'none') outbound.tls = { enabled: true, server_name: data.sni || data.host || host };
  if (data.net === 'ws') outbound.transport = { type: 'ws', path: data.path || '/', headers: data.host ? { Host: data.host } : undefined };
  if (data.net === 'grpc') outbound.transport = { type: 'grpc', service_name: data.path || '' };
  return makeNode(name, outbound, index, 'VMess');
}

function parseHysteria2(raw, index) {
  const url = new URL(raw);
  const name = fragmentName(url, `Hysteria2 ${index + 1}`);
  const outbound = { type: 'hysteria2', tag: name, server: url.hostname, server_port: Number(url.port || 443), password: decodeURIComponent(url.username || ''), tls: { enabled: true, server_name: url.searchParams.get('sni') || url.hostname } };
  const obfs = url.searchParams.get('obfs-password');
  if (obfs) outbound.obfs = { type: url.searchParams.get('obfs') || 'salamander', password: obfs };
  return makeNode(name, outbound, index, 'Hysteria2');
}

function makeNode(name, outbound, index, protocol) {
  const safeName = cleanName(name, `${protocol} ${index + 1}`);
  const location = locationFor(safeName, outbound.server);
  return {
    id: `node-${index}-${safeName.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '')}`,
    name: safeName,
    protocol,
    flag: location.flag,
    country: location.country,
    city: location.city,
    ping: null,
    availability: 'unknown',
    accent: ['amber', 'violet', 'blue'][index % 3],
    outbound: { ...outbound, tag: `proxy-${index}` }
  };
}

export function parseUserinfo(value) {
  if (!value) return null;
  const data = {};
  for (const part of String(value).split(';')) {
    const [key, raw] = part.trim().split('=');
    if (key && raw) data[key] = Number(raw);
  }
  const total = data.total || 0;
  const used = (data.upload || 0) + (data.download || 0);
  return { ...data, total, used, expiresAt: data.expire ? new Date(data.expire * 1000) : null };
}

export function parseSubscription(raw) {
  let text = String(raw || '').replace(/^\uFEFF/, '').trim();
  try {
    if (text.startsWith('{')) {
      const payload = JSON.parse(text);
      const candidate = payload.data || payload.content || payload.subscription || payload.links;
      if (Array.isArray(candidate)) text = candidate.join('\n');
      else if (typeof candidate === 'string') text = candidate.trim();
    }
  } catch { /* line parser below */ }
  let decoded = text;
  if (!decoded.includes('://')) {
    try { decoded = decodeBase64(decodeURIComponent(decoded)); } catch { return []; }
  }
  const lines = decoded.split(/\r?\n|\s+/).map((line) => line.trim()).filter(Boolean);
  const nodes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    try {
      if (line.startsWith('vless://')) nodes.push(parseVless(line, index));
      else if (line.startsWith('vmess://')) nodes.push(parseVmess(line, index));
      else if (line.startsWith('trojan://')) nodes.push(parseTrojan(line, index));
      else if (line.startsWith('ss://')) nodes.push(parseShadowsocks(line, index));
      else if (line.startsWith('hysteria2://')) nodes.push(parseHysteria2(line, index));
    } catch { /* skip only malformed node */ }
  }
  return nodes;
}
