function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, withoutUndefined(item)]));
  return value;
}

export function buildSingBoxConfig(nodes, selectedId, routeMode, transportMode = 'tun') {
  const selected = nodes.find((node) => node.id === selectedId) || nodes[0];
  if (!selected) throw new Error('В подписке нет поддерживаемых серверов');
  const outbounds = nodes.map((node) => ({ ...node.outbound, tag: node.id })).concat([{ type: 'direct', tag: 'direct' }, { type: 'block', tag: 'block' }]);
  const rules = [{ ip_is_private: true, outbound: 'direct' }, { protocol: 'dns', action: 'hijack-dns' }];
  if (routeMode === 'split') rules.push({ domain_suffix: ['.ru', '.рф'], outbound: 'direct' });

  const config = {
    log: { level: 'info', timestamp: true },
    inbounds: transportMode === 'tun'
      ? [{ type: 'tun', tag: 'kartoshka-tun', interface_name: 'KartoshkaVPN', address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'], mtu: 1500, auto_route: true, strict_route: true, stack: 'system', dns_mode: 'hijack', dns_address: ['172.19.0.1'] }]
      : [{ type: 'mixed', tag: 'kartoshka-in', listen: '127.0.0.1', listen_port: 2080, set_system_proxy: true }],
    outbounds,
    route: { auto_detect_interface: true, final: selected.id, rules }
  };
  if (transportMode === 'tun') {
    config.dns = {
      servers: [{ type: 'https', tag: 'remote-dns', server: '1.1.1.1', server_port: 443, path: '/dns-query', tls: { enabled: true, server_name: 'cloudflare-dns.com' }, detour: selected.id }],
      final: 'remote-dns',
      strategy: 'prefer_ipv4'
    };
  }
  return withoutUndefined(config);
}
