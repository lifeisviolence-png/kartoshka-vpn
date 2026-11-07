import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dictionaryFor } from '../src/i18n.js';

const ru = dictionaryFor('ru');
const en = dictionaryFor('en');
const cyrillic = /[А-Яа-яЁё]/;
// Removes line and block comments, including trailing ones, without touching strings.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}
const uiFiles = ['src/main.js', 'src/desktop-bridge.js'];

test('словари RU и EN содержат одинаковые ключи без пустых значений', () => {
  const ruKeys = Object.keys(ru).sort(), enKeys = Object.keys(en).sort();
  const ruSet = new Set(ruKeys), enSet = new Set(enKeys);
  assert.deepEqual(enKeys, ruKeys, `key mismatch: ${ruKeys.filter(k => !enSet.has(k)).join(', ')} | ${enKeys.filter(k => !ruSet.has(k)).join(', ')}`);
  for (const key of ruKeys) {
    assert.ok(String(ru[key]).trim(), `empty RU value: ${key}`);
    assert.ok(String(en[key]).trim(), `empty EN value: ${key}`);
  }
});

test('в английском словаре нет русских значений, кроме названия языка', () => {
  const offenders = Object.entries(en).filter(([key, value]) => cyrillic.test(String(value)) && key !== 'settings.languageRu');
  assert.deepEqual(offenders, []);
});

test('в коде интерфейса не осталось русских литералов', () => {
  for (const file of uiFiles) {
    const source = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    const lines = source.split('\n').map((line, index) => [index + 1, line]).filter(([, line]) => cyrillic.test(line));
    assert.deepEqual(lines, [], `${file}: ${lines.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`).join('\n')}`);
  }
});

test('каждый ключ t(...) в интерфейсе существует в обоих словарях', () => {
  const missing = [];
  for (const file of uiFiles) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) {
      const key = match[1];
      if (!(key in ru) || !(key in en)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('у каждой ошибки парсера и конфига есть перевод в обоих словарях', () => {
  const codes = new Set();
  for (const file of ['src/subscription.js', 'src/xray-config.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\b(?:issue|failCode)\(\s*'([a-zA-Z0-9_.]+)'/g)) codes.add(match[1]);
    for (const match of source.matchAll(/code = '([a-zA-Z0-9_.]+)'/g)) codes.add(match[1]);
  }
  const missing = [...codes].filter((code) => !(`err.${code}` in ru) || !(`err.${code}` in en));
  assert.ok(codes.size > 40, `expected a broad code set, got ${codes.size}`);
  assert.deepEqual(missing.sort(), []);
});

test('динамические ключи маршрутизации Happ существуют во всех вариантах', () => {
  for (const reason of ['shape', 'fields', 'type', 'target', 'extDomain', 'port', 'network', 'empty']) {
    assert.ok(`err.sub.routing.${reason}` in ru, `ru: routing.${reason}`);
    assert.ok(`err.sub.routing.${reason}` in en, `en: routing.${reason}`);
  }
});
