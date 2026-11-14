import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as E from '../dist/engine.js';
import { ExistingRailwayNetwork } from '../dist/existing-network.js';

const a = { lat: 35.68, lng: 139.74 };
const b = { lat: 35.68, lng: 139.76 };
const p = ratio => ({ lat: a.lat, lng: a.lng + (b.lng - a.lng) * ratio });
function line(type = 'double') {
  const state = E.createGame();
  const result = E.buildTrack(state, [a, b], type);
  assert.equal(result.ok, true, result.error);
  return state;
}
function routeGame(type = 'double') {
  const state = line(type);
  const from = E.buildStation(state, p(.1), 5, '始発駅');
  const mid = E.buildStation(state, p(.5), 5, '中間駅');
  const to = E.buildStation(state, p(.9), 5, '終着駅');
  assert.equal(from.ok, true, from.error); assert.equal(mid.ok, true, mid.error); assert.equal(to.ok, true, to.error);
  return { state, startId: from.station.id, endId: to.station.id, midId: mid.station.id };
}

test('initial money and calendar follow the original game', () => {
  const state = E.createGame();
  assert.equal(state.money, 100_000_000_000);
  assert.equal(E.formatDate(state.time), '2026/01/01 06:00:00');
  assert.equal(state.speed, 0);
});

test('construction costs use ¥5bn/km double and ¥2.5bn/km single', () => {
  const double = E.estimateTrackCost([a, b], 'double');
  const single = E.estimateTrackCost([a, b], 'single');
  assert.equal(double.trackCost, Math.round(E.distance(a, b) * 5_000_000));
  assert.equal(single.trackCost, Math.round(E.distance(a, b) * 2_500_000));
  assert.ok(double.landCost > 0);
  const state = E.createGame(), before = state.money;
  const result = E.buildTrack(state, [a, b], 'double');
  assert.equal(state.money, before - result.cost.total);
});

test('funds failure never mutates the world; unlimited construction records costs', () => {
  const state = E.createGame(); state.money = 1;
  assert.equal(E.buildTrack(state, [a, b]).ok, false);
  assert.equal(state.tracks.length, 0); assert.equal(state.money, 1);
  state.unlimited = true;
  assert.equal(E.buildTrack(state, [a, b]).ok, true);
  assert.equal(state.money, 1); assert.ok(state.stats.construction > 0);
});

test('tangent-continuous circular plans and minimum curve radius', () => {
  const plan = E.planTrackPoints([a, b, { lat: 35.69, lng: 139.77 }]);
  assert.equal(plan.ok, true, plan.error); assert.ok(plan.points.length > 5);
  const state = E.createGame();
  const built = E.buildTrack(state, plan.points, 'double');
  assert.equal(built.ok, true, built.error);
  assert.equal(built.track.points.length, plan.points.length);
  const tight = E.planTrackPoints([a, { lat: a.lat, lng: a.lng + .0001 }, { lat: a.lat + .00001, lng: a.lng + .0001 }]);
  assert.equal(tight.ok, false);
});

test('construction rejects disconnected crossings and overlapping tracks', () => {
  const state = line();
  assert.equal(E.buildTrack(state, [{ lat: 35.675, lng: 139.75 }, { lat: 35.685, lng: 139.75 }], 'single').ok, false);
  assert.equal(E.buildTrack(state, [a, b], 'double').ok, false);
  assert.equal(state.tracks.length, 1);
});

test('crossovers use smooth S curves between physical double-track lanes', () => {
  const state = line();
  const plan = E.planTrackPoints([p(.2), p(.4)], 'crossover', state);
  assert.equal(plan.ok, true, plan.error);
  assert.ok(plan.points.length >= 17);
  assert.ok(plan.points[0].lat > a.lat);
  assert.ok(plan.points.at(-1).lat < a.lat);
  const firstDirection = Math.abs((plan.points[1].lat - plan.points[0].lat) / (plan.points[1].lng - plan.points[0].lng));
  assert.ok(firstDirection < .01, 'the S curve is tangent to the host track');
  const built = E.buildTrack(state, plan.points, 'crossover');
  assert.equal(built.ok, true, built.error);
  assert.equal(built.track.connections[0].side, 1);
  assert.equal(built.track.connections[1].side, -1);
  assert.equal(E.buildStation(state, p(.3), 1).station.trackId, state.tracks[0].id, 'a station snaps to its main line, never the crossover');
  assert.equal(E.buildTrack(state, [p(.6), p(.8)], 'scissors').ok, true);
  const restored = E.deserializeGame(E.serializeGame(state));
  assert.deepEqual(restored.tracks[1].connections, state.tracks[1].connections);
});

