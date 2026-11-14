import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTrackNetwork, trackNetworkKey, applyTrackNetwork } from '../dist/track-edit-state.js';

function game() {
  return {
    tracks: [{ id: 't', type: 'single', points: [{ lat: 35, lng: 139 }, { lat: 35.01, lng: 139 }], cost: 100 }],
    stations: [{ id: 's', name: '駅', lat: 35, lng: 139, trackId: 't', population: 1000, passengers: 10, trackConfigs: [{ a: 'independent', b: 'buffer', direction: 'both' }] }],
    routes: [{ id: 'r', name: '路線', trackIds: ['t'], stationIds: ['s'], cars: 2, platformAssignments: { forward: { s: 1 }, backward: {} }, revenue: 100, cost: 50, passengers: 10, trips: 2 }],
    money: 1000, unlimited: false, time: 123456, speed: 60, layer: 'relief', view: { lat: 35, lng: 139, zoom: 15 },
    stationDraft: { kind: 'new', point: { lat: 36, lng: 139 } }, trackDrafts: [{ type: 'single', points: [{ lat: 37, lng: 139 }] }],
    stats: { construction: 300, revenue: 500, cost: 100, passengers: 50 },
  };
}

test('capture keeps only an independent deep copy of infrastructure and route configuration', () => {
  const world = game(), snapshot = captureTrackNetwork(world);
  assert.deepEqual(Object.keys(snapshot).sort(), ['routes', 'stations', 'tracks']);
  snapshot.tracks[0].points[0].lat = 0; snapshot.stations[0].trackConfigs[0].a = 'group1'; snapshot.routes[0].platformAssignments.forward.s = 2;
  assert.equal(world.tracks[0].points[0].lat, 35); assert.equal(world.stations[0].trackConfigs[0].a, 'independent'); assert.equal(world.routes[0].platformAssignments.forward.s, 1);
  world.routes[0].stationIds.push('new'); assert.deepEqual(snapshot.routes[0].stationIds, ['s']);
});

test('restoring geometry and route configuration preserves the live clock, counters, population and unrelated editor state', () => {
  const world = game(), snapshot = captureTrackNetwork(world), view = world.view, stationDraft = world.stationDraft, drafts = world.trackDrafts;
  world.tracks[0].points[0].lat = 36; world.routes[0].cars = 3; world.stations[0].name = '変更後';
  Object.assign(world.routes[0], { revenue: 1200, cost: 300, passengers: 450, trips: 15 });
  Object.assign(world.stations[0], { population: 9000, passengers: 777 });
  world.time += 10000; world.speed = 3600; world.stats.revenue = 1600; world.stats.cost = 700; world.stats.passengers = 800;
  assert.deepEqual(applyTrackNetwork(world, snapshot, { paidDelta: 25, constructionDelta: 40 }), { ok: true });
  assert.equal(world.tracks[0].points[0].lat, 35); assert.equal(world.routes[0].cars, 2); assert.equal(world.stations[0].name, '駅');
  assert.equal(world.time, 133456); assert.equal(world.speed, 3600); assert.equal(world.layer, 'relief'); assert.equal(world.unlimited, false);
  assert.equal(world.view, view); assert.equal(world.stationDraft, stationDraft); assert.equal(world.trackDrafts, drafts);
  assert.deepEqual([world.routes[0].revenue, world.routes[0].cost, world.routes[0].passengers, world.routes[0].trips], [1200, 300, 450, 15]);
  assert.equal(world.stations[0].population, 9000); assert.equal(world.stations[0].passengers, 777);
  assert.deepEqual(world.stats, { construction: 340, revenue: 1600, cost: 700, passengers: 800 }); assert.equal(world.money, 975);
});

test('deleting and restoring routes or stations uses snapshot counters for IDs that no longer exist', () => {
  const world = game(), snapshot = captureTrackNetwork(world);
  assert.equal(applyTrackNetwork(world, { tracks: [], stations: [], routes: [] }).ok, true);
  assert.equal(world.money, 1000); assert.equal(world.time, 123456); assert.equal(world.routes.length, 0);
  assert.equal(applyTrackNetwork(world, snapshot).ok, true);
  assert.equal(world.stations[0].population, 1000); assert.equal(world.stations[0].passengers, 10);
  assert.deepEqual([world.routes[0].revenue, world.routes[0].cost, world.routes[0].passengers, world.routes[0].trips], [100, 50, 10, 2]);
});

