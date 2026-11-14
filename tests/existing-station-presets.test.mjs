import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';
import { ExistingRailwayNetwork } from '../dist/existing-network.js';

const origin = { lat: 35.68, lng: 139.76 }, radius = 6371008.8, radians = Math.PI / 180;
const at = (east, north) => ({ lat: origin.lat + north / radius / radians, lng: origin.lng + east / radius / radians / Math.cos(origin.lat * radians) });
const coordinates = point => [point.lng, point.lat];
const line = points => ({ type: 'Feature', properties: { type: 'rail' }, geometry: { type: 'LineString', coordinates: points.map(coordinates) } });
const sourceStation = (id, point) => ({ type: 'Feature', properties: { type: 'station', id, name: id }, geometry: { type: 'Point', coordinates: coordinates(point) } });
function curvedNetwork() {
  const shape = [[0,0],[600,0],[1200,300],[1800,300],[2600,600]];
  return new ExistingRailwayNetwork({ features: [
    line(shape.map(([x,y]) => at(x,y))), line(shape.map(([x,y]) => at(x,y+160))),
    line([at(1200,-1000),at(1200,1500)]),
    sourceStation('west',at(100,0)), sourceStation('east',at(2500,562.5)),
    sourceStation('parallel-west',at(100,160)), sourceStation('parallel-east',at(2500,722.5)),
    sourceStation('crossing',at(1200,1300)),
  ] });
}
const graph = () => ({ nodes: new Map(), stationNodes: new Map() });
function reachable(value, from, to) {
  const queue = [from], seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    if (queue[i] === to) return true;
    for (const edge of value.nodes.get(queue[i])?.edges || []) if (!seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
  }
  return false;
}

test('provider keeps private platform stop nodes alongside a paid station host without annotating shared junctions', () => {
  const network = curvedNetwork(), value = graph(), stop = { key: 'private-stop', point: at(1200,310), edges: [] };
  value.nodes.set(stop.key,stop); value.stationNodes.set('new',[stop.key]);
  network.augmentGraph(value,{ tracks: [], stations: [{ id: 'new', existingTrack: true, trackId: 'existing:0', ...at(1200,300) }] });
  const hosts = value.stationHostNodes.get('new');
  assert.equal(hosts.length,1); assert.deepEqual(value.stationNodes.get('new'),[stop.key,...hosts]);
  assert.equal(value.nodes.get(hosts[0]).track,undefined,'query-local host identity must not overwrite a possibly shared source junction');
  assert.equal(network.baseNodes.has(stop.key),false);
});

test('provider exact host bindings attach a siding to the selected crossing source instead of the nearest-source tie winner', () => {
  const network = new ExistingRailwayNetwork({ features: [line([at(-1000,0),at(0,0),at(1000,0)]),line([at(0,-1000),at(0,0),at(0,1000)]),sourceStation('north',at(0,900)),sourceStation('wrong-west',at(-900,0))] });
  const endpoint = at(0,0), nearest = network.nearestTrack(endpoint,.25), chosen = network.getTrack(nearest.track.id === 'existing:0' ? 'existing:1' : 'existing:0');
  assert.notEqual(nearest.track.id,chosen.id,'explicit selection deliberately differs from the nearest-source tie winner');
  const bound = network.stationAnchor({ trackId: chosen.id, ...endpoint });
  const track = { id: 'siding', type: 'single', stationTrack: true, existingHostConnections: [{ trackId: chosen.id, offset: bound.offset },{ trackId: chosen.id, offset: bound.offset }], points: [endpoint,at(400,400)] };
  const value = graph();
  value.nodes.set('a',{ key: 'a', point: track.points[0], track, edges: [{ to: 'b', distance: 500 }] });
  value.nodes.set('b',{ key: 'b', point: track.points[1], track, edges: [{ to: 'a', distance: 500 }] });
  network.augmentGraph(value,{ tracks: [track], stations: [{ id: 'north', existing: true, sourceStationId: 'north' },{ id: 'west', existing: true, sourceStationId: 'wrong-west' }] });
  const selectedDestination = chosen.id === 'existing:1' ? 'north' : 'west', otherDestination = selectedDestination === 'north' ? 'west' : 'north';
  assert.equal(reachable(value,'b',value.stationNodes.get(selectedDestination)[0]),true);
  assert.equal(reachable(value,'b',value.stationNodes.get(otherDestination)[0]),false,'a crossing without a source junction must not become an interchange');
});

