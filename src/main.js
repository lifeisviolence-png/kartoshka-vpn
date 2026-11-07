import './styles.css';
import { desktopBridge } from './desktop-bridge.js';
import { parseSubscriptionDetailed, parseUserinfo } from './subscription.js';
import { buildXrayConfig } from './xray-config.js';

const capabilities = desktopBridge.getCapabilities();
const routeModes = [
  { id: 'all', title: 'Через сервер', description: 'Запросы приложений, использующих системный прокси, направляются через сервер.' },
  { id: 'split', title: 'Россия напрямую', description: 'Российские домены и IP — напрямую, остальные запросы — через сервер. Определение IP может использовать локальный DNS.' }
];
const directScheme = /^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//i;
const storageKey = 'kartoshka.state.v1';
const savedData = loadStoredData();
const storedRoute = savedData.routeMode;
const savedServers = savedData.nodes;
const state = {
  servers: Array.isArray(savedServers) ? savedServers.map((node) => ({ ...node, ping: null, proxyPing: null, availability: 'unknown' })) : [],
  selectedId: savedData.selectedId || null,
  subscriptionUrl: savedData.subscriptionUrl || '',
  subscriptionMeta: savedData.subscriptionMeta || null,
  // Older versions saved additional controls; keep their values even though
  // the corresponding functionality is currently unavailable.
  settings: savedData.settings ?? null,
  previousRouteMode: savedData.previousRouteMode ?? (storedRoute && !routeModes.some((mode) => mode.id === storedRoute) ? storedRoute : null),
  routeMode: routeModes.some((mode) => mode.id === storedRoute) ? storedRoute : 'all',
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
  notice: null,
  logs: [],
  search: '',
  message: capabilities.native ? 'Проверяем состояние системного прокси…' : 'Предпросмотр: подключение недоступно'
};
if (!state.selectedId || !state.servers.some((node) => node.id === state.selectedId)) state.selectedId = state.servers[0]?.id || null;
if (savedData.migrate) {
  // Legacy keys remain untouched until and after the new snapshot is committed.
  try { localStorage.setItem(storageKey, JSON.stringify(dataSnapshot(state))); }
  catch { state.notice = { type: 'error', text: 'Не удалось сохранить данные. Старые данные оставлены без изменений.' }; }
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
  if (current?.version === 1 && Array.isArray(current.nodes)) return current;
  let nodes = loadJson('kartoshka.nodes', []);
  if (!Array.isArray(nodes)) nodes = [];
  let subscriptionUrl = readStored('kartoshka.subscriptionUrl', '');
  let subscriptionMeta = loadJson('kartoshka.subscriptionMeta', null);
  // Old manual imports were tagged as subscription and saved their URI as its URL.
  if (directScheme.test(String(subscriptionUrl).trim())) {
    nodes = nodes.map((node) => node.source === 'subscription' ? { ...node, source: 'manual' } : node);
    subscriptionUrl = ''; subscriptionMeta = null;
  }
  return { nodes, selectedId: readStored('kartoshka.selectedId', ''), subscriptionUrl, subscriptionMeta, settings: loadJson('kartoshka.settings', null), routeMode: readStored('kartoshka.routeMode', 'all'), migrate: true };
}
function dataSnapshot(data) {
  // Latencies describe one moment; all durable settings are one atomic value.
  return { version: 1, nodes: data.servers.map(({ ping, proxyPing, availability, ...node }) => node), selectedId: data.selectedId || null, subscriptionUrl: data.subscriptionUrl || '', subscriptionMeta: data.subscriptionMeta || null, routeMode: data.routeMode, settings: data.settings, previousRouteMode: data.previousRouteMode };
}
function commitData(patch) {
  const next = { ...state, ...patch };
  try { localStorage.setItem(storageKey, JSON.stringify(dataSnapshot(next))); }
  catch {
    state.notice = { type: 'error', text: 'Не удалось сохранить данные. Изменения отменены; проверьте доступное место в хранилище.' };
    return false;
  }
  Object.assign(state, patch);
  return true;
}
function selectedNode() { return state.servers.find((node) => node.id === state.selectedId) || null; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function errorText(error) { return typeof error === 'string' ? error : error?.message || 'Неизвестная ошибка'; }
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let value = Number(bytes); let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
function formatExpiry(date) {
  if (!date) return 'Срок не передан';
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? 'Срок не передан' : `до ${value.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })}`;
}
function formatDuration() {
  if (!state.connectedAt) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - state.connectedAt) / 1000));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':');
}
function busy() { return state.connection === 'connecting' || state.connection === 'disconnecting'; }
function unsupportedReason(node) {
  if (!node) return '';
  if (node.unsupportedReason) return String(node.unsupportedReason);
  if (node.unsupported || node.supported === false) return typeof node.unsupported === 'string' ? node.unsupported : 'Этот тип конфигурации не поддерживается Xray';
  // Also validate nodes persisted by older releases, which predate the parser flags.
  try { buildXrayConfig([node], node.id, 'all'); return ''; }
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
function nodePlace(node) { return [node?.country, node?.city].filter(Boolean).join(' · ') || 'Местоположение не указано'; }
function visibleNodes() {
  const query = state.search.trim().toLowerCase();
  return query ? state.servers.filter((node) => `${node.name || ''} ${node.country || ''} ${node.city || ''} ${node.protocol || ''}`.toLowerCase().includes(query)) : state.servers;
}
function statusInfo() {
  return {
    idle: ['Не подключено', state.message, 'idle'],
    connecting: ['Подключение…', state.message, 'connecting'],
    disconnecting: ['Отключение…', state.message, 'connecting'],
    connected: [state.proxyCheckFailed ? 'Прокси включён' : 'Подключено', state.proxyCheckFailed ? 'Системный прокси настроен для активного сервера; доступ не подтверждён' : 'Системный прокси Windows настроен для активного сервера', 'connected'],
    error: ['Ошибка подключения', state.message, 'error']
  }[state.connection];
}
function actionLabel() {
  if (state.cleanupNeeded) return 'Повторить отключение';
  if (state.connection === 'connected') return 'Отключиться';
  if (state.connection === 'connecting') return 'Подключение…';
  if (state.connection === 'disconnecting') return 'Отключение…';
  return 'Подключиться';
}
function toggleDisabled(node) {
  return busy() || (!state.cleanupNeeded && state.connection !== 'connected' && ((!state.bridgeReady && capabilities.native) || !node || Boolean(unsupportedReason(node))));
}
function navItem(id, icon, label) {
  return `<button class="side-item ${state.activeNav === id ? 'active' : ''}" data-nav="${id}" data-focus-key="nav-${id}" ${state.activeNav === id ? 'aria-current="page"' : ''}><span class="side-icon" aria-hidden="true">${icon}</span>${label}</button>`;
}
function renderNotice() {
  if (!state.notice) return '';
  return `<div class="notice ${state.notice.type === 'error' ? 'notice-error' : ''}" role="status"><div><strong>${escapeHtml(state.notice.text)}</strong>${state.notice.details?.length ? `<ul>${state.notice.details.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}</div><button class="notice-close" data-action="dismiss-notice" aria-label="Закрыть уведомление">×</button></div>`;
}
function render() {
  const previous = document.activeElement;
  const focusKey = previous?.getAttribute?.('data-focus-key') || previous?.id || null;
  const oldSelection = previous && typeof previous.selectionStart === 'number' ? [previous.selectionStart, previous.selectionEnd] : null;
  const openingModal = Boolean(state.modal) && !modalPreviouslyOpen;
  const closingModal = !state.modal && modalPreviouslyOpen;
  const node = selectedNode();
  const title = { home: 'Главная', servers: 'Серверы', stats: 'Статистика', settings: 'Настройки', logs: 'Логи', about: 'О приложении' }[state.activeNav] || 'Главная';
  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><img src="/potato-mark.svg" alt=""/><div><strong>Kartoshka<span>VPN</span></strong><small>DESKTOP CLIENT</small></div></div>
      <nav class="side-nav" aria-label="Основная навигация">
        ${navItem('home', '⌂', 'Главная')}${navItem('servers', '◉', 'Серверы')}${navItem('stats', '▥', 'Статистика')}${navItem('settings', '⚙', 'Настройки')}${navItem('logs', '▤', 'Логи')}
      </nav>
      <div class="sidebar-bottom">${navItem('about', 'ⓘ', 'О приложении')}<div class="sidebar-foot"><span class="foot-dot"></span>${capabilities.native ? 'Windows · Xray' : 'Режим предпросмотра'}</div></div>
    </aside>
    <main class="main-area">
      <header class="topbar"><div><span class="overline">KARTOSHKA VPN / DESKTOP</span><h1>${title}</h1></div><div class="topbar-right"><span class="mode-pill"><span></span> ${capabilities.native ? 'WINDOWS PROXY' : 'PREVIEW'}</span><button class="round-button" data-action="refresh" aria-label="Обновить подписку" title="Обновить подписку" ${state.importing ? 'disabled' : ''}>↻</button></div></header>
      ${renderNotice()}
      ${state.activeNav === 'home' ? homeMarkup(node) : state.activeNav === 'servers' ? serversMarkup(node) : utilityMarkup()}
      <footer class="bottom-note"><span>Системный прокси Windows</span><span>Приложения, не использующие его, работают напрямую</span></footer>
    </main>
  </div>${state.modal === 'add' ? modalMarkup() : ''}`;
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
    <div class="home-power"><div class="power-halo" aria-hidden="true"></div><button class="home-power-button" data-action="toggle" data-focus-key="home-power" aria-label="${actionLabel()}" ${disabled}><span aria-hidden="true">⏻</span></button></div>
    <div class="home-status" role="status" aria-live="polite"><span class="home-kicker"><span class="status-dot"></span> СОСТОЯНИЕ ПОДКЛЮЧЕНИЯ</span><h2>${status}</h2><p>${escapeHtml(detail)}</p></div>
    <button class="home-server-card" data-nav="servers"><span class="home-server-flag">${escapeHtml(displayed?.flag || '◇')}</span><span class="home-server-copy"><small>${state.connection === 'connected' ? 'АКТИВНЫЙ СЕРВЕР' : 'ВЫБРАННЫЙ СЕРВЕР'}</small><strong>${escapeHtml(displayed?.name || 'Сервер не выбран')}</strong><span>${escapeHtml(displayed ? nodePlace(displayed) : 'Добавьте конфигурацию для подключения')}</span></span><span class="home-server-arrow" aria-hidden="true">›</span></button>
    <button class="home-connect-button" data-action="toggle" data-focus-key="home-connect" ${disabled}><span aria-hidden="true">⏻</span>${actionLabel()}</button>
    ${reason ? `<div class="inline-warning">${escapeHtml(reason)}</div>` : ''}
    ${differs ? `<div class="inline-note">Активное подключение не изменилось. Выбран другой или обновлённый сервер.</div>` : ''}
    ${selected?.source === 'subscription-retained' ? '<div class="inline-warning">Выбранный сервер сохранён из прежней подписки: сопоставить его с последним обновлением не удалось. Параметры могут быть устаревшими.</div>' : ''}
    ${state.connection === 'connected' && state.proxyCheckFailed ? '<div class="inline-warning" role="status">Последняя проверка прокси не пройдена. Доступ через прокси не подтверждён.</div>' : ''}
    ${state.externalIp && state.connection === 'connected' && !state.proxyCheckFailed ? `<div class="home-ip">Внешний IP через прокси <strong>${escapeHtml(state.externalIp)}</strong></div>` : ''}
    ${state.connection === 'error' ? `<div class="error-box" role="alert">${escapeHtml(state.message)}</div>` : ''}
  </section>`;
}
function serverCard(node) {
  const reason = unsupportedReason(node);
  const active = state.connection === 'connected' && sameConfig(state.activeNode, node);
  return `<button class="server-card ${node.id === state.selectedId ? 'selected' : ''}" data-server="${escapeHtml(node.id)}" data-focus-key="server-${escapeHtml(node.id)}" ${busy() ? 'disabled' : ''} aria-pressed="${node.id === state.selectedId}"><span class="server-flag">${escapeHtml(node.flag || '◇')}</span><span class="server-card-copy"><strong>${escapeHtml(node.customName || node.name || 'Сервер')}${node.favorite ? ' <span class="favorite-mark" aria-label="В избранном">★</span>' : ''}</strong><small>${escapeHtml(node.protocol || 'Конфигурация')} · ${escapeHtml(nodePlace(node))}${node.source === 'subscription-retained' ? ' · Сохранён из прежней подписки' : ''}${active ? ' · Активен' : ''}</small>${reason ? `<small class="unsupported-text">${escapeHtml(reason)}</small>` : ''}</span><span class="server-card-ping ${tcpTestApplicable(node) && node.availability === 'offline' ? 'bad' : ''}">${!tcpTestApplicable(node) ? '—' : node.availability === 'testing' ? '…' : node.ping == null ? '—' : `${escapeHtml(node.ping)} мс`}<small>${tcpTestApplicable(node) ? 'TCP' : 'UDP'}</small></span><span class="server-chevron" aria-hidden="true">›</span></button>`;
}
function serversMarkup(node) {
  const meta = state.subscriptionMeta;
  const nodes = visibleNodes();
  const usage = meta && Number.isFinite(meta.used) && Number.isFinite(meta.total) && meta.total > 0 ? Math.min(100, Math.max(0, meta.used / meta.total * 100)) : null;
  const [status, , statusClass] = statusInfo();
  const reason = unsupportedReason(node);
  const activeDiffers = state.connection === 'connected' && !sameConfig(state.activeNode, node);
  return `<div class="workspace"><section class="server-column">
    <div class="section-heading"><div><span class="overline">ВАШИ КОНФИГУРАЦИИ</span><h2>Список серверов</h2></div><button class="primary-button" data-action="add">＋ Добавить</button></div>
    <div class="server-toolbar"><label class="search-box"><span aria-hidden="true">⌕</span><input id="server-search" data-focus-key="server-search" value="${escapeHtml(state.search)}" placeholder="Поиск по серверам" aria-label="Поиск по серверам"/></label><button class="toolbar-button" data-action="refresh" aria-label="Обновить подписку" title="Обновить подписку" ${state.importing ? 'disabled' : ''}>↻</button></div>
    <section class="subscription-panel"><div class="subscription-header"><div><strong>${state.subscriptionUrl ? 'Подписка подключена' : 'Подписка не добавлена'}</strong><small>${state.subscriptionUrl ? escapeHtml(formatExpiry(meta?.expiresAt)) : 'Добавьте ссылку подписки или отдельный сервер'}</small></div><button class="mini-action" data-action="add">${state.subscriptionUrl ? 'Изменить' : 'Добавить'}</button></div>
      ${state.subscriptionUrl && meta ? `<div class="usage-line"><span>Использовано ${formatBytes(meta.used)} из ${formatBytes(meta.total)}</span></div>${usage === null ? '' : `<div class="usage-track"><i style="width:${usage}%"></i></div>`}` : ''}</section>
    <div class="list-heading"><span>${state.servers.length} серверов</span><span>Задержка TCP</span></div><div class="server-list">${nodes.length ? nodes.map(serverCard).join('') : `<div class="list-empty"><strong>${state.servers.length ? 'Ничего не найдено' : 'Список серверов пуст'}</strong><span>${state.servers.length ? 'Попробуйте изменить поиск' : 'Добавьте подписку или ссылку на сервер'}</span>${!state.servers.length ? '<button class="primary-outline" data-action="add">Добавить сервер</button>' : ''}</div>`}</div>
  </section><section class="control-column"><div class="control-top"><span class="overline">ПОДКЛЮЧЕНИЕ</span><span class="connection-badge ${statusClass}"><i></i>${status}</span></div>
    <div class="server-detail"><span class="detail-eyebrow">ВЫБРАННЫЙ СЕРВЕР</span>${node ? `<div class="detail-node"><span class="selected-flag">${escapeHtml(node.flag || '◇')}</span><div><h2>${escapeHtml(node.customName || node.name || 'Сервер')}</h2><p>${escapeHtml(nodePlace(node))} · ${escapeHtml(node.protocol || '')}</p></div></div><div class="latency-row"><div><span>Задержка TCP</span><strong>${!tcpTestApplicable(node) ? 'TCP-тест неприменим' : node.availability === 'testing' ? 'Проверка…' : node.ping == null ? '—' : `${escapeHtml(node.ping)} мс`}</strong></div><div><span>Через активный прокси</span><strong>${state.proxyTesting ? 'Проверка…' : state.proxyPing == null ? '—' : `${escapeHtml(state.proxyPing)} мс`}</strong></div></div>${reason ? `<div class="inline-warning">${escapeHtml(reason)}</div>` : ''}<div class="detail-actions"><button class="primary-outline" data-action="ping" ${!tcpTestApplicable(node) || node.availability === 'testing' || !capabilities.native ? 'disabled' : ''}>Проверить TCP</button><button class="primary-outline" data-action="proxy-ping" ${state.connection !== 'connected' || state.proxyTesting || !capabilities.native ? 'disabled' : ''}>Проверить прокси</button><button class="ghost-button" data-action="favorite" aria-pressed="${Boolean(node.favorite)}">${node.favorite ? '★ В избранном' : '☆ В избранное'}</button><button class="ghost-button danger" data-action="remove" ${busy() || state.connection === 'connected' ? 'disabled' : ''}>Удалить</button></div>` : '<div class="no-selection">Выберите сервер в списке или добавьте новую конфигурацию.</div>'}</div>
    ${activeDiffers ? `<div class="active-server-note">Сейчас подключён: <strong>${escapeHtml(state.activeNode?.name || 'сервер')}</strong>. Выбранный сервер не изменяет активное соединение до переключения.</div>` : ''}
    ${node?.source === 'subscription-retained' ? '<div class="inline-warning">Сервер сохранён из прежней подписки: сопоставить его с последним обновлением не удалось. Параметры могут быть устаревшими.</div>' : ''}
    ${state.connection === 'connected' && state.proxyCheckFailed ? '<div class="inline-warning" role="status">Последняя проверка прокси не пройдена. Доступ через прокси не подтверждён.</div>' : ''}
    <button class="detail-connect-button" data-action="toggle" data-focus-key="detail-connect" ${toggleDisabled(node) ? 'disabled' : ''}>${actionLabel()}</button>
    <div class="connection-info"><div><span>Время подключения</span><strong data-duration>${state.connection === 'connected' ? formatDuration() : '—'}</strong></div><div><span>Режим</span><strong>${escapeHtml(routeModes.find((mode) => mode.id === (state.connection === 'connected' ? state.activeRouteMode : state.routeMode))?.title || '—')}</strong></div><div><span>Внешний IP</span><strong>${state.connection === 'connected' && !state.proxyCheckFailed ? escapeHtml(state.externalIp || '—') : '—'}</strong></div></div>
    ${state.connection === 'error' ? `<div class="error-box" role="alert">${escapeHtml(state.message)}</div>` : ''}
  </section></div>`;
}
function utilityMarkup() {
  if (state.activeNav === 'settings') return `<section class="utility-screen"><div class="utility-card"><span class="overline">ПАРАМЕТРЫ ПОДКЛЮЧЕНИЯ</span><h2>Настройки</h2><p class="utility-intro">Запросы приложений, использующих системный прокси, направляются согласно выбранному правилу.</p><div class="setting-row"><div><strong>Режим маршрутизации</strong><small>${escapeHtml(routeModes.find((mode) => mode.id === state.routeMode)?.description || '')}${state.connection === 'connected' ? ' Чтобы изменить режим, сначала отключитесь.' : ''}</small></div><select id="route-mode" aria-label="Режим маршрутизации" ${busy() || state.connection === 'connected' || state.cleanupNeeded ? 'disabled' : ''}>${routeModes.map((mode) => `<option value="${mode.id}" ${mode.id === state.routeMode ? 'selected' : ''}>${escapeHtml(mode.title)}</option>`).join('')}</select></div><div class="setting-row unavailable"><div><strong>Запуск вместе с Windows</strong><small>Эта возможность пока не реализована.</small></div><span>Недоступно</span></div><div class="setting-row unavailable"><div><strong>Автоматическое переподключение</strong><small>Эта возможность пока не реализована.</small></div><span>Недоступно</span></div><div class="setting-row unavailable"><div><strong>Настройка DNS</strong><small>Изменение DNS пока недоступно.</small></div><span>Недоступно</span></div></div></section>`;
  if (state.activeNav === 'stats') return `<section class="utility-screen"><div class="utility-card"><span class="overline">ДАННЫЕ ТЕКУЩЕЙ СЕССИИ</span><h2>Статистика</h2><div class="stat-grid"><div><span>Состояние</span><strong>${statusInfo()[0]}</strong></div><div><span>Время подключения</span><strong data-duration>${state.connection === 'connected' ? formatDuration() : '—'}</strong></div><div><span>Внешний IP через прокси</span><strong>${state.connection === 'connected' && !state.proxyCheckFailed ? escapeHtml(state.externalIp || '—') : '—'}</strong></div><div><span>Серверов</span><strong>${state.servers.length}</strong></div><div><span>Использовано по подписке</span><strong>${state.subscriptionMeta ? formatBytes(state.subscriptionMeta.used) : '—'}</strong></div><div><span>Лимит подписки</span><strong>${state.subscriptionMeta ? formatBytes(state.subscriptionMeta.total) : '—'}</strong></div></div><p class="utility-intro">Расход и лимит показываются только по данным поставщика подписки.</p></div></section>`;
  if (state.activeNav === 'about') return `<section class="utility-screen"><div class="utility-card"><span class="overline">KARTOSHKAVPN · 0.7.0</span><h2>О приложении</h2><p class="about-copy">KartoshkaVPN — клиент подписок на базе Xray. Приложение настраивает системный прокси Windows и проверяет соединение через него.</p><p class="about-copy">Это не TUN-подключение: программы, которые игнорируют системный прокси, могут выходить напрямую. Доступность функций зависит от Windows-версии.</p><p class="about-copy">Проверка обновлений приложения пока недоступна.</p></div></section>`;
  return `<section class="utility-screen"><div class="utility-card"><div class="utility-head"><div><span class="overline">ДИАГНОСТИКА</span><h2>Логи</h2></div><button class="primary-outline" data-action="refresh-logs">Обновить</button></div><pre class="log-view">${escapeHtml(state.logs.join('\n') || 'Событий пока нет')}</pre></div></section>`;
}
function modalMarkup() {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><div><span class="overline">ИМПОРТ КОНФИГУРАЦИИ</span><h2 id="modal-title">Добавить сервер</h2></div><button class="modal-close" data-action="close-modal" aria-label="Закрыть" ${state.importing ? 'disabled' : ''}>×</button></div><p>Вставьте ссылку подписки или одну или несколько ссылок серверов. Ручной импорт не заменит сохранённую подписку.</p><label class="visually-hidden" for="import-input">Ссылка подписки или конфигурация сервера</label><textarea id="import-input" data-focus-key="import-input" placeholder="https://.../sub/...&#10;vless://..." ${state.importing ? 'disabled' : ''}>${escapeHtml(state.pendingUrl)}</textarea><div class="modal-hint">Подписка загружается с указанного вами адреса.</div>${state.importError ? `<div class="modal-error" role="alert">${escapeHtml(state.importError)}</div>` : ''}<div class="modal-actions"><button class="ghost-button" data-action="close-modal" ${state.importing ? 'disabled' : ''}>Отмена</button><button class="primary-button" data-action="import" ${state.importing ? 'disabled' : ''}>${state.importing ? 'Загружаем…' : 'Импортировать'}</button></div></section></div>`;
}
function bindEvents() {
  document.querySelectorAll('[data-server]').forEach((button) => button.addEventListener('click', () => selectServer(button.dataset.server)));
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', async () => {
    state.activeNav = button.dataset.nav; render(); document.querySelector(`[data-focus-key="nav-${state.activeNav}"]`)?.focus();
    if (state.activeNav === 'logs') { await loadLogs(); if (state.activeNav === 'logs') render(); }
  }));
  document.querySelectorAll('[data-action="add"]').forEach((button) => button.addEventListener('click', () => { state.pendingUrl = ''; state.importError = ''; state.modal = 'add'; render(); }));
  document.querySelectorAll('[data-action="close-modal"]').forEach((button) => button.addEventListener('click', () => { if (!state.importing) { state.modal = null; state.importError = ''; render(); } }));
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
  document.querySelector('[data-action="proxy-ping"]')?.addEventListener('click', pingProxy);
  document.querySelector('[data-action="favorite"]')?.addEventListener('click', () => { const node = selectedNode(); if (node) { commitData({ servers: state.servers.map((item) => item.id === node.id ? { ...item, favorite: !item.favorite } : item) }); render(); } });
  document.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
    if (busy() || state.connection === 'connected' || state.cleanupNeeded) return;
    const servers = state.servers.filter((item) => item.id !== state.selectedId);
    commitData({ servers, selectedId: servers[0]?.id || null }); render();
  });
  document.querySelector('#route-mode')?.addEventListener('change', (event) => {
    if (busy() || state.connection === 'connected' || state.cleanupNeeded) return;
    if (routeModes.some((mode) => mode.id === event.target.value)) { commitData({ routeMode: event.target.value }); render(); }
  });
  document.querySelector('[data-action="refresh-logs"]')?.addEventListener('click', async () => { await loadLogs(); render(); });
  document.querySelector('.modal')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !state.importing) { state.modal = null; render(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...document.querySelectorAll('.modal button:not(:disabled), .modal textarea:not(:disabled)')];
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
  });
}

