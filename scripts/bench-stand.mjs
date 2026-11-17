#!/usr/bin/env node
// Local measurement stand: one Xray server per transport, the app's own client
// configuration, a local test file and the SOCKS benchmark on top of it.
//
//   node scripts/bench-stand.mjs --only reality --label baseline
//
// Absolute numbers are loopback numbers: they compare configurations of this
// app, not the speed of a provider's server.
import { createServer } from 'node:http';
import { createServer as createTcpServer, connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { argv, env, exit } from 'node:process';
import { parseSubscriptionDetailed } from '../src/subscription.js';
import { buildXrayConfig } from '../src/xray-config.js';

const XRAY = env.XRAY_TEST_BIN || resolve('../../xray/xray');
const FILE_SIZE = 32 * 1024 * 1024;
const UUID = '11111111-1111-4111-8111-111111111111'; // public fixture, not a credential

function args() {
  const out = { only: 'all', label: 'baseline', repeat: 1, patch: '', out: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i], value = argv[i + 1];
    if (key === '--only') { out.only = value; i += 1; }
    else if (key === '--label') { out.label = value; i += 1; }
    else if (key === '--repeat') { out.repeat = Number(value); i += 1; }
    else if (key === '--patch') { out.patch = value; i += 1; }
    else if (key === '--out') { out.out = value; i += 1; }
  }
  return out;
}

async function listen(server, port = 0) { await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); }); return server.address().port; }
async function freeTcp() { const s = createTcpServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p; }
async function freeUdp() { const s = createSocket('udp4'); await new Promise(r => s.bind(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function waitPort(port, proc, timeout = 10000) {
  return new Promise((res, rej) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      if (proc.exitCode !== null) return rej(new Error('ядро завершилось до готовности'));
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); res(); });
      socket.once('error', () => { socket.destroy(); if (Date.now() > deadline) rej(new Error(`порт ${port} не открылся`)); else setTimeout(tick, 100); });
    };
    tick();
  });
}
function stop(proc) { return new Promise((res) => { if (!proc || proc.exitCode !== null) return res(); proc.once('exit', res); proc.kill(); setTimeout(res, 3000); }); }

function patchConfig(config, patchPath) {
  if (!patchPath) return config;
  const patch = JSON.parse(readFileSync(patchPath, 'utf8'));
  const merge = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) merge(target[key], value);
      else target[key] = value;
    }
    return target;
  };
  return merge(config, patch);
}

