import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer, connect } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSubscriptionDetailed } from '../src/subscription.js';
import { buildXrayConfig } from '../src/xray-config.js';

async function listen(server, port = 0) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); return server.address().port; }
async function stop(server) { if (server.listening) await new Promise(resolve => server.close(resolve)); }
async function freePort() { const s = createTcpServer(); const p = await listen(s); await stop(s); return p; }
async function waitForPort(port, proc) {
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw new Error('Xray завершился до начала теста');
    const ok = await new Promise(resolve => { const s = connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
    if (ok) return; await delay(50);
  }
  throw new Error('Xray не открыл локальный порт');
}
async function exchange(port, request, marker) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'); let text = '';
    socket.setTimeout(3000); socket.on('connect', () => socket.write(request));
    socket.on('data', data => { text += data.toString(); if (text.includes(marker)) { socket.destroy(); resolve(text); } });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); }); socket.on('error', reject); socket.on('close', () => { if (!text.includes(marker)) reject(new Error('connection closed')); });
  });
}
function processDone(proc) { return new Promise(resolve => { if (proc.exitCode !== null || proc.signalCode !== null) resolve(); else proc.once('exit', resolve); }); }
async function udpPort() { const s = createSocket('udp4'); await new Promise(resolve => s.bind(0, '127.0.0.1', resolve)); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
async function httpTunnel(targetPort, host = '127.0.0.1') {
  const socket = connect(2080, '127.0.0.1');
  return new Promise((resolve,reject) => {
    let stage = 0, text = '', done = false;
    socket.setTimeout(5000);
    socket.on('connect', () => socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`));
    socket.on('data', data => { text += data.toString(); if (!stage && text.includes('\r\n\r\n')) { if (!/^HTTP\/1\.[01] 200/.test(text)) return reject(new Error('CONNECT не принят')); stage = 1; text = ''; socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'); } else if (stage && text.includes('integration-ok')) { done = true; socket.destroy(); resolve(text); } });
    socket.on('close', () => { if (!done) reject(new Error('соединение закрыто')); });
    socket.on('error', reject); socket.on('timeout', () => { socket.destroy(); reject(new Error('CONNECT timeout')); });
  });
}

test('реальные HTTP CONNECT и SOCKS5 проходят через выбранный VLESS; без сервера прямого обхода нет', { skip: !process.env.XRAY_TEST_BIN, timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kartovpn-e2e-')); let upstream, client, http;
  try {
    let requests = 0;
    http = createHttpServer((_req, res) => { requests++; res.end('integration-ok'); });
    const targetPort = await listen(http), upstreamPort = await freePort();
    const uuid = '22222222-2222-4222-8222-222222222222'; // Public fixture, not a credential.
    const serverConfig = { log:{loglevel:'none'}, inbounds:[{listen:'127.0.0.1',port:upstreamPort,protocol:'vless',settings:{clients:[{id:uuid}],decryption:'none'}}], outbounds:[{protocol:'freedom',settings:{finalRules:[{action:'allow',network:'tcp',ip:['127.0.0.1/32'],port:String(targetPort)}]}}] };
    const node = parseSubscriptionDetailed(`vless://${uuid}@127.0.0.1:${upstreamPort}?type=tcp&security=none#local`).nodes[0];
    assert.ok(node);
    const clientConfig = buildXrayConfig([node], node.id, 'all'); clientConfig.log.loglevel = 'none';
    const serverPath = join(dir,'server.json'), clientPath = join(dir,'client.json');
    writeFileSync(serverPath, JSON.stringify(serverConfig), {mode:0o600}); writeFileSync(clientPath, JSON.stringify(clientConfig), {mode:0o600});
    upstream = spawn(process.env.XRAY_TEST_BIN, ['run','-config',serverPath], {stdio:'ignore'}); await waitForPort(upstreamPort, upstream);
    client = spawn(process.env.XRAY_TEST_BIN, ['run','-config',clientPath], {stdio:'ignore'}); await waitForPort(2080, client); await waitForPort(2081, client);
    const socket = connect(2080, '127.0.0.1');
    const response = await new Promise((resolve,reject) => {
      let stage = 0, text = '';
      socket.setTimeout(4000); socket.on('connect', () => socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`));
      socket.on('data', data => { text += data.toString(); if (!stage && text.includes('\r\n\r\n')) { if (!/^HTTP\/1\.[01] 200/.test(text)) return reject(new Error('CONNECT не принят')); stage = 1; text = ''; socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'); } else if (stage && text.includes('integration-ok')) { socket.destroy(); resolve(text); } });
      socket.on('error', reject); socket.on('timeout', () => { socket.destroy(); reject(new Error('CONNECT timeout')); });
    });
    assert.match(response, /integration-ok/); assert.equal(requests, 1);
    const socks = connect(2081, '127.0.0.1');
    await new Promise((resolve,reject) => {
      let stage = 0, buffer = Buffer.alloc(0);
      socks.setTimeout(4000); socks.on('connect', () => socks.write(Buffer.from([5,1,0])));
      socks.on('data', data => { buffer = Buffer.concat([buffer,data]);
        if (stage === 0 && buffer.length >= 2) { if (buffer[1] !== 0) return reject(new Error('SOCKS auth')); buffer = buffer.subarray(2); stage = 1; socks.write(Buffer.from([5,1,0,1,127,0,0,1,targetPort >> 8,targetPort & 255])); }
        else if (stage === 1 && buffer.length >= 10) { if (buffer[1] !== 0) return reject(new Error('SOCKS connect')); buffer = buffer.subarray(10); stage = 2; socks.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'); }
        else if (stage === 2 && buffer.includes(Buffer.from('integration-ok'))) { socks.destroy(); resolve(); }
      });
      socks.on('error', reject); socks.on('timeout', () => { socks.destroy(); reject(new Error('SOCKS timeout')); });
    });
    assert.equal(requests, 2);
    upstream.kill(); await processDone(upstream); upstream = null;
    try { await exchange(2080, `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\nGET / HTTP/1.1\r\nHost: localhost\r\n\r\n`, 'integration-ok'); assert.fail('Proxy bypassed the unavailable selected server'); } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; }
    assert.equal(requests, 2);
  } finally {
    for (const proc of [client, upstream]) if (proc) { proc.kill(); await processDone(proc); }
    if (http) await stop(http);
    rmSync(dir, {recursive:true, force:true});
  }
});

test('реальный локальный Hysteria2 + Salamander с pinSHA256 передаёт HTTP CONNECT', { skip: !process.env.XRAY_TEST_BIN, timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kartovpn-hy2-')); let upstream, client, http;
  try {
    const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
    const gen = spawnSync('openssl', ['req','-x509','-newkey','rsa:2048','-keyout',key,'-out',cert,'-days','1','-nodes','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'], {stdio:'ignore'});
    assert.equal(gen.status, 0, 'Тесту нужен openssl');
    const der = spawnSync('openssl', ['x509','-in',cert,'-outform','der']); assert.equal(der.status, 0);
    const pin = createHash('sha256').update(der.stdout).digest('hex');
    http = createHttpServer((_req,res) => res.end('integration-ok'));
    const targetPort = await listen(http), port = await udpPort();
    const serverConfig = { log:{loglevel:'none'}, inbounds:[{ listen:'127.0.0.1', port, protocol:'hysteria', settings:{version:2,users:[{auth:'fixture-auth'}]}, streamSettings:{ network:'hysteria', security:'tls', tlsSettings:{certificates:[{certificateFile:cert,keyFile:key}]}, hysteriaSettings:{version:2}, finalmask:{udp:[{type:'salamander',settings:{password:'fixture-mask'}}]} } }], outbounds:[{protocol:'freedom',settings:{finalRules:[{action:'allow',network:'tcp',ip:['127.0.0.1/32'],port:String(targetPort)}]}}] };
    const node = parseSubscriptionDetailed(`hy2://fixture-auth@127.0.0.1:${port}?sni=localhost&pinSHA256=${pin}&obfs=salamander&obfs-password=fixture-mask#local`).nodes[0];
    assert.ok(node); assert.ok(!node.unsupported);
    const config = buildXrayConfig([node], node.id, 'all'); config.log.loglevel = 'none';
    const serverPath = join(dir,'server.json'), clientPath = join(dir,'client.json');
    writeFileSync(serverPath, JSON.stringify(serverConfig), {mode:0o600}); writeFileSync(clientPath, JSON.stringify(config), {mode:0o600});
    upstream = spawn(process.env.XRAY_TEST_BIN, ['run','-config',serverPath], {stdio:'ignore'}); await delay(200); assert.equal(upstream.exitCode, null);
    client = spawn(process.env.XRAY_TEST_BIN, ['run','-config',clientPath], {stdio:'ignore'}); await waitForPort(2080, client);
    assert.match(await httpTunnel(targetPort), /integration-ok/);
  } finally {
    for (const proc of [client,upstream]) if (proc) { proc.kill(); await processDone(proc); }
    if (http) await stop(http);
    rmSync(dir, {recursive:true, force:true});
  }
});

test('split отправляет .ru напрямую, а не-RU — выбранному неработающему прокси', { skip: !process.env.XRAY_TEST_BIN, timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kartovpn-split-')); let client, http;
  try {
    let requests = 0; http = createHttpServer((_req,res) => { requests++; res.end('integration-ok'); });
    const targetPort = await listen(http), port = await freePort();
    const node = parseSubscriptionDetailed(`vless://33333333-3333-4333-8333-333333333333@127.0.0.1:${port}?security=none#fixture`).nodes[0];
    const config = buildXrayConfig([node], node.id, 'split'); config.log.loglevel = 'none';
    // Test-only deterministic DNS: no external queries or changes to the host resolver.
    config.dns = { hosts: { 'split-fixture.ru':'127.0.0.1', 'proxy-fixture.invalid':'127.0.0.1' } };
    config.outbounds[1].streamSettings = { sockopt:{domainStrategy:'UseIPv4'} };
    const path = join(dir,'client.json'); writeFileSync(path, JSON.stringify(config), {mode:0o600});
    client = spawn(process.env.XRAY_TEST_BIN, ['run','-config',path], {stdio:'ignore'}); await waitForPort(2080, client);
    assert.match(await httpTunnel(targetPort, 'split-fixture.ru'), /integration-ok/); assert.equal(requests, 1);
    await assert.rejects(httpTunnel(targetPort, 'proxy-fixture.invalid')); assert.equal(requests, 1);
  } finally {
    if (client) { client.kill(); await processDone(client); }
    if (http) await stop(http);
    rmSync(dir, {recursive:true, force:true});
  }
});
