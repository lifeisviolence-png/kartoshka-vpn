// The desktop app keeps its snapshot in %APPDATA%\ru.kartoshka.vpn\state.enc,
// encrypted with DPAPI. Browsers and the preview keep localStorage, but a
// desktop migration must leave no subscription URL, UUID or password behind.
export const STATE_KEYS = Object.freeze([
  'kartoshka.state.v2',
  'kartoshka.state.v1',
  'kartoshka.nodes',
  'kartoshka.subscriptionUrl',
  'kartoshka.subscriptionMeta',
  'kartoshka.settings',
  'kartoshka.selectedId',
  'kartoshka.routeMode'
]);

function read(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

export function legacyKeysPresent(storage) {
  return STATE_KEYS.filter((key) => read(storage, key) !== null);
}

export function scrubLegacyStorage(storage) {
  const removed = [];
  for (const key of STATE_KEYS) {
    try {
      if (storage.getItem(key) === null) continue;
      storage.removeItem(key);
      removed.push(key);
    } catch { /* a blocked storage is already private to this origin */ }
  }
  return removed;
}

// Secrets that must never appear in a plaintext log line or in localStorage.
// The list is intentionally literal: it is used by tests and by diagnostics.
export function plaintextSecrets(state) {
  const values = [];
  const push = (value) => { if (typeof value === 'string' && value.length >= 4) values.push(value); };
  push(state?.subscriptionUrl);
  for (const node of state?.servers || []) {
    push(node?.originalUri);
    push(node?.outbound?.uuid);
    push(node?.outbound?.password);
    push(node?.outbound?.obfs?.password);
    push(node?.password);
  }
  return values;
}
