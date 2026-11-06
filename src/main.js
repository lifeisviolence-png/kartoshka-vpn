import './styles.css';
import { desktopBridge } from './desktop-bridge.js';
import { parseSubscriptionDetailed, parseUserinfo } from './subscription.js';
import { buildSingBoxConfig } from './singbox-config.js';

const routeModes = [
  { id: 'split', title: 'Россия напрямую', subtitle: 'Зарубежные сайты через прокси' },
  { id: 'all', title: 'Весь трафик через прокси', subtitle: 'Весь трафик через выбранный сервер' },
  { id: 'manual', title: 'Ручной режим', subtitle: 'Пользовательские правила маршрутизации' }
];
const directScheme = /^(vless|vmess|trojan|ss|hysteria2):\/\//i;
const capabilities = desktopBridge.getCapabilities();

const state = {
  servers: loadJson('kartoshka.nodes', []),
  selectedId: localStorage.getItem('kartoshka.selectedId') || null,
  subscriptionUrl: localStorage.getItem('kartoshka.subscriptionUrl') || '',
  pendingUrl: localStorage.getItem('kartoshka.subscriptionUrl') || '',
  subscriptionMeta: loadJson('kartoshka.subscriptionMeta', null),
  connection: 'idle',
  connectedAt: null,
  routeMode: localStorage.getItem('kartoshka.routeMode') || 'split',
  externalIp: null,
  activeNav: 'servers',
  logs: [],
  settings: loadJson('kartoshka.settings', { launchOnStart: false, autoReconnect: true, dnsMode: 'system' }),
  modal: null,
  search: '',
  message: capabilities.native ? 'Готово к подключению' : 'Предпросмотр без подключения'
};
if (!state.selectedId || !state.servers.some((node) => node.id === state.selectedId)) state.selectedId = state.servers[0]?.id || null;

const app = document.querySelector('#app');
let clockTimer;

