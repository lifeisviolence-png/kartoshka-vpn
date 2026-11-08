import './styles.css';
import { desktopBridge } from './desktop-bridge.js';
import { parseSubscriptionDetailed, parseUserinfo, parseHappRouting } from './subscription.js';
import { buildXrayConfig } from './xray-config.js';
import { t, setLanguage, getLanguage, locale, errorText as localizedError, countryCodeFor } from './i18n.js';

const VERSION = '0.8.0';
const capabilities = desktopBridge.getCapabilities();
const routeModeIds = ['all', 'auto', 'split'];
const directScheme = /^(vless|vmess|trojan|ss|shadowsocks|hysteria2|hy2):\/\//i;
const storageKey = 'kartoshka.state.v1';
const savedData = loadStoredData();
const storedRoute = savedData.routeMode;
const savedServers = savedData.nodes;
const state = {
  servers: Array.isArray(savedServers) ? savedServers.map((node) => ({ ...node, ping: null, proxyPing: null, availability: 'unknown' })) : [],
  selectedId: savedData.selectedId || null,
  subscriptionUrl: savedData.subscriptionUrl || '',
  subscriptionMeta: savedData.subscriptionMeta || null,
  settings: savedData.settings ?? null,
  language: savedData.language || 'ru',
  previousRouteMode: savedData.previousRouteMode ?? (storedRoute && !routeModeIds.includes(storedRoute) ? storedRoute : null),
  routeMode: routeModeIds.includes(storedRoute) ? storedRoute : 'auto',
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
  notice: null,
  logs: [],
  search: '',
  message: { key: capabilities.native ? 'state.checkingProxy' : 'state.previewNoConnect' }
};
setLanguage(state.language);
if (!state.selectedId || !state.servers.some((node) => node.id === state.selectedId)) state.selectedId = state.servers[0]?.id || null;
if (savedData.migrate) {
  // Legacy keys remain untouched until and after the new snapshot is committed.
  try { localStorage.setItem(storageKey, JSON.stringify(dataSnapshot(state))); }
  catch { state.notice = { type: 'error', text: t('notice.saveFailedLegacy') }; }
}

const app = document.querySelector('#app');
let exitSequence = 0;
let operationSequence = 0;
let sessionSequence = 0;
let modalPreviouslyOpen = false;