test('platform length, endpoint clearance, overlap and station cost are enforced', () => {
  const state = line();
  assert.equal(E.estimateStationCost(1), 180_000_000);
  assert.equal(E.estimateStationCost(20), 1_700_000_000);
  assert.equal(E.buildStation(state, a, 1).ok, false);
  const built = E.buildStation(state, p(.5), 10);
  assert.equal(built.ok, true, built.error);
  assert.equal(E.buildStation(state, p(.51), 10).ok, false);
  assert.equal(E.buildStation(state, { lat: 35.70, lng: 139.75 }, 1).ok, false);
});

test('station preview shares construction validation and never changes game state', () => {
  const state = line();
  const before = E.serializeGame(state);
  const valid = E.previewStation(state, p(.5), 5);
  assert.equal(valid.ok, true, valid.error);
  assert.equal(valid.cost, E.estimateStationCost(5));
  assert.equal(valid.platformLength, 100);
  assert.equal(valid.track.id, state.tracks[0].id);
  assert.equal(E.serializeGame(state), before);
  const invalid = E.previewStation(state, a, 5);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /はみ出/);
  assert.ok(invalid.point);
  assert.equal(invalid.track.id, state.tracks[0].id);
  assert.equal(E.serializeGame(state), before);
  assert.equal(E.buildStation(state, a, 5).error, invalid.error);
  assert.equal(E.serializeGame(state), before);
  const built = E.buildStation(state, p(.5), 5);
  assert.equal(built.ok, true, built.error);
  assert.deepEqual({ lat: built.station.lat, lng: built.station.lng }, valid.point);
  assert.equal(built.cost, valid.cost);
  assert.equal(E.previewStation(state, p(.5), 5).ok, false, 'overlap is visible before clicking');
  state.money = 0;
  const noFunds = E.previewStation(state, p(.8), 1);
  assert.equal(noFunds.ok, false); assert.match(noFunds.error, /資金/);
});

for (const type of ['single', 'double']) test(`connected ${type} route finds both directions and intermediate stops`, () => {
  const { state, startId, endId, midId } = routeGame(type);
  const before = state.money;
  const result = E.createRoute(state, { startId, endId, cars: 5, fleet: 2, first: '06:00', last: '24:00', name: 'テスト線' });
  assert.equal(result.ok, true, result.error);
  assert.equal(state.money, before, 'the original game has no vehicle purchase cost');
  assert.deepEqual(result.route.stationIds, [startId, midId, endId]);
  assert.ok(result.route.oneWayMinutes > 0);
  assert.equal(result.route.intervalMinutes, (result.route.oneWaySeconds + 300) * 2 / 60 / 2);
  assert.ok(result.route.backwardPoints.length >= 2);
});

test('route validates rolling stock, platform capacity, endpoints and timetable', () => {
  const { state, startId, endId } = routeGame();
  const options = { startId, endId, cars: 5, fleet: 1, first: '06:00', last: '24:00' };
  assert.equal(E.createRoute(state, { ...options, cars: 6 }).ok, false);
  assert.equal(E.createRoute(state, { ...options, fleet: 100 }).ok, false);
  assert.equal(E.createRoute(state, { ...options, endId: startId }).ok, false);
  assert.equal(E.createRoute(state, { ...options, last: '30:00' }).ok, false);
  assert.equal(E.createRoute(state, { ...options, last: '05:00' }).ok, true);
});

test('single-to-new-double connection needs a physical return connection', () => {
  const state = line('single');
  const extension = E.buildTrack(state, [b, { lat: 35.69, lng: 139.77 }], 'double');
  assert.equal(extension.ok, true, extension.error);
  const from = E.buildStation(state, p(.25), 1);
  const to = E.buildStation(state, { lat: 35.685, lng: 139.765 }, 1);
  assert.equal(from.ok, true, from.error); assert.equal(to.ok, true, to.error);
  const route = E.createRoute(state, { startId: from.station.id, endId: to.station.id });
  assert.equal(route.ok, false);
  assert.match(route.error, /復路|つながって/);
});

