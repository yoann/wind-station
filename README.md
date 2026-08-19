# Wind station

A static, public, live-first page showing wind speed and direction from a
device that writes one CSV per day into a Google Drive folder.

No backend, no build step. One charting library from a CDN; everything else is
plain HTML, CSS and ES modules.

**All directions are magnetic**, exactly as the instrument logs them. Nothing is
corrected to true north.

---

## Run it now

```bash
python3 -m http.server 8080     # or: npx serve
open http://localhost:8080
```

With no API key configured, the site starts in **demo mode** against the two
bundled sample days, so you can see it working before touching Google Cloud.
The day picker switches between them.

You must serve over HTTP. Opening `index.html` from the filesystem fails —
ES modules are blocked on `file://`.

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

3. **Fill in `config.js`** — `apiKey`, `stationName`, `placeName`.

4. **Deploy the folder** to any static host: Cloudflare Pages, Netlify, GitHub
   Pages. Nothing needs to run server-side.

## How it fetches

Two calls against `www.googleapis.com`, which sends CORS headers.
(`drive.google.com/uc?export=download` does **not** and fails silently from a
page — don't switch to it.)

- Every 30 s: `files.list` for the folder, `orderBy=modifiedTime desc`,
  `pageSize=1`. About 1 KB. Sorted by modification time, never filename, so
  midnight rollover and re-uploads are handled.
- Only when `modifiedTime` changes: `files/{id}?alt=media` for the CSV.

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

## Design notes worth keeping

- **Direction is never a line chart.** 359° → 002° is a 3° shift; a line draws
  it as a full-scale cliff. Individual samples are plotted as points on a
  0–360 axis, and aggregation goes to the wind rose.
- **Circular means use vectors.** The arithmetic mean of 350° and 010° is 180°,
  pointing exactly backwards. `vectorMeanDeg` averages unit vectors instead.
- **The dial smooths, the chart does not.** The hero shows a 5-minute vector
  mean of direction to damp jitter; the chart plots every sample. This is
  disclosed in the page footer.
- **"Max", not "gust".** At 30 s sampling these are instantaneous samples, not
  the 3-second peak that "gust" means meteorologically.
- **Offline is a first-class state.** Over 15 minutes stale, the dial greys out
  and the pill reads "offline since HH:MM". A confident-looking reading from
  yesterday is worse than no reading.

## Tests

```bash
node --test 'test/*.test.mjs'
```

22 assertions over the parser, the statistics and the wind rose, with fixtures
taken from a real log: 211 rows, 3 header blocks, 13 sentinel rows, TWS
7.3–11.2, TWD 296–339 M.

`test/stress.test.mjs` runs against a synthetic day that the real sample cannot
exercise — gale-force 41 kn, all 16 direction sectors, and a 40-minute outage.
Regenerate it with:

```bash
python3 test/make-stress-fixture.py > sample/SsLog-18-08-2026.csv
```

There is also a DOM smoke test that boots the real page under jsdom with
Chart.js stubbed, checking the readouts, tiles, rose, charts, unit switch and
day picker end to end:

```bash
npm install --no-save jsdom
node test/dom-smoke.mjs
```

## Layout

```
index.html        page structure
app.css           theme, light and dark
app.js            state, polling, rendering, charts
config.js         the only file you need to edit
lib/parser.js     CSV → rows
lib/stats.js      windows, circular means, Beaufort, units
lib/drive.js      Drive REST client
lib/rose.js       wind rose SVG
```

## Not built yet

- Range requests for the tail of a growing file (currently re-fetches whole).
- A map. The station is moored — position is in the footer and the CSV only.
- Multi-day aggregation, which needs precomputation a static site can't do.
