/**
 * Browser-safe contract for the future Tauri/native layer.
 * The prototype intentionally returns demo values and never changes system proxy settings.
 * A desktop build can replace this object with a sing-box/Xray process adapter.
 */
export const desktopBridge = {
  async connect({ serverId, routeMode }) {
    return { ok: true, serverId, routeMode, transport: 'demo-local-proxy' };
  },
  async disconnect() {
    return { ok: true };
  },
  async refreshSubscription() {
    return { ok: true, source: 'demo-3x-ui-subscription' };
  },
  getCapabilities() {
    return {
      tun: false,
      systemProxy: false,
      subscriptionImport: false,
      geofiles: false,
      note: 'Подключение системного прокси появится в desktop-версии.'
    };
  }
};
