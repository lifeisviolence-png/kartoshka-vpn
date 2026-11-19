import './styles.css';
import { desktopBridge } from './desktop-bridge.js';
import { parseSubscriptionDetailed, parseUserinfo } from './subscription.js';
import { buildXrayConfig } from './xray-config.js';
import { t, setLanguage, getLanguage, locale, errorText as localizedError } from './i18n.js';
import { VERSION } from './version.js';
import { icon } from './icons.js';
import { countryByCode, countryLabel, flagPath, detectCountry, groupByCountry } from './countries.js';
import { scrubLegacyStorage, legacyKeysPresent } from './secure-store.js';
import { migrateState, snapshot, subscriptionIdFor, subscriptionNameFor, mergeSubscriptionNodes, removeSubscription, restoreSubscription, nodeEndpoint, mergeKey } from './state-model.js';

const capabilities = desktopBridge.getCapabilities();
const hostIsMac = /Mac/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
if (typeof document !== 'undefined' && document.documentElement) document.documentElement.dataset.os = hostIsMac ? 'macos' : 'windows';
const routeModeIds = ['all', 'auto', 'split'];
const dnsModeIds = ['system', 'builtin'];
const directScheme = /^(vless|vmess|trojan|ss|shadowsocks|hysteria2|hy2):\/\//i;
const storageKey = 'kartoshka.state.v2';
const legacyKey = 'kartoshka.state.v1';
const PING_TIMEOUT = 4000;
const TCP_CONCURRENCY = 8;
const UDP_CONCURRENCY = 3;

function readStored(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function loadJson(key, fallback) { try { return JSON.parse(readStored(key, JSON.stringify(fallback))); } catch { return fallback; } }

function loadStoredData() {
  const current = loadJson(storageKey, null);
  if (current?.version === 2) return { raw: current, migrated: false };
  const previous = loadJson(legacyKey, null);
  if (previous?.version === 1) return { raw: previous, migrated: true };
  let nodes = loadJson('kartoshka.nodes', []);
  if (!Array.isArray(nodes)) nodes = [];
  let subscriptionUrl = readStored('kartoshka.subscriptionUrl', '');
  let subscriptionMeta = loadJson('kartoshka.subscriptionMeta', null);
  // Old manual imports were tagged as subscription and saved their URI as its URL.
  if (directScheme.test(String(subscriptionUrl).trim())) {
    nodes = nodes.map((node) => node.source === 'subscription' ? { ...node, source: 'manual' } : node);
    subscriptionUrl = ''; subscriptionMeta = null;
  }
  const settings = loadJson('kartoshka.settings', null);
  return { raw: { version: 1, nodes, selectedId: readStored('kartoshka.selectedId', ''), subscriptionUrl, subscriptionMeta, settings, language: settings?.language, routeMode: readStored('kartoshka.routeMode', '') }, migrated: true };
}

const loaded = loadStoredData();
const migrated = migrateState(loaded.raw);
const { nodes: storedNodes, ...storedRest } = migrated.state;
const state = {
  ...storedRest,
  servers: storedNodes,
  connection: capabilities.native ? 'disconnecting' : 'idle',
  activeNode: null,
  activeRouteMode: null,
  connectedAt: null,
  externalIp: null,
  proxyPing: null,
  proxyTesting: false,
  proxyCheckFailed: false,
  cleanupNeeded: false,
  bridgeReady: !capabilities.native,
  watchError: '',
  activeNav: 'home',
  modal: null,
  pendingUrl: '',
  importing: false,
  importError: '',
  pendingImport: null,
  pendingDelete: null,
  subscriptionBusy: null,
  refreshAllBusy: false,
  pingJob: null,
  notice: null,
  toast: null,
  logs: [],
  transferActive: false,
  search: '',
  sort: 'country',
  collapsed: [],
  latencyHistory: [],
  diagnostics: '',
  proxyDiagnostics: '',
  proxyWarning: '',
  coreVersion: '',
  message: { key: capabilities.native ? 'state.checkingProxy' : 'state.previewNoConnect' },
  clientUpdate: { status: 'idle', info: null, error: '', progress: 0 }
};
// Effective values: stored settings stay untouched until the user flips a switch,
// so a migration never rewrites the old settings object.
const dnsProtectionOn = () => state.settings?.dnsProtection ?? (state.settings?.dns !== 'system');
const fastReconnectOn = () => state.settings?.fastReconnect ?? (state.settings?.perf?.tcpFastOpen === true);
setLanguage(state.language);
if (!state.selectedId || !state.servers.some((node) => node.id === state.selectedId)) state.selectedId = state.servers[0]?.id || null;
state.servers = state.servers.map(applyCountry);

// The browser preview has no DPAPI: it persists the migrated snapshot in localStorage.
if (!capabilities.native && loaded.migrated) {
  try { localStorage.setItem(storageKey, JSON.stringify(persisted())); }
  catch { state.notice = { type: 'error', text: t('notice.saveFailedLegacy') }; }
}

const app = document.querySelector('#app');
let exitSequence = 0;
let operationSequence = 0;
let sessionSequence = 0;
let modalPreviouslyOpen = false;
let renderTimer = null;
let latencyTimer = null;

function persisted() { return snapshot({ ...state, nodes: state.servers }); }
const NATIVE = capabilities.native;
let persistTimer = null;
let storageLocked = false;
function snapshotText() { return JSON.stringify(persisted()); }
// A desktop snapshot is written only through Rust: DPAPI ciphertext in
// %APPDATA%\ru.kartoshka.vpn\state.enc. localStorage is used by the browser
// preview, and clears itself after a successful encrypted save.
async function saveSnapshotNow() {
  if (!NATIVE) {
    try { localStorage.setItem(storageKey, snapshotText()); }
    catch { state.notice = { type: 'error', text: t('notice.saveFailed') }; }
    return;
  }
  if (storageLocked) return;
  try {
    const saved = await desktopBridge.saveSecureState(snapshotText());
    if (saved?.preview) { localStorage.setItem(storageKey, snapshotText()); return; }
    if (legacyKeysLeft()) scrubLegacyStorage(localStorage);
  } catch {
    state.notice = { type: 'error', text: t('notice.saveFailed') };
  }
}
function legacyKeysLeft() {
  try { return Boolean(localStorage.length); } catch { return false; }
}
function schedulePersist() {
  if (!NATIVE) { saveSnapshotNow(); return; }
  // Small snapshots are written immediately: a debounce only risks losing the
  // last change if the process is closed right after it.
  void saveSnapshotNow();
}
function commitData(patch) {
  Object.assign(state, patch);
  schedulePersist();
  return true;
}
async function resetSecureStorage() {
  if (!NATIVE) return;
  try {
    await desktopBridge.resetSecureState();
  } catch {
    state.notice = { type: 'error', text: t('notice.storageResetFailed') };
    render();
    return;
  }
  storageLocked = false;
  state.servers = [];
  state.selectedId = null;
  state.subscriptionUrl = '';
  state.subscriptionMeta = null;
  state.notice = { type: 'info', text: t('notice.storageReset') };
  await saveSnapshotNow();
  render();
}
async function bootstrapSecureStorage() {
  if (!NATIVE) return;
  try {
    const text = await desktopBridge.loadSecureState();
    if (text) {
      const next = migrateState(JSON.parse(text)).state;
      const nodes = next.nodes.map(applyCountry);
      Object.assign(state, next, { servers: nodes });
      setLanguage(state.language);
      if (!state.selectedId || !state.servers.some((node) => node.id === state.selectedId)) state.selectedId = state.servers[0]?.id || null;
    }
    // An empty install must not create an empty store; a fresh save would only
    // race the first real change.
    if (text || legacyKeysPresent(localStorage).length) await saveSnapshotNow();
    scrubLegacyStorage(localStorage);
  } catch (error) {
    if (String(error?.message || error).includes('state.locked')) {
      storageLocked = true;
      state.notice = { type: 'error', text: t('notice.storageLocked'), action: 'reset-storage' };
    } else {
      state.notice = { type: 'error', text: t('notice.storageReadFailed') };
    }
  }
  render();
}
function selectedNode() { return state.servers.find((node) => node.id === state.selectedId) || null; }
function httpsLink(value) {
  if (!value) return '';
  try { const url = new URL(String(value)); return url.protocol === 'https:' ? url.toString() : ''; } catch { return ''; }
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function errorText(error) {
  const text = localizedError(error);
  // The Rust core still emits Russian diagnostics; the English UI marks them
  // instead of pretending they were translated.
  if (getLanguage() === 'en' && /[\u0400-\u04FF]/.test(text)) return t('err.coreRussian', { text });
  return text;
}
function coreErrorText(error) {
  const text = String(errorText(error));
  const match = text.match(/^(CORE_LAUNCH_[A-Z_]+):/);
  return match ? t(`coreError.${match[1]}`) : text;
}
function messageText(message) {
  if (!message) return '';
  if (message.key === 'raw') return message.params?.text || '';
  return t(message.key, message.params || {});
}
function setMessage(key, params) { state.message = { key, params }; }
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return '—';
  const list = ['unit.b', 'unit.kb', 'unit.mb', 'unit.gb', 'unit.tb'].map((key) => t(key));
  let value = Number(bytes); let index = 0;
  while (value >= 1024 && index < list.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${list[index]}`;
}
function formatExpiry(date) {
  if (!date) return t('subscription.noExpiry');
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return t('subscription.noExpiry');
  return t('subscription.until', { date: value.toLocaleDateString(locale(), { day: '2-digit', month: 'long', year: 'numeric' }) });
}
function formatDate(date) {
  const value = date ? new Date(date) : null;
  if (!value || Number.isNaN(value.getTime())) return '—';
  return value.toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatDuration() {
  if (!state.connectedAt) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - state.connectedAt) / 1000));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':');
}
function busy() { return state.connection === 'connecting' || state.connection === 'disconnecting'; }
function routeTitle(id) { return t(`route.label.${id}`); }
function routeDescription(id) { return t(`route.${id}.desc`); }
function unsupportedReason(node) {
  if (!node) return '';
  // A node that only needs its certificate pinned is usable: the pin is taken
  // on the first successful handshake before the tunnel starts.
  if (node.needsPin) return '';
  if (node.unsupportedReason && !String(node.unsupportedReason).includes('.')) return String(node.unsupportedReason);
  if (node.code) return t(`err.${node.code}`, node.params || {});
  if (node.unsupported || node.supported === false) return t('err.sub.nodeUnsupported');
  // Also validate nodes persisted by older releases, which predate the parser flags.
  try { buildXrayConfig([node], node.id, 'all', null); return ''; }
  catch (error) { return errorText(error); }
}
function tcpTestApplicable(node) { return !['hysteria2', 'hy2', 'hysteria'].includes(String(node?.outbound?.type || node?.protocol || '').toLowerCase()); }
function nodeSignature(node) {
  if (!node) return '';
  const outbound = JSON.parse(JSON.stringify(node.outbound || {}));
  delete outbound.tag;
  // Unsupported links can have identical empty outbounds but distinct credentials
  // and endpoints. Keep the URI only in memory/storage, never in diagnostics.
  return JSON.stringify([String(node.protocol || '').toLowerCase(), outbound, node.unsupported && node.originalUri ? node.originalUri : null]);
}
function nodeIdentity(node) {
  const outbound = node?.outbound || {};
  const endpoint = nodeEndpoint(node);
  const host = typeof endpoint.host === 'string' ? endpoint.host.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase() : '';
  const protocol = String(outbound.type || outbound.protocol || node?.protocol || '').toLowerCase().replace(/^ss$/, 'shadowsocks').replace(/^hy2$/, 'hysteria2');
  let network = String(outbound.transport?.type || outbound.streamSettings?.network || (protocol === 'hysteria2' ? 'hysteria' : 'tcp')).toLowerCase();
  network = ({ raw: 'tcp', websocket: 'ws', splithttp: 'xhttp' })[network] || network;
  if (!host || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !protocol || !network) return null;
  return JSON.stringify([host, endpoint.port, protocol, network]);
}
function sameConfig(a, b) { return Boolean(a && b && nodeSignature(a) === nodeSignature(b)); }
function copyNode(node) { return node ? JSON.parse(JSON.stringify(node)) : null; }

function applyCountry(node) {
  if (!node) return node;
  if (node.countryCode && countryByCode(node.countryCode)) return node;
  const detected = detectCountry(node.name, node.city || '');
  if (!detected.code) return node;
  return { ...node, countryCode: detected.code, countrySource: detected.source };
}
function countryText(node) {
  const code = countryByCode(node?.countryCode) ? node.countryCode : '';
  return code ? countryLabel(code, getLanguage()) : (node?.country || '');
}
function nodePlace(node) { return [countryText(node), node?.city].filter(Boolean).join(' · ') || t('servers.locationUnknown'); }
function flagMarkup(code, className = 'flag') {
  const path = flagPath(code);
  if (path) return `<img class="${className}" src="${path}" alt="" width="20" height="15" loading="lazy"/>`;
  return `<span class="${className} flag-none" aria-hidden="true">${icon('globe', 14)}</span>`;
}
function displayName(node) {
  // Providers usually prefix the name with a flag emoji; the row renders a real
  // flag next to it, so flags/ISO prefixes are removed from the visible label
  // only. The stored name and the search haystack keep the original text.
  const raw = String(node?.customName || node?.name || t('servers.serverFallback')).trim();
  let code = countryByCode(node?.countryCode) ? node.countryCode : '';
  if (!code) {
    const detected = detectCountry(raw, node?.city || '');
    if (detected.code) code = detected.code;
  }
  let name = raw;
  if (code) name = name.replace(new RegExp(`^${String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '');
  name = name.replace(/^(?:[\u{1F1E6}-\u{1F1FF}]{2}\s*)+/u, '');
  name = name.replace(/^[\s|·:—–-]+/, '').trim();
  return name || raw;
}
function nodeFlag(node, className = 'flag') { return flagMarkup(countryByCode(node?.countryCode) ? node.countryCode : '', className); }
function protocolBadge(node) {
  const value = String(node?.outbound?.type || node?.protocol || '').toLowerCase();
  const label = ({ vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'SS', hysteria2: 'HY2' })[value] || value.toUpperCase() || '—';
  return `<span class="protocol-badge">${escapeHtml(label)}</span>`;
}
function pingClass(value) {
  if (!Number.isFinite(value)) return 'ping-none';
  if (value < 150) return 'ping-good';
  if (value < 400) return 'ping-mid';
  return 'ping-bad';
}
function pingText(node) {
  if (!tcpTestApplicable(node)) return node.ping == null ? '—' : `${node.ping} ${t('unit.ms')}`;
  return Number.isFinite(node.ping) ? `${node.ping} ${t('unit.ms')}` : '—';
}
function visibleNodes() {
  const query = state.search.trim().toLowerCase();
  const list = query ? state.servers.filter((node) => `${node.name || ''} ${node.customName || ''} ${node.country || ''} ${countryText(node)} ${node.city || ''} ${node.protocol || ''}`.toLowerCase().includes(query)) : [...state.servers];
  if (state.sort === 'ping') list.sort((a, b) => { if (a.ping == null) return 1; if (b.ping == null) return -1; return a.ping - b.ping; });
  else if (state.sort === 'name') list.sort((a, b) => String(a.customName || a.name).localeCompare(String(b.customName || b.name), locale()));
  return list;
}
function statusInfo() {
  const detail = messageText(state.message);
  return {
    idle: [t('state.idle'), detail, 'idle'],
    connecting: [t('state.connecting'), detail, 'connecting'],
    disconnecting: [t('state.disconnecting'), detail, 'connecting'],
    connected: [state.proxyCheckFailed ? t('state.proxyOn') : t('state.connected'), state.proxyCheckFailed ? t('state.proxyNotConfirmed') : t('state.proxyConfigured'), 'connected'],
    error: [t('state.error'), detail, 'error']
  }[state.connection];
}
function actionLabel() {
  if (state.cleanupNeeded) return t('action.retryDisconnect');
  if (state.connection === 'connected') return t('action.disconnect');
  if (state.connection === 'connecting') return t('action.connecting');
  if (state.connection === 'disconnecting') return t('action.disconnecting');
  return t('action.connect');
}
function toggleDisabled(node) {
  return busy() || (!state.cleanupNeeded && state.connection !== 'connected' && ((!state.bridgeReady && capabilities.native) || !node || Boolean(unsupportedReason(node))));
}
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 40);
}
function showToast(text, action = null) {
  state.toast = { id: Date.now(), text, actionLabel: action?.label || '', action: action?.run || null };
  setTimeout(() => {
    if (state.toast && Date.now() - state.toast.id >= 7900) { state.toast = null; render(); }
  }, 8200);
}

