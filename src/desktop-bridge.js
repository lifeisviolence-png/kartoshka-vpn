import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from './i18n.js';

const isDesktop = Boolean(window.__TAURI_INTERNALS__);
const directScheme = /^(vless|vmess|trojan|ss|hysteria2):\/\//i;

export const desktopBridge = {
  async connect({ config, debug = false }) {
    if (!isDesktop) return { ok: false, demo: true, error: t('bridge.previewProxy') };
    const warning = await invoke('start_proxy', { configJson: JSON.stringify(config), debug: Boolean(debug) });
    return { ok: true, native: true, warning: warning || null };
  },
  async disconnect() {
    if (!isDesktop) return { ok: true, demo: true };
    await invoke('stop_proxy');
    return { ok: true, native: true };
  },
  // The snapshot lives in %APPDATA%\ru.kartoshka.vpn\state.enc and is encrypted
  // with DPAPI. A preview has no DPAPI and keeps localStorage instead.
  async loadSecureState() {
    if (!isDesktop) return null;
    return invoke('load_secure_state');
  },
  async saveSecureState(contents) {
    if (!isDesktop) return { ok: false, preview: true };
    await invoke('save_secure_state', { contents: String(contents) });
    return { ok: true };
  },
  async resetSecureState() {
    if (!isDesktop) return { ok: false, preview: true };
    await invoke('reset_secure_state');
    return { ok: true, native: true };
  },
  async setAutostart(enabled) {
    if (!isDesktop) return { ok: false, preview: true };
    await invoke('set_autostart', { enabled: Boolean(enabled) });
    return { ok: true };
  },
  async autostartEnabled() {
    if (!isDesktop) return false;
    return invoke('autostart_enabled');
  },
  async setCloseToTray(enabled) {
    if (!isDesktop) return { ok: false, preview: true };
    await invoke('set_close_to_tray', { enabled: Boolean(enabled) });
    return { ok: true };
  },
  async setTrayActive(active) {
    if (!isDesktop) return { ok: false, preview: true };
    await invoke('set_tray_active', { active: Boolean(active) });
    return { ok: true };
  },
  async quitApp() {
    if (!isDesktop) return { ok: false, preview: true };
    await invoke('quit_app');
    return { ok: true };
  },
  async openExternal(url) {
    if (!isDesktop) { window.open(url, '_blank', 'noopener'); return { ok: true, preview: true }; }
    await invoke('open_external', { url: String(url) });
    return { ok: true };
  },
  async watchTray({ onToggle, onQuit }) {
    if (!isDesktop) return;
    await listen('tray-toggle', () => onToggle?.());
    await listen('tray-quit', () => onQuit?.());
  },
  async fetchSubscription(url, protectDns = false) {
    if (directScheme.test(url)) return { body: url, userinfo: null };
    if (isDesktop) return invoke('fetch_subscription', { url, protectDns: Boolean(protectDns) });
    const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'text/plain, text/*, */*' } });
    if (!response.ok) throw new Error(t('bridge.subscriptionHttp', { status: response.status }));
    return { body: await response.text(), userinfo: response.headers.get('subscription-userinfo') };
  },
  async pinCertificate({ host, port, serverName }) {
    if (!isDesktop) throw new Error(t('bridge.previewCertificate'));
    return invoke('pin_peer_certificate', { host, port: Number(port), serverName: String(serverName || host) });
  },
  async resolveHost(name) { return invoke('resolve_host', { name }); },
  async dnsCheck(names) { return invoke('dns_check', { names }); },
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
  async proxyDiagnostics() {
    if (!isDesktop) return '';
    return invoke('proxy_diagnostics');
  },
  async collectDiagnosticsFile() {
    if (!isDesktop) return '';
    return invoke('collect_diagnostics');
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
