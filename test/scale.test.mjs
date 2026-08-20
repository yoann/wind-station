import assert from 'node:assert/strict';
import test from 'node:test';

import { niceStep, paddedRange, directionRange, unwrapDeg, foldInto, normDeg } from '../lib/scale.js';
import { min, max, vectorMeanDeg } from '../lib/stats.js';

test('min mirrors max, nulls and all', () => {
  assert.equal(min([3, null, 1, NaN, 7]), 1);
  assert.equal(max([3, null, 1, NaN, 7]), 7);
  assert.equal(min([]), null);
  assert.equal(min([null, null]), null);
});

test('niceStep walks the 1/2/5 ladder', () => {
  assert.equal(niceStep(6), 1);
  assert.equal(niceStep(60), 10);
  assert.equal(niceStep(600), 100);
  assert.equal(niceStep(0), 1);
});

test('niceStep honours a custom ladder', () => {
  const steps = [5, 10, 15, 30, 45, 90];
  assert.equal(niceStep(90, 6, steps), 15);
  assert.equal(niceStep(10_000, 6, steps), 90); // never past the coarsest
});

test('a working breeze gets margin on both sides', () => {
  const r = paddedRange(12, 18, { minSpan: 5, floor: 0 });
  assert.ok(r.min > 0, `min ${r.min}`);
  assert.ok(r.min < 12 && r.max > 18);
});

test('a flat stretch keeps a readable span instead of zooming into noise', () => {
  const r = paddedRange(8.0, 8.4, { minSpan: 5, floor: 0 });
  assert.ok(r.max - r.min >= 5, `${r.max - r.min}`);
  assert.ok(r.min <= 8.0 && r.max >= 8.4);
});

test('a single repeated value still yields a non-zero domain', () => {
  const r = paddedRange(7, 7, { minSpan: 5, floor: 0 });
  assert.ok(r.max > r.min);
  assert.ok(r.min < 7 && r.max > 7);
});

test('the floor lifts the window rather than squashing it', () => {
  const r = paddedRange(0, 1, { minSpan: 5, floor: 0 });
  assert.equal(r.min, 0);
  assert.ok(r.max - r.min >= 5, `${r.max - r.min}`);
});

test('bounds land on the tick step', () => {
  const r = paddedRange(12, 18, { minSpan: 5, floor: 0 });
  assert.equal(r.min % r.step, 0);
  assert.equal(r.max % r.step, 0);
});

test('reversed bounds are tolerated', () => {
  assert.deepEqual(paddedRange(18, 12, { minSpan: 5 }), paddedRange(12, 18, { minSpan: 5 }));
});

test('unwrapping a northerly gives one band, not two', () => {
  const bearings = [355, 358, 2, 6, 1];
  const centre = vectorMeanDeg(bearings);
  const ys = bearings.map((d) => unwrapDeg(centre, d));
  assert.ok(ys.every((y) => Math.abs(y - centre) <= 180));
  assert.ok(max(ys) - min(ys) < 15, `span ${max(ys) - min(ys)}`);

  const r = directionRange(ys, centre);
  assert.ok(r.max - r.min < 360);
  assert.ok(ys.every((y) => y >= r.min && y <= r.max));
});

test('a steady sea breeze narrows the axis but keeps a floor', () => {
  const centre = 265;
  const ys = [249, 250, 251].map((d) => unwrapDeg(centre, d));
  const r = directionRange(ys, centre, { minSpan: 60 });
  assert.ok(r.max - r.min >= 60, `${r.max - r.min}`);
  assert.ok(r.max - r.min < 120);
});

test('a shifty day falls back to a full turn around the mean', () => {
  const centre = 180;
  const ys = [10, 90, 180, 270, 350].map((d) => unwrapDeg(centre, d));
  const r = directionRange(ys, centre);
  assert.equal(r.max - r.min, 360);
  assert.ok(ys.every((y) => y >= r.min && y <= r.max));
  // A whole turn should still label the cardinals, not 194 / 284 / 014.
  assert.ok(Number.isInteger(r.min / 90), `min ${r.min}`);
  assert.equal(r.step, 90);
});

test('an empty direction series still yields a usable domain', () => {
  const r = directionRange([], 90);
  assert.equal(r.max - r.min, 360);
  assert.ok(Number.isInteger(r.min / 90), `min ${r.min}`);
});

test('normDeg brings unwrapped labels home', () => {
  assert.equal(normDeg(-5), 355);
  assert.equal(normDeg(370), 10);
  assert.equal(normDeg(0), 0);
  assert.equal(unwrapDeg(0, null), null);
});

test('folding keeps every point inside a snapped full-turn axis', () => {
  const centre = 13.5;
  const bearings = [5, 60, 150, 190, 200, 280, 350];
  const ys = bearings.map((d) => unwrapDeg(centre, d));
  const r = directionRange(ys, centre);
  assert.ok(ys.some((y) => y > r.max), 'fixture should overflow the snapped window');

  const folded = ys.map((y) => foldInto(y, r.min));
  assert.ok(folded.every((y) => y >= r.min && y <= r.max));
  assert.deepEqual(folded.map(normDeg), bearings, 'folding must not change the bearing');
});

test('folding is a no-op on a narrow axis', () => {
  const centre = 265;
  const ys = [240, 255, 262, 271, 290].map((d) => unwrapDeg(centre, d));
  const r = directionRange(ys, centre, { minSpan: 60 });
  assert.deepEqual(ys.map((y) => foldInto(y, r.min)), ys);
});
