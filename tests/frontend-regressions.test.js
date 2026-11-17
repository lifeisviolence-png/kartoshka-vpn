import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseSubscriptionDetailed, parseUserinfo, parseHappRouting } from '../src/subscription.js';
import { buildXrayConfig } from '../src/xray-config.js';
import { t, setLanguage, getLanguage, locale, errorText as localizedError, countryCodeFor } from '../src/i18n.js';
import { VERSION } from '../src/version.js';
import { icon } from '../src/icons.js';
import { countryByCode, countryLabel, flagPath, detectCountry, groupByCountry } from '../src/countries.js';
import { migrateState, snapshot, subscriptionIdFor, subscriptionNameFor, mergeSubscriptionNodes, removeSubscription, restoreSubscription, nodeEndpoint, mergeKey } from '../src/state-model.js';

// Fabricated credentials, domains and subscription URLs; no browser or npm test dependencies.
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';
const link = (uuid, host = 'one.example', name = 'Node', type = 'tcp') => `vless://${uuid}@${host}:443?type=${type}#${name}`;
const key = 'kartoshka.state.v2';
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '') + `\n;globalThis.hooks = { state, prepareImport, applyImport, runImport, applyPendingImport, importSummary, ensurePin, selectServer, toggleConnection, toggleDisabled, pingProxy, pingOne, pingAll, refreshSubscription, deleteSubscription, homeMarkup, serversMarkup, settingsMarkup, logsMarkup, statusInfo, nodeIdentity, nodeSignature, commitData, render, setLanguage, mergeKey, enrichCountries, handleHealth, failoverCandidate };`;

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
  const calls = { disconnect: 0, connect: 0, ping: 0, proxyPing: 0, pin: 0, configs: [], countries: 0, probes: 0 };
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
    async lookupCountries() { calls.countries++; return []; },
    async probeNodeLatency() { calls.probes++; return 25; },
    ...overrides
  };
  const context = {
    localStorage: store, document, window: { setInterval() {} }, CSS: { escape: (s) => s }, desktopBridge: bridge,
    parseSubscriptionDetailed, parseUserinfo, parseHappRouting, buildXrayConfig, t, setLanguage, getLanguage, locale, localizedError, countryCodeFor,
    icon, VERSION, countryByCode, countryLabel, flagPath, detectCountry, groupByCountry,
    migrateState, snapshot, subscriptionIdFor, subscriptionNameFor, mergeSubscriptionNodes, removeSubscription, restoreSubscription, nodeEndpoint, mergeKey,
    console, URL, Date, Number, setTimeout, JSON, navigator: { clipboard: { async writeText() {} } }
  };
  vm.runInNewContext(source, context, { filename: 'mock-main.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { ...context.hooks, store, calls, bridge, element, get html() { return html; } };
}
const snapshotOf = (h) => h.store.getItem(key);
const plain = (value) => JSON.parse(JSON.stringify(value));
const legacyNode = (uri) => parseSubscriptionDetailed(uri).nodes[0];
async function importAndApply(h, value) {
  const plan = await h.prepareImport(value);
  if (!plan.nodes.length && !plan.routingOnly) return { plan, result: null };
  return { plan, result: h.applyImport(plan) };
}
const subscriptionFixture = (nodes, extra = {}) => JSON.stringify({ ...extra, links: nodes });

test('legacy manual URI is migrated without deleting old keys, and a later subscription keeps it', async () => {
  const old = { ...legacyNode(link(U1)), source: 'subscription', favorite: true, customName: 'Old name' };
  const initial = { 'kartoshka.nodes': JSON.stringify([old]), 'kartoshka.selectedId': old.id, 'kartoshka.subscriptionUrl': link(U1), 'kartoshka.subscriptionMeta': '{"total":42}', 'kartoshka.routeMode': 'split', 'kartoshka.settings': '{"autoReconnect":true,"dnsMode":"custom"}' };
  const h = await setup({ initial, overrides: { async fetchSubscription() { return { body: link(U2, 'new.example', 'New'), userinfo: 'Upload=2; Download=3; Total=20' }; } } });
  assert.equal(h.state.servers[0].source, 'manual');
  assert.equal(h.state.subscriptions.length, 0, 'a direct URI is not a subscription');
  assert.equal(h.state.routeMode, 'split');
  assert.deepEqual(Object.fromEntries(Object.keys(initial).map((k) => [k, h.store.getItem(k)])), initial, 'legacy keys stay untouched');
  const migrated = JSON.parse(snapshotOf(h));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.nodes.length, 1);
  await importAndApply(h, 'https://provider.example/sub');
  assert.equal(h.state.servers.length, 2);
  assert.equal(h.state.subscriptions.length, 1);
  assert.equal(h.state.subscriptions[0].meta.used, 5);
  assert.equal(h.state.servers[0].favorite, true);
  assert.equal(h.state.servers[0].customName, 'Old name');
  assert.equal(h.state.selectedId, old.id);
  assert.equal(JSON.parse(snapshotOf(h)).routeMode, 'split');
  assert.deepEqual(JSON.parse(snapshotOf(h)).settings, { autoReconnect: true, dnsMode: 'custom' });
});