function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; } }
function saveData() { localStorage.setItem('kartoshka.nodes', JSON.stringify(state.servers)); localStorage.setItem('kartoshka.selectedId', state.selectedId || ''); }
function selectedNode() { return state.servers.find((node) => node.id === state.selectedId) || null; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function formatBytes(bytes) { if (!bytes) return '—'; const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let value = bytes; let index = 0; while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; } return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`; }
function formatExpiry(date) { if (!date) return 'Срок не передан'; const value = new Date(date); if (Number.isNaN(value.getTime())) return 'Срок не передан'; return `до ${value.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })}`; }
function formatDuration() { if (!state.connectedAt) return '00:00:00'; const seconds = Math.floor((Date.now() - state.connectedAt) / 1000); return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':'); }
function statusInfo() {
  return {
    idle: ['Не подключено', state.message, 'idle'],
    connecting: ['Подключение…', 'Проверяем соединение', 'connecting'],
    connected: ['Подключено', 'Соединение через выбранный сервер активно', 'connected'],
    error: ['Ошибка', state.message, 'error']
  }[state.connection];
}
function visibleNodes() { const query = state.search.trim().toLowerCase(); return query ? state.servers.filter((node) => `${node.name} ${node.country} ${node.city} ${node.protocol}`.toLowerCase().includes(query)) : state.servers; }
function nodeFingerprint(node) { return `${node.protocol}|${node.outbound?.server || ''}|${node.outbound?.server_port || ''}|${node.name}`.toLowerCase(); }
function utilityMarkup() {
  if (state.activeNav === 'settings') return `<section class="utility-screen"><div class="utility-card"><span class="overline">ПОВЕДЕНИЕ ПРИ ЗАПУСКЕ</span><h2>Настройки</h2><label class="setting-row"><span><strong>Запускать вместе с Windows</strong><small>Приложение останется доступно в области уведомлений</small></span><input type="checkbox" data-setting="launchOnStart" ${state.settings.launchOnStart ? 'checked' : ''}></label><label class="setting-row"><span><strong>Переподключаться при сбое</strong><small>Повторить подключение к выбранному серверу</small></span><input type="checkbox" data-setting="autoReconnect" ${state.settings.autoReconnect ? 'checked' : ''}></label><label class="setting-row"><span><strong>DNS</strong><small>Использовать DNS текущего подключения</small></span><select data-setting="dnsMode"><option value="system" ${state.settings.dnsMode === 'system' ? 'selected' : ''}>Системный</option><option value="remote" ${state.settings.dnsMode === 'remote' ? 'selected' : ''}>Через подключение</option></select></label></div></section>`;
  if (state.activeNav === 'stats') return `<section class="utility-screen"><div class="utility-card"><span class="overline">СЕССИЯ</span><h2>Статистика</h2><div class="stat-grid"><div><span>Состояние</span><strong>${statusInfo()[0]}</strong></div><div><span>Время подключения</span><strong>${state.connection === 'connected' ? formatDuration() : '—'}</strong></div><div><span>Внешний IP</span><strong>${state.externalIp || '—'}</strong></div><div><span>Серверов</span><strong>${state.servers.length}</strong></div><div><span>Загружено</span><strong>${formatBytes(state.subscriptionMeta?.used || 0)}</strong></div><div><span>Лимит</span><strong>${formatBytes(state.subscriptionMeta?.total || 0)}</strong></div></div></div></section>`;
  return `<section class="utility-screen"><div class="utility-card"><div class="utility-head"><div><span class="overline">ДИАГНОСТИКА</span><h2>Логи</h2></div><button class="primary-outline" data-action="refresh-logs">Обновить</button></div><pre class="log-view">${escapeHtml(state.logs.join('\n') || 'Событий пока нет')}</pre></div></section>`;
}

function render() {
  const node = selectedNode();
  const [statusLabel, statusMessage, statusClass] = statusInfo();
  const meta = state.subscriptionMeta;
  const usage = meta?.total ? Math.min(100, (meta.used / meta.total) * 100) : 0;
  const nodes = visibleNodes();
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><img src="/potato-mark.svg" alt=""/><div><strong>Kartoshka<span>VPN</span></strong><small>PRIVATE NETWORK</small></div></div>
        <nav class="side-nav">
          <button class="side-item ${state.activeNav === 'add' ? 'active' : ''}" data-nav="add"><span class="side-icon">＋</span>Добавить</button>
          <button class="side-item ${state.activeNav === 'servers' ? 'active' : ''}" data-nav="servers"><span class="side-icon">◉</span>Серверы</button>
          <button class="side-item ${state.activeNav === 'settings' ? 'active' : ''}" data-nav="settings"><span class="side-icon">⚙</span>Настройки</button>
          <button class="side-item ${state.activeNav === 'stats' ? 'active' : ''}" data-nav="stats"><span class="side-icon">▥</span>Статистика</button>
          <button class="side-item ${state.activeNav === 'logs' ? 'active' : ''}" data-nav="logs"><span class="side-icon">▤</span>Логи</button>
        </nav>
        <div class="sidebar-bottom"><div class="secure-dot"></div><span>${capabilities.native ? 'Готово к подключению' : 'Предпросмотр'}</span><button class="about-button">ⓘ О программе</button></div>
      </aside>
      <main class="main-area">
        <header class="topbar"><div><div class="overline">KARTOSHKAVPN PC</div><h1>${state.activeNav === 'servers' ? 'Серверы' : state.activeNav === 'add' ? 'Добавить сервер' : state.activeNav === 'stats' ? 'Статистика' : state.activeNav === 'logs' ? 'Логи' : 'Настройки'}</h1></div><div class="topbar-right"><span class="mode-pill"><i></i>DESKTOP</span><button class="round-button" title="Обновить подписку" data-action="refresh">↻</button></div></header>
        ${['settings', 'stats', 'logs'].includes(state.activeNav) ? utilityMarkup() : `<div class="workspace">
          <section class="server-column">
            <div class="server-toolbar"><label class="search-box"><span>⌕</span><input id="server-search" value="${escapeHtml(state.search)}" placeholder="Введите текст для поиска"/></label><button class="toolbar-button" data-action="refresh" title="Обновить">↻</button><button class="toolbar-button" data-action="add" title="Добавить">•••</button></div>
            <section class="subscription-panel ${state.subscriptionUrl ? 'loaded' : ''}">
              <div class="subscription-header"><div><strong>${state.subscriptionUrl ? 'KartoshkaVPN' : 'Подписка не добавлена'}</strong><small>${state.subscriptionUrl ? `Обновлено: ${formatExpiry(meta?.expiresAt)}` : 'Вставьте ссылку 3x-ui или конфигурацию сервера'}</small></div><button class="mini-action" data-action="add">${state.subscriptionUrl ? 'Изменить' : 'Добавить'}</button></div>
              ${state.subscriptionUrl ? `<div class="usage-line"><span>${formatBytes(meta?.used || 0)} / ${formatBytes(meta?.total || 0)}</span><span>${meta?.expiresAt ? formatExpiry(meta.expiresAt) : 'срок не передан'}</span></div><div class="usage-track"><i style="width:${usage}%"></i></div>` : '<div class="subscription-empty">Сервера появятся здесь только после успешного импорта подписки.</div>'}
            </section>
            <div class="list-heading"><span>${state.servers.length ? `${state.servers.length} серверов` : 'Нет серверов'}</span><span>${state.servers.length ? 'Пинг · доступность' : 'Добавьте первую конфигурацию'}</span></div>
            <div class="server-list">${nodes.length ? nodes.map((item) => serverCard(item)).join('') : `<div class="list-empty"><div class="empty-orb">＋</div><strong>${state.servers.length ? 'Ничего не найдено' : 'Список серверов пуст'}</strong><span>${state.servers.length ? 'Попробуйте изменить поиск' : 'Нажмите «Добавить» и вставьте ссылку'}</span></div>`}</div>
          </section>
          <section class="control-column">
            <div class="control-top"><span class="proxy-select">Подключение</span><span class="connection-badge ${statusClass}"><i></i>${statusLabel}</span></div>
            <div class="power-stage ${statusClass}"><div class="power-glow"></div><button class="power-control" data-action="toggle" ${(state.connection === 'connecting' || !node) ? 'disabled' : ''}><span>⏻</span></button><div class="power-caption">${node ? (state.connection === 'connected' ? 'Отключиться' : 'Подключиться') : 'Добавьте сервер'}</div></div>
            <div class="selected-panel">${node ? `<div class="selected-flag">${node.flag}</div><div class="selected-copy"><strong>${escapeHtml(node.name)}</strong><span>${escapeHtml(node.country)} · ${escapeHtml(node.city)} · ${node.protocol}</span></div><div class="selected-ping ${node.availability === 'offline' ? 'bad' : ''}"><b>${node.ping == null ? '—' : `${node.ping} ms`}</b><small>TCP · proxy ${node.proxyPing == null ? '—' : `${node.proxyPing} ms`}</small></div>` : '<div class="no-selection"><strong>Сервер не выбран</strong><span>Импортируйте подписку, чтобы подключиться</span></div>'}</div>
            <div class="detail-actions">${node ? `<button class="primary-outline" data-action="ping">${node.ping == null ? 'Проверить ping' : 'Проверить ещё раз'}</button><button class="ghost-button" data-action="remove">Удалить</button>` : ''}</div>
            <div class="connection-info"><div><span>Состояние</span><strong>${statusMessage}</strong></div><div><span>Время подключения</span><strong>${state.connection === 'connected' ? formatDuration() : '—'}</strong></div><div><span>Режим</span><strong>${routeModes.find((mode) => mode.id === state.routeMode)?.title}</strong></div>${state.externalIp ? `<div><span>Внешний IP</span><strong>${escapeHtml(state.externalIp)}</strong></div>` : ''}</div>
            ${state.message && state.connection === 'error' ? `<div class="error-box">${escapeHtml(state.message)}</div>` : ''}
          </section>
        </div>`}
    <footer class="bottom-note"><span>● ${capabilities.native ? 'Подключение готово' : 'Предпросмотр'}</span></footer>
      </main>
    </div>
    ${state.modal === 'add' ? modalMarkup() : ''}
  `;
  bindEvents();
}

