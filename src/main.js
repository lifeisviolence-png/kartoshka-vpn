import './styles.css';
import { desktopBridge } from './desktop-bridge.js';
import { parseSubscription } from './subscription.js';
import { buildSingBoxConfig } from './singbox-config.js';

const servers = [
  { id: 'de-fra', name: 'DE-Frankfurt-01', flag: '🇩🇪', country: 'Германия', city: 'Frankfurt', ping: 82, accent: 'amber', outbound: { type: 'direct', server: 'demo' } },
  { id: 'nl-ams', name: 'NL-Amsterdam-01', flag: '🇳🇱', country: 'Нидерланды', city: 'Amsterdam', ping: 96, accent: 'violet', outbound: { type: 'direct', server: 'demo' } },
  { id: 'fi-hel', name: 'FI-Helsinki-01', flag: '🇫🇮', country: 'Финляндия', city: 'Helsinki', ping: 71, accent: 'blue', outbound: { type: 'direct', server: 'demo' } }
];

const routeModes = [
  { id: 'split', title: 'Россия напрямую', subtitle: 'Зарубежные сайты через прокси' },
  { id: 'all', title: 'Весь трафик через прокси', subtitle: 'Максимальное покрытие приложений' },
  { id: 'manual', title: 'Ручной режим', subtitle: 'Выбор правил вручную' }
];

const capabilities = desktopBridge.getCapabilities();
const state = {
  connection: 'idle',
  selectedServer: servers[0].id,
  routeMode: routeModes[0].id,
  lastUpdated: 'только что',
  subscriptionUrl: localStorage.getItem('kartoshka.subscriptionUrl') || '',
  subscriptionMessage: capabilities.native ? 'sing-box готов к запуску' : 'Preview-режим: без системного прокси',
  native: capabilities.native
};

const app = document.querySelector('#app');

