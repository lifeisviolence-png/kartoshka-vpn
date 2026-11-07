import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseSubscriptionDetailed, parseUserinfo, parseHappRouting } from '../src/subscription.js';
import { buildXrayConfig } from '../src/xray-config.js';
import { t, setLanguage, getLanguage, locale, errorText as localizedError, countryCodeFor } from '../src/i18n.js';

// Fabricated credentials, domains and subscription URLs; no browser or npm test dependencies.
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';
const link = (uuid, host = 'one.example', name = 'Node', type = 'tcp') => `vless://${uuid}@${host}:443?type=${type}#${name}`;
const key = 'kartoshka.state.v1';
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '') + `\n;globalThis.hooks = { state, prepareImport, applyImport, runImport, applyPendingImport, importSummary, ensurePin, selectServer, toggleConnection, toggleDisabled, pingProxy, pingOne, homeMarkup, serversMarkup, statusInfo, nodeIdentity, nodeSignature, commitData, render, setLanguage };`;

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
    if (!elements.has(selector)) elements.set(selector, { handlers: {}, dataset: {}, addEventListener(name, cb) { this.handlers[name] = cb; }, focus() {}, setSelectionRange() {} });
    return elements.get(selector);
  }
  const document = { activeElement: null, querySelector: (s) => s === '#app' ? app : element(s), querySelectorAll: () => [], getElementById: () => null };
  const calls = { disconnect: 0, connect: 0, ping: 0, proxyPing: 0, pin: 0, configs: [] };
  const PIN = Array.from({ length: 32 }, () => 'cd').join(':');
  const bridge = {
    getCapabilities: () => ({ native }),
    async watchProxyExit() {},
    async disconnect() { calls.disconnect++; return { ok: true }; },
    async connect({ config }) { calls.connect++; calls.configs.push(config); return { ok: true }; },
    async probeInternet() { return '192.0.2.1'; },
    async pingNode() { calls.ping++; return 10; },
    async proxyLatency() { calls.proxyPing++; return 10; },
    async pinCertificate(args) { calls.pin++; calls.pinArgs = args; return PIN; },
    async fetchSubscription() { return { body: link(U1), userinfo: null }; },
    async readLogs() { return ''; },
    ...overrides
  };
  const context = { localStorage: store, document, window: { setInterval() {} }, CSS: { escape: (s) => s }, desktopBridge: bridge, parseSubscriptionDetailed, parseUserinfo, parseHappRouting, buildXrayConfig, t, setLanguage, getLanguage, locale, localizedError, countryCodeFor, console, URL, Date, Number, setTimeout, JSON };
  vm.runInNewContext(source, context, { filename: 'mock-main.js' });
  await new Promise((resolve) => setImmediate(resolve));
  return { ...context.hooks, store, calls, bridge, element, get html() { return html; } };
}
const snapshot = (h) => h.store.getItem(key);
const plain = (value) => JSON.parse(JSON.stringify(value));
const legacyNode = (uri) => parseSubscriptionDetailed(uri).nodes[0];
async function importAndApply(h, value) {
  const plan = await h.prepareImport(value);
  if (!plan.nodes.length && !plan.routingOnly) return { plan, result: null };
  return { plan, result: h.applyImport(plan) };
}

