#!/usr/bin/env node
// Measures what a user feels through the running proxy: time to first byte for
// real domains, download and upload throughput of one test file.
//
//   node scripts/bench.mjs --file https://host/test.bin --label reality
//
// The test file address is always supplied by the caller; this script never
// contacts a built-in speed-test service of its own.
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { performance } from 'node:perf_hooks';

const DEFAULT_DOMAINS = [
  'example.com', 'www.wikipedia.org', 'github.com', 'www.microsoft.com', 'www.cloudflare.com',
  'www.mozilla.org', 'www.debian.org', 'www.python.org', 'nodejs.org', 'www.rust-lang.org',
  'www.postgresql.org', 'nginx.org', 'www.apache.org', 'kernel.org', 'www.gnu.org',
  'www.w3.org', 'www.ietf.org', 'www.rfc-editor.org', 'www.archive.org', 'www.nasa.gov'
];

function parseArgs() {
  const options = { socks: '127.0.0.1:2081', samples: 20, file: '', label: '', json: '', upload: 8, domains: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--socks') { options.socks = value; i += 1; }
    else if (key === '--samples') { options.samples = Number(value); i += 1; }
    else if (key === '--file') { options.file = value; i += 1; }
    else if (key === '--label') { options.label = value; i += 1; }
    else if (key === '--json') { options.json = value; i += 1; }
    else if (key === '--upload') { options.upload = Number(value); i += 1; }
    else if (key === '--domains') { options.domains = value; i += 1; }
  }
  if (!options.file) { console.error('Укажите адрес тестового файла: --file https://host/test.bin'); exit(2); }
  if (options.domains) options.domainList = readFileSync(options.domains, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  else options.domainList = DEFAULT_DOMAINS;
  return options;
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
}

// Minimal SOCKS5 CONNECT: the proxy is the only path under test, so the client
// must not fall back to a direct connection when the tunnel is unavailable.
let PROXY = '127.0.0.1:2081';
function socksConnect({ host, port, timeout = 15000 }) {
  const [proxyHost, proxyPort] = PROXY.split(':');
  return new Promise((resolve, reject) => {
    const socket = connect(Number(proxyPort), proxyHost);
    let buffer = Buffer.alloc(0);
    let stage = 0;
    const fail = (error) => { socket.destroy(); reject(error); };
    socket.setTimeout(timeout, () => fail(new Error('SOCKS timeout')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2) {
        if (buffer[1] !== 0) return fail(new Error('SOCKS auth rejected'));
        buffer = buffer.subarray(2);
        const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
        const address = isIp ? Buffer.from(host.split('.').map(Number)) : Buffer.from(host);
        const head = isIp
          ? Buffer.from([5, 1, 0, 1, ...address])
          : Buffer.concat([Buffer.from([5, 1, 0, 3, address.length]), address]);
        const portBytes = Buffer.from([port >> 8, port & 255]);
        stage = 1;
        socket.write(Buffer.concat([head, portBytes]));
        buffer = Buffer.alloc(0);
      } else if (stage === 1 && buffer.length >= 10) {
        if (buffer[1] !== 0) return fail(new Error(`SOCKS connect failed: ${buffer[1]}`));
        socket.removeAllListeners('data');
        socket.setTimeout(0);
        socket.removeAllListeners('timeout');
        resolve(socket);
      }
    });
  });
}

async function readResponse(socket, onFirstByte) {
  let first = true;
  let total = 0;
  return new Promise((resolve, reject) => {
    socket.on('data', (chunk) => {
      if (first) { first = false; onFirstByte?.(); }
      total += chunk.length;
    });
    socket.on('end', () => resolve(total));
    socket.on('close', () => resolve(total));
    socket.on('error', reject);
  });
}

