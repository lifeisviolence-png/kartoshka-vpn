// Durable application state.
//
// v1 kept a single `subscriptionUrl`. v2 stores a list of subscriptions and tags
// every imported node with `subscriptionId`; manual nodes keep `null`. The
// migration is pure so it can be tested without a browser or a Tauri runtime.
export const STATE_VERSION = 2;

const ROUTE_MODES = ['all', 'auto', 'split'];
const TRANSIENT = ['ping', 'proxyPing', 'availability', 'testing', 'probeError'];

export function emptyState() {
  return { version: STATE_VERSION, subscriptions: [], nodes: [], selectedId: null, routeMode: 'auto', previousRouteMode: null, language: 'ru', settings: {}, routing: null };
}

function shortHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function subscriptionIdFor(url) {
  return `sub-${shortHash(String(url || ''))}`;
}

export function subscriptionNameFor(url, meta, index = 0) {
  const title = meta?.title || meta?.profileTitle || '';
  if (title) return String(title).slice(0, 60);
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host || `Subscription ${index + 1}`;
  } catch { return `Subscription ${index + 1}`; }
}

export function cleanNode(node) {
  const copy = { ...node };
  for (const key of TRANSIENT) delete copy[key];
  return copy;
}

export function snapshot(state) {
  return {
    version: STATE_VERSION,
    subscriptions: (state.subscriptions || []).map(({ id, name, url, updatedAt, meta }) => ({ id, name, url, updatedAt: updatedAt || null, meta: meta || null })),
    nodes: (state.nodes || []).map(cleanNode),
    selectedId: state.selectedId || null,
    routeMode: ROUTE_MODES.includes(state.routeMode) ? state.routeMode : 'auto',
    previousRouteMode: state.previousRouteMode || null,
    language: state.language === 'en' ? 'en' : 'ru',
    settings: state.settings || {},
    routing: state.routing || null
  };
}

function normalizeNode(node, subscriptions) {
  if (!node || typeof node !== 'object' || !node.id) return null;
  const subscriptionId = node.subscriptionId && subscriptions.some((item) => item.id === node.subscriptionId) ? node.subscriptionId : null;
  return {
    ...node,
    subscriptionId,
    source: subscriptionId ? (node.source === 'subscription-retained' ? 'subscription-retained' : 'subscription') : 'manual',
    favorite: Boolean(node.favorite),
    customName: node.customName || '',
    ping: null,
    proxyPing: null,
    availability: 'unknown'
  };
}

