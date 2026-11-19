import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSubscriptionDetailed, parseUserinfo, parseHappRouting, parseRoutingProfile } from '../src/subscription.js';
import { buildXrayConfig } from '../src/xray-config.js';

// All credentials and addresses below are fabricated test fixtures.
const id = '11111111-1111-4111-8111-111111111111';
const key = 'A'.repeat(43);
const vless = `vless://${id}@example.test:443?type=tcp&security=reality&pbk=${key}&fp=chrome&sni=example.test&sid=0123&flow=xtls-rprx-vision#Test`;
const xhttp = `vless://${id}@example.test:443?type=xhttp&security=reality&pbk=${key}&fp=chrome&sni=example.test&sid=0123&path=%2Froute&host=cdn.example.test&mode=stream-one&extra=%7B%22xmux%22%3A%7B%22maxConnections%22%3A1%7D%7D#XHTTP`;
const vmess = 'vmess://' + Buffer.from(JSON.stringify({v:'2', ps:'VMess fixture', add:'example.test', port:'443', id, aid:'0', scy:'auto', net:'ws', type:'none', host:'cdn.example.test', path:'/socket', tls:'tls', sni:'example.test'})).toString('base64');
const trojan = 'trojan://fixture-password@example.test:443?security=tls&type=tcp#Trojan';
const ss = 'ss://' + Buffer.from('aes-128-gcm:fixture-password').toString('base64url') + '@example.test:443#SS';
const hy2 = 'hy2://fixture-auth@example.test:443?sni=example.test&obfs=salamander&obfs-password=fixture-mask#HY2';
const PIN = Array.from({ length: 32 }, () => 'ab').join(':');
function parseOne(link) { const result = parseSubscriptionDetailed(link); assert.deepEqual(result.errors, []); assert.equal(result.nodes.length, 1); return result.nodes[0]; }
function config(link, mode = 'all') { const node = parseOne(link); return buildXrayConfig([node], node.id, mode); }
function code(fn) { try { fn(); } catch (error) { return error.code; } return 'no-error'; }

test('подписка 3x-ui: base64, разные протоколы и прежняя модель узла', () => {
  const result = parseSubscriptionDetailed(Buffer.from([vless,xhttp,vmess,trojan,ss,hy2].join('\n')).toString('base64'));
  assert.deepEqual(result.errors, []); assert.deepEqual(result.nodes.map(n => n.protocol), ['VLESS','VLESS','VMess','Trojan','Shadowsocks','Hysteria2']);
  assert.equal(result.nodes[0].outbound.server, 'example.test'); assert.equal(result.nodes[0].favorite, false);
});
test('названия серверов с пробелами не разрывают ссылки', () => {
  const body = [vless.replace('#Test', '#🇩🇪 Германия 1'), vless.replace('#Test', '#🇳🇱 Нидерланды | 2 Gb')].join('\n');
  const result = parseSubscriptionDetailed(Buffer.from(body).toString('base64'));
  assert.deepEqual(result.errors, []); assert.equal(result.nodes.length, 2);
  assert.equal(result.nodes[0].name, '🇩🇪 Германия 1');
  assert.equal(result.nodes[1].name, '🇳🇱 Нидерланды 2 Gb');
  assert.equal(result.nodes[1].countryCode, 'nl');
  assert.equal(result.nodes[1].countrySource, 'emoji');
});
test('несколько ссылок в одной строке делятся только по схеме', () => {
  const body = `${vless.replace('#Test', '#Первая')} ${vless.replace('#Test', '#Вторая с пробелом')}`;
  const result = parseSubscriptionDetailed(body);
  assert.equal(result.nodes.length, 2); assert.deepEqual(result.errors, []);
  assert.equal(result.nodes[1].name, 'Вторая с пробелом');
});
test('XHTTP сохраняет mode, host, path, extra и REALITY', () => {
  const out = config(xhttp).outbounds[0];
  assert.equal(out.streamSettings.network, 'xhttp'); assert.deepEqual(out.streamSettings.xhttpSettings, {path:'/route', host:'cdn.example.test', mode:'stream-one', extra:{xmux:{maxConnections:1}}});
  assert.equal(out.streamSettings.realitySettings.password, key); assert.equal(out.settings.id, id);
});
test('XHTTP mode внутри extra поднимается наверх, а не отклоняется', () => {
  // 3x-ui, Marzban и Happ кладут mode в extra; Xray ждёт его рядом с path.
  const link = 'vless://11111111-1111-4111-8111-111111111111@x.example.com:443?type=xhttp&security=tls&sni=x.example.com&path=%2Fx&extra='
    + encodeURIComponent(JSON.stringify({ mode: 'packet-up', scMaxEachPostBytes: 1000000, scMinPostsIntervalMs: 30, noGRPCHeader: true, xPaddingBytes: '100-1000' })) + '#XHTTP';
  const { nodes, errors } = parseSubscriptionDetailed(link, {});
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].unsupported, undefined);
  const settings = buildXrayConfig(nodes, nodes[0].id, 'auto', null).outbounds[0].streamSettings.xhttpSettings;
  assert.equal(settings.mode, 'packet-up');
  assert.equal(settings.extra.mode, undefined, 'mode не должен оставаться в extra');
  assert.equal(settings.extra.scMaxEachPostBytes, 1000000);
  assert.equal(settings.extra.noGRPCHeader, true);
  assert.equal(settings.path, '/x');
  // Явный mode на верхнем уровне важнее копии внутри extra.
  const both = parseSubscriptionDetailed(link.replace('&extra=', '&mode=stream-up&extra='), {});
  assert.equal(buildXrayConfig(both.nodes, both.nodes[0].id, 'auto', null).outbounds[0].streamSettings.xhttpSettings.mode, 'stream-up');
});

