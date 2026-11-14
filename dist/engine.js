// Independent implementation of Railway Canvas's construction and timetable model.
// Coordinates use WGS84; distances are in metres and the game calendar uses UTC.
export const INITIAL_MONEY = 100_000_000_000;
export const INITIAL_TIME = Date.UTC(2026, 0, 1, 6);
const EARTH = 6_371_008.8;
const RAD = Math.PI / 180;
const DAY = 86_400;
const COLORS = ['#e66b27', '#208ac0', '#3a9b67', '#a451a5', '#d5a326', '#d34f68', '#596bcc', '#309d9a'];
const landBuckets = new Map(), populationBuckets = new Map(), landCache = new Map();
const populationCells = [];
let loadedDataPromise = null;
let existingNetwork = null;
let nextId = 1;
const uid = prefix => `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
const fail = error => ({ ok: false, error });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
const validPoint = p => p && finite(p.lat) && finite(p.lng) && Number(p.lat) >= -85 && Number(p.lat) <= 85 && Number(p.lng) >= -180 && Number(p.lng) <= 180;
const copyPoint = p => ({ lat: Number(p.lat), lng: Number(p.lng) });

export const STATION_LAYOUTS = [
  { id: 'side-1', name: '1面1線・片側ホーム', platforms: 1, tracks: 1, platformPattern: ['P', 'T'] },
  { id: 'island-2', name: '1面2線・島式ホーム', platforms: 1, tracks: 2, platformPattern: ['T', 'P', 'T'] },
  { id: 'side-2', name: '2面2線・相対式ホーム', platforms: 2, tracks: 2, platformPattern: ['P', 'T', 'T', 'P'] },
  { id: 'mixed-3', name: '2面3線・片側＋島式', platforms: 2, tracks: 3, platformPattern: ['P', 'T', 'T', 'P', 'T'] },
  { id: 'island-4', name: '2面4線・島式ホーム', platforms: 2, tracks: 4, platformPattern: ['T', 'P', 'T', 'T', 'P', 'T'] },
  { id: 'mixed-4', name: '3面4線・相対式＋島式', platforms: 3, tracks: 4, platformPattern: ['P', 'T', 'T', 'P', 'T', 'T', 'P'] },
  { id: 'island-6', name: '3面6線・島式ホーム', platforms: 3, tracks: 6, platformPattern: ['T', 'P', 'T', 'T', 'P', 'T', 'T', 'P', 'T'] },
  { id: 'island-8', name: '4面8線・島式ホーム', platforms: 4, tracks: 8, platformPattern: ['T', 'P', 'T', 'T', 'P', 'T', 'T', 'P', 'T', 'T', 'P', 'T'] },
];

export function getStationLayout(id = 'side-1') {
  return STATION_LAYOUTS.find(layout => layout.id === id) || STATION_LAYOUTS[0];
}

const STATION_ENDS = ['independent', 'group1', 'group2', 'group3', 'group4', 'buffer'];
const STATION_DIRECTIONS = ['both', 'forward', 'reverse'];
export function getStationTrackConfigs(station = {}) {
  const count = getStationLayout(station.layoutId).tracks, split = station.wiringMode === 'platforms';
  return Array.from({ length: count }, (_, index) => {
    if (!split) return { a: 'group1', b: 'group1', direction: 'both' };
    const config = station.trackConfigs?.[index] || {};
    return { a: STATION_ENDS.includes(config.a) ? config.a : split ? 'independent' : 'group1', b: STATION_ENDS.includes(config.b) ? config.b : split ? 'independent' : 'group1', direction: STATION_DIRECTIONS.includes(config.direction) ? config.direction : 'both' };
  });
}

export function stationEndLabels() { return { a: 'A側', b: 'B側' }; }

function stationWiringError(options, standalone = true) {
  if (options.wiringMode != null && !['merged', 'platforms'].includes(options.wiringMode)) return '駅の配線方式を選択してください。';
  if (options.portGeometry != null && !['straight', 'spread'].includes(options.portGeometry)) return '駅の接続口の配線が正しくありません。';
  if (options.wiringMode !== 'platforms') return null;
  const count = getStationLayout(options.layoutId).tracks;
  if (options.trackConfigs != null && (!Array.isArray(options.trackConfigs) || options.trackConfigs.length !== count)) return '全番線の配線設定を指定してください。';
  for (const [index, config] of getStationTrackConfigs(options).entries()) {
    const input = options.trackConfigs?.[index];
    if (input && (!STATION_ENDS.includes(input.a) || !STATION_ENDS.includes(input.b) || !STATION_DIRECTIONS.includes(input.direction))) return `${index + 1}番線の配線設定が正しくありません。`;
    if (config.a === 'buffer' && config.b === 'buffer') return `${index + 1}番線は少なくとも片側を接続口にしてください。`;
    if ((config.a === 'buffer' || config.b === 'buffer') && config.direction !== 'both') return `${index + 1}番線の終着線は折り返しのため双方向にしてください。`;
  }
  return null;
}

function stationPoint(center, x, y, bearing = 0) {
  const angle = bearing * RAD, east = x * Math.cos(angle) - y * Math.sin(angle), north = x * Math.sin(angle) + y * Math.cos(angle);
  return { lat: center.lat + north / EARTH / RAD, lng: center.lng + east / (EARTH * Math.cos(center.lat * RAD)) / RAD };
}

function stationHostSelectionError(station) {
  if (station.hostPlatformSelection === 'auto' || (station.hostPlatformNumber === undefined && station.hostPlatformSelection !== 'explicit')) return null;
  const count = getStationLayout(station.layoutId).tracks, hostCount = station.standalone ? 0 : Math.min(Number(station.hostTrackCount) || 0, count), number = Number(station.hostPlatformNumber);
  if (!hostCount) return '元の線路に合わせる番線は、線路上に設置する駅で選択してください。';
  if (!finite(station.hostPlatformNumber) || !Number.isInteger(number) || number < 1 || number + hostCount - 1 > count) return hostCount === 2 ? `元の複線に合わせる連続2番線の開始番号を1〜${count - 1}で選択してください。` : `元の線路に合わせる番線を1〜${count}で選択してください。`;
  return null;
}

// Track and platform positions are shared by the map preview and construction.
// bearing uses degrees from east towards north (0=east/west, 90=north/south).
export function stationGeometry(station) {
  const layout = getStationLayout(station.layoutId), cars = clamp(Math.round(Number(station.cars) || 1), 1, 20);
  const bearing = ((Number(station.bearing) || 0) % 360 + 360) % 360;
  const platformLength = cars * 20, tokens = [], trackOffsets = [];
  let across = 0;
  for (const type of layout.platformPattern) {
    const width = type === 'P' ? 6 : 4;
    tokens.push({ type, width, offset: across + width / 2 }); across += width;
  }
  for (const token of tokens) token.offset -= across / 2;
  tokens.filter(token => token.type === 'T').forEach(token => trackOffsets.push(token.offset));
  const hostTrackCount = station.standalone ? 0 : Math.min(Number(station.hostTrackCount) || 0, layout.tracks);
  const hostSelectionError = stationHostSelectionError({ ...station, hostTrackCount });
  const explicitHost = station.hostPlatformSelection !== 'auto' && station.hostPlatformNumber !== undefined && !hostSelectionError;
  const hostSlotIndices = explicitHost ? Array.from({ length: hostTrackCount }, (_, index) => Number(station.hostPlatformNumber) - 1 + index) : trackOffsets.map((offset, index) => ({ index, distance: Math.abs(offset) })).sort((a, b) => a.distance - b.distance).slice(0, hostTrackCount).map(item => item.index);
  const originOffset = hostSlotIndices.length ? hostSlotIndices.reduce((sum, index) => sum + trackOffsets[index], 0) / hostSlotIndices.length : 0;
  for (const token of tokens) token.offset -= originOffset;
  for (let i = 0; i < trackOffsets.length; i++) trackOffsets[i] -= originOffset;
  const wiringMode = station.wiringMode === 'platforms' ? 'platforms' : 'merged', trackConfigs = getStationTrackConfigs(station);
  const portGeometry = station.portGeometry === 'spread' ? 'spread' : 'straight';
  const approachLength = Math.max(35, across * 2), halfLength = platformLength / 2;
  let connections = Array.isArray(station.connectionPoints) && station.connectionPoints.length === 2 ? station.connectionPoints.map(copyPoint)
    : [stationPoint(station, -halfLength - approachLength, 0, bearing), stationPoint(station, halfLength + approachLength, 0, bearing)];
  const connectionPorts = [], bufferStops = [], endPoints = { a: [], b: [] }, portOffsets = [];
  if (wiringMode === 'platforms') {
    for (const end of ['a', 'b']) {
      const groups = new Map();
      trackConfigs.forEach((config, index) => {
        if (config[end] === 'buffer') {
          const p = stationPoint(station, end === 'a' ? -halfLength : halfLength, trackOffsets[index], bearing);
          endPoints[end][index] = p; bufferStops.push({ point: p, platformIndex: index, end }); return;
        }
        const key = config[end] === 'independent' ? `track${index + 1}` : config[end];
        if (!groups.has(key)) groups.set(key, []); groups.get(key).push(index);
      });
      const ordered = [...groups].sort((a, b) => a[1].reduce((s, i) => s + i, 0) / a[1].length - b[1].reduce((s, i) => s + i, 0) / b[1].length || a[0].localeCompare(b[0]));
      // Independent ports must remain collinear with their platform rails.
      // Reserve them before placing any shared port, even if that shared port
      // sorts earlier, so a group can never accidentally merge into one.
      const occupiedOffsets = portGeometry === 'straight' ? ordered.filter(([key]) => key.startsWith('track')).map(([, indices]) => trackOffsets[indices[0]]) : [];
      if (hostSlotIndices.length && Array.isArray(station.hostTrackPoints)) occupiedOffsets.push(0);
      ordered.forEach(([key, indices], slot) => {
        let offset = portGeometry === 'straight' && key.startsWith('track') ? trackOffsets[indices[0]] : (slot - (ordered.length - 1) / 2) * 18;
        if (portGeometry === 'straight' && key.startsWith('group')) {
          const preferred = offset; let step = 0;
          while (occupiedOffsets.some(other => Math.abs(offset - other) < 1)) {
            step++; offset = preferred + Math.ceil(step / 2) * (step % 2 ? 2 : -2);
          }
          occupiedOffsets.push(offset);
        }
        const p = stationPoint(station, (end === 'a' ? -1 : 1) * (halfLength + approachLength), offset, bearing);
        const label = key.startsWith('group') ? `${end.toUpperCase()}接続口${key.slice(5)}` : `${indices[0] + 1}${end.toUpperCase()}`;
        connectionPorts.push({ point: p, label, platformNumbers: indices.map(index => index + 1), end, key: `${end}:${key}` });
        portOffsets.push(offset); indices.forEach(index => { endPoints[end][index] = p; });
      });
    }
    connections = connectionPorts.map(port => copyPoint(port.point));
  } else {
    for (const [index, end] of ['a', 'b'].entries()) {
      connectionPorts.push({ point: connections[index], label: end.toUpperCase(), platformNumbers: trackOffsets.map((_, i) => i + 1), end, key: `${end}:merged` });
      endPoints[end] = trackOffsets.map(() => connections[index]);
    }
  }
  const platformTrackBodies = trackOffsets.map(offset => [stationPoint(station, -halfLength, offset, bearing), stationPoint(station, halfLength, offset, bearing)]);
  const trackPaths = trackOffsets.map((offset, index) => [endPoints.a[index], ...platformTrackBodies[index], endPoints.b[index]].map(copyPoint));
  const hostPaths = [];
  if (!station.standalone && Array.isArray(station.hostTrackPoints) && station.hostTrackPoints.length >= 2) for (const index of hostSlotIndices) {
    trackPaths[index] = station.hostTrackPoints.map(copyPoint);
    if (Array.isArray(station.hostPlatformPoints) && station.hostPlatformPoints.length === 2) platformTrackBodies[index] = station.hostPlatformPoints.map(copyPoint);
    hostPaths.push({ platformIndex: index, points: trackPaths[index] });
    if (wiringMode === 'platforms') for (const port of connectionPorts) if (port.platformNumbers.includes(index + 1)) port.point = copyPoint(port.end === 'a' ? trackPaths[index][0] : trackPaths[index].at(-1));
  }
  if (wiringMode === 'platforms') connections = connectionPorts.map(port => copyPoint(port.point));
  const platforms = tokens.filter(token => token.type === 'P').map((token, index) => ({
    index, offset: token.offset, width: token.width,
    points: [stationPoint(station, -halfLength, token.offset - token.width / 2, bearing), stationPoint(station, halfLength, token.offset - token.width / 2, bearing), stationPoint(station, halfLength, token.offset + token.width / 2, bearing), stationPoint(station, -halfLength, token.offset + token.width / 2, bearing)],
  }));
  const low = Math.min(-across / 2 - originOffset, ...portOffsets) - 2, high = Math.max(across / 2 - originOffset, ...portOffsets) + 2;
  const width = high - low;
  const footprint = [stationPoint(station, -halfLength - approachLength, low, bearing), stationPoint(station, halfLength + approachLength, low, bearing), stationPoint(station, halfLength + approachLength, high, bearing), stationPoint(station, -halfLength - approachLength, high, bearing)];
  return { layoutId: layout.id, layout, bearing, wiringMode, portGeometry, trackConfigs, connectionPorts, bufferStops, platformLength, approachLength, totalLength: platformLength + 2 * approachLength, width, platforms, trackOffsets, trackPaths, platformTrackBodies, hostPaths, connections, hostSlotIndices, hostPlatformSelection: explicitHost ? 'explicit' : 'auto', hostPlatformNumber: hostSlotIndices.length ? hostSlotIndices[0] + 1 : undefined, ...(hostSelectionError ? { hostSelectionError } : {}), footprint };
}

export function getStationPlatforms(state, station) {
  if (typeof station === 'string') station = state.stations.find(s => s.id === station);
  if (!station) return [];
  if (station.existing) return [{ number: 1, label: '共有ホーム', trackId: station.trackId }];
  const geometry = stationGeometry(station), configs = getStationTrackConfigs(station);
  return configs.map((config, index) => {
    const internal = state.tracks.find(track => track.stationId === station.id && track.platformIndex === index);
    const hostIndex = geometry.hostSlotIndices.slice().sort((a,b)=>a-b).indexOf(index), host = state.tracks.find(track => track.id === station.trackId);
    return { number: index + 1, label: `${index + 1}番線`, ...config, trackId: internal?.id || station.trackId, ...(host?.type === 'double' && hostIndex >= 0 && geometry.hostSlotIndices.length > 1 ? { lane: hostIndex === 0 ? -1 : 1 } : {}) };
  });
}

export function getStationHostPlatformNumbers(station) { return stationGeometry(station).hostSlotIndices.map(index => index + 1); }

function stationHostWiringError(station) {
  if (station.standalone || station.wiringMode !== 'platforms') return null;
  const geometry = stationGeometry(station);
  for (const index of geometry.hostSlotIndices) {
    const config = geometry.trackConfigs[index];
    if (config.a !== 'independent' || config.b !== 'independent' || config.direction !== 'both') return `${index + 1}番線は元の線路を使用します。接続口・進行方向・終端は元の線路のままにしてください。`;
  }
  return null;
}

export function getPopulationCells() { return populationCells; }

// The national graph stays outside saved player-owned infrastructure. Its
// provider adds shared track edges only when a route is being calculated.
export function setExistingNetwork(network) {
  if (network != null && typeof network.augmentGraph !== 'function') throw new TypeError('既設路線の経路データが正しくありません。');
  existingNetwork = network || null;
}

export function createGame() {
  return {
    version: 1, money: INITIAL_MONEY, unlimited: false, time: INITIAL_TIME, speed: 0,
    tracks: [], stations: [], routes: [], view: { lat: 35.6812, lng: 139.7671, zoom: 10.6 },
    layer: 'standard', populationVisible: false, trackDraft: null, trackDrafts: [], stationDraft: null, stationDrafts: [], stats: { revenue: 0, cost: 0, passengers: 0, construction: 0 },
  };
}

export function distance(a, b) {
  const p = (b.lat - a.lat) * RAD;
  const q = (b.lng - a.lng) * RAD;
  const h = Math.sin(p / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(q / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLength(points = []) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
  return length;
}

function project(point, a, b) {
  const cos = Math.cos((a.lat + b.lat) * RAD / 2);
  const x = (point.lng - a.lng) * cos;
  const y = point.lat - a.lat;
  const dx = (b.lng - a.lng) * cos;
  const dy = b.lat - a.lat;
  const t = clamp((x * dx + y * dy) / (dx * dx + dy * dy || 1), 0, 1);
  const snapped = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  return { point: snapped, t, distance: distance(point, snapped), side: Math.sign(dx * y - dy * x) || 1 };
}

export function nearestTrack(state, point, options = {}) {
  if (!validPoint(point)) return null;
  let nearest = null;
  for (const track of state.tracks) {
    if (options.doubleOnly && track.type !== 'double') continue;
    if (options.mainOnly && !['single', 'double'].includes(track.type)) continue;
    let offset = 0;
    for (let i = 0; i < track.points.length - 1; i++) {
      const hit = project(point, track.points[i], track.points[i + 1]);
      if (!nearest || hit.distance < nearest.distance) nearest = { ...hit, track, segmentIndex: i, offset: offset + distance(track.points[i], hit.point) };
      offset += distance(track.points[i], track.points[i + 1]);
    }
  }
  return nearest;
}

function nearbyRecords(buckets, point, grid, radius = 2) {
  const lat = Math.floor(point.lat / grid), lng = Math.floor(point.lng / grid);
  const records = [];
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) records.push(...(buckets.get(`${lat + y}:${lng + x}`) || []));
  return records;
}

function landPrice(point) {
  const key = `${Math.round(point.lat * 1000)}:${Math.round(point.lng * 1000)}`;
  if (landCache.has(key)) return landCache.get(key);
  const records = nearbyRecords(landBuckets, point, .1, 2);
  let price = 50_000;
  if (records.length) {
    const closest = records.map(record => ({ distance: distance(point, record), price: record.price })).sort((a, b) => a.distance - b.distance).slice(0, 8);
    let numerator = 0, denominator = 0;
    for (const item of closest) {
      const weight = 1 / Math.max(50, item.distance) ** 2;
      numerator += item.price * weight; denominator += weight;
    }
    price = numerator / denominator;
  }
  landCache.set(key, price);
  return price;
}

export function stationPopulation(point) {
  const records = nearbyRecords(populationBuckets, point, .02, 2);
  if (!records.length) return 0;
  return Math.round(records.reduce((sum, record) => {
    const metres = distance(point, record);
    return sum + (metres < 2000 ? record.population * (1 - metres / 2000) : 0);
  }, 0));
}

// The source census is factual. Travel mode choice and generated OD demand are
// intentionally a lightweight independent approximation of the original game.
export async function loadEconomicData(state) {
  if (!loadedDataPromise) loadedDataPromise = (async () => {
    const results = { landPrices: false, population: false };
    try {
      const response = await fetch(new URL('./data/land-prices.json', import.meta.url));
      if (!response.ok) throw new Error('land');
      const data = await response.json(), scale = Number(data.coordinateScale) || 100000;
      for (const row of data.points || []) {
        const point = { lat: row[0] / scale, lng: row[1] / scale, price: row[2] };
        const key = `${Math.floor(point.lat / .1)}:${Math.floor(point.lng / .1)}`;
        if (!landBuckets.has(key)) landBuckets.set(key, []);
        landBuckets.get(key).push(point);
      }
      landCache.clear(); results.landPrices = landBuckets.size > 0;
    } catch { /* Construction remains usable while offline. */ }
    try {
      if (typeof DecompressionStream === 'undefined') throw new Error('gzip');
      const response = await fetch(new URL('./data/population.json.gz', import.meta.url));
      if (!response.ok) throw new Error('population');
      const data = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
      const scale = Number(data.coordinateScale) || 10000, popScale = Number(data.populationScale) || 10;
      for (const row of data.cells || []) {
        const point = { lat: row[0] / scale, lng: row[1] / scale, population: row[2] / popScale };
        populationCells.push(point);
        const key = `${Math.floor(point.lat / .02)}:${Math.floor(point.lng / .02)}`;
        if (!populationBuckets.has(key)) populationBuckets.set(key, []);
        populationBuckets.get(key).push(point);
      }
      results.population = populationBuckets.size > 0;
    } catch { /* Population demand uses its documented fallback until loaded. */ }
    return results;
  })();
  const result = await loadedDataPromise;
  if (state) for (const station of state.stations) station.population = stationPopulation(station);
  return result;
}

export function estimateTrackCost(points, type = 'double', state = null) {
  if (!Array.isArray(points) || !points.every(validPoint)) points = [];
  const length = Array.isArray(points) && points.every(validPoint) ? lineLength(points) : 0;
  const rate = { single: 2_500_000, double: 5_000_000, crossover: 2_500_000, scissors: 5_000_000 }[type] || 5_000_000;
  const trackCost = Math.round(length * rate);
  const width = type === 'double' || type === 'scissors' ? 9 : 5;
  let acquisition = 0;
  for (let i = 1; i < (points?.length || 0); i++) {
    const a = points[i - 1], b = points[i], metres = distance(a, b);
    const samples = Math.max(1, Math.ceil(metres / 200));
    for (let sample = 0; sample < samples; sample++) {
      const t = (sample + .5) / samples;
      const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      const hit = state ? nearestTrack(state, point) : null;
      const oldWidth = hit ? (hit.track.type === 'double' ? 9 : 5) : 0;
      const overlap = hit && hit.distance < (width + oldWidth) / 2 ? Math.min(width, Math.max(0, (width + oldWidth) / 2 - hit.distance)) : 0;
      acquisition += metres / samples * (width - overlap) * landPrice(point);
    }
  }
  const landCost = Math.round(acquisition);
  return { length, trackCost, landCost, total: trackCost + landCost, construction: trackCost, land: landCost };
}

const CURVE_MODES = ['legacy', 'tangent', 'point'];

function curveSettings(controls, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return fail('曲線の設定が正しくありません。');
  const curveMode = options.curveMode ?? 'legacy';
  if (!CURVE_MODES.includes(curveMode)) return fail('曲線の作成方式を選択してください。');
  let handles;
  if (options.handles != null) {
    if (!Array.isArray(options.handles) || options.handles.length !== controls.length) return fail('各計画点の曲線ハンドルを指定してください。');
    handles = [];
    for (let index = 0; index < controls.length; index++) {
      const handle = options.handles[index];
      if (handle === null) { handles.push(null); continue; }
      if (!validPoint(handle)) return fail('曲線ハンドルの座標が正しくありません。');
      const span = Math.max(index > 0 ? distance(controls[index], controls[index - 1]) : 0, index + 1 < controls.length ? distance(controls[index], controls[index + 1]) : 0);
      if (distance(controls[index], handle) > Math.min(500_000, Math.max(1000, span * 4))) return fail('曲線ハンドルを計画点から離しすぎています。');
      handles.push(copyPoint(handle));
    }
  }
  return { ok: true, curveMode, ...(handles ? { handles } : {}) };
}

function curveMetadata(controls, options = {}) {
  const settings = curveSettings(controls, options);
  if (!settings.ok) return null;
  if (options.curveMode == null && options.handles == null) return {};
  return { curveMode: settings.curveMode, ...(settings.handles ? { handles: settings.handles } : {}) };
}

function planBezierTrack(controlPoints, type, settings) {
  const origin = copyPoint(controlPoints[0]), cosine = Math.cos(origin.lat * RAD);
  const xy = p => ({ x: (p.lng - origin.lng) * RAD * EARTH * cosine, y: (p.lat - origin.lat) * RAD * EARTH });
  const geo = p => ({ lat: origin.lat + p.y / EARTH / RAD, lng: origin.lng + p.x / EARTH / RAD / cosine });
  const controls = controlPoints.map(xy), sampled = [], curves = [];
  for (let index = 1; index < controls.length; index++) if (Math.hypot(controls[index].x - controls[index - 1].x, controls[index].y - controls[index - 1].y) < 2) return fail('計画点は2m以上離してください。');
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let tangentHandles;
  if (settings.curveMode === 'point') {
    const handles = controls.map((p, index) => {
      if (settings.handles?.[index]) return xy(settings.handles[index]);
      const before = controls[Math.max(0, index - 1)], after = controls[Math.min(controls.length - 1, index + 1)];
      const divisor = index === 0 || index === controls.length - 1 ? 3 : 6;
      return { x: p.x + (after.x - before.x) / divisor, y: p.y + (after.y - before.y) / divisor };
    });
    tangentHandles = handles.map(geo);
    for (let index = 1; index < controls.length; index++) {
      const to = controls[index], outgoing = handles[index - 1], mirrored = { x: 2 * to.x - handles[index].x, y: 2 * to.y - handles[index].y };
      curves.push([controls[index - 1], outgoing, mirrored, to]);
    }
  } else if (controls.length === 2) curves.push([controls[0], midpoint(controls[0], controls[1]), controls[1]]);
  else {
    let start = controls[0];
    for (let index = 1; index < controls.length - 1; index++) {
      const end = index === controls.length - 2 ? controls.at(-1) : midpoint(controls[index], controls[index + 1]);
      curves.push([start, controls[index], end]); start = end;
    }
  }
  const curveFail = error => ({ ...fail(error), ...(tangentHandles ? { tangentHandles } : {}) });
  let minRadius = Infinity;
  const minimumRadius = 15 ** 2 / 11.8 + (type === 'double' ? .75 : 0);
  for (const curve of curves) {
    const polygonLength = curve.slice(1).reduce((sum, p, index) => sum + Math.hypot(p.x - curve[index].x, p.y - curve[index].y), 0);
    const steps = Math.max(24, Math.min(5000, Math.ceil(polygonLength / 20)));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps, u = 1 - t, [a, b, c, d] = curve;
      let point, first, second;
      if (d) {
        point = { x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x, y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y };
        first = { x: 3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (d.x - c.x), y: 3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (d.y - c.y) };
        second = { x: 6 * u * (c.x - 2 * b.x + a.x) + 6 * t * (d.x - 2 * c.x + b.x), y: 6 * u * (c.y - 2 * b.y + a.y) + 6 * t * (d.y - 2 * c.y + b.y) };
      } else {
        point = { x: u * u * a.x + 2 * u * t * b.x + t * t * c.x, y: u * u * a.y + 2 * u * t * b.y + t * t * c.y };
        first = { x: 2 * u * (b.x - a.x) + 2 * t * (c.x - b.x), y: 2 * u * (b.y - a.y) + 2 * t * (c.y - b.y) };
        second = { x: 2 * (c.x - 2 * b.x + a.x), y: 2 * (c.y - 2 * b.y + a.y) };
      }
      const speed = Math.hypot(first.x, first.y), cross = Math.abs(first.x * second.y - first.y * second.x);
      if (speed < 1e-7 && step > 0 && step < steps) return curveFail('曲線がその場で折り返しています。計画点またはハンドルを調整してください。');
      if (cross > 1e-9 && speed > 1e-7) minRadius = Math.min(minRadius, speed ** 3 / cross);
      if (minRadius < minimumRadius) return curveFail('曲線が急すぎます。15km/h以上で走行できる緩やかな曲線にしてください。');
      if (!sampled.length || step > 0) sampled.push(point);
      if (sampled.length > 100_000) return curveFail('曲線の計画点が多すぎます。');
    }
  }
  for (let index = 1; index + 1 < sampled.length; index++) {
    const a = sampled[index - 1], b = sampled[index], c = sampled[index + 1];
    const first = { x: b.x - a.x, y: b.y - a.y }, second = { x: c.x - b.x, y: c.y - b.y };
    const ab = Math.hypot(first.x, first.y), bc = Math.hypot(second.x, second.y), ac = Math.hypot(c.x - a.x, c.y - a.y), cross = Math.abs(first.x * second.y - first.y * second.x);
    if (first.x * second.x + first.y * second.y < 0 && cross < 1e-7 * ab * bc) return curveFail('曲線がその場で折り返しています。計画点またはハンドルを調整してください。');
    if (cross > 1e-9) minRadius = Math.min(minRadius, ab * bc * ac / (2 * cross));
    if (minRadius < minimumRadius) return curveFail('曲線が急すぎます。15km/h以上で走行できる緩やかな曲線にしてください。');
  }
  const points = sampled.map(geo);
  points[0] = copyPoint(controlPoints[0]); points[points.length - 1] = copyPoint(controlPoints.at(-1));
  if (!points.every(validPoint)) return curveFail('曲線の範囲が大きすぎます。計画点とハンドルを近づけてください。');
  Object.defineProperties(points, { _planned: { value: true }, _controls: { value: controlPoints.map(copyPoint) }, _curveOptions: { value: { curveMode: settings.curveMode, ...(settings.handles ? { handles: settings.handles.map(p => p && copyPoint(p)) } : {}) } }, _minRadius: { value: minRadius }, ...(tangentHandles ? { _tangentHandles: { value: tangentHandles } } : {}) });
  return { ok: true, points, minRadius, curveMode: settings.curveMode, ...(tangentHandles ? { tangentHandles } : {}) };
}

export function planTrackPoints(controlPoints, type = 'double', state = null, options = {}) {
  if (!Array.isArray(controlPoints) || !Array.from(controlPoints).every(validPoint)) return fail('計画線の座標が正しくありません。');
  if (controlPoints._planned) return { ok: true, points: controlPoints, minRadius: controlPoints._minRadius ?? Infinity, ...(controlPoints._curveOptions ? { curveMode: controlPoints._curveOptions.curveMode } : {}), ...(controlPoints._tangentHandles ? { tangentHandles: controlPoints._tangentHandles.map(copyPoint) } : {}) };
  const settings = curveSettings(controlPoints, options); if (!settings.ok) return settings;
  if (controlPoints.length < 2) return { ok: true, points: controlPoints.map(copyPoint), minRadius: Infinity, ...(settings.curveMode === 'point' ? { tangentHandles: controlPoints.map(copyPoint) } : {}) };
  if (['crossover', 'scissors'].includes(type)) {
    if (controlPoints.length > 2) return fail('渡線は始点と終点の2か所を選んでください。');
    let points = controlPoints.map(copyPoint);
    if (state && points.length === 2) {
      const options = type === 'scissors' ? { doubleOnly: true } : { mainOnly: true };
      const from = nearestTrack(state, points[0], options), to = nearestTrack(state, points[1], options);
      if (!from || !to || from.distance > 80 || to.distance > 80) return fail('既設の線路上で渡線の始点と終点を選んでください。');
      if (type === 'scissors' && from.track.id !== to.track.id) return fail('両渡線は同じ複線の上で2か所を選んでください。');
      const sides = [from.track.type === 'double' ? from.side : 0, to.track.type === 'double' ? to.side : 0];
      if (from.track.id === to.track.id && sides[0] === sides[1]) sides[1] = -sides[1];
      if (from.track.id === to.track.id && !sides[0]) return fail('同じ単線同士に渡線は設置できません。');
      const origin = from.point, cos = Math.cos(origin.lat * RAD);
      const xy = p => ({ x: (p.lng - origin.lng) * RAD * EARTH * cos, y: (p.lat - origin.lat) * RAD * EARTH });
      const geo = p => ({ lat: origin.lat + p.y / EARTH / RAD, lng: origin.lng + p.x / EARTH / RAD / cos });
      const tangentAt = hit => {
        const a = xy(hit.track.points[hit.segmentIndex]), b = xy(hit.track.points[hit.segmentIndex + 1]);
        const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
      };
      const tangentFrom = tangentAt(from), tangentTo = tangentAt(to);
      const start = xy(from.point), end = xy(to.point);
      start.x -= tangentFrom.y * .75 * sides[0]; start.y += tangentFrom.x * .75 * sides[0];
      end.x -= tangentTo.y * .75 * sides[1]; end.y += tangentTo.x * .75 * sides[1];
      const chord = { x: end.x - start.x, y: end.y - start.y }, metres = Math.hypot(chord.x, chord.y);
      if (metres < 5) return fail('渡線の始点と終点は5m以上離してください。');
      if (tangentFrom.x * chord.x + tangentFrom.y * chord.y < 0) { tangentFrom.x *= -1; tangentFrom.y *= -1; }
      if (tangentTo.x * chord.x + tangentTo.y * chord.y < 0) { tangentTo.x *= -1; tangentTo.y *= -1; }
      const handle = metres / 3;
      const first = { x: start.x + tangentFrom.x * handle, y: start.y + tangentFrom.y * handle };
      const second = { x: end.x - tangentTo.x * handle, y: end.y - tangentTo.y * handle };
      points = [];
      const steps = Math.max(16, Math.min(2000, Math.ceil(metres / 10)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        points.push(geo({ x: u ** 3 * start.x + 3 * u ** 2 * t * first.x + 3 * u * t ** 2 * second.x + t ** 3 * end.x, y: u ** 3 * start.y + 3 * u ** 2 * t * first.y + 3 * u * t ** 2 * second.y + t ** 3 * end.y }));
      }
    }
    Object.defineProperty(points, '_planned', { value: true });
    return { ok: true, points, minRadius: Infinity };
  }
  if (settings.curveMode !== 'legacy') {
    if (controlPoints.length > 10_000) return fail('計画点が多すぎます。');
    return planBezierTrack(controlPoints, type, settings);
  }
  const origin = controlPoints[0], cos = Math.cos(origin.lat * RAD);
  const toXY = p => ({ x: (p.lng - origin.lng) * RAD * EARTH * cos, y: (p.lat - origin.lat) * RAD * EARTH });
  const toPoint = p => ({ lat: origin.lat + p.y / EARTH / RAD, lng: origin.lng + p.x / EARTH / RAD / cos });
  const controls = controlPoints.map(toXY), sampled = [controls[0], controls[1]];
  const firstLength = Math.hypot(controls[1].x - controls[0].x, controls[1].y - controls[0].y);
  if (firstLength < 2) return fail('同じ場所には計画点を追加できません。');
  let tangent = { x: (controls[1].x - controls[0].x) / firstLength, y: (controls[1].y - controls[0].y) / firstLength }, minRadius = Infinity;
  for (let i = 2; i < controls.length; i++) {
    const from = sampled.at(-1), to = controls[i], dx = to.x - from.x, dy = to.y - from.y, lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 4) return fail('計画点は2m以上離してください。');
    const cross = tangent.x * dy - tangent.y * dx;
    if (Math.abs(cross) < .001) {
      if (tangent.x * dx + tangent.y * dy < 0) return fail('線路をその場で折り返すことはできません。');
      sampled.push(to); continue;
    }
    const signedRadius = lengthSquared / (2 * cross), radius = Math.abs(signedRadius);
    minRadius = Math.min(minRadius, radius);
    if (radius - (type === 'double' ? .75 : 0) < 15 ** 2 / 11.8) return fail('曲線が急すぎます。15km/h以上で走行できる緩やかな曲線にしてください。');
    const center = { x: from.x - tangent.y * signedRadius, y: from.y + tangent.x * signedRadius };
    const begin = Math.atan2(from.y - center.y, from.x - center.x), finish = Math.atan2(to.y - center.y, to.x - center.x);
    let sweep = finish - begin;
    if (signedRadius > 0) { while (sweep <= 0) sweep += 2 * Math.PI; }
    else { while (sweep >= 0) sweep -= 2 * Math.PI; }
    if (Math.abs(sweep) > Math.PI * 1.75) return fail('接続できない曲線です。前方の点を選択してください。');
    const steps = Math.min(5000, Math.max(3, Math.ceil(radius * Math.abs(sweep) / 40)));
    for (let step = 1; step <= steps; step++) {
      const angle = begin + sweep * step / steps;
      sampled.push(step === steps ? to : { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
    }
    tangent = { x: tangent.x * Math.cos(sweep) - tangent.y * Math.sin(sweep), y: tangent.x * Math.sin(sweep) + tangent.y * Math.cos(sweep) };
  }
  const points = sampled.map(toPoint);
  Object.defineProperty(points, '_planned', { value: true });
  return { ok: true, points, minRadius };
}

function validateTrackGeometry(state, points, type) {
  if (['crossover', 'scissors'].includes(type)) return null;
  for (let i = 1; i < points.length; i++) {
    for (let j = i + 2; j < points.length; j++) {
      const cross = segmentIntersection(points[i - 1], points[i], points[j - 1], points[j]);
      if (cross && cross.t > 1e-5 && cross.t < 1 - 1e-5 && cross.u > 1e-5 && cross.u < 1 - 1e-5) return '計画線が自己交差しています。';
    }
    for (const old of state.tracks) {
      for (let j = 1; j < old.points.length; j++) {
        const a = points[i - 1], b = points[i], c = old.points[j - 1], d = old.points[j];
        const cross = segmentIntersection(a, b, c, d);
        if (cross && Math.min(distance(cross.point, points[0]), distance(cross.point, points.at(-1))) > 2) return '既設の線路と接続のない交差はできません。接続点で計画を終えてください。';
        const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
        const hit = project(mid, c, d);
        const cosine = Math.abs(((b.lat - a.lat) * (d.lat - c.lat) + (b.lng - a.lng) * (d.lng - c.lng)) / (Math.hypot(b.lat - a.lat, b.lng - a.lng) * Math.hypot(d.lat - c.lat, d.lng - c.lng) || 1));
        if (hit.distance < 1 && hit.t > .001 && hit.t < .999 && cosine > .995) return '既設の線路と重なる位置には敷設できません。';
      }
    }
  }
  return null;
}

export function buildTrack(state, points, type = 'double', options = {}) {
  if (!['single', 'double', 'crossover', 'scissors'].includes(type)) return fail('線路の種類を選んでください。');
  if (!Array.isArray(points) || points.length < 2 || !points.every(validPoint)) return fail('地図上で2点以上を選択してください。');
  const isCrossing = ['crossover', 'scissors'].includes(type);
  const sourceControls = points._controls || (isCrossing && points._planned ? [points[0], points.at(-1)] : points);
  const effectiveOptions = points._curveOptions || options;
  const planned = planTrackPoints(isCrossing && points._planned ? sourceControls : points, type, state, effectiveOptions);
  if (!planned.ok) return planned;
  const clean = [];
  for (let i = 0; i < planned.points.length; i++) {
    const point = copyPoint(planned.points[i]);
    if (!clean.length || distance(point, clean.at(-1)) >= .1 || i === planned.points.length - 1) clean.push(point);
  }
  if (clean.length < 2 || lineLength(clean) < 5) return fail('線路は5m以上の長さで計画してください。');
  if (lineLength(clean) > 2_000_000) return fail('1回の建設距離が長すぎます。');
  let hostTrackId = null, connections = null;
  if (type === 'crossover' || type === 'scissors') {
    const options = type === 'scissors' ? { doubleOnly: true } : { mainOnly: true };
    const from = nearestTrack(state, clean[0], options);
    const to = nearestTrack(state, clean.at(-1), options);
    if (!from || !to || from.distance > 80 || to.distance > 80) return fail('既設の線路上で渡線の始点と終点を選んでください。');
    if (type === 'scissors' && from.track.id !== to.track.id) return fail('両渡線は同じ複線の上で2か所を選んでください。');
    hostTrackId = from.track.id;
    connections = [
      { trackId: from.track.id, side: from.side, offset: from.offset },
      { trackId: to.track.id, side: from.track.id === to.track.id && from.side === to.side ? -to.side : to.side, offset: to.offset },
    ];
  } else {
    // Endpoints snap to already built tracks, making branch junctions usable.
    for (const index of [0, clean.length - 1]) {
      if (options._preserveEndpoints?.[index === 0 ? 0 : 1]) continue;
      let hit = nearestTrack({ tracks: state.tracks.filter(track => !track.stationWiring) }, clean[index], { mainOnly: true });
      for (const station of state.stations) if (station.wiringMode === 'platforms') {
        for (const port of stationGeometry(station).connectionPorts) {
          const metres = distance(clean[index], port.point);
          if (metres <= 20 && (!hit || metres < hit.distance)) hit = { point: port.point, distance: metres };
        }
        if (stationGeometry(station).bufferStops.some(stop => distance(clean[index], stop.point) < .25)) return fail('車止めには接続できません。開いている番線の接続口を選んでください。');
      }
      const shared = existingNetwork?.nearestTrack?.(clean[index], 80);
      if (shared && (!hit || shared.distance < hit.distance)) hit = shared;
      if (hit && hit.distance <= 20) clean[index] = hit.point;
    }
  }
  const geometryError = validateTrackGeometry(state, clean, type);
  if (geometryError) return fail(geometryError);
  const cost = estimateTrackCost(clean, type, state);
  if (!state.unlimited && state.money < cost.total) return fail('所持金が不足しています。');
  const metadata = curveMetadata(sourceControls, effectiveOptions);
  const track = { id: uid('track'), type, points: clean, length: cost.length, cost: cost.total, hostTrackId, connections,
    ...(metadata && (metadata.curveMode || metadata.handles) ? { ...metadata, controlPoints: sourceControls.map(copyPoint) } : {}) };
  state.tracks.push(track);
  if (!state.unlimited) state.money -= cost.total;
  state.stats.construction = (state.stats.construction || 0) + cost.total;
  return { ok: true, track, cost };
}

function validDraftId(value) { return typeof value === 'string' && value.length <= 128 && !!value.trim() && !/[\u0000-\u001f\u007f]/.test(value); }

function prepareTrackDrafts(state, drafts) {
  if (!Array.isArray(drafts) || drafts.length < 1 || drafts.length > 200) return fail('建設する線路の下書きを選んでください。');
  let pointCount = 0; const ids = new Set();
  for (const [index, draft] of drafts.entries()) {
    if (!draft || !['single', 'double', 'crossover', 'scissors'].includes(draft.type) || !Array.isArray(draft.points) || draft.points.length < 2 || draft.points.length > 10_000 || !Array.from(draft.points).every(validPoint)) return { ...fail('各線路の下書きには有効な計画点が2点以上必要です。'), invalidStrokeIndex: index };
    pointCount += draft.points.length;
    if (pointCount > 10_000) return { ...fail('線路の下書きの計画点が多すぎます。'), invalidStrokeIndex: index };
    if (draft.id !== undefined) {
      if (!validDraftId(draft.id) || ids.has(draft.id)) return { ...fail('線路の下書きIDが正しくないか重複しています。'), invalidStrokeIndex: index };
      ids.add(draft.id);
    }
  }
  const scratch = { ...state, tracks: state.tracks.slice(), stats: { ...state.stats } }, tracks = [];
  const cost = { length: 0, trackCost: 0, landCost: 0, total: 0, construction: 0, land: 0 };
  for (const [index, draft] of drafts.entries()) {
    const result = buildTrack(scratch, draft.points, draft.type, draft);
    if (!result.ok) return { ...result, invalidStrokeIndex: index, cost, totalCost: cost.total };
    tracks.push(result.track);
    for (const key of Object.keys(cost)) cost[key] += result.cost[key] || 0;
  }
  return { ok: true, tracks, cost, totalCost: cost.total, scratch };
}

/** Preview separate strokes in construction order, including their dependencies. */
export function previewTrackDrafts(state, drafts) {
  const { scratch, ...result } = prepareTrackDrafts(state, drafts);
  return result;
}

/** Resolve visible draft geometry in its original construction order. */
export function planTrackDraftGeometries(state, drafts) {
  if (!Array.isArray(drafts)) return [];
  const invalid = error => ({ ok: false, points: [], minRadius: Infinity, error });
  if (!state || !Array.isArray(state.tracks) || !Array.isArray(state.stations)) return drafts.map(() => invalid('線路の編集状態が正しくありません。'));
  const scratch = { ...state, tracks: state.tracks.slice(), stats: { ...state.stats }, unlimited: true };
  return drafts.map(draft => {
    if (!draft || !['single', 'double', 'crossover', 'scissors'].includes(draft.type) || !Array.isArray(draft.points) || draft.points.length > 10_000 || !Array.from(draft.points).every(validPoint)) return invalid('計画線の座標または種類が正しくありません。');
    try {
      const geometry = planTrackPoints(draft.points, draft.type, scratch, draft);
      const result = { ...geometry, points: geometry.points || draft.points.map(copyPoint), minRadius: geometry.minRadius ?? Infinity };
      if (!geometry.ok || draft.points.length < 2) return result;
      // Reuse the sampled curve for ordinary tracks, while buildTrack handles
      // switch attachment and cross-stroke geometry checks on the same scratch.
      const built = buildTrack(scratch, geometry.points, draft.type, draft);
      if (!built.ok) return { ...result, ok: false, error: built.error };
      return { ...result, points: built.track.points };
    } catch (error) { return { ...invalid(error?.message || '下書きの形状を計算できませんでした。'), points: draft.points.map(copyPoint) }; }
  });
}

/** Commit separate draft strokes together; no partial construction on failure. */
export function buildTrackDrafts(state, drafts) {
  const { scratch, ...result } = prepareTrackDrafts(state, drafts);
  if (!result.ok) return result;
  state.tracks = scratch.tracks; state.money = scratch.money; state.stats.construction = scratch.stats.construction;
  return result;
}

function prepareConstructionPlan(state, trackDrafts, stationDrafts) {
  const cost = { length: 0, trackCost: 0, landCost: 0, stations: 0, total: 0, construction: 0, land: 0 };
  const result = { ok: false, geometryOk: false, canBuild: false, cost, totalCost: 0, tracks: [], stations: [], preparedTracks: [], trackIdMap: {}, trackPreviews: [], stationPreviews: [] };
  if (!state || !Array.isArray(state.tracks) || !Array.isArray(state.stations) || !Array.isArray(state.routes) || !Array.isArray(trackDrafts) || !Array.isArray(stationDrafts) || trackDrafts.length > 200 || stationDrafts.length > 201) return { ...result, error: '建設計画の下書きが正しくありません。' };
  if (!trackDrafts.length && !stationDrafts.length) return { ...result, error: '確定する線路または駅の下書きを配置してください。' };
  const scratch = { ...state, tracks: state.tracks.slice(), stations: state.stations.slice(), routes: state.routes.slice(), stats: { ...state.stats }, unlimited: true, trackDrafts, trackDraft: null };
  const idCounts = new Map(), mapped = new Map();
  for (const draft of trackDrafts) if (draft?.id !== undefined) idCounts.set(draft.id, (idCounts.get(draft.id) || 0) + 1);
  let pointCount = 0, geometryOk = true;
  const invalidate = (error, kind, index) => {
    geometryOk = false; result.error ||= error;
    const field = kind === 'track' ? 'invalidTrackIndex' : 'invalidStationIndex';
    result[field] ??= index;
  };
  const stationOptions = draft => {
    const options = { ...draft.options };
    if (options.draftTrackId !== undefined) {
      const actualId = mapped.get(options.draftTrackId);
      if (!actualId) return null;
      delete options.draftTrackId; options.ownedTrackId = actualId;
    }
    return options;
  };
  const pendingPortEndpoints = points => {
    const endpoints = [points[0], points.at(-1)], preserve = [false, false];
    for (const raw of stationDrafts) {
      if (raw?.kind !== 'new' || !validPoint(raw.point)) continue;
      const radius = (Number(raw.cars) || 1) * 10 + getStationLayout(raw.options?.layoutId).tracks * 24 + 100;
      if (!endpoints.some(endpoint => distance(endpoint, raw.point) <= radius)) continue;
      const draft = restoreStationDraft(raw, scratch); if (!draft) continue;
      const options = stationOptions(draft); if (!options) continue;
      const preview = previewStation(scratch, draft.point, draft.cars, options);
      if (!preview.ok || preview.wiringMode !== 'platforms') continue;
      const hosts = new Set(preview.geometry.hostSlotIndices.map(index => index + 1));
      for (const port of preview.geometry.connectionPorts) if (port.platformNumbers.every(number => !hosts.has(number))) {
        endpoints.forEach((endpoint, index) => { if (distance(endpoint, port.point) <= .25) preserve[index] = true; });
      }
      if (preserve.every(Boolean)) break;
    }
    return preserve;
  };
  for (const [draftIndex, draft] of trackDrafts.entries()) {
    let error = null;
    if (!draft || !['single', 'double', 'crossover', 'scissors'].includes(draft.type) || !Array.isArray(draft.points) || draft.points.length < 2 || draft.points.length > 10_000 || !Array.from(draft.points).every(validPoint)) error = '各線路の下書きには有効な計画点が2点以上必要です。';
    else if (draft.id !== undefined && (!validDraftId(draft.id) || idCounts.get(draft.id) !== 1)) error = '線路の下書きIDが正しくないか重複しています。';
    else { pointCount += draft.points.length; if (pointCount > 10_000) error = '線路の下書きの計画点が多すぎます。'; }
    if (error) { invalidate(error, 'track', draftIndex); result.trackPreviews.push({ draftIndex, ok: false, error }); continue; }
    const built = buildTrack(scratch, draft.points, draft.type, { ...draft, _preserveEndpoints: pendingPortEndpoints(draft.points) });
    if (!built.ok) { invalidate(built.error, 'track', draftIndex); result.trackPreviews.push({ draftIndex, ...built }); continue; }
    result.tracks.push(built.track);
    const prepared = { ...built.track, draftIndex, ...(draft.id !== undefined ? { draftTrackId: draft.id } : {}) };
    result.preparedTracks.push(prepared); result.trackPreviews.push({ draftIndex, ok: true, track: prepared, points: prepared.points });
    if (draft.id !== undefined) mapped.set(draft.id, built.track.id);
    for (const key of ['length', 'trackCost', 'landCost', 'total', 'construction', 'land']) cost[key] += built.cost[key] || 0;
  }
  for (const [draftIndex, raw] of stationDrafts.entries()) {
    const draft = restoreStationDraft(raw, scratch);
    if (!draft) { const error = '駅の下書きの位置または設定が正しくありません。'; invalidate(error, 'station', draftIndex); result.stationPreviews.push({ draftIndex, ok: false, error }); continue; }
    if (draft.kind === 'existing') {
      const source = existingNetwork?.getStation?.(draft.sourceStationId);
      const built = source ? useExistingStation(scratch, source, 20) : fail('既設駅の情報を確認できません。鉄道データの読み込みを確認してください。');
      if (!built.ok) { invalidate(built.error, 'station', draftIndex); result.stationPreviews.push({ draftIndex, ok: false, source, error: built.error }); continue; }
      if (!result.stations.some(station => station.id === built.station.id)) result.stations.push(built.station);
      result.stationPreviews.push({ draftIndex, ok: true, source, station: built.station, reused: !!built.reused }); continue;
    }
    const options = stationOptions(draft);
    if (!options) { const error = '駅を置く下書き線路が見つからないか、その線路の計画が無効です。別の線路へ自動接続はしません。'; invalidate(error, 'station', draftIndex); result.stationPreviews.push({ draftIndex, ok: false, error }); continue; }
    const preview = previewStation(scratch, draft.point, draft.cars, options);
    if (!preview.ok) { invalidate(preview.error, 'station', draftIndex); result.stationPreviews.push({ draftIndex, ok: false, preview, error: preview.error }); continue; }
    const built = buildStation(scratch, draft.point, draft.cars, undefined, options);
    if (!built.ok) { invalidate(built.error, 'station', draftIndex); result.stationPreviews.push({ draftIndex, ok: false, preview, error: built.error }); continue; }
    result.stations.push(built.station); result.stationPreviews.push({ draftIndex, ok: true, preview, station: built.station });
    cost.stations += built.cost; cost.total += built.cost; cost.construction += built.cost;
  }
  const affordable = state.unlimited || (Number.isFinite(state.money) && state.money >= cost.total);
  Object.assign(result, { geometryOk, ok: geometryOk && affordable, canBuild: geometryOk && affordable, totalCost: cost.total, trackIdMap: Object.fromEntries(mapped) });
  if (geometryOk && !affordable) result.error = '建設計画全体の所持金が不足しています。線路と駅の合計費用を確認してください。';
  return { ...result, scratch };
}

/** Resolve an entire blueprint without charging money or changing the world. */
export function previewConstructionPlan(state, trackDrafts = [], stationDrafts = []) {
  const { scratch, ...result } = prepareConstructionPlan(state, trackDrafts, stationDrafts);
  return structuredClone(result);
}

/** Build all blueprint lines and stations together, or leave everything intact. */
export function buildConstructionPlan(state, trackDrafts = [], stationDrafts = []) {
  const { scratch, ...result } = prepareConstructionPlan(state, trackDrafts, stationDrafts);
  if (!result.ok) return result;
  const money = state.unlimited ? state.money : state.money - result.cost.total;
  const stats = { ...state.stats, construction: (state.stats?.construction || 0) + result.cost.total };
  state.tracks = scratch.tracks; state.stations = scratch.stations; state.money = money; state.stats = stats;
  return result;
}

export function stationCostBreakdown(cars = 1, options = {}) {
  cars = clamp(Math.round(Number(cars) || 1), 1, 20);
  const layout = getStationLayout(options.layoutId);
  const standalone = options.placement === 'free' || options.standalone === true;
  const hostTrackCount = standalone ? 0 : options.hostTrackCount != null ? Math.min(layout.tracks, Math.max(0, Number(options.hostTrackCount))) : options.placement === 'track' ? Math.min(2, layout.tracks) : options.layoutId ? 0 : 1;
  const geometry = options.geometry || stationGeometry({ ...options, lat: 0, lng: 0, cars, layoutId: layout.id, standalone, hostTrackCount });
  const railLength = geometry.trackPaths.reduce((sum, path, index) => sum + (geometry.hostSlotIndices.includes(index) ? 0 : lineLength(path)), 0);
  const baseCost = 100_000_000, platformCost = cars * layout.platforms * 80_000_000, trackCost = Math.round(railLength * 2_500_000);
  return { base: baseCost, platforms: platformCost, tracks: trackCost, baseCost, platformCost, trackCost, total: baseCost + platformCost + trackCost };
}

export function estimateStationCost(cars = 1, options = {}) { return stationCostBreakdown(cars, options).total; }

function pointAtTrackOffset(track, offset) {
  let passed = 0;
  for (let i = 1; i < track.points.length; i++) {
    const a = track.points[i - 1], b = track.points[i], length = distance(a, b);
    if (passed + length >= offset || i === track.points.length - 1) {
      const t = clamp((offset - passed) / (length || 1), 0, 1);
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    passed += length;
  }
  return copyPoint(track.points[0]);
}

function sourceTrackSlice(track, from, to) {
  const offsets = track.offsets || track.points.reduce((values, p, i) => [...values, i ? values[i - 1] + distance(track.points[i - 1], p) : 0], []);
  const first = clamp(from, 0, offsets.at(-1)), last = clamp(to, 0, offsets.at(-1)), low = Math.min(first, last), high = Math.max(first, last);
  const entries = [{ point: pointAtTrackOffset(track, low), offset: low, trackId: track.id }];
  for (let index = 1; index + 1 < track.points.length; index++) if (offsets[index] > low && offsets[index] < high) entries.push({ point: copyPoint(track.points[index]), offset: offsets[index], trackId: track.id });
  entries.push({ point: pointAtTrackOffset(track, high), offset: high, trackId: track.id });
  return first <= last ? entries : entries.reverse();
}

function existingStationHostGeometry(track, offset, extent, platformHalf, requiredExtent) {
  const center = pointAtTrackOffset(track, offset), cosine = Math.cos(center.lat * RAD);
  const vector = (a, b) => {
    const x = (b.lng - a.lng) * cosine, y = b.lat - a.lat, length = Math.hypot(x, y);
    return length > 1e-12 ? { x: x / length, y: y / length } : null;
  };
  const walk = direction => {
    let source = track, endKey = direction < 0 ? source.startKey : source.endKey;
    let entries = sourceTrackSlice(source, offset, direction < 0 ? 0 : source.length ?? lineLength(source.points));
    let remaining = extent, travelled = 0, anchor = { trackId: track.id, offset };
    const points = [copyPoint(center)], visited = new Set();
    const segment = existingNetwork?.pointOnTrack?.(track, offset)?.segmentIndex ?? 0;
    const initial = vector(track.points[segment], track.points[Math.min(segment + 1, track.points.length - 1)]) || { x: 1, y: 0 };
    let heading = { x: initial.x * direction, y: initial.y * direction };
    for (let guard = 0; guard < 256; guard++) {
      for (let index = 1; index < entries.length; index++) {
        const previous = entries[index - 1], next = entries[index], metres = distance(previous.point, next.point);
        if (metres < 1e-8) { anchor = { trackId: source.id, offset: next.offset }; continue; }
        if (remaining <= metres) {
          const at = previous.offset + (next.offset - previous.offset) * remaining / metres;
          const point = pointAtTrackOffset(source, at);
          points.push(point); travelled += remaining;
          return { complete: true, points, travelled, anchor: { trackId: source.id, offset: at } };
        }
        heading = vector(previous.point, next.point) || heading;
        points.push(copyPoint(next.point)); remaining -= metres; travelled += metres; anchor = { trackId: source.id, offset: next.offset };
      }
      // Source-feature boundaries are often artificial. Continue only through
      // exact provider junctions, choosing the most tangent-continuous edge.
      const node = existingNetwork?.baseNodes?.get(endKey);
      const candidates = (node?.edges || []).map(edge => {
        const key = `${edge.trackId}|${endKey}|${edge.to}`;
        const first = edge.points?.[0], next = first && edge.points.find(point => distance(first, point) > .01);
        const tangent = first && next ? vector(first, next) : null;
        return { edge, key, dot: tangent ? heading.x * tangent.x + heading.y * tangent.y : -1 };
      }).filter(candidate => candidate.dot > .15 && !visited.has(candidate.key)).sort((a, b) => b.dot - a.dot || a.key.localeCompare(b.key));
      const choice = candidates[0];
      if (!choice) break;
      const nextSource = existingNetwork?.getTrack?.(choice.edge.trackId);
      if (!nextSource) break;
      const start = nextSource.junctions?.find(junction => junction.key === endKey)?.offset;
      const finish = nextSource.junctions?.find(junction => junction.key === choice.edge.to)?.offset;
      if (!Number.isFinite(start) || !Number.isFinite(finish) || Math.abs(finish - start) < .01) break;
      visited.add(choice.key); source = nextSource; entries = sourceTrackSlice(source, start, finish); endKey = choice.edge.to;
      if (distance(points.at(-1), entries[0].point) > .01) points.push(copyPoint(entries[0].point));
    }
    return { complete: false, points, travelled, anchor };
  };
  const left = walk(-1), right = walk(1);
  if (requiredExtent > 0 && (left.travelled + .01 < requiredExtent || right.travelled + .01 < requiredExtent)) return fail('駅のホームと構内線路を置くための既設線路の長さが不足しています。線路端から少し内側へ移動してください。');
  const hostTrackPoints = [...left.points.slice().reverse(), ...right.points.slice(1)].filter((point, index, list) => !index || distance(point, list[index - 1]) > .001);
  if (hostTrackPoints.length < 2) return fail('既設線路の形状を確認できません。別の位置を選択してください。');
  const local = { points: hostTrackPoints };
  return { ok: true, hostTrackPoints, hostPlatformPoints: [pointAtTrackOffset(local, Math.max(0, left.travelled - platformHalf)), pointAtTrackOffset(local, left.travelled + platformHalf)], connectionPoints: [copyPoint(hostTrackPoints[0]), copyPoint(hostTrackPoints.at(-1))], existingHostConnections: [left.anchor, right.anchor] };
}

function footprintsOverlap(a, b) {
  const origin = a[0], cos = Math.cos(origin.lat * RAD);
  const local = list => list.map(p => ({ x: (p.lng - origin.lng) * cos, y: p.lat - origin.lat }));
  const first = local(a), second = local(b);
  for (const points of [first, second]) for (let i = 0; i < points.length; i++) {
    const from = points[i], to = points[(i + 1) % points.length], axis = { x: -(to.y - from.y), y: to.x - from.x };
    const project = points => points.map(p => p.x * axis.x + p.y * axis.y);
    const x = project(first), y = project(second);
    if (Math.max(...x) < Math.min(...y) || Math.max(...y) < Math.min(...x)) return false;
  }
  return true;
}

export function previewStation(state, point, cars = 1, options = {}) {
  cars = Number(cars);
  if (!Number.isInteger(cars) || cars < 1 || cars > 20) return fail('ホーム対応両数は1〜20両で指定してください。');
  if (!validPoint(point)) return fail('地図上の設置位置を選択してください。');
  if (options.draftTrackId !== undefined) return fail('下書き線路上の駅は、建設計画全体のプレビューまたは一括確定で確認してください。');
  if (options.layoutId && !STATION_LAYOUTS.some(layout => layout.id === options.layoutId)) return fail('駅の構成を選択してください。');
  const layout = getStationLayout(options.layoutId), standalone = options.placement === 'free';
  const wiringError = stationWiringError(options, standalone); if (wiringError) return fail(wiringError);
  let hit = standalone ? null : nearestTrack(options.ownedTrackId ? { tracks: state.tracks.filter(track => track.id === options.ownedTrackId) } : state, point, { mainOnly: true });
  let existingTrack = false;
  if (!standalone && options.existingTrackId) {
    const host = existingNetwork?.getTrack?.(options.existingTrackId);
    if (!host || !String(host.id).startsWith('existing:')) return fail('既設線路の読み込みを確認してください。');
    const projected = nearestTrack({ tracks: [{ ...host, type: 'single' }] }, point, { mainOnly: true });
    hit = projected ? { ...projected, track: host } : null; existingTrack = true;
  }
  if (!standalone && (!hit || hit.distance > 100)) return fail('建設済みの線路上をクリックするか、「駅を先に設置」を選択してください。');
  if (options.layoutId && hit?.track.type === 'double' && layout.tracks < 2) return fail('複線上には2線以上の駅構成を選択してください。');
  const center = standalone ? copyPoint(point) : copyPoint(hit.point);
  let bearing = ((Number(options.bearing) || 0) % 360 + 360) % 360;
  if (hit) {
    const a = hit.track.points[hit.segmentIndex], b = hit.track.points[hit.segmentIndex + 1];
    bearing = Math.atan2(b.lat - a.lat, (b.lng - a.lng) * Math.cos(center.lat * RAD)) / RAD;
  }
  const hostTrackCount = standalone ? 0 : Math.min(layout.tracks, hit.track.type === 'double' ? 2 : 1);
  const hostSelection = { hostPlatformSelection: options.hostPlatformNumber === undefined ? 'auto' : 'explicit', ...(options.hostPlatformNumber !== undefined ? { hostPlatformNumber: options.hostPlatformNumber } : {}) };
  const hostSelectionError = stationHostSelectionError({ ...options, ...hostSelection, layoutId: layout.id, standalone, hostTrackCount });
  if (hostSelectionError) return fail(hostSelectionError);
  const wiringMode = options.wiringMode ?? (options.placement === 'track' ? 'platforms' : 'merged'), trackConfigs = getStationTrackConfigs({ ...options, layoutId: layout.id, wiringMode });
  const portGeometry = options.portGeometry === 'spread' ? 'spread' : 'straight';
  let geometry = stationGeometry({ ...center, cars, layoutId: layout.id, bearing, standalone, hostTrackCount, wiringMode, portGeometry, trackConfigs, ...hostSelection });
  const hostWiringError = stationHostWiringError({ ...center, cars, layoutId: layout.id, bearing, standalone, hostTrackCount, wiringMode, portGeometry, trackConfigs, ...hostSelection });
  if (hostWiringError) return fail(hostWiringError);
  const costBreakdown = stationCostBreakdown(cars, { layoutId: layout.id, placement: standalone ? 'free' : 'track', hostTrackCount, wiringMode, portGeometry, trackConfigs, ...hostSelection });
  const preview = { ...(hit || {}), point: center, ...center, cars, layoutId: layout.id, bearing, standalone, hostTrackCount, wiringMode, portGeometry, trackConfigs, ...hostSelection, ...(hostTrackCount ? { hostPlatformNumber: geometry.hostSlotIndices[0] + 1 } : {}), ...(existingTrack ? { existingTrack: true } : {}), platformLength: geometry.platformLength, geometry, cost: costBreakdown.total, costBreakdown };
  const invalid = error => ({ ...preview, ok: false, error });
  if (hit && existingTrack) {
    const extent = layout.tracks > hostTrackCount ? geometry.totalLength / 2 : geometry.platformLength / 2;
    const requiredExtent = wiringMode === 'platforms' ? geometry.platformLength / 2 : layout.tracks > hostTrackCount ? extent : 0;
    const hostGeometry = existingStationHostGeometry(hit.track, hit.offset, extent, geometry.platformLength / 2, requiredExtent);
    if (!hostGeometry.ok) return invalid(hostGeometry.error);
    const { ok, ...hostFields } = hostGeometry;
    Object.assign(preview, hostFields, { hostPlatformNumber: geometry.hostSlotIndices[0] + 1 });
    geometry = stationGeometry(preview);
    const actualCost = stationCostBreakdown(cars, { layoutId: layout.id, placement: 'track', hostTrackCount, geometry });
    Object.assign(preview, { geometry, cost: actualCost.total, costBreakdown: actualCost });
    if (state.stations.some(station => !station.existing && station.trackId === hit.track.id && Math.abs(station.offset - hit.offset) < (station.cars + cars) * 10 + 2)) return invalid('ほかの駅のホームと重なっています。');
  }
  if (hit && !existingTrack) {
    const hostLength = lineLength(hit.track.points), extent = layout.tracks > hostTrackCount ? geometry.totalLength / 2 : geometry.platformLength / 2;
    const requiredExtent = wiringMode === 'platforms' ? geometry.platformLength / 2 : extent;
    if (hostLength < requiredExtent * 2) return invalid('ホームと構内線路の長さが線路の長さを超えています。');
    if (hit.offset < requiredExtent || hostLength - hit.offset < requiredExtent) return invalid('線路の端からホームがはみ出します。少し内側に設置してください。');
    if (state.stations.some(s => s.trackId === hit.track.id && Math.abs(s.offset - hit.offset) < (s.cars + cars) * 10 + 2)) return invalid('ほかの駅のホームと重なっています。');
    if (layout.tracks > hostTrackCount || wiringMode === 'platforms') {
      const connectionPoints = [pointAtTrackOffset(hit.track, hit.offset - extent), pointAtTrackOffset(hit.track, hit.offset + extent)];
      const hostTrackPoints = sourceTrackSlice(hit.track, hit.offset - extent, hit.offset + extent).map(entry => entry.point);
      Object.assign(preview, { connectionPoints, hostTrackPoints, hostPlatformPoints: [pointAtTrackOffset(hit.track, hit.offset - geometry.platformLength / 2), pointAtTrackOffset(hit.track, hit.offset + geometry.platformLength / 2)], hostPlatformNumber: geometry.hostSlotIndices[0] + 1 });
      geometry = stationGeometry(preview);
      const actualCost = stationCostBreakdown(cars, { layoutId: layout.id, placement: 'track', hostTrackCount, geometry });
      Object.assign(preview, { geometry, cost: actualCost.total, costBreakdown: actualCost });
    }
  }
  for (const station of state.stations) {
    if (station.existing || distance(center, station) > (geometry.totalLength + station.cars * 20) / 2 + 150) continue;
    const oldBearing = station.bearing ?? (() => {
      const oldHit = nearestTrack(state, station, { mainOnly: true });
      if (!oldHit) return 0;
      const a = oldHit.track.points[oldHit.segmentIndex], b = oldHit.track.points[oldHit.segmentIndex + 1];
      return Math.atan2(b.lat - a.lat, (b.lng - a.lng) * Math.cos(station.lat * RAD)) / RAD;
    })();
    if (footprintsOverlap(geometry.footprint, stationGeometry({ ...station, bearing: oldBearing }).footprint)) return invalid('ほかの駅のホーム・構内線路と重なっています。');
  }
  if (!state.unlimited && state.money < preview.cost) return invalid('駅の建設資金が不足しています。');
  return { ...preview, ok: true };
}

export function buildStation(state, point, cars = 1, name, options = {}) {
  const preview = previewStation(state, point, cars, options);
  if (!preview.ok) return preview;
  const { cost, platformLength, geometry } = preview;
  cars = preview.cars;
  const stationId = uid('station'), internal = [];
  geometry.trackPaths.forEach((points, index) => {
    if (geometry.hostSlotIndices.includes(index)) return;
    internal.push({ id: uid('track'), type: 'single', points, length: lineLength(points), cost: 0, stationId, stationTrack: true, platformIndex: index, hostTrackId: null, connections: null,
      ...(!preview.standalone && preview.wiringMode === 'platforms' ? { existingHostConnections: null } : preview.existingHostConnections ? { existingHostConnections: preview.existingHostConnections.map(connection => ({ ...connection })) } : {}),
      ...(preview.wiringMode === 'platforms' ? { stationWiring: true, stationDirection: preview.trackConfigs[index].direction, stationPorts: { a: preview.trackConfigs[index].a !== 'buffer', b: preview.trackConfigs[index].b !== 'buffer' } } : {}) });
  });
  const platformTrackIds = [...(preview.track ? [preview.track.id] : []), ...internal.map(track => track.id)];
  const station = {
    id: stationId, name: String(name || `新駅${state.stations.length + 1}`).trim().slice(0, 48),
    ...preview.point, cars, trackId: platformTrackIds[0], platformTrackIds, offset: preview.offset ?? lineLength(internal[0]?.points || []) / 2, segmentIndex: preview.segmentIndex || 0,
    layoutId: preview.layoutId, bearing: preview.bearing, standalone: preview.standalone, hostTrackCount: preview.hostTrackCount,
    ...(!preview.standalone ? { hostPlatformSelection: preview.hostPlatformSelection, hostPlatformNumber: preview.hostPlatformNumber } : {}),
    wiringMode: preview.wiringMode, portGeometry: preview.portGeometry, trackConfigs: preview.trackConfigs,
    ...(preview.existingTrack ? { existingTrack: true } : {}),
    ...(preview.hostTrackPoints ? { hostTrackPoints: preview.hostTrackPoints.map(copyPoint), hostPlatformPoints: preview.hostPlatformPoints.map(copyPoint), hostPlatformNumber: preview.hostPlatformNumber, ...(preview.existingHostConnections ? { existingHostConnections: preview.existingHostConnections.map(connection => ({ ...connection })) } : {}) } : {}),
    ...(preview.connectionPoints ? { connectionPoints: preview.connectionPoints } : {}),
    platformLength, side: preview.side || 1, cost, passengers: 0, demand: 1, population: stationPopulation(preview.point),
  };
  state.tracks.push(...internal); state.stations.push(station);
  if (!state.unlimited) state.money -= cost;
  state.stats.construction = (state.stats.construction || 0) + cost;
  return { ok: true, station, cost, costBreakdown: preview.costBreakdown };
}

export function useExistingStation(state, sourceStation, cars = 20) {
  if (!existingNetwork) return fail('既設路線データの読み込みが完了していません。');
  const sourceId = sourceStation?.sourceStationId ?? sourceStation?.id;
  if (!['string', 'number'].includes(typeof sourceId) || !String(sourceId).trim()) return fail('既設駅を選択してください。');
  const id = String(sourceId);
  const saved = state.stations.find(station => station.existing && String(station.sourceStationId) === id);
  if (saved) return { ok: true, station: saved, cost: 0, reused: true };
  const source = existingNetwork.getStation ? existingNetwork.getStation(id) : sourceStation;
  if (!source || !validPoint(source) || typeof source.trackId !== 'string' || !source.trackId.startsWith('existing:')) return fail('この既設駅の線路への接続を確認できません。');
  cars = Number(cars);
  if (!Number.isInteger(cars) || cars < 1 || cars > 20) return fail('ホーム対応両数は1〜20両で指定してください。');
  const station = {
    id: uid('station'), name: String(source.name || '既設駅').trim().slice(0, 48), ...copyPoint(source),
    existing: true, sourceStationId: id, trackId: source.trackId, offset: Math.max(0, Number(source.offset) || 0),
    segmentIndex: Math.max(0, Number(source.segmentIndex) || 0), cars, platformLength: cars * 20,
    side: 1, cost: 0, passengers: 0, demand: 1, population: stationPopulation(source),
  };
  state.stations.push(station);
  return { ok: true, station, cost: 0, reused: false };
}

export function renameStation(state, id, name) {
  const station = state.stations.find(s => s.id === id);
  if (!station) return fail('駅が見つかりません。');
  name = String(name || '').trim().slice(0, 48);
  if (!name) return fail('駅名を入力してください。');
  station.name = name;
  return { ok: true, station };
}

export function deleteStation(state, id) {
  const station = state.stations.find(s => s.id === id);
  if (!station) return fail('駅が見つかりません。');
  state.stations = state.stations.filter(s => s.id !== id);
  const removedTracks = new Set(state.tracks.filter(track => track.stationId === id).map(track => track.id));
  state.tracks = state.tracks.filter(track => !removedTracks.has(track.id));
  const deletedRouteIds = state.routes.filter(r => r.startId === id || r.endId === id || r.trackIds?.some(trackId => removedTracks.has(trackId))).map(r => r.id);
  state.routes = state.routes.filter(r => !deletedRouteIds.includes(r.id));
  for (const route of state.routes) route.stationIds = route.stationIds.filter(sid => sid !== id);
  return { ok: true, station, deletedRouteIds };
}

/** Describe removal of one owned line and only its infrastructure dependencies. */
export function previewDeleteTrack(state, id) {
  if (typeof id !== 'string' || id.startsWith('existing:')) return fail('青い既設線路は削除できません。');
  const selected = state.tracks.find(track => track.id === id);
  if (!selected) return fail('線路が見つかりません。');
  if (selected.existing || !['single', 'double', 'crossover', 'scissors'].includes(selected.type)) return fail('青い既設線路は削除できません。');
  if (selected.stationId || selected.stationTrack || selected.stationWiring) return fail('駅の構内線路は個別に削除できません。駅の削除を利用してください。');
  const trackIds = new Set([id]), stationIds = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const track of state.tracks) {
      if (trackIds.has(track.id) || !['crossover', 'scissors'].includes(track.type)) continue;
      if (trackIds.has(track.hostTrackId) || track.connections?.some(connection => trackIds.has(connection.trackId))) { trackIds.add(track.id); changed = true; }
    }
    for (const station of state.stations) {
      if (stationIds.has(station.id) || station.existing || station.existingTrack) continue;
      if (trackIds.has(station.trackId) || station.platformTrackIds?.some(trackId => trackIds.has(trackId))) { stationIds.add(station.id); changed = true; }
    }
    for (const track of state.tracks) if (!trackIds.has(track.id) && stationIds.has(track.stationId)) { trackIds.add(track.id); changed = true; }
  }
  const stations = state.stations.filter(station => stationIds.has(station.id)).map(station => ({ id: station.id, name: station.name }));
  const routes = state.routes.filter(route => stationIds.has(route.startId) || stationIds.has(route.endId) || route.trackIds?.some(trackId => trackIds.has(trackId)) || route.stationIds?.some(stationId => stationIds.has(stationId)) || ['platformAssignments', 'selectedPlatforms'].some(field => ['forward', 'backward'].some(direction => Object.keys(route[field]?.[direction] || {}).some(stationId => stationIds.has(stationId))))).map(route => ({ id: route.id, name: route.name }));
  return { ok: true, trackIds: [...trackIds], stationIds: [...stationIds], routeIds: routes.map(route => route.id), stations, routes, stationNames: stations.map(station => station.name), routeNames: routes.map(route => route.name), cost: 0, refund: 0 };
}

/** Remove a confirmed owned line atomically. Historical costs are not refunded. */
export function deleteTrack(state, id) {
  const result = previewDeleteTrack(state, id);
  if (!result.ok) return result;
  const trackIds = new Set(result.trackIds), stationIds = new Set(result.stationIds), routeIds = new Set(result.routeIds);
  const tracks = state.tracks.filter(track => !trackIds.has(track.id)), stations = state.stations.filter(station => !stationIds.has(station.id)), routes = state.routes.filter(route => !routeIds.has(route.id));
  state.tracks = tracks; state.stations = stations; state.routes = routes;
  return result;
}

function segmentIntersection(a, b, c, d) {
  const bx = b.lng - a.lng, by = b.lat - a.lat, dx = d.lng - c.lng, dy = d.lat - c.lat;
  const den = bx * dy - by * dx;
  if (Math.abs(den) < 1e-14) return null;
  const cx = c.lng - a.lng, cy = c.lat - a.lat;
  const t = (cx * dy - cy * dx) / den;
  const u = (cx * by - cy * bx) / den;
  return t >= -1e-8 && t <= 1 + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8
    ? { point: { lng: a.lng + t * bx, lat: a.lat + t * by }, t: clamp(t, 0, 1), u: clamp(u, 0, 1) } : null;
}

// Track polylines are split at stations and real connections. A drawn crossing
// connects only when a line endpoint meets the other line (grade separation is
// otherwise assumed); dedicated crossover tracks are explicit connections.
function stationEndpointOpen(track, point) {
  if (!track.stationWiring) return true;
  return !!((track.stationPorts?.a && distance(point, track.points[0]) <= .25) || (track.stationPorts?.b && distance(point, track.points.at(-1)) <= .25));
}
function stationJoinAllowed(a, b, pointA, pointB) {
  if (!a.stationWiring && !b.stationWiring) return true;
  return distance(pointA, pointB) <= .25 && stationEndpointOpen(a, pointA) && stationEndpointOpen(b, pointB);
}
function buildGraph(state) {
  // Straight independent station rails can be only four metres apart. Outside
  // links attached to their ports must not rejoin their neighbour via the old
  // five-metre tolerance either; actual snapped endpoints still connect.
  const configuredPorts = state.stations.filter(station => station.wiringMode === 'platforms').flatMap(station => stationGeometry(station).connections);
  const strictTracks = new Set(state.tracks.filter(track => track.stationWiring || [track.points[0], track.points.at(-1)].some(endpoint => configuredPorts.some(port => distance(endpoint, port) <= .25))).map(track => track.id));
  const joinAllowed = (a, b, pointA, pointB) => stationJoinAllowed(a, b, pointA, pointB) && (!(strictTracks.has(a.id) || strictTracks.has(b.id)) || distance(pointA, pointB) <= .25);
  const segments = [];
  for (const track of state.tracks) {
    for (let i = 0; i + 1 < track.points.length; i++) {
      segments.push({ track, index: i, a: track.points[i], b: track.points[i + 1], cuts: [{ t: 0, point: track.points[i] }, { t: 1, point: track.points[i + 1] }] });
    }
  }
  for (const station of state.stations) {
    const trackIds = new Set([station.trackId, ...(station.platformTrackIds || [])]);
    for (const trackId of trackIds) {
      const candidates = segments.filter(s => s.track.id === trackId);
      let best = null;
      for (const segment of candidates) {
        const hit = project(station, segment.a, segment.b);
        if (!best || hit.distance < best.distance) best = { ...hit, segment };
      }
      if (best) best.segment.cuts.push({ t: best.t, point: best.point, stationId: station.id });
    }
  }
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i], b = segments[j];
      if (a.track.id === b.track.id) continue;
      // Bounding boxes avoid costly geographic work for distant segments.
      if (Math.max(a.a.lat, a.b.lat) + .001 < Math.min(b.a.lat, b.b.lat) || Math.max(b.a.lat, b.b.lat) + .001 < Math.min(a.a.lat, a.b.lat) || Math.max(a.a.lng, a.b.lng) + .001 < Math.min(b.a.lng, b.b.lng) || Math.max(b.a.lng, b.b.lng) + .001 < Math.min(a.a.lng, a.b.lng)) continue;
      for (const [point, t] of [[a.a, 0], [a.b, 1]]) {
        const hit = project(point, b.a, b.b);
        if (hit.distance <= 5 && joinAllowed(a.track, b.track, point, hit.point)) {
          a.cuts.push({ t, point: hit.point }); b.cuts.push({ t: hit.t, point: hit.point });
        }
      }
      for (const [point, t] of [[b.a, 0], [b.b, 1]]) {
        const hit = project(point, a.a, a.b);
        if (hit.distance <= 5 && joinAllowed(b.track, a.track, point, hit.point)) {
          b.cuts.push({ t, point: hit.point }); a.cuts.push({ t: hit.t, point: hit.point });
        }
      }
      if (['crossover', 'scissors'].includes(a.track.type) || ['crossover', 'scissors'].includes(b.track.type)) {
        const cross = segmentIntersection(a.a, a.b, b.a, b.b);
        if (cross && joinAllowed(a.track, b.track, cross.point, cross.point)) { a.cuts.push({ t: cross.t, point: cross.point }); b.cuts.push({ t: cross.u, point: cross.point }); }
      }
    }
  }
  const nodes = new Map(), stationNodes = new Map(), groups = new Map();
  const coordinateKey = point => `${Math.round(point.lat * 1e6)},${Math.round(point.lng * 1e6)}`;
  const nodeAt = (segment, point, lane, t) => {
    const coordinate = coordinateKey(point), key = `${segment.track.id}|${coordinate}|${lane}`;
    if (!nodes.has(key)) {
      const node = { key, point: copyPoint(point), edges: [], track: segment.track, lane };
      nodes.set(key, node);
      if (!groups.has(coordinate)) groups.set(coordinate, []);
      groups.get(coordinate).push({ node, segment, t });
    }
    return nodes.get(key);
  };
  for (const segment of segments) {
    const cuts = segment.cuts.sort((a, b) => a.t - b.t);
    const lanes = ['double', 'scissors'].includes(segment.track.type) ? [1, -1] : [0];
    for (const lane of lanes) {
      for (const cut of cuts) {
        const node = nodeAt(segment, cut.point, lane, cut.t);
        if (cut.stationId) {
          if (!stationNodes.has(cut.stationId)) stationNodes.set(cut.stationId, []);
          if (!stationNodes.get(cut.stationId).includes(node.key)) stationNodes.get(cut.stationId).push(node.key);
        }
      }
      for (let i = 1; i < cuts.length; i++) {
        const from = nodeAt(segment, cuts[i - 1].point, lane, cuts[i - 1].t), to = nodeAt(segment, cuts[i].point, lane, cuts[i].t);
        const metres = distance(from.point, to.point);
        if (from === to || metres < .01) continue;
        if ((segment.track.type !== 'double' || lane === 1) && segment.track.stationDirection !== 'reverse') from.edges.push({ to: to.key, distance: metres, trackId: segment.track.id, type: segment.track.type });
        if ((segment.track.type !== 'double' || lane === -1) && segment.track.stationDirection !== 'forward') to.edges.push({ to: from.key, distance: metres, trackId: segment.track.id, type: segment.track.type });
      }
    }
  }
  const isSwitch = track => ['crossover', 'scissors'].includes(track.type);
  const direction = item => {
    const a = item.segment.a, b = item.segment.b, sign = item.node.lane || 1;
    const x = (b.lng - a.lng) * Math.cos(a.lat * RAD), y = b.lat - a.lat, length = Math.hypot(x, y) || 1;
    return { x: sign * x / length, y: sign * y / length };
  };
  const switchCompatible = (bridge, host) => {
    const track = bridge.node.track;
    const atStart = distance(bridge.node.point, track.points[0]) < 2;
    const atEnd = distance(bridge.node.point, track.points.at(-1)) < 2;
    if (!atStart && !atEnd) return false;
    const connection = track.connections?.[atStart ? 0 : 1];
    if (connection?.trackId && connection.trackId !== host.node.track.id) return false;
    const side = track.type === 'scissors' ? (atStart ? bridge.node.lane : -bridge.node.lane) : connection?.side;
    return host.node.lane === 0 || !side || host.node.lane === side;
  };
  for (const entries of groups.values()) {
    for (const a of entries) for (const b of entries) {
      if (a.node.track.id === b.node.track.id) continue;
      if (!joinAllowed(a.node.track, b.node.track, a.node.point, b.node.point)) continue;
      if (isSwitch(a.node.track) && !switchCompatible(a, b)) continue;
      if (isSwitch(b.node.track) && !switchCompatible(b, a)) continue;
      if (a.node.track.type === 'double' && b.node.track.type === 'double') {
        const ad = direction(a), bd = direction(b);
        if (ad.x * bd.x + ad.y * bd.y < -.1) continue;
      }
      // A newly drawn double line attaches its left physical rail to an older
      // single line. A crossover can provide the other return connection.
      const dbl = a.node.track.type === 'double' ? a : b.node.track.type === 'double' ? b : null;
      const single = a.node.track.type === 'single' ? a : b.node.track.type === 'single' ? b : null;
      if (dbl && single && !single.node.track.stationTrack && state.tracks.indexOf(dbl.node.track) > state.tracks.indexOf(single.node.track) && dbl.node.lane !== 1) continue;
      a.node.edges.push({ to: b.node.key, distance: 0, trackId: b.node.track.id, type: b.node.track.type });
    }
  }
  const graph = { nodes, stationNodes };
  existingNetwork?.augmentGraph(graph, state);
  return graph;
}

class DistanceQueue {
  constructor() { this.items = []; }
  push(key, distance) {
    const item = { key, distance }; let index = this.items.length;
    this.items.push(item);
    while (index) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].distance <= distance) break;
      this.items[index] = this.items[parent]; index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    if (!this.items.length) return null;
    const first = this.items[0], last = this.items.pop();
    if (this.items.length) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1].distance < this.items[child].distance) child++;
        if (last.distance <= this.items[child].distance) break;
        this.items[index] = this.items[child]; index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

export function findPath(state, startId, endId, options = {}) {
  const graph = buildGraph(state);
  const requested = options.platforms || {}, prohibited = new Set();
  for (const [id, number] of Object.entries(requested)) {
    const station = state.stations.find(s => s.id === id), platforms = getStationPlatforms(state, station);
    const selected = platforms.find(platform => platform.number === Number(number));
    if (!selected || !Number.isInteger(Number(number))) return null;
    const otherTracks = new Set(platforms.filter(p => p.number !== selected.number).map(p => p.trackId));
    for (const node of graph.nodes.values()) {
      if (node.track?.id === selected.trackId) {
        if (selected.lane != null && node.lane !== selected.lane) prohibited.add(node.key);
      } else if (otherTracks.has(node.track?.id) && (station.standalone || node.track?.id !== station.trackId)) prohibited.add(node.key);
    }
    for (const key of graph.stationNodes.get(id) || []) {
      const node = graph.nodes.get(key);
      if (graph.stationHostNodes?.get(id)?.includes(key) && selected.trackId !== station.trackId) prohibited.add(key);
      if (node.track && (node.track.id !== selected.trackId || (selected.lane != null && node.lane !== selected.lane))) prohibited.add(key);
    }
  }
  const starts = (graph.stationNodes.get(startId) || []).filter(key => !prohibited.has(key)), ends = new Set((graph.stationNodes.get(endId) || []).filter(key => !prohibited.has(key)));
  if (!starts?.length || !ends.size) return null;
  const distances = new Map(starts.map(key => [key, 0])), previous = new Map(), pending = new DistanceQueue();
  for (const key of starts) pending.push(key, 0);
  let end = null;
  while (pending.items.length) {
    const next = pending.pop(), current = next.key;
    if (next.distance !== distances.get(current)) continue;
    if (ends.has(current)) { end = current; break; }
    for (const edge of graph.nodes.get(current).edges) {
      if (prohibited.has(edge.to)) continue;
      const candidate = distances.get(current) + edge.distance;
      if (candidate < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, candidate); previous.set(edge.to, { from: current, edge }); pending.push(edge.to, candidate);
      }
    }
  }
  if (!end) return null;
  const keys = [end], edges = [];
  let cursor = end;
  while (!starts.includes(cursor)) {
    const item = previous.get(cursor);
    if (!item) return null;
    edges.unshift(item.edge); keys.unshift(item.from); cursor = item.from;
  }
  const stationsAt = new Map();
  for (const [id, stationKeys] of graph.stationNodes) for (const key of stationKeys) {
    if (!stationsAt.has(key)) stationsAt.set(key, []);
    stationsAt.get(key).push(id);
  }
  const encountered = [...new Set(keys.flatMap(key => stationsAt.get(key) || []))];
  const pathStationIds = [startId, ...encountered.filter(id => id !== startId && id !== endId), endId];
  if (Object.keys(requested).some(id => !pathStationIds.includes(id))) return null;
  const stationPoints = new Map();
  for (const key of keys) for (const id of stationsAt.get(key) || []) if (!stationPoints.has(id)) stationPoints.set(id, copyPoint(graph.nodes.get(key).point));
  stationPoints.set(startId, copyPoint(graph.nodes.get(keys[0]).point));
  stationPoints.set(endId, copyPoint(graph.nodes.get(keys.at(-1)).point));
  const points = [copyPoint(graph.nodes.get(keys[0]).point)];
  for (let i = 0; i < edges.length; i++) {
    // Shared graph edges can carry a full curved line between their endpoints.
    const geometry = edges[i].points?.length ? edges[i].points : [graph.nodes.get(keys[i + 1]).point];
    for (const point of geometry) if (validPoint(point) && distance(point, points.at(-1)) > .01) points.push(copyPoint(point));
    const destination = graph.nodes.get(keys[i + 1]).point;
    if (distance(destination, points.at(-1)) > .01) points.push(copyPoint(destination));
  }
  const selectedPlatforms = {};
  for (const id of pathStationIds) {
    const station = state.stations.find(s => s.id === id), stationKeys = new Set(graph.stationNodes.get(id) || []);
    const node = keys.map(key => graph.nodes.get(key)).find(node => stationKeys.has(node.key));
    const hostStop = graph.stationHostNodes?.get(id)?.includes(node?.key);
    const platform = getStationPlatforms(state, station).find(platform => platform.trackId === (hostStop ? station.trackId : node?.track?.id) && (platform.lane == null || platform.lane === node.lane));
    selectedPlatforms[id] = Number(requested[id]) || platform?.number || 1;
  }
  return { points, length: distances.get(end), trackIds: [...new Set(edges.map(e => e.trackId))], stationIds: pathStationIds, selectedPlatforms, stationPoints, edges };
}

export function parseServiceTime(input, allowExtended = true) {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(String(input || '').trim());
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]);
  if (hours > (allowExtended ? 29 : 23)) return null;
  return hours * 60 + minutes;
}

function segmentTravelSeconds(points) {
  if (points.length < 2) return 0;
  const samples = [copyPoint(points[0])];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], steps = Math.max(1, Math.ceil(distance(a, b) / 50));
    for (let step = 1; step <= steps; step++) samples.push({ lat: a.lat + (b.lat - a.lat) * step / steps, lng: a.lng + (b.lng - a.lng) * step / steps });
  }
  const limits = samples.map(() => 130 / 3.6);
  for (let i = 1; i < samples.length - 1; i++) {
    const a = distance(samples[i - 1], samples[i]), b = distance(samples[i], samples[i + 1]), c = distance(samples[i - 1], samples[i + 1]);
    const semi = (a + b + c) / 2, area = Math.sqrt(Math.max(0, semi * (semi - a) * (semi - b) * (semi - c)));
    if (area > .01) limits[i] = Math.min(limits[i], Math.sqrt(11.8 * a * b * c / (4 * area)) / 3.6);
  }
  limits[0] = 0; limits[limits.length - 1] = 0;
  for (let i = 1; i < limits.length; i++) limits[i] = Math.min(limits[i], Math.sqrt(limits[i - 1] ** 2 + 2 * .75 * distance(samples[i - 1], samples[i])));
  for (let i = limits.length - 2; i >= 0; i--) limits[i] = Math.min(limits[i], Math.sqrt(limits[i + 1] ** 2 + 2 * .9 * distance(samples[i], samples[i + 1])));
  let seconds = 0;
  for (let i = 1; i < limits.length; i++) seconds += 2 * distance(samples[i - 1], samples[i]) / Math.max(.5, limits[i - 1] + limits[i]);
  return seconds;
}

function routeTravelSeconds(path, stations) {
  const stationMap = new Map(stations.map(station => [station.id, station]));
  let seconds = 0, from = 0;
  for (const stationId of path.stationIds.slice(1)) {
    const station = path.stationPoints?.get(stationId) || stationMap.get(stationId);
    let end = from + 1;
    for (let i = from + 1; i < path.points.length; i++) if (distance(station, path.points[i]) < 1) { end = i; break; }
    const segment = path.points.slice(from, end + 1);
    if (lineLength(segment) < 5) return null;
    seconds += segmentTravelSeconds(segment);
    if (stationId !== path.stationIds.at(-1)) seconds += 30;
    from = end;
  }
  return Math.max(1, seconds);
}

function normalizePlatformAssignments(state, input) {
  const assignments = { forward: {}, backward: {} };
  if (input == null) return { ok: true, assignments };
  if (typeof input !== 'object' || Array.isArray(input)) return fail('路線の使用番線を正しく指定してください。');
  for (const direction of ['forward', 'backward']) {
    const entries = input[direction];
    if (entries == null) continue;
    if (typeof entries !== 'object' || Array.isArray(entries)) return fail('路線の使用番線を正しく指定してください。');
    for (const [id, value] of Object.entries(entries)) {
      if (value == null || value === '' || value === 'auto' || value === 0) continue;
      const station = state.stations.find(s => s.id === id), number = Number(value);
      if (!station || !Number.isInteger(number) || !getStationPlatforms(state, station).some(p => p.number === number)) return fail('選択した駅または番線が見つかりません。使用番線を選び直してください。');
      assignments[direction][id] = number;
    }
  }
  return { ok: true, assignments };
}

export function createRoute(state, options = {}) {
  const { startId, endId } = options;
  if (!startId || !endId) return fail('地図上の駅をクリックして起点と終点を選択してください。');
  if (startId === endId) return fail('起点と終点には別の駅を選択してください。');
  const start = state.stations.find(s => s.id === startId), end = state.stations.find(s => s.id === endId);
  if (!start || !end) return fail('選択した駅が見つかりません。');
  const cars = Number(options.cars ?? 1), fleet = Number(options.fleet ?? 1);
  if (!Number.isInteger(cars) || cars < 1 || cars > 20) return fail('車両両数は1〜20両で指定してください。');
  if (!Number.isInteger(fleet) || fleet < 1 || fleet > 99) return fail('投入編成数は1〜99編成で指定してください。');
  const first = parseServiceTime(options.first ?? '06:00', false), lastInput = parseServiceTime(options.last ?? '24:00');
  if (first == null || lastInput == null) return fail('時刻はHH:MM形式で入力してください。終車は24時以降も指定できます。');
  let last = lastInput;
  if (last <= first) last += 24 * 60;
  if (last - first > 24 * 60) return fail('運行時間は24時間以内で指定してください。');
  const selection = normalizePlatformAssignments(state, options.platformAssignments);
  if (!selection.ok) return selection;
  const platformAssignments = selection.assignments;
  const path = findPath(state, startId, endId, { platforms: platformAssignments.forward });
  if (!path || path.length < 1) return fail(Object.keys(platformAssignments.forward).length ? '指定した往路の番線を通る経路がありません。番線の接続口・進行方向・停車駅を確認してください。' : '起点と終点が線路でつながっていません。');
  const backward = findPath(state, endId, startId, { platforms: platformAssignments.backward });
  if (!backward || backward.length < 1) return fail(Object.keys(platformAssignments.backward).length ? '指定した復路の番線を通る経路がありません。番線の接続口・進行方向・停車駅を確認してください。' : '復路を走行できません。複線のもう1本や渡線の接続を確認してください。');
  const allStationIds = [...new Set([...path.stationIds, ...backward.stationIds])];
  const stations = allStationIds.map(id => state.stations.find(s => s.id === id)).filter(Boolean);
  if (stations.some(s => s.cars < cars)) return fail('停車駅のホーム対応両数を超えています。');
  const oneWaySeconds = routeTravelSeconds(path, stations);
  if (oneWaySeconds == null) return fail('駅間距離が5m未満の区間があります。');
  const oneWayMinutes = oneWaySeconds / 60;
  const intervalMinutes = (oneWaySeconds + 300) * 2 / 60 / fleet;
  const purchaseCost = 0;
  const route = {
    id: uid('route'), name: String(options.name || `${start.name}〜${end.name}`).trim().slice(0, 48),
    color: COLORS[state.routes.length % COLORS.length], startId, endId, cars, fleet,
    first: options.first ?? '06:00', last: options.last ?? '24:00', firstMinute: first, lastMinute: last,
    oneWayMinutes, oneWaySeconds, intervalMinutes, intervalSeconds: intervalMinutes * 60, stationIds: allStationIds, points: path.points, backwardPoints: backward.points,
    trackIds: [...new Set([...path.trackIds, ...backward.trackIds])], length: path.length, purchaseCost,
    platformAssignments, selectedPlatforms: { forward: path.selectedPlatforms, backward: backward.selectedPlatforms },
    revenue: 0, cost: 0, passengers: 0, trips: 0, createdAt: state.time,
  };
  if (!route.name) route.name = `${start.name}〜${end.name}`;
  state.routes.push(route);
  return { ok: true, route, cost: purchaseCost };
}

function preserveRouteHistory(original, calculated) {
  return { ...calculated, id: original.id, color: original.color, revenue: original.revenue || 0, cost: original.cost || 0, passengers: original.passengers || 0, trips: original.trips || 0, createdAt: original.createdAt };
}

export function updateRoutePlatforms(state, id, platformAssignments) {
  const original = state.routes.find(route => route.id === id);
  if (!original) return fail('路線が見つかりません。');
  const scratch = { ...state, routes: [] }, calculated = createRoute(scratch, { ...original, platformAssignments });
  if (!calculated.ok) return calculated;
  const route = preserveRouteHistory(original, calculated.route);
  state.routes = state.routes.map(item => item.id === id ? route : item);
  return { ok: true, route, cost: 0 };
}

export function updateStationWiring(state, id, options = {}) {
  const original = state.stations.find(station => station.id === id);
  if (!original) return fail('駅が見つかりません。');
  if (original.existing) return fail('共有利用する既設駅の配線は変更できません。');
  if (options.hostPlatformNumber !== undefined && (original.hostPlatformSelection !== 'explicit' || Number(options.hostPlatformNumber) !== original.hostPlatformNumber)) return fail('元の線路に合わせる番線は、駅の設置時に選択してください。設置済みのホスト番線は変更できません。');
  const wiringMode = options.wiringMode || original.wiringMode || 'merged';
  let station = { ...original, wiringMode, portGeometry: options.portGeometry ?? original.portGeometry ?? 'straight', trackConfigs: options.trackConfigs ?? (wiringMode === (original.wiringMode || 'merged') ? original.trackConfigs : undefined) };
  const error = stationWiringError(station); if (error) return fail(error);
  station.trackConfigs = getStationTrackConfigs(station);
  let geometry = stationGeometry(station), newCost;
  if (!station.standalone) {
    const lookup = { ...state, unlimited: true, stations: state.stations.filter(value => value.id !== id), tracks: state.tracks.filter(track => track.stationId !== id) };
    const host = lookup.tracks.find(track => track.id === original.trackId);
    const legacySingleOnDouble = !original.existingTrack && host?.type === 'double' && getStationLayout(original.layoutId).tracks === 1;
    const preview = previewStation(lookup, original, original.cars, { placement: 'track', ...(legacySingleOnDouble ? {} : { layoutId: original.layoutId }), bearing: original.bearing, wiringMode, trackConfigs: station.trackConfigs, portGeometry: station.portGeometry, ...(original.hostPlatformSelection === 'explicit' ? { hostPlatformNumber: original.hostPlatformNumber } : {}), ...(original.existingTrack ? { existingTrackId: original.trackId } : { ownedTrackId: original.trackId }) });
    if (!preview.ok) return preview;
    const hostFields = ['bearing', 'offset', 'segmentIndex', 'hostTrackCount', 'connectionPoints', 'hostTrackPoints', 'hostPlatformPoints', 'hostPlatformNumber', 'hostPlatformSelection', 'existingHostConnections'];
    for (const field of hostFields) if (preview[field] !== undefined) station[field] = preview[field];
    geometry = preview.geometry; newCost = preview.costBreakdown;
  }
  const hostError = stationHostWiringError(station); if (hostError) return fail(hostError);
  for (const other of state.stations) if (other.id !== id && !other.existing && footprintsOverlap(geometry.footprint, stationGeometry(other).footprint)) return fail('変更後の構内線路がほかの駅と重なります。');
  const oldGeometry = stationGeometry(original);
  for (const track of state.tracks) if (track.stationId !== id) for (const endpoint of [track.points[0], track.points.at(-1)]) {
    if (oldGeometry.connections.some(point => distance(endpoint, point) <= .25) && !geometry.connections.some(point => distance(endpoint, point) <= .25)) return fail('変更する接続口には駅の外側の線路がつながっています。先にその線路の接続を変更または削除してください。');
  }
  const oldCost = stationCostBreakdown(original.cars, { ...original, placement: original.standalone ? 'free' : 'track', ...(!original.standalone ? { geometry: oldGeometry } : {}) });
  if (!original.standalone) oldCost.tracks = Math.round(state.tracks.filter(track => track.stationTrack && track.stationId === id).reduce((sum, track) => sum + lineLength(track.points), 0) * 2_500_000);
  newCost ||= stationCostBreakdown(station.cars, { ...station, placement: 'free' });
  const cost = Math.max(0, newCost.tracks - oldCost.tracks);
  if (!state.unlimited && state.money < cost) return fail('配線変更の工事資金が不足しています。');
  station.cost = (original.cost || 0) + cost;
  const tracks = state.tracks.map(track => {
    if (!track.stationTrack || track.stationId !== id) return track;
    const index = track.platformIndex, config = station.trackConfigs[index];
    const { stationWiring, stationDirection, stationPorts, existingHostConnections, ...base } = track;
    const points = geometry.trackPaths[index];
    return { ...base, points, length: lineLength(points), ...(wiringMode === 'platforms' ? { stationWiring: true, stationDirection: config.direction, stationPorts: { a: config.a !== 'buffer', b: config.b !== 'buffer' } } : {}), ...(!station.standalone && wiringMode === 'platforms' ? { existingHostConnections: null } : station.existingTrack && station.existingHostConnections?.length === 2 ? { existingHostConnections: station.existingHostConnections.map(connection => ({ ...connection })) } : {}) };
  });
  const scratch = { ...state, tracks, stations: state.stations.map(s => s.id === id ? station : s), routes: [] }, routes = [];
  for (const originalRoute of state.routes) {
    const calculated = createRoute(scratch, originalRoute);
    if (!calculated.ok) return fail(`配線を変更すると路線「${originalRoute.name}」が走行できません。使用番線と駅の外側の接続を見直してください。${calculated.error}`);
    routes.push(preserveRouteHistory(originalRoute, calculated.route));
  }
  state.tracks = tracks; state.stations = scratch.stations; state.routes = routes;
  if (!state.unlimited) state.money -= cost;
  state.stats.construction = (state.stats.construction || 0) + cost;
  return { ok: true, station, cost, costBreakdown: newCost };
}

export function deleteRoute(state, id) {
  const route = state.routes.find(r => r.id === id);
  if (!route) return fail('路線が見つかりません。');
  state.routes = state.routes.filter(r => r.id !== id);
  return { ok: true, route };
}

function departuresBetween(route, from, to) {
  const firstSeconds = route.firstMinute * 60, lastSeconds = route.lastMinute * 60;
  const interval = Math.max(1, route.intervalMinutes * 60);
  let count = 0;
  for (let day = Math.floor(from / 1000 / DAY) - 1; day <= Math.floor(to / 1000 / DAY); day++) {
    const base = day * DAY;
    const lo = from / 1000 - base;
    const hi = Math.min(lastSeconds, to / 1000 - base);
    if (hi < Math.max(firstSeconds, lo)) continue;
    const firstIndex = Math.max(0, Math.floor((lo - firstSeconds) / interval) + 1);
    const lastIndex = Math.floor((hi - firstSeconds) / interval);
    count += Math.max(0, lastIndex - firstIndex + 1);
  }
  return count;
}

export function tick(state, seconds) {
  seconds = Number(seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return { revenue: 0, cost: 0, passengers: 0 };
  seconds = Math.min(seconds, DAY * 366);
  const from = state.time, to = from + seconds * 1000;
  let revenue = 0, cost = 0, passengers = 0;
  const annualInfrastructure = state.tracks.reduce((sum, track) => sum + lineLength(track.points) / 1000 * 20_000_000 * (['double', 'scissors'].includes(track.type) ? 1 : .5), 0)
    + state.stations.reduce((sum, station) => sum + (station.existing ? 0 : (3_000_000 + station.cars * 300_000) * getStationLayout(station.layoutId).platforms), 0);
  cost += annualInfrastructure * seconds / (365 * DAY);
  for (const route of state.routes) {
    const serviceHours = (route.lastMinute - route.firstMinute) / 60 + .5;
    const dailyFixedCost = route.cars * route.fleet * 8_000 + (3505 + 2910) * 1.3 * route.fleet * serviceHours;
    const routeFixedCost = dailyFixedCost * seconds / DAY;
    route.cost = (route.cost || 0) + routeFixedCost;
    cost += routeFixedCost;
    const count = departuresBetween(route, Math.max(from, route.createdAt || from), to);
    if (!count) continue;
    const catchments = route.stationIds.map(id => state.stations.find(s => s.id === id)?.population || 2500);
    let dailyDemand = 0;
    for (let i = 0; i < catchments.length; i++) for (let j = i + 1; j < catchments.length; j++) dailyDemand += Math.sqrt(catchments[i] * catchments[j]) * .08 / (1 + route.length / 30000);
    const departuresPerDay = Math.max(1, Math.floor((route.lastMinute - route.firstMinute) / route.intervalMinutes) + 1);
    const serviceAttraction = Math.min(1, 20 / route.intervalMinutes);
    const riders = Math.max(1, Math.round(Math.min(route.cars * 140, dailyDemand / departuresPerDay * serviceAttraction)));
    const fare = 150 + Math.ceil(route.length / 1000) * 20;
    const tripRevenue = riders * fare * 2;
    const tripCost = route.length / 1000 * 50 * route.cars * 2;
    route.revenue = (route.revenue || 0) + tripRevenue * count;
    route.cost = (route.cost || 0) + tripCost * count;
    route.passengers = (route.passengers || 0) + riders * count * 2;
    route.trips = (route.trips || 0) + count * 2;
    revenue += tripRevenue * count; cost += tripCost * count; passengers += riders * count * 2;
    const stationShare = riders * count * 2 / Math.max(1, route.stationIds.length);
    for (const id of route.stationIds) {
      const station = state.stations.find(s => s.id === id);
      if (station) station.passengers = (station.passengers || 0) + stationShare;
    }
  }
  state.time = to;
  if (!state.unlimited) state.money += revenue - cost;
  state.stats.revenue += revenue; state.stats.cost += cost; state.stats.passengers += passengers;
  return { revenue, cost, passengers };
}

export function formatMoney(value) {
  return `¥${Math.round(Number(value) || 0).toLocaleString('ja-JP')}`;
}

export function formatDate(ms) {
  const date = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function serializeGame(state) {
  return JSON.stringify({ ...state, version: 1 });
}

function restoreStationDraft(draft, state) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || !validPoint(draft.point)) return null;
  const order = Number.isInteger(draft.orderIndex) && draft.orderIndex >= 0 && draft.orderIndex <= 200 ? { orderIndex: draft.orderIndex } : {};
  if (draft.kind === 'existing') {
    if (typeof draft.sourceStationId !== 'string' || !draft.sourceStationId.trim() || draft.sourceStationId.length > 256) return null;
    return { kind: 'existing', point: copyPoint(draft.point), sourceStationId: draft.sourceStationId, ...order };
  }
  if (draft.kind !== 'new' || !finite(draft.cars) || !Number.isInteger(Number(draft.cars)) || Number(draft.cars) < 1 || Number(draft.cars) > 20) return null;
  const input = draft.options;
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['free', 'track'].includes(input.placement) || !STATION_LAYOUTS.some(layout => layout.id === input.layoutId)) return null;
  if (input.bearing !== undefined && !finite(input.bearing)) return null;
  if (input.wiringMode !== undefined && !['merged', 'platforms'].includes(input.wiringMode)) return null;
  const options = {
    placement: input.placement, layoutId: input.layoutId,
    bearing: ((Number(input.bearing) || 0) % 360 + 360) % 360,
    wiringMode: input.wiringMode ?? 'merged',
  };
  if (stationWiringError({ ...input, ...options }, options.placement === 'free')) return null;
  options.trackConfigs = getStationTrackConfigs({ ...input, ...options });
  const hostFields = ['existingTrackId', 'ownedTrackId', 'draftTrackId'].filter(field => input[field] !== undefined);
  if (hostFields.length > 1 || (hostFields.length && options.placement !== 'track')) return null;
  for (const field of hostFields) {
    const id = input[field];
    if (field === 'existingTrackId' ? typeof id !== 'string' || !/^existing:\S+$/.test(id) || id.length > 256 : !validDraftId(id) || (field === 'ownedTrackId' && id.startsWith('existing:'))) return null;
    options[field] = id;
  }
  if (input.hostPlatformNumber !== undefined) {
    const host = options.draftTrackId ? [...(state?.trackDrafts || []), ...(state?.trackDraft ? [state.trackDraft] : [])].find(stroke => stroke.id === options.draftTrackId) : options.ownedTrackId ? state?.tracks.find(track => track.id === options.ownedTrackId) : options.placement === 'track' && !options.existingTrackId ? nearestTrack(state, draft.point, { mainOnly: true })?.track : null;
    const hostTrackCount = options.placement === 'track' ? Math.min(getStationLayout(options.layoutId).tracks, host?.type === 'double' ? 2 : 1) : 0;
    if (stationHostSelectionError({ ...options, hostTrackCount, standalone: options.placement === 'free', hostPlatformNumber: input.hostPlatformNumber, hostPlatformSelection: 'explicit' })) return null;
    options.hostPlatformNumber = Number(input.hostPlatformNumber);
  }
  return { kind: 'new', point: copyPoint(draft.point), cars: Number(draft.cars), options, ...order };
}

export function deserializeGame(input) {
  let raw;
  try { raw = typeof input === 'string' ? JSON.parse(input) : input; }
  catch { throw new Error('セーブデータのJSON形式が正しくありません。'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.tracks) || !Array.isArray(raw.stations) || !Array.isArray(raw.routes)) throw new Error('Railway Canvasのセーブデータではありません。');
  if (raw.tracks.length > 20_000 || raw.stations.length > 10_000 || raw.routes.length > 5_000) throw new Error('セーブデータのサイズが大きすぎます。');
  if (!finite(raw.money) || !finite(raw.time) || !Number.isFinite(new Date(Number(raw.time)).getTime())) throw new Error('資金または日時のデータが正しくありません。');
  const state = createGame();
  state.money = Number(raw.money); state.time = Number(raw.time); state.unlimited = !!raw.unlimited;
  state.speed = clamp(Number(raw.speed) || 0, 0, 86_400);
  const trackIds = new Set();
  state.tracks = raw.tracks.map(track => {
    if (!track || typeof track.id !== 'string' || trackIds.has(track.id) || !['single', 'double', 'crossover', 'scissors'].includes(track.type) || !Array.isArray(track.points) || track.points.length < 2 || track.points.length > 100_000 || !track.points.every(validPoint)) throw new Error('線路データが正しくありません。');
    trackIds.add(track.id);
    const connections = Array.isArray(track.connections) && track.connections.length === 2
      ? track.connections.map(connection => ({ trackId: String(connection.trackId || ''), side: connection.side === -1 ? -1 : 1, offset: Math.max(0, Number(connection.offset) || 0) })) : null;
    const controls = Array.isArray(track.controlPoints) && track.controlPoints.length >= 2 && track.controlPoints.length <= 10_000 && Array.from(track.controlPoints).every(validPoint) ? track.controlPoints.map(copyPoint) : null;
    const metadata = controls ? curveMetadata(controls, track) : null;
    return { id: track.id, type: track.type, points: track.points.map(copyPoint), length: lineLength(track.points), cost: Number(track.cost) || 0, hostTrackId: typeof track.hostTrackId === 'string' ? track.hostTrackId : null, connections,
      ...(metadata && (metadata.curveMode || metadata.handles) ? { ...metadata, controlPoints: controls } : {}),
      ...(track.stationTrack === true && typeof track.stationId === 'string' ? { stationTrack: true, stationId: track.stationId, platformIndex: clamp(Math.round(Number(track.platformIndex) || 0), 0, 7) } : {}) };
  });
  const stationIds = new Set();
  state.stations = raw.stations.map(station => {
    const shared = station?.existing === true && typeof station.sourceStationId === 'string' && !!station.sourceStationId && typeof station.trackId === 'string' && station.trackId.startsWith('existing:');
    const paidExisting = station?.existingTrack === true && station.existing !== true && typeof station.trackId === 'string' && /^existing:\S+$/.test(station.trackId);
    if (!station || typeof station.id !== 'string' || stationIds.has(station.id) || !validPoint(station) || (!trackIds.has(station.trackId) && !shared && !paidExisting)) throw new Error('駅データが正しくありません。');
    stationIds.add(station.id);
    const hit = nearestTrack(state, station, { mainOnly: true });
    const cars = clamp(Math.round(Number(station.cars) || 1), 1, 20);
    const layout = getStationLayout(station.layoutId);
    const host = state.tracks.find(track => track.id === station.trackId);
    const hostTrackCount = paidExisting ? 1 : station.standalone === true ? 0 : Math.min(layout.tracks, host?.type === 'double' ? 2 : 1);
    if (station.hostPlatformSelection != null && !['auto', 'explicit'].includes(station.hostPlatformSelection)) throw new Error('駅のホスト番線の選択方式が正しくありません。');
    const hostPlatformSelection = station.hostPlatformSelection === 'explicit' ? 'explicit' : 'auto';
    const selectedHost = { ...station, hostTrackCount, hostPlatformSelection };
    const selectionError = stationHostSelectionError(selectedHost); if (selectionError) throw new Error(selectionError);
    const from = hit?.track.points[hit.segmentIndex], to = hit?.track.points[hit.segmentIndex + 1];
    const inferredBearing = from && to ? Math.atan2(to.lat - from.lat, (to.lng - from.lng) * Math.cos(station.lat * RAD)) / RAD : 0;
    const bearing = finite(station.bearing) ? ((Number(station.bearing) % 360) + 360) % 360 : inferredBearing;
    const platformTrackIds = [...new Set([station.trackId, ...(Array.isArray(station.platformTrackIds) ? station.platformTrackIds.filter(id => trackIds.has(id)) : [])])];
    const wiringError = stationWiringError(station, station.standalone === true);
    if (wiringError) throw new Error(wiringError);
    const hostTrackPoints = !station.standalone && !shared && Array.isArray(station.hostTrackPoints) && station.hostTrackPoints.length >= 2 && station.hostTrackPoints.length <= 10_000 && Array.from(station.hostTrackPoints).every(validPoint) ? station.hostTrackPoints.map(copyPoint) : null;
    const hostPlatformPoints = !station.standalone && !shared && Array.isArray(station.hostPlatformPoints) && station.hostPlatformPoints.length === 2 && station.hostPlatformPoints.every(validPoint) ? station.hostPlatformPoints.map(copyPoint) : null;
    const existingHostConnections = paidExisting && Array.isArray(station.existingHostConnections) && station.existingHostConnections.length === 2 && station.existingHostConnections.every(connection => connection && typeof connection.trackId === 'string' && /^existing:\S+$/.test(connection.trackId) && finite(connection.offset) && Number(connection.offset) >= 0) ? station.existingHostConnections.map(connection => ({ trackId: connection.trackId, offset: Number(connection.offset) })) : null;
    if (paidExisting && layout.tracks > 1 && (!hostTrackPoints || !hostPlatformPoints || !existingHostConnections)) throw new Error('既設線上の駅の構内線路データが正しくありません。');
    return { id: station.id, name: String(station.name || '新駅').slice(0, 48), ...copyPoint(station), cars, trackId: station.trackId, offset: finite(station.offset) ? Number(station.offset) : hit?.offset || 0, segmentIndex: Number(station.segmentIndex) || 0, side: station.side === -1 ? -1 : 1, platformLength: cars * 20, cost: Number(station.cost) || 0, passengers: Math.max(0, Number(station.passengers) || 0), demand: Math.max(.1, Number(station.demand) || 1), population: Math.max(0, Number(station.population) || 0),
      layoutId: layout.id, bearing, standalone: station.standalone === true, hostTrackCount, platformTrackIds,
      ...(!station.standalone && !shared ? { hostPlatformSelection, hostPlatformNumber: stationGeometry(selectedHost).hostSlotIndices[0] + 1 } : {}),
      wiringMode: station.wiringMode === 'platforms' ? 'platforms' : 'merged', portGeometry: station.portGeometry || (station.wiringMode === 'platforms' ? 'spread' : 'straight'), trackConfigs: getStationTrackConfigs(station),
      ...(Array.isArray(station.connectionPoints) && station.connectionPoints.length === 2 && station.connectionPoints.every(validPoint) ? { connectionPoints: station.connectionPoints.map(copyPoint) } : {}),
      ...(paidExisting ? { existingTrack: true } : {}),
      ...(hostTrackPoints ? { hostTrackPoints, hostPlatformPoints: hostPlatformPoints || [copyPoint(hostTrackPoints[0]), copyPoint(hostTrackPoints.at(-1))], ...(existingHostConnections ? { existingHostConnections } : {}) } : {}),
      ...(shared ? { existing: true, sourceStationId: station.sourceStationId } : {}) };
  });
  for (const station of state.stations) {
    const hostError = stationHostWiringError(station); if (hostError) throw new Error(hostError);
  }
  for (const track of state.tracks) if (track.stationTrack) {
    const station = state.stations.find(s => s.id === track.stationId);
    if (station && !station.standalone && station.wiringMode === 'platforms') track.existingHostConnections = null;
    else if (station?.existingTrack && station.existingHostConnections?.length === 2) track.existingHostConnections = station.existingHostConnections.map(connection => ({ ...connection }));
    if (station?.wiringMode === 'platforms') {
      const config = station.trackConfigs[track.platformIndex];
      if (!config) throw new Error('構内線路の番線が正しくありません。');
      Object.assign(track, { stationWiring: true, stationDirection: config.direction, stationPorts: { a: config.a !== 'buffer', b: config.b !== 'buffer' } });
    }
  }
  const routeIds = new Set();
  state.routes = raw.routes.map(route => {
    if (!route || typeof route.id !== 'string' || routeIds.has(route.id) || !stationIds.has(route.startId) || !stationIds.has(route.endId) || !Array.isArray(route.points) || !route.points.every(validPoint)) throw new Error('路線データが正しくありません。');
    const first = parseServiceTime(route.first, false), lastInput = parseServiceTime(route.last);
    if (first == null || lastInput == null) throw new Error('ダイヤの時刻が正しくありません。');
    routeIds.add(route.id);
    const oneWayMinutes = Math.max(1 / 60, Number(route.oneWayMinutes) || 1), intervalMinutes = Math.max(1 / 60, Number(route.intervalMinutes) || 1);
    const selection = normalizePlatformAssignments(state, route.platformAssignments), actualSelection = normalizePlatformAssignments(state, route.selectedPlatforms);
    if (!selection.ok || !actualSelection.ok) throw new Error('路線の使用番線データが正しくありません。');
    return { id: route.id, name: String(route.name || '路線').slice(0, 48), color: /^#[a-f\d]{6}$/i.test(route.color) ? route.color : COLORS[routeIds.size % COLORS.length], startId: route.startId, endId: route.endId, cars: clamp(Math.round(Number(route.cars) || 1), 1, 20), fleet: clamp(Math.round(Number(route.fleet) || 1), 1, 99), first: route.first, last: route.last, firstMinute: first, lastMinute: lastInput <= first ? lastInput + 1440 : lastInput, oneWayMinutes, oneWaySeconds: oneWayMinutes * 60, intervalMinutes, intervalSeconds: intervalMinutes * 60, stationIds: Array.isArray(route.stationIds) ? route.stationIds.filter(id => stationIds.has(id)) : [route.startId, route.endId], points: route.points.map(copyPoint), backwardPoints: Array.isArray(route.backwardPoints) && route.backwardPoints.every(validPoint) ? route.backwardPoints.map(copyPoint) : route.points.map(copyPoint).reverse(), trackIds: Array.isArray(route.trackIds) ? route.trackIds.filter(id => trackIds.has(id) || (typeof id === 'string' && id.startsWith('existing:'))) : [], length: lineLength(route.points), platformAssignments: selection.assignments, selectedPlatforms: actualSelection.assignments, purchaseCost: 0, revenue: Math.max(0, Number(route.revenue) || 0), cost: Math.max(0, Number(route.cost) || 0), passengers: Math.max(0, Number(route.passengers) || 0), trips: Math.max(0, Number(route.trips) || 0), createdAt: finite(route.createdAt) ? Number(route.createdAt) : state.time };
  });
  if (validPoint(raw.view)) state.view = { ...copyPoint(raw.view), zoom: clamp(Number(raw.view.zoom) || 9, 4, 22) };
  if (['standard', 'satellite', 'blank', 'relief'].includes(raw.layer)) state.layer = raw.layer;
  state.populationVisible = raw.populationVisible === true;
  const draft = raw.trackDraft;
  if (draft && typeof draft === 'object' && !Array.isArray(draft) && ['single', 'double', 'crossover', 'scissors'].includes(draft.type) && Array.isArray(draft.points) && draft.points.length >= 1 && draft.points.length <= 10_000 && Array.from(draft.points).every(validPoint) && typeof draft.paused === 'boolean') {
    const metadata = curveMetadata(draft.points, draft);
    if (metadata && (draft.id === undefined || validDraftId(draft.id))) state.trackDraft = { type: draft.type, points: draft.points.map(copyPoint), paused: draft.paused, ...metadata, ...(draft.id !== undefined ? { id: draft.id } : {}), ...(Number.isInteger(draft.orderIndex) && draft.orderIndex >= 0 && draft.orderIndex <= 200 ? { orderIndex: draft.orderIndex } : {}) };
  }
  let archivedPointCount = 0; const draftIds = new Set();
  if (Array.isArray(raw.trackDrafts)) for (const stroke of raw.trackDrafts.slice(0, 200)) {
    if (!stroke || !['single', 'double', 'crossover', 'scissors'].includes(stroke.type) || !Array.isArray(stroke.points) || stroke.points.length < 1 || archivedPointCount + stroke.points.length > 10_000 || !Array.from(stroke.points).every(validPoint)) continue;
    if (stroke.id !== undefined && (!validDraftId(stroke.id) || draftIds.has(stroke.id))) continue;
    const metadata = curveMetadata(stroke.points, stroke); if (!metadata) continue;
    archivedPointCount += stroke.points.length;
    if (stroke.id !== undefined) draftIds.add(stroke.id);
    state.trackDrafts.push({ type: stroke.type, points: stroke.points.map(copyPoint), ...metadata, ...(stroke.id !== undefined ? { id: stroke.id } : {}) });
  }
  if (state.trackDraft?.id !== undefined && draftIds.has(state.trackDraft.id)) state.trackDraft = null;
  if (Array.isArray(raw.stationDrafts)) for (const draft of raw.stationDrafts.slice(0, 200)) {
    const normalized = restoreStationDraft(draft, state); if (normalized) state.stationDrafts.push(normalized);
  }
  state.stationDraft = restoreStationDraft(raw.stationDraft, state);
  if (raw.stats && typeof raw.stats === 'object') {
    for (const key of ['revenue', 'cost', 'passengers', 'construction']) state.stats[key] = Math.max(0, Number(raw.stats[key]) || 0);
  }
  return state;
}
