// Xray-core v26.10.31, proxy-only. Node.outbound remains in the app's legacy shape.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINTS = new Set(['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized', 'unsafe']);
const SS_METHODS = new Set(['aes-128-gcm', 'aes-256-gcm', 'chacha20-poly1305', 'chacha20-ietf-poly1305', 'xchacha20-poly1305', 'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305']);
const EXTRA_KEYS = new Set(['headers', 'xPaddingBytes', 'xPaddingObfsMode', 'xPaddingKey', 'xPaddingHeader', 'xPaddingPlacement', 'xPaddingMethod', 'uplinkHTTPMethod', 'sessionIDPlacement', 'sessionIDKey', 'sessionIDTable', 'sessionIDLength', 'seqPlacement', 'seqKey', 'uplinkDataPlacement', 'uplinkDataKey', 'uplinkChunkSize', 'noGRPCHeader', 'noSSEHeader', 'scMaxEachPostBytes', 'scMinPostsIntervalMs', 'scMaxBufferedPosts', 'scStreamUpServerSecs', 'serverMaxHeaderBytes', 'xmux', 'downloadSettings', 'h2Params']);
function fail(message) { const error = new Error(message); error.code = 'config.error'; error.message = message; throw error; }
function failCode(code, params = {}) { const error = new Error(code); error.code = code; error.params = params; throw error; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function string(value, message) { if (typeof value !== 'string' || !value.trim()) fail(message); return value; }
function cleanHost(host) { return typeof host === 'string' && host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host; }
function checkPort(port) { if (!Number.isInteger(port) || port < 1 || port > 65535) failCode('config.badPort'); }
function checkId(value) { if (typeof value !== 'string' || !UUID.test(value)) failCode('config.badUuid'); }
function checkExtra(value) {
  if (!object(value)) fail('XHTTP extra должен быть JSON-объектом');
  for (const key of Object.keys(value)) if (!EXTRA_KEYS.has(key)) failCode('config.xhttpExtra', { key });
  if (value.headers !== undefined && (!object(value.headers) || Object.entries(value.headers).some(([k,v]) => k.toLowerCase() === 'host' || typeof v !== 'string'))) failCode('config.xhttpHeaders');
  if (value.xmux !== undefined) {
    if (!object(value.xmux)) failCode('config.xhttpXmux');
    const allowed = ['maxConcurrency', 'maxConnections', 'cMaxReuseTimes', 'hMaxRequestTimes', 'hMaxReusableSecs', 'hKeepAlivePeriod'];
    for (const [key, item] of Object.entries(value.xmux)) {
      if (!allowed.includes(key) || !((Number.isInteger(item) && item >= 0) || (typeof item === 'string' && /^\d+(?:-\d+)?$/.test(item)))) failCode('config.xhttpXmux');
    }
  }
  // A separate download stream contains another full Xray configuration; refuse it
  // rather than silently accepting unknown or incompatible nested parameters.
  if (value.downloadSettings !== undefined) failCode('config.xhttpDownload');
  if (value.h2Params !== undefined) failCode('config.xhttpH2');
  for (const key of ['xPaddingObfsMode', 'noGRPCHeader', 'noSSEHeader']) if (value[key] !== undefined && typeof value[key] !== 'boolean') failCode('config.xhttpExtra', { key });
  for (const key of ['xPaddingKey', 'xPaddingHeader', 'xPaddingPlacement', 'xPaddingMethod', 'uplinkHTTPMethod', 'sessionIDPlacement', 'sessionIDKey', 'sessionIDTable', 'seqPlacement', 'seqKey', 'uplinkDataPlacement', 'uplinkDataKey']) if (value[key] !== undefined && typeof value[key] !== 'string') failCode('config.xhttpExtra', { key });
  for (const key of ['xPaddingBytes', 'sessionIDLength', 'uplinkChunkSize', 'scMaxEachPostBytes', 'scMinPostsIntervalMs', 'scStreamUpServerSecs']) {
    const item = value[key];
    if (item !== undefined && !(Number.isInteger(item) || (typeof item === 'string' && /^-?\d+(?:-\d+)?$/.test(item)))) failCode('config.xhttpExtra', { key });
  }
  for (const key of ['scMaxBufferedPosts', 'serverMaxHeaderBytes']) if (value[key] !== undefined && !Number.isInteger(value[key])) failCode('config.xhttpExtra', { key });
}
// Providers export either colon-separated hex (Chrome style) or bare 64 hex.
const PIN = /^(?:(?:[0-9a-f]{2}:){31}[0-9a-f]{2}|[0-9a-f]{64})$/i;
function streamFor(outbound) {
  const t = outbound.transport;
  if (t !== undefined && t !== null && !object(t)) failCode('config.transport');
  const type = t?.type || 'tcp';
  if (type === 'http' || type === 'h2') failCode('config.legacyTransport');
  if (!['tcp', 'raw', 'ws', 'websocket', 'grpc', 'xhttp', 'httpupgrade'].includes(type)) failCode('config.transport');
  const keysByType = { tcp:['type'], raw:['type'], ws:['type','path','headers'], websocket:['type','path','headers'], grpc:['type','service_name','authority','multi_mode'], xhttp:['type','host','path','mode','extra'], httpupgrade:['type','host','path'] };
  if (t && Object.keys(t).some(key => !keysByType[type].includes(key))) failCode('config.transportParams');
  const network = ({ tcp: 'raw', raw: 'raw', ws: 'ws', websocket: 'ws', grpc: 'grpc', xhttp: 'xhttp', httpupgrade: 'httpupgrade' })[type];
  const stream = { network };
  if (network === 'xhttp') {
    // 3x-ui, Marzban and Happ put the XHTTP mode inside `extra`, while Xray
    // expects it next to host/path. Lift it out instead of rejecting the node.
    const extra = t.extra === undefined ? undefined : { ...t.extra };
    const extraMode = extra && extra.mode !== undefined ? String(extra.mode) : undefined;
    if (extra) delete extra.mode;
    const mode = t.mode !== undefined ? t.mode : extraMode;
    if (mode !== undefined && !['auto', 'packet-up', 'stream-up', 'stream-one'].includes(mode)) failCode('config.xhttpMode');
    if (t.path !== undefined && (typeof t.path !== 'string' || !t.path.startsWith('/'))) failCode('config.xhttpPath');
    if (t.host !== undefined && typeof t.host !== 'string') failCode('config.xhttpHost');
    stream.xhttpSettings = { ...(t.host !== undefined ? { host: t.host } : {}), ...(t.path !== undefined ? { path: t.path } : {}), ...(mode !== undefined ? { mode } : {}) };
    if (extra !== undefined && Object.keys(extra).length) { checkExtra(extra); stream.xhttpSettings.extra = extra; }
  } else if (network === 'ws') {
    if (t.path !== undefined && (typeof t.path !== 'string' || !t.path.startsWith('/'))) failCode('config.wsPath');
    if (t.headers !== undefined && (!object(t.headers) || Object.values(t.headers).some(v => typeof v !== 'string'))) failCode('config.wsHeaders');
    stream.wsSettings = { path: t.path || '/', ...(t.headers ? { headers: t.headers } : {}) };
  } else if (network === 'grpc') {
    if (t.service_name !== undefined && typeof t.service_name !== 'string') failCode('config.grpcService');
    if (t.authority !== undefined && typeof t.authority !== 'string') failCode('config.grpcAuthority');
    if (t.multi_mode !== undefined && typeof t.multi_mode !== 'boolean') failCode('config.grpcMode');
    stream.grpcSettings = { serviceName: t.service_name || '', ...(t.authority ? { authority: t.authority } : {}), ...(t.multi_mode !== undefined ? { multiMode: t.multi_mode } : {}) };
  } else if (network === 'httpupgrade') {
    if (t.path !== undefined && (typeof t.path !== 'string' || !t.path.startsWith('/'))) failCode('config.httpupgradePath');
    if (t.host !== undefined && typeof t.host !== 'string') failCode('config.httpupgradeHost');
    stream.httpupgradeSettings = { path: t.path || '/', ...(t.host ? { host: t.host } : {}) };
  }
  const tls = outbound.tls;
  if (tls !== undefined && tls !== null && !object(tls)) failCode('config.tls');
  if (tls && tls.enabled !== false) {
    const tlsKeys = ['enabled', 'server_name', 'utls', 'reality', 'insecure', 'trust_on_first_use', 'alpn', 'pinned_peer_cert_sha256', 'ech_config_list'];
    if (Object.keys(tls).some(key => !tlsKeys.includes(key))) failCode('config.tlsParams');
    if (tls.utls && (!object(tls.utls) || Object.keys(tls.utls).some(key => !['enabled','fingerprint'].includes(key)))) failCode('config.utls');
    if (tls.reality && (!object(tls.reality) || Object.keys(tls.reality).some(key => !['enabled','public_key','short_id','spider_x','mldsa65_verify'].includes(key)))) failCode('config.realityParams');
    const pin = tls.pinned_peer_cert_sha256;
    if (pin !== undefined && (typeof pin !== 'string' || !PIN.test(pin))) failCode('config.badPin');
    // Xray 26 removed allowInsecure. The node is still usable: the client pins
    // the certificate it saw on the first successful handshake (TOFU).
    if (!pin && (tls.insecure || tls.trust_on_first_use)) failCode('config.needsCertificatePin');
    const fp = tls.utls?.fingerprint;
    if (fp && !FINGERPRINTS.has(fp)) failCode('config.fingerprint');
    if (tls.reality?.enabled) {
      if (!['raw', 'xhttp', 'grpc'].includes(network)) failCode('config.realityTransport');
      if (fp === 'unsafe') failCode('config.realityFingerprint');
      const key = string(tls.reality.public_key, 'Для REALITY необходим public key');
      if (!/^[A-Za-z0-9_-]{43}$/.test(key)) failCode('config.realityKey');
      const sid = tls.reality.short_id || '';
      if (!/^(?:[0-9a-f]{2}){0,8}$/i.test(sid)) failCode('config.realityShortId');
      stream.security = 'reality';
      stream.realitySettings = { serverName: string(tls.server_name, 'Для REALITY необходим SNI'), fingerprint: fp || 'chrome', password: key, shortId: sid, ...(tls.reality.spider_x ? { spiderX: tls.reality.spider_x } : {}), ...(tls.reality.mldsa65_verify ? { mldsa65Verify: tls.reality.mldsa65_verify } : {}) };
    } else {
      stream.security = 'tls';
      stream.tlsSettings = { ...(tls.server_name ? { serverName: tls.server_name } : {}), ...(fp ? { fingerprint: fp } : {}), ...(tls.alpn ? { alpn: tls.alpn } : {}), ...(pin ? { pinnedPeerCertSha256: pin } : {}), ...(tls.ech_config_list ? { echConfigList: tls.ech_config_list } : {}) };
      if (tls.alpn && (!Array.isArray(tls.alpn) || tls.alpn.some(v => typeof v !== 'string' || !v))) failCode('config.alpn');
    }
  } else stream.security = 'none';
  return stream;
}

// Also used at import time, so malformed links do not become apparently usable nodes.
export function toXrayOutbound(node) {
  if (!object(node) || !object(node.outbound)) failCode('config.noOutbound');
  if (node.unsupported || node.supported === false) failCode(node.code || 'config.unsupportedNode', { name: node.name });
  const o = node.outbound;
  const protocol = String(o.type || '').toLowerCase();
  if (!['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2'].includes(protocol)) failCode('config.protocol');
  const common = ['type','tag','server','server_port','tls','transport'];
  const specific = { vless:['uuid','flow','encryption','packet_encoding'], vmess:['uuid','security','alter_id'], trojan:['password'], shadowsocks:['method','password'], hysteria2:['password','obfs'] };
  if (Object.keys(o).some(key => !common.includes(key) && !specific[protocol].includes(key))) failCode('config.nodeParams');
  const address = cleanHost(string(o.server, 'Не указан адрес сервера'));
  if (/\s|[\/@?#]/.test(address)) failCode('config.badAddress');
  const port = Number(o.server_port);
  checkPort(port);
  let settings;
  if (protocol === 'vless') {
    checkId(o.uuid);
    if (o.encryption && o.encryption !== 'none') failCode('config.vlessEncryption');
    if (o.flow && !['xtls-rprx-vision', 'xtls-rprx-vision-udp443'].includes(o.flow)) failCode('config.vlessFlow');
    if (o.packet_encoding && !['xudp', 'packetaddr', 'none'].includes(o.packet_encoding)) failCode('config.packetEncoding');
    if (o.packet_encoding === 'packetaddr') failCode('config.packetAddr');
    settings = { address, port, id: o.uuid, encryption: 'none', ...(o.flow ? { flow: o.flow } : {}) };
  } else if (protocol === 'vmess') {
    checkId(o.uuid);
    if (!['auto', 'aes-128-gcm', 'chacha20-poly1305'].includes(o.security || 'auto')) failCode('config.vmessSecurity');
    if (o.alter_id && Number(o.alter_id) !== 0) failCode('config.vmessAlterId');
    settings = { address, port, id: o.uuid, security: o.security || 'auto' };
  } else if (protocol === 'trojan') settings = { address, port, password: string(o.password, 'Для Trojan необходим пароль') };
  else if (protocol === 'shadowsocks') {
    if (!SS_METHODS.has(o.method)) failCode('config.ssMethod');
    settings = { address, port, method: o.method, password: string(o.password, 'Для Shadowsocks необходим пароль') };
  } else settings = { version: 2, address, port };
  let stream;
  if (protocol === 'hysteria2') {
    if (o.transport) failCode('config.hy2Transport');
    stream = streamFor({ ...o, transport: undefined });
    if (stream.security !== 'tls') failCode('config.hy2Tls');
    stream.network = 'hysteria';
    stream.hysteriaSettings = { version: 2, auth: typeof o.password === 'string' ? o.password : '' };
    if (o.obfs) {
      if (o.obfs.type !== 'salamander' || !o.obfs.password) failCode('config.hy2Obfs');
      stream.finalmask = { udp: [{ type: 'salamander', settings: { password: o.obfs.password } }] };
    }
  } else stream = streamFor(o);
  if (protocol === 'vless' && o.flow && (stream.network !== 'raw' || !['tls', 'reality'].includes(stream.security))) failCode('config.visionTransport');
  const result = { tag: 'proxy', protocol: protocol === 'hysteria2' ? 'hysteria' : protocol, settings, streamSettings: stream };
  if (o.packet_encoding === 'xudp') result.mux = { enabled: true, concurrency: -1, xudpConcurrency: 8 };
  return result;
}

// Built-in split routing, used when the provider does not ship its own rules.
// Only "keep local and Russian traffic direct" is assumed; everything else goes
// through the server, which is the behaviour users expect from a VPN.
const DEFAULT_DIRECT = {
  domains: ['domain:ru', 'domain:xn--p1ai', 'geosite:category-ru', 'geosite:private', 'domain:localhost'],
  ips: ['geoip:ru', 'geoip:private', '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10']
};

export function buildXrayConfig(nodes, selectedId, routeMode, routingProfile = null) {
  if (!['all', 'auto', 'split'].includes(routeMode)) failCode('config.routeMode');
  if (!Array.isArray(nodes)) failCode('config.nodes');
  const selected = nodes.find(node => node?.id === selectedId);
  if (!selected) failCode('config.noSelection');
  const profileRules = routeMode !== 'all' && Array.isArray(routingProfile?.rules) ? routingProfile.rules : null;
  const rules = [];
  let needsDirect = false, needsBlock = false;
  if (profileRules?.length) {
    for (const rule of profileRules) {
      const entry = {
        type: 'field',
        outboundTag: rule.target === 'proxy' ? 'proxy' : rule.target,
        ...(rule.domains?.length ? { domain: rule.domains } : {}),
        ...(rule.ips?.length ? { ip: rule.ips } : {}),
        ...(rule.sources?.length ? { source: rule.sources } : {}),
        ...(rule.ports ? { port: rule.ports } : {}),
        ...(rule.network ? { network: rule.network } : {}),
        ...(rule.domainStrategy ? { domainStrategy: rule.domainStrategy } : {}),
        ...(rule.domainMatcher ? { domainMatcher: rule.domainMatcher } : {})
      };
      if (rule.target === 'direct') needsDirect = true;
      if (rule.target === 'block') needsBlock = true;
      if (rule.target !== 'proxy') rules.push(entry);
    }
  } else if (routeMode !== 'all') {
    needsDirect = true;
    rules.push({ type: 'field', domain: DEFAULT_DIRECT.domains, outboundTag: 'direct' });
    rules.push({ type: 'field', ip: DEFAULT_DIRECT.ips, outboundTag: 'direct' });
  }
  const outbounds = [toXrayOutbound(selected)];
  if (needsDirect) outbounds.push({ tag: 'direct', protocol: 'freedom' });
  if (needsBlock) outbounds.push({ tag: 'block', protocol: 'blackhole' });
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'http-in', listen: '127.0.0.1', port: 2080, protocol: 'http', settings: { allowTransparent: false } },
      { tag: 'socks-in', listen: '127.0.0.1', port: 2081, protocol: 'socks', settings: { auth: 'noauth', udp: true, ip: '127.0.0.1' } }
    ],
    outbounds,
    ...(rules.length ? { routing: { domainStrategy: 'IPIfNonMatch', rules } } : {})
  };
}
