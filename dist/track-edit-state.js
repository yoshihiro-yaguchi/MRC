const ROUTE_LIVE_FIELDS = ['revenue', 'cost', 'passengers', 'trips'];
const STATION_LIVE_FIELDS = ['population', 'passengers'];

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function networkShape(value) {
  return value && ['tracks', 'stations', 'routes'].every(kind => {
    if (!Array.isArray(value[kind])) return false;
    const ids = new Set();
    return value[kind].every(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) return false;
      ids.add(item.id); return true;
    });
  });
}
function stableJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
}
function staticEntityKey(value, liveFields) {
  const normalized = clone(value);
  for (const field of liveFields) delete normalized[field];
  return stableJSON(normalized);
}

/** Keep history independent of the game clock, finances and map/editor state. */
export function captureTrackNetwork(game) {
  const snapshot = clone({ tracks: game.tracks, stations: game.stations, routes: game.routes });
  if (!networkShape(snapshot)) throw new TypeError('線路の編集状態を取得できませんでした。');
  return snapshot;
}

/** Compare topology/configuration while ignoring counters updated by live play. */
export function trackNetworkKey(game) {
  const snapshot = captureTrackNetwork(game);
  for (const station of snapshot.stations) for (const field of STATION_LIVE_FIELDS) delete station[field];
  for (const route of snapshot.routes) for (const field of ROUTE_LIVE_FIELDS) delete route[field];
  return stableJSON(snapshot);
}

/**
 * Restore infrastructure without rewinding simulation. A positive paidDelta
 * charges money; a negative value refunds it. Unlimited games move neither.
 * Existing IDs retain their current live counters; restored IDs use history.
 */
export function applyTrackNetwork(game, snapshot, { paidDelta = 0, constructionDelta = 0 } = {}) {
  if (!Number.isFinite(paidDelta) || !Number.isFinite(constructionDelta)) return { ok: false, error: '編集履歴の費用が正しくありません。' };
  let next;
  try { next = clone(snapshot); }
  catch { return { ok: false, error: '線路の編集状態を復元できませんでした。' }; }
  if (!networkShape(next) || !networkShape(game)) return { ok: false, error: '線路の編集状態が正しくありません。' };
  if (!game.unlimited && !Number.isFinite(game.money)) return { ok: false, error: '所持金の状態を確認してください。' };
  if (!game.unlimited && paidDelta > 0 && game.money < paidDelta) return { ok: false, error: '所持金が不足しているため、この編集をやり直せません。' };
  if (paidDelta === 0 && constructionDelta === 0) {
    try {
      // Draft-only undo must leave existing station/route objects in place:
      // pending asynchronous work can still hold those exact references.
      if (trackNetworkKey(game) === trackNetworkKey(next)) return { ok: true };
    } catch { return { ok: false, error: '線路の編集状態を比較できませんでした。' }; }
  }
  const routes = new Map(game.routes.map(route => [route.id, route])), stations = new Map(game.stations.map(station => [station.id, station]));
  // Prepare every copied value before touching the world, including the live
  // fields, so even a malformed external snapshot fails without a partial edit.
  try {
    for (const [index, route] of next.routes.entries()) {
      const current = routes.get(route.id);
      if (current) {
        for (const field of ROUTE_LIVE_FIELDS) if (Object.hasOwn(current, field)) route[field] = clone(current[field]);
        if (staticEntityKey(current, ROUTE_LIVE_FIELDS) === staticEntityKey(route, ROUTE_LIVE_FIELDS)) next.routes[index] = current;
      }
    }
    for (const [index, station] of next.stations.entries()) {
      const current = stations.get(station.id);
      if (current) {
        for (const field of STATION_LIVE_FIELDS) if (Object.hasOwn(current, field)) station[field] = clone(current[field]);
        // A track-only undo must not cancel unrelated asynchronous station
        // naming or consumers holding an unchanged route object.
        if (staticEntityKey(current, STATION_LIVE_FIELDS) === staticEntityKey(station, STATION_LIVE_FIELDS)) next.stations[index] = current;
      }
    }
  } catch { return { ok: false, error: '現在の運行データを保持できないため、編集を復元できませんでした。' }; }
  const oldConstruction = Number.isFinite(game.stats?.construction) ? game.stats.construction : 0;
  const construction = Math.max(0, oldConstruction + constructionDelta);
  const money = game.unlimited ? game.money : game.money - paidDelta;
  if (!Number.isFinite(construction) || (!game.unlimited && !Number.isFinite(money))) return { ok: false, error: '編集履歴の費用が大きすぎます。' };
  game.tracks = next.tracks; game.stations = next.stations; game.routes = next.routes;
  if (!game.unlimited) game.money = money;
  if (!game.stats || typeof game.stats !== 'object') game.stats = {};
  game.stats.construction = construction;
  return { ok: true };
}