test('legacy manual URI is migrated without deleting old keys, and HTTP refresh preserves it', async () => {
  const old = { ...legacyNode(link(U1)), source: 'subscription', favorite: true, customName: 'Old name' };
  const initial = { 'kartoshka.nodes': JSON.stringify([old]), 'kartoshka.selectedId': old.id, 'kartoshka.subscriptionUrl': link(U1), 'kartoshka.subscriptionMeta': '{"total":42}', 'kartoshka.routeMode': 'split', 'kartoshka.settings': '{"autoReconnect":true,"dnsMode":"custom"}' };
  const h = await setup({ initial, overrides: { async fetchSubscription() { return { body: link(U2, 'new.example', 'New'), userinfo: 'Upload=2; Download=3; Total=20' }; } } });
  assert.equal(h.state.servers[0].source, 'manual');
  assert.equal(h.state.subscriptionUrl, '');
  assert.equal(h.state.subscriptionMeta, null);
  assert.equal(h.state.routeMode, 'split');
  assert.deepEqual(Object.fromEntries(Object.keys(initial).map((k) => [k, h.store.getItem(k)])), initial);
  await importAndApply(h, 'https://provider.example/sub');
  assert.equal(h.state.servers.length, 2);
  assert.equal(h.state.servers[0].favorite, true);
  assert.equal(h.state.servers[0].customName, 'Old name');
  assert.equal(h.state.selectedId, old.id);
  assert.equal(h.state.subscriptionMeta.used, 5);
  assert.equal(JSON.parse(snapshot(h)).routeMode, 'split');
  assert.deepEqual(JSON.parse(snapshot(h)).settings, { autoReconnect: true, dnsMode: 'custom' });
});

test('unreadable lines never reach storage: the plan is returned, applying is an explicit step', async () => {
  let body = link(U1), info = 'upload=10;download=11;total=100';
  const h = await setup({ overrides: { async fetchSubscription() { return { body, userinfo: info }; } } });
  await importAndApply(h, 'https://provider.example/sub');
  assert.equal(h.commitData({ servers: h.state.servers.map(n => ({ ...n, favorite: true })) }), true);
  const before = snapshot(h), beforeMemory = plain(h.state.servers);
  body = `${link(U2, 'two.example')}\ninvalid://broken`;
  const plan = await h.prepareImport('https://provider.example/sub');
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].key, 'sub.unsupportedScheme');
  assert.equal(plan.nodes.length, 1);
  assert.equal(snapshot(h), before, 'preparing must not write');
  assert.deepEqual(plain(h.state.servers), beforeMemory);
  await h.runImport('https://provider.example/sub', true);
  assert.equal(h.state.modal, 'result');
  assert.equal(snapshot(h), before, 'a refresh with errors waits for confirmation');
  h.applyPendingImport();
  assert.notEqual(snapshot(h), before, 'the confirmed import is applied');
});

test('a failed refresh reports the error without leaking the subscription URL', async () => {
  const h = await setup({ overrides: { async fetchSubscription() { throw new Error('network down'); } } });
  await h.runImport('https://provider.example/sub', true);
  assert.match(h.state.notice.text, /Не удалось обновить подписку/);
  assert.doesNotMatch(h.state.notice.text, /provider\.example/);
  assert.match(h.state.notice.text, /network down/);
});

test('UUID rotation and reordering preserve selected and favorite by endpoint and transport', async () => {
  let body = [link(U1, 'a.example', 'A'), link(U2, 'b.example', 'B')].join('\n');
  const h = await setup({ overrides: { async fetchSubscription() { return { body }; } } });
  await importAndApply(h, 'https://provider.example/sub');
  const [a, b] = h.state.servers;
  h.commitData({ servers: h.state.servers.map(n => n.id === a.id ? { ...n, favorite: true, customName: 'Saved' } : n), selectedId: a.id });
  body = [link(U3, 'b.example', 'B'), link(U4, 'a.example', 'A')].join('\n');
  await importAndApply(h, 'https://provider.example/sub');
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
  await importAndApply(h, 'https://provider.example/sub');
  const id = h.state.servers[0].id;
  h.commitData({ servers: h.state.servers.map(n => n.id === id ? { ...n, favorite: true, customName: 'Do not move' } : n), selectedId: id });
  body = [link(U3, 'shared.example', 'Three'), link(U4, 'shared.example', 'Four')].join('\n');
  const { result } = await importAndApply(h, 'https://provider.example/sub');
  assert.equal(result.retained, 1);
  assert.equal(h.state.selectedId, id);
  const retained = h.state.servers.find(n => n.source === 'subscription-retained');
  assert.equal(retained.customName, 'Do not move');
});

