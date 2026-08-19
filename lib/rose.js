// Wind rose: 16 direction sectors, each stacked by speed band.
// Hand-drawn SVG because Chart.js polarArea cannot stack segments.
// Directions are MAGNETIC, as logged.

export const BANDS = [
  { min: 0, max: 5, label: '0-5', color: '#cfe3f7' },
  { min: 5, max: 10, label: '5-10', color: '#9dc6ee' },
  { min: 10, max: 15, label: '10-15', color: '#6aa8e4' },
  { min: 15, max: 20, label: '15-20', color: '#3b87d6' },
  { min: 20, max: 25, label: '20-25', color: '#1f5fa5' },
  { min: 25, max: Infinity, label: '25+', color: '#123b6b' },
];

const SECTORS = 16;
const SECTOR_DEG = 360 / SECTORS;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Bearing (0 = north = up) to screen coordinates. */
function point(cx, cy, r, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

function arcPath(cx, cy, rIn, rOut, a0, a1) {
  const [x0o, y0o] = point(cx, cy, rOut, a0);
  const [x1o, y1o] = point(cx, cy, rOut, a1);
  const [x1i, y1i] = point(cx, cy, rIn, a1);
  const [x0i, y0i] = point(cx, cy, rIn, a0);
  return [
    `M ${x0i.toFixed(2)} ${y0i.toFixed(2)}`,
    `L ${x0o.toFixed(2)} ${y0o.toFixed(2)}`,
    `A ${rOut} ${rOut} 0 0 1 ${x1o.toFixed(2)} ${y1o.toFixed(2)}`,
    `L ${x1i.toFixed(2)} ${y1i.toFixed(2)}`,
    rIn > 0 ? `A ${rIn} ${rIn} 0 0 0 ${x0i.toFixed(2)} ${y0i.toFixed(2)}` : '',
    'Z',
  ].join(' ');
}

/**
 * Tally rows into a 16 x BANDS matrix of percentages of total samples.
 * @returns {{matrix: number[][], total: number, sectorTotals: number[]}}
 */
export function tally(rows) {
  const matrix = Array.from({ length: SECTORS }, () => new Array(BANDS.length).fill(0));
  let total = 0;
  for (const r of rows) {
    if (r.twd === null || r.tws === null) continue;
    const sector = Math.round((r.twd % 360) / SECTOR_DEG) % SECTORS;
    const band = BANDS.findIndex((b) => r.tws >= b.min && r.tws < b.max);
    if (band < 0) continue;
    matrix[sector][band]++;
    total++;
  }
  if (total > 0) {
    for (const row of matrix) {
      for (let i = 0; i < row.length; i++) row[i] = (row[i] / total) * 100;
    }
  }
  const sectorTotals = matrix.map((row) => row.reduce((a, b) => a + b, 0));
  return { matrix, total, sectorTotals };
}

/**
 * Render the rose into a container element.
 * @param {HTMLElement} el
 * @param {Array} rows
 */
export function renderRose(el, rows) {
  const { matrix, total, sectorTotals } = tally(rows);
  el.replaceChildren();

  if (total === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No wind samples for this day.';
    el.append(p);
    return;
  }

  const size = 320;
  const cx = size / 2;
  const cy = size / 2;
  const rMax = 128;
  const rHub = 14;
  const peak = Math.max(...sectorTotals);
  // Ring scale: round the peak up to a sensible step so labels are readable.
  const step = peak > 40 ? 20 : peak > 20 ? 10 : peak > 8 ? 5 : 2;
  const scaleMax = Math.ceil(peak / step) * step;
  const radiusFor = (pct) => rHub + ((rMax - rHub) * pct) / scaleMax;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'rose');
  svg.setAttribute('role', 'img');
  const dominant = sectorTotals.indexOf(peak) * SECTOR_DEG;
  svg.setAttribute('aria-label',
    `Wind rose. Most frequent direction ${Math.round(dominant)} degrees magnetic, ` +
    `${peak.toFixed(0)} percent of ${total} samples.`);

  const add = (tag, attrs, text) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    svg.append(node);
    return node;
  };

  // Rings + percentage labels
  for (let pct = step; pct <= scaleMax; pct += step) {
    add('circle', { cx, cy, r: radiusFor(pct).toFixed(1), class: 'rose-ring' });
    add('text', { x: cx + 3, y: cy - radiusFor(pct) + 10, class: 'rose-ring-label' }, `${pct}%`);
  }

  // Spokes every 45 degrees
  for (let b = 0; b < 360; b += 45) {
    const [x, y] = point(cx, cy, rMax, b);
    add('line', { x1: cx, y1: cy, x2: x.toFixed(2), y2: y.toFixed(2), class: 'rose-spoke' });
  }

  // Stacked sectors
  for (let s = 0; s < SECTORS; s++) {
    let acc = 0;
    const centre = s * SECTOR_DEG;
    const a0 = centre - SECTOR_DEG / 2 + 1.2;
    const a1 = centre + SECTOR_DEG / 2 - 1.2;
    for (let b = 0; b < BANDS.length; b++) {
      const pct = matrix[s][b];
      if (pct <= 0) continue;
      const rIn = radiusFor(acc);
      const rOut = radiusFor(acc + pct);
      acc += pct;
      const path = add('path', {
        d: arcPath(cx, cy, rIn, rOut, a0, a1),
        fill: BANDS[b].color,
        class: 'rose-seg',
      });
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent =
        `${Math.round(centre)}\u00B0 M, ${BANDS[b].label} kn: ${pct.toFixed(1)}%`;
      path.append(title);
    }
  }

  // Cardinal labels
  const labels = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
  for (const [text, bearing] of labels) {
    const [x, y] = point(cx, cy, rMax + 18, bearing);
    add('text', {
      x: x.toFixed(1), y: (y + 5).toFixed(1),
      class: 'rose-cardinal', 'text-anchor': 'middle',
    }, text);
  }

  el.append(svg);
}

/** Build the legend markup once. */
export function renderRoseLegend(el) {
  el.replaceChildren();
  for (const band of BANDS) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = band.color;
    item.append(swatch, document.createTextNode(`${band.label} kn`));
    el.append(item);
  }
}