function serverCard(node) {
  return `<button class="server-card ${node.id === state.selectedId ? 'selected' : ''}" data-server="${escapeHtml(node.id)}"><span class="server-flag">${node.flag}</span><span class="server-card-copy"><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(node.protocol)} / ${escapeHtml(node.country)} · ${escapeHtml(node.city)}</small></span><span class="server-card-ping ${node.availability === 'offline' ? 'bad' : ''}"><i></i>${node.ping == null ? '—' : `${node.ping}ms`}</span><span class="server-chevron">›</span></button>`;
}

function modalMarkup() {
  return `<div class="modal-backdrop"><section class="modal"><div class="modal-head"><div><span class="overline">ИМПОРТ КОНФИГУРАЦИИ</span><h2>Добавить сервер</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p>Вставьте subscription URL 3x-ui, одну ссылку VLESS/VMess/Trojan/SS/Hysteria2 или несколько ссылок построчно.</p><textarea id="import-input" autofocus placeholder="https://.../sub/...\nvless://...">${escapeHtml(state.pendingUrl)}</textarea><div class="modal-hint">Ссылка обрабатывается локально. Приватные данные не отправляются нам.</div>${state.connection === 'error' ? `<div class="modal-error">${escapeHtml(state.message)}</div>` : ''}<div class="modal-actions"><button class="ghost-button" data-action="close-modal">Отмена</button><button class="primary-button" data-action="import">Импортировать</button></div></section></div>`;
}

