# Wind station website — build spec

Static, public, live-first page reading one-file-per-day CSV logs from a Google Drive folder.

## Decisions locked

| Decision | Choice |
|---|---|
| Audience | Public — anyone with the link |
| Priority | Live conditions now; history is secondary |
| Infrastructure | Static hosting only, no backend |
| Direction reference | **Magnetic**, as logged. No WMM conversion. |
| Position | Fixed marker, station is moored. No live track. |
| Source folder | Drive `12Sn5_2YPEmH2ZzxTXy9Fcy8M6MZGi8Qr` ("Wind_data") |

Because directions stay magnetic, every direction readout on the page carries an `M` suffix
(`306° M`) and the page footer states once: *directions are magnetic, not true*. This is not
optional — a stranger with the link will otherwise assume true.

---

## 1. Data source

### Two Drive REST calls

The folder must remain shared as "anyone with the link". Use `www.googleapis.com`, which sends
CORS headers. **Do not** use `drive.google.com/uc?export=download` — no CORS, the fetch fails
silently from a page.

**Poll (every 30 s, ~1 KB):**

```
GET https://www.googleapis.com/drive/v3/files
  ?q='12Sn5_2YPEmH2ZzxTXy9Fcy8M6MZGi8Qr'+in+parents+and+trashed=false
  &orderBy=modifiedTime desc
  &pageSize=1
  &fields=files(id,name,modifiedTime,size)
  &key=API_KEY
```

Take `files[0]`. Sort by `modifiedTime`, never by filename — this survives midnight rollover,
re-uploads, and backfilled days. Filename (`SsLog-19-08-2026.csv`, dd-mm-yyyy) is a display
fallback only.

**Download (only when `modifiedTime` differs from last seen):**

```
GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media&key=API_KEY
```

### API key

Public by necessity. In Google Cloud Console: restrict to the Drive API only, and add an
HTTP-referrer restriction for the site's domain. Keep nothing else in that folder.

### Polling behaviour

- 30 s interval. Pause on `document.visibilitychange` → hidden; resume and poll immediately on
  return.
- Exponential backoff on error: 30 s → 60 s → 120 s, cap 5 min. Never hammer.
- v2 optimisation: once the file is parsed, send `Range: bytes=N-` on subsequent media fetches
  and append only the tail. Skip for v1 — a full day is ~290 KB.

---

## 2. File format and parser

### Observed format

```
'Date, 'Time, 'Latitude, 'Longitude, 'SOG, 'COG, 'TWS, 'TWA, 'TWD, 'Comment,
19/08/2026, 10:18:02 UTC, 38° 19.080' N, 026° 41.698' E, 00.1, 355° M, 08.4, 026° Port, 306° M, ,
```

Encoding **windows-1252**. CRLF line endings. Delimiter is comma-space. Trailing comma yields an
11th always-empty field.

### Parser rules

1. **Decode as windows-1252.** `new TextDecoder('windows-1252').decode(await res.arrayBuffer())`.
   `res.text()` assumes UTF-8 and mangles every `°`.
2. **Skip repeated headers.** The header recurs mid-file (observed at lines 1, 2 and 5) — the
   device writes one per session. Skip *any* line whose trimmed form starts with `'Date`. Note
   the leading apostrophe on column names.
3. **Skip blank lines**, including the trailing one.
4. **Split on `,`, trim each field.** Expect 11.
5. **Timestamp.** Date is `dd/mm/yyyy`; time is `HH:MM:SS UTC`. Parse explicitly into
   `Date.UTC(y, m-1, d, hh, mm, ss)`. Never pass the raw string to `new Date()` — `08/09/2026` is
   ambiguous and will parse as September in some locales.
6. **Null sentinel.** `- - - - -` means no data (seen in SOG and COG on GPS dropout, 13 of 211
   rows). Match `/^[-\s]+$/` → `null`. Let nulls reach the chart as gaps; do not coerce to 0.
7. **TWS.** `parseFloat`. Units assumed knots — see open items.
8. **TWD.** `/^(\d{1,3})°/` → integer, magnetic.
9. **Position.** `38° 19.080' N` is degrees + decimal minutes → `deg + min/60`, negate for S/W.
   Parse once from the first valid row; the station is moored.
10. **Ignore** TWA, SOG, COG and Comment for display — TWA is relative to a stationary hull and
    carries no information here. Keep them in the CSV download.

### Sampling interval is not fixed

Observed 17–33 s, mostly 28–32. **Every rolling statistic must use a time window against parsed
timestamps, never a row count.** "Last hour" is not "the last 120 rows".