test('maintenance is charged while stopped; timetable earns fares and charges operating costs', () => {
  const { state, startId, endId } = routeGame();
  const before = state.money;
  const result = E.tick(state, 60);
  assert.equal(result.revenue, 0); assert.ok(result.cost > 0); assert.ok(state.money < before);
  const route = E.createRoute(state, { startId, endId, cars: 2, fleet: 2 });
  assert.equal(route.ok, true, route.error);
  const earnings = E.tick(state, 3600);
  assert.ok(earnings.revenue > 0); assert.ok(earnings.passengers > 0); assert.ok(earnings.cost > 0);
  assert.equal(E.formatDate(state.time), '2026/01/01 07:01:00');
  state.unlimited = true;
  const money = state.money;
  E.tick(state, 3600);
  assert.equal(state.money, money);
});

test('the first train and overnight service are counted when crossing departure times', () => {
  const { state, startId, endId } = routeGame();
  state.time -= 3600 * 1000;
  assert.equal(E.createRoute(state, { startId, endId, first: '06:00', last: '25:00' }).ok, true);
  assert.equal(E.tick(state, 3599).revenue, 0);
  assert.ok(E.tick(state, 1).revenue > 0, 'the departure at 06:00 is included exactly once');
  assert.equal(E.tick(state, 1).revenue, 0);
  const before = state.routes[0].trips;
  E.tick(state, 19 * 3600);
  assert.ok(state.routes[0].trips > before);
});

test('deleting an endpoint removes dependent routes but does not refund construction', () => {
  const { state, startId, endId } = routeGame();
  E.createRoute(state, { startId, endId });
  const money = state.money;
  const result = E.deleteStation(state, startId);
  assert.equal(result.ok, true); assert.equal(state.routes.length, 0); assert.equal(state.money, money);
  assert.equal(E.renameStation(state, endId, '  新駅名  ').station.name, '新駅名');
});

test('save round-trip retains geometry, timetables, finances and map settings', () => {
  const { state, startId, endId } = routeGame();
  E.createRoute(state, { startId, endId, fleet: 4 });
  E.tick(state, 3600); state.layer = 'satellite'; state.speed = 120;
  const restored = E.deserializeGame(E.serializeGame(state));
  assert.equal(restored.money, state.money); assert.equal(restored.time, state.time);
  assert.deepEqual(restored.tracks[0].points, state.tracks[0].points);
  assert.equal(restored.routes[0].intervalMinutes, state.routes[0].intervalMinutes);
  assert.equal(restored.layer, 'satellite'); assert.equal(restored.speed, 120);
  assert.ok(E.findPath(restored, startId, endId));
  state.view.zoom = 22;
  assert.equal(E.deserializeGame(E.serializeGame(state)).view.zoom, 22);
});

test('malformed saves are rejected without evaluating their contents', () => {
  assert.throws(() => E.deserializeGame('{bad'), /JSON/);
  assert.throws(() => E.deserializeGame('{}'), /セーブデータ/);
  const state = line(); state.tracks[0].points[0].lat = Infinity;
  assert.throws(() => E.deserializeGame(E.serializeGame(state)), /線路データ/);
});

test('packaged 2026 land prices and WorldPop census decode and affect estimates', async () => {
  const originalFetch = globalThis.fetch;
  const before = E.estimateTrackCost([a, b], 'double').landCost;
  globalThis.fetch = async url => new Response(await readFile(url));
  try {
    const loaded = await E.loadEconomicData();
    assert.equal(loaded.landPrices, true);
    assert.equal(loaded.population, true);
    assert.ok(E.stationPopulation({ lat: 35.6812, lng: 139.7671 }) > 1000);
    assert.notEqual(E.estimateTrackCost([a, b], 'double').landCost, before);
  } finally { globalThis.fetch = originalFetch; }
});

function sharedNetwork() {
  const feature = (geometry, properties) => ({ type: 'Feature', geometry, properties });
  return new ExistingRailwayNetwork({ type: 'FeatureCollection', features: [
    feature({ type: 'LineString', coordinates: [[139.76, 35.68], [139.77, 35.681], [139.78, 35.68]] }, { type: 'rail' }),
    feature({ type: 'Point', coordinates: [139.77, 35.681] }, { type: 'station', id: 'shared-middle', name: '既設中間駅' }),
    feature({ type: 'Point', coordinates: [139.78, 35.68] }, { type: 'station', id: 'shared-end', name: '既設終点' }),
    feature({ type: 'LineString', coordinates: [[139.79, 35.675], [139.79, 35.685]] }, { type: 'rail' }),
    feature({ type: 'Point', coordinates: [139.79, 35.684] }, { type: 'station', id: 'isolated', name: '別線の駅' }),
  ] });
}

