import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSubscriptionDetailed, parseUserinfo } from '../src/subscription.js';
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
function parseOne(link) { const result = parseSubscriptionDetailed(link); assert.deepEqual(result.errors, []); assert.equal(result.nodes.length, 1); return result.nodes[0]; }
function config(link) { const node = parseOne(link); return buildXrayConfig([node], node.id, 'all'); }

test('подписка 3x-ui: base64, разные протоколы и прежняя модель узла', () => {
  const result = parseSubscriptionDetailed(Buffer.from([vless,xhttp,vmess,trojan,ss,hy2].join('\n')).toString('base64'));
  assert.deepEqual(result.errors, []); assert.deepEqual(result.nodes.map(n => n.protocol), ['VLESS','VLESS','VMess','Trojan','Shadowsocks','Hysteria2']);
  assert.equal(result.nodes[0].outbound.server, 'example.test'); assert.equal(result.nodes[0].favorite, false);
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
  assert.throws(() => buildXrayConfig([parseOne(vless)], 'absent', 'all'), /не найден/);
  for (const mode of ['manual',undefined]) assert.throws(() => buildXrayConfig([parseOne(vless)], parseOne(vless).id, mode), /недоступен/);
});
test('split использует настоящие правила geosite/geoip и оставляет proxy по умолчанию', () => {
  const n = parseOne(vless), c = buildXrayConfig([n], n.id, 'split');
  assert.deepEqual(c.outbounds.map(o => o.tag), ['proxy', 'direct']);
  assert.ok(c.routing.rules[0].domain.includes('geosite:category-ru'));
  assert.ok(c.routing.rules[1].ip.includes('geoip:ru'));
});
test('Hysteria2 отображается как native hysteria + salamander', () => {
  const out = config(hy2).outbounds[0]; assert.equal(out.protocol, 'hysteria'); assert.equal(out.settings.version, 2);
  assert.equal(out.streamSettings.network, 'hysteria'); assert.equal(out.streamSettings.hysteriaSettings.auth, 'fixture-auth'); assert.equal(out.streamSettings.finalmask.udp[0].type, 'salamander');
});
test('несовместимый Hysteria2 не теряется и запрещён к запуску', () => {
  for (const link of ['hy2://fixture@example.test?insecure=1#unsafe', 'hysteria2://fixture@example.test?obfs=gecko&obfs-password=fixture#gecko']) {
    const result = parseSubscriptionDetailed(link); assert.equal(result.nodes.length, 1); assert.equal(result.nodes[0].unsupported, true); assert.equal(result.nodes[0].originalUri, link); assert.equal(result.errors.length, 1);
    assert.throws(() => buildXrayConfig(result.nodes, result.nodes[0].id, 'all'));
  }
});
test('ошибки параметров не игнорируются и не показывают секреты', () => {
  for (const suffix of ['&unknown=fixture-secret', '&mode=bad', '&path=%ZZ', '&type=ws', '&extra=%7Bbad%7D']) {
    const result = parseSubscriptionDetailed(xhttp.replace('#XHTTP', suffix + '#XHTTP'));
    assert.equal(result.nodes.length, 0); assert.equal(result.errors.length, 1); assert.ok(!result.errors[0].includes('fixture-secret'));
  }
  assert.equal(parseSubscriptionDetailed(vless.replace('11111111-1111-4111-8111-111111111111', 'bad')).nodes.length, 0);
});
test('старые TCP/WS узлы преобразуются, неоднозначный старый HTTP требует повторного импорта', () => {
  const n = parseOne(vless); delete n.outbound.transport;
  assert.equal(buildXrayConfig([n], n.id, 'all').outbounds[0].streamSettings.network, 'raw');
  n.outbound.transport = {type:'http', path:'/lost', host:['example.test']};
  assert.throws(() => buildXrayConfig([n], n.id, 'all'), /перевставьте подписку/);
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
    const n = parseOne(vless), path = join(dir, 'split.json');
    writeFileSync(path, JSON.stringify(buildXrayConfig([n], n.id, 'split')), {mode:0o600});
    const split = spawnSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-config', path], {encoding:'utf8'});
    assert.equal(split.status, 0, `split requires geoip.dat and geosite.dat: ${split.stderr} ${split.stdout}`);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
