import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const APP = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const html = readFileSync(`${APP}/index.html`, 'utf8');
const appCss = readFileSync(`${APP}/app.css`, 'utf8');


const dom = new JSDOM(html, { url: 'https://example.org/', pretendToBeVisual: true });
const { window } = dom;

// Stub Chart.js — CDN is unreachable in the sandbox, and we are testing wiring,
// not the chart library. Record the configs so we can assert on them.
const charts = [];
class ChartStub {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;
    this.data = config.data;
    charts.push(this);
  }
  destroy() {}
  update() {}
  setActiveElements() {}
  getActiveElements() { return []; }
}
window.Chart = ChartStub;

// Stub Google Drive. config.js carries a real API key, so the page takes the
// live path, not demo mode — the stub has to answer files.list and alt=media
// the way Drive does. File ids are the sample filenames so a failure names the
// day it came from. Newest first: the 19th is the real 211-row log.
// Two more days, synthesised at other positions, because the two real samples
// sit at the same anchorage and so cannot show the picker naming places apart.
// A log body just needs a header and a couple of rows to parse and geocode.
const syntheticDay = (date, lat, lon) => [
  "'Date, 'Time, 'Latitude, 'Longitude, 'SOG, 'COG, 'TWS, 'TWA, 'TWD, 'Comment, ",
  `${date}, 09:00:00 UTC, ${lat}, ${lon}, 00.1, 355\xB0 M, 09.0, 026\xB0 Port, 300\xB0 M, , `,
  `${date}, 09:00:30 UTC, ${lat}, ${lon}, 00.1, 355\xB0 M, 09.2, 026\xB0 Port, 301\xB0 M, , `,
  `${date}, 09:01:00 UTC, ${lat}, ${lon}, 00.1, 355\xB0 M, 09.1, 026\xB0 Port, 302\xB0 M, , `,
  '',
].join('\r\n');

const SYNTHETIC = {
  // Bodrum — a different regatta, so this day must be labelled apart.
  'drv-SsLog-17-08-2026.csv': syntheticDay('17/08/2026', "37\xB0 01.800' N", "027\xB0 25.800' E"),
  // Open sea — nothing to name, so this day must show no place at all.
  'drv-SsLog-16-08-2026.csv': syntheticDay('16/08/2026', "36\xB0 00.000' N", "023\xB0 00.000' E"),
};

const DRIVE_FILES = [
  { id: 'drv-SsLog-19-08-2026.csv', name: 'SsLog-19-08-2026.csv', modifiedTime: '2026-08-19T14:05:00.000Z', size: '21441' },
  { id: 'drv-SsLog-18-08-2026.csv', name: 'SsLog-18-08-2026.csv', modifiedTime: '2026-08-18T23:59:00.000Z', size: '193324' },
  { id: 'drv-SsLog-17-08-2026.csv', name: 'SsLog-17-08-2026.csv', modifiedTime: '2026-08-17T18:00:00.000Z', size: '400' },
  { id: 'drv-SsLog-16-08-2026.csv', name: 'SsLog-16-08-2026.csv', modifiedTime: '2026-08-16T18:00:00.000Z', size: '400' },
];

const bodyOf = (buf) => ({
  ok: true,
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
});
const sampleBody = (name) => bodyOf(readFileSync(`${APP}/sample/${name}`));

// Stub Nominatim. A masthead reading 'Zeytineli' proves the place came from the
// GPS fix. Open water geocodes to nothing, as it really does.
const GAZETTEER = [
  { lat: 38.318, lon: 26.695, address: { village: 'Zeytineli', country: 'T\u00FCrkiye' } },
  { lat: 37.030, lon: 27.430, address: { town: 'Bodrum', country: 'T\u00FCrkiye' } },
];
const geocodeCalls = [];
const rangeRequests = [];

window.fetch = async (url, options) => {
  const u = new URL(String(url), 'https://example.org/');

  if (u.hostname === 'nominatim.openstreetmap.org') {
    const lat = Number(u.searchParams.get('lat'));
    const lon = Number(u.searchParams.get('lon'));
    geocodeCalls.push(`${lat},${lon}`);
    const hit = GAZETTEER.find((p) => Math.abs(p.lat - lat) < 0.05 && Math.abs(p.lon - lon) < 0.05);
    return { ok: true, json: async () => (hit ? { address: hit.address } : { error: 'Unable to geocode' }) };
  }

  // files.list — honours pageSize, already sorted newest-first
  if (u.pathname === '/drive/v3/files') {
    const pageSize = Number(u.searchParams.get('pageSize') ?? 1);
    const files = DRIVE_FILES.slice(0, pageSize);
    return { ok: true, json: async () => ({ files }) };
  }

  // files/{id}?alt=media
  const id = decodeURIComponent(u.pathname.split('/').pop());
  const range = options?.headers?.Range;
  if (range) rangeRequests.push(id);
  const meta = DRIVE_FILES.find((f) => f.id === id);
  if (meta && u.searchParams.get('alt') === 'media') {
    // Drive honours Range; serving the whole file is a superset the parser
    // handles, and the header itself is asserted below.
    return SYNTHETIC[id] ? bodyOf(Buffer.from(SYNTHETIC[id], 'latin1')) : sampleBody(meta.name);
  }

  // Demo mode still works if the API key is ever cleared from config.js
  if (/^SsLog-.*\.csv$/.test(id)) return sampleBody(id);

  throw new Error(`unexpected fetch: ${url}`);
};

