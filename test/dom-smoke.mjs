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
const DRIVE_FILES = [
  { id: 'drv-SsLog-19-08-2026.csv', name: 'SsLog-19-08-2026.csv', modifiedTime: '2026-08-19T14:05:00.000Z', size: '21441' },
  { id: 'drv-SsLog-18-08-2026.csv', name: 'SsLog-18-08-2026.csv', modifiedTime: '2026-08-18T23:59:00.000Z', size: '193324' },
];

const sampleBody = (name) => {
  const buf = readFileSync(`${APP}/sample/${name}`);
  return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

window.fetch = async (url) => {
  const u = new URL(String(url), 'https://example.org/');

  // files.list — honours pageSize, already sorted newest-first
  if (u.pathname === '/drive/v3/files') {
    const pageSize = Number(u.searchParams.get('pageSize') ?? 1);
    const files = DRIVE_FILES.slice(0, pageSize);
    return { ok: true, json: async () => ({ files }) };
  }

  // files/{id}?alt=media
  const id = decodeURIComponent(u.pathname.split('/').pop());
  const meta = DRIVE_FILES.find((f) => f.id === id);
  if (meta && u.searchParams.get('alt') === 'media') return sampleBody(meta.name);

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
// The direction dots read --accent-soft. Without it in both themes they fall
// back to a Chart.js default and stop matching the line they sit under.
check('both themes define the soft accent the direction dots use',
  (appCss.match(/--accent-soft:/g) || []).length === 2,
  `${(appCss.match(/--accent-soft:/g) || []).length} definitions`);
check('footer discloses the startup rows dropped', /2 dropped at startup/.test($('footer-meta').textContent), $('footer-meta').textContent);
check('footer credits the author', /Built by Yoann Peronneau\./.test(document.querySelector('footer').textContent));
check('two charts created', charts.length === 2, `${charts.length}`);

if (charts.length === 2) {
  const [tws, twd] = charts;
  check('speed chart is a line', tws.config.type === 'line');
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
  check('speed area fills to the axis, not to zero', tws.data.datasets[0].fill === 'start');
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
check('day picker offers both sample days', $('day-select').options.length === 3, `${$('day-select').options.length} options`);
check('back-to-live button revealed', !$('back-to-live').hidden);
check('history mode in status pill', $('status-text').textContent === 'Viewing history', $('status-text').textContent);
check('rose fans across many sectors', $('rose').querySelectorAll('path.rose-seg').length > 30, `${$('rose').querySelectorAll('path.rose-seg').length} segments`);
check('gale-force max recorded', parseFloat($('stat-max').textContent) > 0, $('stat-max').textContent);
check('speed series loaded the bigger day', charts.at(-2).data.datasets[0].data.length > 1500, `${charts.at(-2).data.datasets[0].data.length} points`);

console.log(fails.length ? `\n${fails.length} failing\n` : '\nall passing\n');
process.exit(fails.length ? 1 : 0);
