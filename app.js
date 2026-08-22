import { CONFIG } from './config.js';
import { parseLog, decodeLog, dateFromFilename, parseFirstFix } from './lib/parser.js';
import {
  summarise, freshness, formatAge, formatSpeed, UNITS, cardinal16, MINUTE, SUMMARY_MINUTES,
  TREND_MINUTES, SHIFT_MINUTES, SMOOTH_MINUTES,
  min, max, windowRows, vectorMeanDeg, rollingVectorMeanDeg, rollingMean, mooredRows,
} from './lib/stats.js';
import {
  paddedRange, directionRange, unwrapDeg, foldInto, normDeg, breakWraps,
} from './lib/scale.js';
import { fetchLatestMeta, listFiles, fetchFileBytes, fetchFileHead, describeError } from './lib/drive.js';
import { reverseGeocode, localityOf } from './lib/geocode.js';
import { renderRose, renderRoseLegend } from './lib/rose.js';
import { Chart } from './lib/chart.js';

const DEMO = !CONFIG.apiKey;
const DEMO_FILES = [
  { id: './sample/SsLog-19-08-2026.csv', name: 'SsLog-19-08-2026.csv' },
  { id: './sample/SsLog-18-08-2026.csv', name: 'SsLog-18-08-2026.csv' },
];
const MAG = CONFIG.directionsAreMagnetic ? '\u00B0 M' : '\u00B0';

// Axis tuning. Both are floors on the *visible* span: without them a steady
// breeze fills the panel with sampling noise. Speed is in knots and scaled to
// the display unit, so the axis behaves the same whichever unit is selected.
const SPEED_MIN_SPAN_KN = 5;
const DIR_MIN_SPAN_DEG = 60;
const DIR_CENTRE_MINUTES = 15;

// A load off the sample folder, or a warm Drive cache, resolves in a few frames.
// Dimming the page for one of them reads as a flicker, which is worse than no
// feedback at all, so the busy treatment waits this long before it shows.
const BUSY_DELAY = 180;

// Shown instead of "no data" when the file held readings but every one of them
// was logged while the boat was moving — a real state, not an outage.
const UNDER_WAY = 'Vessel under way \u2014 no station readings';
const underWayOnly = () => !state.rows.length && state.excluded > 0;

const state = {
  unit: CONFIG.defaultUnit,
  rows: [],
  rawText: '',
  fileMeta: null,       // { id, name, modifiedTime }
  excluded: 0,          // rows dropped because the vessel was under way
  warmup: 0,            // rows dropped as the instrument's first of a session
  viewingDay: '',       // '' = follow latest, otherwise a file id
  loading: false,       // a user-initiated fetch is in flight
  busy: false,          // ...and it has outlasted BUSY_DELAY, so say so on screen
  error: null,
  backoff: 0,
  places: new Map(),    // file id -> place name, or null once looked up in vain
  dayFiles: [],         // whatever the picker is currently showing
};

const el = (id) => document.getElementById(id);
let twsChart = null;
let twdChart = null;
let pollTimer = null;
let busyTimer = null;

/* -- formatting ----------------------------------------------------------- */

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', timeZone: CONFIG.timeZone, hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: CONFIG.timeZone,
});

const clockAt = (ms) => timeFmt.format(new Date(ms));
const unitLabel = () => UNITS[state.unit].label;

/* -- boot ----------------------------------------------------------------- */

