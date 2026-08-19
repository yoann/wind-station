// Google Drive v3 client, browser-side, public folder + API key.
//
// Must use www.googleapis.com — it sends CORS headers.
// drive.google.com/uc?export=download does NOT, and fails silently from a page.

const BASE = 'https://www.googleapis.com/drive/v3/files';

class DriveError extends Error {
  constructor(message, status, options) {
    super(message, options);
    this.name = 'DriveError';
    this.status = status;
  }
}

async function request(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new DriveError('network unreachable', 0, { cause });
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message ?? '';
    } catch { /* non-JSON error body */ }
    throw new DriveError(detail || `HTTP ${res.status}`, res.status);
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

export async function fetchLatestMeta(folderId, apiKey) {
  const files = await listFiles(folderId, apiKey, 1);
  return files[0] ?? null;
}

/** Download file contents as raw bytes (decoding is the parser's job). */
export async function fetchFileBytes(fileId, apiKey) {
  const params = new URLSearchParams({ alt: 'media', key: apiKey });
  const res = await request(`${BASE}/${encodeURIComponent(fileId)}?${params}`);
  return res.arrayBuffer();
}

/** Human-readable reason for a failed call, for the status pill. */
export function describeError(err) {
  if (!(err instanceof DriveError)) return 'unexpected error';
  if (err.status === 0) return 'no network';
  if (err.status === 403) return 'access denied — check the API key restrictions';
  if (err.status === 404) return 'folder not found — check the folder ID and sharing';
  if (err.status === 429) return 'rate limited by Drive';
  if (err.status >= 500) return 'Drive is unavailable';
  return err.message;
}

export { DriveError };
