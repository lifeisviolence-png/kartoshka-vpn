import './styles.css';
import { desktopBridge } from './desktop-bridge.js';
import { parseSubscription } from './subscription.js';
import { buildSingBoxConfig } from './singbox-config.js';

const servers = [];

const routeModes = [
  { id: 'split', title: 'Россия напрямую', subtitle: 'Зарубежные сайты через прокси' },
  { id: 'all', title: 'Весь трафик через прокси', subtitle: 'Максимальное покрытие приложений' },
  { id: 'manual', title: 'Ручной режим', subtitle: 'Выбор правил вручную' }
];

const capabilities = desktopBridge.getCapabilities();
const state = {
  connection: 'idle',
  selectedServer: null,
  routeMode: routeModes[0].id,
  lastUpdated: 'только что',
  subscriptionUrl: localStorage.getItem('kartoshka.subscriptionUrl') || '',
  subscriptionMessage: 'Сначала загрузите ссылку подписки 3x-ui',
  native: capabilities.native
};

const app = document.querySelector('#app');

function selectedServer() {
  return servers.find((server) => server.id === state.selectedServer) ?? null;
}

function statusCopy() {
  const nativeHint = state.native ? 'Системный прокси управляется sing-box' : 'Демо-режим браузера: системный прокси не меняется';
  return {
    idle: { label: 'Не подключено', hint: state.subscriptionMessage, className: 'is-idle' },
    connecting: { label: 'Подключение', hint: 'Запускаем sing-box и системный прокси…', className: 'is-connecting' },
    connected: { label: 'Подключено', hint: nativeHint, className: 'is-connected' },
    error: { label: 'Ошибка', hint: state.subscriptionMessage || 'Не удалось запустить sing-box', className: 'is-error' }
  }[state.connection];
}

