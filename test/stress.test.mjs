// The real sample day is gentle and narrow: 7-11 kn from three sectors.
// A display that looks right there can still fail at gale force, across a full
// direction sweep, or with the station powered down mid-file. This fixture
// (test/make-stress-fixture.py) covers those.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLogBytes } from '../lib/parser.js';
import { tally, BANDS } from '../lib/rose.js';
import { summarise, beaufort, windowRows } from '../lib/stats.js';

const here = dirname(fileURLToPath(import.meta.url));
const { rows, skipped } = parseLogBytes(
  readFileSync(join(here, '..', 'sample', 'SsLog-18-08-2026.csv')),
);

test('multiple session headers are all skipped', () => {
  assert.ok(skipped.header >= 3, `expected repeated headers, got ${skipped.header}`);
  assert.equal(skipped.malformed, 0);
  assert.ok(rows.length > 1500);
});

test('gale-force speeds survive parsing', () => {
  const tws = rows.map((r) => r.tws);
  assert.ok(Math.max(...tws) > 35, `expected gale force, got ${Math.max(...tws)}`);
  assert.equal(beaufort(Math.max(...tws)).force >= 8, true);
});

test('the outage gap is preserved, not interpolated away', () => {
  const gaps = rows.slice(1).map((r, i) => (r.t - rows[i].t) / 1000);
  const biggest = Math.max(...gaps);
  assert.ok(biggest > 2000, `expected a long outage, got ${biggest}s`);
  // No synthetic rows were invented to fill it
  assert.equal(rows.filter((r) => r.tws === null).length, 0);
});

test('rose fills all 16 sectors and multiple bands', () => {
  const { matrix, sectorTotals, total } = tally(rows);
  assert.equal(sectorTotals.filter((v) => v > 0).length, 16);
  assert.ok(matrix.flat().filter((v) => v > 0).length > 30);
  const sum = sectorTotals.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 0.001, `percentages should total 100, got ${sum}`);
  assert.ok(total > 1500);
});

test('every sample lands in exactly one speed band', () => {
  for (const r of rows) {
    const hits = BANDS.filter((b) => r.tws >= b.min && r.tws < b.max);
    assert.equal(hits.length, 1, `${r.tws} kn matched ${hits.length} bands`);
  }
});

test('summary is computed against the newest sample, not wall-clock now', () => {
  const s = summarise(rows);
  assert.equal(s.latest.t, rows.at(-1).t);
  assert.equal(s.tws, rows.at(-1).tws);
  // the 60-minute window must not reach across the whole file
  const w = windowRows(rows, rows.at(-1).t, 60);
  assert.ok(w.length < rows.length);
  assert.ok(w.at(-1).t - w[0].t <= 3600 * 1000);
});
