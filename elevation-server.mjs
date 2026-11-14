const UPSTREAM = 'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php';

function coordinate(params, name, limit) {
  const values = params.getAll(name);
  if (values.length !== 1 || !values[0].trim()) return null;
  const value = Number(values[0]);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

/** Same-origin proxy for the single fixed public GSI elevation endpoint. */
export function createElevationHandler({ fetchImpl = globalThis.fetch, timeoutMs = 12_000, maxCacheEntries = 256 } = {}) {
  const cache = new Map();
  return async function elevationHandler(req, res, requestURL) {
    if (req.method !== 'GET') { send(res, 405, { error: 'GET method required' }, { Allow: 'GET' }); return; }
    let url;
    try { url = requestURL || new URL(req.url, 'http://localhost'); }
    catch { send(res, 400, { error: 'Invalid coordinates' }); return; }
    const lat = coordinate(url.searchParams, 'lat', 85), lon = coordinate(url.searchParams, 'lon', 180);
    if (lat === null || lon === null) { send(res, 400, { error: 'Invalid coordinates' }); return; }
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (cache.has(key)) { send(res, 200, cache.get(key)); return; }
    const upstream = new URL(UPSTREAM);
    upstream.searchParams.set('lat', lat.toFixed(6)); upstream.searchParams.set('lon', lon.toFixed(6)); upstream.searchParams.set('outtype', 'JSON');
    const controller = new AbortController(); let timer;
    try {
      const data = await Promise.race([
        (async () => {
          const response = await fetchImpl(upstream.href, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
          if (!response.ok) throw new Error('Upstream HTTP error');
          return response.json();
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error('Elevation lookup timed out'); error.name = 'TimeoutError';
            reject(error); controller.abort();
          }, timeoutMs);
        }),
      ]);
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(data, 'elevation')) throw new Error('Malformed elevation response');
      const height = data.elevation;
      if (height === '-----' || height === null || height === '') { send(res, 200, { elevation: '-----', hsrc: '-----' }); return; }
      if (!['string', 'number'].includes(typeof height) || !String(height).trim() || !Number.isFinite(Number(height))) throw new Error('Malformed elevation response');
      const result = { elevation: Number(height), hsrc: typeof data.hsrc === 'string' && data.hsrc ? data.hsrc.slice(0, 256) : '国土地理院' };
      cache.set(key, result);
      if (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
      send(res, 200, result);
    } catch (error) {
      const timeout = error.name === 'TimeoutError';
      send(res, timeout ? 504 : 502, { error: timeout ? 'Elevation lookup timed out' : 'Elevation service unavailable' });
    } finally { clearTimeout(timer); }
  };
}
