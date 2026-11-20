import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n.js';

const plugin = (command, args = {}) => invoke(`plugin:vpn|${command}`, args);

/**
 * Android side of the bridge. It talks only to tauri-plugin-vpn: the service
 * receives a complete Xray config and never opens a local TCP control port.
 */
export const androidBridge = {
  isAndroid: true,

  async connect({ config, splitMode = 'off', includePackages = [], excludePackages = [], localNetwork = false, nodeLabel = '', country = '' }) {
    return plugin('android_connect', {
      payload: {
        configJson: JSON.stringify(config),
        splitMode,
        includePackages,
        excludePackages,
        localNetwork,
        nodeLabel,
        country
      }
    });
  },

  async disconnect() {
    await plugin('android_disconnect');
    return { ok: true, native: true };
  },

  async status() {
    return plugin('status');
  },

  async listApps() {
    const result = await plugin('android_apps');
    return Array.isArray(result?.apps) ? result.apps : [];
  },

  async requestNotificationPermission() {
    return plugin('android_notification_permission');
  },

  // Android has no system proxy and no local HTTP/SOCKS listener.
  async loadSecureState() { return null; },
  // Phase 1 keeps the subscription list in localStorage; the last tunnel
  // bundle is encrypted by the service with Android Keystore. Phase 3 moves
  // the whole state to an Android Keystore-backed store.
  async saveSecureState() { return { ok: false, preview: true, android: true }; },
  async resetSecureState() { return { ok: true, android: true }; },
  async setAutostart() { return { ok: false, android: true }; },
  async autostartEnabled() { return false; },
  async setCloseToTray() { return { ok: false, android: true }; },
  async setTrayActive() { return { ok: false, android: true }; },
  async quitApp() { return { ok: false, android: true }; },

  async checkClientUpdate() { throw new Error(t('settings.clientUpdatePreview')); },
  async installClientUpdate() { throw new Error(t('settings.clientUpdatePreview')); },
  async watchClientUpdate() { return () => {}; },

  async openExternal(url) {
    window.open(url, '_blank', 'noopener');
    return { ok: true, android: true };
  },

  async watchTray() {},
  async watchProxyExit() { return () => {}; },
  async watchHealth() { return () => {}; },

  async fetchSubscription(url, protectDns = false) {
    const directScheme = /^(vless|vmess|trojan|ss|hysteria2):\/\//i;
    if (directScheme.test(url)) return { body: url, userinfo: null };
    const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'text/plain, text/*, */*' } });
    if (!response.ok) throw new Error(t('bridge.subscriptionHttp', { status: response.status }));
    return { body: await response.text(), userinfo: response.headers.get('subscription-userinfo') };
  },

  async pinCertificate() { throw new Error(t('bridge.previewCertificate')); },
  async resolveHost() { return null; },
  async dnsCheck() { return null; },
  async pingNode() { return null; },
  async probeNodeLatency() { return null; },
  async lookupCountries() { return []; },
  async proxyLatency() { return null; },
  // A probe would need a local listener or an external request. Phase 1 uses
  // the service status instead; the UI must not claim an external IP.
  async probeInternet() { return null; },
  async readLogs() { return ''; },
  async proxyDiagnostics() { return ''; },
  async collectDiagnosticsFile() { return ''; },

  getCapabilities() {
    return { systemProxy: false, subscriptionImport: true, geofiles: false, native: true, android: true, vpn: true };
  }
};
