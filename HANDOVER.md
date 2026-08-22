# Handover — wind station website

Everything a fresh session needs to pick this up cold. No prior context assumed.

---

## 1. What this is

A static, public, live-first web page that displays wind speed and direction
from an instrument on a moored vessel near İzmir, Türkiye. The device writes one
CSV per day into a public Google Drive folder, updating roughly every 30 seconds
while powered on. The page reads those files directly from the browser.

The site is built and tested. It runs today in demo mode against bundled sample
data. It is not yet deployed and has never run against the live Drive folder,
because no API key has been created.

**Drive folder:** `12Sn5_2YPEmH2ZzxTXy9Fcy8M6MZGi8Qr` (named `Wind_data`)

---

## 2. Decisions already made

These were settled with the user across the design conversation. Treat them as
fixed unless the user reopens them.

| Decision | Choice | Why it matters |
|---|---|---|
| Audience | Public — anyone with the link | Needs plain-language readouts, no jargon-only display |
| Priority | Live conditions now; history secondary | Default view is today; past days are lazy-loaded on demand |
| Infrastructure | Static hosting only, no backend | Forces browser-side Drive reads; rules out precomputed rollups |
| Direction reference | **Magnetic**, uncorrected | The log emits `306° M`. No WMM conversion. Labelled `M` everywhere |
| Position | Fixed marker, footer only | Vessel is moored (~13 m of drift). No map, no live position broadcast |
| Place name | Reverse-geocoded from each file's own fix, in English | The vessel moves between regattas, so a configured place is wrong half the season. Nothing is shown until the lookup answers |
| Columns used | Date, Time, TWS, TWD | SOG/COG/TWA dropped from display, kept in the CSV download |
| Under-way rows | Excluded above `CONFIG.maxSogKnots` (2 kn) | The boat is a race committee vessel; rows logged while it moves are boat-motion readings from elsewhere. Null SOG is kept |
| Startup rows | First data row after every header dropped | The device writes a header per logging session; the reading that follows is the instrument warming up. 2 of 211 on the real fixture |
| Direction chart | Dots for every sample, plus a 5-min vector mean line | The dots show spread, the line shows trend. 5 min keeps the 8–12 min oscillations a sailor reads for, and matches the dial |
| Speed chart | Same mark as direction: faded dots plus a 5-min mean line | The two panels stack, so one mark should mean one thing in both. The dots keep the gusting spread visible, which a smoothed line alone hides. Replaced a filled line through every sample |
| Load feedback | Stale panels dim, pill reads `Loading…`, after a 180 ms threshold | A day change used to leave the previous day's numbers under the new day's label with no acknowledgement. Only user-initiated loads (boot, day change, back-to-live) — a background poll must never dim the page or displace the `Live` pill |
| Charting | Chart.js 4, bundled | Was a CDN script; now tree-shaken into the build, no runtime third party |
| Build | Vite, output to `dist/` | One JS + one CSS request instead of 8 files plus a CDN hit |
| Deployment | GitHub Actions → Pages | Publishes `dist/` only, so the repo root is not served |

