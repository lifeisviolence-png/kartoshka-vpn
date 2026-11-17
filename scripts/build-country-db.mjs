#!/usr/bin/env node
// Builds the bundled offline country database used by the desktop core.
//
// Input: DB-IP "country lite" CSV (start,end,country) for IPv4, either plain or
// gzip-compressed. Output: KCDB1, a sorted array of (start, end, country index)
// records. The file is gzip-compressed with Node's zlib, so the Rust core only
// needs a small inflate dependency.
//
// Data: IP Geolocation by DB-IP <https://db-ip.com> (CC BY 4.0).
// Run: node scripts/build-country-db.mjs <dbip.csv[.gz]> <out.bin.gz>
import { createReadStream } from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/build-country-db.mjs <dbip.csv[.gz]> <out.bin.gz>');
  process.exit(2);
}

const ipv4 = (value) => {
  const parts = String(value).trim().split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
};

const ranges = [];
const codes = new Set();
const stream = createReadStream(resolve(input));
const lines = createInterface({ input: input.endsWith('.gz') ? stream.pipe(createGunzip()) : stream, crlfDelay: Infinity });
for await (const line of lines) {
  const [start, end, code] = line.split(',');
  if (!code || code.length !== 2) continue;
  const first = ipv4(start);
  const last = ipv4(end);
  if (first === null || last === null || last < first) continue;
  ranges.push([first, last, code.toUpperCase()]);
  codes.add(code.toUpperCase());
}
ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

// Merge contiguous ranges of the same country; DB-IP splits them per block.
const merged = [];
for (const [start, end, code] of ranges) {
  const previous = merged[merged.length - 1];
  if (previous && previous[2] === code && start <= previous[1] + 1) {
    if (end > previous[1]) previous[1] = end;
  } else merged.push([start, end, code]);
}

const ordered = [...codes].sort();
const index = new Map(ordered.map((code, position) => [code, position]));
const header = Buffer.alloc(12);
header.write('KCDB', 0, 'ascii');
header.writeUInt16LE(1, 4);
header.writeUInt16LE(ordered.length, 6);
header.writeUInt32LE(merged.length, 8);
const body = Buffer.alloc(merged.length * 10);
merged.forEach(([start, end, code], position) => {
  const offset = position * 10;
  body.writeUInt32LE(start, offset);
  body.writeUInt32LE(end, offset + 4);
  body.writeUInt16LE(index.get(code), offset + 8);
});
const table = Buffer.concat(ordered.map((code) => Buffer.from(code, 'ascii')));
const packed = gzipSync(Buffer.concat([header, body, table]), { level: 9 });
writeFileSync(resolve(output), packed);
const source = readFileSync(resolve(output));
console.log(JSON.stringify({ ranges: ranges.length, merged: merged.length, countries: ordered.length, bytes: source.length }, null, 2));
