import './styles.css';
import { desktopBridge } from './desktop-bridge.js';

const servers = [
  { id: 'de-fra', flag: '🇩🇪', country: 'Германия', city: 'Frankfurt', ping: 82, accent: 'amber' },
  { id: 'nl-ams', flag: '🇳🇱', country: 'Нидерланды', city: 'Amsterdam', ping: 96, accent: 'violet' },
  { id: 'fi-hel', flag: '🇫🇮', country: 'Финляндия', city: 'Helsinki', ping: 71, accent: 'blue' }
];

const routeModes = [
  { id: 'split', title: 'Россия напрямую', subtitle: 'Зарубежные сайты через прокси' },
  { id: 'all', title: 'Весь трафик через прокси', subtitle: 'Максимальное покрытие приложений' },
  { id: 'manual', title: 'Ручной режим', subtitle: 'Выбор правил вручную' }
];

const state = {
  connection: 'idle',
  selectedServer: servers[0].id,
  routeMode: routeModes[0].id,
  lastUpdated: 'только что'
};

const app = document.querySelector('#app');

function selectedServer() {
  return servers.find((server) => server.id === state.selectedServer) ?? servers[0];
}

function statusCopy() {
  return {
    idle: { label: 'Не подключено', hint: 'Прокси готов к запуску', className: 'is-idle' },
    connecting: { label: 'Подключение', hint: 'Проверяем локальный прокси…', className: 'is-connecting' },
    connected: { label: 'Подключено', hint: 'Локальный прокси работает', className: 'is-connected' },
    error: { label: 'Ошибка', hint: 'Не удалось запустить демонстрационный адаптер', className: 'is-error' }
  }[state.connection];
}