---

## 3. Derived values

| Value | Rule |
|---|---|
| Current | Last row with non-null TWS |
| Mean (10 min, 60 min) | Arithmetic mean of TWS in the time window |
| Max (10 min, 60 min) | Max TWS in window — **label "max", not "gust"** |
| Trend | mean(last 10 min) − mean(previous 10 min), shown as ±kn |
| Direction now | Vector mean of last 5 min |
| Veer / back | Signed circular difference: vector mean now vs 30 min ago. >0 veering, <0 backing |
| Beaufort | Standard knots→force bands, with descriptor ("fresh breeze, force 5") |
| Cardinal | 16-point from magnetic degrees, suffixed `M` |

**Direction maths is circular.** Always convert to unit vectors, average sin and cos, then
`atan2`. Arithmetic mean of 350° and 010° gives 180° — pointing exactly backwards.

**Do not call the max a gust.** At ~30 s sampling you are recording instantaneous samples, not
the 3-second peak that "gust" means meteorologically. Labelling it "max, last hour" is accurate
and costs nothing.

---

## 4. Page structure

Single page, single column on mobile, max ~900 px on desktop. Order top to bottom:

1. **Header** — station name, place name, freshness pill.
2. **Hero** — compass dial (needle at TWD magnetic) with TWS as the centre number; Beaufort
   descriptor line beneath. This plus the pill fills the first mobile screen.
3. **Secondary tiles** (2×2) — max 60 min, mean 60 min, trend, veer/back.
4. **Charts** — TWS line over the day; TWD below it as *dots* on a 0–360 axis with N/E/S/W ticks,
   sharing one x-axis and one crosshair.
5. **Wind rose** — 16 sectors × Beaufort bins, computed client-side from the day's rows.
6. **Day picker + CSV download** — lazy: fetches one day's file on demand. Do not attempt
   multi-day ranges without a backend.
7. **Footer** — magnetic-direction note, sampling interval, data source.

### Direction is never a line chart

359° → 002° is a 3° shift but plots as a 357° cliff. Dots on a 0–360 axis avoid the artifact
entirely; a steady breeze still reads as a flat band. Aggregation goes to the rose.

### States

| State | Condition | Presentation |
|---|---|---|
| Live | Last sample < 2 min | Green pill, "live · Ns ago" |
| Delayed | 2–15 min | Amber pill, "last reading HH:MM" |
| Offline | > 15 min | Grey pill, dial desaturated, "station offline since HH:MM" |
| No data today | File empty or absent | Hero replaced by "no readings yet today", charts hidden |
| Fetch error | Drive call failed | Keep last good data on screen, amber pill "reconnecting" |

A public page showing a confident 18 kn from yesterday is worse than one admitting the station is
off. Build the offline state first, not last.

---

## 5. Visual language

- Dark-capable, high contrast, legible in sunlight. Mobile-first.
- One blue sequential ramp keyed to Beaufort bands, reused in the rose and any heatmap. No
  rainbow, no per-chart palette.
- Times displayed in Europe/Istanbul with the UTC value in the tooltip. The log is explicit UTC,
  so there is no guessing.
- Units toggle: knots (default) / m/s / km/h. Persist in `localStorage` and mirror to the URL
  hash so a shared link keeps the sender's units.

---

## 6. Stack

Vanilla HTML/CSS/JS plus Chart.js from a CDN is enough and keeps first paint fast — no build
step, no framework. Host on Cloudflare Pages, Netlify, or GitHub Pages. Total dependency
surface: one charting library.

---

## 7. Build order

1. Parser + fixtures. Unit-test against the 19/08 file: 211 data rows, 3 header lines skipped,
   13 sentinel rows, span 10:18:02–12:03:01 UTC, TWS 7.3–11.2, TWD 296–339 M.
2. Drive fetch + poll loop with backoff, logging to console only.
3. Hero + freshness states, including offline and no-data.
4. TWS and TWD charts with shared axis.
5. Wind rose.
6. Day picker, CSV download, units toggle, footer.

Test with synthetic data at 35 kn gusting and with a six-hour-old file. A layout that works at
9 kn steady can fail badly at both.

---

## 8. Open items

- **TWS units** — assumed knots. Confirm against the device manual.
- **Does the device log gusts separately?** If a gust column exists in another log mode, it is
  worth enabling; the 30 s max is a weaker substitute.
- **Station display name** and the place label for the fixed marker.
- **Domain** for the referrer restriction on the API key.