// Accepts any stored shape (including v1) and always returns a usable v2 state.
// Unknown fields are dropped rather than trusted.
export function migrateState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return { state: base, migrated: false };
  if (raw.version === STATE_VERSION && Array.isArray(raw.nodes)) {
    const subscriptions = Array.isArray(raw.subscriptions) ? raw.subscriptions.filter((item) => item && item.id && typeof item.url === 'string').map((item) => ({ id: item.id, name: item.name || subscriptionNameFor(item.url), url: item.url, updatedAt: item.updatedAt || null, meta: item.meta || null })) : [];
    const nodes = raw.nodes.map((node) => normalizeNode(node, subscriptions)).filter(Boolean);
    return {
      state: {
        ...base,
        subscriptions,
        nodes,
        selectedId: nodes.some((node) => node.id === raw.selectedId) ? raw.selectedId : nodes[0]?.id || null,
        routeMode: ROUTE_MODES.includes(raw.routeMode) ? raw.routeMode : 'auto',
        previousRouteMode: raw.previousRouteMode || null,
        language: raw.language === 'en' ? 'en' : 'ru',
        settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
        routing: raw.routing && typeof raw.routing === 'object' ? raw.routing : null
      },
      migrated: false
    };
  }
  // v1: a single subscription URL plus nodes tagged only by `source`.
  // A direct proxy URI was stored as `subscriptionUrl` by very old builds; such
  // nodes are manual and must not become a subscription.
  const stored = typeof raw.subscriptionUrl === 'string' ? raw.subscriptionUrl.trim() : '';
  const url = /^(vless|vmess|trojan|ss|shadowsocks|hysteria2|hy2):\/\//i.test(stored) ? '' : stored;
  const legacyMeta = raw.subscriptionMeta && typeof raw.subscriptionMeta === 'object' ? raw.subscriptionMeta : null;
  const subscriptions = [];
  let subscriptionId = null;
  if (url) {
    subscriptionId = subscriptionIdFor(url);
    subscriptions.push({ id: subscriptionId, name: subscriptionNameFor(url, legacyMeta), url, updatedAt: legacyMeta?.updatedAt || null, meta: legacyMeta ? { used: legacyMeta.used, total: legacyMeta.total, expiresAt: legacyMeta.expiresAt, title: legacyMeta.title } : null });
  }
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map((node) => {
    if (!node || !node.id) return null;
    const imported = node.source === 'subscription' || node.source === 'subscription-retained';
    const next = { ...node, subscriptionId: imported ? subscriptionId : null };
    return normalizeNode(next, subscriptions);
  }).filter(Boolean);
  const routing = legacyMeta && (legacyMeta.routing || legacyMeta.routingUnsupported?.length)
    ? { profile: legacyMeta.routing || null, unsupported: legacyMeta.routingUnsupported || [], dns: Boolean(legacyMeta.routingDns), source: legacyMeta.routingSource || null, updatedAt: legacyMeta.routingUpdatedAt || null }
    : null;
  const selectedId = nodes.some((node) => node.id === raw.selectedId) ? raw.selectedId : nodes[0]?.id || null;
  return {
    state: {
      ...base,
      subscriptions,
      nodes,
      selectedId,
      routeMode: ROUTE_MODES.includes(raw.routeMode) ? raw.routeMode : 'auto',
      previousRouteMode: raw.previousRouteMode || null,
      language: raw.language === 'en' ? 'en' : 'ru',
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
      routing
    },
    migrated: true
  };
}

export function nodeEndpoint(node) {
  const outbound = node?.outbound || {};
  const endpoint = outbound.settings?.vnext?.[0] || outbound.settings?.servers?.[0] || outbound.settings?.server || {};
  return { host: outbound.server || outbound.address || endpoint.address || endpoint.server || '', port: Number(outbound.server_port ?? outbound.port ?? endpoint.port) };
}

export function nodeCredential(node) {
  const outbound = node?.outbound || {};
  const settings = outbound.settings || {};
  const vnext = settings.vnext?.[0] || {};
  const server = settings.servers?.[0] || {};
  return String(vnext.users?.[0]?.id || server.password || settings.password || outbound.uuid || outbound.password || outbound.settings?.password || vnext.users?.[0]?.email || '');
}

// The merge key required by the product: protocol + host + port + credential.
export function mergeKey(node) {
  const { host, port } = nodeEndpoint(node);
  const protocol = String(node?.outbound?.type || node?.protocol || '').toLowerCase().replace(/^ss$/, 'shadowsocks').replace(/^hy2$/, 'hysteria2');
  return [protocol, String(host).toLowerCase(), port, nodeCredential(node)].join('|');
}