test('insufficient funds or invalid restoration data leave the entire world and history input untouched', () => {
  const world = game(), snapshot = captureTrackNetwork(world), before = JSON.stringify(world), input = JSON.stringify(snapshot), tracks = world.tracks, stats = world.stats;
  assert.equal(applyTrackNetwork(world, { tracks: [], stations: [], routes: [] }, { paidDelta: 1001, constructionDelta: 90 }).ok, false);
  assert.equal(JSON.stringify(world), before); assert.equal(world.tracks, tracks); assert.equal(world.stats, stats);
  for (const options of [{ paidDelta: NaN }, { constructionDelta: Infinity }, { paidDelta: '1' }]) assert.equal(applyTrackNetwork(world, snapshot, options).ok, false);
  for (const invalid of [null, {}, { tracks: [], stations: [], routes: [{ id: 'a' }, { id: 'a' }] }]) assert.equal(applyTrackNetwork(world, invalid).ok, false);
  const circular = { tracks: [], stations: [], routes: [] }; circular.self = circular;
  assert.equal(applyTrackNetwork(world, circular).ok, false);
  assert.equal(JSON.stringify(world), before); assert.equal(JSON.stringify(snapshot), input);
});

test('undo refunds and redo charges relative deltas without rewinding accumulated revenue or allowing negative construction totals', () => {
  const world = game(), snapshot = captureTrackNetwork(world);
  world.money += 500; world.stats.revenue += 500;
  assert.equal(applyTrackNetwork(world, snapshot, { paidDelta: -200, constructionDelta: -500 }).ok, true);
  assert.equal(world.money, 1700); assert.equal(world.stats.construction, 0); assert.equal(world.stats.revenue, 1000);
  assert.equal(applyTrackNetwork(world, snapshot, { paidDelta: 200, constructionDelta: 500 }).ok, true);
  assert.equal(world.money, 1500); assert.equal(world.stats.construction, 500); assert.equal(world.stats.revenue, 1000);
});

test('unlimited games never charge or refund money but still track construction changes', () => {
  const world = game(), snapshot = captureTrackNetwork(world); world.unlimited = true; world.money = 1;
  assert.equal(applyTrackNetwork(world, snapshot, { paidDelta: 5000, constructionDelta: 5000 }).ok, true);
  assert.equal(world.money, 1); assert.equal(world.stats.construction, 5300); assert.equal(world.unlimited, true);
  assert.equal(applyTrackNetwork(world, snapshot, { paidDelta: -5000, constructionDelta: -5000 }).ok, true);
  assert.equal(world.money, 1); assert.equal(world.stats.construction, 300);
});

test('restored nested objects have no aliases to history input or the replaced live network', () => {
  const world = game(), oldTrack = world.tracks[0], oldStation = world.stations[0], snapshot = captureTrackNetwork(world);
  world.tracks[0].points[0].lat = 35.5;
  oldStation.name = '変更された駅';
  assert.equal(applyTrackNetwork(world, snapshot).ok, true);
  snapshot.tracks[0].points[0].lng = 0; oldStation.trackConfigs[0].b = 'group2';
  assert.equal(world.tracks[0].points[0].lng, 139); assert.equal(world.stations[0].trackConfigs[0].b, 'buffer');
  world.tracks[0].points[1].lat = 1; world.routes[0].platformAssignments.forward.s = 3;
  assert.equal(oldTrack.points[1].lat, 35.01); assert.equal(snapshot.routes[0].platformAssignments.forward.s, 1);
});