test('snake_case поля XHTTP переносятся в extra.xPaddingBytes', () => {
  const link = 'vless://11111111-1111-4111-8111-111111111111@x.example.com:443?type=xhttp&security=tls&sni=x.example.com&path=%2Fx&extra='
    + encodeURIComponent(JSON.stringify({ mode: 'auto', x_padding_bytes: '100-1000', x_padding_key: 'secret', sc_max_each_post_bytes: 1000000 })) + '#XHTTP';
  const { nodes, errors } = parseSubscriptionDetailed(link, {});
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const extra = buildXrayConfig(nodes, nodes[0].id, 'auto', null).outbounds[0].streamSettings.xhttpSettings.extra;
  assert.equal(extra.xPaddingBytes, '100-1000');
  assert.equal(extra.xPaddingKey, 'secret');
  assert.equal(extra.scMaxEachPostBytes, 1000000);
  assert.equal(extra.x_padding_bytes, undefined, 'the alias must not leak into the config');
  assert.equal(extra.sc_max_each_post_bytes, undefined);
});

test('подсказки клиента support-* не считаются неизвестными параметрами', () => {
  const link = 'vless://11111111-1111-4111-8111-111111111111@x.example.com:443?type=ws&security=tls&sni=x.example.com&path=%2Fws&support-x25519mlkem768=1#WS';
  const { nodes, warnings, errors } = parseSubscriptionDetailed(link, {});
  assert.equal(errors.length, 0);
  assert.equal(nodes.length, 1);
  assert.deepEqual(warnings.filter((w) => w.key === 'sub.unknownParam'), []);
});

