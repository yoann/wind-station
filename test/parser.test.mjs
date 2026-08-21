import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLogBytes, parseTimestamp, parseDegMin, parseBearing, parseNumber, dateFromFilename } from '../lib/parser.js';
import { vectorMeanDeg, circularDiff, beaufort, cardinal16, summarise, windowRows, formatSpeed, mooredRows, rollingVectorMeanDeg } from '../lib/stats.js';

const here = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(here, '..', 'sample', 'SsLog-19-08-2026.csv'));
const { rows, station, skipped } = parseLogBytes(bytes);

test('fixture: row and skip counts match the real file', () => {
  assert.equal(rows.length, 211);
  assert.equal(skipped.header, 3);
  assert.equal(skipped.blank, 1);
  assert.equal(skipped.malformed, 0);
});

test('fixture: time span is 10:18:02 to 12:03:01 UTC', () => {
  assert.equal(new Date(rows[0].t).toISOString(), '2026-08-19T10:18:02.000Z');
  assert.equal(new Date(rows.at(-1).t).toISOString(), '2026-08-19T12:03:01.000Z');
});

test('fixture: TWS and TWD ranges', () => {
  const tws = rows.map((r) => r.tws);
  assert.equal(Math.min(...tws), 7.3);
  assert.equal(Math.max(...tws), 11.2);
  const twd = rows.map((r) => r.twd);
  assert.equal(Math.min(...twd), 296);
  assert.equal(Math.max(...twd), 339);
});

test('fixture: 13 rows carry the null sentinel in SOG and COG', () => {
  assert.equal(rows.filter((r) => r.sog === null).length, 13);
  assert.equal(rows.filter((r) => r.cog === null).length, 13);
  // ...and no wind data was lost to it
  assert.equal(rows.filter((r) => r.tws === null).length, 0);
});

test('fixture: station position parsed from degrees-decimal-minutes', () => {
  assert.ok(Math.abs(station.lat - 38.318) < 0.001);
  assert.ok(Math.abs(station.lon - 26.6949) < 0.001);
});

test('fixture: sampling interval is irregular, so row counts are not time', () => {
  const gaps = rows.slice(1).map((r, i) => (r.t - rows[i].t) / 1000);
  assert.ok(Math.min(...gaps) < 30, 'expected some gaps under 30s');
  assert.ok(Math.max(...gaps) > 30, 'expected some gaps over 30s');
  // The last 120 rows happen to number the same as the last 60 minutes here,
  // but they do not COVER 60 minutes — they span 3571s. Counting rows drifts.
  const last120 = rows.slice(-120);
  const spanSec = (last120.at(-1).t - last120[0].t) / 1000;
  assert.notEqual(spanSec, 3600, '120 rows is not 60 minutes of data');
  assert.ok(Math.abs(spanSec - 3600) > 20, `expected drift from 3600s, got ${spanSec}s`);
});

test('dd/mm/yyyy is never handed to Date()', () => {
  assert.equal(parseTimestamp('19/08/2026', '10:18:02 UTC'), Date.UTC(2026, 7, 19, 10, 18, 2));
  // the ambiguous case: this is 8 September, not 9 August
  assert.equal(parseTimestamp('08/09/2026', '00:00:00 UTC'), Date.UTC(2026, 8, 8, 0, 0, 0));
  assert.equal(parseTimestamp('not a date', '10:00:00 UTC'), null);
});

test('sentinel never becomes zero', () => {
  assert.equal(parseNumber('- - - - -'), null);
  assert.equal(parseNumber('00.1'), 0.1);
  assert.equal(parseNumber('0'), 0);
  assert.equal(parseBearing('- - - - -'), null);
  assert.equal(parseBearing('306\u00B0 M'), 306);
  assert.equal(parseDegMin('- - - - -'), null);
});

test('south and west hemispheres negate', () => {
  assert.ok(Math.abs(parseDegMin("38\u00B0 19.080' S") + 38.318) < 0.001);
  assert.ok(Math.abs(parseDegMin("026\u00B0 41.698' W") + 26.6949) < 0.001);
});