test('draft-only restoration preserves live object references for pending station naming work', () => {
  const world = game(), snapshot = captureTrackNetwork(world);
  const tracks = world.tracks, stations = world.stations, routes = world.routes, pendingStation = stations[0], route = routes[0], stats = world.stats;
  world.time += 1000; world.speed = 120;
  Object.assign(pendingStation, { population: 3000, passengers: 450 });
  Object.assign(route, { revenue: 1000, cost: 700, passengers: 800, trips: 90 });
  world.money = 1300; world.stats.revenue += 300;
  const before = JSON.stringify(world);
  assert.equal(applyTrackNetwork(world, snapshot).ok, true);
  assert.equal(world.tracks, tracks); assert.equal(world.stations, stations); assert.equal(world.routes, routes); assert.equal(world.stats, stats);
  assert.equal(world.stations[0], pendingStation); assert.equal(world.routes[0], route); assert.equal(world.stations.includes(pendingStation), true);
  assert.equal(JSON.stringify(world), before);
  pendingStation.name = '非同期の町名';
  assert.equal(world.stations[0].name, '非同期の町名');
  snapshot.stations[0].name = '履歴側だけの変更';
  assert.equal(world.stations[0].name, '非同期の町名');
});

test('undoing a track build preserves unchanged stations and routes while adjusting only its construction deltas', () => {
  const world = game(), snapshot = captureTrackNetwork(world), pendingStation = world.stations[0], route = world.routes[0];
  world.tracks.push({ id: 'extra', type: 'single', points: [{ lat: 36, lng: 139 }, { lat: 36.01, lng: 139 }], cost: 100 });
  world.money -= 100; world.stats.construction += 100; world.time += 2000;
  pendingStation.population = 5000; pendingStation.passengers += 200; route.revenue += 300;
  assert.equal(applyTrackNetwork(world, snapshot, { paidDelta: -100, constructionDelta: -100 }).ok, true);
  assert.deepEqual(world.tracks.map(track => track.id), ['t']); assert.equal(world.money, 1000); assert.equal(world.stats.construction, 300);
  assert.equal(world.stations[0], pendingStation); assert.equal(world.routes[0], route); assert.equal(world.stations.includes(pendingStation), true);
  assert.equal(pendingStation.population, 5000); assert.equal(pendingStation.passengers, 210); assert.equal(route.revenue, 400); assert.equal(world.time, 125456);
  pendingStation.name = '非同期で決まった駅名'; assert.equal(world.stations[0].name, '非同期で決まった駅名');
  assert.equal(snapshot.stations[0].name, '駅'); assert.equal(snapshot.routes[0].revenue, 100);
});

test('restoring changed station geometry and route settings replaces those entities with independent copies', () => {
  const world = game(), snapshot = captureTrackNetwork(world), oldStation = world.stations[0], oldRoute = world.routes[0];
  oldStation.lat = 36; oldRoute.cars = 8; oldStation.passengers = 600; oldRoute.trips = 40;
  assert.equal(applyTrackNetwork(world, snapshot).ok, true);
  assert.notEqual(world.stations[0], oldStation); assert.notEqual(world.routes[0], oldRoute);
  assert.equal(world.stations[0].lat, 35); assert.equal(world.routes[0].cars, 2);
  assert.equal(world.stations[0].passengers, 600); assert.equal(world.routes[0].trips, 40);
  snapshot.stations[0].lat = 0; oldRoute.platformAssignments.forward.s = 9;
  assert.equal(world.stations[0].lat, 35); assert.equal(world.routes[0].platformAssignments.forward.s, 1);
});

test('network keys ignore live economic updates and station population while detecting geometry, names and routing configuration', () => {
  const world = game(), initial = trackNetworkKey(world);
  world.time++; world.speed++; world.money++; world.unlimited = true; world.layer = 'blank'; world.stats.construction++;
  Object.assign(world.routes[0], { revenue: 900, cost: 700, passengers: 600, trips: 500 }); Object.assign(world.stations[0], { population: 2000, passengers: 999 });
  assert.equal(trackNetworkKey(world), initial);
  for (const change of [
    next => { next.tracks[0].points[0].lat += .001; },
    next => { next.stations[0].name = '別の駅'; },
    next => { next.routes[0].name = '別の路線'; },
    next => { next.routes[0].platformAssignments.forward.s = 2; },
    next => { next.routes[0].cars = 8; },
    next => { next.tracks[0].cost += 1; },
  ]) { const next = game(); change(next); assert.notEqual(trackNetworkKey(next), initial); }
  const reordered = game(); reordered.tracks[0] = { cost: 100, points: reordered.tracks[0].points, type: 'single', id: 't' };
  assert.equal(trackNetworkKey(reordered), initial);
});
