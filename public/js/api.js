export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

export async function api(method, url, body, { signal } = {}) {
  const headers = { 'X-VERTO': '1' };
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal, credentials: 'same-origin' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Немає зв’язку із сервером.', 0, null);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('verto-unauthorized'));
    throw new ApiError(data?.error || `Помилка ${res.status}`, res.status, data);
  }
  return data;
}

export const get = (u, o) => api('GET', u, undefined, o);
export const post = (u, b) => api('POST', u, b);
export const patch = (u, b) => api('PATCH', u, b);
export const put = (u, b) => api('PUT', u, b);
export const del = (u) => api('DELETE', u);
