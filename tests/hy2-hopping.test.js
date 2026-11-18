import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePortSpec, parseSubscriptionDetailed } from '../src/subscription.js';
import { buildXrayConfig } from '../src/xray-config.js';
import { dictionaryFor } from '../src/i18n.js';

const link = (authority, query = '') => `hysteria2://pass@example.com:${authority}${query}#Hop`;

test('диапазон и список портов разбираются до разбора URL', () => {
  assert.deepEqual(parsePortSpec('20000-20010'), { count: 11, first: 20000, last: 20010, single: null });
  assert.deepEqual(parsePortSpec('443,8443'), { count: 2, first: 443, last: 8443, single: null });
  assert.deepEqual(parsePortSpec('8443'), { count: 1, first: 8443, last: 8443, single: 8443 });
  assert.equal(parsePortSpec('0-10'), null);
  assert.equal(parsePortSpec('20000-10000'), null);
  assert.equal(parsePortSpec('abc'), null);
});

test('ссылка с диапазоном в authority остаётся видимой, но помечена причиной', () => {
  const result = parseSubscriptionDetailed(link('20000-20010'));
  assert.deepEqual(result.errors, []);
  const node = result.nodes[0];
  assert.equal(node.supported, false);
  assert.equal(node.code, 'sub.hy2PortHopping');
  assert.equal(node.portHopping.count, 11);
  assert.equal(node.portHopping.first, 20000);
  assert.equal(node.outbound.server, 'example.com');
  assert.equal(node.outbound.server_port, 20000);
  const reason = dictionaryFor('ru')['err.sub.hy2PortHopping']
    .replace('{spec}', node.params.spec).replace('{count}', node.params.count).replace('{first}', node.params.first);
  assert.match(reason, /20000-20010/);
  assert.match(reason, /26\.10\.31/);
});

test('список портов и mport дают то же сообщение', () => {
  for (const [raw, count] of [
    [link('443,8443'), 2],
    [link('443', '?mport=20000-20005'), 6]
  ]) {
    const node = parseSubscriptionDetailed(raw).nodes[0];
    assert.equal(node.code, 'sub.hy2PortHopping');
    assert.equal(node.portHopping.count, count);
  }
});

test('один порт (в том числе mport) остаётся рабочей ссылкой', () => {
  const plain = parseSubscriptionDetailed(link('8443')).nodes[0];
  assert.ok(!plain.code);
  assert.equal(plain.outbound.server_port, 8443);
  const single = parseSubscriptionDetailed(link('443', '?mport=9443')).nodes[0];
  assert.ok(!single.code);
  assert.equal(single.outbound.server_port, 9443);
});

test('ядро 26.10.31 отвергает и диапазон в port, и udphop', { skip: !process.env.XRAY_TEST_BIN }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'karto-hy2-'));
  try {
    const base = {
      log: { loglevel: 'warning' },
      inbounds: [{ port: 2081, listen: '127.0.0.1', protocol: 'socks', settings: { udp: true } }]
    };
    // Both spellings of hopping are rejected while building the outbound, so the
    // app cannot ship them; the single-port control lives in the next test.
    // The core registers Hysteria2 as protocol "hysteria" with version 2.
    // A range in "port" is rejected; "udphop" is ignored by the JSON parser
    // (rc 0), so emitting it would silently keep one port and promise hopping.
    for (const extra of [{ port: '20000-30000' }, { udphop: { ports: '20000-30000', interval: 30 } }, { port: 8443 }]) {
      const config = {
        ...base,
        outbounds: [{
          protocol: 'hysteria',
          settings: { version: 2, address: '127.0.0.1', port: 443, ...extra },
          streamSettings: { network: 'hysteria', security: 'tls', hysteriaSettings: { version: 2, auth: 'x' } }
        }]
      };
      const file = join(dir, 'config.json');
      writeFileSync(file, JSON.stringify(config));
      const rejected = extra.port === '20000-30000';
      let failed = false;
      try { execFileSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-c', file], { stdio: 'pipe' }); } catch { failed = true; }
      assert.equal(failed, rejected, `config ${JSON.stringify(extra)}: rejected=${failed}, expected=${rejected}`);
      if (extra.udphop) assert.ok(!failed, 'udphop passes unnoticed, therefore the app must not emit it');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('конфиг с одним портом проходит xray run -test', { skip: !process.env.XRAY_TEST_BIN }, () => {
  const node = parseSubscriptionDetailed(link('8443')).nodes[0];
  const config = buildXrayConfig([node], node.id, 'all');
  const dir = mkdtempSync(join(tmpdir(), 'karto-hy2-one-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify(config));
    assert.doesNotThrow(() => execFileSync(process.env.XRAY_TEST_BIN, ['run', '-test', '-c', file], { stdio: 'pipe' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