function navItem(id, iconName, label) {
  return `<button class="nav-item ${state.activeNav === id ? 'active' : ''}" data-nav="${id}" data-focus-key="nav-${id}" ${state.activeNav === id ? 'aria-current="page"' : ''}>${icon(iconName, 17)}<span>${escapeHtml(label)}</span></button>`;
}
function renderNotice() {
  if (!state.notice) return '';
  const details = state.notice.details?.length ? `<ul>${state.notice.details.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '';
  // Never render a dismiss-only bar: an empty notice looked like a stray close
  // button above the selected-server card on macOS.
  if (!String(state.notice.text || '').trim() && !details) return '';
  const action = state.notice.action === 'reconnect'
    ? `<button class="button small" data-action="reconnect">${escapeHtml(t('action.reconnect'))}</button>`
    : state.notice.action === 'reset-storage'
      ? `<button class="button small" data-action="reset-storage">${escapeHtml(t('action.resetStorage'))}</button>`
      : '';
  return `<div class="notice ${state.notice.type === 'error' ? 'notice-error' : ''}" role="status"><div>${escapeHtml(state.notice.text)}${details}</div>${action}<button class="icon-button" data-action="dismiss-notice" aria-label="${escapeHtml(t('app.close'))}">${icon('close', 14)}</button></div>`;
}
function toastMarkup() {
  if (!state.toast) return '';
  return `<div class="toast" role="status"><span>${escapeHtml(state.toast.text)}</span>${state.toast.action ? `<button class="toast-action" data-action="toast-action">${escapeHtml(state.toast.actionLabel)}</button>` : ''}<button class="icon-button" data-action="dismiss-toast" aria-label="${escapeHtml(t('app.close'))}">${icon('close', 13)}</button></div>`;
}
let shellSignature = '';
// Set once the first real render proves that the DOM is a tree and not the
// string-only stub used by the regression harness.
let incremental = true;
let lastPageMarkup = '';
let lastModalMarkup = '';
let lastToastMarkup = '';

function shellMarkup() {
  return `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><img class="brand-mark" src="/potato-mark.png" alt=""/><div class="brand-copy"><strong>Kartoshka<span>VPN</span></strong><small>${escapeHtml(t('app.tagline'))}</small></div></div>
      <nav class="nav" aria-label="${escapeHtml(t('app.navigation'))}">
        ${navItem('home', 'home', t('nav.home'))}${navItem('servers', 'server', t('nav.servers'))}${navItem('stats', 'chart', t('nav.stats'))}${navItem('settings', 'settings', t('nav.settings'))}${navItem('logs', 'logs', t('nav.logs'))}
      </nav>
      <div class="sidebar-bottom">${navItem('about', 'info', t('nav.about'))}<div class="sidebar-foot"><span class="foot-dot ${state.connection === 'connected' ? 'on' : ''}"></span><span>${escapeHtml(capabilities.native ? t('app.windowsXray') : t('app.previewMode'))}</span></div><span class="sidebar-version">v${escapeHtml(VERSION)}</span></div>
    </aside>
    <main class="main">
      <header class="topbar"><div class="topbar-title"><h1>${escapeHtml(t(`nav.${state.activeNav}`))}</h1><span class="topbar-sub">${escapeHtml(capabilities.native ? t('app.windowsProxy') : t('app.preview'))}</span></div><div class="topbar-actions">${state.connection === 'connected' ? `<span class="session-chip">${icon('clock', 13)}<span data-duration>${formatDuration()}</span></span>` : ''}<button class="icon-button" data-action="refresh" aria-label="${escapeHtml(t('app.refresh'))}" title="${escapeHtml(t('app.refresh'))}" ${state.importing ? 'disabled' : ''}>${icon('refresh', 15)}</button></div></header>
      <div id="page-host" class="page-host"></div>
    </main>
  </div><div id="modal-host"></div><div id="toast-host"></div>`;
}

function dockMarkup(node) {
  if (!node || !['home', 'servers'].includes(state.activeNav)) return '';
  const [status, , statusClass] = statusInfo();
  return `<div class="mobile-dock" role="region" aria-label="${escapeHtml(t('control.selected'))}">
    ${nodeFlag(node, 'flag')}
    <div class="dock-copy"><strong>${escapeHtml(displayName(node))}</strong><span class="dock-sub">${escapeHtml(node.outbound?.type?.toUpperCase() || '')} · ${escapeHtml(pingText(node))} · <span class="dock-status ${statusClass}">${escapeHtml(status)}</span></span></div>
    <button class="button primary" data-action="toggle" ${toggleDisabled(node) ? 'disabled' : ''}>${escapeHtml(actionLabel())}</button>
  </div>`;
}

function pageMarkup(node) {
  return `${renderNotice()}${state.activeNav === 'home' ? homeMarkup(node) : state.activeNav === 'servers' ? serversMarkup(node) : state.activeNav === 'settings' ? settingsMarkup() : state.activeNav === 'stats' ? statsMarkup() : state.activeNav === 'logs' ? logsMarkup() : aboutMarkup()}${dockMarkup(node)}<footer class="footer-note"><span>${icon('shield', 13)} ${escapeHtml(t('footer.proxy'))}</span><span>${escapeHtml(t('footer.direct'))}</span></footer>`;
}

function modalMarkupForState() {
  return state.modal === 'add' ? modalMarkup() : state.modal === 'result' ? resultMarkup() : state.modal === 'delete-sub' ? deleteMarkup() : '';
}

// Inner scrollers survive a page swap: their offset is captured by key and put
// back before the frame is painted. The main column keeps its own offset
// because only its children are replaced.
function captureScroll() {
  const offsets = new Map();
  // The main column is the page scroller: replacing its children can clamp the
  // offset if the new content is momentarily shorter, so it is saved too.
  const main = document.querySelector('.main');
  if (main) offsets.set('__main', main.scrollTop);
  for (const element of document.querySelectorAll('[data-scroll-key]')) offsets.set(element.dataset.scrollKey, element.scrollTop);
  return offsets;
}
function restoreScroll(offsets) {
  if (!offsets.size) return;
  const main = document.querySelector('.main');
  const saved = offsets.get('__main');
  if (main && typeof saved === 'number') {
    const max = Math.max(0, main.scrollHeight - main.clientHeight);
    main.scrollTop = Math.min(saved, max);
  }
  for (const element of document.querySelectorAll('[data-scroll-key]')) {
    const value = offsets.get(element.dataset.scrollKey);
    if (typeof value === 'number' && element.scrollTop !== value) element.scrollTop = value;
  }
}

// The regression harness builds a minimal DOM that stores innerHTML as a string
// without parsing it. There is no #page-host there, so the whole view is written
// in one go; the real WebView always takes the incremental path below.
function renderWhole(node) {
  shellSignature = '';
  lastPageMarkup = ''; lastModalMarkup = ''; lastToastMarkup = '';
  app.innerHTML = `${shellMarkup().replace('<div id="page-host" class="page-host"></div>', `<div id="page-host" class="page-host">${pageMarkup(node)}</div>`)}${modalMarkupForState()}${toastMarkup()}`;
  incremental = (document.querySelector('#page-host')?.childElementCount || 0) > 0;
  bindEvents();
}

function render() {
  const previous = document.activeElement;
  const focusKey = previous?.getAttribute?.('data-focus-key') || previous?.id || null;
  const oldSelection = previous && typeof previous.selectionStart === 'number' ? [previous.selectionStart, previous.selectionEnd] : null;
  const openingModal = Boolean(state.modal) && !modalPreviouslyOpen;
  const closingModal = !state.modal && modalPreviouslyOpen;
  const node = selectedNode();
  let mount = document.querySelector('#page-host');
  if (!incremental || !mount || mount.nodeType !== 1) { renderWhole(node); modalPreviouslyOpen = Boolean(state.modal); return; }
  const shell = `${state.connection}|${state.activeNav}|${state.language}|${state.importing}|${VERSION}|${capabilities.native}`;
  let changed = false;
  if (shell !== shellSignature) {
    shellSignature = shell;
    app.innerHTML = shellMarkup();
    // The shell rebuild replaces the host element, so the old reference is detached.
    mount = document.querySelector('#page-host');
    lastPageMarkup = ''; lastModalMarkup = ''; lastToastMarkup = '';
    changed = true;
  }
  const page = pageMarkup(node);
  if (page !== lastPageMarkup) {
    const offsets = captureScroll();
    mount.innerHTML = page; lastPageMarkup = page; restoreScroll(offsets); changed = true;
  }
  const modal = modalMarkupForState();
  if (modal !== lastModalMarkup) {
    const host = document.querySelector('#modal-host');
    if (host) { host.innerHTML = modal; lastModalMarkup = modal; changed = true; }
  }
  const toast = toastMarkup();
  if (toast !== lastToastMarkup) {
    const host = document.querySelector('#toast-host');
    if (host) { host.innerHTML = toast; lastToastMarkup = toast; changed = true; }
  }
  if (!changed && !openingModal && !closingModal) { modalPreviouslyOpen = Boolean(state.modal); return; }
  bindEvents();
  if (openingModal) document.querySelector('#import-input')?.focus();
  else if (closingModal) (document.querySelector('[data-action="add"]') || document.querySelector('[data-action="refresh"]'))?.focus();
  else if (focusKey) {
    const replacement = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`) || document.getElementById(focusKey);
    replacement?.focus();
    if (oldSelection && replacement?.setSelectionRange) replacement.setSelectionRange(...oldSelection);
  }
  modalPreviouslyOpen = Boolean(state.modal);
}

function sparkline(values) {
  if (!values.length) return `<div class="spark-empty">${escapeHtml(t('home.noSamples'))}</div>`;
  const width = 260, height = 46, max = Math.max(...values, 1);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
    const y = height - Math.max(2, (value / max) * (height - 4));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(t('home.latencyChart'))}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