function bindEvents() {
  document.querySelectorAll('[data-server]').forEach((button) => button.addEventListener('click', () => { state.selectedId = button.dataset.server; saveData(); render(); }));
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', async () => { state.activeNav = button.dataset.nav; if (button.dataset.nav === 'add') state.modal = 'add'; if (button.dataset.nav === 'logs') await loadLogs(); render(); }));
  document.querySelectorAll('[data-action="add"]').forEach((button) => button.addEventListener('click', () => { state.activeNav = 'add'; state.modal = 'add'; state.pendingUrl = state.subscriptionUrl; render(); }));
  document.querySelectorAll('[data-action="close-modal"]').forEach((button) => button.addEventListener('click', () => { state.modal = null; state.connection = state.connection === 'error' ? 'idle' : state.connection; render(); }));
  document.querySelector('#server-search')?.addEventListener('input', (event) => { state.search = event.target.value; render(); const input = document.querySelector('#server-search'); input?.focus(); input?.setSelectionRange(state.search.length, state.search.length); });
  document.querySelector('[data-action="import"]')?.addEventListener('click', async () => { const value = document.querySelector('#import-input')?.value || ''; state.pendingUrl = value; state.message = 'Загружаем конфигурацию…'; state.connection = 'connecting'; render(); try { await importConfig(value); state.modal = null; state.connection = 'idle'; state.message = `${state.servers.length} серверов загружено`; render(); refreshPings(); } catch (error) { state.connection = 'error'; state.message = error.message || 'Не удалось импортировать конфигурацию'; state.modal = 'add'; render(); } });
  document.querySelectorAll('[data-action="refresh"]').forEach((button) => button.addEventListener('click', () => { if (state.subscriptionUrl) { state.pendingUrl = state.subscriptionUrl; state.modal = 'add'; render(); document.querySelector('[data-action="import"]')?.click(); } else { state.modal = 'add'; render(); } }));
  document.querySelector('[data-action="toggle"]')?.addEventListener('click', toggleConnection);
  document.querySelector('[data-action="ping"]')?.addEventListener('click', async () => { const node = selectedNode(); if (!node) return; node.ping = null; node.availability = 'testing'; render(); await pingOne(node); render(); });
  document.querySelector('[data-action="remove"]')?.addEventListener('click', () => { state.servers = state.servers.filter((item) => item.id !== state.selectedId); state.selectedId = state.servers[0]?.id || null; saveData(); render(); });
  document.querySelectorAll('[data-setting]').forEach((input) => input.addEventListener('change', () => { state.settings[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value; localStorage.setItem('kartoshka.settings', JSON.stringify(state.settings)); }));
  document.querySelector('[data-action="refresh-logs"]')?.addEventListener('click', async () => { await loadLogs(); render(); });
}

async function importConfig(value) {
  const text = value.trim();
  if (!text) throw new Error('Вставьте ссылку или конфигурацию');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const response = lines.length > 1 && lines.every((line) => directScheme.test(line)) ? { body: lines.join('\n'), userinfo: null } : await desktopBridge.fetchSubscription(text);
  const parsed = parseSubscriptionDetailed(response.body ?? response);
  if (!parsed.nodes.length) throw new Error(`Не найдено поддерживаемых узлов. ${parsed.errors.join(' ')}`);
  const previousByFingerprint = new Map(state.servers.map((node) => [nodeFingerprint(node), node]));
  const imported = parsed.nodes.map((node) => { const previous = previousByFingerprint.get(nodeFingerprint(node)); return { ...node, favorite: previous?.favorite || false, customName: previous?.customName || '', source: 'subscription' }; });
  const manual = state.servers.filter((node) => node.source !== 'subscription');
  state.servers = [...manual, ...imported];
  state.selectedId = imported[0]?.id || manual[0]?.id || null;
  state.subscriptionUrl = text;
  state.subscriptionMeta = parseUserinfo(response.userinfo);
  localStorage.setItem('kartoshka.subscriptionUrl', text);
  localStorage.setItem('kartoshka.subscriptionMeta', JSON.stringify(state.subscriptionMeta));
  saveData();
  if (parsed.errors.length) state.message = `${imported.length} серверов загружено; пропущено строк: ${parsed.errors.length}`;
}

async function refreshPings() { await Promise.all(state.servers.map((node) => pingOne(node))); saveData(); render(); }
async function pingOne(node) { const value = await desktopBridge.pingNode(node); node.ping = value; node.proxyPing = state.connection === 'connected' ? await desktopBridge.proxyLatency() : null; node.availability = value == null ? (capabilities.native ? 'offline' : 'unknown') : 'online'; }
async function loadLogs() { try { const text = await desktopBridge.readLogs(); state.logs = text ? text.trim().split('\n').slice(-200) : []; } catch { state.logs = ['Логи доступны только в Windows-версии.']; } }

async function toggleConnection() {
  const node = selectedNode();
  if (!node) return;
  if (state.connection === 'connected') { await desktopBridge.disconnect(); state.connection = 'idle'; state.connectedAt = null; state.externalIp = null; state.message = 'Подключение остановлено'; render(); return; }
  if (!capabilities.native) { state.connection = 'error'; state.message = 'Запустите Windows-версию: Preview не может изменить системный прокси'; render(); return; }
  state.connection = 'connecting'; state.message = 'Запускаем sing-box…'; render();
  try { await desktopBridge.connect({ config: buildSingBoxConfig(state.servers, state.selectedId, state.routeMode) }); state.message = 'Проверяем соединение…'; render(); state.externalIp = await desktopBridge.probeInternet(); state.connection = 'connected'; state.connectedAt = Date.now(); state.message = 'Интернет через выбранный сервер работает'; render(); }
  catch (error) { try { await desktopBridge.disconnect(); } catch { /* ядро уже могло завершиться */ } state.connection = 'error'; state.connectedAt = null; state.externalIp = null; state.message = error.message || 'VPN не прошёл проверку'; render(); }
}

render();
desktopBridge.watchProxyExit((message) => { state.connection = 'error'; state.connectedAt = null; state.externalIp = null; state.message = message || 'Подключение неожиданно завершилось'; render(); });
clockTimer = window.setInterval(() => { if (state.connection === 'connected') render(); }, 1000);
