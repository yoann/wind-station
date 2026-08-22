# Wind station

A static, public, live-first page showing wind speed and direction from a
device that writes one CSV per day into a Google Drive folder.

No backend. A Vite build bundles the page into one JS file and one CSS file —
Chart.js included, so nothing is fetched from a CDN at runtime. The source is
plain HTML, CSS and ES modules.

**All directions are magnetic**, exactly as the instrument logs them. Nothing is
corrected to true north.

---

## Run it now

```bash
npm install
npm run dev          # http://localhost:5173
```

With no API key configured, the site starts in **demo mode** against the two
bundled sample days, so you can see it working before touching Google Cloud.
The day picker switches between them. `sample/` is served by the dev server but
is deliberately left out of the production build.

To check the real build output rather than the dev server:

```bash
npm run build && npm run preview
```

## Go live

1. **Share the folder.** In Drive, set the folder to "anyone with the link".

2. **Create a browser API key.** Google Cloud Console → APIs & Services →
   Credentials → Create credentials → API key. Then edit the key:
   - *API restrictions*: restrict to **Google Drive API** only.
   - *Application restrictions*: **HTTP referrers**, matching your domain
     (e.g. `https://wind.example.org/*`).

   The key ships in your JavaScript and is readable by anyone. The referrer
   restriction is what makes that safe — it can only be used from your site,
   against a folder you already made public. Keep nothing else in that folder.

3. **Fill in `config.js`** — `apiKey`, `stationName`, `timeZone`.

4. **Push to `main`.** `.github/workflows/deploy.yml` runs the tests, builds,
   and publishes **only `dist/`** to GitHub Pages. The repo root — this README,
   the specs, `sample/`, `test/`, the unbundled sources — is never served.

   This requires *Settings → Pages → Source* set to **GitHub Actions**. Note
   that `config.js` is bundled at build time, so a config change needs a push,
   not an edit on the server. Nothing runs server-side.

## How it fetches