function homeMarkup(selected) {
  const [status, detail, statusClass] = statusInfo();
  const displayed = state.connection === 'connected' && state.activeNode ? state.activeNode : selected;
  const reason = state.connection === 'connected' ? '' : unsupportedReason(selected);
  const differs = state.connection === 'connected' && selected && !sameConfig(state.activeNode, selected);
  const disabled = toggleDisabled(selected) ? 'disabled' : '';
  const subscriptions = state.subscriptions.length;
  const activePing = state.connection === 'connected' ? (state.proxyPing ?? selected?.ping) : selected?.ping;
  return `<section class="home">
    <div class="status-card ${statusClass}">
      <div class="status-head"><span class="status-dot"></span><span class="status-label">${escapeHtml(status)}</span>${state.connection === 'connected' ? `<span class="status-timer">${icon('clock', 13)}<span data-duration>${formatDuration()}</span></span>` : ''}</div>
      <p class="status-detail">${escapeHtml(detail)}</p>
      <button class="status-server" data-nav="servers" ${state.servers.length ? '' : 'disabled'}>
        ${displayed ? nodeFlag(displayed, 'flag flag-lg') : flagMarkup('', 'flag flag-lg')}
        <span class="status-server-copy"><small>${escapeHtml(state.connection === 'connected' ? t('home.activeServer') : t('home.selectedServer'))}</small><strong>${escapeHtml(displayed ? displayName(displayed) : t('home.noServer'))}</strong><span>${escapeHtml(displayed ? nodePlace(displayed) : t('home.addConfig'))}</span></span>
        ${icon('chevron', 15, 'muted-icon')}
      </button>
      <div class="status-metrics">
        <div><span>${escapeHtml(t('home.ping'))}</span><strong class="${pingClass(activePing)}">${Number.isFinite(activePing) ? `${activePing} ${t('unit.ms')}` : '—'}</strong></div>
        <div><span>${escapeHtml(t('home.route'))}</span><strong>${escapeHtml(t(`route.short.${state.connection === 'connected' ? state.activeRouteMode : state.routeMode}`))}</strong></div>
        <div><span>${escapeHtml(t('home.externalIp'))}</span><strong>${state.connection === 'connected' && !state.proxyCheckFailed ? escapeHtml(state.externalIp || '—') : '—'}</strong></div>
      </div>
      <div class="spark-block"><div class="spark-head"><span>${escapeHtml(t('home.latency'))}</span><span class="spark-value">${Number.isFinite(activePing) ? `${activePing} ${t('unit.ms')}` : '—'}</span></div>${sparkline(state.latencyHistory)}</div>
      <button class="connect-button ${state.connection === 'connected' ? 'danger' : 'primary'}" data-action="toggle" data-focus-key="home-connect" ${disabled}>${icon('power', 16)}${escapeHtml(actionLabel())}</button>
      <div class="home-switches">
        <div class="home-switch">
          <label class="switch-text" for="home-dns-protection"><strong>${escapeHtml(t('home.dnsProtection'))}</strong><small>${escapeHtml(t('home.dnsProtectionHint'))}</small></label>
          <span class="info" tabindex="0" role="note" aria-label="${escapeHtml(t('home.dnsProtectionInfo'))}" title="${escapeHtml(t('home.dnsProtectionInfo'))}">i</span>
          <label class="switch"><input type="checkbox" id="home-dns-protection" data-toggle="dns-protection" aria-label="${escapeHtml(t('home.dnsProtection'))}" ${dnsProtectionOn() ? 'checked' : ''}/><span></span></label>
        </div>
        <div class="home-switch">
          <label class="switch-text" for="home-fast-reconnect"><strong>${escapeHtml(t('home.fastReconnect'))}</strong><small>${escapeHtml(t('home.fastReconnectHint'))}</small></label>
          <span class="info" tabindex="0" role="note" aria-label="${escapeHtml(t('home.fastReconnectInfo'))}" title="${escapeHtml(t('home.fastReconnectInfo'))}">i</span>
          <label class="switch"><input type="checkbox" id="home-fast-reconnect" data-toggle="fast-reconnect" aria-label="${escapeHtml(t('home.fastReconnect'))}" ${fastReconnectOn() ? 'checked' : ''}/><span></span></label>
        </div>
      </div>
      ${reason ? `<div class="inline-warning">${escapeHtml(reason)}</div>` : ''}
      ${differs ? `<div class="inline-note">${escapeHtml(t('home.activeUnchanged'))}</div>` : ''}
      ${selected?.source === 'subscription-retained' ? `<div class="inline-warning">${escapeHtml(t('home.retained'))}</div>` : ''}
      ${state.connection === 'connected' && state.proxyCheckFailed ? `<div class="inline-warning" role="status">${escapeHtml(t('home.proxyCheckFailed'))}</div>` : ''}
      ${state.connection === 'error' ? `<div class="error-box" role="alert">${escapeHtml(messageText(state.message))}</div>` : ''}
      ${state.diagnostics ? `<details class="diagnostics"><summary>${escapeHtml(t('home.diagnostics'))}</summary><pre>${escapeHtml(state.diagnostics)}</pre></details>` : ''}
    </div>
    <div class="home-side">
      <div class="panel"><div class="panel-head"><span>${escapeHtml(t('home.quick'))}</span></div>
        <div class="quick-grid">
          <button class="quick" data-nav="servers">${icon('server', 16)}<span>${escapeHtml(t('home.allServers'))}</span><strong>${state.servers.length}</strong></button>
          <button class="quick" data-nav="settings">${icon('settings', 16)}<span>${escapeHtml(t('home.route'))}</span><strong>${escapeHtml(t(`route.short.${state.routeMode}`))}</strong></button>
          <button class="quick" data-action="speed-test" ${state.connection !== 'connected' || state.speedRunning ? 'disabled' : ''}>${icon('activity', 16)}<span>${escapeHtml(t('speed.title'))}</span><strong>${state.speedRunning ? '…' : (state.speed ? `${state.speed.down} ${t('speed.unit')}` : '—')}</strong></button>
          <button class="quick" data-action="ping-all" ${state.pingJob ? 'disabled' : ''}>${icon('activity', 16)}<span>${escapeHtml(t('home.checkPing'))}</span><strong>${state.pingJob ? `${state.pingJob.done}/${state.pingJob.total}` : '—'}</strong></button>
          <button class="quick" data-nav="logs">${icon('logs', 16)}<span>${escapeHtml(t('home.logs'))}</span><strong>${state.logs.length}</strong></button>
        </div>
      </div>
      <div class="panel"><div class="panel-head"><span>${escapeHtml(t('home.subscriptions'))}</span><button class="link-button" data-action="add">${escapeHtml(t('servers.add'))}</button></div>
        ${subscriptions ? state.subscriptions.map((item) => `<div class="mini-sub"><span class="mini-sub-name">${escapeHtml(item.name)}</span><span class="muted">${state.servers.filter((node) => node.subscriptionId === item.id).length}</span></div>`).join('') : `<p class="muted small">${escapeHtml(t('home.noSubscriptions'))}</p>`}
      </div>
      <div class="panel"><div class="panel-head"><span>${escapeHtml(t('home.session'))}</span></div>
        <div class="kv"><span>${escapeHtml(t('home.started'))}</span><strong>${state.connectedAt ? new Date(state.connectedAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '—'}</strong></div>
        <div class="kv"><span>${escapeHtml(t('home.protocol'))}</span><strong>${escapeHtml(selected?.outbound?.type?.toUpperCase() || '—')}</strong></div>
        <div class="kv"><span>${escapeHtml(t('home.version'))}</span><strong>${escapeHtml(VERSION)}</strong></div>
      </div>
    </div>
  </section>`;
}

function serverRow(node) {
  const reason = unsupportedReason(node);
  const active = state.connection === 'connected' && sameConfig(state.activeNode, node);
  const testing = node.availability === 'testing';
  const selected = node.id === state.selectedId;
  return `<button class="server-row ${selected ? 'selected' : ''} ${active ? 'active' : ''}" data-server="${escapeHtml(node.id)}" data-focus-key="server-${escapeHtml(node.id)}" ${busy() ? 'disabled' : ''} aria-pressed="${selected}">
    ${nodeFlag(node)}
    <span class="server-name"><span class="server-title">${escapeHtml(displayName(node))}${node.favorite ? `<span class="favorite" aria-label="${escapeHtml(t('servers.favorite'))}">★</span>` : ''}</span><span class="server-sub">${escapeHtml(node.outbound?.server || nodePlace(node))}${reason ? ` · <span class="warn-text">${escapeHtml(reason)}</span>` : ''}</span></span>
    ${protocolBadge(node)}
    <span class="server-ping ${testing ? 'ping-testing' : pingClass(node.ping)}">${testing ? `<span class="spinner"></span>` : escapeHtml(pingText(node))}</span>
    ${icon('chevron', 14, 'row-chevron')}
  </button>`;
}

function groupMarkup(group) {
  const collapsed = state.collapsed.includes(group.code || 'unknown');
  const name = group.code ? group.name : t('servers.groupUnknown');
  return `<section class="server-group">
    <button class="group-head" data-group="${escapeHtml(group.code || 'unknown')}" aria-expanded="${!collapsed}">
      ${group.code ? flagMarkup(group.code) : flagMarkup('')}
      <strong>${escapeHtml(name)}</strong>
      <span class="group-count">${group.count}</span>
      <span class="group-ping ${pingClass(group.ping)}">${Number.isFinite(group.ping) ? `${group.ping} ${t('unit.ms')}` : ''}</span>
      ${icon('chevron', 14, collapsed ? 'rot-0' : 'rot-90')}
    </button>
    ${collapsed ? '' : group.nodes.map(serverRow).join('')}
  </section>`;
}

function subscriptionCard(item) {
  const count = state.servers.filter((node) => node.subscriptionId === item.id).length;
  const busyThis = state.subscriptionBusy === item.id;
  const usage = item.meta && Number.isFinite(item.meta.used) && Number.isFinite(item.meta.total) && item.meta.total > 0 ? Math.min(100, Math.max(0, item.meta.used / item.meta.total * 100)) : null;
  return `<div class="sub-card">
    <div class="sub-icon">${icon('link', 15)}</div>
    <div class="sub-copy"><strong>${escapeHtml(item.name)}</strong><span class="muted small">${escapeHtml(t('servers.subServers', { count }))} · ${escapeHtml(t('servers.subUpdated', { date: formatDate(item.updatedAt) }))}</span>${usage === null ? '' : `<div class="usage"><div class="usage-track"><i style="width:${usage}%"></i></div><span class="muted small">${escapeHtml(formatBytes(item.meta.used))} / ${escapeHtml(formatBytes(item.meta.total))}</span></div>`}</div>
    <div class="sub-actions">${item.meta?.supportUrl ? `<button class="button small" data-action="open-link" data-url="${escapeHtml(item.meta.supportUrl)}">${escapeHtml(t('subscription.support'))}</button>` : ''}${item.meta?.homeUrl ? `<button class="button small" data-action="open-link" data-url="${escapeHtml(item.meta.homeUrl)}">${escapeHtml(t('subscription.account'))}</button>` : ''}<button class="icon-button" data-action="refresh-sub" data-id="${escapeHtml(item.id)}" title="${escapeHtml(t('servers.refreshSub'))}" aria-label="${escapeHtml(t('servers.refreshSub'))}" ${busyThis ? 'disabled' : ''}>${busyThis ? '<span class="spinner"></span>' : icon('refresh', 15)}</button><button class="icon-button danger" data-action="ask-delete-sub" data-id="${escapeHtml(item.id)}" title="${escapeHtml(t('servers.deleteSub'))}" aria-label="${escapeHtml(t('servers.deleteSub'))}" ${busyThis ? 'disabled' : ''}>${icon('trash', 15)}</button></div>
  </div>`;
}

function serversMarkup(node) {
  const nodes = visibleNodes();
  const groups = groupByCountry(nodes, getLanguage());
  const [status, , statusClass] = statusInfo();
  const reason = unsupportedReason(node);
  const activeDiffers = state.connection === 'connected' && !sameConfig(state.activeNode, node);
  const job = state.pingJob;
  const pingLabel = (value) => Number.isFinite(value) ? `${escapeHtml(value)} ${t('unit.ms')}` : '—';
  const headerPing = job ? `${t('servers.pinging')} ${job.done}/${job.total}` : t('servers.pingAll');
  return `<div class="workspace">
    <section class="server-column">
      <div class="section-head">
        <div class="section-title"><h2>${escapeHtml(t('servers.title'))}</h2><span class="muted small">${escapeHtml(t('servers.count', { count: state.servers.length }))}${state.subscriptions.length ? ` · ${escapeHtml(t('servers.subCount', { count: state.subscriptions.length }))}` : ''}</span></div>
        <button class="button primary" data-action="add">${icon('plus', 15)}${escapeHtml(t('servers.add'))}</button>
      </div>
      ${job ? `<div class="ping-progress"><div class="ping-bar"><i style="width:${job.total ? Math.round(job.done / job.total * 100) : 0}%"></i></div><span>${job.done}/${job.total}</span><button class="button small" data-action="cancel-ping">${escapeHtml(t('servers.cancelPing'))}</button></div>` : ''}
      <div class="toolbar">
        <label class="search">${icon('search', 15)}<input id="server-search" data-focus-key="server-search" value="${escapeHtml(state.search)}" placeholder="${escapeHtml(t('servers.search'))}" aria-label="${escapeHtml(t('servers.search'))}"/></label>
        <label class="select-wrap">${icon('filter', 14)}<select id="server-sort" aria-label="${escapeHtml(t('servers.sortBy'))}"><option value="country" ${state.sort === 'country' ? 'selected' : ''}>${escapeHtml(t('servers.sortCountry'))}</option><option value="ping" ${state.sort === 'ping' ? 'selected' : ''}>${escapeHtml(t('servers.sortPing'))}</option><option value="name" ${state.sort === 'name' ? 'selected' : ''}>${escapeHtml(t('servers.sortName'))}</option></select></label>
        <button class="button" data-action="refresh-all" title="${escapeHtml(t('servers.refreshSub'))}" aria-label="${escapeHtml(t('servers.refreshSub'))}" ${state.refreshAllBusy || !state.subscriptions.length ? 'disabled' : ''}>${state.refreshAllBusy ? '<span class="spinner"></span>' : icon('refresh', 15)}</button>
        <button class="button" data-action="ping-all" title="${escapeHtml(t('servers.pingAll'))}" aria-label="${escapeHtml(headerPing)}" ${job ? 'disabled' : ''}>${icon('activity', 15)}<span class="small">${escapeHtml(job ? `${job.done}/${job.total}` : t('servers.pingShort'))}</span></button>
      </div>
      ${state.subscriptions.length ? `<div class="sub-list">${state.subscriptions.map(subscriptionCard).join('')}</div>` : ''}
      <div class="server-list">${nodes.length ? groups.map(groupMarkup).join('') : `<div class="empty"><strong>${escapeHtml(state.servers.length ? t('servers.notFound') : t('servers.emptyTitle'))}</strong><span>${escapeHtml(state.servers.length ? t('servers.notFoundHint') : t('servers.emptyHint'))}</span>${!state.servers.length ? `<button class="button primary" data-action="add">${escapeHtml(t('servers.addServer'))}</button>` : ''}</div>`}</div>
    </section>
    <section class="detail-column">
      <div class="detail-head"><span class="overline">${escapeHtml(t('control.selected'))}</span><span class="connection-badge ${statusClass}"><i></i>${escapeHtml(status)}</span></div>
      <div class="detail-card">
        ${node ? `<div class="detail-node">${nodeFlag(node, 'flag flag-lg')}<div><h3>${escapeHtml(displayName(node))}</h3><p class="muted small">${escapeHtml(nodePlace(node))} · ${escapeHtml(node.outbound?.type?.toUpperCase() || '')}</p></div></div>
        <div class="detail-metrics"><div><span>${escapeHtml(t('control.tcp'))}</span><strong class="${pingClass(node.ping)}">${!tcpTestApplicable(node) ? escapeHtml(t('control.tcpNotApplicable')) : node.availability === 'testing' ? escapeHtml(t('control.testing')) : pingLabel(node.ping)}</strong></div><div><span>${escapeHtml(t('control.viaProxy'))}</span><strong class="${pingClass(state.proxyPing)}">${state.proxyTesting ? escapeHtml(t('control.testing')) : pingLabel(state.proxyPing)}</strong></div></div>
        ${reason ? `<div class="inline-warning">${escapeHtml(reason)}</div>` : ''}
        <div class="detail-actions"><button class="button small" data-action="ping" ${!tcpTestApplicable(node) || node.availability === 'testing' || !capabilities.native || state.pingJob ? 'disabled' : ''}>${icon('activity', 14)}${escapeHtml(t('control.testTcp'))}</button><button class="button small" data-action="proxy-ping" ${state.connection !== 'connected' || state.proxyTesting || !capabilities.native ? 'disabled' : ''}>${escapeHtml(t('control.testProxy'))}</button><button class="button small" data-action="favorite" aria-pressed="${Boolean(node.favorite)}">${icon('star', 14)}${escapeHtml(node.favorite ? t('control.favoriteRemove') : t('control.favoriteAdd'))}</button><button class="button small danger" data-action="remove" ${busy() || state.connection === 'connected' ? 'disabled' : ''}>${icon('trash', 14)}${escapeHtml(t('control.delete'))}</button></div>` : `<div class="empty small"><span>${escapeHtml(t('control.noSelection'))}</span></div>`}
      </div>
      ${activeDiffers ? `<div class="inline-note">${escapeHtml(t('control.currentlyConnected', { name: state.activeNode?.name || t('servers.serverFallback') }))}</div>` : ''}
      ${node?.source === 'subscription-retained' ? `<div class="inline-warning">${escapeHtml(t('control.notApplied'))}</div>` : ''}
      ${state.connection === 'connected' && state.proxyCheckFailed ? `<div class="inline-warning">${escapeHtml(t('notice.proxyCheckFailedShort'))}</div>` : ''}
      <button class="connect-button ${state.connection === 'connected' ? 'danger' : 'primary'}" data-action="toggle" data-focus-key="detail-connect" ${toggleDisabled(node) ? 'disabled' : ''}>${icon('power', 16)}${escapeHtml(actionLabel())}</button>
      <div class="panel compact"><div class="kv"><span>${escapeHtml(t('control.time'))}</span><strong data-duration>${state.connection === 'connected' ? formatDuration() : '—'}</strong></div><div class="kv"><span>${escapeHtml(t('control.mode'))}</span><strong>${escapeHtml(routeTitle(state.connection === 'connected' ? state.activeRouteMode : state.routeMode))}</strong></div><div class="kv"><span>${escapeHtml(t('control.externalIp'))}</span><strong>${state.connection === 'connected' && !state.proxyCheckFailed ? escapeHtml(state.externalIp || '—') : '—'}</strong></div></div>
      ${state.connection === 'error' ? `<div class="error-box" role="alert">${escapeHtml(messageText(state.message))}</div>` : ''}
      ${state.diagnostics ? `<details class="diagnostics"><summary>${escapeHtml(t('home.diagnostics'))}</summary><pre>${escapeHtml(state.diagnostics)}</pre></details>` : ''}
    </section>
  </div>`;
}

