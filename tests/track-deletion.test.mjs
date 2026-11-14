import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';

const point=(lng,lat=35.68)=>({lat,lng});
function line(state,lat=35.68){const result=E.buildTrack(state,[point(139.76,lat),point(139.78,lat)],'double');assert.equal(result.ok,true,result.error);return result.track;}
function station(state,lng,lat=35.68,name='駅',options={}){const result=E.buildStation(state,point(lng,lat),1,name,options);assert.equal(result.ok,true,result.error);return result.station;}
function route(state,start,end,name){const result=E.createRoute(state,{startId:start.id,endId:end.id,name});assert.equal(result.ok,true,result.error);return result.route;}

test('owned line removal previews affected named stations and routes without mutating anything, then deletes without a refund',()=>{
  E.setExistingNetwork(null);const state=E.createGame(),host=line(state),west=station(state,139.762,35.68,'削除側西駅'),east=station(state,139.778,35.68,'削除側東駅'),service=route(state,west,east,'削除側路線');
  const other=line(state,35.70),otherWest=station(state,139.762,35.70,'残す西駅'),otherEast=station(state,139.778,35.70,'残す東駅'),remainingService=route(state,otherWest,otherEast,'残す路線');
  const before=E.serializeGame(state),money=state.money,stats={...state.stats},preview=E.previewDeleteTrack(state,host.id);
  assert.equal(preview.ok,true,preview.error);assert.equal(E.serializeGame(state),before);assert.deepEqual(preview.trackIds,[host.id]);assert.deepEqual(new Set(preview.stationIds),new Set([west.id,east.id]));assert.deepEqual(preview.routeIds,[service.id]);
  assert.deepEqual(preview.stationNames,['削除側西駅','削除側東駅']);assert.deepEqual(preview.routeNames,['削除側路線']);assert.equal(preview.refund,0);
  const removed=E.deleteTrack(state,host.id);assert.deepEqual(removed,preview);assert.deepEqual(state.tracks.map(track=>track.id),[other.id]);assert.deepEqual(state.stations.map(s=>s.id),[otherWest.id,otherEast.id]);assert.deepEqual(state.routes.map(r=>r.id),[remainingService.id]);assert.equal(state.money,money);assert.deepEqual(state.stats,stats);
  const loaded=E.deserializeGame(E.serializeGame(state));assert.equal(loaded.routes[0].id,remainingService.id);assert.ok(E.findPath(loaded,otherWest.id,otherEast.id));
});

test('deleting a host cascades station-owned sidings while leaving an ordinary connected external neighbour in place',()=>{
  E.setExistingNetwork(null);const state=E.createGame(),host=line(state);
  const hub=station(state,139.77,35.68,'2面4線駅',{placement:'track',layoutId:'island-4'}),sidings=state.tracks.filter(track=>track.stationId===hub.id).map(track=>track.id);assert.equal(sidings.length,2);
  const adjacent=E.buildTrack(state,[point(139.78),point(139.785)],'double');assert.equal(adjacent.ok,true,adjacent.error);
  const preview=E.previewDeleteTrack(state,host.id);assert.deepEqual(new Set(preview.trackIds),new Set([host.id,...sidings]));assert.deepEqual(preview.stationIds,[hub.id]);
  assert.equal(E.deleteTrack(state,host.id).ok,true);assert.deepEqual(state.tracks.map(track=>track.id),[adjacent.track.id]);assert.equal(state.stations.length,0);assert.equal(E.deserializeGame(E.serializeGame(state)).tracks.length,1);
});

test('dependent crossovers use both connection references and host references, while independent main lines remain',()=>{
  E.setExistingNetwork(null);const state=E.createGame(),south=line(state),north=line(state,35.685);
  const crossover=E.buildTrack(state,[point(139.765),point(139.77,35.685)],'crossover');assert.equal(crossover.ok,true,crossover.error);assert.equal(crossover.track.hostTrackId,south.id);
  const scissors=E.buildTrack(state,[point(139.762),point(139.764)],'scissors');assert.equal(scissors.ok,true,scissors.error);
  const previewNorth=E.previewDeleteTrack(state,north.id);assert.deepEqual(new Set(previewNorth.trackIds),new Set([north.id,crossover.track.id]));
  const previewSouth=E.previewDeleteTrack(state,south.id);assert.deepEqual(new Set(previewSouth.trackIds),new Set([south.id,crossover.track.id,scissors.track.id]));
  assert.equal(E.deleteTrack(state,north.id).ok,true);assert.deepEqual(new Set(state.tracks.map(track=>track.id)),new Set([south.id,scissors.track.id]));
  assert.equal(E.deserializeGame(E.serializeGame(state)).tracks.length,2);
});

test('deleting a standalone station connection preserves the station and its own platform tracks but removes the dependent route',()=>{
  E.setExistingNetwork(null);const state=E.createGame(),options={placement:'free',layoutId:'island-2',wiringMode:'platforms'};
  const west=station(state,139.76,35.68,'独立西駅',options),east=station(state,139.78,35.68,'独立東駅',options);
  const first=E.stationGeometry(west).connectionPorts.find(p=>p.end==='b'&&p.platformNumbers.includes(1)),second=E.stationGeometry(east).connectionPorts.find(p=>p.end==='a'&&p.platformNumbers.includes(1));
  const connection=E.buildTrack(state,[first.point,second.point],'single');assert.equal(connection.ok,true,connection.error);const service=route(state,west,east,'接続路線');
  const internalIds=state.tracks.filter(track=>track.stationTrack).map(track=>track.id),preview=E.previewDeleteTrack(state,connection.track.id);assert.deepEqual(preview.stationIds,[]);assert.deepEqual(preview.routeIds,[service.id]);
  E.deleteTrack(state,connection.track.id);assert.deepEqual(state.tracks.map(track=>track.id),internalIds);assert.deepEqual(state.stations.map(s=>s.id),[west.id,east.id]);assert.equal(state.routes.length,0);assert.equal(E.deserializeGame(E.serializeGame(state)).stations.length,2);
});

test('blue lines, shared equipment, station-internal rails and unknown ids cannot be deleted through the line tool',()=>{
  const state=E.createGame(),own=station(state,139.76,35.68,'構内駅',{placement:'free',layoutId:'island-2',wiringMode:'platforms'}),before=E.serializeGame(state);
  for(const id of ['existing:0','missing',own.platformTrackIds[0],null]){
    assert.equal(E.previewDeleteTrack(state,id).ok,false);assert.equal(E.deleteTrack(state,id).ok,false);assert.equal(E.serializeGame(state),before);
  }
  for(const marker of [{existing:true},{stationId:own.id},{stationTrack:true},{stationWiring:true}]){
    state.tracks.push({id:'protected',type:'single',points:[point(139.80),point(139.81)],...marker});const saved=E.serializeGame(state);assert.equal(E.deleteTrack(state,'protected').ok,false);assert.equal(E.serializeGame(state),saved);state.tracks.pop();
  }
});
