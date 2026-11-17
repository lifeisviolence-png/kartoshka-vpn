import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the interface version matches every build manifest', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read('package.json')).version, VERSION);
  assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, VERSION);
  assert.match(read('src-tauri/Cargo.toml'), new RegExp(`^version = "${VERSION.replace(/\./g, '\\.')}"$`, 'm'));
});

test('the changelog documents the current version', () => {
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, new RegExp(`^## v${VERSION.replace(/\./g, '\\.')}`, 'm'), 'add a changelog entry before releasing');
});
