#!/usr/bin/env python3
"""Isolated Xray end-to-end tests; no user config or Windows network changes.

Run from the repository root: XRAY_BIN=/path/to/xray python3 tests/xray_local_integration.py
All credentials and servers are ephemeral and limited to the local computer.
"""
import base64
import http.server
import json
import os
import shutil
import socket
import socketserver
import subprocess
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
XRAY = os.environ.get('XRAY_BIN', 'xray')
UUID = '11111111-1111-4111-8111-111111111111'
PASSWORD = 'temporary-test-password-only'
BODY = b'kartoshka-xray-end-to-end-ok'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_listening(port, proc):
    for _ in range(100):
        if proc.poll() is not None:
            raise RuntimeError(f'Xray exited early, status {proc.returncode}')
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.15):
                return
        except OSError:
            time.sleep(0.05)
    raise RuntimeError(f'Xray did not listen on localhost:{port}')


def kill_process(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=4)


def create_client_config(url, path):
    script = """
import { parseSubscriptionDetailed } from './src/subscription.js';
import { buildXrayConfig } from './src/xray-config.js';
const parsed = parseSubscriptionDetailed(process.argv[1]);
if (parsed.errors.length || parsed.nodes.length !== 1)
  throw Error('Input was not parsed: ' + JSON.stringify(parsed.errors));
console.log(JSON.stringify(buildXrayConfig(parsed.nodes, parsed.nodes[0].id, 'all')));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', script, url], cwd=ROOT, capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError(f'Parser/generator failed: {result.stderr[-1000:]}')
    path.write_text(result.stdout)


def test_command(config):
    result = subprocess.run([XRAY, 'run', '-test', '-config', str(config)], capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError(f'Xray rejected generated config: {result.stderr[-1000:]} {result.stdout[-1000:]}')


class RequestHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(BODY)
    def log_message(self, *_):
        pass


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def request(target_port, proxy='http://127.0.0.1:2080'):
    return subprocess.run(['curl', '--silent', '--show-error', '--max-time', '4', '--noproxy', '', '--proxy', proxy, f'http://127.0.0.1:{target_port}/'], capture_output=True, timeout=7)


def make_server_config(inbound, path, target_port):
    conf = {'log': {'loglevel': 'info' if os.environ.get('XRAY_TEST_DEBUG') else 'warning'}, 'inbounds': [inbound], 'outbounds': [{'protocol': 'freedom', 'tag': 'direct', 'settings': {'finalRules': [{'action': 'allow', 'network': 'tcp', 'ip': ['127.0.0.1/32'], 'port': str(target_port)}]}}]}
    path.write_text(json.dumps(conf))


def make_cases(port):
    raw = lambda protocol, settings, stream=None: {
        'listen': '127.0.0.1', 'port': port, 'protocol': protocol, 'settings': settings,
        **({'streamSettings': stream} if stream else {})
    }
    vmess_data = {'v': '2', 'ps': 'local VMess', 'add': '127.0.0.1', 'port': str(port), 'id': UUID, 'aid': '0', 'scy': 'auto', 'net': 'tcp', 'tls': ''}
    vmess = 'vmess://' + base64.b64encode(json.dumps(vmess_data).encode()).decode()
    ss = base64.urlsafe_b64encode(f'aes-128-gcm:{PASSWORD}'.encode()).decode().rstrip('=')
    return [
        ('VLESS TCP', f'vless://{UUID}@127.0.0.1:{port}?type=tcp&security=none#local', raw('vless', {'clients': [{'id': UUID}], 'decryption': 'none'})),
        ('VLESS XHTTP', f'vless://{UUID}@127.0.0.1:{port}?type=xhttp&path=%2Ftest&security=none#local', raw('vless', {'clients': [{'id': UUID}], 'decryption': 'none'}, {'network': 'xhttp', 'xhttpSettings': {'path': '/test'}})),
        ('VMess TCP', vmess, raw('vmess', {'clients': [{'id': UUID}]})),
        ('Shadowsocks', f'ss://{ss}@127.0.0.1:{port}#local', raw('shadowsocks', {'method': 'aes-128-gcm', 'password': PASSWORD, 'network': 'tcp'})),
    ]


def make_reality_case(port, tmp):
    cert, key = tmp / 'test-cert.pem', tmp / 'test-key.pem'
    result = subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=example.test', '-addext', 'subjectAltName=DNS:example.test'], capture_output=True, timeout=20)
    if result.returncode:
        raise RuntimeError('Cannot generate local TLS fixture')
    generated = subprocess.check_output([XRAY, 'x25519'], text=True, timeout=10)
    private_key = public_key = None
    for line in generated.splitlines():
        if line.startswith('PrivateKey:'): private_key = line.split(':', 1)[1].strip()
        if line.startswith('Password (PublicKey):'): public_key = line.split(':', 1)[1].strip()
    if not private_key or not public_key:
        raise RuntimeError('Cannot create Reality test keys')
    tls_port = free_port()
    tls = subprocess.Popen(['openssl', 's_server', '-accept', f'127.0.0.1:{tls_port}', '-cert', str(cert), '-key', str(key), '-quiet'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_listening(tls_port, tls)
    except Exception:
        kill_process(tls)
        raise
    inbound = {'listen': '127.0.0.1', 'port': port, 'protocol': 'vless',
               'settings': {'clients': [{'id': UUID}], 'decryption': 'none'},
               'streamSettings': {'network': 'raw', 'security': 'reality', 'realitySettings': {
                   'target': f'127.0.0.1:{tls_port}', 'serverNames': ['example.test'],
                   'privateKey': private_key, 'shortIds': ['0123456789abcdef']}}}
    url = f'vless://{UUID}@127.0.0.1:{port}?type=tcp&security=reality&sni=example.test&fp=chrome&pbk={public_key}&sid=0123456789abcdef#local'
    return url, inbound, tls


def main():
    if not shutil.which(XRAY):
        raise SystemExit('XRAY_BIN must name the official Xray binary')
    for local_port in (2080, 2081):
        with socket.socket() as s:
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(('127.0.0.1', local_port))
            except OSError as exc:
                raise SystemExit(f'Port {local_port} is in use; refusing to disturb an existing service: {exc}')
    target = ThreadedHTTPServer(('127.0.0.1', 0), RequestHandler)
    threading.Thread(target=target.serve_forever, daemon=True).start()
    results = []
    with tempfile.TemporaryDirectory(prefix='kartoshka-xray-test-') as temp:
        tmp = Path(temp)
        for name in ('VLESS TCP', 'VLESS XHTTP', 'VLESS Reality', 'VMess TCP', 'Shadowsocks'):
            port = free_port()
            tls = None
            if name == 'VLESS Reality':
                url, inbound, tls = make_reality_case(port, tmp)
                label = name
            else:
                label, url, inbound = next(case for case in make_cases(port) if case[0] == name)
            server_file, client_file = tmp / 'server.json', tmp / 'client.json'
            make_server_config(inbound, server_file, target.server_port)
            server = client = None
            try:
                create_client_config(url, client_file)
                test_command(server_file)
                test_command(client_file)
                debug = os.environ.get('XRAY_TEST_DEBUG')
                if debug:
                    data = json.loads(client_file.read_text()); data['log']['loglevel'] = 'info'; client_file.write_text(json.dumps(data))
                server = subprocess.Popen([XRAY, 'run', '-config', str(server_file)], stdout=None if debug else subprocess.DEVNULL, stderr=None if debug else subprocess.DEVNULL)
                wait_listening(port, server)
                client = subprocess.Popen([XRAY, 'run', '-config', str(client_file)], stdout=None if debug else subprocess.DEVNULL, stderr=None if debug else subprocess.DEVNULL)
                wait_listening(2080, client)
                response = request(target.server_port)
                if response.returncode or response.stdout != BODY:
                    raise RuntimeError(f'HTTP proxy failed: {response.stderr.decode(errors="replace")[-400:]}')
                socks = request(target.server_port, 'socks5h://127.0.0.1:2081')
                if socks.returncode or socks.stdout != BODY:
                    raise RuntimeError(f'SOCKS proxy failed: {socks.stderr.decode(errors="replace")[-400:]}')
                # Stopping the simulated remote server must break the request. This
                # detects a mistaken direct outbound that would otherwise appear to work.
                kill_process(server)
                server = None
                failed = request(target.server_port)
                if failed.returncode == 0 and failed.stdout == BODY:
                    raise RuntimeError('Request still succeeded after remote server stopped (possible direct bypass)')
                print(f'PASS {label}: HTTP + SOCKS through server; no direct fallback', flush=True)
                results.append((label, True))
            except Exception as exc:
                print(f'FAIL {label}: {exc}', flush=True)
                results.append((label, False))
            finally:
                kill_process(client)
                kill_process(server)
                kill_process(tls)
    target.shutdown()
    if not all(ok for _, ok in results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