function readStored(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function loadJson(key, fallback) { try { return JSON.parse(readStored(key, JSON.stringify(fallback))); } catch { return fallback; } }
function loadStoredData() {
  const current = loadJson(storageKey, null);
  if (current?.version === 1 && Array.isArray(current.nodes)) {
    const language = ['ru', 'en'].includes(current.settings?.language) ? current.settings.language : undefined;
    return { ...current, routeMode: current.routeMode, language: current.language || language };
  }
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
  return { nodes, selectedId: readStored('kartoshka.selectedId', ''), subscriptionUrl, subscriptionMeta, settings, language: settings?.language, routeMode: readStored('kartoshka.routeMode', ''), migrate: true };
}
function dataSnapshot(data) {
  // Latencies describe one moment; all durable settings are one atomic value.
  return { version: 1, nodes: data.servers.map(({ ping, proxyPing, availability, ...node }) => node), selectedId: data.selectedId || null, subscriptionUrl: data.subscriptionUrl || '', subscriptionMeta: data.subscriptionMeta || null, routeMode: data.routeMode, settings: data.settings, previousRouteMode: data.previousRouteMode, language: data.language };
}
function commitData(patch) {
  const next = { ...state, ...patch };
  try { localStorage.setItem(storageKey, JSON.stringify(dataSnapshot(next))); }
  catch {
    state.notice = { type: 'error', text: t('notice.saveFailed') };
    return false;
  }
  Object.assign(state, patch);
  return true;
}
function selectedNode() { return state.servers.find((node) => node.id === state.selectedId) || null; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function errorText(error) {
  const text = localizedError(error);
  // The Rust core still emits Russian diagnostics; the English UI marks them
  // instead of pretending they were translated.
  if (getLanguage() === 'en' && /[\u0400-\u04FF]/.test(text)) return t('err.coreRussian', { text });
  return text;
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
function nodeEndpoint(node) {
  const outbound = node?.outbound || {};
  const endpoint = outbound.settings?.vnext?.[0] || outbound.settings?.servers?.[0] || outbound.settings?.server || {};
  return { host: outbound.server || outbound.address || endpoint.address || endpoint.server || '', port: Number(outbound.server_port ?? outbound.port ?? endpoint.port) };
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
function countryName(node) {
  if (!node) return '';
  const code = node.countryCode || countryCodeFor(node.country);
  return code ? t(`country.${code}`) : (node.country || '');
}
function nodePlace(node) { return [countryName(node), node?.city].filter(Boolean).join(' · ') || t('servers.locationUnknown'); }
function visibleNodes() {
  const query = state.search.trim().toLowerCase();
  return query ? state.servers.filter((node) => `${node.name || ''} ${node.country || ''} ${countryName(node)} ${node.city || ''} ${node.protocol || ''}`.toLowerCase().includes(query)) : state.servers;
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
function navItem(id, icon, label) {
  return `<button class="side-item ${state.activeNav === id ? 'active' : ''}" data-nav="${id}" data-focus-key="nav-${id}" ${state.activeNav === id ? 'aria-current="page"' : ''}><span class="side-icon" aria-hidden="true">${icon}</span>${escapeHtml(label)}</button>`;
}
function renderNotice() {
  if (!state.notice) return '';
  const details = state.notice.details?.length ? `<ul>${state.notice.details.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '';
  return `<div class="notice ${state.notice.type === 'error' ? 'notice-error' : ''}" role="status"><div><strong>${escapeHtml(state.notice.text)}</strong>${details}</div><button class="notice-close" data-action="dismiss-notice" aria-label="${escapeHtml(t('app.close'))}">×</button></div>`;
}
function render() {
  const previous = document.activeElement;
  const focusKey = previous?.getAttribute?.('data-focus-key') || previous?.id || null;
  const oldSelection = previous && typeof previous.selectionStart === 'number' ? [previous.selectionStart, previous.selectionEnd] : null;
  const openingModal = Boolean(state.modal) && !modalPreviouslyOpen;
  const closingModal = !state.modal && modalPreviouslyOpen;
  const node = selectedNode();
  const title = t(`nav.${state.activeNav}`);
  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><img src="/potato-mark.svg" alt=""/><div><strong>Kartoshka<span>VPN</span></strong><small>${escapeHtml(t('app.tagline'))}</small></div></div>
      <nav class="side-nav" aria-label="${escapeHtml(t('app.navigation'))}">
        ${navItem('home', '⌂', t('nav.home'))}${navItem('servers', '◉', t('nav.servers'))}${navItem('stats', '▥', t('nav.stats'))}${navItem('settings', '⚙', t('nav.settings'))}${navItem('logs', '▤', t('nav.logs'))}
      </nav>
      <div class="sidebar-bottom">${navItem('about', 'ⓘ', t('nav.about'))}<div class="sidebar-foot"><span class="foot-dot"></span>${escapeHtml(capabilities.native ? t('app.windowsXray') : t('app.previewMode'))}</div></div>
    </aside>
    <main class="main-area">
      <header class="topbar"><div><span class="overline">KARTOSHKA VPN / DESKTOP</span><h1>${escapeHtml(title)}</h1></div><div class="topbar-right"><span class="mode-pill"><span></span> ${escapeHtml(capabilities.native ? t('app.windowsProxy') : t('app.preview'))}</span><button class="round-button" data-action="refresh" aria-label="${escapeHtml(t('app.refresh'))}" title="${escapeHtml(t('app.refresh'))}" ${state.importing ? 'disabled' : ''}>↻</button></div></header>
      ${renderNotice()}
      ${state.activeNav === 'home' ? homeMarkup(node) : state.activeNav === 'servers' ? serversMarkup(node) : utilityMarkup()}
      <footer class="bottom-note"><span>${escapeHtml(t('footer.proxy'))}</span><span>${escapeHtml(t('footer.direct'))}</span></footer>
    </main>
  </div>${state.modal === 'add' ? modalMarkup() : state.modal === 'result' ? resultMarkup() : ''}`;
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
function homeMarkup(selected) {
  const [status, detail, statusClass] = statusInfo();
  const displayed = state.connection === 'connected' && state.activeNode ? state.activeNode : selected;
  const reason = state.connection === 'connected' ? '' : unsupportedReason(selected);
  const differs = state.connection === 'connected' && selected && !sameConfig(state.activeNode, selected);
  const disabled = toggleDisabled(selected) ? 'disabled' : '';
  return `<section class="home-screen ${statusClass}">
    <div class="home-power"><div class="power-halo" aria-hidden="true"></div><button class="home-power-button" data-action="toggle" data-focus-key="home-power" aria-label="${escapeHtml(actionLabel())}" ${disabled}><span aria-hidden="true">⏻</span></button></div>
    <div class="home-status" role="status" aria-live="polite"><span class="home-kicker"><span class="status-dot"></span> ${escapeHtml(t('state.kicker'))}</span><h2>${escapeHtml(status)}</h2><p>${escapeHtml(detail)}</p></div>
    <button class="home-server-card" data-nav="servers"><span class="home-server-flag">${escapeHtml(displayed?.flag || '◇')}</span><span class="home-server-copy"><small>${escapeHtml(state.connection === 'connected' ? t('home.activeServer') : t('home.selectedServer'))}</small><strong>${escapeHtml(displayed?.name || t('home.noServer'))}</strong><span>${escapeHtml(displayed ? nodePlace(displayed) : t('home.addConfig'))}</span></span><span class="home-server-arrow" aria-hidden="true">›</span></button>
    <button class="home-connect-button" data-action="toggle" data-focus-key="home-connect" ${disabled}><span aria-hidden="true">⏻</span>${escapeHtml(actionLabel())}</button>
    ${reason ? `<div class="inline-warning">${escapeHtml(reason)}</div>` : ''}
    ${differs ? `<div class="inline-note">${escapeHtml(t('home.activeUnchanged'))}</div>` : ''}
    ${selected?.source === 'subscription-retained' ? `<div class="inline-warning">${escapeHtml(t('home.retained'))}</div>` : ''}
    ${state.connection === 'connected' && state.proxyCheckFailed ? `<div class="inline-warning" role="status">${escapeHtml(t('home.proxyCheckFailed'))}</div>` : ''}
    ${state.externalIp && state.connection === 'connected' && !state.proxyCheckFailed ? `<div class="home-ip">${escapeHtml(t('home.externalIp'))} <strong>${escapeHtml(state.externalIp)}</strong></div>` : ''}
    ${state.connection === 'error' ? `<div class="error-box" role="alert">${escapeHtml(messageText(state.message))}</div>` : ''}
  </section>`;
}
function serverCard(node) {
  const reason = unsupportedReason(node);
  const active = state.connection === 'connected' && sameConfig(state.activeNode, node);
  const meta = [node.protocol || t('servers.configuration'), nodePlace(node), node.source === 'subscription-retained' ? t('servers.retained') : '', active ? t('servers.active') : ''].filter(Boolean).join(' · ');
  return `<button class="server-card ${node.id === state.selectedId ? 'selected' : ''}" data-server="${escapeHtml(node.id)}" data-focus-key="server-${escapeHtml(node.id)}" ${busy() ? 'disabled' : ''} aria-pressed="${node.id === state.selectedId}"><span class="server-flag">${escapeHtml(node.flag || '◇')}</span><span class="server-card-copy"><strong>${escapeHtml(node.customName || node.name || t('servers.serverFallback'))}${node.favorite ? ` <span class="favorite-mark" aria-label="${escapeHtml(t('servers.favorite'))}">★</span>` : ''}</strong><small>${escapeHtml(meta)}</small>${reason ? `<small class="unsupported-text">${escapeHtml(reason)}</small>` : ''}</span><span class="server-card-ping ${tcpTestApplicable(node) && node.availability === 'offline' ? 'bad' : ''}">${!tcpTestApplicable(node) ? '—' : node.availability === 'testing' ? '…' : node.ping == null ? '—' : `${escapeHtml(node.ping)} ${t('unit.ms')}`}<small>${tcpTestApplicable(node) ? 'TCP' : 'UDP'}</small></span><span class="server-chevron" aria-hidden="true">›</span></button>`;
}
function serversMarkup(node) {
  const meta = state.subscriptionMeta;
  const nodes = visibleNodes();
  const usage = meta && Number.isFinite(meta.used) && Number.isFinite(meta.total) && meta.total > 0 ? Math.min(100, Math.max(0, meta.used / meta.total * 100)) : null;
  const [status, , statusClass] = statusInfo();
  const reason = unsupportedReason(node);
  const activeDiffers = state.connection === 'connected' && !sameConfig(state.activeNode, node);
  const pingLabel = (value) => value == null ? '—' : `${escapeHtml(value)} ${t('unit.ms')}`;
  return `<div class="workspace"><section class="server-column">
    <div class="section-heading"><div><span class="overline">${escapeHtml(t('servers.overline'))}</span><h2>${escapeHtml(t('servers.title'))}</h2></div><button class="primary-button" data-action="add">＋ ${escapeHtml(t('servers.add'))}</button></div>
    <div class="server-toolbar"><label class="search-box"><span aria-hidden="true">⌕</span><input id="server-search" data-focus-key="server-search" value="${escapeHtml(state.search)}" placeholder="${escapeHtml(t('servers.search'))}" aria-label="${escapeHtml(t('servers.search'))}"/></label><button class="toolbar-button" data-action="refresh" aria-label="${escapeHtml(t('app.refresh'))}" title="${escapeHtml(t('app.refresh'))}" ${state.importing ? 'disabled' : ''}>↻</button></div>
    <section class="subscription-panel"><div class="subscription-header"><div><strong>${escapeHtml(state.subscriptionUrl ? t('servers.subscriptionConnected') : t('servers.subscriptionMissing'))}</strong><small>${escapeHtml(state.subscriptionUrl ? formatExpiry(meta?.expiresAt) : t('servers.subscriptionHint'))}</small></div><button class="mini-action" data-action="add">${escapeHtml(state.subscriptionUrl ? t('servers.change') : t('servers.add'))}</button></div>
      ${state.subscriptionUrl && meta ? `<div class="usage-line"><span>${escapeHtml(t('servers.used', { used: formatBytes(meta.used), total: formatBytes(meta.total) }))}</span></div>${usage === null ? '' : `<div class="usage-track"><i style="width:${usage}%"></i></div>`}` : ''}</section>
    <div class="list-heading"><span>${escapeHtml(t('servers.count', { count: state.servers.length }))}</span><span>${escapeHtml(t('servers.latency'))}</span></div><div class="server-list">${nodes.length ? nodes.map(serverCard).join('') : `<div class="list-empty"><strong>${escapeHtml(state.servers.length ? t('servers.notFound') : t('servers.emptyTitle'))}</strong><span>${escapeHtml(state.servers.length ? t('servers.notFoundHint') : t('servers.emptyHint'))}</span>${!state.servers.length ? `<button class="primary-outline" data-action="add">${escapeHtml(t('servers.addServer'))}</button>` : ''}</div>`}</div>
  </section><section class="control-column"><div class="control-top"><span class="overline">${escapeHtml(t('control.overline'))}</span><span class="connection-badge ${statusClass}"><i></i>${escapeHtml(status)}</span></div>
    <div class="server-detail"><span class="detail-eyebrow">${escapeHtml(t('control.selected'))}</span>${node ? `<div class="detail-node"><span class="selected-flag">${escapeHtml(node.flag || '◇')}</span><div><h2>${escapeHtml(node.customName || node.name || t('servers.serverFallback'))}</h2><p>${escapeHtml(nodePlace(node))} · ${escapeHtml(node.protocol || '')}</p></div></div><div class="latency-row"><div><span>${escapeHtml(t('control.tcp'))}</span><strong>${!tcpTestApplicable(node) ? escapeHtml(t('control.tcpNotApplicable')) : node.availability === 'testing' ? escapeHtml(t('control.testing')) : pingLabel(node.ping)}</strong></div><div><span>${escapeHtml(t('control.viaProxy'))}</span><strong>${state.proxyTesting ? escapeHtml(t('control.testing')) : pingLabel(state.proxyPing)}</strong></div></div>${reason ? `<div class="inline-warning">${escapeHtml(reason)}</div>` : ''}<div class="detail-actions"><button class="primary-outline" data-action="ping" ${!tcpTestApplicable(node) || node.availability === 'testing' || !capabilities.native ? 'disabled' : ''}>${escapeHtml(t('control.testTcp'))}</button><button class="primary-outline" data-action="proxy-ping" ${state.connection !== 'connected' || state.proxyTesting || !capabilities.native ? 'disabled' : ''}>${escapeHtml(t('control.testProxy'))}</button><button class="ghost-button" data-action="favorite" aria-pressed="${Boolean(node.favorite)}">${escapeHtml(node.favorite ? t('control.favoriteRemove') : t('control.favoriteAdd'))}</button><button class="ghost-button danger" data-action="remove" ${busy() || state.connection === 'connected' ? 'disabled' : ''}>${escapeHtml(t('control.delete'))}</button></div>` : `<div class="no-selection">${escapeHtml(t('control.noSelection'))}</div>`}</div>
    ${activeDiffers ? `<div class="active-server-note">${escapeHtml(t('control.currentlyConnected', { name: state.activeNode?.name || t('servers.serverFallback') }))}</div>` : ''}
    ${node?.source === 'subscription-retained' ? `<div class="inline-warning">${escapeHtml(t('control.notApplied'))}</div>` : ''}
    ${state.connection === 'connected' && state.proxyCheckFailed ? `<div class="inline-warning" role="status">${escapeHtml(t('notice.proxyCheckFailedShort'))}</div>` : ''}
    <button class="detail-connect-button" data-action="toggle" data-focus-key="detail-connect" ${toggleDisabled(node) ? 'disabled' : ''}>${escapeHtml(actionLabel())}</button>
    <div class="connection-info"><div><span>${escapeHtml(t('control.time'))}</span><strong data-duration>${state.connection === 'connected' ? formatDuration() : '—'}</strong></div><div><span>${escapeHtml(t('control.mode'))}</span><strong>${escapeHtml(routeTitle(state.connection === 'connected' ? state.activeRouteMode : state.routeMode))}</strong></div><div><span>${escapeHtml(t('control.externalIp'))}</span><strong>${state.connection === 'connected' && !state.proxyCheckFailed ? escapeHtml(state.externalIp || '—') : '—'}</strong></div></div>
    ${state.connection === 'error' ? `<div class="error-box" role="alert">${escapeHtml(messageText(state.message))}</div>` : ''}
  </section></div>`;
}
function utilityMarkup() {
  if (state.activeNav === 'settings') {
    const source = state.subscriptionMeta?.routing ? t('settings.routeSourceSubscription') : t('settings.routeSourceBuiltin');
    const rejected = state.subscriptionMeta?.routingUnsupported?.length || 0;
    const routeNote = `${escapeHtml(t('settings.routeSource', { source }))}${rejected ? `<br/><span class="route-source warning-text">${escapeHtml(t('settings.routeUnsupported', { count: rejected }))}</span>` : ''}${state.subscriptionMeta?.routingDns ? `<br/><span class="route-source">${escapeHtml(t('settings.routeDnsIgnored'))}</span>` : ''}`;
    const unavailable = `<span>${escapeHtml(t('settings.unavailable'))}</span>`;
    return `<section class="utility-screen"><div class="utility-card"><span class="overline">${escapeHtml(t('settings.overline'))}</span><h2>${escapeHtml(t('settings.title'))}</h2><p class="utility-intro">${escapeHtml(t('settings.intro'))}</p>
      <div class="setting-row"><div><strong>${escapeHtml(t('settings.language'))}</strong><small>${escapeHtml(t('settings.languageHint'))}</small></div><select id="language" aria-label="${escapeHtml(t('settings.language'))}"><option value="ru" ${state.language === 'ru' ? 'selected' : ''}>${escapeHtml(t('settings.languageRu'))}</option><option value="en" ${state.language === 'en' ? 'selected' : ''}>${escapeHtml(t('settings.languageEn'))}</option></select></div>
      <div class="setting-row"><div><strong>${escapeHtml(t('settings.routeMode'))}</strong><small>${escapeHtml(routeDescription(state.routeMode))}${escapeHtml(state.connection === 'connected' ? t('settings.routeHintConnected') : '')}<br/>${routeNote}</small></div><select id="route-mode" aria-label="${escapeHtml(t('settings.routeMode'))}" ${busy() || state.connection === 'connected' || state.cleanupNeeded ? 'disabled' : ''}>${routeModeIds.map((id) => `<option value="${id}" ${id === state.routeMode ? 'selected' : ''}>${escapeHtml(routeTitle(id))}</option>`).join('')}</select></div>
      <div class="setting-row unavailable"><div><strong>${escapeHtml(t('settings.startup'))}</strong><small>${escapeHtml(t('settings.startupHint'))}</small></div>${unavailable}</div>
      <div class="setting-row unavailable"><div><strong>${escapeHtml(t('settings.autoReconnect'))}</strong><small>${escapeHtml(t('settings.autoReconnectHint'))}</small></div>${unavailable}</div>
      <div class="setting-row unavailable"><div><strong>${escapeHtml(t('settings.dns'))}</strong><small>${escapeHtml(t('settings.dnsHint'))}</small></div>${unavailable}</div></div></section>`;
  }
  if (state.activeNav === 'stats') return `<section class="utility-screen"><div class="utility-card"><span class="overline">${escapeHtml(t('stats.overline'))}</span><h2>${escapeHtml(t('stats.title'))}</h2><div class="stat-grid"><div><span>${escapeHtml(t('stats.state'))}</span><strong>${escapeHtml(statusInfo()[0])}</strong></div><div><span>${escapeHtml(t('stats.time'))}</span><strong data-duration>${state.connection === 'connected' ? formatDuration() : '—'}</strong></div><div><span>${escapeHtml(t('stats.externalIp'))}</span><strong>${state.connection === 'connected' && !state.proxyCheckFailed ? escapeHtml(state.externalIp || '—') : '—'}</strong></div><div><span>${escapeHtml(t('stats.servers'))}</span><strong>${state.servers.length}</strong></div><div><span>${escapeHtml(t('stats.used'))}</span><strong>${state.subscriptionMeta ? formatBytes(state.subscriptionMeta.used) : '—'}</strong></div><div><span>${escapeHtml(t('stats.limit'))}</span><strong>${state.subscriptionMeta ? formatBytes(state.subscriptionMeta.total) : '—'}</strong></div></div><p class="utility-intro">${escapeHtml(t('stats.note'))}</p></div></section>`;
  if (state.activeNav === 'about') return `<section class="utility-screen"><div class="utility-card"><span class="overline">${escapeHtml(t('about.overline', { version: VERSION }))}</span><h2>${escapeHtml(t('about.title'))}</h2><p class="about-copy">${escapeHtml(t('about.body1'))}</p><p class="about-copy">${escapeHtml(t('about.body2'))}</p><p class="about-copy">${escapeHtml(t('about.body3'))}</p></div></section>`;
  return `<section class="utility-screen"><div class="utility-card"><div class="utility-head"><div><span class="overline">${escapeHtml(t('logs.overline'))}</span><h2>${escapeHtml(t('logs.title'))}</h2></div><button class="primary-outline" data-action="refresh-logs">${escapeHtml(t('logs.refresh'))}</button></div><pre class="log-view">${escapeHtml(state.logs.join('\n') || t('logs.empty'))}</pre></div></section>`;
}
function modalMarkup() {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><div><span class="overline">${escapeHtml(t('modal.overline'))}</span><h2 id="modal-title">${escapeHtml(t('modal.title'))}</h2></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(t('app.close'))}" ${state.importing ? 'disabled' : ''}>×</button></div><p>${escapeHtml(t('modal.intro'))}</p><label class="visually-hidden" for="import-input">${escapeHtml(t('modal.label'))}</label><textarea id="import-input" data-focus-key="import-input" placeholder="${escapeHtml(t('modal.placeholder'))}" ${state.importing ? 'disabled' : ''}>${escapeHtml(state.pendingUrl)}</textarea><div class="modal-hint">${escapeHtml(t('modal.hint'))}</div>${state.importError ? `<div class="modal-error" role="alert">${escapeHtml(state.importError)}</div>` : ''}<div class="modal-actions"><button class="ghost-button" data-action="close-modal" ${state.importing ? 'disabled' : ''}>${escapeHtml(t('app.cancel'))}</button><button class="primary-button" data-action="import" ${state.importing ? 'disabled' : ''}>${state.importing ? escapeHtml(t('modal.importing')) : escapeHtml(t('modal.import'))}</button></div></section></div>`;
}
function issueList(items, kind) {
  if (!items?.length) return '';
  return `<div class="result-block"><strong>${escapeHtml(t(kind === 'error' ? 'modal.resultErrors' : 'modal.resultWarnings'))}</strong><ul>${items.slice(0, 40).map((item) => `<li>${escapeHtml(`${item.line ? `${item.line}: ` : ''}${t(`err.${item.key}`, item.params || {})}`)}</li>`).join('')}${items.length > 40 ? `<li>… ${items.length - 40}</li>` : ''}</ul></div>`;
}
function resultMarkup() {
  const plan = state.pendingImport;
  if (!plan) return '';
  const ok = plan.nodes.filter((node) => !unsupportedReason(node)).length;
  const failed = plan.errors.length;
  const actionable = plan.nodes.length > 0;
  return `<div class="modal-backdrop"><section class="modal modal-result" role="dialog" aria-modal="true" aria-labelledby="result-title"><div class="modal-head"><div><span class="overline">${escapeHtml(t('modal.resultTitle'))}</span><h2 id="result-title">${escapeHtml(t('modal.resultTitle'))}</h2></div><button class="modal-close" data-action="close-result" aria-label="${escapeHtml(t('app.close'))}">×</button></div><p>${escapeHtml(t('modal.resultLead', { total: plan.total, ok, failed }))}</p>${actionable ? '' : `<div class="modal-error" role="alert">${escapeHtml(t('modal.resultNothing'))}</div>`}${issueList(plan.errors, 'error')}${issueList(plan.warnings, 'warning')}<p class="modal-hint">${escapeHtml(t('modal.resultKept'))}</p><div class="modal-actions"><button class="ghost-button" data-action="close-result">${escapeHtml(actionable ? t('modal.resultCancel') : t('app.close'))}</button>${actionable ? `<button class="primary-button" data-action="apply-import">${escapeHtml(plan.isSubscription ? t('modal.resultRefresh') : t('modal.resultImport'))}</button>` : ''}</div></section></div>`;
}
function bindEvents() {
  document.querySelectorAll('[data-server]').forEach((button) => button.addEventListener('click', () => selectServer(button.dataset.server)));
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', async () => {
    state.activeNav = button.dataset.nav; render(); document.querySelector(`[data-focus-key="nav-${state.activeNav}"]`)?.focus();
    if (state.activeNav === 'logs') { await loadLogs(); if (state.activeNav === 'logs') render(); }
  }));
  document.querySelectorAll('[data-action="add"]').forEach((button) => button.addEventListener('click', () => { state.pendingUrl = ''; state.importError = ''; state.pendingImport = null; state.modal = 'add'; render(); }));
  document.querySelectorAll('[data-action="close-modal"]').forEach((button) => button.addEventListener('click', () => { if (!state.importing) { state.modal = null; state.importError = ''; render(); } }));
  document.querySelectorAll('[data-action="close-result"]').forEach((button) => button.addEventListener('click', () => { state.pendingImport = null; state.modal = null; render(); }));
  document.querySelector('[data-action="apply-import"]')?.addEventListener('click', () => applyPendingImport());
  document.querySelectorAll('[data-action="dismiss-notice"]').forEach((button) => button.addEventListener('click', () => { state.notice = null; render(); }));
  document.querySelector('#server-search')?.addEventListener('input', (event) => { state.search = event.target.value; render(); });
  document.querySelector('#import-input')?.addEventListener('input', (event) => { state.pendingUrl = event.target.value; });
  document.querySelector('[data-action="import"]')?.addEventListener('click', () => runImport(state.pendingUrl, false));
  document.querySelectorAll('[data-action="refresh"]').forEach((button) => button.addEventListener('click', () => {
    if (state.importing) return;
    if (state.subscriptionUrl) runImport(state.subscriptionUrl, true);
    else { state.pendingUrl = ''; state.importError = ''; state.modal = 'add'; render(); }
  }));
  document.querySelectorAll('[data-action="toggle"]').forEach((button) => button.addEventListener('click', toggleConnection));
  document.querySelector('[data-action="ping"]')?.addEventListener('click', () => pingOne(selectedNode()));
  document.querySelector('[data-action="proxy-ping"]')?.addEventListener('click', () => pingProxy);
  document.querySelector('[data-action="favorite"]')?.addEventListener('click', () => { const node = selectedNode(); if (node) { commitData({ servers: state.servers.map((item) => item.id === node.id ? { ...item, favorite: !item.favorite } : item) }); render(); } });
  document.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
    if (busy() || state.connection === 'connected' || state.cleanupNeeded) return;
    const servers = state.servers.filter((item) => item.id !== state.selectedId);
    commitData({ servers, selectedId: servers[0]?.id || null }); render();
  });
  document.querySelector('#route-mode')?.addEventListener('change', (event) => {
    if (busy() || state.connection === 'connected' || state.cleanupNeeded) return;
    if (routeModeIds.includes(event.target.value)) { commitData({ routeMode: event.target.value }); render(); }
  });
  document.querySelector('#language')?.addEventListener('change', (event) => {
    const language = event.target.value === 'en' ? 'en' : 'ru';
    setLanguage(language);
    state.language = language;
    commitData({ language, settings: { ...(state.settings || {}), language } });
    render();
  });
  document.querySelector('[data-action="refresh-logs"]')?.addEventListener('click', async () => { await loadLogs(); render(); });
  document.querySelector('.modal')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !state.importing) { state.modal = null; state.pendingImport = null; render(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...document.querySelectorAll('.modal button:not(:disabled), .modal textarea:not(:disabled), .modal select:not(:disabled)')];
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
  });
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
function importSummary(result) {
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
    try { response = isSubscription ? await desktopBridge.fetchSubscription(text) : { body: text, userinfo: null }; }
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
      return { nodes: [], errors: [], warnings: [], total: 0, isSubscription: true, routingOnly: true, routing, url: text, meta: state.subscriptionMeta, manualRouting: true };
    }
    return { nodes: [], errors: errors.length ? errors : [{ key: 'err.noServers' }], warnings, total: 0, isSubscription, routing, url: text, meta: null };
  }
  return { nodes: parsed.nodes, errors, warnings, total: parsed.nodes.length + errors.length, isSubscription, routing, url: text, meta: isSubscription ? parseUserinfo(response.userinfo) : null, format: parsed.format };
}
function applyImport(plan) {
  if (plan.routingOnly && plan.manualRouting) {
    const meta = { ...(state.subscriptionMeta || {}), routing: plan.routing, routingSource: 'happ', routingUpdatedAt: new Date().toISOString() };
    if (!commitData({ subscriptionMeta: meta })) throw Object.assign(new Error('saveFailed'), { code: 'saveFailed' });
    return { count: 0, duplicates: 0, unsupported: 0, retained: 0, skipped: 0 };
  }
  const isSubscription = plan.isSubscription;
  const source = isSubscription ? 'subscription' : 'manual';
  // The list may have changed while the request was in flight. Reconcile only after it finishes.
  const previous = state.servers;
  const oldSubscription = isSubscription ? previous.filter((node) => node.source === 'subscription' || node.source === 'subscription-retained') : [];
  const seen = new Set(isSubscription ? [] : previous.filter((node) => node.source === 'manual').map(nodeSignature));
  const incoming = [];
  let duplicates = 0;
  for (const node of plan.nodes) {
    const signature = nodeSignature(node);
    if (seen.has(signature)) { duplicates += 1; continue; }
    seen.add(signature); incoming.push(node);
  }
  const matches = new Map(), matchedOld = new Set();
  function matchUnique(keyFor) {
    const oldGroups = new Map(), newGroups = new Map();
    const add = (groups, key, item) => { if (key) groups.set(key, [...(groups.get(key) || []), item]); };
    oldSubscription.filter((node) => !matchedOld.has(node)).forEach((node) => add(oldGroups, keyFor(node), node));
    incoming.filter((node) => !matches.has(node)).forEach((node) => add(newGroups, keyFor(node), node));
    for (const [key, nodes] of newGroups) {
      const old = oldGroups.get(key);
      if (nodes.length === 1 && old?.length === 1) { matches.set(nodes[0], old[0]); matchedOld.add(old[0]); }
    }
  }
  if (isSubscription) { matchUnique(nodeSignature); matchUnique(nodeIdentity); }
  const retained = oldSubscription.filter((node) => !matchedOld.has(node) && (node.favorite || node.customName || node.id === state.selectedId));
  const remaining = isSubscription ? [...previous.filter((node) => !oldSubscription.includes(node)), ...retained.map((node) => ({ ...node, source: 'subscription-retained' }))] : [...previous];
  const reservedIds = new Set(remaining.map((node) => node.id));
  const previousIds = new Set(previous.map((node) => node.id));
  const imported = incoming.map((node) => {
    const old = matches.get(node);
    let id = old && !reservedIds.has(old.id) ? old.id : node.id;
    if (!id || reservedIds.has(id) || (!old && previousIds.has(id))) {
      const base = String(id || 'node'); let suffix = 2;
      while (reservedIds.has(`${base}-${suffix}`) || previousIds.has(`${base}-${suffix}`)) suffix += 1;
      id = `${base}-${suffix}`;
    }
    reservedIds.add(id);
    return { ...node, id, source, favorite: old?.favorite ?? node.favorite ?? false, customName: old?.customName ?? node.customName ?? '', ping: null, proxyPing: null, availability: 'unknown' };
  });
  const servers = [...remaining, ...imported];
  const selectedId = servers.some((node) => node.id === state.selectedId) ? state.selectedId : servers[0]?.id || null;
  const routing = plan.routing || (isSubscription ? null : state.subscriptionMeta?.routing || null);
  const meta = isSubscription ? {
    ...(plan.meta || {}),
    routing: routing || null,
    routingUnsupported: routing?.unsupported || [],
    routingDns: Boolean(routing?.dns),
    routingSource: routing ? (plan.format === 'happ-routing' ? 'happ' : 'subscription') : null,
    routingUpdatedAt: routing ? new Date().toISOString() : null
  } : state.subscriptionMeta;
  const patch = { servers, selectedId, ...(isSubscription ? { subscriptionUrl: plan.url, subscriptionMeta: meta } : {}) };
  if (!commitData(patch)) throw Object.assign(new Error('saveFailed'), { code: 'saveFailed' });
  return { count: imported.length, duplicates, unsupported: imported.filter((node) => node.unsupported).length, retained: retained.length, skipped: plan.errors.length };
}

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
async function pingProxy() {
  if (!capabilities.native || state.connection !== 'connected' || state.proxyTesting) return;
  const session = sessionSequence;
  state.proxyTesting = true; state.proxyPing = null; render();
  try {
    const value = await desktopBridge.proxyLatency();
    if (session !== sessionSequence || state.connection !== 'connected') return;
    state.proxyPing = Number.isFinite(value) && value >= 0 ? value : null;
    state.proxyCheckFailed = state.proxyPing === null;
    if (state.proxyCheckFailed) state.notice = { type: 'error', code: 'proxy-check', text: t('notice.proxyCheckFailed') };
    else if (state.notice?.code === 'proxy-check') state.notice = null;
  } catch {
    if (session === sessionSequence && state.connection === 'connected') { state.proxyCheckFailed = true; state.notice = { type: 'error', code: 'proxy-check', text: t('notice.proxyCheckError') }; }
  } finally { if (session === sessionSequence) state.proxyTesting = false; render(); }
}
async function loadLogs() {
  try { const text = await desktopBridge.readLogs(); state.logs = text ? text.trim().split('\n').slice(-200) : []; }
  catch (error) { state.logs = [t('logs.failed', { error: errorText(error) })]; }
}
function resetSession() { state.activeNode = null; state.activeRouteMode = null; state.connectedAt = null; state.externalIp = null; state.proxyPing = null; state.proxyTesting = false; state.proxyCheckFailed = false; if (state.notice?.code === 'proxy-check') state.notice = null; sessionSequence += 1; }
async function stopProxy() {
  const result = await desktopBridge.disconnect();
  if (result?.ok === false) throw Object.assign(new Error(result.error || 'proxyStopFailed'), { code: 'proxyStopFailed' });
}
async function stopCurrent(messageKey = 'state.restoringProxy') {
  state.connection = 'disconnecting'; setMessage(messageKey); render();
  try {
    await stopProxy(); resetSession(); state.cleanupNeeded = false; return true;
  } catch (error) {
    resetSession(); state.cleanupNeeded = true; state.connection = 'error';
    setMessage('state.restoreFailed', { error: errorText(error) }); render(); return false;
  }
}
async function startSelected(node) {
  if (!node || unsupportedReason(node)) return;
  if (!capabilities.native || !state.bridgeReady || state.cleanupNeeded) {
    state.connection = 'error'; setMessage('state.connectUnavailable'); render(); return;
  }
  const route = state.routeMode;
  const operation = ++operationSequence;
  const exitsAtStart = exitSequence;
  state.connection = 'connecting'; setMessage('state.startingXray', { name: node.name || t('servers.serverFallback') }); state.cleanupNeeded = false; render();
  try {
    // Pin the stored node, not a copy: the fingerprint must survive the session.
    if (node.needsPin) { setMessage('state.pinning'); render(); await ensurePin(node); }
    const snapshot = copyNode(node);
    const config = buildXrayConfig([snapshot], snapshot.id, route, state.subscriptionMeta?.routing || null);
    const result = await desktopBridge.connect({ config });
    if (result?.ok === false) throw Object.assign(new Error('proxyLaunchFailed'), { code: 'proxyLaunchFailed', params: { error: errorText(result.error) } });
    if (operation !== operationSequence || exitSequence !== exitsAtStart) throw Object.assign(new Error('xrayExitedDuringConnect'), { code: 'xrayExitedDuringConnect' });
    setMessage('state.checkingInternet'); render();
    const ip = await desktopBridge.probeInternet();
    if (operation !== operationSequence || exitSequence !== exitsAtStart) throw Object.assign(new Error('xrayExitedDuringProbe'), { code: 'xrayExitedDuringProbe' });
    if (!ip) throw Object.assign(new Error('probeEmpty'), { code: 'probeEmpty' });
    state.activeNode = snapshot; state.activeRouteMode = route; state.externalIp = ip; state.connectedAt = Date.now(); state.connection = 'connected'; setMessage('state.established'); sessionSequence += 1; render();
  } catch (error) {
    // Even a failed launch may have changed system proxy settings; cleanup is mandatory.
    state.connection = 'disconnecting'; setMessage('state.restoringProxy'); render();
    let cleanupError = '';
    try { await stopProxy(); } catch (cleanup) { cleanupError = errorText(cleanup); }
    resetSession(); state.cleanupNeeded = Boolean(cleanupError); state.connection = 'error';
    const base = errorText(error);
    state.message = { key: 'raw', params: { text: cleanupError ? `${base}${t('state.cleanupFailedSuffix', { error: cleanupError })}` : base } };
    render();
  }
}
async function toggleConnection() {
  if (busy()) return;
  if (state.cleanupNeeded || state.connection === 'connected') {
    if (await stopCurrent()) {
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
    const snapshot = copyNode(node);
    if (!(await stopCurrent('state.restoringBeforeSwitch'))) return;
    // A subscription refresh can finish while stopping. Connect the originally chosen snapshot,
    // and show it as active even if the refreshed list no longer contains it.
    const selectedId = state.servers.some((item) => item.id === id) ? id : state.selectedId;
    if (!commitData({ selectedId })) { state.connection = 'idle'; setMessage('state.stopped'); render(); return; }
    await startSelected(snapshot); return;
  }
  commitData({ selectedId: id }); render();
}
function handleProxyExit(message) {
  if (state.connection === 'disconnecting' || state.connection === 'idle' || state.connection === 'error') return;
  exitSequence += 1;
  if (state.connection === 'connecting') { setMessage('state.xrayExitedConnecting'); render(); return; }
  // Block new operations until a cleanup attempt has completed.
  void (async () => {
    const detail = typeof message === 'string' && message ? message : t('state.xrayExited');
    if (await stopCurrent('state.restoringAfterXray')) { state.connection = 'error'; state.message = { key: 'raw', params: { text: detail } }; render(); }
    else { state.message = { key: 'raw', params: { text: `${detail}. ${messageText(state.message)}` } }; render(); }
  })();
}
render();
void (async () => {
  let watchError = '';
  try { await desktopBridge.watchProxyExit(handleProxyExit); } catch (error) { watchError = errorText(error); }
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
  render();
})();
window.setInterval(() => { if (state.connection === 'connected') document.querySelectorAll('[data-duration]').forEach((item) => { item.textContent = formatDuration(); }); }, 1000);
