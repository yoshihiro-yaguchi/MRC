import { distance } from './engine.js';

export function calculateGrade(a, b) {
  const horizontalDistance = distance(a, b), elevationA = Number(a.elevation), elevationB = Number(b.elevation);
  if (!Number.isFinite(horizontalDistance) || horizontalDistance < 1) throw new Error('始点と終点を1m以上離して選択してください。');
  if (![a.elevation,b.elevation].every(value => value !== null && value !== '' && Number.isFinite(Number(value)))) throw new Error('2点の標高を取得できませんでした。');
  const elevationDifference = elevationB - elevationA;
  return { horizontalDistance, elevationA, elevationB, elevationDifference, permille: elevationDifference / horizontalDistance * 1000 };
}

/** Fetch only the two selected points, with a small successful-result cache. */
export class ElevationLookup {
  constructor(fetchImpl = globalThis.fetch) { this.fetch = fetchImpl.bind(globalThis); this.cache = new Map(); }
  async get(point, signal) {
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 85 || Math.abs(point.lng) > 180) throw new Error('地図上の地点を選択してください。');
    const key = `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
    if (this.cache.has(key)) return { ...point, ...this.cache.get(key) };
    const url = new URL('http://localhost/api/elevation');
    url.searchParams.set('lat',point.lat.toFixed(6)); url.searchParams.set('lon',point.lng.toFixed(6)); url.searchParams.set('outtype','JSON');
    let data;
    try {
      const response = await this.fetch(url.pathname + url.search, { signal, credentials: 'omit' });
      if (!response.ok) throw new Error('HTTP error');
      data = await response.json();
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      throw new Error('標高データを取得できませんでした。通信状況を確認して測り直してください。');
    }
    if (data.elevation === null || data.elevation === '' || !Number.isFinite(Number(data.elevation))) throw new Error('この地点の標高データがありません。陸上の別の地点を選択してください。');
    const result = { elevation: Number(data.elevation), source: String(data.hsrc || '国土地理院') };
    this.cache.set(key,result); if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
    return { ...point, ...result };
  }
}
