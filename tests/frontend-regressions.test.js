import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseSubscriptionDetailed, parseUserinfo } from '../src/subscription.js';
import { buildXrayConfig } from '../src/xray-config.js';

// Fabricated credentials, domains and subscription URLs; no browser or npm test dependencies.
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';
const link = (uuid, host = 'one.example', name = 'Node', type = 'tcp') => `vless://${uuid}@${host}:443?type=${type}#${name}`;
const key = 'kartoshka.state.v1';
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '') + `\n;globalThis.hooks = { state, importConfig, runImport, selectServer, toggleConnection, toggleDisabled, pingProxy, pingOne, homeMarkup, serversMarkup, statusInfo, nodeIdentity, nodeSignature, commitData, render };`;

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data, fail: false, writes: 0,
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { this.writes++; if (this.fail) throw new Error('quota containing private url'); data.set(k, String(v)); }
  };
}
async function setup({ initial = {}, native = false, overrides = {}, store = storage(initial) } = {}) {
  let html = '', elements = new Map();
  const app = {};
  Object.defineProperty(app, 'innerHTML', { get: () => html, set: (value) => { html = value; elements = new Map(); } });
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, { handlers: {}, addEventListener(name, cb) { this.handlers[name] = cb; }, focus() {}, setSelectionRange() {} });
    return elements.get(selector);
  }
  const document = { activeElement: null, querySelector: (s) => s === '#app' ? app : element(s), querySelectorAll: () => [], getElementById: () => null };
  const calls = { disconnect: 0, connect: 0, ping: 0, proxyPing: 0 };
  const bridge = {
    getCapabilities: () => ({ native }),
    async watchProxyExit() {},
    async disconnect() { calls.disconnect++; return { ok: true }; },
    async connect() { calls.connect++; return { ok: true }; },
    async probeInternet() { return '192.0.2.1'; },
    async pingNode() { calls.ping++; return 10; },
    async proxyLatency() { calls.proxyPing++; return 10; },
    async fetchSubscription() { return { body: link(U1), userinfo: null }; },
    async readLogs() { return ''; },
    ...overrides
  };
  const context = { localStorage: store, document, window: { setInterval() {} }, CSS: { escape: (s) => s }, desktopBridge: bridge, parseSubscriptionDetailed, parseUserinfo, buildXrayConfig, console, URL, Date, Number, setTimeout };
  vm.runInNewContext(source, context, { filename: 'mock-main.js' });
  await new Promise((resolve) => setImmediate(resolve));
  return { ...context.hooks, store, calls, bridge, element, get html() { return html; } };
}
const snapshot = (h) => h.store.getItem(key);
const plain = (value) => JSON.parse(JSON.stringify(value));
const legacyNode = (uri) => parseSubscriptionDetailed(uri).nodes[0];

test('legacy manual URI is migrated without deleting old keys, and HTTP refresh preserves it', async () => {
  const old = { ...legacyNode(link(U1)), source: 'subscription', favorite: true, customName: 'Old name' };
  const initial = { 'kartoshka.nodes': JSON.stringify([old]), 'kartoshka.selectedId': old.id, 'kartoshka.subscriptionUrl': link(U1), 'kartoshka.subscriptionMeta': '{"total":42}', 'kartoshka.routeMode': 'split', 'kartoshka.settings': '{"autoReconnect":true,"dnsMode":"custom"}' };
  const h = await setup({ initial, overrides: { async fetchSubscription() { return { body: link(U2, 'new.example', 'New'), userinfo: 'Upload=2; Download=3; Total=20' }; } } });
  assert.equal(h.state.servers[0].source, 'manual');
  assert.equal(h.state.subscriptionUrl, '');
  assert.equal(h.state.subscriptionMeta, null);
  assert.equal(h.state.routeMode, 'split');
  assert.deepEqual(Object.fromEntries(Object.keys(initial).map((k) => [k, h.store.getItem(k)])), initial);
  await h.importConfig('https://provider.example/sub');
  assert.equal(h.state.servers.length, 2);
  assert.equal(h.state.servers[0].favorite, true);
  assert.equal(h.state.servers[0].customName, 'Old name');
  assert.equal(h.state.selectedId, old.id);
  assert.equal(h.state.subscriptionMeta.used, 5);
  assert.equal(JSON.parse(snapshot(h)).routeMode, 'split');
  assert.deepEqual(JSON.parse(snapshot(h)).settings, { autoReconnect: true, dnsMode: 'custom' });
});