test('circular mean does not average 350 and 010 into 180', () => {
  const m = vectorMeanDeg([350, 10]);
  assert.ok(m < 1 || m > 359, `expected ~0 degrees, got ${m}`);
  assert.equal(Math.round(vectorMeanDeg([90, 110])), 100);
  assert.equal(vectorMeanDeg([null, null]), null);
});

test('circular difference is signed and shortest-path', () => {
  assert.equal(circularDiff(350, 10), 20);   // veering through north
  assert.equal(circularDiff(10, 350), -20);  // backing through north
  assert.equal(circularDiff(100, 130), 30);
});

test('beaufort and cardinal', () => {
  assert.equal(beaufort(9.2).force, 3);
  assert.equal(beaufort(18).label, 'fresh breeze');
  assert.equal(beaufort(0.5).force, 0);
  assert.equal(cardinal16(306), 'NW');    // 306 is 9 deg from NW, 13.5 from WNW
  assert.equal(cardinal16(300), 'WNW');
  assert.equal(cardinal16(0), 'N');
  assert.equal(cardinal16(359), 'N');
});

test('unit conversion', () => {
  assert.equal(formatSpeed(10, 'kn'), '10.0');
  assert.equal(formatSpeed(10, 'ms'), '5.1');
  assert.equal(formatSpeed(10, 'kmh'), '18.5');
  assert.equal(formatSpeed(null, 'kn'), '--');
});

test('summary over the fixture', () => {
  const s = summarise(rows);
  assert.equal(s.tws, 8.7);
  assert.equal(s.twd, 327);
  assert.equal(s.sampleCount, 211);
  assert.ok(s.maxRecent >= s.meanRecent);
  assert.ok(s.shift !== null);
});

test('filename date is dd-mm-yyyy', () => {
  assert.equal(dateFromFilename('SsLog-19-08-2026.csv').iso, '2026-08-19');
  assert.equal(dateFromFilename('nope.csv'), null);
});

test('empty and header-only input does not throw', () => {
  assert.equal(parseLogBytes(Buffer.from('')).rows.length, 0);
  assert.equal(parseLogBytes(Buffer.from("'Date, 'Time, 'TWS,\r\n")).rows.length, 0);
});

test('mooredRows drops rows logged under way, keeps unknown SOG', () => {
  const sample = [
    { sog: 0.2 }, { sog: 2 }, { sog: 2.1 }, { sog: 11.4 }, { sog: null },
  ];
  const kept = mooredRows(sample, 2);
  // The threshold is a ceiling, not a cut: exactly 2.0 kn is still stationary.
  assert.deepEqual(kept.map((r) => r.sog), [0.2, 2, null]);
});

test('mooredRows leaves the moored fixture untouched', () => {
  // Every SOG in the real file is <= 0.4 kn — the boat never moved.
  assert.equal(mooredRows(rows, 2).length, 211);
});

test('mooredRows over a parsed under-way log', () => {
  // Neither sample file contains motion, so the filter is exercised here.
  const log = [
    "'Date, 'Time, 'Latitude, 'Longitude, 'SOG, 'COG, 'TWS, 'TWA, 'TWD, 'Comment, ",
    "19/08/2026, 10:00:00 UTC, 38\xB0 19.080' N, 026\xB0 41.698' E, 00.1, 355\xB0 M, 08.4, 026\xB0 Port, 306\xB0 M, , ",
    "19/08/2026, 10:00:30 UTC, 38\xB0 19.200' N, 026\xB0 41.900' E, 06.2, 090\xB0 M, 14.1, 040\xB0 Stbd, 100\xB0 M, , ",
    "19/08/2026, 10:01:00 UTC, 38\xB0 19.400' N, 026\xB0 42.100' E, 03.4, 090\xB0 M, 12.7, 040\xB0 Stbd, 110\xB0 M, , ",
    "19/08/2026, 10:01:30 UTC, 38\xB0 19.080' N, 026\xB0 41.698' E, - - - - -, - - - - -, 08.6, 026\xB0 Port, 308\xB0 M, , ",
  ].join('\r\n');
  const parsed = parseLogBytes(Buffer.from(log, 'latin1'));
  assert.equal(parsed.rows.length, 4);
  const kept = mooredRows(parsed.rows, 2);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((r) => r.tws), [8.4, 8.6]);
});