test('subscription routing profile is stored and used to build the tunnel rules', async () => {
  const profile = { routing: { rules: [{ type: 'field', domain: ['geosite:private'], outboundTag: 'direct' }, { type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' }] } };
  const body = JSON.stringify({ ...profile, links: [link(U1, 'a.example', 'A')] });
  const h = await setup({ overrides: { async fetchSubscription() { return { body, userinfo: null }; } } });
  const { plan } = await importAndApply(h, 'https://provider.example/sub');
  assert.equal(plan.routing.rules.length, 2);
  assert.equal(h.state.subscriptionMeta.routingSource, 'subscription');
  assert.equal(h.state.routeMode, 'auto');
  h.state.connection = 'connected';
  h.state.activeNode = h.state.servers[0];
  await h.toggleConnection(); // disconnect path only
  h.state.connection = 'idle';
  const node = h.state.servers[0];
  const config = buildXrayConfig([node], node.id, h.state.routeMode, h.state.subscriptionMeta.routing);
  assert.deepEqual(config.outbounds.map(o => o.tag), ['proxy', 'direct', 'block']);
});

test('import summary and language switch are applied immediately and saved', async () => {
  const h = await setup();
  const summary = h.importSummary({ count: 2, duplicates: 0, unsupported: 0, retained: 0, skipped: 0 });
  assert.match(summary, /Импортировано: 2/);
  h.state.notice = null;
  h.setLanguage('en');
  h.render();
  assert.match(h.html, /Servers/);
  assert.match(h.html, /Settings/);
  assert.equal(getLanguage(), 'en');
  h.setLanguage('ru');
});

test('a node that needs a certificate pin is pinned before connecting and stored', async () => {
  const insecure = `vless://${U1}@pin.example:443?type=ws&security=tls&sni=pin.example&path=%2Fws&allowInsecure=1#Pinned`;
  const h = await setup({ native: true, overrides: { async fetchSubscription() { return { body: insecure, userinfo: null }; } } });
  await importAndApply(h, 'https://provider.example/sub');
  const node = h.state.servers[0];
  assert.equal(node.needsPin, true);
  h.state.connection = 'idle';
  h.state.bridgeReady = true;
  await h.toggleConnection();
  assert.equal(h.calls.pin, 1);
  assert.equal(h.calls.pinArgs.host, 'pin.example');
  assert.equal(h.calls.connect, 1);
  const sent = h.calls.configs[0];
  assert.match(sent.outbounds[0].streamSettings.tlsSettings.pinnedPeerCertSha256, /^cd:cd:/);
  assert.equal(h.state.servers[0].needsPin, false);
  assert.match(JSON.parse(snapshot(h)).nodes[0].outbound.tls.pinned_peer_cert_sha256, /^cd:cd:/);
});

test('an import with only unreadable lines reports the reasons and keeps storage', async () => {
  const h = await setup();
  const before = snapshot(h);
  const plan = await h.prepareImport('garbage-without-links');
  assert.equal(plan.nodes.length, 0);
  assert.equal(plan.errors[0].key, 'sub.notLinks');
  assert.equal(snapshot(h), before);
  h.applyImport(plan);
  assert.equal(h.state.modal, null);
  assert.equal(snapshot(h), before, 'an unreadable payload never writes');
});

test('Happ routing link updates routing without touching servers', async () => {
  const h = await setup({ initial: { [key]: JSON.stringify({ version: 1, nodes: [legacyNode(link(U1))], selectedId: legacyNode(link(U1)).id, subscriptionUrl: 'https://provider.example/sub', subscriptionMeta: { total: 1 }, routeMode: 'auto', settings: {}, language: 'ru' }) } });
  const payload = { routing: { rules: [{ type: 'field', domain: ['geosite:private'], outboundTag: 'direct' }] } };
  const happ = 'happ://routing/onadd/' + Buffer.from(JSON.stringify(payload)).toString('base64');
  const { plan, result } = await importAndApply(h, happ);
  assert.equal(plan.routingOnly, true);
  assert.equal(result.count, 0);
  assert.equal(h.state.servers.length, 1);
  assert.equal(h.state.subscriptionMeta.routingSource, 'happ');
});
