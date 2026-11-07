// Xray-core v26.10.31, proxy-only. Node.outbound remains in the app's legacy shape.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINTS = new Set(['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized', 'unsafe']);
const SS_METHODS = new Set(['aes-128-gcm', 'aes-256-gcm', 'chacha20-poly1305', 'chacha20-ietf-poly1305', 'xchacha20-poly1305', 'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305']);
const EXTRA_KEYS = new Set(['headers', 'xPaddingBytes', 'xPaddingObfsMode', 'xPaddingKey', 'xPaddingHeader', 'xPaddingPlacement', 'xPaddingMethod', 'uplinkHTTPMethod', 'sessionIDPlacement', 'sessionIDKey', 'sessionIDTable', 'sessionIDLength', 'seqPlacement', 'seqKey', 'uplinkDataPlacement', 'uplinkDataKey', 'uplinkChunkSize', 'noGRPCHeader', 'noSSEHeader', 'scMaxEachPostBytes', 'scMinPostsIntervalMs', 'scMaxBufferedPosts', 'scStreamUpServerSecs', 'serverMaxHeaderBytes', 'xmux', 'downloadSettings', 'h2Params']);
function fail(message) { throw new Error(message); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function string(value, message) { if (typeof value !== 'string' || !value.trim()) fail(message); return value; }
function cleanHost(host) { return typeof host === 'string' && host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host; }
function checkPort(port) { if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Некорректный порт сервера'); }
function checkId(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('Некорректный UUID'); }
function checkExtra(value) {
  if (!object(value)) fail('XHTTP extra должен быть JSON-объектом');
  for (const key of Object.keys(value)) if (!EXTRA_KEYS.has(key)) fail(`Неподдерживаемый параметр XHTTP extra: ${key}`);
  if (value.headers !== undefined && (!object(value.headers) || Object.entries(value.headers).some(([k,v]) => k.toLowerCase() === 'host' || typeof v !== 'string'))) fail('Некорректные XHTTP headers');
  if (value.xmux !== undefined) {
    if (!object(value.xmux)) fail('Некорректный XHTTP xmux');
    const allowed = ['maxConcurrency', 'maxConnections', 'cMaxReuseTimes', 'hMaxRequestTimes', 'hMaxReusableSecs', 'hKeepAlivePeriod'];
    for (const [key, item] of Object.entries(value.xmux)) {
      if (!allowed.includes(key) || !((Number.isInteger(item) && item >= 0) || (typeof item === 'string' && /^\d+(?:-\d+)?$/.test(item)))) fail('Некорректный XHTTP xmux');
    }
  }
  // A separate download stream contains another full Xray configuration; refuse it
  // rather than silently accepting unknown or incompatible nested parameters.
  if (value.downloadSettings !== undefined) fail('XHTTP downloadSettings пока не поддерживается');
  if (value.h2Params !== undefined) fail('XHTTP h2Params пока не поддерживается');
  for (const key of ['xPaddingObfsMode', 'noGRPCHeader', 'noSSEHeader']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('Некорректный параметр XHTTP extra');
  for (const key of ['xPaddingKey', 'xPaddingHeader', 'xPaddingPlacement', 'xPaddingMethod', 'uplinkHTTPMethod', 'sessionIDPlacement', 'sessionIDKey', 'sessionIDTable', 'seqPlacement', 'seqKey', 'uplinkDataPlacement', 'uplinkDataKey']) if (value[key] !== undefined && typeof value[key] !== 'string') fail('Некорректный параметр XHTTP extra');
  for (const key of ['xPaddingBytes', 'sessionIDLength', 'uplinkChunkSize', 'scMaxEachPostBytes', 'scMinPostsIntervalMs', 'scStreamUpServerSecs']) {
    const item = value[key];
    if (item !== undefined && !(Number.isInteger(item) || (typeof item === 'string' && /^-?\d+(?:-\d+)?$/.test(item)))) fail('Некорректный параметр XHTTP extra');
  }
  for (const key of ['scMaxBufferedPosts', 'serverMaxHeaderBytes']) if (value[key] !== undefined && !Number.isInteger(value[key])) fail('Некорректный параметр XHTTP extra');
}
function streamFor(outbound) {
  const t = outbound.transport;
  if (t !== undefined && t !== null && !object(t)) fail('Некорректный транспорт');
  const type = t?.type || 'tcp';
  if (type === 'http' || type === 'h2') fail('Старый HTTP/XHTTP-узел неоднозначен: перевставьте подписку или исходную ссылку');
  if (!['tcp', 'raw', 'ws', 'websocket', 'grpc', 'xhttp', 'httpupgrade'].includes(type)) fail('Неподдерживаемый транспорт');
  const keysByType = { tcp:['type'], raw:['type'], ws:['type','path','headers'], websocket:['type','path','headers'], grpc:['type','service_name','authority','multi_mode'], xhttp:['type','host','path','mode','extra'], httpupgrade:['type','host','path'] };
  if (t && Object.keys(t).some(key => !keysByType[type].includes(key))) fail('Неизвестные параметры транспорта; повторно импортируйте ссылку');
  const network = ({ tcp: 'raw', raw: 'raw', ws: 'ws', websocket: 'ws', grpc: 'grpc', xhttp: 'xhttp', httpupgrade: 'httpupgrade' })[type];
  const stream = { network };
  if (network === 'xhttp') {
    if (t.mode !== undefined && !['auto', 'packet-up', 'stream-up', 'stream-one'].includes(t.mode)) fail('Некорректный режим XHTTP');
    if (t.path !== undefined && (typeof t.path !== 'string' || !t.path.startsWith('/'))) fail('Некорректный путь XHTTP');
    if (t.host !== undefined && typeof t.host !== 'string') fail('Некорректный host XHTTP');
    stream.xhttpSettings = { ...(t.host !== undefined ? { host: t.host } : {}), ...(t.path !== undefined ? { path: t.path } : {}), ...(t.mode !== undefined ? { mode: t.mode } : {}) };
    if (t.extra !== undefined) { checkExtra(t.extra); stream.xhttpSettings.extra = t.extra; }
  } else if (network === 'ws') {
    if (t.path !== undefined && (typeof t.path !== 'string' || !t.path.startsWith('/'))) fail('Некорректный путь WebSocket');
    if (t.headers !== undefined && (!object(t.headers) || Object.values(t.headers).some(v => typeof v !== 'string'))) fail('Некорректные WebSocket headers');
    stream.wsSettings = { path: t.path || '/', ...(t.headers ? { headers: t.headers } : {}) };
  } else if (network === 'grpc') {
    if (t.service_name !== undefined && typeof t.service_name !== 'string') fail('Некорректный serviceName gRPC');
    if (t.authority !== undefined && typeof t.authority !== 'string') fail('Некорректный authority gRPC');
    if (t.multi_mode !== undefined && typeof t.multi_mode !== 'boolean') fail('Некорректный multiMode gRPC');
    stream.grpcSettings = { serviceName: t.service_name || '', ...(t.authority ? { authority: t.authority } : {}), ...(t.multi_mode !== undefined ? { multiMode: t.multi_mode } : {}) };
  } else if (network === 'httpupgrade') {
    if (t.path !== undefined && (typeof t.path !== 'string' || !t.path.startsWith('/'))) fail('Некорректный путь HTTPUpgrade');
    if (t.host !== undefined && typeof t.host !== 'string') fail('Некорректный host HTTPUpgrade');
    stream.httpupgradeSettings = { path: t.path || '/', ...(t.host ? { host: t.host } : {}) };
  }
  const tls = outbound.tls;
  if (tls !== undefined && tls !== null && !object(tls)) fail('Некорректные параметры TLS');
  if (tls && tls.enabled !== false) {
    const tlsKeys = ['enabled', 'server_name', 'utls', 'reality', 'insecure', 'alpn', 'pinned_peer_cert_sha256', 'ech_config_list'];
    if (Object.keys(tls).some(key => !tlsKeys.includes(key))) fail('Неподдерживаемые параметры TLS');
    if (tls.utls && (!object(tls.utls) || Object.keys(tls.utls).some(key => !['enabled','fingerprint'].includes(key)))) fail('Неподдерживаемые параметры uTLS');
    if (tls.reality && (!object(tls.reality) || Object.keys(tls.reality).some(key => !['enabled','public_key','short_id','spider_x','mldsa65_verify'].includes(key)))) fail('Неподдерживаемые параметры REALITY');
    if (tls.insecure) fail('Xray v26.10.31 удалил allowInsecure; используйте pinSHA256 или другую конфигурацию');
    const fp = tls.utls?.fingerprint;
    if (fp && !FINGERPRINTS.has(fp)) fail('Неподдерживаемый TLS fingerprint');
    if (tls.reality?.enabled) {
      if (!['raw', 'xhttp', 'grpc'].includes(network)) fail('REALITY несовместим с выбранным транспортом');
      if (fp === 'unsafe') fail('REALITY требует fingerprint uTLS');
      const key = string(tls.reality.public_key, 'Для REALITY необходим public key');
      if (!/^[A-Za-z0-9_-]{43}$/.test(key)) fail('Некорректный REALITY public key');
      const sid = tls.reality.short_id || '';
      if (!/^(?:[0-9a-f]{2}){0,8}$/i.test(sid)) fail('Некорректный REALITY shortId');
      stream.security = 'reality';
      stream.realitySettings = { serverName: string(tls.server_name, 'Для REALITY необходим SNI'), fingerprint: fp || 'chrome', password: key, shortId: sid, ...(tls.reality.spider_x ? { spiderX: tls.reality.spider_x } : {}), ...(tls.reality.mldsa65_verify ? { mldsa65Verify: tls.reality.mldsa65_verify } : {}) };
    } else {
      stream.security = 'tls';
      stream.tlsSettings = { ...(tls.server_name ? { serverName: tls.server_name } : {}), ...(fp ? { fingerprint: fp } : {}), ...(tls.alpn ? { alpn: tls.alpn } : {}), ...(tls.pinned_peer_cert_sha256 ? { pinnedPeerCertSha256: tls.pinned_peer_cert_sha256 } : {}), ...(tls.ech_config_list ? { echConfigList: tls.ech_config_list } : {}) };
      if (tls.alpn && (!Array.isArray(tls.alpn) || tls.alpn.some(v => typeof v !== 'string' || !v))) fail('Некорректный TLS ALPN');
      if (tls.pinned_peer_cert_sha256 && !/^(?:[0-9a-f]{2}:?){32}$/i.test(tls.pinned_peer_cert_sha256)) fail('Некорректный pinSHA256');
    }
  } else stream.security = 'none';
  return stream;
}

// Also used at import time, so malformed links do not become apparently usable nodes.
export function toXrayOutbound(node) {
  if (!object(node) || !object(node.outbound)) fail('Узел не содержит параметров подключения');
  if (node.unsupported || node.supported === false) fail(node.unsupportedReason || 'Этот узел не поддерживается');
  const o = node.outbound;
  const protocol = String(o.type || '').toLowerCase();
  if (!['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2'].includes(protocol)) fail('Неподдерживаемый протокол');
  const common = ['type','tag','server','server_port','tls','transport'];
  const specific = { vless:['uuid','flow','encryption','packet_encoding'], vmess:['uuid','security','alter_id'], trojan:['password'], shadowsocks:['method','password'], hysteria2:['password','obfs'] };
  if (Object.keys(o).some(key => !common.includes(key) && !specific[protocol].includes(key))) fail('Неподдерживаемые параметры узла; повторно импортируйте ссылку');
  const address = cleanHost(string(o.server, 'Не указан адрес сервера'));
  if (/\s|[\/@?#]/.test(address)) fail('Некорректный адрес сервера');
  const port = Number(o.server_port);
  checkPort(port);
  let settings;
  if (protocol === 'vless') {
    checkId(o.uuid);
    if (o.encryption && o.encryption !== 'none') fail('VLESS Encryption пока не поддерживается');
    if (o.flow && !['xtls-rprx-vision', 'xtls-rprx-vision-udp443'].includes(o.flow)) fail('Неподдерживаемый VLESS flow');
    if (o.packet_encoding && !['xudp', 'packetaddr', 'none'].includes(o.packet_encoding)) fail('Неподдерживаемое packetEncoding');
    if (o.packet_encoding === 'packetaddr') fail('packetaddr не поддерживается Xray');
    settings = { address, port, id: o.uuid, encryption: 'none', ...(o.flow ? { flow: o.flow } : {}) };
  } else if (protocol === 'vmess') {
    checkId(o.uuid);
    if (!['auto', 'aes-128-gcm', 'chacha20-poly1305'].includes(o.security || 'auto')) fail('Неподдерживаемое шифрование VMess');
    if (o.alter_id && Number(o.alter_id) !== 0) fail('VMess alterId больше 0 не поддерживается Xray');
    settings = { address, port, id: o.uuid, security: o.security || 'auto' };
  } else if (protocol === 'trojan') settings = { address, port, password: string(o.password, 'Для Trojan необходим пароль') };
  else if (protocol === 'shadowsocks') {
    if (!SS_METHODS.has(o.method)) fail('Неподдерживаемый метод Shadowsocks');
    settings = { address, port, method: o.method, password: string(o.password, 'Для Shadowsocks необходим пароль') };
  } else settings = { version: 2, address, port };
  let stream;
  if (protocol === 'hysteria2') {
    if (o.transport) fail('Неподдерживаемый транспорт Hysteria2');
    stream = streamFor({ ...o, transport: undefined });
    if (stream.security !== 'tls') fail('Hysteria2 требует TLS');
    stream.network = 'hysteria';
    stream.hysteriaSettings = { version: 2, auth: typeof o.password === 'string' ? o.password : '' };
    if (o.obfs) {
      if (o.obfs.type !== 'salamander' || !o.obfs.password) fail('Неподдерживаемая маскировка Hysteria2');
      stream.finalmask = { udp: [{ type: 'salamander', settings: { password: o.obfs.password } }] };
    }
  } else stream = streamFor(o);
  if (protocol === 'vless' && o.flow && (stream.network !== 'raw' || !['tls', 'reality'].includes(stream.security))) fail('Vision требует TCP и TLS/REALITY');
  const result = { tag: 'proxy', protocol: protocol === 'hysteria2' ? 'hysteria' : protocol, settings, streamSettings: stream };
  if (o.packet_encoding === 'xudp') result.mux = { enabled: true, concurrency: -1, xudpConcurrency: 8 };
  return result;
}

export function buildXrayConfig(nodes, selectedId, routeMode) {
  if (!['all', 'split'].includes(routeMode)) fail('Режим маршрутизации недоступен: выберите «Весь трафик через прокси» или «Россия напрямую»');
  if (!Array.isArray(nodes)) fail('Некорректный список серверов');
  const selected = nodes.find(node => node?.id === selectedId);
  if (!selected) fail('Выбранный сервер не найден');
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'http-in', listen: '127.0.0.1', port: 2080, protocol: 'http', settings: { allowTransparent: false } },
      { tag: 'socks-in', listen: '127.0.0.1', port: 2081, protocol: 'socks', settings: { auth: 'noauth', udp: true, ip: '127.0.0.1' } }
    ],
    outbounds: [toXrayOutbound(selected), ...(routeMode === 'split' ? [{ tag: 'direct', protocol: 'freedom' }] : [])],
    ...(routeMode === 'split' ? { routing: { domainStrategy: 'IPIfNonMatch', rules: [
      { type: 'field', domain: ['domain:ru', 'domain:xn--p1ai', 'geosite:category-ru'], outboundTag: 'direct' },
      { type: 'field', ip: ['geoip:ru'], outboundTag: 'direct' }
    ] } } : {})
  };
}
