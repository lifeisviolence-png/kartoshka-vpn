#!/usr/bin/env node
// Isolates the client-side cost of resolving names for routing rules.
//
// A local resolver answers one test name after a fixed delay and forwards
// everything else, so the difference between DNS modes is visible on loopback
// where the network itself costs nothing. The system resolver is pointed at it
// for the duration of the run and restored afterwards.
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { createServer as createTcpServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { argv, env, exit } from 'node:process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSubscriptionDetailed } from '../src/subscription.js';
import { buildXrayConfig } from '../src/xray-config.js';

const XRAY = env.XRAY_TEST_BIN || resolve('../../xray/xray');
const UUID = '44444444-4444-4444-8444-444444444444';
const NAME = 'bench-dns.test';
const DELAY = Number(env.BENCH_DNS_DELAY || 100);
const SAMPLES = Number(env.BENCH_SAMPLES || 20);

function args() {
  const out = { modes: 'system,auto,builtin', out: '' };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--modes') { out.modes = argv[i + 1]; i += 1; }
    else if (argv[i] === '--out') { out.out = argv[i + 1]; i += 1; }
  }
  return out;
}
async function listen(server) { await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); }); return server.address().port; }
function stop(proc) { return new Promise((res) => { if (!proc || proc.exitCode !== null) return res(); proc.once('exit', res); proc.kill(); setTimeout(res, 3000); }); }
function waitPort(port, proc) {
  return new Promise((res, rej) => {
    const deadline = Date.now() + 10000;
    const tick = () => {
      if (proc.exitCode !== null) return rej(new Error('ядро завершилось'));
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); res(); });
      socket.once('error', () => { socket.destroy(); if (Date.now() > deadline) rej(new Error(`порт ${port}`)); else setTimeout(tick, 80); });
    };
    tick();
  });
}

function parseQuery(buffer) {
  let offset = 12, labels = [];
  while (buffer[offset] !== 0) { const len = buffer[offset]; labels.push(buffer.subarray(offset + 1, offset + 1 + len).toString()); offset += len + 1; }
  return { name: labels.join('.'), end: offset + 5 };
}
function answerA(query, ip) {
  const header = Buffer.from(query.subarray(0, 2));
  const flags = Buffer.from([0x81, 0x80]);
  const counts = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const question = query.subarray(12, query.length);
  const answer = Buffer.concat([
    Buffer.from([0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04]),
    Buffer.from(ip.split('.').map(Number))
  ]);
  return Buffer.concat([header, flags, counts, question, answer]);
}

function median(values) { const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function p95(values) { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; }

async function request(port, host) {
  const started = performance.now();
  return new Promise((res, rej) => {
    const socket = connect(port, '127.0.0.1');
    socket.setTimeout(8000, () => { socket.destroy(); rej(new Error('timeout')); });
    socket.once('error', rej);
    socket.once('connect', () => socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    socket.once('data', () => { socket.destroy(); res(performance.now() - started); });
  });
}

const options = args();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { try { copyFileSync(join(tmpdir(), 'kartovpn-dns-restore'), '/etc/resolv.conf'); } catch {} process.exit(1); });
const modes = options.modes.split(',').map(s => s.trim()).filter(Boolean);
const dir = mkdtempSync(join(tmpdir(), 'kartovpn-dns-'));
const resolv = '/etc/resolv.conf';
const backup = join(dir, 'resolv.backup');
const results = [];
let http, dns, upstream, client, forwarder;
try {
  http = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); });
  const targetPort = await listen(http);

  // Resolver: one name is delayed, everything else is forwarded unchanged.
  dns = createSocket('udp4');
  forwarder = createSocket('udp4');
  await new Promise((res, rej) => { dns.once('error', rej); dns.bind(53, '127.0.0.1', res); });
  await new Promise(r => forwarder.bind(0, '127.0.0.1', r));
  dns.on('message', (msg, rinfo) => {
    const { name } = parseQuery(msg);
    if (name === NAME) { setTimeout(() => dns.send(answerA(msg, '127.0.0.1'), rinfo.port, rinfo.address), DELAY); return; }
    const pending = (reply) => { dns.send(reply, rinfo.port, rinfo.address); forwarder.off('message', pending); };
    forwarder.on('message', pending);
    forwarder.send(msg, 53, '8.8.8.8');
  });

  copyFileSync(resolv, backup);
  copyFileSync(resolv, join(tmpdir(), 'kartovpn-dns-restore'));
  writeFileSync(resolv, 'nameserver 127.0.0.1\noptions timeout:2 attempts:1\n');

  const serverPort = await (async () => { const s = createTcpServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; })();
  const serverConfig = { log: { loglevel: 'warning' }, inbounds: [{ listen: '127.0.0.1', port: serverPort, protocol: 'vless', settings: { clients: [{ id: UUID }], decryption: 'none' } }], outbounds: [{ protocol: 'freedom', settings: { finalRules: [{ action: 'allow', network: 'tcp', ip: ['127.0.0.1/32'] }] } }] };
  const serverPath = join(dir, 'server.json');
  writeFileSync(serverPath, JSON.stringify(serverConfig), { mode: 0o600 });
  upstream = spawn(XRAY, ['run', '-config', serverPath], { stdio: 'ignore' });
  await waitPort(serverPort, upstream);

  const node = parseSubscriptionDetailed(`vless://${UUID}@127.0.0.1:${serverPort}?type=tcp&security=none#dns`).nodes[0];
  for (const mode of modes) {
    const config = buildXrayConfig([node], node.id, 'split', null, { dns: mode });
    config.log.loglevel = 'warning';
    const clientPath = join(dir, `client-${mode}.json`);
    writeFileSync(clientPath, JSON.stringify(config), { mode: 0o600 });
    client = spawn(XRAY, ['run', '-config', clientPath], { stdio: 'ignore' });
    await waitPort(2081, client);
    const values = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      try { values.push(await request(2080, NAME)); } catch { /* counted as failure below */ }
    }
    const entry = { mode, samples: values.length, median: median(values), p95: p95(values), failures: SAMPLES - values.length };
    results.push(entry);
    console.log(`${mode.padEnd(8)} median ${entry.median.toFixed(0)} ms  p95 ${entry.p95.toFixed(0)} ms  сбоев ${entry.failures}`);
    await stop(client); client = null;
  }
  if (options.out) writeFileSync(options.out, JSON.stringify({ delay: DELAY, samples: SAMPLES, at: new Date().toISOString(), results }, null, 2));
} finally {
  copyFileSync(backup, resolv);
  if (client) await stop(client);
  if (upstream) await stop(upstream);
  if (http) await new Promise(r => http.close(r));
  if (dns) dns.close(); if (forwarder) forwarder.close();
  rmSync(dir, { recursive: true, force: true });
}
if (!results.length) exit(1);