test('unreadable lines never reach storage: the plan is returned, applying is an explicit step', async () => {
  let body = link(U1), info = 'upload=10;download=11;total=100';
  const h = await setup({ overrides: { async fetchSubscription() { return { body, userinfo: info }; } } });
  await importAndApply(h, 'https://provider.example/sub');
  assert.equal(h.commitData({ servers: h.state.servers.map(n => ({ ...n, favorite: true })) }), true);
  const before = snapshotOf(h), beforeMemory = plain(h.state.servers);
  body = `${link(U2, 'two.example')}\ninvalid://broken`;
  const plan = await h.prepareImport('https://provider.example/sub');
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].key, 'sub.unsupportedScheme');
  assert.equal(plan.nodes.length, 1);
  assert.equal(snapshotOf(h), before, 'preparing must not write');
  assert.deepEqual(plain(h.state.servers), beforeMemory);
  await h.runImport('https://provider.example/sub', true);
  assert.equal(h.state.modal, 'result');
  assert.equal(snapshotOf(h), before, 'a refresh with errors waits for confirmation');
  h.applyPendingImport();
  assert.notEqual(snapshotOf(h), before, 'the confirmed import is applied');
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
  const { result } = await importAndApply(h, 'https://provider.example/sub');
  assert.equal(result.added, 0, 'a rotated credential updates the same server');
  assert.equal(result.kept, 2);
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
  const body = subscriptionFixture([link(U1, 'a.example', 'A')], profile);
  const h = await setup({ overrides: { async fetchSubscription() { return { body, userinfo: null }; } } });
  const { plan } = await importAndApply(h, 'https://provider.example/sub');
  assert.equal(plan.routing.rules.length, 2);
  assert.equal(h.state.routing.source, 'subscription');
  assert.equal(h.state.routing.profile.rules.length, 2);
  assert.equal(h.state.routeMode, 'auto');
  const node = h.state.servers[0];
  const config = buildXrayConfig([node], node.id, h.state.routeMode, h.state.routing.profile);
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
  assert.match(JSON.parse(snapshotOf(h)).nodes[0].outbound.tls.pinned_peer_cert_sha256, /^cd:cd:/);
});

test('an import with only unreadable lines reports the reasons and keeps storage', async () => {
  const h = await setup();
  const before = snapshotOf(h);
  const plan = await h.prepareImport('garbage-without-links');
  assert.equal(plan.nodes.length, 0);
  assert.equal(plan.errors[0].key, 'sub.notLinks');
  assert.equal(snapshotOf(h), before);
  h.applyImport(plan);
  assert.equal(h.state.modal, null);
  assert.equal(snapshotOf(h), before, 'an unreadable payload never writes');
});

test('Happ routing link updates routing without touching servers', async () => {
  const h = await setup({ initial: { [key]: JSON.stringify({ version: 2, nodes: [legacyNode(link(U1))], subscriptions: [], selectedId: legacyNode(link(U1)).id, routeMode: 'auto', settings: {}, language: 'ru' }) } });
  const payload = { routing: { rules: [{ type: 'field', domain: ['geosite:private'], outboundTag: 'direct' }] } };
  const happ = 'happ://routing/onadd/' + Buffer.from(JSON.stringify(payload)).toString('base64');
  const { plan, result } = await importAndApply(h, happ);
  assert.equal(plan.routingOnly, true);
  assert.equal(result.count, 0);
  assert.equal(h.state.servers.length, 1);
  assert.equal(h.state.routing.source, 'happ');
});