for (const type of ['single', 'double']) test(`a ${type} player branch runs into existing blue infrastructure in both directions`, () => {
  const network = sharedNetwork(); E.setExistingNetwork(network);
  try {
    const state = E.createGame(); state.money = 1_000_000_000_000_000;
    const track = E.buildTrack(state, [{ lat: 35.67, lng: 139.76 }, { lat: 35.68002, lng: 139.76 }], type);
    assert.equal(track.ok, true, track.error);
    const endpoint = track.track.points.at(-1);
    assert.ok(network.nearestTrack(endpoint, .1), 'the near endpoint snaps onto the blue railway');
    const start = E.buildStation(state, { lat: 35.675, lng: 139.76 }, 5, '自作駅');
    assert.equal(start.ok, true, start.error);
    const before = state.money;
    const middle = E.useExistingStation(state, network.getStation('shared-middle'));
    const end = E.useExistingStation(state, network.getStation('shared-end'));
    assert.equal(middle.ok, true, middle.error); assert.equal(end.ok, true, end.error);
    assert.equal(end.station.existing, true); assert.equal(end.station.cars, 20);
    assert.equal(state.money, before); assert.equal(state.tracks.length, 1, 'the national graph is not added to owned tracks');
    const repeated = E.useExistingStation(state, network.getStation('shared-end'));
    assert.equal(repeated.station, end.station); assert.equal(state.stations.length, 3);
    const route = E.createRoute(state, { startId: start.station.id, endId: end.station.id, cars: 5, fleet: 2 });
    assert.equal(route.ok, true, route.error);
    assert.deepEqual(route.route.stationIds, [start.station.id, middle.station.id, end.station.id]);
    assert.ok(route.route.points.some(point => E.distance(point, network.getStation('shared-middle')) < .1), 'the detailed curved shared geometry is retained');
    assert.ok(route.route.trackIds.some(id => id.startsWith('existing:')));
    assert.ok(route.route.backwardPoints.length > 2);
    const saved = E.serializeGame(state), restored = E.deserializeGame(saved);
    assert.equal(restored.stations.at(-1).sourceStationId, 'shared-end');
    assert.equal(restored.stations.at(-1).existing, true);
    assert.deepEqual(restored.routes[0].trackIds, route.route.trackIds);
    assert.deepEqual(E.findPath(restored, start.station.id, end.station.id).points, E.findPath(state, start.station.id, end.station.id).points);
    assert.equal(E.serializeGame(state), saved, 'routing never mutates owned infrastructure or savings');
    const isolated = E.useExistingStation(state, network.getStation('isolated'));
    assert.equal(E.createRoute(state, { startId: start.station.id, endId: isolated.station.id }).ok, false);
  } finally { E.setExistingNetwork(null); }
});

test('shared stations cost nothing to register or maintain, but their trains pay operating costs', () => {
  const network = sharedNetwork(); E.setExistingNetwork(network);
  try {
    const state = E.createGame(), before = state.money;
    const first = E.useExistingStation(state, network.getStation('shared-middle'));
    const last = E.useExistingStation(state, network.getStation('shared-end'));
    assert.equal(E.tick(state, 3600).cost, 0); assert.equal(state.money, before);
    assert.equal(E.createRoute(state, { startId: first.station.id, endId: last.station.id, cars: 20 }).ok, true);
    const result = E.tick(state, 3600);
    assert.ok(result.cost > 0); assert.ok(result.revenue > 0);
    assert.equal(state.tracks.length, 0);
  } finally { E.setExistingNetwork(null); }
});

test('the real national network routes between Tokyo and Shinjuku without importing its tracks', async () => {
  const data = JSON.parse(await readFile(new URL('../dist/data/railways.json', import.meta.url), 'utf8'));
  const network = new ExistingRailwayNetwork(data); E.setExistingNetwork(network);
  try {
    const tokyo = [...network.stationSources.values()].find(station => station.name === '東京');
    const shinjuku = [...network.stationSources.values()].find(station => station.name === '新宿');
    const state = E.createGame();
    const from = E.useExistingStation(state, network.getStation(tokyo.id));
    const to = E.useExistingStation(state, network.getStation(shinjuku.id));
    assert.equal(from.ok, true, from.error); assert.equal(to.ok, true, to.error);
    const result = E.createRoute(state, { startId: from.station.id, endId: to.station.id, cars: 10 });
    assert.equal(result.ok, true, result.error);
    assert.ok(result.route.length > 5000 && result.route.length < 25000, 'station anchors must not force a long detour around Tokyo');
    assert.ok(result.route.points.length > 30);
    assert.equal(state.tracks.length, 0);
  } finally { E.setExistingNetwork(null); }
});