test('subscription refresh and manual partial input are rejected atomically', async () => {
  let body = link(U1), info = 'upload=10;download=11;total=100';
  const h = await setup({ overrides: { async fetchSubscription() { return { body, userinfo: info }; } } });
  await h.importConfig('https://provider.example/sub');
  assert.equal(h.commitData({ servers: h.state.servers.map(n => ({ ...n, favorite: true })) }), true);
  const before = snapshot(h), beforeMemory = plain(h.state.servers);
  body = `${link(U2, 'two.example')}\ninvalid://broken`;
  info = 'upload=50;download=50;total=1000';
  await assert.rejects(h.importConfig('https://provider.example/sub'), /Импорт отменён/);
  assert.equal(snapshot(h), before);
  assert.deepEqual(plain(h.state.servers), beforeMemory);
  await assert.rejects(h.importConfig(`${link(U3)}\ninvalid://broken`), /Импорт отменён/);
  assert.equal(snapshot(h), before);
  await h.runImport('https://provider.example/sub', true);
  assert.match(h.state.notice.text, /не удалось обновить/i);
  assert.doesNotMatch(h.state.notice.text, /provider\.example/);
});

test('UUID rotation and reordering preserve selected and favorite by endpoint and transport', async () => {
  let body = [link(U1, 'a.example', 'A'), link(U2, 'b.example', 'B')].join('\n');
  const h = await setup({ overrides: { async fetchSubscription() { return { body }; } } });
  await h.importConfig('https://provider.example/sub');
  const [a, b] = h.state.servers;
  h.commitData({ servers: h.state.servers.map(n => n.id === a.id ? { ...n, favorite: true, customName: 'Saved' } : n), selectedId: a.id });
  body = [link(U3, 'b.example', 'B'), link(U4, 'a.example', 'A')].join('\n');
  await h.importConfig('https://provider.example/sub');
  const byHost = Object.fromEntries(h.state.servers.map(n => [n.outbound.server, n]));
  assert.equal(byHost['a.example'].id, a.id);
  assert.equal(byHost['a.example'].favorite, true);
  assert.equal(byHost['a.example'].customName, 'Saved');
  assert.equal(byHost['b.example'].id, b.id);
  assert.equal(h.state.selectedId, a.id);
  assert.equal(byHost['a.example'].outbound.uuid, U4);
});

test('different transport is not a match; ambiguous rotated endpoints retain old settings separately', async () => {
  let body = [link(U1, 'shared.example', 'One'), link(U2, 'shared.example', 'Two')].join('\n');
  const h = await setup({ overrides: { async fetchSubscription() { return { body }; } } });
  await h.importConfig('https://provider.example/sub');
  const id = h.state.servers[0].id;
  h.commitData({ servers: h.state.servers.map(n => n.id === id ? { ...n, favorite: true, customName: 'Do not move' } : n), selectedId: id });
  body = [link(U3, 'shared.example', 'Three'), link(U4, 'shared.example', 'Four')].join('\n');
  const result = await h.importConfig('https://provider.example/sub');
  assert.equal(result.retained, 1);
  assert.equal(h.state.selectedId, id);
  assert.equal(h.state.servers.find(n => n.id === id).source, 'subscription-retained');
  assert.equal(h.state.servers.find(n => n.id === id).customName, 'Do not move');
  assert.ok(h.state.servers.filter(n => n.source === 'subscription').every(n => !n.favorite && !n.customName));
  await h.importConfig('https://provider.example/sub');
  assert.equal(h.state.servers.find(n => n.id === id).favorite, true);
  const old = legacyNode(link(U1, 'same.example', 'A', 'tcp'));
  const ws = legacyNode(link(U3, 'same.example', 'A', 'ws'));
  assert.notEqual(h.nodeIdentity(old), h.nodeIdentity(ws));
});