test('provider never falls back to a different blue line for invalid or displaced explicit host bindings', () => {
  const network = curvedNetwork(), start = at(200,0), end = at(300,0), track = network.getTrack('existing:0');
  for (const bindings of [null,[],[{ trackId: 'missing', offset: 0 },{ trackId: 'missing', offset: 0 }],[{ trackId: track.id, offset: track.length+10 },{ trackId: track.id, offset: track.length+10 }],[{ trackId: track.id, offset: 0 },{ trackId: track.id, offset: 0 }]]) {
    const own = { id: 'private', type: 'single', stationTrack: true, existingHostConnections: bindings, points: [start,end] }, value = graph();
    value.nodes.set('own-a',{ key: 'own-a', point: start, track: own, edges: [{ to: 'own-b', distance: 100 }] });
    value.nodes.set('own-b',{ key: 'own-b', point: end, track: own, edges: [{ to: 'own-a', distance: 100 }] });
    network.augmentGraph(value,{ tracks: [own], stations: [{ id: 'east', existing: true, sourceStationId: 'east' }] });
    assert.equal(reachable(value,'own-a',value.stationNodes.get('east')[0]),false);
  }
});

test('an outside line attached to an independent port cannot silently use the nearby blue host at that end', () => {
  const network = new ExistingRailwayNetwork({ features: [line([at(-1000,0),at(1000,0)]),sourceStation('east',at(900,0))] });
  for (const blockedBindings of [null,[]]) for (const connectOtherEnd of [false,true]) {
    const privateTrack = { id: 'private', type: 'single', stationTrack: true, stationWiring: true, stationPorts: { a: true, b: true }, existingHostConnections: blockedBindings, points: [at(100,4),at(300,4)] };
    const outside = { id: 'outside', type: 'single', points: [privateTrack.points[1],connectOtherEnd ? at(700,0) : at(700,200)] }, value = graph();
    for (const track of [privateTrack,outside]) for (const [index,point] of track.points.entries()) {
      const key = `${track.id}-${index}`, other = `${track.id}-${1-index}`;
      value.nodes.set(key,{ key, point, track, edges: [{ to: other, distance: E.distance(...track.points), trackId: track.id }] });
    }
    value.nodes.get('private-1').edges.push({ to: 'outside-0', distance: 0, trackId: outside.id });
    value.nodes.get('outside-0').edges.push({ to: 'private-1', distance: 0, trackId: outside.id });
    network.augmentGraph(value,{ tracks: [privateTrack,outside], stations: [{ id: 'east', existing: true, sourceStationId: 'east' }] });
    assert.equal(reachable(value,'private-0',value.stationNodes.get('east')[0]),connectOtherEnd,'only the separately drawn blue endpoint may connect this platform');
  }
});

