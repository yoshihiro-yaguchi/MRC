import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';
import {ExistingRailwayNetwork} from '../dist/existing-network.js';

const origin={lat:35.68,lng:139.76},earth=6371008.8,radians=Math.PI/180;
const at=(east,north=0)=>({lat:origin.lat+north/earth/radians,lng:origin.lng+east/earth/radians/Math.cos(origin.lat*radians)});
const line=points=>({type:'Feature',properties:{type:'rail'},geometry:{type:'LineString',coordinates:points.map(point=>[point.lng,point.lat])}});
const sourceStation=(id,point)=>({type:'Feature',properties:{type:'station',id,name:id},geometry:{type:'Point',coordinates:[point.lng,point.lat]}});
const stationDraft=(point,options)=>({kind:'new',point,cars:8,options});
const allStations=state=>[...(state.stationDrafts||[]),...(state.stationDraft?[state.stationDraft]:[])];
const pairedPlan=()=>{
  const state=E.createGame(),host={id:'pending-corridor',type:'single',curveMode:'tangent',points:[at(-1800),at(1800)]};
  const options={placement:'track',layoutId:'island-2',wiringMode:'platforms',draftTrackId:host.id,hostPlatformNumber:1};
  state.trackDrafts=[host];
  state.stationDrafts=[stationDraft(at(-700),{...options})];
  state.stationDraft=stationDraft(at(700),{...options});
  return state;
};
function unchangedFailure(state,tracks,stations) {
  const before=E.serializeGame(state),inputs=JSON.stringify({tracks,stations});
  const preview=E.previewConstructionPlan(state,tracks,stations);
  assert.equal(preview.ok,false); assert.equal(E.serializeGame(state),before); assert.equal(JSON.stringify({tracks,stations}),inputs);
  const built=E.buildConstructionPlan(state,tracks,stations);
  assert.equal(built.ok,false); assert.equal(E.serializeGame(state),before,'no rail, station, charge or pending plan may be partially committed');
  assert.equal(JSON.stringify({tracks,stations}),inputs);
  return {preview,built};
}

test('two stations on a pending rail survive saving without infrastructure, then form one paid construction and a real route',()=>{
  E.setExistingNetwork(null); const state=pairedPlan(),beforeMoney=state.money;
  const loaded=E.deserializeGame(E.serializeGame(state)),tracks=loaded.trackDrafts,stations=allStations(loaded);
  assert.equal(loaded.tracks.length,0); assert.equal(loaded.stations.length,0); assert.equal(loaded.routes.length,0);
  assert.equal(loaded.money,beforeMoney); assert.equal(loaded.stats.construction,0);
  assert.equal(loaded.stationDrafts.length,1); assert.equal(loaded.stationDraft.point.lng,state.stationDraft.point.lng);
  assert.equal(tracks[0].id,'pending-corridor'); assert.deepEqual(stations.map(draft=>draft.options.draftTrackId),['pending-corridor','pending-corridor']);
  const saved=E.serializeGame(loaded),inputs=JSON.stringify({tracks,stations});
  const preview=E.previewConstructionPlan(loaded,tracks,stations);
  assert.equal(preview.ok,true,preview.error); assert.equal(preview.geometryOk,true); assert.equal(preview.canBuild,true);
  assert.equal(E.serializeGame(loaded),saved); assert.equal(JSON.stringify({tracks,stations}),inputs);
  const built=E.buildConstructionPlan(loaded,tracks,stations);
  assert.equal(built.ok,true,built.error); assert.equal(built.totalCost,preview.totalCost); assert.equal(built.cost.total,preview.cost.total);
  assert.equal(loaded.money,beforeMoney-built.totalCost); assert.equal(loaded.stats.construction,built.totalCost);
  assert.equal(loaded.stations.length,2); assert.equal(loaded.tracks.length,3,'one drafted host plus one private platform rail per station');
  const hostId=built.trackIdMap['pending-corridor']; assert.ok(loaded.tracks.some(track=>track.id===hostId));
  assert.ok(loaded.stations.every(station=>station.trackId===hostId));
  const [west,east]=loaded.stations.slice().sort((a,b)=>a.lng-b.lng);
  for(const [from,to] of [[west,east],[east,west]]) {
    const path=E.findPath(loaded,from.id,to.id,{platforms:{[west.id]:1,[east.id]:1}});
    assert.ok(path); assert.ok(path.trackIds.includes(hostId));
    assert.equal(E.findPath(loaded,from.id,to.id,{platforms:{[west.id]:2,[east.id]:2}}),null,'private platforms stay isolated after the shared batch');
  }
  const route=E.createRoute(loaded,{startId:west.id,endId:east.id,cars:8,platformAssignments:{forward:{[west.id]:1,[east.id]:1},backward:{[west.id]:1,[east.id]:1}}});
  assert.equal(route.ok,true,route.error); assert.equal(JSON.stringify({tracks,stations}),inputs);
  const restored=E.deserializeGame(E.serializeGame(loaded));
  assert.ok(E.findPath(restored,west.id,east.id,{platforms:route.route.platformAssignments.forward}));
  assert.equal(restored.money,loaded.money); assert.equal(restored.routes.length,1);
});