function clientUpdateMarkup() {
  const update = state.clientUpdate || {};
  const info = update.info;
  const status = update.status || 'idle';
  let statusText = t('settings.clientUpdateUnknown');
  if (status === 'checking') statusText = t('settings.checkingClientUpdate');
  else if (status === 'downloading') statusText = t('settings.clientUpdateDownloading');
  else if (status === 'installing') statusText = t('settings.clientUpdateInstalling');
  else if (status === 'disconnecting') statusText = t('settings.clientUpdateDisconnecting');
  else if (status === 'error') statusText = t('settings.clientUpdateError', { error: update.error || '' });
  else if (info?.available) statusText = t('settings.clientUpdateAvailable', { version: info.latestVersion });
  else if (info) statusText = t('settings.clientUpdateCurrent');
  const notes = info?.available && info.notes
    ? `<div class="update-notes"><strong>${escapeHtml(t('settings.clientUpdateNotes'))}</strong><div>${escapeHtml(info.notes)}</div></div>`
    : '';
  const reason = info?.available && info.reason
    ? `<small class="warn">${escapeHtml(info.reason)}</small>`
    : '';
  const signature = info?.available
    ? `<small class="${info.signatureVerified ? 'muted' : 'warn'}">${escapeHtml(t(info.signatureVerified ? 'settings.clientUpdateSignature' : 'settings.clientUpdateSignatureMissing'))}</small>`
    : '';
  const disabled = status === 'checking' || status === 'downloading' || status === 'installing' || status === 'disconnecting';
  const installDisabled = disabled || !info?.canInstall || busy() || state.cleanupNeeded;
  const installLabel = state.connection === 'connected' ? t('settings.clientUpdateDisconnectInstall') : t('settings.clientUpdateDownload');
  const install = info?.available
    ? `<button class="button small" id="install-client-update" ${installDisabled ? 'disabled' : ''}>${icon('download', 14)}${escapeHtml(installLabel)}</button>`
    : '';
  const release = info?.releaseUrl
    ? `<button class="button small" data-action="open-client-release">${escapeHtml(t('settings.clientUpdateOpen'))}</button>`
    : '';
  const admin = hostIsMac ? `<div class="setting"><small>${escapeHtml(t('settings.clientUpdateAdmin'))}</small></div>` : '';
  return `<div class="panel"><div class="panel-head"><span>${escapeHtml(t('settings.clientUpdate'))}</span></div>
    <div class="setting"><div><strong>${escapeHtml(t('settings.clientVersion'))}</strong></div><span class="mono">${escapeHtml(VERSION)}</span></div>
    <div class="setting"><div><strong>${escapeHtml(statusText)}</strong><small>${escapeHtml(t('settings.clientUpdateHint'))}</small>${signature}${reason}${notes}</div><div class="row-actions"><button class="button small" id="check-client-update" ${disabled ? 'disabled' : ''}>${icon('refresh', 14)}${escapeHtml(t('settings.checkClientUpdate'))}</button>${install}${release}</div></div>
    ${admin}
  </div>`;
}
function settingsMarkup() {
  const nodeMode = state.settings?.nodeMode === 'auto' ? 'auto' : 'single';
  const dnsMode = dnsModeIds.includes(state.settings?.dns) ? state.settings.dns : 'system';
  const source = state.routing?.profile ? t('settings.routeSourceSubscription') : t('settings.routeSourceBuiltin');
  const rejected = state.routing?.unsupported?.length || 0;
  const routeNote = `${escapeHtml(t('settings.routeSource', { source }))}${rejected ? `<br/><span class="warn-text">${escapeHtml(t('settings.routeUnsupported', { count: rejected }))}</span>` : ''}${state.routing?.dns ? `<br/><span class="muted">${escapeHtml(t('settings.routeDnsIgnored'))}</span>` : ''}`;
  const dnsResult = state.dnsCheck
    ? `${escapeHtml(t(state.dnsCheck.ok ? 'settings.dnsCheckOk' : 'settings.dnsCheckFail', { server: state.dnsCheck.server || '', ip: state.dnsCheck.ip || '' }))}${state.dnsCheck.ok ? ` · ${escapeHtml(t('settings.dnsCheckPath', { path: t(`settings.dnsVia.${state.dnsCheck.via || 'bootstrap-ip'}`, { ip: state.dnsCheck.ip || '' }) }))}` : ''}`
    : '';
  return `<section class="page narrow">
    <div class="panel"><div class="panel-head"><span>${escapeHtml(t('settings.general'))}</span></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.language'))}</strong><small>${escapeHtml(t('settings.languageHint'))}</small></div><select id="language" aria-label="${escapeHtml(t('settings.language'))}"><option value="ru" ${state.language === 'ru' ? 'selected' : ''}>${escapeHtml(t('settings.languageRu'))}</option><option value="en" ${state.language === 'en' ? 'selected' : ''}>${escapeHtml(t('settings.languageEn'))}</option></select></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.routeMode'))}</strong><small>${escapeHtml(routeDescription(state.routeMode))}${escapeHtml(state.connection === 'connected' ? t('settings.routeHintConnected') : '')}<br/>${routeNote}</small></div><select id="route-mode" aria-label="${escapeHtml(t('settings.routeMode'))}" ${busy() || state.connection === 'connected' || state.cleanupNeeded ? 'disabled' : ''}>${routeModeIds.map((id) => `<option value="${id}" ${id === state.routeMode ? 'selected' : ''}>${escapeHtml(routeTitle(id))}</option>`).join('')}</select></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.nodeMode'))}</strong><small>${escapeHtml(t(`settings.nodeMode.${nodeMode}.hint`))}</small></div><select id="node-mode" aria-label="${escapeHtml(t('settings.nodeMode'))}" ${busy() || state.connection === 'connected' || state.cleanupNeeded ? 'disabled' : ''}><option value="single" ${nodeMode === 'single' ? 'selected' : ''}>${escapeHtml(t('settings.nodeMode.single'))}</option><option value="auto" ${nodeMode === 'auto' ? 'selected' : ''}>${escapeHtml(t('settings.nodeMode.auto'))}</option></select></div>
      <div class="setting"><div><strong>${escapeHtml(t('speed.url'))}</strong><small>${escapeHtml(t('speed.urlHint'))}</small></div><input id="speed-url" type="url" class="text-input" placeholder="https://" value="${escapeHtml(state.settings?.speedUrl || '')}"/></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.perf.sniffing'))}</strong><small>${escapeHtml(t('settings.perf.sniffingHint'))}</small></div><label class="switch"><input type="checkbox" id="perf-sniffing" ${state.settings?.perf?.sniffing ? 'checked' : ''}/><span></span></label></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.perf.preferIPv4'))}</strong><small>${escapeHtml(t('settings.perf.preferIPv4Hint'))}</small></div><label class="switch"><input type="checkbox" id="perf-ipv4" ${state.settings?.perf?.preferIPv4 ? 'checked' : ''}/><span></span></label></div>
      <div class="setting"><div><strong>${escapeHtml(t('home.fastReconnect'))}</strong><small>${escapeHtml(t('home.fastReconnectHint'))}</small><small class="muted">${escapeHtml(t('home.fastReconnectInfo'))}</small></div><label class="switch"><input type="checkbox" id="settings-fast-reconnect" data-toggle="fast-reconnect" aria-label="${escapeHtml(t('home.fastReconnect'))}" ${state.settings?.fastReconnect ? 'checked' : ''}/><span></span></label></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.debug'))}</strong><small>${escapeHtml(t('settings.debugHint'))}</small></div><label class="switch"><input type="checkbox" id="debug-mode" ${state.settings?.debug ? 'checked' : ''}/><span></span></label></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.xhttpQuery'))}</strong><small>${escapeHtml(t('settings.xhttpQueryHint'))}</small></div><label class="switch"><input type="checkbox" id="xhttp-query" ${state.settings?.xhttpQueryParams !== false ? 'checked' : ''}/><span></span></label></div>
    </div>
    <div class="panel"><div class="panel-head"><span>${escapeHtml(t('settings.data'))}</span></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.storage'))}</strong><small>${escapeHtml(t('settings.storageHint', { count: state.servers.length, subs: state.subscriptions.length }))}</small></div><button class="button small danger" data-action="clear-data">${icon('trash', 14)}${escapeHtml(t('settings.clearData'))}</button></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.version'))}</strong><small>${escapeHtml(t('settings.versionHint'))}</small></div><span class="mono">${escapeHtml(VERSION)}</span></div>
    </div>
    ${clientUpdateMarkup()}
    <div class="panel"><div class="panel-head"><span>${escapeHtml(t('settings.automation'))}</span></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.autostart'))}</strong><small>${escapeHtml(t('settings.autostartHint'))}</small></div><label class="switch"><input type="checkbox" id="settings-autostart" ${state.settings?.autostart ? 'checked' : ''}/><span></span></label></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.autoconnect'))}</strong><small>${escapeHtml(t('settings.autoconnectHint'))}</small></div><label class="switch"><input type="checkbox" id="settings-autoconnect" ${state.settings?.autoconnect ? 'checked' : ''}/><span></span></label></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.closeToTray'))}</strong><small>${escapeHtml(t('settings.closeToTrayHint'))}</small></div><label class="switch"><input type="checkbox" id="settings-close-to-tray" ${state.settings?.closeToTray ? 'checked' : ''}/><span></span></label></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.autoUpdate'))}</strong><small>${escapeHtml(t('settings.autoUpdateHint'))}</small></div><select id="auto-update-hours" aria-label="${escapeHtml(t('settings.autoUpdate'))}">${[[0, 'off'], [6, '6'], [12, '12'], [24, '24']].map(([value, key]) => `<option value="${value}" ${Number(state.settings?.autoUpdateHours ?? 12) === value ? 'selected' : ''}>${escapeHtml(t(`settings.autoUpdate.${key}`))}</option>`).join('')}</select></div>
      <div class="setting"><div><strong>${escapeHtml(t('home.dnsProtection'))}</strong><small>${escapeHtml(t(`settings.dnsMode.${dnsMode}.desc`))}</small><small class="muted">${escapeHtml(t('home.dnsProtectionInfo'))}</small></div><label class="switch"><input type="checkbox" id="settings-dns-protection" data-toggle="dns-protection" aria-label="${escapeHtml(t('home.dnsProtection'))}" ${dnsMode === 'builtin' ? 'checked' : ''}/><span></span></label></div>
      <div class="setting dns-check-row"><button class="button small" id="dns-check" ${state.dnsCheck?.running ? 'disabled' : ''}>${escapeHtml(t('settings.checkDns'))}</button><span class="dns-result" role="status">${dnsResult}</span></div>
      <div class="setting"><div><strong>${escapeHtml(t('settings.failover'))}</strong></div><select id="failover-mode" aria-label="${escapeHtml(t('settings.failover'))}">${['country', 'any', 'never'].map((id) => `<option value="${id}" ${id === (state.settings?.failover || 'country') ? 'selected' : ''}>${escapeHtml(t(`settings.failoverMode.${id}`))}</option>`).join('')}</select></div>
    </div>
  </section>`;
}

