import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const APP = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const html = readFileSync(`${APP}/index.html`, 'utf8');


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

window.fetch = async (url) => {
  const name = String(url).split('/').pop();
  if (/^SsLog-.*\.csv$/.test(name)) {
    const buf = readFileSync(`${APP}/sample/${name}`);
    return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  }
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

console.log('\nDOM smoke test (demo mode, sample file):');
check('demo banner shown', !$('banner').hidden);
check('speed readout populated', $('dial-speed').textContent === '8.7', `got "${$('dial-speed').textContent}"`);
check('direction readout is the 5-min vector mean, not the raw last sample', $('direction-line').textContent === '334° M NNW', `got "${$('direction-line').textContent}"`);
check('beaufort described', $('beaufort-line').textContent === 'gentle breeze, force 3', `got "${$('beaufort-line').textContent}"`);
check('needle rotated to bearing', /rotate\(3[0-9]{2} 100 100\)/.test($('needle').getAttribute('transform')), $('needle').getAttribute('transform'));
check('max tile filled', /kn$/.test($('stat-max').textContent), $('stat-max').textContent);
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
check('two charts created', charts.length === 2, `${charts.length}`);

if (charts.length === 2) {
  const [tws, twd] = charts;
  check('speed chart is a line', tws.config.type === 'line');
  check('direction chart is a scatter', twd.config.type === 'scatter');
  check('direction y-axis is 0-360', twd.config.options.scales.y.min === 0 && twd.config.options.scales.y.max === 360);
  check('x scale configs are distinct objects', tws.config.options.scales.x !== twd.config.options.scales.x);
  check('speed series has 211 points', tws.data.datasets[0].data.length === 211, `${tws.data.datasets[0].data.length}`);
  check('direction series drops nulls', twd.data.datasets[0].data.every((p) => p.y !== null));
  check('cardinal tick callback', twd.config.options.scales.y.ticks.callback(90) === 'E');
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
}

// Day picker: switch to the synthetic gale day and re-check the rose fans out
$('day-select').value = './sample/SsLog-18-08-2026.csv';
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