for (const layout of E.STATION_LAYOUTS) test(`${layout.name} explicitly merges real private platforms into the curved blue host before and after saving`, () => {
  const network = curvedNetwork(), state = E.createGame(), source = JSON.stringify(network.getTrack('existing:0'));
  E.setExistingNetwork(network);
  try {
    const west = E.useExistingStation(state,network.getStation('west')).station, east = E.useExistingStation(state,network.getStation('east')).station;
    const options = { placement: 'track', layoutId: layout.id, existingTrackId: 'existing:0', wiringMode: 'merged' }, position = at(1200,300), before = state.money;
    const preview = E.previewStation(state,position,8,options);
    assert.equal(preview.ok,true,preview.error); assert.equal(preview.hostTrackCount,1);
    const built = E.buildStation(state,position,8,'新設ハブ',options);
    assert.equal(built.ok,true,built.error);
    const station = built.station, privateTracks = state.tracks.filter(track => track.stationId === station.id), platforms = E.getStationPlatforms(state,station);
    assert.equal(station.existingTrack,true); assert.equal(station.existing,undefined); assert.equal(station.trackId,'existing:0');
    assert.equal(privateTracks.length,layout.tracks-1); assert.equal(platforms.length,layout.tracks); assert.equal(new Set(platforms.map(platform => platform.trackId)).size,layout.tracks);
    assert.ok(state.tracks.every(track => !track.id.startsWith('existing:')),'shared source tracks must never become owned construction');
    assert.equal(built.cost,preview.cost); assert.equal(state.money,before-built.cost); assert.equal(built.costBreakdown.platforms,layout.platforms*8*80_000_000);
    assert.equal(built.cost,built.costBreakdown.base+built.costBreakdown.platforms+built.costBreakdown.tracks);
    if (privateTracks.length) {
      const actualTrackCost = Math.round(privateTracks.reduce((sum,track) => sum+E.lineLength(track.points),0)*2_500_000);
      assert.ok(Math.abs(built.costBreakdown.tracks-actualTrackCost) <= Math.max(2,actualTrackCost*.001),'siding cost must represent actual owned yard geometry');
    } else assert.equal(built.costBreakdown.tracks,0);
    for (const track of privateTracks) {
      assert.equal(track.stationTrack,true); assert.equal(track.existingHostConnections.length,2);
      for (const [index, endpoint] of [track.points[0],track.points.at(-1)].entries()) {
        const binding = track.existingHostConnections[index], host = network.getTrack(binding.trackId), bound = network.pointOnTrack(host,binding.offset);
        assert.equal(binding.trackId,'existing:0'); assert.ok(E.distance(endpoint,bound.point)<.25);
      }
    }
    for (const platform of platforms) {
      const selected = { platforms: { [station.id]: platform.number } };
      for (const [from,to] of [[west.id,station.id],[station.id,west.id],[west.id,east.id],[east.id,west.id]]) {
        const path = E.findPath(state,from,to,selected);
        assert.ok(path,`${layout.id}: ${from}→${to} via platform ${platform.number}`);
        assert.ok(path.trackIds.includes(platform.trackId),'the selected private platform must be physically traversed, not just labeled');
        assert.ok(path.stationIds.includes(station.id)); assert.equal(path.selectedPlatforms[station.id],platform.number);
      }
    }
    const lastPlatform = platforms.at(-1), route = E.createRoute(state,{ startId: west.id, endId: east.id, cars: 8, fleet: 1, platformAssignments: { forward: { [station.id]: lastPlatform.number }, backward: { [station.id]: lastPlatform.number } } });
    assert.equal(route.ok,true,route.error); assert.ok(route.route.trackIds.includes(lastPlatform.trackId));
    const saved = E.serializeGame(state); E.setExistingNetwork(null);
    const loaded = E.deserializeGame(saved), restoredStation = loaded.stations.find(item => item.id === station.id);
    assert.equal(restoredStation.layoutId,layout.id); assert.equal(restoredStation.hostPlatformNumber,station.hostPlatformNumber);
    assert.deepEqual(E.getStationPlatforms(loaded,restoredStation).map(platform => [platform.number,platform.trackId]),platforms.map(platform => [platform.number,platform.trackId]));
    assert.equal(loaded.tracks.length,layout.tracks-1); assert.equal(loaded.money,state.money);
    E.setExistingNetwork(network);
    const restoredPath = E.findPath(loaded,west.id,east.id,{ platforms: { [station.id]: lastPlatform.number } });
    assert.ok(restoredPath); assert.ok(restoredPath.trackIds.includes(lastPlatform.trackId));
    assert.equal(JSON.stringify(network.getTrack('existing:0')),source,'construction and routing must leave cached source geometry untouched');
  } finally { E.setExistingNetwork(null); }
});