function statsMarkup() {
  const totalUsed = state.subscriptions.reduce((sum, item) => sum + (Number.isFinite(item.meta?.used) ? item.meta.used : 0), 0);
  const totalLimit = state.subscriptions.reduce((sum, item) => sum + (Number.isFinite(item.meta?.total) ? item.meta.total : 0), 0);
  return `<section class="page"><div class="stat-grid">
    <div class="stat-card"><span>${escapeHtml(t('stats.state'))}</span><strong>${escapeHtml(statusInfo()[0])}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('stats.time'))}</span><strong data-duration>${state.connection === 'connected' ? formatDuration() : '—'}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('stats.externalIp'))}</span><strong>${state.connection === 'connected' && !state.proxyCheckFailed ? escapeHtml(state.externalIp || '—') : '—'}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('stats.servers'))}</span><strong>${state.servers.length}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('stats.subscriptions'))}</span><strong>${state.subscriptions.length}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('stats.used'))}</span><strong>${totalUsed ? formatBytes(totalUsed) : '—'}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('stats.limit'))}</span><strong>${totalLimit ? formatBytes(totalLimit) : '—'}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('speed.title'))}</span><strong>${state.speed ? `${state.speed.down} / ${state.speed.up} ${t('speed.unit')}` : '—'}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('speed.latency'))}</span><strong>${state.speed ? `${state.speed.latency} ${t('unit.ms')}` : '—'}</strong></div>
    <div class="stat-card"><span>${escapeHtml(t('stats.latency'))}</span><strong class="${pingClass(state.proxyPing)}">${Number.isFinite(state.proxyPing) ? `${state.proxyPing} ${t('unit.ms')}` : '—'}</strong></div>
  </div><p class="muted small">${escapeHtml(t('stats.note'))}</p></section>`;
}

function logsMarkup() {
  return `<section class="page"><div class="panel">
    <div class="panel-head"><span>${escapeHtml(t('logs.title'))}</span><div class="head-actions"><label class="inline-check"><input type="checkbox" id="debug-mode" ${state.settings?.debug ? 'checked' : ''}/>${escapeHtml(t('logs.debug'))}</label><button class="button small" data-action="copy-logs">${icon('copy', 14)}${escapeHtml(t('logs.copy'))}</button><button class="button small" data-action="copy-diagnostics">${icon('copy', 14)}${escapeHtml(t('logs.copyDiagnostics'))}</button><button class="button small" data-action="refresh-logs">${icon('refresh', 14)}${escapeHtml(t('logs.refresh'))}</button></div></div>
    <p class="muted small">${escapeHtml(t('logs.debugHint'))}</p>
    ${state.proxyWarning ? `<p class="warn-text">${escapeHtml(t('logs.proxyWarningLine', { text: state.proxyWarning }))}</p>` : ''}
    <details class="diagnostics"><summary>${escapeHtml(t('logs.diagnostics'))}</summary><pre class="log-view small-log">${escapeHtml(state.proxyDiagnostics || t('logs.diagnosticsHint'))}</pre></details>
    <pre class="log-view">${escapeHtml(state.logs.join('\n') || t('logs.empty'))}</pre>
  </div></section>`;
}

function aboutMarkup() {
  return `<section class="page narrow"><div class="panel about">
    <img class="about-mark" src="/potato-mark.png" alt=""/>
    <h2>KartoshkaVPN <span class="mono">${escapeHtml(VERSION)}</span></h2>
    <p>${escapeHtml(t('about.body1'))}</p><p>${escapeHtml(t('about.body2'))}</p><p>${escapeHtml(t('about.body3'))}</p>
    <div class="about-links"><a href="https://github.com/lifeisviolence-png/kartoshka-vpn" target="_blank" rel="noreferrer">${icon('link', 14)} GitHub</a><span class="muted small">${escapeHtml(t('about.licenses'))}</span></div>
  </div></section>`;
}

function modalMarkup() {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><div><h2 id="modal-title">${escapeHtml(t('modal.title'))}</h2><p class="muted small">${escapeHtml(t('modal.intro'))}</p></div><button class="icon-button" data-action="close-modal" aria-label="${escapeHtml(t('app.close'))}" ${state.importing ? 'disabled' : ''}>${icon('close', 16)}</button></div><label class="visually-hidden" for="import-input">${escapeHtml(t('modal.label'))}</label><textarea id="import-input" data-focus-key="import-input" placeholder="${escapeHtml(t('modal.placeholder'))}" ${state.importing ? 'disabled' : ''}>${escapeHtml(state.pendingUrl)}</textarea><div class="modal-hint">${escapeHtml(t('modal.hint'))}</div>${state.importError ? `<div class="modal-error" role="alert">${escapeHtml(state.importError)}</div>` : ''}<div class="modal-actions"><button class="button" data-action="close-modal" ${state.importing ? 'disabled' : ''}>${escapeHtml(t('app.cancel'))}</button><button class="button primary" data-action="import" ${state.importing ? 'disabled' : ''}>${state.importing ? `<span class="spinner"></span>${escapeHtml(t('modal.importing'))}` : escapeHtml(t('modal.import'))}</button></div></section></div>`;
}
function groupIssues(items) {
  const groups = new Map();
  for (const item of items) {
    const text = `${item.line ? `${item.line}: ` : ''}${t(`err.${item.key}`, item.params || {})}`;
    const base = t(`err.${item.key}`, item.params || {});
    if (!groups.has(base)) groups.set(base, { text: base, lines: [], count: 0 });
    const group = groups.get(base);
    group.count += 1;
    if (item.line) group.lines.push(item.line);
  }
  return [...groups.values()];
}
function issueList(items, kind) {
  if (!items?.length) return '';
  const groups = groupIssues(items);
  return `<div class="result-block"><strong>${escapeHtml(t(kind === 'error' ? 'modal.resultErrors' : 'modal.resultWarnings'))}</strong><ul>${groups.slice(0, 40).map((group) => `<li>${escapeHtml(group.count > 1 ? `${t('modal.grouped', { count: group.count })}: ${group.text}` : group.text)}${group.lines.length > 1 ? ` <span class="muted">(${group.lines.slice(0, 6).join(', ')}${group.lines.length > 6 ? '…' : ''})</span>` : ''}</li>`).join('')}</ul></div>`;
}
function resultMarkup() {
  const plan = state.pendingImport;
  if (!plan) return '';
  const ok = plan.nodes.filter((node) => !unsupportedReason(node)).length;
  const failed = plan.errors.length;
  const actionable = plan.nodes.length > 0;
  return `<div class="modal-backdrop"><section class="modal modal-result" role="dialog" aria-modal="true" aria-labelledby="result-title"><div class="modal-head"><div><h2 id="result-title">${escapeHtml(t('modal.resultTitle'))}</h2></div><button class="icon-button" data-action="close-result" aria-label="${escapeHtml(t('app.close'))}">${icon('close', 16)}</button></div><p>${escapeHtml(t('modal.resultLead', { total: plan.total, ok, failed }))}</p>${actionable ? '' : `<div class="modal-error" role="alert">${escapeHtml(t('modal.resultNothing'))}</div>`}${issueList(plan.errors, 'error')}${issueList(plan.warnings, 'warning')}<p class="modal-hint">${escapeHtml(t('modal.resultKept'))}</p><div class="modal-actions"><button class="button" data-action="close-result">${escapeHtml(actionable ? t('modal.resultCancel') : t('app.close'))}</button>${actionable ? `<button class="button primary" data-action="apply-import">${escapeHtml(plan.isSubscription ? t('modal.resultRefresh') : t('modal.resultImport'))}</button>` : ''}</div></section></div>`;
}
function deleteMarkup() {
  const item = state.pendingDelete;
  if (!item) return '';
  const count = state.servers.filter((node) => node.subscriptionId === item.id).length;
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><div class="modal-head"><div><h2 id="delete-title">${escapeHtml(t('servers.deleteSubTitle'))}</h2></div><button class="icon-button" data-action="close-delete" aria-label="${escapeHtml(t('app.close'))}">${icon('close', 16)}</button></div><p>${escapeHtml(t('servers.deleteSubBody', { name: item.name, count }))}</p><div class="modal-actions"><button class="button" data-action="close-delete">${escapeHtml(t('app.cancel'))}</button><button class="button danger" data-action="confirm-delete-sub">${icon('trash', 14)}${escapeHtml(t('servers.deleteSubConfirm'))}</button></div></section></div>`;
}

function bindEvents() {
  document.querySelectorAll('[data-server]').forEach((button) => button.addEventListener('click', () => selectServer(button.dataset.server)));
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', async () => {
    state.activeNav = button.dataset.nav; render(); document.querySelector(`[data-focus-key="nav-${state.activeNav}"]`)?.focus();
    if (state.activeNav === 'logs') { await loadLogs(); await loadProxyDiagnostics(); if (state.activeNav === 'logs') render(); }
  }));
  document.querySelectorAll('[data-group]').forEach((button) => button.addEventListener('click', () => {
    const key = button.dataset.group;
    state.collapsed = state.collapsed.includes(key) ? state.collapsed.filter((item) => item !== key) : [...state.collapsed, key];
    render();
  }));
  document.querySelectorAll('[data-action="add"]').forEach((button) => button.addEventListener('click', () => { state.pendingUrl = ''; state.importError = ''; state.pendingImport = null; state.modal = 'add'; render(); }));
  document.querySelectorAll('[data-action="close-modal"]').forEach((button) => button.addEventListener('click', () => { if (!state.importing) { state.modal = null; state.importError = ''; render(); } }));
  document.querySelectorAll('[data-action="close-result"]').forEach((button) => button.addEventListener('click', () => { state.pendingImport = null; state.modal = null; render(); }));
  document.querySelector('[data-action="apply-import"]')?.addEventListener('click', () => applyPendingImport());
  document.querySelectorAll('[data-action="dismiss-notice"]').forEach((button) => button.addEventListener('click', () => { state.notice = null; render(); }));
  document.querySelectorAll('[data-action="reset-storage"]').forEach((button) => button.addEventListener('click', resetSecureStorage));
  document.querySelectorAll('[data-toggle]').forEach((input) => input.addEventListener('change', () => {
    if (input.dataset.toggle === 'dns-protection') setDnsProtection(input.checked); else setFastReconnect(input.checked);
  }));
  document.querySelectorAll('[data-action="reconnect"]').forEach((button) => button.addEventListener('click', reconnectNow));
  document.querySelector('#dns-check')?.addEventListener('click', checkDns);
  document.querySelectorAll('[data-action="dismiss-toast"]').forEach((button) => button.addEventListener('click', () => { state.toast = null; render(); }));
  document.querySelector('[data-action="toast-action"]')?.addEventListener('click', () => { const action = state.toast?.action; state.toast = null; action?.(); render(); });
  document.querySelector('#server-search')?.addEventListener('input', (event) => { state.search = event.target.value; render(); });
  document.querySelector('#server-sort')?.addEventListener('change', (event) => { state.sort = ['ping', 'name', 'country'].includes(event.target.value) ? event.target.value : 'country'; render(); });
  document.querySelector('#import-input')?.addEventListener('input', (event) => { state.pendingUrl = event.target.value; });
  document.querySelector('[data-action="import"]')?.addEventListener('click', () => runImport(state.pendingUrl, false));
  document.querySelectorAll('[data-action="refresh"]').forEach((button) => button.addEventListener('click', () => {
    if (state.importing) return;
    if (state.subscriptions.length) refreshAll();
    else { state.pendingUrl = ''; state.importError = ''; state.modal = 'add'; render(); }
  }));
  document.querySelectorAll('[data-action="refresh-all"]').forEach((button) => button.addEventListener('click', () => refreshAll()));
  document.querySelectorAll('[data-action="open-link"]').forEach((button) => button.addEventListener('click', async () => {
    const url = httpsLink(button.dataset.url);
    if (!url) return;
    try { await desktopBridge.openExternal(url); }
    catch (error) { state.notice = { type: 'error', text: errorText(error) }; render(); }
  }));
  document.querySelectorAll('[data-action="refresh-sub"]').forEach((button) => button.addEventListener('click', () => refreshSubscription(button.dataset.id)));
  document.querySelectorAll('[data-action="ask-delete-sub"]').forEach((button) => button.addEventListener('click', () => { state.pendingDelete = state.subscriptions.find((item) => item.id === button.dataset.id) || null; state.modal = 'delete-sub'; render(); }));
  document.querySelectorAll('[data-action="close-delete"]').forEach((button) => button.addEventListener('click', () => { state.pendingDelete = null; state.modal = null; render(); }));
  document.querySelector('[data-action="confirm-delete-sub"]')?.addEventListener('click', () => deleteSubscription(state.pendingDelete?.id));
  document.querySelectorAll('[data-action="toggle"]').forEach((button) => button.addEventListener('click', toggleConnection));
  document.querySelector('[data-action="ping"]')?.addEventListener('click', () => pingOne(selectedNode()));
  document.querySelector('[data-action="proxy-ping"]')?.addEventListener('click', () => pingProxy());
  document.querySelector('[data-action="ping-all"]')?.addEventListener('click', () => pingAll());
  document.querySelector('[data-action="speed-test"]')?.addEventListener('click', () => runSpeedTest());
  document.querySelector('[data-action="cancel-ping"]')?.addEventListener('click', () => { if (state.pingJob) { state.pingJob.cancelled = true; render(); } });
  document.querySelector('[data-action="favorite"]')?.addEventListener('click', () => { const node = selectedNode(); if (node) { commitData({ servers: state.servers.map((item) => item.id === node.id ? { ...item, favorite: !item.favorite } : item) }); render(); } });
  document.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
    if (busy() || state.connection === 'connected' || state.cleanupNeeded) return;
    const servers = state.servers.filter((item) => item.id !== state.selectedId);
    commitData({ servers, selectedId: servers[0]?.id || null }); render();
  });
  document.querySelector('[data-action="clear-data"]')?.addEventListener('click', () => {
    if (busy() || state.connection === 'connected' || state.cleanupNeeded) return;
    if (!window.confirm(t('settings.clearConfirm'))) return;
    commitData({ servers: [], subscriptions: [], selectedId: null, routing: null });
    state.toast = { id: Date.now(), text: t('settings.cleared'), actionLabel: '', action: null };
    render();
  });
  document.querySelector('#route-mode')?.addEventListener('change', (event) => {
    if (busy() || state.connection === 'connected' || state.cleanupNeeded) return;
    if (routeModeIds.includes(event.target.value)) { commitData({ routeMode: event.target.value }); render(); }
  });
  document.querySelector('#speed-url')?.addEventListener('change', (event) => {
    commitData({ settings: { ...(state.settings || {}), speedUrl: String(event.target.value || '').trim() } }); render();
  });
  document.querySelector('#node-mode')?.addEventListener('change', (event) => {
    if (['single', 'auto'].includes(event.target.value)) { commitData({ settings: { ...(state.settings || {}), nodeMode: event.target.value } }); render(); }
  });
  document.querySelector('#dns-mode')?.addEventListener('change', (event) => {
    if (dnsModeIds.includes(event.target.value)) { commitData({ settings: { ...(state.settings || {}), dns: event.target.value } }); render(); }
  });
  document.querySelector('#xhttp-query')?.addEventListener('change', (event) => {
    commitData({ settings: { ...(state.settings || {}), xhttpQueryParams: Boolean(event.target.checked) } }); render();
  });
  document.querySelector('#failover-mode')?.addEventListener('change', (event) => {
    if (['country', 'any', 'never'].includes(event.target.value)) { commitData({ settings: { ...(state.settings || {}), failover: event.target.value } }); render(); }
  });
  document.querySelector('#settings-autostart')?.addEventListener('change', async (event) => {
    const autostart = Boolean(event.target.checked);
    commitData({ settings: { ...(state.settings || {}), autostart } });
    try { await desktopBridge.setAutostart(autostart); }
    catch (error) { state.notice = { type: 'error', text: errorText(error) }; }
    render();
  });
  document.querySelector('#settings-autoconnect')?.addEventListener('change', (event) => {
    commitData({ settings: { ...(state.settings || {}), autoconnect: Boolean(event.target.checked) } }); render();
  });
  document.querySelector('#settings-close-to-tray')?.addEventListener('change', async (event) => {
    const closeToTray = Boolean(event.target.checked);
    commitData({ settings: { ...(state.settings || {}), closeToTray } });
    try { await desktopBridge.setCloseToTray(closeToTray); } catch { /* preview */ }
    render();
  });
  document.querySelector('#check-client-update')?.addEventListener('click', () => { void checkClientUpdate(); });
  document.querySelector('#install-client-update')?.addEventListener('click', () => { void installClientUpdate(); });
  document.querySelector('[data-action="open-client-release"]')?.addEventListener('click', () => {
    const url = state.clientUpdate?.info?.releaseUrl;
    if (url) void desktopBridge.openExternal(url).catch(() => {});
  });
  document.querySelector('#auto-update-hours')?.addEventListener('change', (event) => {
    const hours = Math.max(0, Math.min(168, Number(event.target.value) || 0));
    commitData({ settings: { ...(state.settings || {}), autoUpdateHours: hours } });
    scheduleAutoUpdate();
    render();
  });
  document.querySelector('#language')?.addEventListener('change', (event) => {
    const language = event.target.value === 'en' ? 'en' : 'ru';
    setLanguage(language);
    state.language = language;
    commitData({ language, settings: { ...(state.settings || {}), language } });
    render();
  });
  for (const [id, key] of [['perf-sniffing', 'sniffing'], ['perf-ipv4', 'preferIPv4']]) {
    document.querySelector(`#${id}`)?.addEventListener('change', (event) => {
      commitData({ settings: { ...(state.settings || {}), perf: { ...(state.settings?.perf || {}), [key]: event.target.checked } } }); render();
    });
  }
  document.querySelectorAll('#debug-mode').forEach((input) => input.addEventListener('change', (event) => {
    const debug = Boolean(event.target.checked);
    commitData({ settings: { ...(state.settings || {}), debug } });
    state.notice = { text: debug ? t('notice.debugOn') : t('notice.debugOff') };
    render();
  }));
  document.querySelector('[data-action="refresh-logs"]')?.addEventListener('click', async () => { await loadLogs(); await loadProxyDiagnostics(); render(); });
  document.querySelector('[data-action="copy-diagnostics"]')?.addEventListener('click', async () => {
    try {
      const text = await desktopBridge.collectDiagnosticsFile();
      await navigator.clipboard.writeText(text || '');
      state.notice = { text: t('logs.copyDiagnosticsDone') };
    } catch { state.notice = { type: 'error', text: t('logs.copyDiagnosticsFailed') }; }
    render();
  });
  document.querySelector('[data-action="copy-logs"]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.logs.join('\n')); state.notice = { text: t('logs.copied') }; } catch { state.notice = { type: 'error', text: t('logs.copyFailed') }; }
    render();
  });
  document.querySelector('.modal')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !state.importing) { state.modal = null; state.pendingImport = null; state.pendingDelete = null; render(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...document.querySelectorAll('.modal button:not(:disabled), .modal textarea:not(:disabled), .modal select:not(:disabled)')];
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
  });
}

