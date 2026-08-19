// Edit this file, then deploy. Nothing else needs changing to go live.

export const CONFIG = {
  // Google Drive folder holding one CSV per day, shared "anyone with the link".
  folderId: '12Sn5_2YPEmH2ZzxTXy9Fcy8M6MZGi8Qr',

  // Browser API key. Restrict it in Google Cloud Console to:
  //   - the Drive API only
  //   - an HTTP referrer matching your domain
  // Leaving this empty runs the site in demo mode against sample/.
  apiKey: 'AIzaSyAAdtZRjeeHO73HJw_lcJvnTWsDzx13BIo',

  stationName: 'Wind station',
  placeName: 'Urla, Turkiye',                 // e.g. 'Cesme, Turkiye' — shown under the title
  timeZone: 'Europe/Istanbul',   // display zone; the log itself is UTC
  defaultUnit: 'kn',             // 'kn' | 'ms' | 'kmh'
  pollSeconds: 30,

  // Directions in the log are magnetic. Leave true unless the device is
  // reconfigured to output true bearings.
  directionsAreMagnetic: true,
};