test('one plan combines a blue eight-platform station, a free preset and free existing-station adoption while keeping manual wiring real',()=>{
  const provider=new ExistingRailwayNetwork({features:[line([at(-3000),at(3000)]),sourceStation('east',at(2200))]});
  E.setExistingNetwork(provider);
  try {
    const state=E.createGame(),beforeMoney=state.money,source=JSON.stringify(provider.getTrack('existing:0'));
    const blue=stationDraft(origin,{placement:'track',layoutId:'island-8',wiringMode:'platforms',existingTrackId:'existing:0',hostPlatformNumber:8});
    const free=stationDraft(at(0,1200),{placement:'free',layoutId:'island-2',bearing:90,wiringMode:'platforms'});
    const bluePreview=E.previewStation(state,blue.point,8,blue.options),freePreview=E.previewStation(state,free.point,8,free.options);
    assert.equal(bluePreview.ok,true,bluePreview.error); assert.equal(freePreview.ok,true,freePreview.error);
    const bluePort=bluePreview.geometry.connectionPorts.find(port=>port.end==='b'&&port.platformNumbers.includes(1)).point;
    const freePort=freePreview.geometry.connectionPorts.find(port=>port.end==='a'&&port.platformNumbers.includes(1)).point;
    state.trackDrafts=[{id:'pending-manual-link',type:'single',curveMode:'tangent',points:[bluePort,freePort]}];
    state.stationDrafts=[blue,free]; state.stationDraft={kind:'existing',point:at(2200),sourceStationId:'east'};
    const saved=E.serializeGame(state); E.setExistingNetwork(null); const loaded=E.deserializeGame(saved); E.setExistingNetwork(provider);
    assert.equal(loaded.tracks.length,0); assert.equal(loaded.stations.length,0); assert.equal(loaded.money,beforeMoney);
    const untouched=E.serializeGame(loaded),preview=E.previewConstructionPlan(loaded,loaded.trackDrafts,allStations(loaded)); assert.equal(preview.ok,true,preview.error);
    assert.equal(E.serializeGame(loaded),untouched,'preview does not adopt source stations or build any pending assets');
    const built=E.buildConstructionPlan(loaded,loaded.trackDrafts,allStations(loaded)); assert.equal(built.ok,true,built.error);
    assert.equal(built.totalCost,preview.totalCost); assert.equal(loaded.money,beforeMoney-built.totalCost);
    assert.equal(loaded.stations.length,3); assert.equal(loaded.tracks.length,10,'seven blue sidings, two free-station rails and one manual outside link');
    assert.ok(loaded.tracks.every(track=>!track.id.startsWith('existing:')));
    const hub=loaded.stations.find(station=>station.existingTrack),yard=loaded.stations.find(station=>station.standalone),east=loaded.stations.find(station=>station.existing);
    assert.equal(hub.hostPlatformNumber,8); assert.equal(hub.hostPlatformSelection,'explicit'); assert.equal(east.cost,0);
    const host=E.getStationPlatforms(loaded,hub).find(platform=>platform.number===8); assert.equal(host.trackId,'existing:0');
    const linkId=built.trackIdMap['pending-manual-link'];
    for(const [from,to] of [[hub,yard],[yard,hub]]) for(const platform of E.getStationPlatforms(loaded,hub)) {
      const path=E.findPath(loaded,from.id,to.id,{platforms:{[hub.id]:platform.number,[yard.id]:1}});
      assert.equal(!!path,platform.number===1);
      if(path){assert.ok(path.trackIds.includes(platform.trackId));assert.ok(path.trackIds.includes(linkId));}
    }
    assert.ok(E.findPath(loaded,hub.id,east.id,{platforms:{[hub.id]:8}}));
    assert.equal(E.findPath(loaded,hub.id,east.id,{platforms:{[hub.id]:1}}),null,'the outside link crossing the blue host must not silently join it');
    const route=E.createRoute(loaded,{startId:yard.id,endId:hub.id,cars:8,platformAssignments:{forward:{[yard.id]:1,[hub.id]:1},backward:{[yard.id]:1,[hub.id]:1}}});
    assert.equal(route.ok,true,route.error);
    E.setExistingNetwork(null); const restored=E.deserializeGame(E.serializeGame(loaded)); E.setExistingNetwork(provider);
    assert.ok(E.findPath(restored,yard.id,hub.id,{platforms:route.route.platformAssignments.forward}));
    assert.equal(E.findPath(restored,hub.id,east.id,{platforms:{[hub.id]:1}}),null);
    assert.equal(JSON.stringify(provider.getTrack('existing:0')),source);
  } finally {E.setExistingNetwork(null);}
});

