import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DNS_PROVIDERS, DNS_IP_URLS, FALLBACK_PROVIDER, RU_PROVIDER } from '../src/dns-providers.js';
import { renderModule } from '../scripts/gen-dns-providers.mjs';
import { buildXrayConfig, DOH_SERVERS } from '../src/xray-config.js';

const source = readFileSync(new URL('../shared/dns-providers.json', import.meta.url), 'utf8');
const parsed = JSON.parse(source);
const node = {
  id: 'n1',
  name: 'Test',
  outbound: {
    type: 'vless', server: '203.0.113.10', server_port: 443,
    uuid: '11111111-1111-1111-1111-111111111111',
    tls: { enabled: true, server_name: 'example.com' }
  }
};
const profile = { rules: [{ target: 'direct', domains: ['domain:ru'] }] };

test('src/dns-providers.js совпадает с shared/dns-providers.json', () => {
  const generated = readFileSync(new URL('../src/dns-providers.js', import.meta.url), 'utf8');
  assert.equal(generated, renderModule(source), 'перегенерируйте: node scripts/gen-dns-providers.mjs');
});

test('у каждого провайдера есть IPv4 bootstrap и IP-адрес для конфига ядра', () => {
  assert.ok(parsed.providers.length >= 4);
  for (const provider of parsed.providers) {
    assert.ok(provider.bootstrap.length >= 2, `${provider.id}: нужно минимум два IPv4`);
    for (const ip of provider.bootstrap) assert.match(ip, /^(\d{1,3}\.){3}\d{1,3}$/);
    assert.match(provider.ipUrl, /^https:\/\/(\d{1,3}\.){3}\d{1,3}\//, `${provider.id}: ipUrl должен быть по IP`);
    assert.ok((provider.bootstrapV6 || []).length >= 1, `${provider.id}: IPv6 из документации`);
    for (const ip of provider.bootstrapV6) assert.match(ip, /^[0-9a-f:]+$/i);
  }
  assert.ok(RU_PROVIDER.ru);
  assert.ok(!FALLBACK_PROVIDER.ru);
  assert.equal(DNS_IP_URLS.length, DNS_PROVIDERS.length);
});

test('builtin-конфиг не содержит имён DoH-серверов и шлёт DNS через прокси', () => {
  const config = buildXrayConfig([node], node.id, 'split', profile, { dns: 'builtin' });
  assert.equal(DOH_SERVERS.ru, RU_PROVIDER.ipUrl);
  const hosts = config.dns.servers.map((server) => new URL(server.address).hostname);
  for (const host of hosts) assert.match(host, /^(\d{1,3}\.){3}\d{1,3}$/);
  assert.deepEqual(config.routing.rules[0], { type: 'field', inboundTag: ['dns-query'], outboundTag: 'proxy' });
  assert.equal(config.routing.rules.filter((rule) => rule.inboundTag?.includes('dns-query')).length, 1);
});

test('в режиме Авто правило DNS уходит на балансировщик, а не на несуществующий тег', () => {
  const second = { ...node, id: 'n2', name: 'Second' };
  const config = buildXrayConfig([node, second], node.id, 'split', profile, { dns: 'builtin', auto: [node, second] });
  const rule = config.routing.rules.find((item) => item.inboundTag?.includes('dns-query'));
  assert.ok(rule, 'правило DNS есть');
  assert.equal(rule.outboundTag, undefined);
  assert.equal(rule.balancerTag, 'auto');
  assert.ok(config.routing.balancers.some((balancer) => balancer.tag === 'auto'));
});

test('без builtin-режима правило DNS не добавляется', () => {
  const config = buildXrayConfig([node], node.id, 'split', profile, { dns: 'system' });
  assert.equal(config.dns, undefined);
  assert.ok(!config.routing.rules.some((rule) => rule.inboundTag?.includes('dns-query')));
});