**Deliberately not built:** a map; multi-day aggregation (needs precomputation a
static site can't do); `Range` requests for the growing file tail.

---

## 3. Current state

```
wind-station/
  index.html                    page structure, and the Vite build entry
  app.css                       theme, light + dark
  app.js                        state, polling, rendering, charts
  config.js                     THE ONLY FILE THE USER EDITS TO GO LIVE
                                (bundled at build time — a change needs a push)
  vite.config.js                build config
  public/                       copied verbatim into dist/ (CNAME, .nojekyll)
  .github/workflows/deploy.yml  test, build, publish dist/ to Pages
  lib/chart.js                  Chart.js + only the registrations used
  lib/parser.js                 CSV → rows
  lib/stats.js                  time windows, circular + rolling means, Beaufort, units
  lib/scale.js                  chart axis domains
  lib/drive.js                  Drive REST client
  lib/rose.js                   wind rose SVG
  lib/geocode.js                GPS fix → place name (cached, throttled)
  sample/SsLog-19-08-2026.csv   REAL log from the device (211 rows, 105 min)
  sample/SsLog-18-08-2026.csv   SYNTHETIC stress day (1922 rows, generated)
  test/geocode.test.mjs         21 tests
  test/parser.test.mjs          33 tests
  test/scale.test.mjs           20 tests
  test/stress.test.mjs          6 tests
  test/dom-smoke.mjs            78 assertions, jsdom + stubbed Chart.js/Drive/Nominatim
  test/make-stress-fixture.py   regenerates the synthetic day
  README.md                     setup and deployment
```

Verification status, all passing as of handover:

```bash
npm install
npm test                               # 80 tests
npm run test:dom                       # 78 assertions
npm run build && npm run preview       # visual check of the real bundle
```

The DOM smoke test boots the real `index.html` under jsdom with `window.Chart`
stubbed — jsdom has no canvas context — and with `fetch` emulating Drive, since
`config.js` now carries an API key and the page takes the live path.

Real Chart.js rendering has since been confirmed in a browser against the built
bundle: both charts draw, tooltips appear, and the crosshair plugin syncs hover
across the two. That check cannot use the deployed API key from localhost (it is
referrer-restricted and returns 403), so it was done by stubbing `fetch` in a
throwaway copy of `dist/`.

Because Chart.js is now registered piecemeal in `lib/chart.js` rather than
auto-registered, **a chart config using a component that is not registered will
throw at render time and no test will catch it** — the smoke test stubs Chart.js
out. Adding a chart type, scale or plugin means adding it there too.

---

## 4. Log format — the things that break naive parsers

All of these were found by inspecting a real file and are covered by tests.
Do not "simplify" the parser without re-reading this list.

| Trait | Example | Handling |
|---|---|---|
| Encoding is windows-1252 | `°` is one 0xB0 byte | `TextDecoder('windows-1252')` on an ArrayBuffer. `res.text()` assumes UTF-8 and mangles every degree sign |
| Header repeats mid-file | at lines 1, 2, 5 | Skip *any* line starting `'Date` — one is written per device session. The next data row is marked `sessionStart` and dropped in `app.js` |
| Column names have a leading apostrophe | `'Date, 'Time,` | Cosmetic, but don't match on `Date` alone |
| No-data sentinel | `- - - - -` | → `null`, never `0`. Seen in SOG/COG on GPS dropout (13 of 211 rows) |
| Dates are `dd/mm/yyyy` | `19/08/2026` | Parse explicitly. `new Date("08/09/2026")` is 8 Sept or 9 Aug depending on locale |
| Times carry `UTC` | `10:18:02 UTC` | Parse as UTC; display in `Europe/Istanbul` |
| Positions are deg + decimal minutes | `38° 19.080' N` | → `deg + min/60`, negate for S/W |
| Bearings are magnetic | `306° M` | Integer degrees; the `M` is meaningful |
| Sampling is irregular | 17–33 s, mostly 28–32 | **Every rolling stat must use a time window, never a row count** |
| Trailing comma | 11 fields, last always empty | Comment column is always empty in observed data |

Fixture facts for the real file (`SsLog-19-08-2026.csv`): 211 data rows (2 of
them marked `sessionStart`, so 209 reach the display),
3 header lines skipped, 1 blank, 13 sentinel rows, span 10:18:02–12:03:01 UTC,
TWS 7.3–11.2 kn, TWD 296°–339° M, station at 38.3180° N 26.6950° E.
A full 24 h day is expected to be ≈2,880 rows and ≈290 KB.

---

## 5. Design invariants — do not break these

1. **Raw direction samples are never joined by a line.** 359° → 002° is a 3°
   shift; a line through raw samples draws it as a full-scale cliff. Samples are
   plotted as points. Aggregation goes to the wind rose.
   The *axis* is continuous, though: points are unwrapped to within half a turn
   of the last 15-minute vector mean (`lib/scale.js`), so a northerly reads as
   one band instead of splitting across the top and bottom edges. Tick labels
   normalise back to 0–359.
   The **5-minute vector mean** *is* drawn as a line over those points, and this
   does not reopen the rule. It rides the same unwrapped, folded axis as the
   dots, and `breakWraps` (`lib/scale.js`) inserts a null wherever two adjacent
   values land on opposite edges — reachable only on the full-turn axis. No
   cliff is ever rendered. If you touch that pipeline, keep the mean series the
   same length as the sample series: `syncTo` cross-highlights the two charts by
   position.
2. **Circular means use unit vectors.** Arithmetic mean of 350° and 010° is
   180° — exactly backwards. See `vectorMeanDeg` in `lib/stats.js`.
3. **"Max", not "gust".** At 30 s sampling these are instantaneous samples, not
   the 3-second peak "gust" means meteorologically. The footer says so.
4. **The dial and both charts' mean lines smooth identically.** All read
   `SMOOTH_MINUTES` (5) from `lib/stats.js` — the dial via `summarise()`, the
   direction line via `rollingVectorMeanDeg()`, the speed line via
   `rollingMean()` — so the right-hand end of the direction line is the number
   under the dial (334° on the real fixture, where the last raw sample is 327°),
   and speed is smoothed over the same span rather than a second window nobody
   can compare against. Change the constant and all three move together.
   Both charts also draw the same marks: faded dots (`--accent-soft`) for every
   sample, the mean line in `--accent` over them, samples as dataset 0 because
   `syncTo` cross-highlights the charts by that index. Keep each mean series the
   same length as its sample series, for the same reason.
5. **Offline is a first-class state.** Over 15 min stale → dial greys out, pill
   reads "offline since HH:MM". A confident reading from yesterday is worse
   than no reading. States: live (<2 min), delayed (2–15 min), offline (>15 min),
   no-data, fetch-error.
6. **Must use `www.googleapis.com`.** It sends CORS headers.
   `drive.google.com/uc?export=download` does not and fails silently from a page.
7. **Sort Drive files by `modifiedTime`, never filename.** Survives midnight
   rollover, re-uploads and backfilled days.
8. **Only stationary rows, and no startup rows, reach the display.** `ingest` in
   `app.js` first drops rows the parser marked `sessionStart` — the device writes
   a header whenever it opens a log, and the row after it is the instrument
   warming up — then passes the rest through `mooredRows` (`lib/stats.js`) before
   anything else sees it,
   so the tiles, charts, rose and station marker are all built from readings
   taken at the mooring. A missing SOG is kept — the sentinel means a GPS
   dropout, not motion. The threshold is `CONFIG.maxSogKnots`; the CSV download
   still serves the untouched file. Filter here and nowhere else: the parser
   stays a pure CSV reader — it *marks* `sessionStart` rather than dropping,
   because it is the only thing that sees the file's original order before the
   sort — and the footer discloses both counts. Order matters: startup rows go
   first, so an under-way warm-up row is not counted twice.

9. **The place name is derived, never assumed.** It comes from the loaded file's
   own GPS fix (`lib/geocode.js`), because the vessel moves between regattas and
   a configured place would be wrong half the season. Two rules follow. First,
   `renderPlace()` runs *before* any await in `resolvePlaceFor` — when the day
   changes, the previous day's place must leave the screen immediately rather
   than sit above a log recorded 200 miles away. Second, every path in that
   module swallows its errors: a place name is cosmetic and must never be able
   to keep the wind data off the screen. Pending, disabled, failed and
   open-water lookups alike leave the line blank rather than name a guess.

---

## 6. Next tasks, in order

1. **Render check with real Chart.js.** Serve the folder, open in a browser,
   confirm both charts draw, the crosshair syncs between them, and the rose
   renders in both light and dark mode. This is the one thing the test suite
   cannot prove.
2. **Go live.** Create a browser API key (Drive API only + HTTP-referrer
   restriction), fill `config.js`, deploy to Cloudflare Pages / Netlify /
   GitHub Pages. Then confirm against the real folder: does `files.list` return
   what's expected, does the poll loop pick up a mid-day update?
3. **`Range` requests for the file tail.** Once a day's file is parsed, request
   only bytes past the last known offset and append, instead of re-downloading
   ~290 KB on every change. Drive's `alt=media` honours `Range`.
   Acceptance: a tab open for an hour transfers far less than 60 × file size.
4. **Mobile pass on a real phone in sunlight.** The layout is mobile-first but
   has only been checked at desktop widths.
5. **Long-run soak.** Leave it open across a device power-cycle and confirm the
   live → delayed → offline → live transitions all fire.

---

## 7. Open questions for the user

- **TWS units are assumed knots.** Not stated anywhere in the file. Confirm
  against the device manual — everything downstream (Beaufort bands, the rose's
  speed bins, the unit converter) depends on it.
- **Does the device log true gusts** in another mode? If so, prefer that over
  the 30-second maximum.
- **Station display name** for `config.js` (currently generic). The place label
  no longer needs deciding: it is derived from each file's own GPS fix.
- **Domain**, needed for the API-key referrer restriction.

---

## 8. Seed prompt for the new session

Paste this, and attach or point at the project folder:

> I'm continuing work on a static website that displays wind data from a
> Google Drive folder of daily CSVs. The project is complete and tested —
> read `HANDOVER.md` first, then `README.md`. It covers the locked design
> decisions, the log-format gotchas, and the invariants I don't want broken.
>
> Current state: 22 unit tests and 34 DOM assertions pass, but the charts have
> never been rendered by real Chart.js because the build sandbox had no CDN
> access. Start with task 1 in the handover — a render check in a real browser
> — then we'll move on to `Range` requests for the file tail.

If the new session has no filesystem access, the files it most needs pasted are
`lib/parser.js`, `lib/stats.js` and `app.js`, in that order.
