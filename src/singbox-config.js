function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, withoutUndefined(item)]));
  return value;
}

export function buildSingBoxConfig(nodes, selectedId, routeMode) {
  const selected = nodes.find((node) => node.id === selectedId) || nodes[0];
  if (!selected) throw new Error('В подписке нет поддерживаемых серверов');
  const outbounds = nodes.map((node) => ({ ...node.outbound, tag: node.id })).concat([{ type: 'direct', tag: 'direct' }, { type: 'block', tag: 'block' }]);
  const rules = [{ ip_is_private: true, outbound: 'direct' }];
  if (routeMode === 'split') rules.push({ domain_suffix: ['.ru', '.рф'], outbound: 'direct' });
  return withoutUndefined({
    log: { level: 'info', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'kartoshka-in', listen: '127.0.0.1', listen_port: 2080 }],
    outbounds,
    route: { auto_detect_interface: true, final: selected.id, rules }
  });
}