test('loopback HTTP и SOCKS, единственный outbound выбранного прокси, без TUN', () => {
  const c = config(vless);
  assert.deepEqual(c.inbounds.map(({listen,port,protocol}) => ({listen,port,protocol})), [{listen:'127.0.0.1',port:2080,protocol:'http'},{listen:'127.0.0.1',port:2081,protocol:'socks'}]);
  assert.equal(c.inbounds[0].settings.allowTransparent, false); assert.deepEqual(c.outbounds.map(o => o.protocol), ['vless']);
  assert.equal(code(() => buildXrayConfig([parseOne(vless)], 'absent', 'all')), 'config.noSelection');
  for (const mode of ['manual', undefined]) assert.equal(code(() => buildXrayConfig([parseOne(vless)], parseOne(vless).id, mode)), 'config.routeMode');
});
test('split и auto используют настоящие правила geosite/geoip и оставляют proxy по умолчанию', () => {
  for (const mode of ['split', 'auto']) {
    const n = parseOne(vless), c = buildXrayConfig([n], n.id, mode);
    assert.deepEqual(c.outbounds.map(o => o.tag), ['proxy', 'direct']);
    assert.ok(c.routing.rules[0].domain.includes('geosite:category-ru'));
    assert.ok(c.routing.rules[1].ip.includes('geoip:ru'));
    assert.ok(c.routing.rules[0].domain.includes('geosite:private'));
  }
  const all = config(vless);
  assert.equal(all.routing, undefined); assert.deepEqual(all.outbounds.map(o => o.tag), ['proxy']);
});
test('правила из подписки заменяют встроенные и добавляют block', () => {
  const n = parseOne(vless);
  const profile = { rules: [
    { target: 'direct', domains: ['domain:example.test'], ips: [] },
    { target: 'block', domains: ['geosite:category-ads-all'], ips: [] },
    { target: 'proxy', domains: [], ips: ['1.2.3.4/32'] }
  ] };
  const c = buildXrayConfig([n], n.id, 'auto', profile);
  assert.deepEqual(c.outbounds.map(o => o.tag), ['proxy', 'direct', 'block']);
  assert.deepEqual(c.routing.rules.map(r => r.outboundTag), ['direct', 'block']);
  assert.deepEqual(c.routing.rules[0].domain, ['domain:example.test']);
  const all = buildXrayConfig([n], n.id, 'all', profile);
  assert.equal(all.routing, undefined);
});
test('профиль маршрутизации читается из JSON подписки и из ссылки Happ', () => {
  const profile = { routing: { rules: [{ type: 'field', domain: ['geosite:private'], outboundTag: 'direct' }, { domain: ['geosite:ads'], outboundTag: 'block' }] } };
  const result = parseSubscriptionDetailed(JSON.stringify({ ...profile, links: [vless] }));
  assert.equal(result.nodes.length, 1);
  assert.deepEqual(result.routing.rules.map(r => r.target), ['direct', 'block']);
  const happ = 'happ://routing/onadd/' + Buffer.from(JSON.stringify(profile)).toString('base64');
  const parsed = parseHappRouting(happ);
  assert.deepEqual(parsed.rules.map(r => r.target), ['direct', 'block']);
});
test('Happ Plus: поддерживаемые правила применяются, остальные перечисляются по номеру', () => {
  const payload = { routing: { rules: [
    { type: 'field', domain: ['geosite:private', 'domain:example.test'], outboundTag: 'direct' },
    { type: 'field', ip: ['10.0.0.0/8'], port: '443,8443', network: 'tcp', outboundTag: 'direct' },
    { type: 'field', source: ['192.168.1.0/24'], outboundTag: 'block' },
    { type: 'field', domain: ['geosite:ads'], outboundTag: 'block' },
    { type: 'field', domain: ['ext:adblock.txt'], outboundTag: 'block' },
    { type: 'field', domain: ['geosite:private'], outboundTag: 'direct-2' },
    { type: 'field', domain: ['geosite:private'], outboundTag: 'direct', processName: ['chrome.exe'] },
    { type: 'field', domain: ['geosite:private'], balancerTag: 'auto' },
    { type: 'field', domain: ['geosite:private'], outboundTag: 'direct', port: 'http' },
    { type: 'field', outboundTag: 'direct' }
  ] }, dns: { servers: ['1.1.1.1'] } };
  const parsed = parseRoutingProfile(payload);
  assert.equal(parsed.total, 10);
  assert.equal(parsed.rules.length, 4);
  assert.deepEqual(parsed.rules.map(r => r.target), ['direct','direct','block','block']);
  assert.deepEqual(parsed.rules[1].ports, '443,8443');
  assert.equal(parsed.rules[1].network, 'tcp');
  assert.deepEqual(parsed.rules[2].sources, ['192.168.1.0/24']);
  assert.equal(parsed.unsupported.length, 6);
  assert.deepEqual(parsed.unsupported.map(r => [r.index, r.reason]), [[5,'extDomain'],[6,'target'],[7,'fields'],[8,'fields'],[9,'port'],[10,'empty']]);
  assert.deepEqual(parsed.unsupported[2].fields, ['processName']);
  assert.equal(parsed.dnsApplied, false);
  const withStrategy = parseRoutingProfile({ routing: { domainStrategy: 'IPIfNonMatch', rules: [{ domain: ['domain:a.test'], outboundTag: 'direct' }] } });
  assert.equal(withStrategy.globalStrategy, 'IPIfNonMatch');
  assert.deepEqual(withStrategy.unsupported.map(r => r.reason), ['globalStrategy']);
});
test('правила Happ с network и source попадают в конфиг Xray', () => {
  const n = parseOne(vless);
  const profile = { rules: [{ target: 'block', domains: [], ips: [], sources: ['192.168.1.0/24'], ports: '443', network: 'tcp' }] };
  const c = buildXrayConfig([n], n.id, 'auto', profile);
  const rule = c.routing.rules[0];
  assert.equal(rule.network, 'tcp');
  assert.deepEqual(rule.source, ['192.168.1.0/24']);
  assert.equal(rule.port, '443');
  assert.equal(rule.outboundTag, 'block');
});
test('Hysteria2 отображается как native hysteria + salamander', () => {
  const out = config(hy2).outbounds[0]; assert.equal(out.protocol, 'hysteria'); assert.equal(out.settings.version, 2);
  assert.equal(out.streamSettings.network, 'hysteria'); assert.equal(out.streamSettings.hysteriaSettings.auth, 'fixture-auth'); assert.equal(out.streamSettings.finalmask.udp[0].type, 'salamander');
});
test('allowInsecure превращается в закрепление сертификата, а не в отказ', () => {
  const result = parseSubscriptionDetailed(`vless://${id}@example.test:443?type=ws&security=tls&sni=example.test&path=%2Fws&allowInsecure=1#Insecure`);
  assert.deepEqual(result.errors, []); assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].needsPin, true);
  assert.equal(code(() => buildXrayConfig(result.nodes, result.nodes[0].id, 'all')), 'config.needsCertificatePin');
  const pinned = result.nodes[0];
  pinned.outbound.tls.pinned_peer_cert_sha256 = PIN;
  const out = buildXrayConfig([pinned], pinned.id, 'all').outbounds[0];
  assert.equal(out.streamSettings.tlsSettings.pinnedPeerCertSha256, PIN);
  assert.equal(out.streamSettings.tlsSettings.allowInsecure, undefined);
});
test('некорректный отпечаток сертификата отклоняется', () => {
  const node = parseOne(`vless://${id}@example.test:443?type=tcp&security=tls&sni=example.test#TLS`);
  node.outbound.tls.pinned_peer_cert_sha256 = 'zz:zz';
  assert.equal(code(() => buildXrayConfig([node], node.id, 'all')), 'config.badPin');
});
test('несовместимый Hysteria2 не теряется и запрещён к запуску', () => {
  const result = parseSubscriptionDetailed('hysteria2://fixture@example.test:443,8443?sni=example.test#hopping');
  assert.equal(result.nodes.length, 1); assert.equal(result.nodes[0].unsupported, true);
  assert.equal(result.nodes[0].originalUri, 'hysteria2://fixture@example.test:443,8443?sni=example.test#hopping');
  assert.deepEqual(result.errors, []); assert.equal(result.warnings.length, 1);
  assert.equal(code(() => buildXrayConfig(result.nodes, result.nodes[0].id, 'all')), 'sub.hy2PortHopping');
});
test('неизвестные параметры не блокируют импорт, но и не теряются', () => {
  const result = parseSubscriptionDetailed(xhttp.replace('#XHTTP', '&unknown=fixture-secret#XHTTP'));
  assert.deepEqual(result.errors, []); assert.equal(result.nodes.length, 1);
  assert.equal(result.warnings.length, 1); assert.equal(result.warnings[0].key, 'sub.unknownParam');
  assert.equal(result.warnings[0].params.key, 'unknown');
  assert.ok(!JSON.stringify(result.warnings).includes('fixture-secret'));
  for (const suffix of ['&mode=bad', '&path=%ZZ', '&type=ws', '&extra=%7Bbad%7D']) {
    const broken = parseSubscriptionDetailed(xhttp.replace('#XHTTP', suffix + '#XHTTP'));
    assert.equal(broken.nodes.length, 0); assert.equal(broken.errors.length, 1);
    assert.ok(!JSON.stringify(broken.errors).includes('fixture-secret'));
  }
  assert.equal(parseSubscriptionDetailed(vless.replace(id, 'bad')).nodes.length, 0);
});
test('gRPC mode=gun/multi принимается панелями, неизвестный режим отклоняется', () => {
  for (const mode of ['gun', 'multi']) {
    const result = parseSubscriptionDetailed(`vless://${id}@example.test:443?type=grpc&security=tls&sni=example.test&serviceName=svc&mode=${mode}#gRPC`);
    assert.deepEqual(result.errors, []); assert.equal(result.nodes.length, 1);
  }
  const bad = parseSubscriptionDetailed(`vless://${id}@example.test:443?type=grpc&security=tls&sni=example.test&serviceName=svc&mode=weird#gRPC`);
  assert.equal(bad.nodes.length, 0); assert.equal(bad.errors[0].key, 'sub.badGrpcMode');
});
test('старые TCP/WS узлы преобразуются, неоднозначный старый HTTP требует повторного импорта', () => {
  const n = parseOne(vless); delete n.outbound.transport;
  assert.equal(buildXrayConfig([n], n.id, 'all').outbounds[0].streamSettings.network, 'raw');
  n.outbound.transport = {type:'http', path:'/lost', host:['example.test']};
  assert.equal(code(() => buildXrayConfig([n], n.id, 'all')), 'config.legacyTransport');
});
test('SS credentials с двоеточием, userinfo, JSON-обёртка', () => {
  const link = 'ss://' + Buffer.from('aes-256-gcm:pass:part').toString('base64url') + '@example.test:443#SS';
  assert.equal(parseOne(link).outbound.password, 'pass:part');
  assert.equal(parseSubscriptionDetailed(JSON.stringify({links:[link]})).nodes.length, 1);
  const info = parseUserinfo('upload=20; download=30; total=100; expire=1700000000');
  assert.equal(info.used, 50); assert.equal(info.total, 100); assert.equal(info.expiresAt.toISOString(), '2023-11-14T22:13:20.000Z');
});