for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'Blob', 'URL', 'Option', 'getComputedStyle', 'Chart', 'fetch', 'Node', 'Element', 'SVGElement']) {
  if (k in globalThis && k !== 'fetch' && k !== 'URL') continue;
  globalThis[k] = window[k];
}
globalThis.document = window.document;
globalThis.window = window;
globalThis.fetch = window.fetch;
globalThis.Chart = ChartStub;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.Option = window.Option;
globalThis.Blob = window.Blob;
globalThis.localStorage = window.localStorage;

await import(`${APP}/app.js`);
await new Promise((r) => setTimeout(r, 400));

const $ = (id) => window.document.getElementById(id);
const fails = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); fails.push(name); }
};

// Place lookups are throttled to one a second, so they land well after the
// initial render. Poll rather than guess a sleep long enough to cover them.
const waitFor = async (cond, ms = 6000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

console.log('\nDOM smoke test (live Drive path, stubbed):');
check('no demo banner — config.js has an API key', $('banner').hidden);
check('speed readout populated', $('dial-speed').textContent === '8.7', `got "${$('dial-speed').textContent}"`);
check('direction readout is the 5-min vector mean, not the raw last sample', $('direction-line').textContent === '334° M NNW', `got "${$('direction-line').textContent}"`);
check('beaufort described', $('beaufort-line').textContent === 'gentle breeze, force 3', `got "${$('beaufort-line').textContent}"`);
check('needle rotated to bearing', /rotate\(3[0-9]{2} 100 100\)/.test($('needle').getAttribute('transform')), $('needle').getAttribute('transform'));
check('max tile filled', /kn$/.test($('stat-max').textContent), $('stat-max').textContent);
check('tile labels state the window', $('stat-max-label').textContent === 'Max, last 15 min', $('stat-max-label').textContent);
check('direction chart note removed', !/Plotted as points/.test(document.body.textContent));
check('mean tile filled', /kn$/.test($('stat-mean').textContent), $('stat-mean').textContent);
check('trend tile filled', $('stat-trend').textContent !== '--', $('stat-trend').textContent);
check('shift tile filled', $('stat-shift').textContent !== '--', $('stat-shift').textContent);
check('station offline (2026 fixture is old)', /Offline since/.test($('status-text').textContent), $('status-text').textContent);
check('dial desaturated when offline', $('dial').classList.contains('stale'));
check('dial ticks drawn', $('dial-ticks').children.length === 36, `${$('dial-ticks').children.length} ticks`);
check('rose rendered as svg', !!$('rose').querySelector('svg'));
check('rose segments match the narrow day (3 sectors x 2 bands)', $('rose').querySelectorAll('path.rose-seg').length === 5, `${$('rose').querySelectorAll('path.rose-seg').length} segments`);
check('rose legend built', $('rose-legend').children.length === 6);
check('footer meta populated', /samples/.test($('footer-meta').textContent), $('footer-meta').textContent);
check('nothing excluded — the fixture day is moored throughout', !/excluded/.test($('footer-meta').textContent), $('footer-meta').textContent);
// The sample dots on both charts read --accent-soft. Without it in both themes
// they fall back to a Chart.js default and stop matching the line they sit under.
check('both themes define the soft accent the sample dots use',
  (appCss.match(/--accent-soft:/g) || []).length === 2,
  `${(appCss.match(/--accent-soft:/g) || []).length} definitions`);
check('footer discloses the startup rows dropped', /2 dropped at startup/.test($('footer-meta').textContent), $('footer-meta').textContent);
check('footer credits the author', /Built by Yoann Peronneau\./.test(document.querySelector('footer').textContent));
check('two charts created', charts.length === 2, `${charts.length}`);

if (charts.length === 2) {
  const [tws, twd] = charts;
  check('speed chart is a scatter', tws.config.type === 'scatter');
  check('direction chart is a scatter', twd.config.type === 'scatter');
  const dy = twd.config.options.scales.y;
  const sy = tws.config.options.scales.y;
  check('direction y-axis narrows to the data', dy.max - dy.min < 360, `${dy.min}-${dy.max}`);
  check('direction y-axis brackets every point',
    twd.data.datasets[0].data.every((p) => p.y >= dy.min && p.y <= dy.max));
  check('direction y-axis keeps a readable floor', dy.max - dy.min >= 60, `${dy.max - dy.min} deg`);
  check('speed y-axis lifts off zero on the narrow day', sy.min > 0, `min ${sy.min}`);
  check('speed y-axis clears the peak', sy.max > Math.max(...tws.data.datasets[0].data.map((p) => p.y ?? 0)));
  check('speed y-axis keeps a readable floor', sy.max - sy.min >= 5, `${sy.max - sy.min} kn`);
  check('x scale configs are distinct objects', tws.config.options.scales.x !== twd.config.options.scales.x);
  // 211 parsed rows, less the 2 that opened a logging session.
  check('speed series has 209 points', tws.data.datasets[0].data.length === 209, `${tws.data.datasets[0].data.length}`);
  check('direction series drops nulls', twd.data.datasets[0].data.every((p) => p.y !== null));

  // The samples stay dots; only the 5-minute mean is drawn as a line.
  check('direction chart overlays a mean line on the samples', twd.data.datasets.length === 2,
    `${twd.data.datasets.length} datasets`);
  const avg = twd.data.datasets[1];
  check('mean series is a line', avg?.type === 'line', `${avg?.type}`);
  check('mean line is labelled with its window', avg?.label === '5-min mean', `${avg?.label}`);
  check('mean line draws over the samples', avg?.order < twd.data.datasets[0].order);
  // Colours resolve to '' here — jsdom never loads app.css — so the shade is
  // checked in the stylesheet and confirmed by eye in a browser.
  check('samples get a hover colour distinct from their resting shade',
    'pointHoverBackgroundColor' in twd.data.datasets[0]);
  // syncTo() cross-highlights the charts by position, so the two direction
  // datasets have to stay the same length.
  check('mean series aligns with the samples',
    avg?.data.length >= twd.data.datasets[0].data.length, `${avg?.data.length}`);
  check('mean line honours its gaps', avg?.spanGaps === false);
  check('mean line stays inside the axis',
    avg?.data.every((p) => p.y === null || (p.y >= dy.min && p.y <= dy.max)));
  check('mean line never draws a wrap cliff', (() => {
    let prev = null;
    for (const p of avg?.data ?? []) {
      if (p.y === null) { prev = null; continue; }
      if (prev !== null && Math.abs(p.y - prev) > 180) return false;
      prev = p.y;
    }
    return true;
  })());
  check('tooltip reports the sample, not the mean',
    twd.config.options.plugins.tooltip.filter({ datasetIndex: 0 }) === true
    && twd.config.options.plugins.tooltip.filter({ datasetIndex: 1 }) === false);

  // The speed chart carries the same treatment: faded dots for every sample,
  // one mean line over them, smoothed over the same window as the direction one.
  check('speed chart overlays a mean line on the samples', tws.data.datasets.length === 2,
    `${tws.data.datasets.length} datasets`);
  const savg = tws.data.datasets[1];
  check('speed mean series is a line', savg?.type === 'line', `${savg?.type}`);
  check('speed mean line shares the direction chart\'s window',
    savg?.label === avg?.label, `${savg?.label}`);
  check('speed mean line draws over the samples', savg?.order < tws.data.datasets[0].order);
  check('speed samples get a hover colour distinct from their resting shade',
    'pointHoverBackgroundColor' in tws.data.datasets[0]);
  check('speed mean series aligns with the samples',
    savg?.data.length === tws.data.datasets[0].data.length, `${savg?.data.length}`);
  check('speed mean line honours its gaps', savg?.spanGaps === false);
  check('speed mean line stays inside the axis',
    savg?.data.every((p) => p.y === null || (p.y >= sy.min && p.y <= sy.max)));
  check('speed mean line is smoother than the samples it averages', (() => {
    const jump = (d) => {
      let worst = 0;
      for (let i = 1; i < d.length; i++) {
        if (d[i].y === null || d[i - 1].y === null) continue;
        worst = Math.max(worst, Math.abs(d[i].y - d[i - 1].y));
      }
      return worst;
    };
    return jump(savg.data) < jump(tws.data.datasets[0].data);
  })());
  check('speed tooltip reports the sample, not the mean',
    tws.config.options.plugins.tooltip.filter({ datasetIndex: 0 }) === true
    && tws.config.options.plugins.tooltip.filter({ datasetIndex: 1 }) === false);
  check('degree tick callback', dy.ticks.callback(90) === '090\u00B0', dy.ticks.callback(90));
  check('degree tick callback normalises an unwrapped value', dy.ticks.callback(-5) === '355\u00B0', dy.ticks.callback(-5));
}

// Unit switch should re-render values and chart series
$('unit-select').value = 'ms';
$('unit-select').dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 50));
check('unit switch updates readout', $('dial-speed').textContent === '4.5', `got "${$('dial-speed').textContent}"`);
check('unit switch updates dial label', $('dial-unit').textContent === 'm/s');
check('unit switch rebuilt charts', charts.length === 4, `${charts.length} charts created total`);
if (charts.length === 4) {
  check('series converted to m/s', Math.abs(charts[2].data.datasets[0].data.at(-1).y - 4.4757) < 0.01, `${charts[2].data.datasets[0].data.at(-1).y}`);
  const msY = charts[2].config.options.scales.y;
  check('speed floor scales with the unit', msY.max - msY.min >= 5 * 0.514444, `${msY.max - msY.min} m/s`);
}

