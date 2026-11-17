import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscriptionDetailed } from '../src/subscription.js';
import { migrateState, snapshot, subscriptionIdFor, mergeSubscriptionNodes, removeSubscription, restoreSubscription, mergeKey, nodeIdentityKey, STATE_VERSION } from '../src/state-model.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const node = (uuid, host, name = host) => parseSubscriptionDetailed(`vless://${uuid}@${host}:443?type=tcp#${name}`).nodes[0];

test('v1 state becomes a v2 subscription without losing nodes or routing', () => {
  const raw = {
    version: 1,
    nodes: [{ ...node(U1, 'a.example'), id: 'a', source: 'subscription', favorite: true }],
    selectedId: 'a',
    subscriptionUrl: 'https://provider.example/sub',
    subscriptionMeta: { total: 100, used: 10, routing: { rules: [] }, routingSource: 'subscription', routingUnsupported: [{ index: 1 }], routingDns: true },
    routeMode: 'split',
    settings: { autoReconnect: true },
    language: 'en'
  };
  const { state, migrated } = migrateState(raw);
  assert.equal(migrated, true);
  assert.equal(state.version, STATE_VERSION);
  assert.equal(state.subscriptions.length, 1);
  assert.equal(state.subscriptions[0].id, subscriptionIdFor('https://provider.example/sub'));
  assert.equal(state.nodes[0].subscriptionId, state.subscriptions[0].id);
  assert.equal(state.nodes[0].favorite, true);
  assert.equal(state.routeMode, 'split');
  assert.equal(state.language, 'en');
  assert.deepEqual(state.settings, { autoReconnect: true });
  assert.equal(state.routing.source, 'subscription');
  assert.equal(state.routing.unsupported.length, 1);
  assert.equal(state.routing.dns, true);
});

test('a direct proxy URI stored as subscriptionUrl stays manual', () => {
  const uri = `vless://${U1}@a.example:443?type=tcp#A`;
  const { state } = migrateState({ version: 1, nodes: [{ ...node(U1, 'a.example'), id: 'a', source: 'subscription' }], subscriptionUrl: uri });
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.nodes[0].subscriptionId, null);
  assert.equal(state.nodes[0].source, 'manual');
});

test('a v2 node pointing at a missing subscription becomes manual', () => {
  const { state, migrated } = migrateState({ version: 2, subscriptions: [], nodes: [{ ...node(U1, 'a.example'), id: 'a', subscriptionId: 'gone' }] });
  assert.equal(migrated, false);
  assert.equal(state.nodes[0].subscriptionId, null);
  assert.equal(state.nodes[0].source, 'manual');
});

test('snapshot drops volatile measurements but keeps durable fields', () => {
  const { state } = migrateState({ version: 2, subscriptions: [], nodes: [{ ...node(U1, 'a.example'), id: 'a', ping: 42, availability: 'online', proxyPing: 7 }], selectedId: 'a', settings: { debug: true }, language: 'en' });
  const saved = snapshot(state);
  assert.equal(saved.nodes[0].ping, undefined);
  assert.equal(saved.nodes[0].availability, undefined);
  assert.equal(saved.nodes[0].proxyPing, undefined);
  assert.equal(saved.settings.debug, true);
  assert.equal(saved.language, 'en');
  assert.equal(saved.version, 2);
});

test('merge adds new servers, updates rotated credentials and keeps favourites', () => {
  const first = { ...node(U1, 'a.example'), id: 'a', subscriptionId: 's' };
  const second = { ...node(U2, 'b.example'), id: 'b', subscriptionId: 's', favorite: true, customName: 'Saved' };
  const incoming = [node(U3, 'a.example'), node(U2, 'b.example')];
  const result = mergeSubscriptionNodes({ nodes: [first, second], incoming, subscriptionId: 's', selectedId: 'b' });
  assert.equal(result.added, 0, 'a.example kept its id through the credential rotation');
  assert.equal(result.kept, 2);
  assert.equal(result.removed, 0);
  const a = result.nodes.find((item) => item.outbound.server === 'a.example');
  assert.equal(a.id, 'a');
  assert.equal(a.outbound.uuid, U3);
  const b = result.nodes.find((item) => item.outbound.server === 'b.example');
  assert.equal(b.favorite, true);
  assert.equal(b.customName, 'Saved');
});

test('merge removes servers that disappeared and retains the selected one', () => {
  const first = { ...node(U1, 'a.example'), id: 'a', subscriptionId: 's' };
  const second = { ...node(U2, 'b.example'), id: 'b', subscriptionId: 's' };
  const result = mergeSubscriptionNodes({ nodes: [first, second], incoming: [node(U1, 'a.example')], subscriptionId: 's', selectedId: 'b' });
  assert.equal(result.removed, 0);
  assert.equal(result.retained, 1);
  assert.equal(result.nodes.find((item) => item.id === 'b').source, 'subscription-retained');
});

test('ids never collide across subscriptions', () => {
  const manual = { ...node(U1, 'same.example'), id: 'node-0-same-example', subscriptionId: null, source: 'manual' };
  const result = mergeSubscriptionNodes({ nodes: [manual], incoming: [node(U2, 'same.example')], subscriptionId: 's', selectedId: null });
  const imported = result.nodes.find((item) => item.subscriptionId === 's');
  assert.notEqual(imported.id, 'node-0-same-example');
  assert.equal(new Set(result.nodes.map((item) => item.id)).size, 2);
});

test('deleting and restoring a subscription keeps its servers intact', () => {
  const first = { ...node(U1, 'a.example'), id: 'a', subscriptionId: 's1' };
  const second = { ...node(U2, 'b.example'), id: 'b', subscriptionId: 's2' };
  const state = { nodes: [first, second], subscriptions: [{ id: 's1', name: 'One', url: 'https://one.example' }, { id: 's2', name: 'Two', url: 'https://two.example' }], selectedId: 'a' };
  const next = removeSubscription(state, 's1');
  assert.equal(next.nodes.length, 1);
  assert.equal(next.subscriptions.length, 1);
  assert.equal(next.selectedId, 'b');
  const restored = restoreSubscription({ nodes: next.nodes, subscriptions: next.subscriptions, selectedId: next.selectedId }, { subscription: state.subscriptions[0], nodes: [first], selectedId: 'a' });
  assert.equal(restored.nodes.length, 2);
  assert.equal(restored.subscriptions.length, 2);
  assert.equal(restored.nodes.find((item) => item.id === 'a').subscriptionId, 's1');
});

test('merge keys use protocol, host, port and credential', () => {
  const a = node(U1, 'a.example');
  assert.match(mergeKey(a), new RegExp(`^vless\\|a\\.example\\|443\\|${U1}$`));
  assert.equal(nodeIdentityKey(a), 'a.example|443|vless|tcp');
  const ws = parseSubscriptionDetailed(`vless://${U1}@a.example:443?type=ws&path=%2Fws#A`).nodes[0];
  assert.equal(nodeIdentityKey(ws), 'a.example|443|vless|ws');
});