test('two subscriptions stay separate, deleting one removes only its servers, undo restores them', async () => {
  const bodies = { 'https://a.example/sub': link(U1, 'a.example', 'A'), 'https://b.example/sub': link(U2, 'b.example', 'B') };
  const h = await setup({ overrides: { async fetchSubscription(url) { return { body: bodies[url], userinfo: null }; } } });
  await importAndApply(h, 'https://a.example/sub');
  await importAndApply(h, 'https://b.example/sub');
  assert.equal(h.state.subscriptions.length, 2);
  assert.equal(h.state.servers.length, 2);
  const [first] = h.state.subscriptions;
  const removedId = h.state.servers.find(n => n.subscriptionId === first.id).id;
  await h.deleteSubscription(first.id);
  assert.equal(h.state.subscriptions.length, 1);
  assert.equal(h.state.servers.length, 1);
  assert.equal(h.state.servers.some(n => n.id === removedId), false);
  assert.equal(h.state.toast.actionLabel, 'Вернуть');
  h.state.toast.action();
  assert.equal(h.state.servers.length, 2);
  assert.equal(h.state.subscriptions.length, 2);
  assert.equal(JSON.parse(snapshotOf(h)).nodes.length, 2);
});

test('refresh reports added and removed counts and keeps favourites', async () => {
  let body = [link(U1, 'a.example', 'A'), link(U2, 'b.example', 'B')].join('\n');
  const h = await setup({ overrides: { async fetchSubscription() { return { body }; } } });
  await importAndApply(h, 'https://provider.example/sub');
  const kept = h.state.servers.find(n => n.outbound.server === 'b.example');
  h.commitData({ servers: h.state.servers.map(n => n.id === kept.id ? { ...n, favorite: true } : n) });
  body = [link(U1, 'a.example', 'A'), link(U3, 'c.example', 'C')].join('\n');
  const { result } = await importAndApply(h, 'https://provider.example/sub');
  assert.equal(result.added, 1, 'c.example is new');
  assert.equal(result.removed, 0, 'b.example is kept because it is a favourite');
  assert.equal(result.retained, 1, 'the favourite survives the provider removing it');
  assert.equal(h.state.servers.filter(n => n.source === 'subscription').length, 2);
  assert.equal(h.state.servers.find(n => n.outbound.server === 'b.example').favorite, true);
});

test('country flags are detected from the provider name before any network lookup', async () => {
  const body = [`vless://${U1}@de.example:443?type=tcp#🇩🇪 Frankfurt`, `vless://${U2}@pl.example:443?type=tcp#PL-1PL Польша Vless`].join('\n');
  const h = await setup({ overrides: { async fetchSubscription() { return { body }; } } });
  await importAndApply(h, 'https://provider.example/sub');
  const byHost = Object.fromEntries(h.state.servers.map(n => [n.outbound.server, n]));
  assert.equal(byHost['de.example'].countryCode, 'de');
  assert.equal(byHost['de.example'].countrySource, 'emoji');
  assert.equal(byHost['pl.example'].countryCode, 'pl');
  assert.equal(byHost['pl.example'].countrySource, 'name');
  const html = h.serversMarkup(byHost['de.example']);
  assert.match(html, /\/flags\/de\.svg/);
  assert.match(html, /Германия/);
});

const policyNodes = [
  { id: 'a', name: 'DE-1', country: 'DE' },
  { id: 'b', name: 'DE-2', country: 'DE' },
  { id: 'c', name: 'US-1', country: 'US' }
];
test('автопереключение: политика выбора узла для трёх режимов', async () => {
  const h = await setup();
  const pick = (mode, active, nodes = policyNodes) => h.failoverCandidate(nodes, active, mode, () => true);
  assert.equal(pick('never', policyNodes[0]), null);
  assert.equal(pick('country', policyNodes[0]).id, 'b');
  // No node of the same country: the policy must not silently change the country.
  assert.equal(pick('country', policyNodes[2]), null);
  assert.equal(pick('any', policyNodes[2]).id, 'a');
  // An unusable node is never chosen.
  const onlyBroken = [policyNodes[0], policyNodes[1]];
  assert.equal(h.failoverCandidate(onlyBroken, policyNodes[0], 'any', (node) => node.id !== 'b'), null);
});
test('автопереключение: «не переключать» оставляет узел и показывает notice.healthNoSwitch', async () => {
  const h = await setup({ native: true });
  await importAndApply(h, 'https://provider.example/sub', [link(U1, 'de1.example', 'DE-1'), link(U2, 'de2.example', 'DE-2')].join('\n'));
  h.state.connection = 'connected';
  h.state.bridgeReady = true;
  h.state.activeNode = h.state.servers[0];
  h.state.settings = { ...(h.state.settings || {}), failover: 'never' };
  await h.handleHealth('unhealthy', 'core stopped');
  assert.equal(h.state.activeNode.id, h.state.servers[0].id);
  assert.equal(h.state.message.key, 'notice.healthNoSwitch');
});