test('xray run -test проверяет каждый сгенерированный протокол', { skip: !process.env.XRAY_TEST_BIN }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kartovpn-config-'));
  try {
    for (const [index,link] of [vless,xhttp,vmess,trojan,ss,hy2].entries()) {
      const path = join(dir, `${index}.json`); writeFileSync(path, JSON.stringify(config(link)), {mode:0o600});
      const result = spawnSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-config', path], {encoding:'utf8'});
      assert.equal(result.status, 0, `xray rejected fixture ${index}: ${result.stderr} ${result.stdout}`);
    }
    const insecure = parseOne(`vless://${id}@example.test:443?type=tcp&security=tls&sni=example.test&allowInsecure=1#Insecure`);
    insecure.outbound.tls.pinned_peer_cert_sha256 = PIN;
    const pinnedPath = join(dir, 'pinned.json');
    writeFileSync(pinnedPath, JSON.stringify(buildXrayConfig([insecure], insecure.id, 'all')), {mode:0o600});
    const pinned = spawnSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-config', pinnedPath], {encoding:'utf8'});
    assert.equal(pinned.status, 0, `xray rejected the pinned config: ${pinned.stderr} ${pinned.stdout}`);
    const n = parseOne(vless), path = join(dir, 'split.json');
    writeFileSync(path, JSON.stringify(buildXrayConfig([n], n.id, 'auto')), {mode:0o600});
    const split = spawnSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-config', path], {encoding:'utf8'});
    assert.equal(split.status, 0, `routing requires geoip.dat and geosite.dat: ${split.stderr} ${split.stdout}`);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
test('DNS: system не добавляет резолвер, builtin включает DoH, кэш и .ru-сервер', () => {
  const node = parseOne(vless);
  const system = buildXrayConfig([node], node.id, 'split', null, { dns: 'system' });
  assert.equal(system.dns, undefined);
  assert.equal(system.routing.domainStrategy, 'IPIfNonMatch');
  const builtin = buildXrayConfig([node], node.id, 'split', null, { dns: 'builtin' });
  assert.equal(builtin.routing.domainStrategy, 'IPIfNonMatch');
  assert.equal(builtin.dns.disableCache, false);
  assert.equal(builtin.dns.queryStrategy, 'UseIPv4');
  // DoH only, and every address is a literal IP: no DoH hostname can reach the
  // system resolver. A plain UDP resolver would let the provider read every name.
  assert.equal(builtin.dns.tag, 'dns-query');
  const urls = builtin.dns.servers.map((server) => String(server.address));
  assert.ok(urls.every((url) => url.startsWith('https://')));
  assert.ok(urls.every((url) => !/:53\b/.test(url)));
  for (const url of urls) {
    const host = new URL(url).hostname;
    assert.ok(/^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(host), `${url} must use an IP, not a name`);
  }
  assert.ok(builtin.dns.servers.some((server) => String(server.address).startsWith('https://77.88.8.8/') && server.domains.includes('domain:ru')));
  assert.ok(urls.includes('https://1.1.1.1/dns-query'));
  // Built-in queries are matched by tag and sent through the proxy outbound.
  assert.deepEqual(builtin.routing.rules[0], { type: 'field', inboundTag: ['dns-query'], outboundTag: 'proxy' });
  // Unknown values must not silently disable resolution for rules.
  const fallback = buildXrayConfig([node], node.id, 'split', null, { dns: 'nonsense' });
  assert.equal(fallback.dns, undefined);
  // Without rules there is nothing to resolve, so no resolver and no routing block.
  const all = buildXrayConfig([node], node.id, 'all', null, { dns: 'builtin' });
  assert.equal(all.dns, undefined);
  assert.equal(all.routing, undefined);
});
test('авто: пул узлов, balancer leastPing и observatory; один узел — без balancer', () => {
  const a = parseOne(vless), b = parseOne(trojan);
  const auto = buildXrayConfig([a, b], a.id, 'split', null, { auto: [a, b] });
  assert.deepEqual(auto.outbounds.map((item) => item.tag), ['proxy-1', 'proxy-2', 'direct']);
  assert.equal(auto.routing.balancers[0].strategy.type, 'leastPing');
  assert.deepEqual(auto.routing.balancers[0].selector, ['proxy-']);
  assert.equal(auto.observatory.probeUrl, 'https://www.gstatic.com/generate_204');
  // The catch-all rule sends everything unmatched to the balancer, never to a tag that does not exist.
  assert.equal(auto.routing.rules.at(-1).balancerTag, 'auto');
  assert.equal(auto.routing.rules.some((rule) => rule.outboundTag === 'proxy'), false);
  const single = buildXrayConfig([a, b], a.id, 'split', null, { auto: [a] });
  assert.deepEqual(single.outbounds.map((item) => item.tag), ['proxy', 'direct']);
  assert.equal(single.routing.balancers, undefined);
  assert.equal(single.observatory, undefined);
  if (process.env.XRAY_TEST_BIN) {
    const dir = mkdtempSync(join(tmpdir(), 'kartovpn-auto-'));
    try {
      const path = join(dir, 'auto.json');
      writeFileSync(path, JSON.stringify(auto), { mode: 0o600 });
      const result = spawnSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-config', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, `xray rejected the auto config: ${result.stderr} ${result.stdout}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
test('опции производительности: sniffing, IPv4 и TFO выключены по умолчанию', () => {
  const node = parseOne(vless);
  const base = buildXrayConfig([node], node.id, 'all');
  assert.equal(base.inbounds[0].sniffing, undefined);
  assert.equal(base.outbounds[0].streamSettings.sockopt, undefined);
  const tuned = buildXrayConfig([node], node.id, 'all', null, { perf: { sniffing: true, preferIPv4: true, tcpFastOpen: true } });
  assert.deepEqual(tuned.inbounds[0].sniffing.destOverride, ['http', 'tls', 'quic']);
  assert.equal(tuned.inbounds[0].sniffing.routeOnly, true);
  assert.equal(tuned.outbounds[0].streamSettings.sockopt.domainStrategy, 'UseIPv4');
  assert.equal(tuned.outbounds[0].streamSettings.sockopt.tcpFastOpen, true);
  if (process.env.XRAY_TEST_BIN) {
    const dir = mkdtempSync(join(tmpdir(), 'kartovpn-perf-'));
    try {
      const path = join(dir, 'tuned.json');
      writeFileSync(path, JSON.stringify(tuned), { mode: 0o600 });
      const result = spawnSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-config', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, `xray rejected the tuned config: ${result.stderr} ${result.stdout}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// Real panel form: XHTTP tuning arrives as separate query keys, not inside extra.
const xhttpQuery = `vless://${id}@example.test:443?type=xhttp&security=reality&pbk=${key}&fp=chrome&sni=example.test&sid=0123&path=%2Froute&host=cdn.example.test&mode=auto&x_padding_bytes=100-1000#XHTTPQuery`;
test('XHTTP: параметры из query попадают в extra без предупреждений', () => {
  const result = parseSubscriptionDetailed(xhttpQuery);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  const node = result.nodes[0];
  assert.equal(node.outbound.transport.extra.xPaddingBytes, '100-1000');
  const built = buildXrayConfig([node], node.id, 'all');
  assert.equal(built.outbounds[0].streamSettings.xhttpSettings.extra.xPaddingBytes, '100-1000');
});
test('XHTTP: extra=JSON имеет приоритет над query, типы приводятся', () => {
  const mixed = `vless://${id}@example.test:443?type=xhttp&security=tls&sni=example.test&path=%2Fm&x_padding_bytes=100-1000&no_grpc_header=true&xmux=%7B%22maxConnections%22%3A1%7D&extra=${encodeURIComponent(JSON.stringify({ xPaddingBytes: 2048, xPaddingKey: 'x-fixture' }))}#Mixed`;
  const result = parseSubscriptionDetailed(mixed);
  assert.deepEqual(result.warnings, []);
  const extra = result.nodes[0].outbound.transport.extra;
  assert.equal(extra.xPaddingBytes, 2048);
  assert.equal(extra.xPaddingKey, 'x-fixture');
  assert.equal(extra.noGRPCHeader, true);
  assert.deepEqual(extra.xmux, { maxConnections: 1 });
});
test('XHTTP: те же ключи на ws и grpc остаются предупреждением', () => {
  for (const link of [
    `vless://${id}@example.test:443?type=ws&security=tls&sni=example.test&path=%2Fws&x_padding_bytes=100-1000#WS`,
    `vless://${id}@example.test:443?type=grpc&security=tls&sni=example.test&service=grpc&x_padding_bytes=100-1000#GRPC`
  ]) {
    const result = parseSubscriptionDetailed(link);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((w) => w.key === 'sub.unknownParam'), 'ожидалось предупреждение sub.unknownParam');
  }
});
const xhttpMixed = `vless://${id}@example.test:443?type=xhttp&security=tls&sni=example.test&path=%2Fm&x_padding_bytes=100-1000&no_grpc_header=true&xmux=%7B%22maxConnections%22%3A1%7D&extra=${encodeURIComponent(JSON.stringify({ xPaddingBytes: 2048, xPaddingKey: 'x-fixture' }))}#Mixed`;
test('XHTTP: выключенная настройка использует только extra=JSON', () => {
  const node = parseOne(xhttpMixed);
  const extra = buildXrayConfig([node], node.id, 'all', null, { xhttpQuery: false }).outbounds[0].streamSettings.xhttpSettings.extra;
  assert.equal(extra.xPaddingBytes, 2048, 'extra=JSON wins');
  assert.equal(extra.xPaddingKey, 'x-fixture');
  assert.equal(extra.noGRPCHeader, undefined, 'query-only key must be dropped');
  assert.equal(extra.xmux, undefined, 'query-only JSON key must be dropped too');
});
test('XHTTP: без extra=JSON выключенная настройка не добавляет extra', () => {
  const node = parseOne(xhttpQuery);
  const settings = buildXrayConfig([node], node.id, 'all', null, { xhttpQuery: false }).outbounds[0].streamSettings.xhttpSettings;
  assert.equal(settings.extra, undefined);
  assert.equal(settings.mode, 'auto');
});
const hy2Tuned = `hy2://fixture-auth@example.test:443?sni=example.test&obfs=salamander&obfs-password=fixture-mask&up=50%20mbps&down=200%20mbps&congestion=bbr#HY2Tuned`;
test('Hysteria2: up, down и congestion переносятся, без них полей нет', () => {
  const tuned = parseSubscriptionDetailed(hy2Tuned);
  assert.deepEqual(tuned.warnings, []);
  const settings = tuned.nodes[0].outbound;
  assert.equal(settings.up, '50 mbps');
  assert.equal(settings.down, '200 mbps');
  assert.equal(settings.congestion, 'bbr');
  const plain = parseOne(hy2).outbound;
  assert.equal(plain.up, undefined);
  assert.equal(plain.down, undefined);
  assert.equal(plain.congestion, undefined);
});
test('xray run -test принимает XHTTP из query и Hysteria2 с полосами', { skip: !process.env.XRAY_TEST_BIN }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kartovpn-fixes-'));
  try {
    for (const [index, link] of [xhttpQuery, hy2Tuned].entries()) {
      const path = join(dir, `${index}.json`);
      writeFileSync(path, JSON.stringify(config(link)), { mode: 0o600 });
      const result = spawnSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-config', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, `ядро отклонило конфигурацию ${index}: ${result.stderr} ${result.stdout}`);
    }
    for (const [name, options] of [['xhttp-query-on', {}], ['xhttp-query-off', { xhttpQuery: false }]]) {
      const node = parseOne(xhttpMixed);
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(buildXrayConfig([node], node.id, 'all', null, options)), { mode: 0o600 });
      const result = spawnSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-config', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, `ядро отклонило ${name}: ${result.stderr} ${result.stdout}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('xray run -test принимает DoH-конфиг и TCP Fast Open', { skip: !process.env.XRAY_TEST_BIN }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kartovpn-doh-'));
  try {
    const node = parseOne(xhttp);
    for (const [name, options] of [['doh', { dns: 'builtin' }], ['doh-tfo', { dns: 'builtin', perf: { tcpFastOpen: true } }], ['system', { dns: 'system' }]]) {
      const config = buildXrayConfig([node], node.id, 'split', null, options);
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
      const result = spawnSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-config', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, `ядро отклонило ${name}: ${result.stderr} ${result.stdout}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
