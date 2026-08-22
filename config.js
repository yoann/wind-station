// Edit this file, then deploy. Nothing else needs changing to go live.

export const CONFIG = {
  // Google Drive folder holding one CSV per day, shared "anyone with the link".
  folderId: '12Sn5_2YPEmH2ZzxTXy9Fcy8M6MZGi8Qr',

  // Browser API key. Restrict it in Google Cloud Console to:
  //   - the Drive API only
  //   - an HTTP referrer matching your domain
  // Leaving this empty runs the site in demo mode against sample/.
  // apiKey: 'AIzaSyAAdtZRjeeHO73HJw_lcJvnTWsDzx13BIo',

  stationName: 'Race Committee Vessel',
  // The place shown under the title is derived from each log's own GPS fix, so
  // a boat that moves between regattas labels itself correctly. Until the
  // lookup answers, nothing is shown rather than a guess.
  timeZone: 'Europe/Istanbul',   // display zone; the log itself is UTC
  defaultUnit: 'kn',             // 'kn' | 'ms' | 'kmh'
  pollSeconds: 30,

  // Directions in the log are magnetic. Leave true unless the device is
  // reconfigured to output true bearings.
  directionsAreMagnetic: true,

  // Turning each log's GPS fix into a place name. The coordinates are sent to
  // the endpoint below; set enabled: false to keep them entirely on the device,
  // leaving the place blank. Answers are cached in the browser, rounded to
  // ~100 m, so a season moored in one bay costs a single request.
  geocode: {
    enabled: true,
    endpoint: 'https://nominatim.openstreetmap.org/reverse',
    zoom: 14,              // 14 names the town; 12 and below only reach the province
    language: 'en',        // place names in English, whatever the local script
    minIntervalMs: 1100,   // Nominatim's usage policy is one request per second
    cacheDays: 90,
  },

  // The vessel is a race committee boat, not a fixed mast. Readings logged while
  // it is moving are boat-motion artefacts from a different place, so rows above
  // this speed over ground (knots) are excluded from every display. Rows with no
  // SOG in the log are kept — that sentinel means a GPS dropout, not motion.
  maxSogKnots: 2,
};