// ---------------------------------------------------------------------------
// Import and subscription reconciliation
// ---------------------------------------------------------------------------
function importSummary(result) {
  if (result.updated) {
    return t('notice.refreshed', { added: result.added, removed: result.removed, retained: result.retained });
  }
  return `${t('notice.imported', { count: result.count, duplicates: result.duplicates })}${result.unsupported ? t('notice.unsupported', { count: result.unsupported }) : ''}${result.retained ? t('notice.retained', { count: result.retained }) : ''}${result.skipped ? t('notice.skipped', { count: result.skipped }) : ''}${state.connection === 'connected' ? t('notice.activeKept') : ''}`;
}

// Reads and validates everything first. Nothing is written until applyImport,
// so a failed download or an unreadable payload cannot damage saved servers.
async function prepareImport(value) {
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error('noInput'), { code: 'noInput' });
  const routingOnly = text.startsWith('happ://');
  const isSubscription = routingOnly || (/^https?:\/\/\S+$/i.test(text) && !directScheme.test(text));
  let response;
  if (routingOnly) response = { body: text, userinfo: null };
  else {
    try { response = isSubscription ? await desktopBridge.fetchSubscription(text, dnsProtectionOn()) : { body: text, userinfo: null }; }
    catch (error) { throw Object.assign(new Error('subscriptionFailed'), { code: 'subscriptionFailed', params: { error: errorText(error) } }); }
  }
  const parsed = parseSubscriptionDetailed(response.body ?? response);
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  const happRouting = parsed.format === 'happ-routing' ? parsed.routing : null;
  const routing = happRouting || parsed.routing || null;
  // Rules this build cannot express are listed by number, not dropped silently.
  for (const rule of routing?.unsupported || []) {
    warnings.push({ key: `sub.routing.${rule.reason || 'shape'}`, params: { index: rule.index, fields: (rule.fields || []).join(', '), target: rule.target || '' } });
  }
  if (routing?.dns && routing.dnsApplied === false) warnings.push({ key: 'sub.routingDnsIgnored' });
  if (!parsed.nodes?.length) {
    if (routingOnly && routing) {
      return { nodes: [], errors: [], warnings: [], total: 0, isSubscription: true, routingOnly: true, routing, url: text, meta: null, manualRouting: true };
    }
    return { nodes: [], errors: errors.length ? errors : [{ key: 'err.noServers' }], warnings, total: 0, isSubscription, routing, url: text, meta: null };
  }
  return { nodes: parsed.nodes, errors, warnings, total: parsed.nodes.length + errors.length, isSubscription, routing, url: text, meta: isSubscription ? { ...parseUserinfo(response.userinfo), title: response.title || '', supportUrl: httpsLink(response.supportUrl), homeUrl: httpsLink(response.homeUrl) } : null, format: parsed.format, title: parsed.title || '' };
}

function nextNodeId(base, used) {
  let id = base || 'node'; let suffix = 2;
  while (used.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
  used.add(id);
  return id;
}

function applyManualImport(plan) {
  const used = new Set(state.servers.map((node) => node.id));
  const existingKeys = new Set(state.servers.filter((node) => !node.subscriptionId).map(mergeKey));
  let duplicates = 0;
  const added = [];
  for (const node of plan.nodes.map(applyCountry)) {
    const key = mergeKey(node);
    if (existingKeys.has(key)) { duplicates += 1; continue; }
    existingKeys.add(key);
    added.push({ ...node, id: nextNodeId(node.id, used), subscriptionId: null, source: 'manual' });
  }
  const servers = [...state.servers, ...added];
  const selectedId = servers.some((node) => node.id === state.selectedId) ? state.selectedId : servers[0]?.id || null;
  if (!commitData({ servers, selectedId })) throw Object.assign(new Error('saveFailed'), { code: 'saveFailed' });
  return { count: added.length, duplicates, unsupported: added.filter((node) => node.unsupported).length, retained: 0, skipped: plan.errors.length };
}

function applySubscriptionImport(plan) {
  const url = plan.url;
  const existing = state.subscriptions.find((item) => item.url === url);
  const id = existing?.id || subscriptionIdFor(url);
  const subscription = existing || { id, name: subscriptionNameFor(url, plan.meta, state.subscriptions.length), url, updatedAt: null, meta: null };
  const merged = mergeSubscriptionNodes({ nodes: state.servers, incoming: plan.nodes.map(applyCountry), subscriptionId: id, selectedId: state.selectedId });
  const subscriptions = existing
    ? state.subscriptions.map((item) => item.id === id ? { ...item, updatedAt: new Date().toISOString(), meta: plan.meta || item.meta, name: plan.title || item.name } : item)
    : [...state.subscriptions, { ...subscription, updatedAt: new Date().toISOString(), meta: plan.meta }];
  const routing = plan.routing
    ? { profile: plan.routing, unsupported: plan.routing.unsupported || [], dns: Boolean(plan.routing.dns), source: plan.format === 'happ-routing' ? 'happ' : 'subscription', updatedAt: new Date().toISOString() }
    : state.routing;
  const selectedId = merged.nodes.some((node) => node.id === state.selectedId) ? state.selectedId : merged.nodes[0]?.id || null;
  if (!commitData({ servers: merged.nodes, subscriptions, selectedId, routing })) throw Object.assign(new Error('saveFailed'), { code: 'saveFailed' });
  enrichCountries(merged.nodes.filter((node) => !node.countryCode).map((node) => node.id));
  return { count: merged.added, added: merged.added, removed: merged.removed, retained: merged.retained, kept: merged.kept, duplicates: merged.duplicates, skipped: plan.errors.length, unsupported: merged.nodes.filter((node) => node.unsupported).length, updated: Boolean(existing) };
}

function applyImport(plan) {
  if (plan.routingOnly && plan.manualRouting) {
    const routing = { profile: plan.routing, unsupported: plan.routing.unsupported || [], dns: Boolean(plan.routing.dns), source: 'happ', updatedAt: new Date().toISOString() };
    if (!commitData({ routing })) throw Object.assign(new Error('saveFailed'), { code: 'saveFailed' });
    return { count: 0, duplicates: 0, unsupported: 0, retained: 0, skipped: 0 };
  }
  return plan.isSubscription ? applySubscriptionImport(plan) : applyManualImport(plan);
}

async function runImport(value, refresh) {
  if (state.importing) return;
  state.importing = true; state.importError = ''; state.notice = null; render();
  try {
    const plan = await prepareImport(value);
    state.importing = false;
    if (plan.errors.length || plan.warnings.length) {
      // Never apply a partly readable subscription silently: show what was read
      // and what failed, then let the user decide.
      state.pendingImport = plan;
      state.modal = 'result';
      render();
      return;
    }
    const result = applyImport(plan);
    state.modal = null;
    state.notice = { text: importSummary(result) };
  } catch (error) {
    if (!refresh || state.modal) { state.modal = 'add'; state.importError = errorText(error); }
    else state.notice = { type: 'error', text: t('notice.refreshFailed', { error: errorText(error) }) };
  } finally { state.importing = false; render(); }
}
function applyPendingImport() {
  const plan = state.pendingImport;
  if (!plan) return;
  try {
    const result = applyImport(plan);
    state.pendingImport = null;
    state.modal = null;
    state.notice = { text: importSummary(result) };
  } catch (error) {
    state.pendingImport = null;
    state.modal = 'result';
    state.importError = errorText(error);
  }
  render();
}

async function refreshSubscription(id) {
  const subscription = state.subscriptions.find((item) => item.id === id);
  if (!subscription || state.subscriptionBusy) return;
  state.subscriptionBusy = id; state.notice = null; render();
  try {
    const plan = await prepareImport(subscription.url);
    if (plan.errors.length || plan.warnings.length) {
      state.pendingImport = plan;
      state.modal = 'result';
      return;
    }
    const result = applyImport(plan);
    state.notice = { text: importSummary(result) };
  } catch (error) {
    // A network failure never touches the saved list.
    state.notice = { type: 'error', text: t('notice.refreshFailed', { error: errorText(error) }) };
  } finally { state.subscriptionBusy = null; render(); }
}

async function refreshAll() {
  if (state.refreshAllBusy || !state.subscriptions.length) return;
  state.refreshAllBusy = true; state.notice = null; render();
  let added = 0, removed = 0, failed = 0;
  for (const subscription of [...state.subscriptions]) {
    try {
      const plan = await prepareImport(subscription.url);
      if (plan.errors.length) { failed += 1; continue; }
      const result = applyImport(plan);
      added += result.added || 0; removed += result.removed || 0;
    } catch { failed += 1; }
  }
  state.refreshAllBusy = false;
  state.notice = failed ? { type: 'error', text: t('notice.refreshPartial', { added, removed, failed }) } : { text: t('notice.refreshed', { added, removed, retained: 0 }) };
  render();
}

async function deleteSubscription(id) {
  const subscription = state.subscriptions.find((item) => item.id === id);
  if (!subscription) return;
  const nodes = state.servers.filter((node) => node.subscriptionId === id);
  const activeInside = state.connection === 'connected' && nodes.some((node) => sameConfig(node, state.activeNode));
  if (activeInside && !(await stopCurrent('state.restoringBeforeDelete'))) return;
  const backup = { subscription, nodes, selectedId: state.selectedId };
  const next = removeSubscription({ nodes: state.servers, subscriptions: state.subscriptions, selectedId: state.selectedId }, id);
  if (!commitData({ servers: next.nodes, subscriptions: next.subscriptions, selectedId: next.selectedId })) return;
  state.pendingDelete = null; state.modal = null;
  showToast(t('toast.subDeleted', { name: subscription.name, count: nodes.length }), { label: t('toast.undo'), run: () => { const restored = restoreSubscription({ nodes: state.servers, subscriptions: state.subscriptions, selectedId: state.selectedId }, backup); commitData({ servers: restored.nodes, subscriptions: restored.subscriptions, selectedId: restored.selectedId }); state.notice = { text: t('toast.restored', { name: subscription.name }) }; render(); } });
  render();
}

// ---------------------------------------------------------------------------
// Country enrichment, latency
// ---------------------------------------------------------------------------
async function enrichCountries(ids) {
  if (!capabilities.native || !ids.length) return;
  const nodes = state.servers.filter((node) => ids.includes(node.id) && !node.countryCode);
  if (!nodes.length) return;
  try {
    const result = await desktopBridge.lookupCountries(nodes.map((node) => nodeEndpoint(node).host));
    if (!Array.isArray(result)) return;
    const byHost = new Map(result.map((item) => [String(item.host).toLowerCase(), item.code]));
    let changed = false;
    const servers = state.servers.map((node) => {
      if (!ids.includes(node.id) || node.countryCode) return node;
      const code = byHost.get(String(nodeEndpoint(node).host).toLowerCase());
      if (!code || !countryByCode(code)) return node;
      changed = true;
      return { ...node, countryCode: code, countrySource: 'geoip' };
    });
    if (changed) commitData({ servers });
  } catch { /* the flag stays a globe; nothing else depends on it */ }
}

async function pingOne(node) {
  if (!node || !capabilities.native || node.availability === 'testing') return;
  if (!tcpTestApplicable(node)) { state.notice = { text: t('notice.tcpNotApplicable') }; render(); return; }
  const { host, port } = nodeEndpoint(node);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) { state.notice = { type: 'error', text: t('notice.tcpNoAddress') }; render(); return; }
  node.ping = null; node.availability = 'testing'; render();
  try {
    const value = await desktopBridge.pingNode({ outbound: { server: host, server_port: port } });
    if (!state.servers.includes(node)) return;
    node.ping = Number.isFinite(value) && value >= 0 ? value : null;
    node.availability = node.ping === null ? 'offline' : 'online';
  } catch (error) {
    if (!state.servers.includes(node)) return;
    node.availability = 'unknown'; state.notice = { type: 'error', text: t('notice.tcpFailed', { error: errorText(error) }) };
  } finally { render(); }
}