test('manual duplicate of subscription becomes independent node; counts exclude true duplicates', async () => {
  let body = link(U1);
  const h = await setup({ overrides: { async fetchSubscription() { return { body }; } } });
  await h.importConfig('https://provider.example/sub');
  const first = await h.importConfig(`${link(U1)}\n${link(U1)}`);
  assert.equal(first.count, 1); assert.equal(first.duplicates, 1);
  assert.equal(h.state.servers.length, 2);
  assert.notEqual(h.state.servers[0].id, h.state.servers[1].id);
  assert.equal(h.state.servers[1].source, 'manual');
  const second = await h.importConfig(link(U1));
  assert.equal(second.count, 0); assert.equal(second.duplicates, 1);
  body = link(U2, 'other.example');
  await h.importConfig('https://provider.example/sub');
  assert.equal(h.state.servers.filter(n => n.source === 'manual' && n.outbound.uuid === U1).length, 1);
  await h.runImport(link(U1), false);
  assert.match(h.state.notice.text, /Импортировано: 0; пропущено дубликатов: 1/);
});

test('all persistent edits roll back memory and snapshot when setItem fails', async () => {
  let body = [link(U1), link(U2, 'two.example')].join('\n');
  const h = await setup({ overrides: { async fetchSubscription() { return { body, userinfo: 'upload=1;download=2;total=10' }; } } });
  await h.importConfig('https://provider.example/sub');
  const before = snapshot(h), originalServers = plain(h.state.servers), originalSelected = h.state.selectedId;
  h.store.fail = true;
  body = link(U3, 'three.example');
  await assert.rejects(h.importConfig('https://new.example/secret'), /сохранить данные/);
  assert.equal(snapshot(h), before); assert.deepEqual(plain(h.state.servers), originalServers);
  assert.equal(h.state.subscriptionUrl, 'https://provider.example/sub');
  await h.selectServer(h.state.servers[1].id);
  assert.equal(h.state.selectedId, originalSelected); assert.equal(snapshot(h), before);
  h.render(); h.element('[data-action="favorite"]').handlers.click();
  assert.equal(h.state.servers[0].favorite, false); assert.equal(snapshot(h), before);
  h.element('[data-action="remove"]').handlers.click();
  assert.equal(h.state.servers.length, 2); assert.equal(snapshot(h), before);
  h.element('#route-mode').handlers.change({ target: { value: 'split' } });
  assert.equal(h.state.routeMode, 'all'); assert.equal(snapshot(h), before);
  assert.match(h.state.notice.text, /сохранить данные/);
  assert.doesNotMatch(h.state.notice.text, /private url/);
});

test('failed initial migration keeps every old key and retry persists migrated data', async () => {
  const uri = link(U1), node = legacyNode(uri);
  const initial = { 'kartoshka.nodes': JSON.stringify([node]), 'kartoshka.subscriptionUrl': uri, 'kartoshka.selectedId': node.id };
  const store = storage(initial); store.fail = true;
  const h = await setup({ store });
  assert.equal(store.getItem(key), null);
  assert.deepEqual(Object.fromEntries(store.data), initial);
  assert.equal(h.state.servers[0].source, 'manual');
  assert.match(h.state.notice.text, /Старые данные/);
  store.fail = false;
  assert.equal(h.commitData({ routeMode: 'split' }), true);
  assert.equal(JSON.parse(snapshot(h)).nodes[0].source, 'manual');
  assert.equal(store.getItem('kartoshka.subscriptionUrl'), uri);
});