test('explicit blue host selection follows either parallel line and cannot turn a new station into an unrelated interchange', () => {
  const network = curvedNetwork(), selected = [];
  E.setExistingNetwork(network);
  try {
    // This point lies between the two source corridors; selecting the source
    // ID must override a general nearest-track result consistently.
    const mainPoint = at(2100,412.5), parallelPoint = at(2100,572.5), middle = { lat: (mainPoint.lat+parallelPoint.lat)/2, lng: mainPoint.lng };
    for (const id of ['existing:0','existing:1']) {
      const state = E.createGame(), preview = E.previewStation(state,middle,8,{ placement: 'track', layoutId: 'island-8', existingTrackId: id });
      assert.equal(preview.ok,true,preview.error); assert.equal(preview.track.id,id); selected.push(preview.point);
    }
    assert.ok(E.distance(selected[0],selected[1])>100,'moving to the other host changes the actual snapped station corridor');
    const state = E.createGame(), built = E.buildStation(state,at(1200,300),8,'主線ホーム',{ placement: 'track', layoutId: 'island-8', existingTrackId: 'existing:0' });
    assert.equal(built.ok,true,built.error);
    const east = E.useExistingStation(state,network.getStation('east')).station, other = E.useExistingStation(state,network.getStation('parallel-east')).station, crossing = E.useExistingStation(state,network.getStation('crossing')).station;
    assert.ok(E.findPath(state,built.station.id,east.id));
    assert.equal(E.findPath(state,built.station.id,other.id),null); assert.equal(E.findPath(state,built.station.id,crossing.id),null);
  } finally { E.setExistingNetwork(null); }
});

test('pending blue-host station drafts retain every preset without provider data at restore time', () => {
  E.setExistingNetwork(null);
  for (const layout of E.STATION_LAYOUTS) {
    const state = E.createGame();
    state.stationDraft = { kind: 'new', point: at(1200,300), cars: 8, options: { placement: 'track', layoutId: layout.id, bearing: 0, wiringMode: 'merged', existingTrackId: 'existing:0' } };
    const restored = E.deserializeGame(E.serializeGame(state));
    assert.equal(restored.stationDraft?.options.layoutId,layout.id); assert.equal(restored.stationDraft?.options.existingTrackId,'existing:0');
    assert.equal(restored.tracks.length,0); assert.equal(restored.stations.length,0); assert.equal(restored.money,state.money);
  }
});

for (const layout of E.STATION_LAYOUTS) test(`${layout.name} defaults to independent private platforms and preserves their isolation after reload`, () => {
  const network = curvedNetwork(), state = E.createGame(); E.setExistingNetwork(network);
  try {
    const west = E.useExistingStation(state,network.getStation('west')).station, east = E.useExistingStation(state,network.getStation('east')).station;
    const built = E.buildStation(state,at(1200,300),8,'独立番線',{ placement: 'track', layoutId: layout.id, existingTrackId: 'existing:0' });
    assert.equal(built.ok,true,built.error); assert.equal(built.station.wiringMode,'platforms'); assert.equal(built.station.portGeometry,'straight');
    const platforms = E.getStationPlatforms(state,built.station), host = platforms.find(platform => platform.trackId === 'existing:0');
    assert.ok(host); assert.equal(state.tracks.length,layout.tracks-1); assert.ok(E.findPath(state,west.id,east.id));
    for (const platform of platforms) for (const [from,to] of [[west.id,built.station.id],[built.station.id,west.id],[east.id,built.station.id],[built.station.id,east.id],[west.id,east.id],[east.id,west.id]]) {
      const result = E.findPath(state,from,to,{ platforms: { [built.station.id]: platform.number } });
      assert.equal(!!result,platform === host,`${layout.id} platform ${platform.number}: only the original host is connected`);
    }
    for (const track of state.tracks) {
      assert.equal(track.existingHostConnections,null); assert.equal(track.stationWiring,true);
      assert.ok(E.distance(track.points[0],track.points[1])>0); assert.ok(E.distance(track.points[2],track.points[3])>0);
      const geometry = E.stationGeometry(built.station);
      assert.deepEqual(track.points,geometry.trackPaths[track.platformIndex]);
    }
    const saved = E.serializeGame(state); E.setExistingNetwork(null);
    const loaded = E.deserializeGame(saved), station = loaded.stations.find(item => item.id === built.station.id);
    assert.equal(station.wiringMode,'platforms'); assert.ok(loaded.tracks.every(track => track.existingHostConnections === null));
    E.setExistingNetwork(network);
    for (const platform of E.getStationPlatforms(loaded,station)) {
      const path = E.findPath(loaded,station.id,east.id,{ platforms: { [station.id]: platform.number } });
      assert.equal(!!path,platform.trackId === 'existing:0');
    }
    if (layout.tracks > 1) {
      const disconnected = platforms.find(platform => platform.trackId !== 'existing:0'), before = E.serializeGame(loaded);
      const route = E.createRoute(loaded,{ startId: station.id, endId: east.id, cars: 8, platformAssignments: { forward: { [station.id]: disconnected.number }, backward: { [station.id]: disconnected.number } } });
      assert.equal(route.ok,false); assert.equal(E.serializeGame(loaded),before,'an unconnected platform choice must not buy trains or change routes');
    }
  } finally { E.setExistingNetwork(null); }
});