function render() {
  const server = selectedServer();
  const status = statusCopy();
  const isBusy = state.connection === 'connecting';
  const isConnected = state.connection === 'connected';
  const hasServers = servers.length > 0;
  const buttonLabel = isBusy ? 'Подключаем…' : isConnected ? 'Отключиться' : 'Подключиться';

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand-lockup">
          <img src="/potato-mark.svg" alt="" class="brand-mark" />
          <div><div class="brand-name">КартошкаVPN</div><div class="brand-caption">quiet internet</div></div>
        </div>
        <nav class="nav-list" aria-label="Навигация">
          <button class="nav-item is-active" type="button"><span class="nav-icon">◎</span>Подключение</button>
          <button class="nav-item" type="button" data-scroll="routing"><span class="nav-icon">⌘</span>Маршрутизация</button>
          <button class="nav-item" type="button" data-scroll="subscription"><span class="nav-icon">◌</span>Подписка</button>
        </nav>
        <div class="sidebar-bottom">
          <div class="bridge-note"><span class="tiny-dot"></span><div><strong>${state.native ? 'sing-box sidecar' : 'Desktop build'}</strong><span>${state.native ? 'системный прокси готов' : 'нативная сборка готовится'}</span></div></div>
          <div class="version-line">v0.2 · ${state.native ? 'desktop' : 'preview'}</div>
        </div>
      </aside>

      <main class="content">
        <header class="topbar">
          <div><span class="eyebrow">Личный клиент</span><h1>Подключение</h1></div>
          <div class="topbar-actions"><span class="prototype-pill"><span class="pill-dot"></span>${state.native ? 'desktop' : 'preview'}</span><button class="icon-button" type="button" aria-label="Настройки">⌁</button></div>
        </header>

        <section class="surface-card subscription-card subscription-banner" id="subscription">
          <div class="subscription-top"><span class="eyebrow">Подписка 3x-ui</span><span class="subscription-badge">${hasServers ? 'подключена' : 'не подключена'}</span></div>
          <div class="expiry-date">— <span>дата не загружена</span></div>
          <div class="expiry-caption">Дата окончания появится после чтения данных подписки</div>
          <div class="progress-track"><span></span></div>
          <div class="subscription-bottom"><span>Осталось 85 дней</span><button type="button" data-action="refresh">Обновить сервера</button></div>
          <div class="subscription-input-row"><input id="subscription-url" type="url" value="${escapeHtml(state.subscriptionUrl)}" placeholder="Вставьте ссылку подписки 3x-ui" autocomplete="off"/><button class="load-button" type="button" data-action="load-subscription">Загрузить</button></div>
          <div class="subscription-helper">Поддерживаются vless, vmess, trojan и shadowsocks. Ссылка хранится только локально.</div>
        </section>

        <section class="dashboard-grid">
          <div class="primary-column">
            <section class="connection-card ${status.className}" aria-live="polite">
              <div class="card-kicker"><span class="status-orb"></span> Состояние соединения</div>
              <div class="connection-main"><div><div class="status-label">${status.label}</div><div class="status-hint">${status.hint}</div></div><button class="power-button" type="button" data-action="toggle" ${(isBusy || !hasServers) ? 'disabled' : ''}><span class="power-ring"><span class="power-glyph">⏻</span></span><span>${hasServers ? buttonLabel : 'Загрузите подписку'}</span></button></div>
              <div class="connection-meta"><div class="selected-server-line"><span class="server-flag">${server?.flag || '·'}</span><div><span class="meta-label">Сервер</span><strong>${server ? escapeHtml(server.name) : 'Нет выбранного сервера'}</strong></div></div><div class="latency-line"><span class="meta-label">Задержка</span><strong>${server?.ping === '—' ? '—' : server ? `${server.ping} ms` : '—'}</strong></div></div>
            </section>
            <section class="surface-card" id="routing"><div class="section-heading"><div><span class="eyebrow">Логика трафика</span><h2>Маршрутизация</h2></div><span class="section-count">${routeModes.length} режима</span></div><div class="route-options">${routeModes.map((mode, index) => `<button class="route-option ${state.routeMode === mode.id ? 'is-selected' : ''}" type="button" data-route="${mode.id}"><span class="route-radio"><span></span></span><span class="route-copy"><strong>${mode.title}</strong><small>${mode.subtitle}</small></span>${index === 0 ? '<span class="recommended">рекомендуем</span>' : ''}</button>`).join('')}</div></section>
          </div>

          <div class="secondary-column">
            <section class="surface-card servers-card"><div class="section-heading"><div><span class="eyebrow">3x-ui subscription</span><h2>Серверы</h2></div><button class="refresh-button" type="button" data-action="refresh" aria-label="Обновить серверы" ${state.subscriptionUrl ? '' : 'disabled'}>↻</button></div><div class="server-list">${hasServers ? servers.map((item) => `<button class="server-row ${item.id === state.selectedServer ? 'is-selected' : ''}" type="button" data-server="${item.id}"><span class="server-avatar ${item.accent}">${item.flag}</span><span class="server-details"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.country)} · ${escapeHtml(item.city)}</small></span><span class="server-ping"><i></i>${item.ping === '—' ? '—' : `${item.ping} ms`}</span><span class="server-check">${item.id === state.selectedServer ? '✓' : ''}</span></button>`).join('') : '<div class="empty-state"><strong>Серверов пока нет</strong><span>Вставьте ссылку подписки 3x-ui выше и нажмите «Загрузить».</span></div>'}</div><div class="server-footer"><span>${hasServers ? `Обновлено ${state.lastUpdated}` : 'Ожидается подписка'}</span>${hasServers ? '<span class="healthy"><i></i>серверы загружены</span>' : '<span>список пуст</span>'}</div></section>
          </div>
        </section>

        <footer class="disclaimer"><span class="info-icon">i</span><span>${state.native ? 'Системный прокси Windows/macOS запускается через sing-box. TUN не включён намеренно.' : 'Это Preview интерфейса. Для системного прокси запустите desktop-сборку из GitHub Actions.'}</span><span class="capability-state">${state.native ? 'proxy ready' : 'preview only'}</span></footer>
      </main>
    </div>
  `;
  bindEvents();
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }

async function loadSubscription(inputValue) {
  const url = (inputValue ?? document.querySelector('#subscription-url')?.value ?? '').trim();
  if (!url) throw new Error('Вставьте ссылку подписки 3x-ui');
  if (!/^(https?:\/\/|vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\/)/i.test(url)) {
    throw new Error('Нужна http(s)-ссылка подписки или прямая vless/vmess/trojan/ss-ссылка');
  }
  const raw = await desktopBridge.fetchSubscription(url);
  const imported = parseSubscription(raw);
  if (!imported.length) throw new Error('Ссылка открылась, но поддерживаемые узлы vless/vmess/trojan/ss не найдены');
  servers.splice(0, servers.length, ...imported);
  state.selectedServer = servers[0].id;
  state.subscriptionUrl = url;
  localStorage.setItem('kartoshka.subscriptionUrl', url);
  state.lastUpdated = 'только что';
  state.subscriptionMessage = `Загружено серверов: ${servers.length}`;
}

function bindEvents() {
  document.querySelectorAll('[data-server]').forEach((button) => button.addEventListener('click', () => { if (state.connection === 'connected') state.connection = 'idle'; state.selectedServer = button.dataset.server; render(); }));
  document.querySelectorAll('[data-route]').forEach((button) => button.addEventListener('click', () => { state.routeMode = button.dataset.route; render(); }));
  document.querySelector('[data-action="toggle"]')?.addEventListener('click', async () => {
    if (!servers.length) { state.connection = 'error'; state.subscriptionMessage = 'Сначала загрузите подписку и выберите сервер'; render(); return; }
    if (state.connection === 'connected') { await desktopBridge.disconnect(); state.connection = 'idle'; state.subscriptionMessage = 'Прокси остановлен'; render(); return; }
    state.connection = 'connecting'; render();
    try {
      const config = buildSingBoxConfig(servers, state.selectedServer, state.routeMode);
      const result = await desktopBridge.connect({ config });
      state.connection = result.ok ? 'connected' : 'error';
      state.subscriptionMessage = result.demo ? 'Preview: кнопка работает без системного прокси' : 'Системный прокси работает через sing-box';
    } catch (error) { state.connection = 'error'; state.subscriptionMessage = error.message || 'Не удалось запустить sing-box'; }
    render();
  });
  document.querySelector('[data-action="load-subscription"]')?.addEventListener('click', async (event) => {
    const inputValue = document.querySelector('#subscription-url')?.value ?? '';
    event.currentTarget.disabled = true;
    state.subscriptionMessage = 'Загружаем подписку…'; render();
    try { await loadSubscription(inputValue); state.connection = 'idle'; }
    catch (error) { state.connection = 'error'; state.subscriptionMessage = error.message || 'Не удалось загрузить подписку'; }
    render();
  });
  document.querySelectorAll('[data-action="refresh"]').forEach((button) => button.addEventListener('click', async () => {
    button.classList.add('is-spinning');
    if (state.subscriptionUrl) { try { await loadSubscription(); } catch (error) { state.subscriptionMessage = error.message; } }
    else { state.subscriptionMessage = 'Сначала загрузите ссылку подписки 3x-ui'; }
    state.lastUpdated = 'только что'; render();
  }));
  document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'center' })));
}

render();
