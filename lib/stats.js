// Derived values. Every window is a TIME window against parsed timestamps —
// the device samples at 17-33s, so "the last 15 minutes" is never "the last N rows".

export const MINUTE = 60_000;

/** Window behind the max and mean tiles. Both labels are derived from it. */
export const SUMMARY_MINUTES = 15;

/** Rows whose timestamp falls in (end - minutes, end]. */
export function windowRows(rows, endMs, minutes) {
  const start = endMs - minutes * MINUTE;
  return rows.filter((r) => r.t > start && r.t <= endMs);
}

export function mean(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function max(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
}

export function min(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? Math.min(...v) : null;
}

/**
 * Vector mean of bearings in degrees. Arithmetic mean of 350 and 010 gives 180 —
 * exactly backwards — so always go through unit vectors.
 */
export function vectorMeanDeg(degrees) {
  const v = degrees.filter((d) => d !== null && Number.isFinite(d));
  if (!v.length) return null;
  let sx = 0, sy = 0;
  for (const d of v) {
    const r = (d * Math.PI) / 180;
    sx += Math.sin(r);
    sy += Math.cos(r);
  }
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) return null;
  return (((Math.atan2(sx, sy) * 180) / Math.PI) + 360) % 360;
}

/** Signed shortest angular difference b - a, in (-180, 180]. Positive = veering. */
export function circularDiff(a, b) {
  if (a === null || b === null) return null;
  let d = ((b - a + 540) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}

const BEAUFORT = [
  { max: 1, force: 0, label: 'calm' },
  { max: 3, force: 1, label: 'light air' },
  { max: 6, force: 2, label: 'light breeze' },
  { max: 10, force: 3, label: 'gentle breeze' },
  { max: 16, force: 4, label: 'moderate breeze' },
  { max: 21, force: 5, label: 'fresh breeze' },
  { max: 27, force: 6, label: 'strong breeze' },
  { max: 33, force: 7, label: 'near gale' },
  { max: 40, force: 8, label: 'gale' },
  { max: 47, force: 9, label: 'strong gale' },
  { max: 55, force: 10, label: 'storm' },
  { max: 63, force: 11, label: 'violent storm' },
  { max: Infinity, force: 12, label: 'hurricane force' },
];

/** Knots -> { force, label }. */
export function beaufort(knots) {
  if (knots === null || !Number.isFinite(knots)) return null;
  return BEAUFORT.find((b) => knots < b.max) ?? BEAUFORT[BEAUFORT.length - 1];
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Degrees -> 16-point cardinal. */
export function cardinal16(deg) {
  if (deg === null || !Number.isFinite(deg)) return null;
  return POINTS[Math.round((deg % 360) / 22.5) % 16];
}

export const UNITS = {
  kn: { label: 'kn', factor: 1, decimals: 1 },
  ms: { label: 'm/s', factor: 0.514444, decimals: 1 },
  kmh: { label: 'km/h', factor: 1.852, decimals: 1 },
};

/** Convert a knots value into the chosen display unit. */
export function convert(knots, unit) {
  if (knots === null || !Number.isFinite(knots)) return null;
  const u = UNITS[unit] ?? UNITS.kn;
  return knots * u.factor;
}

export function formatSpeed(knots, unit) {
  const v = convert(knots, unit);
  if (v === null) return '--';
  return v.toFixed((UNITS[unit] ?? UNITS.kn).decimals);
}

/**
 * Everything the hero and tiles need, computed from the full row set.
 * `now` defaults to the newest sample so historic days summarise correctly.
 */
export function summarise(rows, nowMs = null) {
  const withWind = rows.filter((r) => r.tws !== null);
  if (!withWind.length) return null;

  const latest = withWind[withWind.length - 1];
  const end = nowMs ?? latest.t;

  const w10 = windowRows(withWind, end, 10);
  const recent = windowRows(withWind, end, SUMMARY_MINUTES);
  const prev10 = windowRows(withWind, end - 10 * MINUTE, 10);
  const w5 = windowRows(withWind, end, 5);

  const dirNow = vectorMeanDeg(w5.map((r) => r.twd));
  const dirThen = vectorMeanDeg(windowRows(withWind, end - 30 * MINUTE, 5).map((r) => r.twd));

  const mean10 = mean(w10.map((r) => r.tws));
  const meanPrev10 = mean(prev10.map((r) => r.tws));

  return {
    latest,
    tws: latest.tws,
    twd: latest.twd,
    dirSmoothed: dirNow ?? latest.twd,
    maxRecent: max(recent.map((r) => r.tws)),
    meanRecent: mean(recent.map((r) => r.tws)),
    trend: mean10 !== null && meanPrev10 !== null ? mean10 - meanPrev10 : null,
    shift: circularDiff(dirThen, dirNow),
    beaufort: beaufort(latest.tws),
    cardinal: cardinal16(dirNow ?? latest.twd),
    sampleCount: withWind.length,
  };
}

/** Freshness state from the age of the newest sample. */
export function freshness(latestMs, nowMs = Date.now()) {
  const age = nowMs - latestMs;
  if (age < 2 * MINUTE) return { state: 'live', age };
  if (age < 15 * MINUTE) return { state: 'delayed', age };
  return { state: 'offline', age };
}

/** Human age: "12s ago", "4 min ago", "3 h 20 min ago". */
export function formatAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
}
