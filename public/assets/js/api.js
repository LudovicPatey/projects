// Thin JSON API client (relative URLs so the app also works in a sub-directory).
let csrf = '';
export function setCsrf(t) { csrf = t; }

async function request(method, url, body) {
  const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') opts.headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) {
    if (body instanceof FormData) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Multipart upload with progress callback (0..1). */
function upload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* empty */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || (xhr.status === 413 ? 'File too large for the server.' : `Upload failed (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(formData);
  });
}

/**
 * A GET that sends back the ETag of the previous answer. Returns {changed: false} when the server answers 304,
 * so that a poll costs neither the server's work nor the transfer when nothing changed.
 */
export async function getIfChanged(url, etag) {
  const headers = { Accept: 'application/json' };
  if (etag) headers['If-None-Match'] = etag;
  const res = await fetch(url, { headers, credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 304) return { changed: false, etag };
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const err = new Error(data?.error || `Request failed (${res.status})`); err.status = res.status; throw err; }
  return { changed: true, etag: res.headers.get('ETag'), data };
}

/** The compact facts list arrives as columns: one object per fact again. */
export function expandFacts(data) {
  if (!data?.columns) return data?.facts || [];
  return data.rows.map((row) => Object.fromEntries(data.columns.map((c, i) => [c, row[i]])));
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b ?? {}),
  patch: (u, b) => request('PATCH', u, b ?? {}),
  del: (u) => request('DELETE', u),
  upload,
};
