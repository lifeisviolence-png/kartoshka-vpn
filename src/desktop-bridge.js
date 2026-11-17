import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from './i18n.js';

const isDesktop = Boolean(window.__TAURI_INTERNALS__);
const directScheme = /^(vless|vmess|trojan|ss|hysteria2):\/\//i;

export const desktopBridge = {
  async connect({ config, debug = false }) {
    if (!isDesktop) return { ok: false, demo: true, error: t('bridge.previewProxy') };
    await invoke('start_proxy', { configJson: JSON.stringify(config), debug: Boolean(debug) });
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
    if (!response.ok) throw new Error(t('bridge.subscriptionHttp', { status: response.status }));
    return { body: await response.text(), userinfo: response.headers.get('subscription-userinfo') };
  },
  async pinCertificate({ host, port, serverName }) {
    if (!isDesktop) throw new Error(t('bridge.previewCertificate'));
    return invoke('pin_peer_certificate', { host, port: Number(port), serverName: String(serverName || host) });
  },
  async pingNode(node) {
    if (!isDesktop || !node?.outbound?.server) return null;
    return invoke('test_latency', { host: node.outbound.server, port: Number(node.outbound.server_port || 443) });
  },
  // One request through a temporary core instance; used for UDP protocols where
  // a TCP handshake proves nothing.
  async probeNodeLatency(config) {
    if (!isDesktop) return null;
    return invoke('probe_node_latency', { configJson: JSON.stringify(config) });
  },
  async lookupCountries(hosts) {
    if (!isDesktop || !Array.isArray(hosts) || !hosts.length) return [];
    return invoke('lookup_countries', { hosts: hosts.map(String) });
  },
  async proxyLatency() {
    if (!isDesktop) return null;
    return invoke('test_proxy_latency');
  },
  async probeInternet() {
    if (!isDesktop) throw new Error(t('bridge.previewProbe'));
    return invoke('probe_internet');
  },
  async readLogs() {
    if (!isDesktop) return '';
    return invoke('read_logs');
  },
  async watchProxyExit(callback) {
    if (!isDesktop) return () => {};
    return listen('proxy-exited', (event) => callback(event.payload));
  },
  async watchHealth(callback) {
    if (!isDesktop) return () => {};
    const stops = await Promise.all([
      listen('proxy-restarted', (event) => callback('restarted', event.payload)),
      listen('proxy-unhealthy', (event) => callback('unhealthy', event.payload))
    ]);
    return () => stops.forEach((stop) => stop());
  },
  getCapabilities() {
    return { systemProxy: isDesktop, subscriptionImport: true, geofiles: false, native: isDesktop };
  }
};
