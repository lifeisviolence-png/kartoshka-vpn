export function buildSingBoxConfig(nodes, selectedId, routeMode) {
  const selected = nodes.find((node) => node.id === selectedId) || nodes[0];
  if (!selected) throw new Error('В подписке нет поддерживаемых серверов');

  const outbounds = nodes.map((node) => ({ ...node.outbound, tag: node.id })).concat([
    { type: 'direct', tag: 'direct' },
    { type: 'block', tag: 'block' }
  ]);

  const route = {
    auto_detect_interface: true,
    final: selected.id,
    rules: [
      { ip_is_private: true, outbound: 'direct' },
      { protocol: 'dns', outbound: 'direct' }
    ]
  };

  if (routeMode === 'manual') route.final = selected.id;
  if (routeMode === 'split') route.rules.push({ domain_suffix: ['.ru', '.рф'], outbound: 'direct' });

  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'kartoshka-in', listen: '127.0.0.1', listen_port: 2080, set_system_proxy: true }],
    outbounds,
    route
  };
}
