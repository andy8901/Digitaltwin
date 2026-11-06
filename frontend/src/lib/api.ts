export async function api<T = unknown>(path: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const init: RequestInit = { ...opts, credentials: 'same-origin' };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (!init.method) init.method = 'POST';
  }
  const r = await fetch(path, init);
  if (r.status === 401) { location.href = '/login'; throw new Error('login required'); }
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && (body as { detail?: string }).detail) || `${r.status} ${r.statusText}`);
  return body as T;
}
