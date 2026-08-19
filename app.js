import { CONFIG } from './config.js';
import { parseLog, decodeLog, dateFromFilename } from './lib/parser.js';
import {
  summarise, freshness, formatAge, formatSpeed, UNITS, cardinal16, MINUTE,
} from './lib/stats.js';
import { fetchLatestMeta, listFiles, fetchFileBytes, describeError } from './lib/drive.js';
import { renderRose, renderRoseLegend } from './lib/rose.js';

const DEMO = !CONFIG.apiKey;
const DEMO_FILES = [
  { id: './sample/SsLog-19-08-2026.csv', name: 'SsLog-19-08-2026.csv' },
  { id: './sample/SsLog-18-08-2026.csv', name: 'SsLog-18-08-2026.csv' },
];
const MAG = CONFIG.directionsAreMagnetic ? '\u00B0 M' : '\u00B0';

const state = {
  unit: CONFIG.defaultUnit,
  rows: [],
  rawText: '',
  fileMeta: null,       // { id, name, modifiedTime }
  viewingDay: '',       // '' = follow latest, otherwise a file id
  error: null,
  backoff: 0,
};

const el = (id) => document.getElementById(id);
let twsChart = null;
let twdChart = null;
let pollTimer = null;

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
  if (CONFIG.placeName) el('place-name').textContent = CONFIG.placeName;
  document.title = CONFIG.stationName;

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
    load({ force: true });
  });

  el('back-to-live').addEventListener('click', () => {
    state.viewingDay = '';
    el('day-select').value = '';
    el('back-to-live').hidden = true;
    load({ force: true });
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

  load();
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

async function load({ force = false } = {}) {
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
    scheduleNext();
  }
}

function ingest(bytes, meta) {
  state.rawText = decodeLog(bytes);
  const { rows, station } = parseLog(state.rawText);
  state.rows = rows;
  state.station = station;
  state.fileMeta = meta;
}

function scheduleNext() {
  clearTimeout(pollTimer);
  if (DEMO || state.viewingDay) return;   // history is static; demo has nothing to poll
  const base = CONFIG.pollSeconds * 1000;
  const delay = state.backoff ? Math.min(base * state.backoff, 5 * MINUTE) : base;
  pollTimer = setTimeout(load, delay);
}

function populateDayOptions(files) {
  const select = el('day-select');
  const current = select.value;
  select.replaceChildren(new Option('Latest', ''));
  for (const f of files) {
    const d = dateFromFilename(f.name);
    const label = d ? dateFmt.format(new Date(Date.UTC(d.y, d.m - 1, d.d))) : f.name;
    select.append(new Option(label, f.id));
  }
  select.value = current;
}

async function refreshDayIndex() {
  if (DEMO) return;
  if (state.indexFetchedAt && Date.now() - state.indexFetchedAt < 10 * MINUTE) return;
  try {
    const files = await listFiles(CONFIG.folderId, CONFIG.apiKey, 100);
    state.fileIndex = files;
    state.indexFetchedAt = Date.now();
    populateDayOptions(files);
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
  el('stat-max').textContent = s?.max60 != null ? `${formatSpeed(s.max60, state.unit)} ${u}` : '--';
  el('stat-mean').textContent = s?.mean60 != null ? `${formatSpeed(s.mean60, state.unit)} ${u}` : '--';

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

  if (state.error) {
    pill.classList.add('pill-error');
    text.textContent = state.error;
    return;
  }
  if (!state.rows.length) {
    pill.classList.add('pill-loading');
    text.textContent = 'No data';
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
  return { tick: css('--ink-3'), grid: css('--line'), accent: css('--accent'), ink: css('--ink') };
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
  const speedData = rows.map((r) => ({
    x: r.t,
    y: r.tws === null ? null : r.tws * UNITS[state.unit].factor,
  }));
  const dirData = rows
    .map((r, i) => ({ x: r.t, y: r.twd, i }))
    .filter((p) => p.y !== null);

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
    type: 'line',
    data: {
      datasets: [{
        label: `Wind speed (${unitLabel()})`,
        data: speedData,
        borderColor: theme.accent,
        backgroundColor: 'rgba(31, 95, 165, 0.10)',
        borderWidth: 2,
        pointRadius: 0,
        pointHitRadius: 12,
        fill: true,
        tension: 0.3,
        spanGaps: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => clockAt(items[0].parsed.x),
            label: (item) => `${item.parsed.y?.toFixed(1) ?? '--'} ${unitLabel()}`,
          },
        },
      },
      scales: {
        x: makeXScale(),
        y: {
          beginAtZero: true,
          grid: { color: theme.grid },
          border: { display: false },
          ticks: { color: theme.tick, font: { size: 11 } },
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
      datasets: [{
        label: 'Wind direction',
        data: dirData,
        backgroundColor: theme.accent,
        pointRadius: 2.2,
        pointHoverRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => clockAt(items[0].parsed.x),
            label: (item) => {
              const d = Math.round(item.parsed.y);
              return `${String(d).padStart(3, '0')}${MAG} ${cardinal16(d)}`;
            },
          },
        },
      },
      scales: {
        x: makeXScale(),
        y: {
          min: 0,
          max: 360,
          grid: { color: theme.grid },
          border: { display: false },
          ticks: {
            color: theme.tick, font: { size: 11 }, stepSize: 90,
            callback: (v) => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' }[v] ?? ''),
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