function probeConfig(node) {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const config = buildXrayConfig([copyNode(node)], node.id, 'all', null);
  config.inbounds = [{ tag: 'probe-http', listen: '127.0.0.1', port, protocol: 'http' }];
  delete config.routing;
  delete config.dns;
  return config;
}

async function measureNode(node) {
  if (tcpTestApplicable(node)) {
    const { host, port } = nodeEndpoint(node);
    if (!host || !Number.isInteger(port)) return null;
    const started = Date.now();
    const value = await Promise.race([
      desktopBridge.pingNode({ outbound: { server: host, server_port: port } }),
      new Promise((resolve) => setTimeout(() => resolve(null), PING_TIMEOUT))
    ]);
    return Number.isFinite(value) && value >= 0 ? Math.min(value, Date.now() - started) : null;
  }
  // UDP protocols need a real tunnel: one request through a temporary core.
  try {
    if (node.needsPin) await ensurePin(node);
    return await desktopBridge.probeNodeLatency(probeConfig(node));
  } catch { return null; }
}

// The measurement runs inside the WebView, so it uses the system proxy the app
// has just configured and therefore the same path as any other application.
async function runSpeedTest() {
  const url = String(state.settings?.speedUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) { setMessage('speed.needUrl'); state.page = 'settings'; render(); return; }
  if (state.connection !== 'connected' || state.speedRunning) return;
  state.speedRunning = true; state.transferActive = true; setMessage('speed.running'); render();
  try {
    const times = [];
    for (let index = 0; index < 3; index += 1) {
      const started = performance.now();
      await fetch(url, { method: 'HEAD', cache: 'no-store' });
      times.push(performance.now() - started);
    }
    const latency = Math.round(times.sort((a, b) => a - b)[1]);
    const downloadStart = performance.now();
    const response = await fetch(url, { cache: 'no-store' });
    const reader = response.body.getReader();
    let bytes = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; }
    const down = bytes * 8 / ((performance.now() - downloadStart) / 1000) / 1e6;
    const size = 4 * 1024 * 1024;
    const uploadStart = performance.now();
    try { await fetch(url, { method: 'POST', body: new Blob([new Uint8Array(size)]), cache: 'no-store' }); } catch { /* сервер может не принимать POST; время отправки всё равно измерено */ }
    const up = size * 8 / ((performance.now() - uploadStart) / 1000) / 1e6;
    state.speed = { at: Date.now(), url, latency, down: Math.round(down * 10) / 10, up: Math.round(up * 10) / 10 };
    commitData({ speed: state.speed });
    setMessage('speed.done');
  } catch (error) {
    setMessage('speed.failed', { error: errorText(error) });
  } finally {
    state.speedRunning = false; state.transferActive = false; render();
  }
}

async function pingAll() {
  if (state.pingJob || !capabilities.native || state.transferActive) return;
  const nodes = [...state.servers];
  if (!nodes.length) return;
  state.pingJob = { total: nodes.length, done: 0, cancelled: false };
  state.sort = 'ping';
  render();
  const tcp = nodes.filter(tcpTestApplicable);
  const udp = nodes.filter((node) => !tcpTestApplicable(node));
  const runPool = async (list, limit) => {
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length) {
        if (state.pingJob?.cancelled) return;
        const node = list[cursor++];
        node.availability = 'testing';
        scheduleRender();
        const value = await measureNode(node);
        if (!state.servers.includes(node)) { state.pingJob.done += 1; continue; }
        node.ping = value;
        node.availability = value === null ? 'offline' : 'online';
        state.pingJob.done += 1;
        scheduleRender();
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  };
  await Promise.all([runPool(tcp, TCP_CONCURRENCY), runPool(udp, UDP_CONCURRENCY)]);
  const cancelled = state.pingJob.cancelled;
  state.pingJob = null;
  state.notice = { text: cancelled ? t('notice.pingCancelled') : t('notice.pingDone') };
  commitData({ servers: state.servers });
  render();
}

async function pingProxy() {
  if (!capabilities.native || state.connection !== 'connected' || state.proxyTesting) return;
  const session = sessionSequence;
  state.proxyTesting = true; state.proxyPing = null; render();
  try {
    const value = await desktopBridge.proxyLatency();
    if (session !== sessionSequence || state.connection !== 'connected') return;
    state.proxyPing = Number.isFinite(value) && value >= 0 ? value : null;
    state.proxyCheckFailed = state.proxyPing === null;
    if (Number.isFinite(state.proxyPing)) state.latencyHistory = [...state.latencyHistory.slice(-39), state.proxyPing];
    if (state.proxyCheckFailed) state.notice = { type: 'error', code: 'proxy-check', text: t('notice.proxyCheckFailed') };
    else if (state.notice?.code === 'proxy-check') state.notice = null;
  } catch {
    if (session === sessionSequence && state.connection === 'connected') { state.proxyCheckFailed = true; state.notice = { type: 'error', code: 'proxy-check', text: t('notice.proxyCheckError') }; }
  } finally { if (session === sessionSequence) state.proxyTesting = false; render(); }
}

