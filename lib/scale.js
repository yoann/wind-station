// Axis domains for the charts. Kept out of stats.js: that module is weather
// math, this one is presentation — how a data range becomes a readable scale.

import { min, max, circularDiff } from './stats.js';

const DEGREE_STEPS = [5, 10, 15, 30, 45, 90];

/**
 * Smallest step that keeps a span under `target` ticks. Defaults to the
 * 1/2/5 x 10^n ladder; pass `steps` for a scale with its own idea of a round
 * number (degrees want 15/30/45/90, not 20/50/100).
 */
export function niceStep(span, target = 6, steps = null) {
  if (!Number.isFinite(span) || span <= 0) return steps ? steps[0] : 1;
  const raw = span / target;
  if (steps) return steps.find((s) => s >= raw) ?? steps[steps.length - 1];
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

/**
 * Data range -> axis domain: a relative margin, a floor on the visible span so
 * a flat stretch does not zoom into sampling noise, an optional hard lower
 * bound, and edges rounded outward onto the tick step.
 */
export function paddedRange(lo, hi, { minSpan = 0, floor = null, pad = 0.1, steps = null } = {}) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new TypeError('paddedRange needs finite bounds');
  }
  if (hi < lo) [lo, hi] = [hi, lo];

  // A zero-width series still needs a margin, hence the minSpan-derived floor.
  const margin = Math.max((hi - lo) * pad, minSpan * 0.05);
  let min = lo - margin;
  let max = hi + margin;

  const short = minSpan - (max - min);
  if (short > 0) {
    min -= short / 2;
    max += short / 2;
  }

  // Clamping lifts the whole window rather than squashing it, so minSpan holds.
  if (floor !== null && min < floor) {
    max += floor - min;
    min = floor;
  }

  const step = niceStep(max - min, 6, steps);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  if (floor !== null && min < floor) min = floor;

  return { min, max, step };
}

/** A bearing mapped into the continuous space around `centre`, in (centre-180, centre+180]. */
export function unwrapDeg(centre, deg) {
  const d = circularDiff(centre, deg);
  return d === null ? null : centre + d;
}

/**
 * A bearing shifted by whole turns until it sits inside [min, min + 360).
 * A no-op for a narrow axis, where every point is already in range; it earns
 * its keep on a full-turn axis, whose bounds are snapped to the cardinals and
 * so no longer line up with the centre the points were unwrapped around.
 */
export function foldInto(v, min) {
  return v === null ? null : min + normDeg(v - min);
}

/** A bearing normalised back to 0-359, for labels on an unwrapped axis. */
export function normDeg(v) {
  return ((v % 360) + 360) % 360;
}

/**
 * Domain for the unwrapped direction axis. Same padding rules as paddedRange,
 * plus a hard cap of one full turn — beyond that the axis says nothing the
 * wind rose does not say better, so it stops widening and recentres.
 */
export function directionRange(values, centre, { minSpan = 60 } = {}) {
  const lo = min(values);
  const hi = max(values);
  if (lo === null) return fullTurn(centre);

  const r = paddedRange(lo, hi, { minSpan, steps: DEGREE_STEPS });
  if (r.max - r.min <= 360) return r;
  return fullTurn(centre);
}

/** A whole turn around `centre`, snapped so the ticks land on the cardinals. */
function fullTurn(centre) {
  const min = Math.round((centre - 180) / 90) * 90;
  return { min, max: min + 360, step: 90 };
}

/**
 * Breaks a folded direction series wherever consecutive points sit on opposite
 * edges of the axis. Only reachable on the full-turn axis, whose bounds are
 * snapped to the cardinals: there a 359 -> 002 step folds to a near-full-height
 * jump, and a line would draw the cliff the "direction is never a line chart"
 * rule exists to avoid. A null breaks the line instead. A no-op on the narrow
 * axis, where every step is small.
 */
export function breakWraps(points) {
  const out = [];
  let prev = null;
  for (const p of points) {
    if (p.y === null) {
      prev = null;
    } else if (prev !== null && Math.abs(p.y - prev) > 180) {
      out.push({ x: p.x, y: null });
      prev = p.y;
    } else {
      prev = p.y;
    }
    out.push(p);
  }
  return out;
}