function selectedServer() {
  return servers.find((server) => server.id === state.selectedServer) ?? servers[0];
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
          <div class="subscription-top"><span class="eyebrow">Подписка 3x-ui</span><span class="subscription-badge">${state.subscriptionUrl ? 'подключена' : 'демо'}</span></div>
          <div class="expiry-date">30 <span>января</span> 2027</div>
          <div class="expiry-caption">Дата окончания подписки${state.subscriptionUrl ? ' · данные из интерфейса' : ' · демонстрационные данные'}</div>
          <div class="progress-track"><span></span></div>
          <div class="subscription-bottom"><span>Осталось 85 дней</span><button type="button" data-action="refresh">Обновить сервера</button></div>
          <div class="subscription-input-row"><input id="subscription-url" type="url" value="${escapeHtml(state.subscriptionUrl)}" placeholder="Вставьте ссылку подписки 3x-ui" autocomplete="off"/><button class="load-button" type="button" data-action="load-subscription">Загрузить</button></div>
          <div class="subscription-helper">Поддерживаются vless, vmess, trojan и shadowsocks. Ссылка хранится только локально.</div>
        </section>

        <section class="dashboard-grid">
          <div class="primary-column">
            <section class="connection-card ${status.className}" aria-live="polite">
              <div class="card-kicker"><span class="status-orb"></span> Состояние соединения</div>
              <div class="connection-main"><div><div class="status-label">${status.label}</div><div class="status-hint">${status.hint}</div></div><button class="power-button" type="button" data-action="toggle" ${isBusy ? 'disabled' : ''}><span class="power-ring"><span class="power-glyph">⏻</span></span><span>${buttonLabel}</span></button></div>
              <div class="connection-meta"><div class="selected-server-line"><span class="server-flag">${server.flag}</span><div><span class="meta-label">Сервер</span><strong>${server.name}</strong></div></div><div class="latency-line"><span class="meta-label">Задержка</span><strong>${server.ping} ms</strong></div></div>
            </section>
            <section class="surface-card" id="routing"><div class="section-heading"><div><span class="eyebrow">Логика трафика</span><h2>Маршрутизация</h2></div><span class="section-count">${routeModes.length} режима</span></div><div class="route-options">${routeModes.map((mode, index) => `<button class="route-option ${state.routeMode === mode.id ? 'is-selected' : ''}" type="button" data-route="${mode.id}"><span class="route-radio"><span></span></span><span class="route-copy"><strong>${mode.title}</strong><small>${mode.subtitle}</small></span>${index === 0 ? '<span class="recommended">рекомендуем</span>' : ''}</button>`).join('')}</div></section>
          </div>

          <div class="secondary-column">
            <section class="surface-card servers-card"><div class="section-heading"><div><span class="eyebrow">3x-ui subscription</span><h2>Серверы</h2></div><button class="refresh-button" type="button" data-action="refresh" aria-label="Обновить серверы">↻</button></div><div class="server-list">${servers.map((item) => `<button class="server-row ${item.id === state.selectedServer ? 'is-selected' : ''}" type="button" data-server="${item.id}"><span class="server-avatar ${item.accent}">${item.flag}</span><span class="server-details"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.country)} · ${escapeHtml(item.city)}</small></span><span class="server-ping"><i></i>${item.ping} ms</span><span class="server-check">${item.id === state.selectedServer ? '✓' : ''}</span></button>`).join('')}</div><div class="server-footer"><span>Обновлено ${state.lastUpdated}</span><span class="healthy"><i></i>сервера в норме</span></div></section>
          </div>
        </section>

        <footer class="disclaimer"><span class="info-icon">i</span><span>${state.native ? 'Системный прокси Windows/macOS запускается через sing-box. TUN не включён намеренно.' : 'Это Preview интерфейса. Для системного прокси запустите desktop-сборку из GitHub Actions.'}</span><span class="capability-state">${state.native ? 'proxy ready' : 'preview only'}</span></footer>
      </main>
    </div>
  `;
  bindEvents();
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }

async function loadSubscription() {
  const input = document.querySelector('#subscription-url');
  const url = input?.value.trim();
  if (!url) throw new Error('Вставьте ссылку подписки 3x-ui');
  state.subscriptionUrl = url;
  localStorage.setItem('kartoshka.subscriptionUrl', url);
  const raw = await desktopBridge.fetchSubscription(url);
  const imported = parseSubscription(raw);
  if (!imported.length) throw new Error('Не найдено поддерживаемых ссылок vless/vmess/trojan/ss');
  servers.splice(0, servers.length, ...imported);
  state.selectedServer = servers[0].id;
  state.lastUpdated = 'только что';
  state.subscriptionMessage = `Загружено серверов: ${servers.length}`;
}

function bindEvents() {
  document.querySelectorAll('[data-server]').forEach((button) => button.addEventListener('click', () => { if (state.connection === 'connected') state.connection = 'idle'; state.selectedServer = button.dataset.server; render(); }));
  document.querySelectorAll('[data-route]').forEach((button) => button.addEventListener('click', () => { state.routeMode = button.dataset.route; render(); }));
  document.querySelector('[data-action="toggle"]')?.addEventListener('click', async () => {
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
    event.currentTarget.disabled = true;
    state.subscriptionMessage = 'Загружаем подписку…'; render();
    try { await loadSubscription(); state.connection = 'idle'; }
    catch (error) { state.connection = 'error'; state.subscriptionMessage = error.message || 'Не удалось загрузить подписку'; }
    render();
  });
  document.querySelectorAll('[data-action="refresh"]').forEach((button) => button.addEventListener('click', async () => {
    button.classList.add('is-spinning');
    if (state.subscriptionUrl) { try { await loadSubscription(); } catch (error) { state.subscriptionMessage = error.message; } }
    else { servers.forEach((item) => { item.ping = Math.max(48, item.ping + Math.round(Math.random() * 14 - 7)); }); }
    state.lastUpdated = 'только что'; render();
  }));
  document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'center' })));
}

render();