test('cleanup remains available on watcher failure; success does not enable a new connection', async () => {
  let attempts = 0, connect = 0;
  const h = await setup({ native: true, overrides: {
    async watchProxyExit() { throw new Error('event unavailable'); },
    async disconnect() { if (++attempts === 1) throw new Error('restore failed'); return { ok: true }; },
    async connect() { connect++; return { ok: true }; }
  } });
  assert.equal(h.state.bridgeReady, false); assert.equal(h.state.cleanupNeeded, true);
  assert.equal(h.toggleDisabled(null), false);
  await h.toggleConnection();
  assert.equal(attempts, 2); assert.equal(h.state.cleanupNeeded, false);
  assert.equal(h.state.connection, 'error');
  assert.match(h.state.message, /мониторинг Xray недоступен/);
  h.state.servers = [legacyNode(link(U1))]; h.state.selectedId = h.state.servers[0].id;
  assert.equal(h.toggleDisabled(h.state.servers[0]), true);
  await h.toggleConnection(); assert.equal(connect, 0);
});

test('failed proxy check stays connected but never claims health; warning is session-scoped', async () => {
  let mode = 'fail', connects = 0, disconnects = 0;
  const h = await setup({ native: true, overrides: {
    async proxyLatency() { if (mode === 'fail') throw new Error('timeout'); return 23; },
    async connect() { connects++; }, async disconnect() { disconnects++; return { ok: true }; }
  } });
  const a = legacyNode(link(U1, 'a.example', 'Active'));
  const b = legacyNode(link(U2, 'b.example', 'Selected'));
  Object.assign(h.state, { connection: 'connected', activeNode: a, servers: [a, b], selectedId: b.id, externalIp: '192.0.2.1' });
  const baseline = disconnects;
  await h.pingProxy();
  assert.equal(h.state.connection, 'connected'); assert.equal(h.state.proxyCheckFailed, true);
  assert.match(h.homeMarkup(b), /Последняя проверка прокси не пройдена/);
  assert.match(h.homeMarkup(b), /АКТИВНЫЙ СЕРВЕР/);
  assert.doesNotMatch(h.homeMarkup(b), /работает через выбранный сервер/i);
  assert.match(h.serversMarkup(b), /Последняя проверка прокси не пройдена/);
  assert.equal(connects, 0); assert.equal(disconnects, baseline);
  mode = 'success'; await h.pingProxy();
  assert.equal(h.state.proxyCheckFailed, false); assert.equal(h.state.proxyPing, 23);
  assert.equal(h.state.notice, null);
});

test('Hysteria2 UDP does not run a misleading TCP test', async () => {
  const h = await setup({ native: true });
  const uri = 'hy2://fixture@example.test:443#UDP';
  await h.importConfig(uri);
  const node = h.state.servers[0];
  assert.match(h.serversMarkup(node), /TCP-тест неприменим/);
  assert.match(h.serversMarkup(node), /data-action="ping" disabled/);
  await h.pingOne(node); assert.equal(h.calls.ping, 0);
  assert.notEqual(node.availability, 'offline');
});