test('a later overlapping station rejects the complete plan without building earlier rails or stations',()=>{
  E.setExistingNetwork(null); const state=pairedPlan();
  state.stationDraft.point=at(-680);
  const {built}=unchangedFailure(state,state.trackDrafts,allStations(state)); assert.match(built.error,/重な/);
});

test('deleting a pending host never lets its station fall back onto an unrelated built line',()=>{
  E.setExistingNetwork(null); const state=E.createGame(),owned=E.buildTrack(state,[at(-1800),at(1800)],'single');
  assert.equal(owned.ok,true,owned.error);
  state.trackDrafts=[{id:'unrelated-pending-line',type:'single',points:[at(-1800,500),at(1800,500)]}];
  state.stationDraft=stationDraft(origin,{placement:'track',layoutId:'island-2',wiringMode:'platforms',draftTrackId:'deleted-pending-host'});
  unchangedFailure(state,state.trackDrafts,allStations(state));
  assert.equal(state.tracks.length,1); assert.equal(state.tracks[0].id,owned.track.id); assert.equal(state.stations.length,0);
});

test('aggregate funds failure after individually affordable rails and stations preserves the entire pending plan',()=>{
  E.setExistingNetwork(null); const state=pairedPlan(),stations=allStations(state);
  const complete=E.previewConstructionPlan(state,state.trackDrafts,stations); assert.equal(complete.ok,true,complete.error);
  state.money=complete.totalCost-1;
  const {preview,built}=unchangedFailure(state,state.trackDrafts,stations);
  assert.equal(preview.geometryOk,true); assert.equal(preview.canBuild,false); assert.equal(preview.totalCost,complete.totalCost);
  assert.match(built.error,/所持金|資金/); assert.equal(state.stats.construction,0);
});

test('a legacy single station draft remains selected and can be committed through the new combined planner',()=>{
  E.setExistingNetwork(null); const raw=E.createGame();
  raw.stationDraft=stationDraft(origin,{placement:'free',layoutId:'island-2',bearing:45,wiringMode:'platforms'});
  delete raw.stationDrafts;
  const state=E.deserializeGame(JSON.stringify(raw));
  assert.deepEqual(state.stationDrafts,[]); assert.equal(state.stationDraft.point.lat,origin.lat); assert.equal(state.stationDraft.options.bearing,45);
  const before=state.money,preview=E.previewConstructionPlan(state,[],allStations(state)); assert.equal(preview.ok,true,preview.error);
  const built=E.buildConstructionPlan(state,[],allStations(state)); assert.equal(built.ok,true,built.error);
  assert.equal(state.stations.length,1); assert.equal(state.tracks.length,2); assert.equal(state.stations[0].bearing,45);
  assert.equal(state.money,before-preview.totalCost); assert.equal(built.totalCost,preview.totalCost);
});

for(const connectOtherEnd of [false,true]) test(`pending free-station ports two metres from blue rails ${connectOtherEnd?'connect only through the deliberately drawn other endpoint':'stay isolated when an outside line merely starts there'}`,()=>{
  const provider=new ExistingRailwayNetwork({features:[line([at(-2000),at(2000)]),sourceStation('east',at(1600))]});
  E.setExistingNetwork(provider);
  try {
    const state=E.createGame(),free=stationDraft(at(0,7),{placement:'free',layoutId:'island-2',bearing:0,wiringMode:'platforms'});
    const geometry=E.previewStation(state,free.point,8,free.options).geometry;
    const port=geometry.connectionPorts.find(port=>port.end==='b'&&port.platformNumbers.includes(1)).point;
    assert.ok(provider.nearestTrack(port,5).distance>1.9); assert.ok(provider.nearestTrack(port,5).distance<2.1);
    state.trackDrafts=[{id:'outside-from-free-port',type:'single',points:[port,at(1000,connectOtherEnd?0:400)]}];
    state.stationDrafts=[free]; state.stationDraft={kind:'existing',point:at(1600),sourceStationId:'east'};
    const built=E.buildConstructionPlan(state,state.trackDrafts,allStations(state)); assert.equal(built.ok,true,built.error);
    const external=state.tracks.find(track=>track.id===built.trackIdMap['outside-from-free-port']);
    assert.ok(E.distance(external.points[0],port)<.25,'building the pending outside line must not snap its private-port endpoint onto the source rail');
    const yard=state.stations.find(station=>station.standalone),east=state.stations.find(station=>station.existing);
    const check=world=>{
      for(const [from,to] of [[yard,east],[east,yard]]) {
        const path=E.findPath(world,from.id,to.id,{platforms:{[yard.id]:1}});
        assert.equal(!!path,connectOtherEnd);
        if(path)assert.ok(path.trackIds.includes(external.id));
      }
      assert.equal(E.findPath(world,yard.id,east.id,{platforms:{[yard.id]:2}}),null,'the adjacent private platform must not join the outside link');
    };
    check(state); E.setExistingNetwork(null); const restored=E.deserializeGame(E.serializeGame(state)); E.setExistingNetwork(provider); check(restored);
  } finally {E.setExistingNetwork(null);}
});
