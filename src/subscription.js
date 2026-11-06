const decoder = new TextDecoder();

function decodeBase64(value) {
  const normalized = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function fragmentName(url, fallback) {
  return decodeURIComponent(url.hash.slice(1) || fallback).replace(/[\\/:*?"<>|]/g, ' ').trim() || fallback;
}

function tlsConfig(url) {
  const security = url.searchParams.get('security');
  if (!security || security === 'none') return undefined;
  const tls = { enabled: true };
  const serverName = url.searchParams.get('sni') || url.hostname;
  if (serverName) tls.server_name = serverName;
  const fingerprint = url.searchParams.get('fp');
  if (fingerprint) tls.utls = { enabled: true, fingerprint };
  if (security === 'reality') {
    tls.reality = { enabled: true };
    const publicKey = url.searchParams.get('pbk');
    const shortId = url.searchParams.get('sid');
    if (publicKey) tls.reality.public_key = publicKey;
    if (shortId) tls.reality.short_id = shortId;
  }
  return tls;
}

function transportConfig(url) {
  const type = url.searchParams.get('type') || url.searchParams.get('net');
  if (!type || type === 'tcp') return undefined;
  if (type === 'ws') {
    const transport = { type: 'ws' };
    const path = url.searchParams.get('path');
    const host = url.searchParams.get('host');
    if (path) transport.path = path;
    if (host) transport.headers = { Host: host };
    return transport;
  }
  if (type === 'grpc') {
    const transport = { type: 'grpc' };
    const serviceName = url.searchParams.get('serviceName') || url.searchParams.get('service');
    if (serviceName) transport.service_name = serviceName;
    return transport;
  }
  if (type === 'http') return { type: 'http', host: url.searchParams.get('host')?.split(',') || [], path: url.searchParams.get('path') || '/' };
  return undefined;
}

function parseVless(raw, index) {
  const url = new URL(raw);
  const name = fragmentName(url, `VLESS ${index + 1}`);
  const outbound = {
    type: 'vless', tag: name, server: url.hostname, server_port: Number(url.port || 443), uuid: decodeURIComponent(url.username),
    packet_encoding: url.searchParams.get('packetEncoding') || undefined,
    flow: url.searchParams.get('flow') || undefined,
    tls: tlsConfig(url), transport: transportConfig(url)
  };
  return makeNode(name, outbound, index);
}

function parseTrojan(raw, index) {
  const url = new URL(raw);
  const name = fragmentName(url, `Trojan ${index + 1}`);
  return makeNode(name, { type: 'trojan', tag: name, server: url.hostname, server_port: Number(url.port || 443), password: decodeURIComponent(url.username), tls: tlsConfig(url), transport: transportConfig(url) }, index);
}

function parseShadowsocks(raw, index) {
  const url = new URL(raw);
  const name = fragmentName(url, `Shadowsocks ${index + 1}`);
  const credentials = decodeBase64(url.username || '').split(':');
  return makeNode(name, { type: 'shadowsocks', tag: name, server: url.hostname, server_port: Number(url.port || 443), method: credentials[0] || '2022-blake3-aes-128-gcm', password: credentials.slice(1).join(':') || decodeURIComponent(url.password || '') }, index);
}

function parseVmess(raw, index) {
  const payload = decodeBase64(raw.slice('vmess://'.length));
  const data = JSON.parse(payload);
  const name = data.ps || `VMess ${index + 1}`;
  const outbound = { type: 'vmess', tag: name, server: data.add, server_port: Number(data.port || 443), uuid: data.id, security: data.scy || 'auto', alter_id: Number(data.aid || 0) };
  if (data.tls && data.tls !== 'none') outbound.tls = { enabled: true, server_name: data.sni || data.host || data.add };
  if (data.net === 'ws') outbound.transport = { type: 'ws', path: data.path || '/', headers: data.host ? { Host: data.host } : undefined };
  return makeNode(name, outbound, index);
}

function makeNode(name, outbound, index) {
  return { id: `node-${index}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, country: 'Подписка', city: outbound.server, ping: '—', accent: ['amber', 'violet', 'blue'][index % 3], outbound };
}

export function parseSubscription(raw) {
  const text = raw.trim();
  const decoded = text.includes('://') ? text : decodeBase64(text);
  const lines = decoded.split(/\r?\n|\s+/).map((line) => line.trim()).filter(Boolean);
  const nodes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    try {
      if (line.startsWith('vless://')) nodes.push(parseVless(line, index));
      else if (line.startsWith('vmess://')) nodes.push(parseVmess(line, index));
      else if (line.startsWith('trojan://')) nodes.push(parseTrojan(line, index));
      else if (line.startsWith('ss://')) nodes.push(parseShadowsocks(line, index));
    } catch {
      // Ignore malformed lines and continue importing the rest of a subscription.
    }
  }
  return nodes;
}