function render() {
  const server = selectedServer();
  const status = statusCopy();
  const isBusy = state.connection === 'connecting';
  const isConnected = state.connection === 'connected';
  const buttonLabel = isBusy ? 'Подключаем…' : isConnected ? 'Отключиться' : 'Подключиться';
  const capabilities = desktopBridge.getCapabilities();

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand-lockup">
          <img src="/potato-mark.svg" alt="" class="brand-mark" />
          <div>
            <div class="brand-name">КартошкаVPN</div>
            <div class="brand-caption">quiet internet</div>
          </div>
        </div>

        <nav class="nav-list" aria-label="Навигация">
          <button class="nav-item is-active" type="button"><span class="nav-icon">◎</span>Подключение</button>
          <button class="nav-item" type="button" data-scroll="routing"><span class="nav-icon">⌘</span>Маршрутизация</button>
          <button class="nav-item" type="button" data-scroll="subscription"><span class="nav-icon">◌</span>Подписка</button>
        </nav>

        <div class="sidebar-bottom">
          <div class="bridge-note">
            <span class="tiny-dot"></span>
            <div>
              <strong>Desktop bridge</strong>
              <span>готов к интеграции</span>
            </div>
          </div>
          <div class="version-line">v0.1 · прототип</div>
        </div>
      </aside>

      <main class="content">
        <header class="topbar">
          <div>
            <span class="eyebrow">Личный клиент</span>
            <h1>Подключение</h1>
          </div>
          <div class="topbar-actions">
            <span class="prototype-pill"><span class="pill-dot"></span> preview</span>
            <button class="icon-button" type="button" aria-label="Настройки">⌁</button>
          </div>
        </header>

        <section class="surface-card subscription-card subscription-banner" id="subscription">
          <div class="subscription-top"><span class="eyebrow">Подписка</span><span class="subscription-badge">активна</span></div>
          <div class="expiry-date">30 <span>января</span> 2027</div>
          <div class="expiry-caption">Дата окончания подписки</div>
          <div class="progress-track"><span></span></div>
          <div class="subscription-bottom"><span>Осталось 85 дней</span><button type="button" data-action="refresh">Обновить данные</button></div>
        </section>

        <section class="dashboard-grid">
          <div class="primary-column">
            <section class="connection-card ${status.className}" aria-live="polite">
              <div class="card-kicker"><span class="status-orb"></span> Состояние соединения</div>
              <div class="connection-main">
                <div>
                  <div class="status-label">${status.label}</div>
                  <div class="status-hint">${status.hint}</div>
                </div>
                <button class="power-button" type="button" data-action="toggle" ${isBusy ? 'disabled' : ''}>
                  <span class="power-ring"><span class="power-glyph">⏻</span></span>
                  <span>${buttonLabel}</span>
                </button>
              </div>
              <div class="connection-meta">
                <div class="selected-server-line">
                  <span class="server-flag">${server.flag}</span>
                  <div><span class="meta-label">Сервер</span><strong>${server.country} · ${server.city}</strong></div>
                </div>
                <div class="latency-line"><span class="meta-label">Задержка</span><strong>${server.ping} ms</strong></div>
              </div>
            </section>

            <section class="surface-card" id="routing">
              <div class="section-heading">
                <div><span class="eyebrow">Логика трафика</span><h2>Маршрутизация</h2></div>
                <span class="section-count">${routeModes.length} режима</span>
              </div>
              <div class="route-options">
                ${routeModes.map((mode, index) => `
                  <button class="route-option ${state.routeMode === mode.id ? 'is-selected' : ''}" type="button" data-route="${mode.id}">
                    <span class="route-radio"><span></span></span>
                    <span class="route-copy"><strong>${mode.title}</strong><small>${mode.subtitle}</small></span>
                    ${index === 0 ? '<span class="recommended">рекомендуем</span>' : ''}
                  </button>
                `).join('')}
              </div>
            </section>
          </div>

          <div class="secondary-column">
            <section class="surface-card servers-card">
              <div class="section-heading">
                <div><span class="eyebrow">3x-ui subscription</span><h2>Серверы</h2></div>
                <button class="refresh-button" type="button" data-action="refresh" aria-label="Обновить серверы">↻</button>
              </div>
              <div class="server-list">
                ${servers.map((item) => `
                  <button class="server-row ${item.id === state.selectedServer ? 'is-selected' : ''}" type="button" data-server="${item.id}">
                    <span class="server-avatar ${item.accent}">${item.flag}</span>
                    <span class="server-details"><strong>${item.country}</strong><small>${item.city}</small></span>
                    <span class="server-ping"><i></i>${item.ping} ms</span>
                    <span class="server-check">${item.id === state.selectedServer ? '✓' : ''}</span>
                  </button>
                `).join('')}
              </div>
              <div class="server-footer"><span>Обновлено ${state.lastUpdated}</span><span class="healthy"><i></i>сервера в норме</span></div>
            </section>

          </div>
        </section>

        <footer class="disclaimer">
          <span class="info-icon">i</span>
          <span>Это интерфейс-прототип. Системный прокси, TUN и загрузка geofiles подключаются в desktop-версии через sing-box или Xray.</span>
          <span class="capability-state">${capabilities.tun ? 'TUN доступен' : 'TUN пока выключен'}</span>
        </footer>
      </main>
    </div>
  `;

  bindEvents();
}

function bindEvents() {
  document.querySelectorAll('[data-server]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.connection === 'connected') state.connection = 'idle';
      state.selectedServer = button.dataset.server;
      render();
    });
  });

  document.querySelectorAll('[data-route]').forEach((button) => {
    button.addEventListener('click', () => {
      state.routeMode = button.dataset.route;
      render();
    });
  });

  document.querySelector('[data-action="toggle"]')?.addEventListener('click', async () => {
    if (state.connection === 'connected') {
      await desktopBridge.disconnect();
      state.connection = 'idle';
      render();
      return;
    }
    state.connection = 'connecting';
    render();
    window.setTimeout(async () => {
      const result = await desktopBridge.connect({ serverId: state.selectedServer, routeMode: state.routeMode });
      state.connection = result.ok ? 'connected' : 'error';
      render();
    }, 850);
  });

  document.querySelectorAll('[data-action="refresh"]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.classList.add('is-spinning');
      await desktopBridge.refreshSubscription();
      window.setTimeout(() => {
        state.lastUpdated = 'только что';
        servers.forEach((item) => { item.ping = Math.max(48, item.ping + Math.round(Math.random() * 14 - 7)); });
        render();
      }, 500);
    });
  });

  document.querySelectorAll('[data-scroll]').forEach((button) => {
    button.addEventListener('click', () => document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  });
}

render();
