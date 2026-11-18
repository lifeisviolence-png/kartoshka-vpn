import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE_KEYS, legacyKeysPresent, plaintextSecrets, scrubLegacyStorage } from '../src/secure-store.js';

function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map)
  };
}

const legacy = {
  'kartoshka.state.v2': JSON.stringify({ version: 2, subscriptionUrl: 'https://panel.example/sub/secret-token' }),
  'kartoshka.nodes': JSON.stringify([{ id: 'a', outbound: { uuid: '11111111-2222-3333-4444-555555555555', password: 'p@ssw0rd' } }])
};

test('старые ключи находятся полностью', () => {
  const storage = fakeStorage(legacy);
  assert.deepEqual(legacyKeysPresent(storage), ['kartoshka.state.v2', 'kartoshka.nodes']);
});

test('зачистка удаляет URL, UUID и пароль из localStorage', () => {
  const storage = fakeStorage(legacy);
  const removed = scrubLegacyStorage(storage);
  assert.deepEqual(removed, ['kartoshka.state.v2', 'kartoshka.nodes']);
  assert.deepEqual(storage.dump(), {});
  assert.deepEqual(legacyKeysPresent(storage), []);
});

test('зачистка идемпотентна и не падает на пустом хранилище', () => {
  const storage = fakeStorage();
  assert.deepEqual(scrubLegacyStorage(storage), []);
  assert.deepEqual(scrubLegacyStorage(storage), []);
});

test('секреты перечисляются для проверки логов', () => {
  const secrets = plaintextSecrets({
    subscriptionUrl: 'https://panel.example/sub/secret-token',
    servers: [{ originalUri: 'vless://uuid@host:443', outbound: { uuid: '11111111-2222-3333-4444-555555555555', password: 'p@ssw0rd' } }]
  });
  assert.ok(secrets.includes('https://panel.example/sub/secret-token'));
  assert.ok(secrets.includes('p@ssw0rd'));
  assert.equal(secrets.length, 4);
});

test('список ключей покрывает все легаси-ключи', () => {
  assert.equal(STATE_KEYS.length, 8);
  assert.ok(STATE_KEYS.every((key) => key.startsWith('kartoshka.')));
});
