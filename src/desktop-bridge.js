import { invoke } from '@tauri-apps/api/core';

const isDesktop = Boolean(window.__TAURI_INTERNALS__);

export const desktopBridge = {
  async connect({ config }) {
    if (!isDesktop) return { ok: true, demo: true };
    await invoke('start_proxy', { configJson: JSON.stringify(config) });
    return { ok: true, native: true };
  },
  async disconnect() {
    if (!isDesktop) return { ok: true, demo: true };
    await invoke('stop_proxy');
    return { ok: true, native: true };
  },
  async refreshSubscription() {
    return { ok: true };
  },
  async fetchSubscription(url) {
    if (/^(vless|vmess|trojan|ss):\/\//i.test(url)) return url;
    if (isDesktop) return invoke('fetch_subscription', { url });
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Ошибка подписки: HTTP ${response.status}`);
    return response.text();
  },
  getCapabilities() {
    return { tun: false, systemProxy: isDesktop, subscriptionImport: true, geofiles: false, native: isDesktop };
  }
};