async function runImport(value, refresh) {
  if (state.importing) return;
  state.importing = true; state.importError = ''; state.notice = null; render();
  try {
    const result = await importConfig(value);
    state.modal = null;
    state.notice = { text: `Импортировано: ${result.count}; пропущено дубликатов: ${result.duplicates}.${result.unsupported ? ` Неподдерживаемых узлов сохранено: ${result.unsupported}.` : ''}${result.retained ? ` Сохранено старых узлов с настройками: ${result.retained}.` : ''}${state.connection === 'connected' ? ' Активное подключение не изменено.' : ''}` };
  } catch (error) {
    if (!refresh || state.modal) { state.modal = 'add'; state.importError = errorText(error); }
    else state.notice = { type: 'error', text: `Не удалось обновить подписку: ${errorText(error)}` };
  } finally { state.importing = false; render(); }
}
async function importConfig(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Вставьте ссылку или конфигурацию');
  const isSubscription = /^https?:\/\/\S+$/i.test(text) && !directScheme.test(text);
  let response;
  try { response = isSubscription ? await desktopBridge.fetchSubscription(text) : { body: text, userinfo: null }; }
  catch { throw new Error('Не удалось загрузить подписку. Проверьте подключение и адрес.'); }
  const parsed = parseSubscriptionDetailed(response.body ?? response);
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  const fatalErrors = errors.filter((error) => !/^Строка \d+: узел сохранён как неподдерживаемый:/.test(String(error)));
  // Updates are all-or-nothing even for parser warnings. A manual import can
  // retain complete but unsupported nodes; malformed lines are never partial.
  if ((isSubscription && errors.length) || fatalErrors.length) throw new Error(`Импорт отменён: ошибок в данных — ${errors.length}. Сохранённые серверы не изменены.`);
  if (!parsed.nodes?.length) throw new Error('Серверы не найдены. Сохранённые данные не изменены.');
  const nextMeta = isSubscription ? parseUserinfo(response.userinfo) : null;
  const source = isSubscription ? 'subscription' : 'manual';
  // The list may have changed while the request was in flight. Reconcile only after it finishes.
  const previous = state.servers;
  const oldSubscription = isSubscription ? previous.filter((node) => node.source === 'subscription' || node.source === 'subscription-retained') : [];
  const seen = new Set(isSubscription ? [] : previous.filter((node) => node.source === 'manual').map(nodeSignature));
  const incoming = [];
  let duplicates = 0;
  for (const node of parsed.nodes) {
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
  const patch = { servers, selectedId, ...(isSubscription ? { subscriptionUrl: text, subscriptionMeta: nextMeta } : {}) };
  if (!commitData(patch)) throw new Error('Не удалось сохранить данные. Импорт отменён.');
  return { count: imported.length, duplicates, unsupported: imported.filter((node) => node.unsupported).length, retained: retained.length };
}
async function pingOne(node) {
  if (!node || !capabilities.native || node.availability === 'testing') return;
  if (!tcpTestApplicable(node)) { state.notice = { text: 'TCP-тест неприменим к Hysteria2 (UDP). Можно проверить активный прокси.' }; render(); return; }
  const { host, port } = nodeEndpoint(node);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) { state.notice = { type: 'error', text: 'Адрес или порт сервера недоступны для TCP-проверки' }; render(); return; }
  node.ping = null; node.availability = 'testing'; render();
  try {
    const value = await desktopBridge.pingNode({ outbound: { server: host, server_port: port } });
    if (!state.servers.includes(node)) return;
    node.ping = Number.isFinite(value) && value >= 0 ? value : null;
    node.availability = node.ping === null ? 'offline' : 'online';
  } catch (error) {
    if (!state.servers.includes(node)) return;
    node.availability = 'unknown'; state.notice = { type: 'error', text: `TCP-проверка не выполнена: ${errorText(error)}` };
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
    if (state.proxyCheckFailed) state.notice = { type: 'error', code: 'proxy-check', text: 'Проверка через активный прокси не удалась; доступ не подтверждён.' };
    else if (state.notice?.code === 'proxy-check') state.notice = null;
  } catch (error) {
    if (session === sessionSequence && state.connection === 'connected') { state.proxyCheckFailed = true; state.notice = { type: 'error', code: 'proxy-check', text: 'Проверка через активный прокси не выполнена; доступ не подтверждён.' }; }
  } finally { if (session === sessionSequence) state.proxyTesting = false; render(); }
}
async function loadLogs() {
  try { const text = await desktopBridge.readLogs(); state.logs = text ? text.trim().split('\n').slice(-200) : []; }
  catch (error) { state.logs = [`Не удалось прочитать логи: ${errorText(error)}`]; }
}
function resetSession() { state.activeNode = null; state.activeRouteMode = null; state.connectedAt = null; state.externalIp = null; state.proxyPing = null; state.proxyTesting = false; state.proxyCheckFailed = false; if (state.notice?.code === 'proxy-check') state.notice = null; sessionSequence += 1; }
async function stopProxy() {
  const result = await desktopBridge.disconnect();
  if (result?.ok === false) throw new Error(result.error || 'Не удалось остановить прокси');
}
async function stopCurrent(message = 'Отключаем прокси…') {
  state.connection = 'disconnecting'; state.message = message; render();
  try {
    await stopProxy(); resetSession(); state.cleanupNeeded = false; return true;
  } catch (error) {
    resetSession(); state.cleanupNeeded = true; state.connection = 'error';
    state.message = `Не удалось восстановить системный прокси: ${errorText(error)}. Повторите отключение и проверьте настройки Windows.`; render(); return false;
  }
}
async function startSelected(node) {
  if (!node || unsupportedReason(node)) return;
  if (!capabilities.native || !state.bridgeReady || state.cleanupNeeded) {
    state.connection = 'error'; state.message = 'Подключение недоступно: мониторинг состояния Xray не работает.'; render(); return;
  }
  const snapshot = copyNode(node);
  const route = state.routeMode;
  const operation = ++operationSequence;
  const exitsAtStart = exitSequence;
  state.connection = 'connecting'; state.message = `Запускаем Xray: ${snapshot.name || 'сервер'}…`; state.cleanupNeeded = false; render();
  try {
    const config = buildXrayConfig([snapshot], snapshot.id, route);
    const result = await desktopBridge.connect({ config });
    if (result?.ok === false) throw new Error(result.error || 'Не удалось запустить прокси');
    if (operation !== operationSequence || exitSequence !== exitsAtStart) throw new Error('Xray завершился во время подключения');
    state.message = 'Проверяем доступ в интернет через прокси…'; render();
    const ip = await desktopBridge.probeInternet();
    if (operation !== operationSequence || exitSequence !== exitsAtStart) throw new Error('Xray завершился во время проверки подключения');
    if (!ip) throw new Error('Проверка внешнего IP не вернула результат');
    state.activeNode = snapshot; state.activeRouteMode = route; state.externalIp = ip; state.connectedAt = Date.now(); state.connection = 'connected'; state.message = 'Подключение установлено'; sessionSequence += 1; render();
  } catch (error) {
    // Even a failed launch may have changed system proxy settings; cleanup is mandatory.
    state.connection = 'disconnecting'; state.message = 'Восстанавливаем системный прокси…'; render();
    let cleanupError = '';
    try { await stopProxy(); } catch (cleanup) { cleanupError = errorText(cleanup); }
    resetSession(); state.cleanupNeeded = Boolean(cleanupError); state.connection = 'error';
    state.message = `${errorText(error)}${cleanupError ? `. Не удалось восстановить системный прокси: ${cleanupError}. Повторите отключение и проверьте настройки Windows.` : ''}`; render();
  }
}
async function toggleConnection() {
  if (busy()) return;
  if (state.cleanupNeeded || state.connection === 'connected') {
    if (await stopCurrent()) {
      if (capabilities.native && !state.bridgeReady) { state.connection = 'error'; state.message = `Прокси восстановлен, но мониторинг Xray недоступен${state.watchError ? `: ${state.watchError}` : ''}. Новое подключение запрещено.`; }
      else { state.connection = 'idle'; state.message = 'Подключение остановлено'; }
      render();
    }
    return;
  }
  const node = selectedNode();
  if (!node) return;
  const reason = unsupportedReason(node);
  if (reason) { state.notice = { type: 'error', text: reason }; render(); return; }
  if (!capabilities.native) { state.connection = 'error'; state.message = 'Запустите Windows-версию: в режиме предпросмотра подключение недоступно'; render(); return; }
  if (!state.bridgeReady) { state.connection = 'error'; state.message = 'Мониторинг состояния Xray недоступен; подключение запрещено.'; render(); return; }
  await startSelected(node);
}
async function selectServer(id) {
  if (busy() || state.cleanupNeeded) return;
  const node = state.servers.find((item) => item.id === id);
  if (!node) return;
  if (state.connection === 'connected' && !sameConfig(state.activeNode, node)) {
    if (unsupportedReason(node)) { if (commitData({ selectedId: id })) state.notice = { type: 'error', text: `${unsupportedReason(node)}. Текущее подключение сохранено.` }; render(); return; }
    const snapshot = copyNode(node);
    if (!(await stopCurrent('Отключаем текущий сервер перед переключением…'))) return;
    // A subscription refresh can finish while stopping. Connect the originally chosen snapshot,
    // and show it as active even if the refreshed list no longer contains it.
    const selectedId = state.servers.some((item) => item.id === id) ? id : state.selectedId;
    if (!commitData({ selectedId })) { state.connection = 'idle'; state.message = 'Подключение остановлено'; render(); return; }
    await startSelected(snapshot); return;
  }
  commitData({ selectedId: id }); render();
}
function handleProxyExit(message) {
  if (state.connection === 'disconnecting' || state.connection === 'idle' || state.connection === 'error') return;
  exitSequence += 1;
  if (state.connection === 'connecting') { state.message = 'Xray завершился во время подключения; восстанавливаем прокси…'; render(); return; }
  // Block new operations until a cleanup attempt has completed.
  void (async () => {
    const detail = typeof message === 'string' && message ? message : 'Xray неожиданно завершился';
    if (await stopCurrent('Восстанавливаем прокси после завершения Xray…')) { state.connection = 'error'; state.message = detail; render(); }
    else { state.message = `${detail}. ${state.message}`; render(); }
  })();
}
render();
void (async () => {
  let watchError = '';
  try { await desktopBridge.watchProxyExit(handleProxyExit); } catch (error) { watchError = errorText(error); }
  state.watchError = watchError;
  if (!capabilities.native) { state.bridgeReady = !watchError; if (watchError) { state.connection = 'error'; state.message = `Не удалось отслеживать состояние Xray: ${watchError}`; } render(); return; }
  // The bridge has no status query. On a frontend reload, stop any surviving session before
  // declaring it idle; a successful stop is the backend's restoration guarantee.
  let cleanupError = '';
  try { await stopProxy(); } catch (error) { cleanupError = errorText(error); }
  resetSession(); state.bridgeReady = !watchError; state.cleanupNeeded = Boolean(cleanupError);
  if (cleanupError) { state.connection = 'error'; state.message = `Не удалось восстановить системный прокси: ${cleanupError}. Повторите отключение и проверьте настройки Windows.`; }
  else if (watchError) { state.connection = 'error'; state.message = `Не удалось отслеживать состояние Xray: ${watchError}`; }
  else { state.connection = 'idle'; state.message = 'Выберите сервер и подключитесь'; }
  render();
})();
window.setInterval(() => { if (state.connection === 'connected') document.querySelectorAll('[data-duration]').forEach((item) => { item.textContent = formatDuration(); }); }, 1000);