// Day picker: switch to the synthetic gale day and re-check the rose fans out
$('day-select').value = 'drv-SsLog-18-08-2026.csv';
$('day-select').dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 400));
console.log('\nAfter switching to the synthetic gale day:');
check('day picker offers every day in the folder', $('day-select').options.length === 5, `${$('day-select').options.length} options`);
check('back-to-live button revealed', !$('back-to-live').hidden);
check('history mode in status pill', $('status-text').textContent === 'Viewing history', $('status-text').textContent);
check('rose fans across many sectors', $('rose').querySelectorAll('path.rose-seg').length > 30, `${$('rose').querySelectorAll('path.rose-seg').length} segments`);
check('gale-force max recorded', parseFloat($('stat-max').textContent) > 0, $('stat-max').textContent);
check('speed series loaded the bigger day', charts.at(-2).data.datasets[0].data.length > 1500, `${charts.at(-2).data.datasets[0].data.length} points`);

// Location derived from the GPS fixes
const named = await waitFor(() => $('place-name').textContent === 'Zeytineli, T\u00FCrkiye');
console.log('\nLocation derived from the GPS fix:');
check('masthead names the place the coordinates are in',
  named, `got "${$('place-name').textContent}"`);
check('footer names the place beside the coordinates',
  /Zeytineli, T\u00FCrkiye \u00B7 38\.3180\u00B0/.test($('footer-meta').textContent), $('footer-meta').textContent);

