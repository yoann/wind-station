// Chart.js, bundled instead of loaded from a CDN, with only the pieces the two
// charts in app.js actually use registered. The UMD build ships every
// controller, scale and plugin; registering by hand lets the bundler drop the
// rest — polar/radar/bar/doughnut, the time and logarithmic scales, animations
// nothing here asks for.
//
// Anything added to a chart config later needs its component added here too. A
// missing registration is not silent: Chart.js throws and names what it wanted.

import {
  Chart as ChartJS,
  LineController,
  ScatterController,
  LineElement,
  PointElement,
  LinearScale,
  Tooltip,
} from 'chart.js';

ChartJS.register(
  LineController,     // the mean line on both charts
  ScatterController,  // the samples on both charts
  LineElement,
  PointElement,
  LinearScale,        // both axes on both charts
  Tooltip,
);

// Legend is deliberately absent: both charts set legend.display = false, and an
// unregistered plugin's config block is ignored rather than fatal.

// test/dom-smoke.mjs installs a stub on globalThis before importing app.js,
// because jsdom has no canvas context for the real library to draw into.
export const Chart = globalThis.Chart ?? ChartJS;