async function loadLogs() {
  try { const text = await desktopBridge.readLogs(); state.logs = text ? text.trim().split('\n').slice(-300) : []; }
  catch (error) { state.logs = [t('logs.failed', { error: errorText(error) })]; }
}
async function loadProxyDiagnostics() {
  try { state.proxyDiagnostics = await desktopBridge.proxyDiagnostics() || ''; }
  catch (error) { state.proxyDiagnostics = t('logs.diagnosticsFailed', { error: errorText(error) }); }
}
async function logXhttpSummary(config) {
  const outbound = config?.outbounds?.find((item) => item?.streamSettings?.xhttpSettings);
  if (!outbound) return;
  try {
    const diagnostics = await desktopBridge.proxyDiagnostics();
    const match = String(diagnostics || '').match(/^core=(.+)$/m);
    if (match) state.coreVersion = match[1].trim();
  } catch { /* версия необязательна */ }
  const xhttp = outbound.streamSettings.xhttpSettings;
  appendLocalLog(t('logs.xhttpLine', { path: xhttp.path || '/', mode: xhttp.mode || 'auto', host: xhttp.host || '—', keys: Object.keys(xhttp.extra || {}).join(',') || '—', core: state.coreVersion || '—' }));
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function ensurePin(node) {
  if (!node?.needsPin) return node;
  const tls = node.outbound?.tls;
  if (tls?.pinned_peer_cert_sha256) { node.needsPin = false; return node; }
  const { host, port } = nodeEndpoint(node);
  if (!host || !Number.isInteger(port)) throw Object.assign(new Error('sub.badAddress'), { code: 'sub.badAddress' });
  const pin = await desktopBridge.pinCertificate({ host, port, serverName: tls?.server_name || host });
  if (!/^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(pin)) throw Object.assign(new Error('config.badPin'), { code: 'config.badPin' });
  tls.pinned_peer_cert_sha256 = pin;
  delete tls.trust_on_first_use;
  delete tls.insecure;
  node.needsPin = false;
  commitData({ servers: state.servers });
  state.notice = { text: t('notice.pinned', { pin: pin.slice(0, 17) + '…' }) };
  return node;
}
function resetSession() { state.activeNode = null; state.activeRouteMode = null; state.connectedAt = null; state.externalIp = null; state.proxyPing = null; state.proxyTesting = false; state.proxyCheckFailed = false; state.latencyHistory = []; if (state.notice?.code === 'proxy-check') state.notice = null; sessionSequence += 1; }
async function stopProxy() {
  const result = await desktopBridge.disconnect();
  if (result?.ok === false) throw Object.assign(new Error(result.error || 'proxyStopFailed'), { code: 'proxyStopFailed' });
}
async function stopCurrent(messageKey = 'state.restoringProxy') {
  state.connection = 'disconnecting'; setMessage(messageKey); render();
  try {
    await stopProxy(); resetSession(); state.cleanupNeeded = false; syncTray(); return true;
  } catch (error) {
    resetSession(); state.cleanupNeeded = true; state.connection = 'error';
    setMessage('state.restoreFailed', { error: errorText(error) }); render(); return false;
  }
}
async function collectDiagnostics() {
  try {
    const text = await desktopBridge.readLogs();
    const lines = String(text || '').trim().split('\n').filter(Boolean).slice(-12);
    return lines.join('\n');
  } catch { return ''; }
}
async function checkClientUpdate() {
  if (!NATIVE) {
    state.clientUpdate = { status: 'error', info: null, error: t('settings.clientUpdatePreview'), progress: 0 };
    render();
    return;
  }
  if (state.clientUpdate?.status === 'checking' || state.clientUpdate?.status === 'downloading' || state.clientUpdate?.status === 'installing') return;
  state.clientUpdate = { ...(state.clientUpdate || {}), status: 'checking', error: '', progress: 0 };
  render();
  try {
    const info = await desktopBridge.checkClientUpdate();
    state.clientUpdate = { status: info?.available ? 'available' : 'current', info: info || null, error: '', progress: 0 };
  } catch (error) {
    state.clientUpdate = { ...(state.clientUpdate || {}), status: 'error', error: errorText(error) };
  }
  render();
}
async function installClientUpdate() {
  const info = state.clientUpdate?.info;
  if (!info?.available || !info.canInstall) return;
  if (busy() || state.cleanupNeeded) {
    state.notice = { type: 'error', text: t('settings.clientUpdateBlocked') };
    render();
    return;
  }
  if (state.connection === 'connected') {
    state.clientUpdate = { ...state.clientUpdate, status: 'disconnecting', error: '', progress: 0 };
    setMessage('settings.clientUpdateDisconnecting');
    render();
    if (!(await stopCurrent('settings.clientUpdateDisconnecting'))) {
      state.clientUpdate = {
        ...state.clientUpdate,
        status: 'error',
        error: t('settings.clientUpdateBlocked')
      };
      render();
      return;
    }
  }
  state.clientUpdate = { ...state.clientUpdate, status: 'downloading', error: '', progress: 0 };
  render();
  try {
    await desktopBridge.installClientUpdate(info.latestVersion);
    state.clientUpdate = { ...state.clientUpdate, status: 'installing' };
    render();
    window.setTimeout(() => { void desktopBridge.quitApp().catch(() => {}); }, 1000);
  } catch (error) {
    state.clientUpdate = { ...state.clientUpdate, status: 'error', error: errorText(error) };
    render();
  }
}
function handleClientUpdateProgress(payload) {
  if (!payload) return;
  const status = payload.stage === 'ready' ? 'installing' : payload.stage === 'downloading' ? 'downloading' : (state.clientUpdate?.status || 'idle');
  const total = Number(payload.total || 0);
  const downloaded = Number(payload.downloaded || 0);
  state.clientUpdate = {
    ...(state.clientUpdate || {}),
    status,
    progress: total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : 0
  };
  if (state.activeNav === 'settings') render();
}
function autoPool(selected) {
  if (state.settings?.nodeMode !== 'auto' || !selected) return [];
  const usable = state.servers.filter((item) => item.id !== selected.id && !unsupportedReason(item) && !item.unsupported);
  const favorites = usable.filter((item) => item.favorite);
  const sameCountry = selected.country ? usable.filter((item) => item.country === selected.country && !item.favorite) : [];
  return [selected, ...(favorites.length ? favorites : sameCountry).slice(0, 5)];
}


let autoUpdateTimer = null;
let lastTrayActive = null;
function syncTray() {
  if (!NATIVE) return;
  const active = state.connection === 'connected';
  if (active === lastTrayActive) return;
  lastTrayActive = active;
  try { const pending = desktopBridge.setTrayActive?.(active); pending?.catch?.(() => {}); } catch { /* preview */ }
}
async function initAutomation() {
  if (!NATIVE) return;
  DesktopSettings.apply();
  scheduleAutoUpdate();
  if (state.settings?.autoconnect && selectedNode() && state.bridgeReady && state.connection === 'idle') {
    setTimeout(() => { if (state.connection === 'idle' && selectedNode()) toggleConnection(); }, 1500);
  }
}
const DesktopSettings = {
  apply() {
    try { const pending = desktopBridge.setCloseToTray?.(Boolean(state.settings?.closeToTray)); pending?.catch?.(() => {}); } catch { /* preview */ }
  }
};
function scheduleAutoUpdate() {
  if (autoUpdateTimer) { clearInterval(autoUpdateTimer); autoUpdateTimer = null; }
  const hours = Number(state.settings?.autoUpdateHours ?? 12);
  if (!NATIVE || !hours) return;
  autoUpdateTimer = setInterval(() => { void maybeAutoUpdate(); }, 30 * 60 * 1000);
  setTimeout(() => { void maybeAutoUpdate(); }, 5000);
}
async function maybeAutoUpdate() {
  const hours = Number(state.settings?.autoUpdateHours ?? 12);
  if (!hours || state.refreshAllBusy || busy() || !state.subscriptions.length) return;
  const last = Number(state.settings?.lastAutoUpdateAt || 0);
  if (Date.now() - last < hours * 3600 * 1000) return;
  appendLocalLog(t('logs.autoUpdateStart'));
  try {
    await refreshAll();
    appendLocalLog(t('logs.autoUpdateDone'));
  } catch (error) {
    // A network failure keeps the imported list: refreshAll only replaces data on success.
    appendLocalLog(t('logs.autoUpdateFailed', { error: errorText(error) }));
  }
  commitData({ settings: { ...(state.settings || {}), lastAutoUpdateAt: Date.now() } });
}
async function startSelected(node) {
  if (!node || unsupportedReason(node)) return;
  if (!capabilities.native || !state.bridgeReady || state.cleanupNeeded) {
    state.connection = 'error'; setMessage('state.connectUnavailable'); render(); return;
  }
  const route = state.routeMode;
  state.proxyWarning = '';
  const operation = ++operationSequence;
  const exitsAtStart = exitSequence;
  state.connection = 'connecting'; state.diagnostics = ''; setMessage('state.startingXray', { name: node.name || t('servers.serverFallback') }); state.cleanupNeeded = false; render();
  try {
    // Pin the stored node, not a copy: the fingerprint must survive the session.
    if (node.needsPin) { setMessage('state.pinning'); render(); await ensurePin(node); }
    const snapshotNode = await protectNodeAddress(copyNode(node));
    const poolRaw = autoPool(snapshotNode);
    const pool = poolRaw.length > 1 ? await Promise.all(poolRaw.map(protectNodeAddress)) : poolRaw;
    const config = buildXrayConfig(pool.length > 1 ? pool : [snapshotNode], snapshotNode.id, route, state.routing?.profile || null, { dns: dnsProtectionOn() ? 'builtin' : 'system', perf: { ...(state.settings?.perf || {}), tcpFastOpen: fastReconnectOn() }, auto: pool.length > 1 ? pool : undefined, xhttpQuery: state.settings?.xhttpQueryParams !== false });
    const result = await desktopBridge.connect({ config, debug: Boolean(state.settings?.debug) });
    if (result?.ok === false) throw Object.assign(new Error('coreLaunch'), { code: 'coreLaunch', params: { error: coreErrorText(result.error) } });
    if (result?.warning) {
      state.proxyWarning = result.warning;
      state.notice = { type: 'error', text: result.warning };
      appendLocalLog(t('logs.proxyWarningLine', { text: result.warning }));
    }
    logXhttpSummary(config);
    if (operation !== operationSequence || exitSequence !== exitsAtStart) throw Object.assign(new Error('xrayExitedDuringConnect'), { code: 'xrayExitedDuringConnect' });
    setMessage('state.checkingInternet'); render();
    const ip = await desktopBridge.probeInternet();
    if (operation !== operationSequence || exitSequence !== exitsAtStart) throw Object.assign(new Error('xrayExitedDuringProbe'), { code: 'xrayExitedDuringProbe' });
    if (!ip) throw Object.assign(new Error('probeEmpty'), { code: 'probeEmpty' });
    state.activeNode = snapshotNode; state.activeRouteMode = route; state.externalIp = ip; state.connectedAt = Date.now(); state.connection = 'connected'; setMessage('state.established'); sessionSequence += 1; render(); syncTray();
    void pingProxy();
    latencyTimer = setInterval(() => { if (state.connection === 'connected' && !state.proxyTesting) void pingProxy(); }, 15000);
  } catch (error) {
    // Even a failed launch may have changed system proxy settings; cleanup is mandatory.
    state.connection = 'disconnecting'; setMessage('state.restoringProxy'); render();
    let cleanupError = '';
    try { await stopProxy(); } catch (cleanup) { cleanupError = errorText(cleanup); }
    resetSession(); state.cleanupNeeded = Boolean(cleanupError); state.connection = 'error';
    const base = coreErrorText(error);
    state.diagnostics = await collectDiagnostics();
    state.message = { key: 'raw', params: { text: cleanupError ? `${base}${t('state.cleanupFailedSuffix', { error: cleanupError })}` : base } };
    if (node?.outbound?.type === 'hysteria2' && /timeout|timed out|handshake/i.test(`${base} ${state.diagnostics}`)) state.notice = { type: 'error', text: t('notice.udpHint') };
    render();
  }
}
async function toggleConnection() {
  if (busy()) return;
  if (state.cleanupNeeded || state.connection === 'connected') {
    if (await stopCurrent()) {
      if (latencyTimer) { clearInterval(latencyTimer); latencyTimer = null; }
      if (capabilities.native && !state.bridgeReady) { state.connection = 'error'; setMessage('state.restoredButNoWatch', { details: state.watchError ? `: ${state.watchError}` : '' }); }
      else { state.connection = 'idle'; setMessage('state.stopped'); }
      render();
    }
    return;
  }
  const node = selectedNode();
  if (!node) return;
  const reason = unsupportedReason(node);
  if (reason) { state.notice = { type: 'error', text: reason }; render(); return; }
  if (!capabilities.native) { state.connection = 'error'; setMessage('state.previewUnavailable'); render(); return; }
  if (!state.bridgeReady) { state.connection = 'error'; setMessage('state.watchUnavailable'); render(); return; }
  await startSelected(node);
}
async function selectServer(id) {
  if (busy() || state.cleanupNeeded) return;
  const node = state.servers.find((item) => item.id === id);
  if (!node) return;
  if (state.connection === 'connected' && !sameConfig(state.activeNode, node)) {
    if (unsupportedReason(node)) { if (commitData({ selectedId: id })) state.notice = { type: 'error', text: t('notice.selectedUnsupported', { error: unsupportedReason(node) }) }; render(); return; }
    const snapshotNode = copyNode(node);
    if (!(await stopCurrent('state.restoringBeforeSwitch'))) return;
    // A subscription refresh can finish while stopping. Connect the originally chosen snapshot,
    // and show it as active even if the refreshed list no longer contains it.
    const selectedId = state.servers.some((item) => item.id === id) ? id : state.selectedId;
    if (!commitData({ selectedId })) { state.connection = 'idle'; setMessage('state.stopped'); render(); return; }
    await startSelected(snapshotNode); return;
  }
  commitData({ selectedId: id }); render();
}
function appendLocalLog(message) {
  state.logs = [...state.logs, `${new Date().toLocaleTimeString()} ${message}`].slice(-500);
  if (state.page === 'logs') render();
}
// Pure policy: which node may replace the failed one. Kept separate so the
// three modes are testable without a live tunnel.
function failoverCandidate(servers, active, mode, isUsable) {
  if (mode === 'never') return null;
  const candidates = servers.filter((node) => node.id !== active?.id && isUsable(node));
  if (mode === 'any') return candidates[0] || null;
  return candidates.find((node) => node.country && node.country === active?.country) || null;
}
let lastHealthSwitch = 0;
const IP_ONLY = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i;
// DNS protection resolves the node host over DoH before the core starts and
// substitutes the address while keeping the original name for TLS/Reality.
async function protectNodeAddress(node) {
  const host = node?.outbound?.server;
  if (!dnsProtectionOn() || !host || IP_ONLY.test(host)) return node;
  try {
    const result = await desktopBridge.resolveHost(host);
    if (!result?.ip || result.source === 'system' || result.source === 'failed') {
      state.notice = { type: 'error', text: t('notice.dnsFallback') };
      appendLocalLog(t('notice.dnsFallback'));
      return node;
    }
    const copy = copyNode(node);
    copy.outbound.server = result.ip;
    if (copy.outbound.tls?.enabled) copy.outbound.tls.server_name = copy.outbound.tls.server_name || host;
    const transport = copy.outbound.transport;
    if (transport && !transport.host && !transport.headers?.Host && ['ws', 'httpupgrade', 'xhttp', 'splithttp', 'h2', 'grpc'].includes(transport.type)) transport.host = host;
    return copy;
  } catch { return node; }
}
function setDnsProtection(on) {
  commitData({ settings: { ...(state.settings || {}), dnsProtection: Boolean(on), dns: on ? 'builtin' : 'system' } });
  render();
}
function setFastReconnect(on) {
  commitData({ settings: { ...(state.settings || {}), fastReconnect: Boolean(on), perf: { ...(state.settings?.perf || {}), tcpFastOpen: Boolean(on) } } });
  state.tfoFailures = 0;
  state.notice = state.connection === 'connected' ? { type: 'info', text: t('notice.fastReconnectPending'), action: 'reconnect' } : null;
  render();
}
async function reconnectNow() {
  if (busy()) return;
  const node = state.activeNode || selectedNode();
  if (!node) return;
  if (!(await stopCurrent())) return;
  state.connection = 'idle';
  await startSelected(node);
}
async function checkDns() {
  state.dnsCheck = { running: true };
  render();
  try {
    const results = await desktopBridge.dnsCheck(['example.com', 'cloudflare.com', 'yandex.ru']);
    const hit = (results || []).find((item) => item?.source === 'doh' || item?.source === 'cache');
    state.dnsCheck = hit ? { ok: true, server: hit.server, ip: hit.server_ip || '', via: hit.via || 'bootstrap-ip' } : { ok: false };
  } catch { state.dnsCheck = { ok: false }; }
  render();
}
async function handleHealth(kind, payload) {
  if (kind === 'restarted') {
    try { state.logs = (await desktopBridge.readLogs()).split('\n').filter(Boolean); } catch { /* лог необязателен */ }
    if (state.page === 'logs') render();
    return;
  }
  if (state.connection !== 'connected' || Date.now() - lastHealthSwitch < 60000) return;
  // Two failures in a row after enabling TCP Fast Open mean the network drops it.
  if (fastReconnectOn()) {
    state.tfoFailures = (state.tfoFailures || 0) + 1;
    if (state.tfoFailures >= 2) {
      state.tfoFailures = 0;
      commitData({ settings: { ...(state.settings || {}), fastReconnect: false, perf: { ...(state.settings?.perf || {}), tcpFastOpen: false } } });
      state.notice = { type: 'error', text: t('notice.fastReconnectDisabled') };
      appendLocalLog(t('notice.fastReconnectDisabled'));
      render();
      return;
    }
  }
  // The core could not restart the tunnel. Switching changes the exit country and
  // the external IP, so it is a setting: same country by default.
  const failover = state.settings?.failover === 'any' || state.settings?.failover === 'never' ? state.settings.failover : 'country';
  if (failover === 'never') { state.proxyCheckFailed = true; setMessage('notice.healthNoSwitch', { error: errorText(payload) }); render(); return; }
  const next = failoverCandidate(state.servers, state.activeNode, failover, (node) => !unsupportedReason(node));
  if (!next) { state.proxyCheckFailed = true; setMessage('notice.healthFailed', { error: errorText(payload) }); render(); return; }
  lastHealthSwitch = Date.now();
  const label = next.name || t('servers.serverFallback');
  const country = next.country ? ` (${next.country})` : '';
  appendLocalLog(t('notice.healthSwitch', { name: label }));
  setMessage('notice.failoverSwitched', { name: label, country });
  await startSelected(next);
}
function handleProxyExit(message) {
  if (state.connection === 'disconnecting' || state.connection === 'idle' || state.connection === 'error') return;
  exitSequence += 1;
  if (state.connection === 'connecting') { setMessage('state.xrayExitedConnecting'); render(); return; }
  // Block new operations until a cleanup attempt has completed.
  void (async () => {
    const detail = typeof message === 'string' && message ? message : t('state.xrayExited');
    state.diagnostics = await collectDiagnostics();
    if (await stopCurrent('state.restoringAfterXray')) { state.connection = 'error'; state.message = { key: 'raw', params: { text: detail } }; render(); }
    else { state.message = { key: 'raw', params: { text: `${detail}. ${messageText(state.message)}` } }; render(); }
  })();
}

render();
bootstrapSecureStorage();
void (async () => {
  let watchError = '';
  try { await desktopBridge.watchProxyExit(handleProxyExit); } catch (error) { watchError = errorText(error); }
  try { await desktopBridge.watchHealth(handleHealth); } catch { /* события доступны только в настольной сборке */ }
  try { await desktopBridge.watchTray({ onToggle: () => { void toggleConnection(); }, onQuit: () => { void desktopBridge.quitApp(); } }); } catch { /* трей только в настольной сборке */ }
  try { await desktopBridge.watchClientUpdate(handleClientUpdateProgress); } catch { /* обновления только в настольной сборке */ }
  state.watchError = watchError;
  if (!capabilities.native) { state.bridgeReady = !watchError; if (watchError) { state.connection = 'error'; setMessage('state.watchFailed', { error: watchError }); } setMessage('state.previewNoConnect'); render(); return; }
  // The bridge has no status query. On a frontend reload, stop any surviving session before
  // declaring it idle; a successful stop is the backend's restoration guarantee.
  let cleanupError = '';
  try { await stopProxy(); } catch (error) { cleanupError = errorText(error); }
  resetSession(); state.bridgeReady = !watchError; state.cleanupNeeded = Boolean(cleanupError);
  if (cleanupError) { state.connection = 'error'; setMessage('state.restoreFailed', { error: cleanupError }); }
  else if (watchError) { state.connection = 'error'; setMessage('state.watchFailed', { error: watchError }); }
  else { state.connection = 'idle'; setMessage('state.chooseServer'); }
  enrichCountries(state.servers.filter((node) => !node.countryCode).map((node) => node.id));
  render();
})();
window.setInterval(() => { if (state.connection === 'connected') document.querySelectorAll('[data-duration]').forEach((item) => { item.textContent = formatDuration(); }); }, 1000);

// Test hooks: the regression suite evaluates this file without a browser and
// needs the same entry points the UI uses.