function stationTestState() { const state = E.createGame(); state.money = 1_000_000_000_000_000; return state; }
function stationTestLine(type = 'double') {
  const state = stationTestState();
  const built = E.buildTrack(state, [a, b], type);
  assert.equal(built.ok, true, built.error);
  return state;
}

test('station presets define real track and platform footprints with matching construction estimates', () => {
  assert.equal(E.STATION_LAYOUTS.length, 8);
  for (const layout of E.STATION_LAYOUTS) {
    const station = { ...a, cars: 8, layoutId: layout.id, bearing: 0, standalone: true };
    const geometry = E.stationGeometry(station);
    assert.equal(geometry.trackPaths.length, layout.tracks);
    assert.equal(geometry.platforms.length, layout.platforms);
    assert.equal(geometry.connections.length, 2);
    assert.equal(geometry.platformLength, 160);
    assert.ok(geometry.trackPaths.every(path => path.length === 4));
    const breakdown = E.stationCostBreakdown(8, { layoutId: layout.id, placement: 'free' });
    assert.equal(breakdown.total, breakdown.base + breakdown.platforms + breakdown.tracks);
    assert.equal(E.estimateStationCost(8, { layoutId: layout.id, placement: 'free' }), breakdown.total);
  }
  const east = E.stationGeometry({ ...a, cars: 8, layoutId: 'island-4', standalone: true, bearing: 0 });
  const north = E.stationGeometry({ ...a, cars: 8, layoutId: 'island-4', standalone: true, bearing: 90 });
  assert.ok(Math.abs(east.connections[0].lat - east.connections[1].lat) < 1e-9);
  assert.ok(Math.abs(north.connections[0].lng - north.connections[1].lng) < 1e-9);
  assert.equal(E.getStationLayout('unknown').id, 'side-1');
});

for (const connectingType of ['single', 'double']) test(`stations placed before their ${connectingType} connection operate in both directions`, () => {
  E.setExistingNetwork(null);
  const state = stationTestState(), options = { layoutId: 'island-4', placement: 'free', bearing: 0 };
  const before = E.serializeGame(state), preview = E.previewStation(state, a, 8, options);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(E.serializeGame(state), before, 'a preview cannot reserve tracks or deduct money');
  const from = E.buildStation(state, a, 8, '先置き西駅', options), to = E.buildStation(state, b, 8, '先置き東駅', options);
  assert.equal(from.ok, true, from.error); assert.equal(to.ok, true, to.error);
  assert.equal(from.station.standalone, true);
  assert.equal(from.station.platformTrackIds.length, 4);
  assert.equal(state.tracks.filter(track => track.stationId === from.station.id && track.stationTrack).length, 4);
  assert.equal(from.cost, preview.cost);
  const unconnected = E.createRoute(state, { startId: from.station.id, endId: to.station.id, cars: 8 });
  assert.equal(unconnected.ok, false, 'separate stations have no invisible connection');
  const west = E.stationGeometry(from.station), east = E.stationGeometry(to.station);
  const connected = E.buildTrack(state, [west.connections[1], east.connections[0]], connectingType);
  assert.equal(connected.ok, true, connected.error);
  const route = E.createRoute(state, { startId: from.station.id, endId: to.station.id, cars: 8, fleet: 2 });
  assert.equal(route.ok, true, route.error);
  assert.deepEqual(route.route.stationIds, [from.station.id, to.station.id]);
  assert.ok(route.route.trackIds.includes(connected.track.id));
  assert.ok(route.route.trackIds.some(id => from.station.platformTrackIds.includes(id)));
  assert.ok(E.findPath(state, to.station.id, from.station.id));
  assert.ok(route.route.oneWayMinutes > 0);
});

