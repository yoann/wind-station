// Reverse geocoding: a GPS fix -> a human place name.
//
// The station is a race committee vessel, so each log can come from a different
// anchorage. Rather than trust a hardcoded place in config, we ask an online
// gazetteer (OpenStreetMap Nominatim by default) what is at the coordinates.
//
// Three rules shape everything here:
//   - Never throw, never block. A missing place name is cosmetic; the wind data
//     must render identically with the network unplugged.
//   - Never hammer the endpoint. Nominatim's usage policy is one request per
//     second, so every call is serialised through a single spaced queue.
//   - Round before caching. Fixes drift by metres while the boat swings, so a
//     whole season at one anchorage must cost exactly one lookup.

const CACHE_KEY = 'wind-station.places.v1';
const MAX_ENTRIES = 200;

const DEFAULTS = {
  endpoint: 'https://nominatim.openstreetmap.org/reverse',
  zoom: 14,
  minIntervalMs: 1100,
  cacheDays: 90,
};

// Most specific first. Nominatim populates whichever of these exist at the zoom
// it answered at; the further offshore the fix, the coarser the answer, and past
// territorial waters there is no answer at all.
//
// `town` deliberately outranks `suburb`: a fix off Urla comes back with both
// (suburb "İçmeler", town "Urla"), and the town is the one a sailor would name.
// `province` and `region` are here because that is all a fix in open bay water
// resolves to — without them a real station reads as just "Türkiye".
const LOCALITY_KEYS = [
  'village', 'town', 'city', 'municipality', 'suburb',
  'county', 'state', 'province', 'region',
];

// Memory layer over localStorage: cheap, and it also survives a storage that
// throws (private browsing) so a session still de-duplicates its own lookups.
const memory = new Map();     // coordKey -> string | null
const inflight = new Map();   // coordKey -> Promise<string|null>

let chain = Promise.resolve();
let lastFetchAt = -Infinity;

/**
 * Cache key for a fix, rounded to ~100 m.
 * The rounding is the point: it collapses mooring swing into one lookup.
 */
export function coordKey(lat, lon) {
  return `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
}

/** "Urla, Türkiye" -> "Urla". The picker has no room for the country. */
export function localityOf(place) {
  if (!place) return null;
  return String(place).split(',')[0].trim() || null;
}

/**
 * Nominatim payload -> display string, or null if it names nowhere.
 * Open water commonly returns an error body or an address with no locality.
 */
export function formatPlace(payload) {
  if (!payload || payload.error) return null;
  const address = payload.address;
  if (!address) return null;

  let locality = null;
  for (const key of LOCALITY_KEYS) {
    const value = address[key];
    if (value) { locality = String(value).trim(); break; }
  }
  const country = address.country ? String(address.country).trim() : null;

  if (!locality) return country || null;
  if (!country || country === locality) return locality;
  return `${locality}, ${country}`;
}

/* -- cache ---------------------------------------------------------------- */

function readCache(storage) {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};   // absent, unparseable, or a storage that throws — all the same
  }
}

function writeCache(storage, entries) {
  try {
    let keys = Object.keys(entries);
    if (keys.length > MAX_ENTRIES) {
      // Drop the oldest first so a long-lived browser cannot grow unbounded.
      keys = keys.sort((a, b) => (entries[b].ts ?? 0) - (entries[a].ts ?? 0)).slice(0, MAX_ENTRIES);
      entries = Object.fromEntries(keys.map((k) => [k, entries[k]]));
    }
    storage?.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch { /* quota, private mode — the lookup still worked, just not cached */ }
}

/* -- throttle ------------------------------------------------------------- */

// One queue for the whole module: N pending files still respect one req/sec.
function schedule(task, { minIntervalMs, now, wait }) {
  const run = chain.then(async () => {
    const gap = minIntervalMs - (now() - lastFetchAt);
    if (gap > 0) await wait(gap);
    lastFetchAt = now();
    return task();
  });
  chain = run.then(() => {}, () => {});   // a failed task must not stall the queue
  return run;
}

/* -- lookup --------------------------------------------------------------- */

/**
 * Reverse-geocode a fix. Resolves to a place name or null — never rejects.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {object} [opts]  endpoint, zoom, minIntervalMs, cacheDays, and the
 *                         injectables fetch / now / wait / storage (tests).
 * @returns {Promise<string|null>}
 */
export function reverseGeocode(lat, lon, opts = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return Promise.resolve(null);

  const {
    endpoint = DEFAULTS.endpoint,
    zoom = DEFAULTS.zoom,
    minIntervalMs = DEFAULTS.minIntervalMs,
    cacheDays = DEFAULTS.cacheDays,
    fetch: fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    storage = globalThis.localStorage,
  } = opts;

  const key = coordKey(lat, lon);
  if (memory.has(key)) return Promise.resolve(memory.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const entries = readCache(storage);
  const hit = entries[key];
  const ttl = cacheDays * 24 * 60 * 60 * 1000;
  if (hit && typeof hit === 'object' && now() - (hit.ts ?? 0) < ttl) {
    const name = hit.name ?? null;
    memory.set(key, name);
    return Promise.resolve(name);
  }

  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lon),
    zoom: String(zoom),
    addressdetails: '1',
  });

  const promise = schedule(async () => {
    if (typeof fetchImpl !== 'function') return null;
    const res = await fetchImpl(`${endpoint}?${params}`, { headers: { Accept: 'application/json' } });
    if (!res?.ok) return null;
    return formatPlace(await res.json());
  }, { minIntervalMs, now, wait })
    // A miss is cached too: open water should not be re-asked on every reload.
    .then((name) => name ?? null, () => null)
    .then((name) => {
      memory.set(key, name);
      const fresh = readCache(storage);
      fresh[key] = { name, ts: now() };
      writeCache(storage, fresh);
      inflight.delete(key);
      return name;
    });

  inflight.set(key, promise);
  return promise;
}

/** Test seam: drop the in-process caches. Does not touch localStorage. */
export function resetGeocodeCache() {
  memory.clear();
  inflight.clear();
  chain = Promise.resolve();
  lastFetchAt = -Infinity;
}