function uniqueId(base, used) {
  let id = base || 'node';
  let suffix = 2;
  while (used.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
  used.add(id);
  return id;
}

// Endpoint identity without the credential: a provider that rotates UUIDs keeps
// the same server, so the id, favourite and custom name must survive the refresh.
export function nodeIdentityKey(node) {
  const { host, port } = nodeEndpoint(node);
  const protocol = String(node?.outbound?.type || node?.protocol || '').toLowerCase().replace(/^ss$/, 'shadowsocks').replace(/^hy2$/, 'hysteria2');
  let network = String(node?.outbound?.transport?.type || node?.outbound?.streamSettings?.network || (protocol === 'hysteria2' ? 'hysteria' : 'tcp')).toLowerCase();
  network = ({ raw: 'tcp', websocket: 'ws', splithttp: 'xhttp' })[network] || network;
  if (!host || !Number.isInteger(port) || !protocol) return '';
  return [String(host).toLowerCase(), port, protocol, network].join('|');
}

// Reconciles one subscription with a freshly downloaded list. Favourites, custom
// names and the selected node survive even when the provider drops them, and the
// node keeps its id so the UI selection stays stable.
export function mergeSubscriptionNodes({ nodes, incoming, subscriptionId, selectedId }) {
  const used = new Set(nodes.filter((node) => node.subscriptionId !== subscriptionId).map((node) => node.id));
  const existing = nodes.filter((node) => node.subscriptionId === subscriptionId);
  const byKey = new Map();
  for (const node of existing) {
    const key = mergeKey(node);
    byKey.set(key, [...(byKey.get(key) || []), node]);
  }
  const matched = new Set();
  const matchedIncoming = new Map();
  let duplicates = 0;
  const seen = new Set();
  const pending = [];
  for (const node of incoming) {
    const key = mergeKey(node);
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    const previous = (byKey.get(key) || []).find((item) => !matched.has(item));
    if (previous) { matched.add(previous); matchedIncoming.set(node, previous); } else pending.push(node);
  }
  // Second pass: same endpoint and transport, different credential. Only an
  // unambiguous pair is matched, otherwise two identical servers could swap names.
  const remainingOld = existing.filter((node) => !matched.has(node));
  const oldByIdentity = new Map();
  for (const node of remainingOld) {
    const identity = nodeIdentityKey(node);
    if (identity) oldByIdentity.set(identity, [...(oldByIdentity.get(identity) || []), node]);
  }
  const incomingByIdentity = new Map();
  for (const node of pending) {
    const identity = nodeIdentityKey(node);
    if (identity) incomingByIdentity.set(identity, [...(incomingByIdentity.get(identity) || []), node]);
  }
  for (const [identity, list] of incomingByIdentity) {
    const candidates = oldByIdentity.get(identity) || [];
    if (list.length === 1 && candidates.length === 1) {
      matched.add(candidates[0]);
      matchedIncoming.set(list[0], candidates[0]);
    }
  }
  const merged = [];
  let added = 0;
  for (const node of incoming) {
    if (duplicates && !seen.has(mergeKey(node))) continue;
    const previous = matchedIncoming.get(node);
    if (!previous) added += 1;
    const id = previous && !used.has(previous.id) ? previous.id : uniqueId(previous?.id || node.id, used);
    merged.push({
      ...node,
      id,
      subscriptionId,
      source: 'subscription',
      favorite: previous?.favorite ?? Boolean(node.favorite),
      customName: previous?.customName || '',
      countryCode: previous?.countryCode || node.countryCode || '',
      countrySource: previous?.countrySource || node.countrySource || '',
      ping: null,
      proxyPing: null,
      availability: 'unknown'
    });
  }
  const retained = existing.filter((node) => !matched.has(node) && (node.favorite || node.customName || node.id === selectedId))
    .map((node) => ({ ...node, source: 'subscription-retained', ping: null, availability: 'unknown' }));
  const removed = existing.length - matched.size - retained.length;
  const others = nodes.filter((node) => node.subscriptionId !== subscriptionId);
  return { nodes: [...others, ...merged, ...retained], added, removed, retained: retained.length, duplicates, kept: matched.size };
}

export function removeSubscription({ nodes, subscriptions, selectedId }, subscriptionId) {
  const removedNodes = nodes.filter((node) => node.subscriptionId === subscriptionId);
  const remaining = nodes.filter((node) => node.subscriptionId !== subscriptionId);
  const nextSelected = remaining.some((node) => node.id === selectedId) ? selectedId : remaining[0]?.id || null;
  return {
    nodes: remaining,
    subscriptions: subscriptions.filter((item) => item.id !== subscriptionId),
    selectedId: nextSelected,
    removed: removedNodes.length,
    removedNodes
  };
}

// Restores a deleted subscription together with its nodes (the 8-second undo).
export function restoreSubscription(state, snapshotValue) {
  if (!snapshotValue?.subscription) return state;
  const subscriptions = state.subscriptions.some((item) => item.id === snapshotValue.subscription.id)
    ? state.subscriptions
    : [...state.subscriptions, snapshotValue.subscription];
  const nodes = [...state.nodes];
  for (const node of snapshotValue.nodes || []) {
    if (!nodes.some((item) => item.id === node.id)) nodes.push(node);
  }
  return { ...state, subscriptions, nodes, selectedId: state.selectedId || snapshotValue.selectedId || null };
}