function boot() {
  el('station-name').textContent = CONFIG.stationName;
  renderPlace();
  document.title = CONFIG.stationName;

  // Labels come from the constant so they cannot drift from the window.
  el('stat-max-label').textContent = `Max, last ${SUMMARY_MINUTES} min`;
  el('stat-mean-label').textContent = `Mean, last ${SUMMARY_MINUTES} min`;
  el('stat-trend-label').textContent = `Trend, ${TREND_MINUTES} min`;
  el('stat-shift-label').textContent = `Shift, ${SHIFT_MINUTES} min`;

  buildDialTicks();
  renderRoseLegend(el('rose-legend'));

  state.unit = new URLSearchParams(location.hash.slice(1)).get('units')
    || localStorage.getItem('units')
    || CONFIG.defaultUnit;
  if (!UNITS[state.unit]) state.unit = 'kn';
  el('unit-select').value = state.unit;

  el('unit-select').addEventListener('change', (e) => {
    state.unit = e.target.value;
    localStorage.setItem('units', state.unit);
    location.hash = `units=${state.unit}`;
    render();
  });

  el('day-select').addEventListener('change', (e) => {
    state.viewingDay = e.target.value;
    el('back-to-live').hidden = !state.viewingDay;
    clearFile();
    load({ force: true, busy: true });
  });

  el('back-to-live').addEventListener('click', () => {
    state.viewingDay = '';
    el('day-select').value = '';
    el('back-to-live').hidden = true;
    clearFile();
    load({ force: true, busy: true });
  });

  el('download').addEventListener('click', downloadCsv);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });

  if (DEMO) {
    el('banner').hidden = false;
    el('banner').textContent =
      'Demo mode — showing the bundled sample file. Add an API key in config.js to go live.';
  }

  load({ busy: true });
  setInterval(renderFreshness, 5000);
}

function buildDialTicks() {
  const g = el('dial-ticks');
  const ns = 'http://www.w3.org/2000/svg';
  for (let b = 0; b < 360; b += 10) {
    const major = b % 30 === 0;
    const rad = (b * Math.PI) / 180;
    const r1 = 92;
    const r2 = major ? 82 : 87;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', (100 + r1 * Math.sin(rad)).toFixed(2));
    line.setAttribute('y1', (100 - r1 * Math.cos(rad)).toFixed(2));
    line.setAttribute('x2', (100 + r2 * Math.sin(rad)).toFixed(2));
    line.setAttribute('y2', (100 - r2 * Math.cos(rad)).toFixed(2));
    line.setAttribute('opacity', major ? '0.8' : '0.35');
    g.append(line);
  }
}

/* -- loading -------------------------------------------------------------- */

async function load({ force = false, busy = false } = {}) {
  if (busy) beginBusy();
  try {
    if (DEMO) {
      const path = state.viewingDay || DEMO_FILES[0].id;
      if (state.fileMeta?.id === path && !force) return;
      const res = await fetch(path);
      if (!res.ok) throw new Error('sample file missing');
      const name = path.split('/').pop();
      ingest(await res.arrayBuffer(), { id: path, name, modifiedTime: '' });
      state.error = null;
      render();
      populateDayOptions(DEMO_FILES);
      resolvePlaces(DEMO_FILES);
      return;
    }

    let meta;
    if (state.viewingDay) {
      meta = state.fileIndex?.find((f) => f.id === state.viewingDay) ?? null;
      if (!meta) throw new Error('day not found');
      if (!force && state.fileMeta?.id === meta.id) { render(); return; }
    } else {
      meta = await fetchLatestMeta(CONFIG.folderId, CONFIG.apiKey);
      if (!meta) { state.error = 'no files in the folder'; render(); return; }
      // Cheap path: nothing changed, just refresh the clock.
      if (!force && state.fileMeta?.id === meta.id
          && state.fileMeta?.modifiedTime === meta.modifiedTime) {
        state.error = null;
        renderFreshness();
        scheduleNext();
        return;
      }
    }

    const bytes = await fetchFileBytes(meta.id, CONFIG.apiKey);
    ingest(bytes, meta);
    state.error = null;
    state.backoff = 0;
    render();
    refreshDayIndex();
  } catch (err) {
    state.error = describeError(err);
    state.backoff = Math.min(state.backoff ? state.backoff * 2 : 1, 10);
    render();
  } finally {
    // Before scheduleNext, and before this function returns to whatever paints
    // next: leaving the flag up would repaint the pill as 'Loading' on data
    // that has already landed.
    if (busy) { endBusy(); renderFreshness(); }
    scheduleNext();
  }
}