test('fixture: the first row of each logging session is marked, not dropped', () => {
  // Headers sit at lines 1, 2 and 5 of the real file. The first two are
  // consecutive, so they mark one row between them, not two.
  const marked = rows.filter((r) => r.sessionStart);
  assert.equal(rows.length, 211, 'the parser marks, it does not filter');
  assert.deepEqual(
    marked.map((r) => new Date(r.t).toISOString()),
    ['2026-08-19T10:18:02.000Z', '2026-08-19T10:19:00.000Z'],
  );
});

test('consecutive headers mark one row, and every other row is unmarked', () => {
  const log = [
    "'Date, 'Time, 'Latitude, 'Longitude, 'SOG, 'COG, 'TWS, 'TWA, 'TWD, 'Comment, ",
    "'Date, 'Time, 'Latitude, 'Longitude, 'SOG, 'COG, 'TWS, 'TWA, 'TWD, 'Comment, ",
    "19/08/2026, 10:00:00 UTC, 38\xB0 19.080' N, 026\xB0 41.698' E, 00.1, 355\xB0 M, 08.4, 026\xB0 Port, 306\xB0 M, , ",
    "19/08/2026, 10:00:30 UTC, 38\xB0 19.080' N, 026\xB0 41.698' E, 00.1, 355\xB0 M, 08.1, 043\xB0 Port, 305\xB0 M, , ",
    "'Date, 'Time, 'Latitude, 'Longitude, 'SOG, 'COG, 'TWS, 'TWA, 'TWD, 'Comment, ",
    "19/08/2026, 10:01:00 UTC, 38\xB0 19.081' N, 026\xB0 41.700' E, 00.1, 355\xB0 M, 08.0, 025\xB0 Port, 307\xB0 M, , ",
  ].join('\r\n');
  const parsed = parseLogBytes(Buffer.from(log, 'latin1'));
  assert.deepEqual(parsed.rows.map((r) => r.sessionStart), [true, false, true]);
});

test('rolling direction mean wraps through north instead of averaging backwards', () => {
  const rowsAt = (...pairs) => pairs.map(([min, twd]) => ({ t: min * 60_000, twd }));
  const out = rollingVectorMeanDeg(rowsAt([0, 355], [1, 5]), 5);
  assert.equal(out.length, 2);
  assert.equal(out[0], 355);
  assert.ok(out[1] < 1 || out[1] > 359, `expected ~0 degrees, got ${out[1]}`);
});

test('rolling direction mean uses a time window, not a row count', () => {
  // Four samples crowded into one minute, then one 10 minutes later: the last
  // window must hold only itself, however many rows preceded it.
  const rows5 = [
    { t: 0, twd: 100 }, { t: 20_000, twd: 100 }, { t: 40_000, twd: 100 },
    { t: 60_000, twd: 100 }, { t: 10 * 60_000, twd: 200 },
  ];
  const out = rollingVectorMeanDeg(rows5, 5);
  assert.equal(Math.round(out[3]), 100);
  assert.equal(Math.round(out[4]), 200, 'the 100-degree run has aged out');
});

test('rolling direction mean is null-safe and aligned to its input', () => {
  const rows5 = [
    { t: 0, twd: null }, { t: 30_000, twd: 90 }, { t: 60_000, twd: 110 },
  ];
  const out = rollingVectorMeanDeg(rows5, 5);
  assert.equal(out.length, 3);
  assert.equal(out[0], null, 'a window holding no bearing yields null, not 0');
  assert.equal(Math.round(out[1]), 90);
  assert.equal(Math.round(out[2]), 100);
  assert.deepEqual(rollingVectorMeanDeg([], 5), []);
});

test('rolling direction mean over the fixture tracks the dial', () => {
  // The line's right-hand end is the number under the dial: same window,
  // same maths. This is the coherence the shared SMOOTH_MINUTES buys.
  const out = rollingVectorMeanDeg(rows, 5);
  assert.equal(out.length, rows.length);
  assert.equal(Math.round(out.at(-1)), Math.round(summarise(rows).dirSmoothed));
});