Two calls against `www.googleapis.com`, which sends CORS headers.
(`drive.google.com/uc?export=download` does **not** and fails silently from a
page — don't switch to it.)

- Every 30 s: `files.list` for the folder, `orderBy=modifiedTime desc`,
  `pageSize=1`. About 1 KB. Sorted by modification time, never filename, so
  midnight rollover and re-uploads are handled.
- Only when `modifiedTime` changes: `files/{id}?alt=media` for the CSV.
- Once per day file, ever: `files/{id}?alt=media` with `Range: bytes=0-2047`,
  to read that day's opening GPS fix for the picker label. See **Location**.

Polling pauses when the tab is hidden and backs off exponentially on error
(30 s → 60 s → … → 5 min cap). Selecting a past day pauses live polling until
you press "Back to live".

## Log format

The parser handles these, all observed in real files:

| Trait | Handling |
|---|---|
| windows-1252 encoding | decoded via `TextDecoder('windows-1252')` — `res.text()` would mangle every `°` |
| Header repeats mid-file | every line starting `'Date` is skipped, not just line 1 |
| `- - - - -` no-data sentinel | becomes `null`, never `0`; charts show a gap |
| `dd/mm/yyyy` dates | parsed explicitly; never passed to `new Date()` |
| `HH:MM:SS UTC` times | parsed as UTC, displayed in `config.timeZone` |
| `38° 19.080' N` positions | degrees + decimal minutes → decimal degrees |
| `306° M` bearings | integer degrees, magnetic |
| Irregular 17–33 s sampling | every rolling statistic uses a **time** window, never a row count |

## Location

The place under the title is **derived from the log**, not configured. Every row
carries a GPS fix, so each day's file states where it was recorded — which
matters, because the station is a race committee vessel that moves between
regattas. A hardcoded place would be wrong for half the season.

- The fix is reverse-geocoded through OpenStreetMap Nominatim (no API key).
- The picker names a day only when the folder spans more than one place; when
  every day is from the same anchorage the name is noise and the masthead
  already carries it.
- To label days that have not been downloaded, each file is probed once with a
  2 KB `Range` request — enough to reach its first data row.
- Answers are cached in `localStorage`, keyed to the fix rounded to ~100 m, so
  mooring swing does not re-ask and a whole season at one anchorage costs a
  single request. Requests are spaced to one per second, Nominatim's policy.
- Names are requested in English (`geocode.language`), so a station off Turkey
  reads "Urla, Turkey" rather than the local spelling.
- A fix in open water genuinely resolves to nothing. That, a disabled lookup and
  an unreachable network all leave the line blank — the page never guesses.

**Privacy:** enabling this sends the station's coordinates to Nominatim. Set
`geocode.enabled: false` in `config.js` to keep them on the device; the page
then shows no place at all.

## Design notes worth keeping

- **Direction samples are never joined by a line.** 359° → 002° is a 3° shift;
  a line through raw samples draws it as a full-scale cliff. Individual samples
  are plotted as points, and aggregation goes to the wind rose. The one line on
  that chart is the 5-minute vector mean, which is safe because it rides the
  unwrapped axis and is broken with a gap wherever a fold would draw a cliff
  (`breakWraps` in `lib/scale.js`).
- **Both charts carry the same mark.** Speed is drawn the same way as direction:
  faded dots for every sample, one 5-minute mean line over them. The panels
  stack, so the same mark should mean the same thing in both — and the dots keep
  the gusting spread on screen, which a smoothed line alone would hide.
- **Both chart axes are cut to the data.** Min and max come from the day's
  samples plus a margin, over a minimum span so a flat stretch does not zoom
  into sampling noise. Direction is centred on the last 15-minute vector mean
  and unwrapped around it, keeping a northerly in one band. See `lib/scale.js`.
- **Circular means use vectors.** The arithmetic mean of 350° and 010° is 180°,
  pointing exactly backwards. `vectorMeanDeg` averages unit vectors instead.
- **The dial and the charts' mean lines smooth identically.** All three use
  `SMOOTH_MINUTES` (5) from `lib/stats.js`, so the right-hand end of the
  direction line is the number under the dial, and speed is smoothed over the
  same span. The dots behind the lines are still every raw sample.
- **"Max", not "gust".** At 30 s sampling these are instantaneous samples, not
  the 3-second peak that "gust" means meteorologically.
- **Offline is a first-class state.** Over 15 minutes stale, the dial greys out
  and the pill reads "offline since HH:MM". A confident-looking reading from
  yesterday is worse than no reading.
- **Rows logged under way are excluded.** The instrument sits on a race
  committee vessel, so anything recorded above `maxSogKnots` (2 kn over ground)
  is a boat-motion reading from somewhere other than the mooring. Those rows
  never reach the tiles, charts, rose or station marker; the footer says how
  many were dropped, and the CSV download still serves the untouched file. A
  missing SOG is kept — that sentinel means a GPS dropout, not motion.
- **The first reading of each session is dropped.** The device writes a fresh
  header line every time it opens a log, and the row that follows is the
  instrument starting up. The parser only *marks* those rows (`sessionStart`) —
  it is the one place that knows the file's original order, since rows are
  sorted by timestamp before they leave it — and `ingest` in `app.js` drops
  them, before the under-way filter so the two counts stay honest.

## Tests

```bash
npm test
```

80 tests over the parser, the statistics, the axis scales, the geocoder and the
wind rose, with fixtures taken from a real log: 211 rows, 3 header blocks,
13 sentinel rows, TWS 7.3–11.2, TWD 296–339 M.

`test/stress.test.mjs` runs against a synthetic day that the real sample cannot
exercise — gale-force 41 kn, all 16 direction sectors, and a 40-minute outage.
Regenerate it with:

```bash
python3 test/make-stress-fixture.py > sample/SsLog-18-08-2026.csv
```

There is also a DOM smoke test that boots the real page under jsdom with
Chart.js stubbed and Drive faked, checking the readouts, tiles, rose, charts,
unit switch and day picker end to end:

```bash
npm run test:dom
```

Both suites run in CI and a failure blocks the deploy.

## Layout

```
index.html        page structure, and the Vite build entry
app.css           theme, light and dark
app.js            state, polling, rendering, charts
config.js         the only file you need to edit
lib/parser.js     CSV → rows
lib/stats.js      windows, circular means, Beaufort, units
lib/scale.js      chart axis domains
lib/drive.js      Drive REST client
lib/rose.js       wind rose SVG
lib/chart.js      Chart.js, with only the used pieces registered
vite.config.js    build config
public/           copied verbatim into dist/ (CNAME, .nojekyll)
```

## Not built yet

- Range requests for the tail of a growing file (currently re-fetches whole).
  The request itself now exists — `fetchFileHead` in `lib/drive.js` — but it is
  only used to read a file's opening fix, not to follow one that is growing.
- A map. The station is moored — position is in the footer and the CSV only.
- Multi-day aggregation, which needs precomputation a static site can't do.