async function startStand(kind, dir) {
  const serverPath = join(dir, `${kind}-server.json`);
  const clientPath = join(dir, `${kind}-client.json`);
  let serverConfig, nodeUri, extra = {};
  if (kind === 'reality') {
    const port = await freeTcp();
    const keys = spawnSync(XRAY, ['x25519'], { encoding: 'utf8' });
    const privateKey = /PrivateKey:\s*(\S+)/.exec(keys.stdout)?.[1];
    const publicKey = /Password \(PublicKey\):\s*(\S+)/.exec(keys.stdout)?.[1];
    if (!privateKey || !publicKey) throw new Error(`xray x25519: ${keys.stdout} ${keys.stderr}`);
    serverConfig = {
      log: { loglevel: 'warning' },
      inbounds: [{ listen: '127.0.0.1', port, protocol: 'vless', settings: { clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: 'none' }, streamSettings: { network: 'raw', security: 'reality', realitySettings: { show: false, dest: 'www.microsoft.com:443', xver: 0, serverNames: ['www.microsoft.com'], privateKey, shortIds: ['abcd1234'] } } }],
      outbounds: [{ protocol: 'freedom', settings: { finalRules: [{ action: 'allow', network: 'tcp', ip: ['127.0.0.1/32'] }] } }]
    };
    nodeUri = `vless://${UUID}@127.0.0.1:${port}?type=tcp&security=reality&sni=www.microsoft.com&fp=chrome&pbk=${publicKey}&sid=abcd1234&flow=xtls-rprx-vision#reality`;
  } else if (kind === 'xhttp') {
    const port = await freeTcp();
    serverConfig = {
      log: { loglevel: 'warning' },
      inbounds: [{ listen: '127.0.0.1', port, protocol: 'vless', settings: { clients: [{ id: UUID }], decryption: 'none' }, streamSettings: { network: 'xhttp', security: 'none', xhttpSettings: { path: '/x' } } }],
      outbounds: [{ protocol: 'freedom', settings: { finalRules: [{ action: 'allow', network: 'tcp', ip: ['127.0.0.1/32'] }] } }]
    };
    nodeUri = `vless://${UUID}@127.0.0.1:${port}?type=xhttp&path=%2Fx&security=none&mode=auto#xhttp`;
  } else {
    const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
    const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '1', '-nodes', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    if (gen.status !== 0) throw new Error('нужен openssl');
    const der = spawnSync('openssl', ['x509', '-in', cert, '-outform', 'der']);
    const pin = createHash('sha256').update(der.stdout).digest('hex');
    const port = await freeUdp();
    serverConfig = {
      log: { loglevel: 'warning' },
      inbounds: [{ listen: '127.0.0.1', port, protocol: 'hysteria', settings: { version: 2, users: [{ auth: 'fixture-auth' }] }, streamSettings: { network: 'hysteria', security: 'tls', tlsSettings: { certificates: [{ certificateFile: cert, keyFile: key }] }, hysteriaSettings: { version: 2 }, finalmask: { udp: [{ type: 'salamander', settings: { password: 'fixture-mask' } }] } } }],
      outbounds: [{ protocol: 'freedom', settings: { finalRules: [{ action: 'allow', network: 'tcp', ip: ['127.0.0.1/32'] }] } }]
    };
    nodeUri = `hy2://fixture-auth@127.0.0.1:${port}?sni=localhost&pinSHA256=${pin}&obfs=salamander&obfs-password=fixture-mask#hysteria2`;
  }
  const node = parseSubscriptionDetailed(nodeUri).nodes[0];
  if (!node) throw new Error(`не удалось разобрать ${kind}`);
  const config = buildXrayConfig([node], node.id, 'all', null, { perf: JSON.parse(env.PERF_OPTS || '{}') });
  writeFileSync(serverPath, JSON.stringify(serverConfig), { mode: 0o600 });
  writeFileSync(clientPath, JSON.stringify(config), { mode: 0o600 });
  const server = spawn(XRAY, ['run', '-config', serverPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let serverError = '';
  server.stderr.on('data', (chunk) => { serverError += chunk.toString(); });
  if (kind === 'hysteria2') await delay(400); else await waitPort(serverConfig.inbounds[0].port, server);
  const client = spawn(XRAY, ['run', '-config', clientPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let clientError = '';
  client.stderr.on('data', (chunk) => { clientError += chunk.toString(); });
  try { await waitPort(2081, client); } catch (error) {
    await stop(client); await stop(server);
    throw new Error(`${kind}: ${error.message}\nserver: ${serverError}\nclient: ${clientError}`);
  }
  return { kind, server, client, clientPath, serverError: () => serverError, clientError: () => clientError };
}

const options = args();
const dir = mkdtempSync(join(tmpdir(), 'kartovpn-bench-'));
const results = [];
let fileServer;
try {
  const payload = randomBytes(FILE_SIZE);
  fileServer = createServer((req, res) => {
    if (req.method === 'POST') { req.on('data', () => {}); req.on('end', () => { res.writeHead(200); res.end('ok'); }); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  const filePort = await listen(fileServer);
  const fileUrl = `http://127.0.0.1:${filePort}/test.bin`;
  const kinds = options.only === 'all' ? ['reality', 'xhttp', 'hysteria2'] : [options.only];
  for (const kind of kinds) {
    const stand = await startStand(kind, dir);
    try {
      patchConfig; // client config patched in place for A/B measurements
      if (options.patch) {
        const patched = patchConfig(JSON.parse(readFileSync(stand.clientPath, 'utf8')), options.patch);
        writeFileSync(stand.clientPath, JSON.stringify(patched));
        await stop(stand.client);
        stand.client = spawn(XRAY, ['run', '-config', stand.clientPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        await waitPort(2081, stand.client);
      }
      for (let round = 1; round <= options.repeat; round += 1) {
        const json = join(dir, `${kind}-${round}.json`);
        const child = spawn(process.execPath, [resolve('scripts/bench.mjs'), '--file', fileUrl, '--label', `${options.label}-${kind}${options.repeat > 1 ? `-r${round}` : ''}`, '--json', json, '--samples', env.BENCH_SAMPLES || '20'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        await new Promise((res) => child.once('exit', res));
        if (env.BENCH_DEBUG && stderr) console.error(stderr.trim());
        if (!existsSync(json)) { console.error(`${kind}: бенчмарк не дал результата\n${stdout}\n${stderr}`); continue; }
        const data = JSON.parse(readFileSync(json, 'utf8'));
        results.push(data.summary);
        console.log(`${kind.padEnd(9)} ttfb ${String(data.summary.ttfbMedianMs).padStart(6)} ms  p95 ${String(data.summary.ttfbP95Ms).padStart(6)} ms  ↓ ${String(data.summary.downloadMbps).padStart(6)} Мбит/с  ↑ ${String(data.summary.uploadMbps).padStart(6)} Мбит/с  сбоев ${data.summary.failures}`);
      }
    } finally {
      await stop(stand.client);
      await stop(stand.server);
    }
  }
  if (options.out) writeFileSync(options.out, JSON.stringify({ label: options.label, patch: options.patch || null, at: new Date().toISOString(), results }, null, 2));
} finally {
  if (fileServer) await new Promise(r => fileServer.close(r));
  rmSync(dir, { recursive: true, force: true });
}
if (!results.length) exit(1);
