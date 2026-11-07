import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSubscriptionDetailed, parseUserinfo, parseHappRouting } from '../src/subscription.js';
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
  assert.equal(result.nodes[1].country, 'Нидерланды');
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