for (const selectedNumber of [5,8]) test(`a user-drawn outside connection opens only independent blue-station platform ${selectedNumber} in both directions`, () => {
  const network = new ExistingRailwayNetwork({ features: [line([at(-1500,0),at(1500,0)]),line([at(-1500,4),at(900,4),at(1200,400),at(1500,400)]),sourceStation('east',at(1200,0)),sourceStation('parallel',at(1200,400))] });
  E.setExistingNetwork(network); const state = E.createGame(); state.unlimited = true;
  try {
    const result = E.buildStation(state,origin,8,`${selectedNumber}番線を手動接続`,{ placement: 'track', layoutId: 'island-8', existingTrackId: 'existing:0' });
    assert.equal(result.ok,true,result.error); const station = result.station, east = E.useExistingStation(state,network.getStation('east')).station, parallel = E.useExistingStation(state,network.getStation('parallel')).station;
    const geometry = E.stationGeometry(station), port = geometry.connectionPorts.find(port => port.end === 'b' && port.platformNumbers.includes(selectedNumber)).point;
    assert.equal(E.findPath(state,station.id,east.id,{ platforms: { [station.id]: selectedNumber } }),null);
    const link = E.buildTrack(state,[port,{ lat: port.lat, lng: at(600,0).lng },at(800,0)],'single');
    assert.equal(link.ok,true,link.error); assert.ok(E.distance(link.track.points[0],port)<.25);
    const check = game => {
      const platforms = E.getStationPlatforms(game,station.id), host = platforms.find(platform => platform.trackId === 'existing:0');
      for (const platform of platforms) for (const [from,to] of [[station.id,east.id],[east.id,station.id]]) {
        const path = E.findPath(game,from,to,{ platforms: { [station.id]: platform.number } });
        assert.equal(!!path,platform.number === selectedNumber || platform.number === host.number,`platform ${platform.number} must not join its neighbour`);
        if (path && platform.number === selectedNumber) { assert.ok(path.trackIds.includes(platform.trackId)); assert.ok(path.trackIds.includes(link.track.id)); }
      }
      assert.equal(E.findPath(game,station.id,parallel.id,{ platforms: { [station.id]: selectedNumber } }),null,'a crossing or a four-metre parallel blue source is not an interchange');
    };
    check(state); const saved = E.serializeGame(state); E.setExistingNetwork(null); const restored = E.deserializeGame(saved); E.setExistingNetwork(network); check(restored);
  } finally { E.setExistingNetwork(null); }
});

