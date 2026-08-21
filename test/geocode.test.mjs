import test from 'node:test';
import assert from 'node:assert/strict';
import { coordKey, localityOf, formatPlace, reverseGeocode, resetGeocodeCache } from '../lib/geocode.js';

/** A localStorage stand-in. `throws` models private-browsing mode. */
function memoryStorage({ throws = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem(k) { if (throws) throw new Error('denied'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (throws) throw new Error('denied'); map.set(k, String(v)); },
  };
}

/** Records every call, answers with a canned Nominatim body. */
function stubFetch(body, { ok = true } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    return { ok, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const URLA = { address: { town: 'Urla', country: 'Türkiye' } };

/** Options with a fake clock, so throttling is asserted without sleeping. */
function harness(fetchImpl, extra = {}) {
  const waits = [];
  let clock = 0;
  return {
    waits,
    tick: () => clock,
    opts: {
      fetch: fetchImpl,
      storage: memoryStorage(),
      now: () => clock,
      wait: async (ms) => { waits.push(ms); clock += ms; },
      minIntervalMs: 1000,
      ...extra,
    },
  };
}

test('coordKey rounds to ~100 m', () => {
  assert.equal(coordKey(38.31800, 26.694966), '38.318,26.695');
  assert.equal(coordKey(-38.3, -26.7), '-38.300,-26.700');
});

test('localityOf keeps only the town', () => {
  assert.equal(localityOf('Urla, Türkiye'), 'Urla');
  assert.equal(localityOf('Urla'), 'Urla');
  assert.equal(localityOf(null), null);
  assert.equal(localityOf(''), null);
});

test('formatPlace prefers the most specific locality', () => {
  assert.equal(formatPlace({ address: { village: 'Zeytineli', town: 'Urla', country: 'Türkiye' } }),
    'Zeytineli, Türkiye');
  assert.equal(formatPlace({ address: { city: 'İzmir', county: 'X', country: 'Türkiye' } }),
    'İzmir, Türkiye');
});

// Captured from nominatim.openstreetmap.org for the station's own fix,
// 38.318 N 26.695 E, at the zoom config.js ships with.
test('formatPlace names the town for the real station fix', () => {
  const zoom14 = {
    address: {
      suburb: 'İçmeler',
      city_district: 'İçmeler Mahallesi',
      town: 'Urla',
      province: 'İzmir',
      region: 'Ege Bölgesi',
      postcode: '35430',
      country: 'Türkiye',
      country_code: 'tr',
    },
  };
  // The town, not the suburb: "İçmeler" is more precise than a sailor wants.
  assert.equal(formatPlace(zoom14), 'Urla, Türkiye');
});

// The same fix at zoom 12, which is all a coarser query returns. Without
// province in the chain this degrades to a bare "Türkiye".
test('formatPlace falls back to the province when nothing finer is returned', () => {
  const zoom12 = {
    address: { province: 'İzmir', region: 'Ege Bölgesi', country: 'Türkiye', country_code: 'tr' },
  };
  assert.equal(formatPlace(zoom12), 'İzmir, Türkiye');
});

// Real body for a fix in open sea, served with HTTP 200.
test('formatPlace returns nothing for open water', () => {
  assert.equal(formatPlace({ error: 'Unable to geocode' }), null);
});

test('formatPlace falls back to country alone, then to null', () => {
  assert.equal(formatPlace({ address: { country: 'Türkiye' } }), 'Türkiye');
  assert.equal(formatPlace({ address: {} }), null);
  assert.equal(formatPlace({ error: 'Unable to geocode' }), null);
  assert.equal(formatPlace(null), null);
});

test('formatPlace does not repeat a name that is also the country', () => {
  assert.equal(formatPlace({ address: { state: 'Malta', country: 'Malta' } }), 'Malta');
});

test('a fix 30 m away is the same lookup', async () => {
  resetGeocodeCache();
  const fetchImpl = stubFetch(URLA);
  const { opts } = harness(fetchImpl);
  assert.equal(await reverseGeocode(38.3180, 26.6950, opts), 'Urla, Türkiye');
  assert.equal(await reverseGeocode(38.3183, 26.6952, opts), 'Urla, Türkiye');
  assert.equal(fetchImpl.calls.length, 1, 'mooring swing must not cost a second request');
});

test('concurrent calls for one coordinate issue a single request', async () => {
  resetGeocodeCache();
  const fetchImpl = stubFetch(URLA);
  const { opts } = harness(fetchImpl);
  const names = await Promise.all([
    reverseGeocode(38.318, 26.695, opts),
    reverseGeocode(38.318, 26.695, opts),
    reverseGeocode(38.318, 26.695, opts),
  ]);
  assert.deepEqual(names, ['Urla, Türkiye', 'Urla, Türkiye', 'Urla, Türkiye']);
  assert.equal(fetchImpl.calls.length, 1);
});

test('a warm localStorage cache issues no request at all', async () => {
  resetGeocodeCache();
  const first = stubFetch(URLA);
  const { opts } = harness(first);
  await reverseGeocode(38.318, 26.695, opts);
  assert.equal(first.calls.length, 1);

  // New process, same browser: memory is empty but the store is warm.
  resetGeocodeCache();
  const second = stubFetch(URLA);
  const name = await reverseGeocode(38.318, 26.695, { ...opts, fetch: second });
  assert.equal(name, 'Urla, Türkiye');
  assert.equal(second.calls.length, 0);
});

test('a cache entry past its TTL is refetched', async () => {
  resetGeocodeCache();
  const fetchImpl = stubFetch(URLA);
  const { opts } = harness(fetchImpl, { cacheDays: 1 });
  await reverseGeocode(38.318, 26.695, opts);

  resetGeocodeCache();
  const later = { ...opts, now: () => 3 * 24 * 60 * 60 * 1000 };
  await reverseGeocode(38.318, 26.695, later);
  assert.equal(fetchImpl.calls.length, 2);
});

test('distinct places are spaced by the throttle interval', async () => {
  resetGeocodeCache();
  const fetchImpl = stubFetch(URLA);
  const { opts, waits } = harness(fetchImpl);
  await Promise.all([
    reverseGeocode(38.318, 26.695, opts),
    reverseGeocode(40.100, 26.400, opts),
    reverseGeocode(37.000, 27.000, opts),
  ]);
  assert.equal(fetchImpl.calls.length, 3);
  // First goes straight out; the next two each wait a full interval.
  assert.deepEqual(waits, [1000, 1000]);
});

test('the request carries the coordinates, the configured zoom and the language', async () => {
  resetGeocodeCache();
  const fetchImpl = stubFetch(URLA);
  const { opts } = harness(fetchImpl, { endpoint: 'https://example.test/reverse', zoom: 14 });
  await reverseGeocode(38.318, 26.695, opts);
  const url = new URL(fetchImpl.calls[0]);
  assert.equal(url.origin + url.pathname, 'https://example.test/reverse');
  assert.equal(url.searchParams.get('lat'), '38.318');
  assert.equal(url.searchParams.get('lon'), '26.695');
  assert.equal(url.searchParams.get('zoom'), '14');
  assert.equal(url.searchParams.get('format'), 'jsonv2');
  // Without this Nominatim answers in the local language, which is not the
  // language the rest of the page is in.
  assert.equal(url.searchParams.get('accept-language'), 'en');
});

test('the language is configurable', async () => {
  resetGeocodeCache();
  const fetchImpl = stubFetch(URLA);
  const { opts } = harness(fetchImpl, { language: 'fr' });
  await reverseGeocode(38.318, 26.695, opts);
  assert.equal(new URL(fetchImpl.calls[0]).searchParams.get('accept-language'), 'fr');
});

test('a network failure resolves to null instead of throwing', async () => {
  resetGeocodeCache();
  const failing = async () => { throw new Error('offline'); };
  const { opts } = harness(failing);
  assert.equal(await reverseGeocode(38.318, 26.695, opts), null);
});

test('an HTTP error resolves to null', async () => {
  resetGeocodeCache();
  const fetchImpl = stubFetch({}, { ok: false });
  const { opts } = harness(fetchImpl);
  assert.equal(await reverseGeocode(38.318, 26.695, opts), null);
});

test('open water is remembered as a miss, not re-asked', async () => {
  resetGeocodeCache();
  const fetchImpl = stubFetch({ error: 'Unable to geocode' });
  const { opts } = harness(fetchImpl);
  assert.equal(await reverseGeocode(35.0, 20.0, opts), null);
  assert.equal(await reverseGeocode(35.0, 20.0, opts), null);
  assert.equal(fetchImpl.calls.length, 1);
});

test('a failed lookup does not stall the queue behind it', async () => {
  resetGeocodeCache();
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) throw new Error('offline');
    return { ok: true, json: async () => URLA };
  };
  const { opts } = harness(fetchImpl);
  const [first, second] = await Promise.all([
    reverseGeocode(35.0, 20.0, opts),
    reverseGeocode(38.318, 26.695, opts),
  ]);
  assert.equal(first, null);
  assert.equal(second, 'Urla, Türkiye');
});

test('a storage that throws still returns a name', async () => {
  resetGeocodeCache();
  const fetchImpl = stubFetch(URLA);
  const { opts } = harness(fetchImpl, { storage: memoryStorage({ throws: true }) });
  assert.equal(await reverseGeocode(38.318, 26.695, opts), 'Urla, Türkiye');
});

test('a missing fix never reaches the network', async () => {
  resetGeocodeCache();
  const fetchImpl = stubFetch(URLA);
  const { opts } = harness(fetchImpl);
  assert.equal(await reverseGeocode(null, 26.695, opts), null);
  assert.equal(await reverseGeocode(NaN, NaN, opts), null);
  assert.equal(fetchImpl.calls.length, 0);
});