test('unsupported Hysteria2 links with empty outbound remain distinct and errors omit credentials', async () => {
  const h = await setup();
  const a = 'hysteria2://fixture-secret-A@example.test:100-200#A';
  const b = 'hysteria2://fixture-secret-B@example.test:300-400#B';
  const result = await h.importConfig(`${a}\n${b}\n${a}`);
  assert.equal(result.count, 2); assert.equal(result.duplicates, 1); assert.equal(result.unsupported, 2);
  assert.equal(h.state.servers.length, 2);
  assert.notEqual(h.nodeSignature(h.state.servers[0]), h.nodeSignature(h.state.servers[1]));
  await h.runImport(`${a}\n${b}`, false);
  assert.doesNotMatch(h.state.notice.text, /fixture-secret|hysteria2:\/\//);
  const badExtra = `${link(U1).replace('?type=tcp', '?type=xhttp&extra=%7B%22fixture-secret%22%3A1%7D')}`;
  assert.doesNotMatch(JSON.stringify(parseSubscriptionDetailed(badExtra).errors), /fixture-secret/);
});

test('geography only uses explicit country flags, never Ukraine substring as UK', () => {
  const ukraine = legacyNode(link(U1, 'ukraine.example', 'Ukraine'));
  assert.notEqual(ukraine.country, 'Великобритания');
  assert.equal(ukraine.country, '');
  const flagged = legacyNode(link(U1, 'example.test', encodeURIComponent('🇺🇦 Ukraine')));
  assert.equal(flagged.country, 'Украина'); assert.equal(flagged.flag, '🇺🇦');
});

test('userinfo normalizes case and does not fabricate values for incomplete or invalid data', () => {
  assert.equal(parseUserinfo('Upload=20; DOWNLOAD=30; TOTAL=100').used, 50);
  assert.equal(parseUserinfo('Upload=20; DOWNLOAD=30; TOTAL=100').total, 100);
  assert.equal(parseUserinfo('upload=20; total=100').used, null);
  assert.equal(parseUserinfo('upload=0; download=0').used, 0);
  assert.equal(parseUserinfo('upload=1; download=2').total, null);
  assert.equal(parseUserinfo('upload=1; download=invalid; total=-1').used, null);
  assert.equal(parseUserinfo('total=oops').total, null);
  assert.equal(parseUserinfo('upload=9007199254740991; download=1').used, null);
  assert.equal(parseUserinfo('upload=1; upload=2; download=1').used, null);
});

test('subscription network failure cannot expose its URL or underlying secret', async () => {
  const secret = 'https://provider.example/sub?token=fixture-secret';
  const h = await setup({ overrides: { async fetchSubscription() { throw new Error(`failed ${secret}`); } } });
  await h.runImport(secret, true);
  assert.doesNotMatch(h.state.notice.text, /provider|fixture-secret|https:/);
});

test('asynchronous import reconciles with a selection made while fetch is pending', async () => {
  let finish;
  const h = await setup({ overrides: { fetchSubscription: () => new Promise((resolve) => { finish = resolve; }) } });
  await h.importConfig([link(U1), link(U2, 'two.example')].join('\n'));
  const second = h.state.servers[1].id;
  const pending = h.importConfig('https://provider.example/sub');
  await h.selectServer(second);
  finish({ body: link(U3, 'three.example') });
  await pending;
  assert.equal(h.state.selectedId, second);
  assert.equal(JSON.parse(snapshot(h)).selectedId, second);
});

test('normal native connection, server switch, and process exit retain the expected lifecycle', async () => {
  let exitHandler, disconnects = 0;
  const configs = [];
  const h = await setup({ native: true, overrides: {
    async watchProxyExit(callback) { exitHandler = callback; },
    async disconnect() { disconnects++; return { ok: true }; },
    async connect({ config }) { configs.push(config); return { ok: true }; },
    async probeInternet() { return '192.0.2.5'; }
  } });
  await h.importConfig([link(U1, 'a.example', 'A'), link(U2, 'b.example', 'B')].join('\n'));
  const [a, b] = h.state.servers;
  await h.toggleConnection();
  assert.equal(h.state.connection, 'connected'); assert.equal(h.state.activeNode.id, a.id);
  assert.equal(configs[0].outbounds[0].settings.address, 'a.example');
  await h.selectServer(b.id);
  assert.equal(h.state.connection, 'connected'); assert.equal(h.state.selectedId, b.id);
  assert.equal(h.state.activeNode.id, b.id); assert.equal(configs[1].outbounds[0].settings.address, 'b.example');
  assert.equal(disconnects, 2); // Startup restoration and switch.
  exitHandler('Xray завершился');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.connection, 'error'); assert.equal(h.state.activeNode, null);
  assert.equal(disconnects, 3); assert.match(h.state.message, /завершился/);
});