const labelled = await waitFor(() => /Bodrum/.test($('day-select').textContent));
check('picker names the day logged at another anchorage', labelled,
  [...$('day-select').options].map((o) => o.text).join(' | '));
check('picker keeps the date as the primary label',
  /^Mon 17 Aug \u2014 Bodrum$/.test([...$('day-select').options].find((o) => /Bodrum/.test(o.text))?.text ?? ''),
  [...$('day-select').options].map((o) => o.text).join(' | '));
check('a day the gazetteer cannot name keeps its bare date',
  [...$('day-select').options].some((o) => o.text === 'Sun 16 Aug'),
  [...$('day-select').options].map((o) => o.text).join(' | '));

// The two real samples share an anchorage, so the folder must cost one lookup
// for them, not one per file — that is what makes labelling a season viable.
await waitFor(() => geocodeCalls.length >= 3);
check('one lookup per place, not per file', geocodeCalls.length === 3, geocodeCalls.join(' | '));
check('unseen days are probed with a Range request, not downloaded whole',
  rangeRequests.includes('drv-SsLog-17-08-2026.csv') && rangeRequests.includes('drv-SsLog-16-08-2026.csv'),
  rangeRequests.join(' | '));
check('the loaded day is never probed — its fix is already parsed',
  !rangeRequests.includes('drv-SsLog-19-08-2026.csv'), rangeRequests.join(' | '));

// A fix over open water geocodes to nothing. The page must still render, with
// no place named — this is the regression that matters.
$('day-select').value = 'drv-SsLog-16-08-2026.csv';
$('day-select').dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 300));
console.log('\nAfter switching to a day logged over open water:');
// Not a waitFor: the line must clear the moment the day changes, never keep a
// stale name inherited from the day before it.
check('masthead shows nothing when the fix cannot be named',
  $('place-name').textContent === '', `got "${$('place-name').textContent}"`);
check('footer omits the place but keeps the coordinates',
  !/Urla/.test($('footer-meta').textContent) && /36\.0000\u00B0/.test($('footer-meta').textContent),
  $('footer-meta').textContent);
check('the day still renders its readings', $('dial-speed').textContent !== '--', $('dial-speed').textContent);

console.log(fails.length ? `\n${fails.length} failing\n` : '\nall passing\n');
process.exit(fails.length ? 1 : 0);
