// Parser for SsLog-style wind station CSV files.
//
// Format notes that drive every decision here:
//   - encoding is windows-1252, not UTF-8 (the degree sign is a single 0xB0 byte)
//   - the header line recurs mid-file, once per device session
//   - column names carry a leading apostrophe ('Date, 'Time, ...)
//   - "- - - - -" is the no-data sentinel
//   - dates are dd/mm/yyyy, times are HH:MM:SS UTC
//   - directions are MAGNETIC ("306° M")

const HEADER_PREFIX = "'Date";
const SENTINEL = /^[-\s]+$/;

/** Decode raw bytes as windows-1252, falling back to latin1 (identical for our byte range). */
export function decodeLog(bytes) {
  const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  try {
    return new TextDecoder('windows-1252').decode(buf);
  } catch {
    return new TextDecoder('latin1').decode(buf);
  }
}

/** "10:18:02 UTC" + "19/08/2026" -> epoch ms, or null if unparseable. */
export function parseTimestamp(dateStr, timeStr) {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateStr.trim());
  const t = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(timeStr.trim());
  if (!d || !t) return null;
  const [, dd, mm, yyyy] = d.map(Number);
  const [, hh, mi, ss] = t.map(Number);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 60) return null;
  return Date.UTC(yyyy, mm - 1, dd, hh, mi, ss);
}

/** "38° 19.080' N" -> 38.318. Returns null on sentinel or malformed input. */
export function parseDegMin(str) {
  const s = String(str).trim();
  if (!s || SENTINEL.test(s)) return null;
  const m = /^(\d+)\D+([\d.]+)\D*([NSEW])/i.exec(s);
  if (!m) return null;
  const deg = Number(m[1]) + Number(m[2]) / 60;
  const hemi = m[3].toUpperCase();
  return hemi === 'S' || hemi === 'W' ? -deg : deg;
}

/** "306° M" -> 306. Returns null on sentinel. */
export function parseBearing(str) {
  const s = String(str).trim();
  if (!s || SENTINEL.test(s)) return null;
  const m = /^(\d{1,3})/.exec(s);
  if (!m) return null;
  const deg = Number(m[1]);
  return deg >= 0 && deg <= 360 ? deg % 360 : null;
}

/** Numeric field with sentinel handling. Never coerces missing data to 0. */
export function parseNumber(str) {
  const s = String(str).trim();
  if (!s || SENTINEL.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "026° Port" -> { angle: 26, side: 'port' } */
export function parseTwa(str) {
  const s = String(str).trim();
  if (!s || SENTINEL.test(s)) return null;
  const m = /^(\d{1,3})\D+(Port|Stbd)/i.exec(s);
  if (!m) return null;
  return { angle: Number(m[1]), side: m[2].toLowerCase() === 'port' ? 'port' : 'stbd' };
}

/**
 * Parse a full log file.
 * @param {string} text  windows-1252-decoded file contents
 * @returns {{rows: Array, station: {lat:number, lon:number}|null, skipped: object}}
 */
export function parseLog(text) {
  const lines = String(text).split(/\r?\n/);
  const rows = [];
  const skipped = { header: 0, blank: 0, malformed: 0 };
  let station = null;
  // The device writes a header every time it opens a logging session, so the
  // next data row is the instrument warming up. Marked here because only the
  // scan knows the file order — `rows` is sorted by timestamp before it leaves.
  // Marking, not dropping: this stays a pure reader, app.js does the filtering.
  let pendingSessionStart = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { skipped.blank++; continue; }
    if (trimmed.startsWith(HEADER_PREFIX)) {
      skipped.header++;
      pendingSessionStart = true;
      continue;
    }

    const f = line.split(',').map((s) => s.trim());
    if (f.length < 9) { skipped.malformed++; continue; }

    const t = parseTimestamp(f[0], f[1]);
    if (t === null) { skipped.malformed++; continue; }

    const lat = parseDegMin(f[2]);
    const lon = parseDegMin(f[3]);
    if (station === null && lat !== null && lon !== null) station = { lat, lon };

    rows.push({
      t,
      lat,
      lon,
      sog: parseNumber(f[4]),
      cog: parseBearing(f[5]),
      tws: parseNumber(f[6]),
      twa: parseTwa(f[7]),
      twd: parseBearing(f[8]),
      comment: (f[9] || '').trim() || null,
      sessionStart: pendingSessionStart,
    });
    pendingSessionStart = false;
  }

  rows.sort((a, b) => a.t - b.t);
  return { rows, station, skipped };
}

/** Convenience: bytes -> parsed result. */
export function parseLogBytes(bytes) {
  return parseLog(decodeLog(bytes));
}

/** dd-mm-yyyy embedded in a filename -> { y, m, d, label } */
export function dateFromFilename(name) {
  const m = /(\d{2})-(\d{2})-(\d{4})/.exec(String(name));
  if (!m) return null;
  const [, dd, mm, yyyy] = m.map(Number);
  return { y: yyyy, m: mm, d: dd, iso: `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}` };
}