function ingest(bytes, meta) {
  state.rawText = decodeLog(bytes);
  const { rows, station } = parseLog(state.rawText);
  // The first reading of each logging session is the instrument starting up.
  // Dropped before the SOG filter so it is counted here and not absorbed there.
  const running = rows.filter((r) => !r.sessionStart);
  state.warmup = rows.length - running.length;
  state.rows = mooredRows(running, CONFIG.maxSogKnots);
  state.excluded = running.length - state.rows.length;
  // The marker has to come from a stationary row too: a file that opens
  // mid-passage would otherwise pin the footer to wherever the boat was moving.
  const fixed = state.rows.find((r) => r.lat !== null && r.lon !== null);
  state.station = fixed ? { lat: fixed.lat, lon: fixed.lon } : station;
  state.fileMeta = meta;
  resolvePlaceFor(meta, state.station);
}

/**
 * Acknowledge a load the reader asked for. The stale panels dim and the pill
 * says why, but only once the wait is long enough to be worth mentioning:
 * `loading` goes up at once so assistive tech hears it, `busy` — the visible
 * half — waits out BUSY_DELAY. Background polls never call this; a poll must
 * not grey the page out or push the Live pill aside.
 */
function beginBusy() {
  state.loading = true;
  document.querySelector('main').setAttribute('aria-busy', 'true');
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => {
    if (!state.loading) return;
    state.busy = true;
    document.body.classList.add('is-loading');
    // The button serves the file on screen, and right now there isn't one.
    el('download').disabled = true;
    renderFreshness();
  }, BUSY_DELAY);
}

function endBusy() {
  clearTimeout(busyTimer);
  state.loading = false;
  state.busy = false;
  document.body.classList.remove('is-loading');
  el('download').disabled = false;
  document.querySelector('main').setAttribute('aria-busy', 'false');
}

/**
 * Forget the file on screen, the moment the reader picks a different day. The
 * place name and the footer's filename both name a specific log, and naming the
 * old one over the new one's label is the mistake invariant 9 exists to prevent.
 * The readings themselves stay, dimmed, until the new ones land.
 */
function clearFile() {
  state.fileMeta = null;
  renderPlace();
  renderFooter();
}

function scheduleNext() {
  clearTimeout(pollTimer);
  if (DEMO || state.viewingDay) return;   // history is static; demo has nothing to poll
  const base = CONFIG.pollSeconds * 1000;
  const delay = state.backoff ? Math.min(base * state.backoff, 5 * MINUTE) : base;
  pollTimer = setTimeout(load, delay);
}

function populateDayOptions(files) {
  state.dayFiles = files;
  const select = el('day-select');
  const current = select.value;

  // Tagging every option with the same place is noise — the masthead already
  // says where we are. The place only earns its space when the folder spans
  // more than one, which is exactly when the date alone is ambiguous.
  const known = files.map((f) => localityOf(state.places.get(f.id))).filter(Boolean);
  const showPlace = new Set(known).size > 1;

  select.replaceChildren(new Option('Latest', ''));
  for (const f of files) {
    const d = dateFromFilename(f.name);
    let label = d ? dateFmt.format(new Date(Date.UTC(d.y, d.m - 1, d.d))) : f.name;
    const place = showPlace ? localityOf(state.places.get(f.id)) : null;
    if (place) label += ` \u2014 ${place}`;
    select.append(new Option(label, f.id));
  }
  select.value = current;
}

/** Repaint the picker in place — used when a place name arrives late. */
function repaintDayOptions() {
  if (state.dayFiles.length) populateDayOptions(state.dayFiles);
}

async function refreshDayIndex() {
  if (DEMO) return;
  if (state.indexFetchedAt && Date.now() - state.indexFetchedAt < 10 * MINUTE) return;
  try {
    const files = await listFiles(CONFIG.folderId, CONFIG.apiKey, 100);
    state.fileIndex = files;
    state.indexFetchedAt = Date.now();
    populateDayOptions(files);
    resolvePlaces(files);
  } catch { /* the picker is optional; never let it break the live view */ }
}