for (const hostNumber of [1,8]) test(`blue host platform ${hostNumber} keeps its chosen physical rail through draft restore, manual wiring and world restore`, () => {
  const network = curvedNetwork(), state = E.createGame(), source = JSON.stringify(network.getTrack('existing:0'));
  const position = at(1200,300), options = { placement: 'track', layoutId: 'island-8', existingTrackId: 'existing:0', hostPlatformNumber: hostNumber, wiringMode: 'platforms' };
  E.setExistingNetwork(network);
  try {
    const west = E.useExistingStation(state,network.getStation('west')).station, east = E.useExistingStation(state,network.getStation('east')).station;
    state.stationDraft = { kind: 'new', point: position, cars: 8, options };
    E.setExistingNetwork(null); const pending = E.deserializeGame(E.serializeGame(state));
    assert.equal(pending.stationDraft.options.hostPlatformNumber,hostNumber); assert.equal(pending.tracks.length,0); assert.equal(pending.money,state.money);
    E.setExistingNetwork(network);
    const preview = E.previewStation(state,position,8,pending.stationDraft.options);
    assert.equal(preview.ok,true,preview.error); assert.deepEqual(preview.geometry.hostSlotIndices,[hostNumber-1]);
    assert.equal(preview.geometry.trackOffsets[hostNumber-1],0,'the requested platform is physically centered on the reused rail');
    assert.equal(preview.geometry.hostPaths[0].platformIndex,hostNumber-1);
    const built = E.buildStation(state,position,8,`元線を${hostNumber}番線に配置`,pending.stationDraft.options);
    assert.equal(built.ok,true,built.error); state.stationDraft = null;
    const station = built.station, privateNumber = hostNumber === 1 ? 8 : 1;
    assert.equal(station.hostPlatformNumber,hostNumber); assert.equal(station.hostPlatformSelection,'explicit');
    const assertConnections = (world, connected, outsideTrackId = null) => {
      const restoredStation = world.stations.find(item => item.id === station.id), platforms = E.getStationPlatforms(world,restoredStation);
      assert.equal(restoredStation.hostPlatformNumber,hostNumber); assert.equal(restoredStation.hostPlatformSelection,'explicit');
      assert.deepEqual(E.getStationHostPlatformNumbers(restoredStation),[hostNumber]);
      assert.equal(platforms.find(platform => platform.number === hostNumber).trackId,'existing:0');
      assert.equal(world.tracks.filter(track => track.stationId === station.id).length,7);
      for (const platform of platforms) {
        if (platform.number !== hostNumber) {
          const own = world.tracks.find(track => track.id === platform.trackId);
          assert.equal(own?.platformIndex,platform.number-1); assert.equal(own?.existingHostConnections,null);
        }
        for (const [from,to] of [[station.id,east.id],[east.id,station.id]]) {
          const path = E.findPath(world,from,to,{ platforms: { [station.id]: platform.number } });
          assert.equal(!!path,connected.has(platform.number),`host ${hostNumber}, selected ${platform.number}`);
          if (path) {
            assert.ok(path.trackIds.includes(platform.trackId)); assert.equal(path.selectedPlatforms[station.id],platform.number);
            if (outsideTrackId && platform.number === privateNumber) assert.ok(path.trackIds.includes(outsideTrackId));
          }
        }
      }
      for (const [from,to] of [[west.id,east.id],[east.id,west.id]]) {
        const hostPath = E.findPath(world,from,to,{ platforms: { [station.id]: hostNumber } });
        assert.ok(hostPath); assert.equal(hostPath.selectedPlatforms[station.id],hostNumber);
      }
    };
    assertConnections(state,new Set([hostNumber]));
    for (const [from,to] of [[west.id,east.id],[east.id,west.id]]) assert.equal(E.findPath(state,from,to,{ platforms: { [station.id]: privateNumber } }),null,'an isolated explicit intermediate choice cannot use the old central platform');
    E.setExistingNetwork(null); const isolated = E.deserializeGame(E.serializeGame(state)); E.setExistingNetwork(network);
    assertConnections(isolated,new Set([hostNumber]));
    const geometry = E.stationGeometry(station), port = geometry.connectionPorts.find(port => port.end === 'b' && port.platformNumbers.includes(privateNumber)).point;
    const target = network.pointOnTrack(network.getTrack('existing:0'),station.offset+700).point;
    const external = E.buildTrack(state,[port,target],'single'); assert.equal(external.ok,true,external.error);
    assertConnections(state,new Set([hostNumber,privateNumber]),external.track.id);
    const route = E.createRoute(state,{ startId: station.id, endId: east.id, cars: 8, platformAssignments: { forward: { [station.id]: privateNumber }, backward: { [station.id]: hostNumber } } });
    assert.equal(route.ok,true,route.error); assert.equal(route.route.selectedPlatforms.forward[station.id],privateNumber); assert.equal(route.route.selectedPlatforms.backward[station.id],hostNumber);
    E.setExistingNetwork(null); const restored = E.deserializeGame(E.serializeGame(state)); E.setExistingNetwork(network);
    assertConnections(restored,new Set([hostNumber,privateNumber]),external.track.id);
    assert.deepEqual(restored.routes[0].selectedPlatforms,route.route.selectedPlatforms);
    assert.equal(JSON.stringify(network.getTrack('existing:0')),source,'changing the platform alignment must not move or import the source network');
  } finally { E.setExistingNetwork(null); }
});
