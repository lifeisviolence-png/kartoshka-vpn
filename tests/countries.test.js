import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES, countryByCode, countryLabel, flagPath, detectCountry, emojiCountry, isoCountry, nameCountry, groupByCountry, bestPing } from '../src/countries.js';

test('the country table has unique ISO codes and both labels', () => {
  const codes = COUNTRIES.map((country) => country.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const country of COUNTRIES) {
    assert.match(country.code, /^[a-z]{2}$/);
    assert.ok(country.ru.trim(), country.code);
    assert.ok(country.en.trim(), country.code);
    assert.equal([...country.emoji].length, 2, country.code);
  }
});

test('a flag emoji wins over every text hint', () => {
  assert.equal(detectCountry('🇳🇱 Amsterdam').code, 'nl');
  assert.equal(detectCountry('🇳🇱 Amsterdam').source, 'emoji');
  assert.equal(emojiCountry('🇩🇪 Frankfurt'), 'de');
  assert.equal(emojiCountry('no flag here'), '');
  assert.equal(emojiCountry('🇽🇽 nowhere'), '', 'an unknown pair is not a country');
});

test('country names are recognised in Russian and English, longest match first', () => {
  assert.equal(detectCountry('PL-1PL Польша Vless').code, 'pl');
  assert.equal(detectCountry('Germany Frankfurt').code, 'de');
  assert.equal(detectCountry('Южная Корея Seoul').code, 'kr', 'the longer name beats "Корея"');
  assert.equal(nameCountry('Нидерланды'), 'nl');
  assert.equal(detectCountry('Сервер без локации').code, '');
});

test('ISO codes count only as explicit uppercase tokens', () => {
  assert.equal(isoCountry('DE-1'), 'de');
  assert.equal(isoCountry('[NL] edge'), 'nl');
  assert.equal(isoCountry('NODE_US_2'), 'us');
  assert.equal(isoCountry('node_us_2'), '', 'lowercase tokens are ambiguous');
  assert.equal(isoCountry('in the middle'), '', 'lowercase words are not codes');
  assert.equal(isoCountry('no'), '');
  assert.equal(detectCountry('in the middle').code, '');
});

test('well-known cities are the last text hint', () => {
  assert.equal(detectCountry('Frankfurt am Main').code, 'de');
  assert.equal(detectCountry('Amsterdam-01').code, 'nl');
  assert.equal(detectCountry('Tokyo edge').code, 'jp');
});

test('labels and flag paths follow the selected language', () => {
  assert.equal(countryLabel('de', 'ru'), 'Германия');
  assert.equal(countryLabel('de', 'en'), 'Germany');
  assert.equal(flagPath('de'), '/flags/de.svg');
  assert.equal(flagPath('xx'), '');
  assert.equal(countryByCode('DE').code, 'de');
});

test('grouping keeps countries ordered by their best latency and the unknown bucket last', () => {
  const nodes = [
    { id: '1', countryCode: 'de', ping: 120 },
    { id: '2', countryCode: 'de', ping: 40 },
    { id: '3', countryCode: 'nl', ping: 80 },
    { id: '4', countryCode: '', ping: 10 },
    { id: '5', countryCode: 'de', ping: null }
  ];
  const groups = groupByCountry(nodes, 'ru');
  assert.deepEqual(groups.map((group) => group.code), ['de', 'nl', '']);
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].ping, 40);
  assert.equal(groups[0].name, 'Германия');
  assert.equal(groups[2].name, '');
  assert.equal(bestPing([{ ping: null }, { ping: 7 }]), 7);
  assert.equal(bestPing([{ ping: null }]), null);
});