function downloadCsv() {
  if (!state.rawText) return;
  const blob = new Blob([state.rawText], { type: 'text/csv;charset=windows-1252' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.fileMeta?.name || 'wind-log.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* -- location -------------------------------------------------------------- */

// The place under the title is derived from each log's own GPS fix, so a boat
// that moves between regattas labels itself. Nothing is shown while a lookup is
// pending, or when it is disabled or came back with nothing.
//
// Labelling the *picker* needs a fix from files we have not downloaded, so each
// one is probed with a 2 KB Range request and the answer is remembered by file
// id — a day is probed once, ever. All of this is cosmetic: every path below
// swallows its errors rather than let a missing place name reach the wind data.

const FIX_KEY = 'wind-station.fix.v1';
const FIX_LIMIT = 400;
const HEAD_BYTES = 2048;
const PLACE_WORKERS = 2;

// Guards a file already being probed, so overlapping index refreshes cannot
// double up on the same Range request.
const probing = new Set();

function loadFixes() {
  try {
    const raw = localStorage.getItem(FIX_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveFix(id, fix) {
  try {
    const all = loadFixes();
    all[id] = fix;
    const keys = Object.keys(all);
    // One file per day, so this only bites after a year of use.
    const kept = keys.length > FIX_LIMIT ? keys.slice(keys.length - FIX_LIMIT) : keys;
    localStorage.setItem(FIX_KEY, JSON.stringify(Object.fromEntries(kept.map((k) => [k, all[k]]))));
  } catch { /* private mode or quota — the fix is still good for this session */ }
}

function currentPlace() {
  const id = state.fileMeta?.id;
  return (id && state.places.get(id)) || null;
}

function renderPlace() {
  // Blank until the lookup answers: a stale or configured place would claim a
  // location this log was never recorded at.
  el('place-name').textContent = currentPlace() || '';
}

/** First bytes of a file, enough to reach its opening fix. */
async function headBytes(file) {
  if (DEMO) {
    const res = await fetch(file.id, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } });
    if (!res.ok) throw new Error('sample file missing');
    return res.arrayBuffer();
  }
  return fetchFileHead(file.id, CONFIG.apiKey, HEAD_BYTES);
}

/** The fix for a file, from cache, or probed with a Range request. */
async function fixFor(file) {
  const cached = loadFixes()[file.id];
  if (cached && Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) return cached;
  const fix = parseFirstFix(decodeLog(await headBytes(file)));
  if (fix) saveFix(file.id, fix);
  return fix;
}

/**
 * Place for the file on screen. Its fix is already parsed, so this costs no
 * download — only the geocode, which is usually a cache hit.
 */
async function resolvePlaceFor(meta, station) {
  // Repaint first, before any await: the file on screen has just changed, and
  // leaving the previous day's place above it would assert a location this log
  // was never recorded at. The line stays empty until the name lands.
  renderPlace();
  if (!CONFIG.geocode?.enabled || !meta || !station) return;
  if (state.places.has(meta.id)) return;

  saveFix(meta.id, station);
  const place = await reverseGeocode(station.lat, station.lon, CONFIG.geocode);
  state.places.set(meta.id, place);
  renderPlace();
  renderFooter();
  repaintDayOptions();
}

/**
 * Places for every file in the picker, in the background, repainting labels as
 * they land. Files that fail are left unresolved so the next index refresh can
 * retry them; that refresh is throttled to 10 minutes, which bounds the retries.
 */
async function resolvePlaces(files) {
  if (!CONFIG.geocode?.enabled) return;
  const pending = files.filter((f) => !state.places.has(f.id) && !probing.has(f.id));
  if (!pending.length) return;
  for (const f of pending) probing.add(f.id);

  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const file = pending[cursor++];
      try {
        const fix = await fixFor(file);
        const place = fix ? await reverseGeocode(fix.lat, fix.lon, CONFIG.geocode) : null;
        state.places.set(file.id, place);
        repaintDayOptions();
        if (file.id === state.fileMeta?.id) { renderPlace(); renderFooter(); }
      } catch { /* leave unresolved: the label is optional, the wind data is not */ }
      probing.delete(file.id);
    }
  };
  await Promise.all(Array.from({ length: PLACE_WORKERS }, worker));
}

/* -- rendering ------------------------------------------------------------ */

function render() {
  const summary = summarise(state.rows);
  renderHero(summary);
  renderTiles(summary);
  renderCharts();
  renderRose(el('rose'), state.rows);
  renderFooter();
  renderFreshness();
}

function renderHero(s) {
  const dial = el('dial');
  if (!s) {
    el('dial-speed').textContent = '--';
    el('direction-line').textContent = '--';
    el('beaufort-line').textContent = state.error
      ? 'Data unavailable'
      : underWayOnly()
        ? UNDER_WAY
        : 'No readings yet today';
    el('updated-line').textContent = '';
    dial.classList.add('stale');
    return;
  }

  el('dial-speed').textContent = formatSpeed(s.tws, state.unit);
  el('dial-unit').textContent = unitLabel();

  const dir = Math.round(s.dirSmoothed ?? s.twd ?? 0);
  el('needle').setAttribute('transform', `rotate(${dir} 100 100)`);
  el('direction-line').textContent =
    s.twd === null ? '--' : `${String(dir).padStart(3, '0')}${MAG} ${cardinal16(dir)}`;
  el('beaufort-line').textContent = s.beaufort
    ? `${s.beaufort.label}, force ${s.beaufort.force}`
    : '';

  const { state: fresh } = freshness(s.latest.t);
  dial.classList.toggle('stale', fresh === 'offline');
}

function renderTiles(s) {
  const u = unitLabel();
  el('stat-max').textContent = s?.maxRecent != null ? `${formatSpeed(s.maxRecent, state.unit)} ${u}` : '--';
  el('stat-mean').textContent = s?.meanRecent != null ? `${formatSpeed(s.meanRecent, state.unit)} ${u}` : '--';

  if (s?.trend != null) {
    const v = (s.trend * UNITS[state.unit].factor);
    el('stat-trend').textContent = `${v >= 0 ? '+' : '\u2212'}${Math.abs(v).toFixed(1)} ${u}`;
  } else {
    el('stat-trend').textContent = '--';
  }

  if (s?.shift != null && Math.abs(s.shift) >= 1) {
    el('stat-shift').textContent =
      `${s.shift > 0 ? 'Veering' : 'Backing'} ${Math.abs(Math.round(s.shift))}\u00B0`;
  } else if (s?.shift != null) {
    el('stat-shift').textContent = 'Steady';
  } else {
    el('stat-shift').textContent = '--';
  }
}

function renderFreshness() {
  const pill = el('status-pill');
  const text = el('status-text');
  pill.className = 'pill';

  // First, ahead of the error: a retry after a failure should read as trying
  // again, not as the old failure still standing.
  if (state.busy) {
    pill.classList.add('pill-loading');
    text.textContent = 'Loading\u2026';
    return;
  }
  if (state.error) {
    pill.classList.add('pill-error');
    text.textContent = state.error;
    return;
  }
  if (!state.rows.length) {
    pill.classList.add('pill-loading');
    text.textContent = underWayOnly() ? UNDER_WAY : 'No data';
    return;
  }
  if (state.viewingDay) {
    pill.classList.add('pill-offline');
    text.textContent = 'Viewing history';
    el('updated-line').textContent =
      `${state.rows.length} samples, ${clockAt(state.rows[0].t)}\u2013${clockAt(state.rows.at(-1).t)}`;
    return;
  }

  const last = state.rows.at(-1).t;
  const { state: fresh, age } = freshness(last);
  if (fresh === 'live') {
    pill.classList.add('pill-live');
    text.textContent = `Live \u00B7 ${formatAge(age)}`;
  } else if (fresh === 'delayed') {
    pill.classList.add('pill-delayed');
    text.textContent = `Delayed \u00B7 ${formatAge(age)}`;
  } else {
    pill.classList.add('pill-offline');
    text.textContent = `Offline since ${clockAt(last)}`;
  }
  el('updated-line').textContent = `Last reading ${clockAt(last)} \u00B7 ${formatAge(age)}`;
}

function renderFooter() {
  const bits = [];
  if (state.fileMeta?.name) bits.push(state.fileMeta.name);
  if (state.rows.length) bits.push(`${state.rows.length} samples`);
  if (state.excluded) bits.push(`${state.excluded} excluded, vessel under way`);
  if (state.warmup) bits.push(`${state.warmup} dropped at startup`);
  const place = currentPlace();
  if (place) bits.push(place);
  if (state.station) {
    bits.push(`${state.station.lat.toFixed(4)}\u00B0, ${state.station.lon.toFixed(4)}\u00B0`);
  }
  bits.push(`times shown in ${CONFIG.timeZone.replace('_', ' ')}`);
  el('footer-meta').textContent = bits.join(' \u00B7 ');
}

/* -- charts --------------------------------------------------------------- */

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartTheme() {
  return {
    tick: css('--ink-3'),
    grid: css('--line'),
    accent: css('--accent'),
    soft: css('--accent-soft'),
    ink: css('--ink'),
  };
}

const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.getActiveElements();
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.strokeStyle = css('--ink-3');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function renderCharts() {
  const theme = chartTheme();
  const rows = state.rows;
  const factor = UNITS[state.unit].factor;
  const speedData = rows.map((r) => ({
    x: r.t,
    y: r.tws === null ? null : r.tws * factor,
  }));
  // Same treatment as direction: every sample as a faded dot, the trailing mean
  // as the line. Same length as speedData on purpose — syncTo() cross-highlights
  // the charts by position, so a shorter series would desync the crosshair.
  const speedAvg = rollingMean(rows, SMOOTH_MINUTES).map((v, i) => ({
    x: rows[i].t,
    y: v === null ? null : v * factor,
  }));
  const speeds = speedData.map((p) => p.y);
  const speedAxis = speeds.some((y) => y !== null)
    ? paddedRange(min(speeds), max(speeds), {
      minSpan: SPEED_MIN_SPAN_KN * factor, floor: 0,
    })
    : { min: 0, max: 10 * factor, step: 2 * factor };

  // The direction axis is continuous, not 0-360: every sample is unwrapped to
  // within half a turn of the recent mean, so a northerly reads as one band
  // instead of splitting across the top and bottom edges.
  const end = rows.length ? rows.at(-1).t : 0;
  const centre = vectorMeanDeg(windowRows(rows, end, DIR_CENTRE_MINUTES).map((r) => r.twd))
    ?? vectorMeanDeg(rows.map((r) => r.twd))
    ?? 180;
  const meanDeg = rollingVectorMeanDeg(rows, SMOOTH_MINUTES);
  const unwrapped = rows
    .map((r, i) => ({ x: r.t, y: unwrapDeg(centre, r.twd), avg: meanDeg[i], i }))
    .filter((p) => p.y !== null);
  const dirAxis = directionRange(unwrapped.map((p) => p.y), centre, {
    minSpan: DIR_MIN_SPAN_DEG,
  });
  const dirData = unwrapped.map((p) => ({ ...p, y: foldInto(p.y, dirAxis.min) }));

  // The mean goes through the same unwrap-and-fold as the samples, so the line
  // and the dots share one axis. Same length as dirData on purpose: syncTo()
  // cross-highlights the charts by position, and a shorter series would desync
  // the crosshair.
  const avgData = breakWraps(dirData.map((p) => ({
    x: p.x,
    y: p.avg === null ? null : foldInto(unwrapDeg(centre, p.avg), dirAxis.min),
  })));

  const makeXScale = () => ({
    type: 'linear',
    min: rows.length ? rows[0].t : undefined,
    max: rows.length ? rows.at(-1).t : undefined,
    grid: { display: false },
    border: { color: theme.grid },
    ticks: {
      color: theme.tick, font: { size: 11 }, maxTicksLimit: 7, autoSkip: true,
      callback: (v) => clockAt(v),
    },
  });

  if (twsChart) twsChart.destroy();
  twsChart = new Chart(el('chart-tws'), {
    type: 'scatter',
    data: {
      datasets: [
        // Samples stay dataset 0: syncTo() and the DOM smoke test both index it.
        {
          label: `Wind speed (${unitLabel()})`,
          data: speedData,
          backgroundColor: theme.soft,
          pointHoverBackgroundColor: theme.accent,
          pointRadius: 2.2,
          pointHoverRadius: 4,
          order: 2,              // higher order draws first, i.e. behind
        },
        {
          type: 'line',          // mixed dataset; LineController is registered
          label: `${SMOOTH_MINUTES}-min mean`,
          data: speedAvg,
          borderColor: theme.accent,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 0,
          spanGaps: false,       // a gap in the log is a gap in the line
          tension: 0,            // already smoothed; no Bezier on top
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          // The mean line is context, not a reading: report the sample under
          // the cursor, never the smoothed value.
          filter: (item) => item.datasetIndex === 0,
          callbacks: {
            title: (items) => clockAt(items[0].parsed.x),
            label: (item) => `${item.parsed.y?.toFixed(1) ?? '--'} ${unitLabel()}`,
          },
        },
      },
      scales: {
        x: makeXScale(),
        y: {
          min: speedAxis.min,
          max: speedAxis.max,
          grid: { color: theme.grid },
          border: { display: false },
          ticks: {
            color: theme.tick, font: { size: 11 }, stepSize: speedAxis.step,
            // Chart.js would localise the separator; the rest of the page is en-GB.
            callback: (v) => v.toFixed(speedAxis.step < 1 ? 1 : 0),
          },
          title: { display: true, text: unitLabel(), color: theme.tick, font: { size: 11 } },
        },
      },
      onHover: (_e, els) => syncTo(twdChart, els),
    },
    plugins: [crosshair],
  });

  if (twdChart) twdChart.destroy();
  twdChart = new Chart(el('chart-twd'), {
    type: 'scatter',
    data: {
      datasets: [
        // Samples stay dataset 0: syncTo() and the DOM smoke test both index it.
        {
          label: 'Wind direction',
          data: dirData,
          backgroundColor: theme.soft,
          pointHoverBackgroundColor: theme.accent,
          pointRadius: 2.2,
          pointHoverRadius: 4,
          order: 2,              // higher order draws first, i.e. behind
        },
        {
          type: 'line',          // mixed dataset; LineController is registered
          label: `${SMOOTH_MINUTES}-min mean`,
          data: avgData,
          borderColor: theme.accent,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 0,
          spanGaps: false,       // honour the wrap breaks
          tension: 0,            // already smoothed; no Bezier on top
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          // The mean line is context, not a reading: report the sample under
          // the cursor, never the smoothed value.
          filter: (item) => item.datasetIndex === 0,
          callbacks: {
            title: (items) => clockAt(items[0].parsed.x),
            label: (item) => {
              const d = Math.round(normDeg(item.parsed.y));
              return `${String(d).padStart(3, '0')}${MAG} ${cardinal16(d)}`;
            },
          },
        },
      },
      scales: {
        x: makeXScale(),
        y: {
          min: dirAxis.min,
          max: dirAxis.max,
          grid: { color: theme.grid },
          border: { display: false },
          ticks: {
            color: theme.tick, font: { size: 11 }, stepSize: dirAxis.step,
            callback: (v) => `${String(Math.round(normDeg(v))).padStart(3, '0')}\u00B0`,
          },
        },
      },
      onHover: (_e, els) => syncTo(twsChart, els),
    },
    plugins: [crosshair],
  });
}

function syncTo(target, elements) {
  if (!target) return;
  if (!elements.length) {
    target.setActiveElements([]);
  } else {
    const idx = Math.min(elements[0].index, target.data.datasets[0].data.length - 1);
    target.setActiveElements([{ datasetIndex: 0, index: idx }]);
  }
  target.update('none');
}

/* -- go ------------------------------------------------------------------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
