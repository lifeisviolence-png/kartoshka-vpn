import { invoke } from '@tauri-apps/api/core';

const isDesktop = Boolean(window.__TAURI_INTERNALS__);
const directScheme = /^(vless|vmess|trojan|ss|hysteria2):\/\//i;

export const desktopBridge = {
  async connect({ config }) {
    if (!isDesktop) return { ok: false, demo: true, error: 'Preview не может включить системный прокси' };
    await invoke('start_proxy', { configJson: JSON.stringify(config) });
    return { ok: true, native: true };
  },
  async disconnect() {
    if (!isDesktop) return { ok: true, demo: true };
    await invoke('stop_proxy');
    return { ok: true, native: true };
  },
  async fetchSubscription(url) {
    if (directScheme.test(url)) return { body: url, userinfo: null };
    if (isDesktop) return invoke('fetch_subscription', { url });
    const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'text/plain, text/*, */*' } });
    if (!response.ok) throw new Error(`Сервер подписки вернул HTTP ${response.status}`);
    return { body: await response.text(), userinfo: response.headers.get('subscription-userinfo') };
  },
  async pingNode(node) {
    if (!isDesktop || !node?.outbound?.server) return null;
    return invoke('test_latency', { host: node.outbound.server, port: Number(node.outbound.server_port || 443) });
  },
  getCapabilities() {
    return { tun: false, systemProxy: isDesktop, subscriptionImport: true, geofiles: false, native: isDesktop };
  }
};