test('a two-platform four-track station reuses a double main line and adds two functioning sidings', () => {
  const state = stationTestLine('double'), host = state.tracks[0];
  const options = { layoutId: 'island-4', placement: 'track' };
  const before = state.money, preview = E.previewStation(state, p(.5), 8, options);
  assert.equal(preview.ok, true, preview.error);
  const station = E.buildStation(state, p(.5), 8, '2面4線駅', options);
  assert.equal(station.ok, true, station.error);
  assert.equal(state.money, before - station.cost);
  assert.equal(station.station.hostTrackCount, 2);
  assert.equal(station.station.platformTrackIds.length, 3, 'one double main-line object plus two independent sidings');
  assert.equal(state.tracks.length, 3);
  assert.equal(state.tracks[0], host, 'the existing line is retained');
  assert.equal(state.tracks.filter(track => track.stationId === station.station.id).length, 2);
  assert.ok(E.stationGeometry(station.station).trackPaths.length === 4);
  const from = E.buildStation(state, p(.1), 1), to = E.buildStation(state, p(.9), 1);
  assert.equal(from.ok, true, from.error); assert.equal(to.ok, true, to.error);
  const route = E.createRoute(state, { startId: from.station.id, endId: to.station.id, cars: 1 });
  assert.equal(route.ok, true, route.error);
  assert.ok(route.route.stationIds.includes(station.station.id));
});

test('station construction failures leave all infrastructure and finances unchanged', () => {
  const state = E.createGame(), options = { layoutId: 'island-8', placement: 'free', bearing: 45 };
  state.money = 1;
  const before = E.serializeGame(state);
  assert.equal(E.buildStation(state, a, 20, '資金不足', options).ok, false);
  assert.equal(E.serializeGame(state), before);
  state.unlimited = true;
  assert.equal(E.buildStation(state, a, 8, '先置き駅', options).ok, true);
  const built = E.serializeGame(state);
  assert.equal(E.buildStation(state, a, 8, '重複駅', options).ok, false);
  assert.equal(E.serializeGame(state), built);
  assert.equal(E.previewStation(state, { lat: 100, lng: 139 }, 8, options).ok, false);
  const main = stationTestLine('double');
  assert.match(E.previewStation(main, p(.5), 5, { layoutId: 'side-1', placement: 'track' }).error, /2線以上/);
});

test('new station topology and population display survive a save while legacy stations still load', () => {
  const state = E.createGame(); state.populationVisible = true;
  const built = E.buildStation(state, a, 8, '保存駅', { placement: 'free', layoutId: 'mixed-4', bearing: 32 });
  assert.equal(built.ok, true, built.error);
  const restored = E.deserializeGame(E.serializeGame(state)), station = restored.stations[0];
  assert.equal(station.layoutId, 'mixed-4'); assert.equal(station.bearing, 32); assert.equal(station.standalone, true);
  assert.deepEqual(station.platformTrackIds, built.station.platformTrackIds);
  assert.equal(restored.populationVisible, true);
  assert.equal(restored.tracks.filter(track => track.stationTrack && track.stationId === station.id).length, 4);
  assert.deepEqual(E.stationGeometry(station).connections, E.stationGeometry(built.station).connections);
  const legacy = stationTestLine(); E.buildStation(legacy, p(.5), 3, '旧駅');
  for (const key of ['layoutId', 'bearing', 'standalone', 'platformTrackIds', 'hostTrackCount']) delete legacy.stations[0][key];
  const old = E.deserializeGame(E.serializeGame(legacy));
  assert.equal(old.stations[0].layoutId, 'side-1');
  assert.deepEqual(old.stations[0].platformTrackIds, [old.tracks[0].id]);
  assert.equal(old.populationVisible, false);
  const cells = E.getPopulationCells(); assert.ok(cells.length > 500000); assert.equal(E.getPopulationCells(), cells);
});

test('removing a standalone station deletes its own yard but preserves outside connections and other stations', () => {
  const state = stationTestState(), options = { placement: 'free', layoutId: 'island-4', bearing: 0 };
  const from = E.buildStation(state, a, 8, '削除駅', options), to = E.buildStation(state, b, 8, '残す駅', options);
  const connection = E.buildTrack(state, [E.stationGeometry(from.station).connections[1], E.stationGeometry(to.station).connections[0]], 'double');
  assert.equal(connection.ok, true, connection.error);
  assert.equal(E.createRoute(state, { startId: from.station.id, endId: to.station.id }).ok, true);
  const before = state.money;
  const removed = E.deleteStation(state, from.station.id);
  assert.equal(removed.ok, true); assert.equal(state.money, before);
  assert.equal(state.tracks.filter(track => track.stationId === from.station.id).length, 0);
  assert.equal(state.tracks.filter(track => track.stationId === to.station.id).length, 4);
  assert.ok(state.tracks.some(track => track.id === connection.track.id));
  assert.equal(state.routes.length, 0);
});