async function ttfb(domain) {
  const started = performance.now();
  const socket = await socksConnect({ host: domain, port: 443 });
  const secure = tlsConnect({ socket, servername: domain, ALPNProtocols: ['http/1.1'] });
  await new Promise((resolve, reject) => {
    secure.once('secureConnect', resolve);
    secure.once('error', reject);
    secure.setTimeout(15000, () => reject(new Error('TLS timeout')));
  });
  const firstByte = new Promise((resolve, reject) => {
    secure.once('data', () => resolve(performance.now() - started));
    secure.once('error', reject);
    secure.setTimeout(15000, () => reject(new Error('response timeout')));
  });
  secure.write(`GET / HTTP/1.1\r\nHost: ${domain}\r\nUser-Agent: KartoshkaBench/1\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
  try {
    const elapsed = await firstByte;
    secure.destroy();
    return elapsed;
  } catch (error) { secure.destroy(); throw error; }
}

async function download(url) {
  const target = new URL(url);
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const socket = await socksConnect({ host: target.hostname, port });
  const stream = target.protocol === 'https:' ? tlsConnect({ socket, servername: target.hostname }) : socket;
  if (target.protocol === 'https:') await new Promise((resolve, reject) => { stream.once('secureConnect', resolve); stream.once('error', reject); });
  const started = performance.now();
  let bytes = 0;
  stream.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\nUser-Agent: KartoshkaBench/1\r\nConnection: close\r\n\r\n`);
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => { bytes += chunk.length; });
    stream.on('end', resolve); stream.on('close', resolve); stream.on('error', reject);
  });
  const seconds = (performance.now() - started) / 1000;
  if (process.env.BENCH_DEBUG) console.error(`download bytes=${bytes} seconds=${seconds.toFixed(2)}`);
  return { bytes, seconds, mbps: (bytes * 8) / seconds / 1e6 };
}

async function upload(url, megabytes) {
  const target = new URL(url);
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const payload = Buffer.alloc(Math.round(megabytes * 1024 * 1024), 0x61);
  const socket = await socksConnect({ host: target.hostname, port });
  const stream = target.protocol === 'https:' ? tlsConnect({ socket, servername: target.hostname }) : socket;
  if (target.protocol === 'https:') await new Promise((resolve, reject) => { stream.once('secureConnect', resolve); stream.once('error', reject); });
  const started = performance.now();
  stream.write(`POST ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\nUser-Agent: KartoshkaBench/1\r\nContent-Type: application/octet-stream\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`);
  await new Promise((resolve, reject) => {
    stream.write(payload, (error) => { if (error) reject(error); else resolve(); });
    stream.on('error', reject);
  });
  await new Promise((resolve) => { stream.on('close', resolve); stream.on('end', resolve); stream.setTimeout(30000, resolve); });
  const seconds = (performance.now() - started) / 1000;
  stream.destroy();
  return { bytes: payload.length, seconds, mbps: (payload.length * 8) / seconds / 1e6 };
}

const options = parseArgs();
PROXY = options.socks;
const result = { label: options.label, transport: options.label, socks: options.socks, file: options.file, at: new Date().toISOString(), ttfb: {}, download: null, upload: null, failures: [] };

const samples = [];
for (const domain of options.domainList.slice(0, options.samples)) {
  try { samples.push(await ttfb(domain)); }
  catch (error) { result.failures.push(`${domain}: ${error.message}`); }
}
result.ttfb = { samples: samples.length, median: median(samples), p95: percentile(samples, 95), values: samples.map(v => Math.round(v)) };
try { result.download = await download(options.file); } catch (error) { result.failures.push(`download: ${error.message}`); }
try { result.upload = await upload(options.file, options.upload); } catch (error) { result.failures.push(`upload: ${error.message}`); }

const round = (value, digits = 1) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const summary = {
  label: result.label,
  ttfbMedianMs: round(result.ttfb.median),
  ttfbP95Ms: round(result.ttfb.p95),
  ttfbSamples: result.ttfb.samples,
  downloadMbps: round(result.download?.mbps ?? NaN),
  uploadMbps: round(result.upload?.mbps ?? NaN),
  failures: result.failures.length
};
console.log(JSON.stringify(summary));
if (options.json) writeFileSync(options.json, JSON.stringify({ summary, ...result }, null, 2));
if (result.failures.length) console.error(result.failures.slice(0, 5).join('\n'));
