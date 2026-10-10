// Google Drive v3 client, browser-side, public folder + API key.
//
// Must use www.googleapis.com — it sends CORS headers.
// drive.google.com/uc?export=download does NOT, and fails silently from a page.

const BASE = 'https://www.googleapis.com/drive/v3/files';

// Drive reports throttling as 403 as often as 429, told apart from a refused
// key only by the reason code in the body.
const THROTTLE_REASONS = new Set([
  'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded',
  'downloadQuotaExceeded', 'sharingRateLimitExceeded',
]);

class DriveError extends Error {
  constructor(message, status, options) {
    super(message, options);
    this.name = 'DriveError';
    this.status = status;
    this.reason = options?.reason ?? '';
  }

  get throttled() {
    return this.status === 429 || THROTTLE_REASONS.has(this.reason);
  }
}

async function request(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (cause) {
    throw new DriveError('network unreachable', 0, { cause });
  }
  if (!res.ok) {
    let detail = '';
    let reason = '';
    try {
      const body = await res.json();
      detail = body?.error?.message ?? '';
      reason = body?.error?.errors?.[0]?.reason ?? '';
    } catch { /* non-JSON error body */ }
    throw new DriveError(detail || `HTTP ${res.status}`, res.status, { reason });
  }
  return res;
}

/**
 * List files in the folder, newest first by modifiedTime.
 * Sorting by modifiedTime (not filename) survives midnight rollover,
 * re-uploads and backfilled days.
 */
export async function listFiles(folderId, apiKey, pageSize = 1) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    orderBy: 'modifiedTime desc',
    pageSize: String(pageSize),
    fields: 'files(id,name,modifiedTime,size)',
    key: apiKey,
  });
  const res = await request(`${BASE}?${params}`);
  const body = await res.json();
  return body.files ?? [];
}

const mediaUrl = (fileId, apiKey) =>
  `${BASE}/${encodeURIComponent(fileId)}?${new URLSearchParams({ alt: 'media', key: apiKey })}`;

/** Download file contents as raw bytes (decoding is the parser's job). */
export async function fetchFileBytes(fileId, apiKey) {
  const res = await request(mediaUrl(fileId, apiKey));
  return res.arrayBuffer();
}

/**
 * First `bytes` of a file. Enough to read the opening GPS fix without paying
 * for a whole day's log — a full folder can be labelled for the price of one
 * download. Drive answers 206, which `res.ok` accepts; a server that ignores
 * the header just sends more than we asked for, which is harmless.
 */
export async function fetchFileHead(fileId, apiKey, bytes = 2048) {
  const url = mediaUrl(fileId, apiKey);
  try {
    const res = await request(url, { headers: { Range: `bytes=0-${bytes - 1}` } });
    return res.arrayBuffer();
  } catch (err) {
    // 416 means the file is shorter than the range. It is small, so just take it.
    if (err instanceof DriveError && err.status === 416) {
      return (await request(url)).arrayBuffer();
    }
    throw err;
  }
}

/**
 * Everything from byte `start` to the end of the file — what a growing log has
 * gained since the last fetch. Drive answers 206; `partial` is false if a
 * server sent the whole file instead, so the caller replaces rather than
 * appends. null on 416: the file is now shorter than `start`.
 */
export async function fetchFileFrom(fileId, apiKey, start) {
  try {
    const res = await request(mediaUrl(fileId, apiKey), {
      headers: { Range: `bytes=${start}-` },
      // The same URL and range repeat until the file grows; never answer from cache.
      cache: 'no-store',
    });
    return { bytes: await res.arrayBuffer(), partial: res.status === 206 };
  } catch (err) {
    if (err instanceof DriveError && err.status === 416) return null;
    throw err;
  }
}

/** Human-readable reason for a failed call, for the status pill. */
export function describeError(err) {
  if (!(err instanceof DriveError)) return 'unexpected error';
  if (err.status === 0) return 'no network';
  if (err.throttled) return 'rate limited by Drive';
  if (err.status === 403) return 'access denied — check the API key restrictions';
  if (err.status === 404) return 'folder not found — check the folder ID and sharing';
  if (err.status >= 500) return 'Drive is unavailable';
  return err.message;
}

export { DriveError };
