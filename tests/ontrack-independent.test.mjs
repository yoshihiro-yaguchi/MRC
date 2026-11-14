import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';
import {ExistingRailwayNetwork} from '../dist/existing-network.js';

const origin={lat:35.68,lng:139.76},rad=Math.PI/180,earth=6371008.8,cosine=Math.cos(origin.lat*rad);
const point=(x,y=0)=>({lat:origin.lat+y/earth/rad,lng:origin.lng+x/earth/rad/cosine});
function owned(type='single',half=1000){E.setExistingNetwork(null);const state=E.createGame(),built=E.buildTrack(state,[point(-half),point(half)],type);assert.equal(built.ok,true,built.error);return{state,host:built.track};}
function shared(half=1000){
  const line={type:'Feature',properties:{type:'rail'},geometry:{type:'LineString',coordinates:[point(-half),point(half)].map(p=>[p.lng,p.lat])}};
  const source=(id,x)=>({type:'Feature',properties:{type:'station',id,name:id},geometry:{type:'Point',coordinates:[point(x).lng,point(x).lat]}});
  const provider=new ExistingRailwayNetwork({type:'FeatureCollection',features:[line,...(half>700?[source('west',-700),source('east',700)]:[])]});E.setExistingNetwork(provider);return{state:E.createGame(),provider};
}

for(const type of ['single','double'])test(`new presets on an owned ${type} reuse only the immutable host platforms and keep private rails disconnected`,()=>{
  const {state,host}=owned(type),built=E.buildStation(state,origin,8,'独立番線駅',{placement:'track',layoutId:'island-4'});assert.equal(built.ok,true,built.error);assert.equal(built.station.wiringMode,'platforms');
  const west=E.buildStation(state,point(-700),1,'西');assert.equal(west.ok,true,west.error);
  const hostNumbers=E.getStationHostPlatformNumbers(built.station),platforms=E.getStationPlatforms(state,built.station);assert.equal(hostNumbers.length,type==='double'?2:1);
  for(const platform of platforms){const selection={platforms:{[built.station.id]:platform.number}},forward=E.findPath(state,west.station.id,built.station.id,selection),backward=E.findPath(state,built.station.id,west.station.id,selection);assert.equal(!!(forward||backward),hostNumbers.includes(platform.number),`${platform.number}番線 must not auto-merge`);}
  for(const track of state.tracks.filter(track=>track.stationId===built.station.id)){assert.equal(track.stationWiring,true);assert.equal(track.existingHostConnections,null);assert.equal(track.points[0].lat,track.points[1].lat);assert.equal(track.points[2].lat,track.points[3].lat);}
  const loaded=E.deserializeGame(E.serializeGame(state));assert.deepEqual(loaded.tracks.find(track=>track.id===host.id).points,host.points);assert.deepEqual(loaded.stations[0].hostTrackPoints,built.station.hostTrackPoints);
  for(const platform of E.getStationPlatforms(loaded,loaded.stations[0])){const selection={platforms:{[built.station.id]:platform.number}};assert.equal(!!(E.findPath(loaded,west.station.id,built.station.id,selection)||E.findPath(loaded,built.station.id,west.station.id,selection)),hostNumbers.includes(platform.number));}
});

test('old merged blue stations preserve old saves, reject a conversion that strands a routed platform, and convert without a charge when uncommitted',()=>{
  const {state,provider}=shared(),built=E.buildStation(state,origin,8,'旧合流駅',{placement:'track',layoutId:'island-8',existingTrackId:'existing:0',wiringMode:'merged'});assert.equal(built.ok,true,built.error);
  const west=E.useExistingStation(state,provider.getStation('west'));assert.equal(west.ok,true,west.error);
  const route=E.createRoute(state,{startId:west.station.id,endId:built.station.id,platformAssignments:{forward:{[built.station.id]:1},backward:{[built.station.id]:1}}});assert.equal(route.ok,true,route.error);
  delete built.station.wiringMode;delete built.station.trackConfigs;const loaded=E.deserializeGame(E.serializeGame(state));assert.equal(loaded.stations[0].wiringMode,'merged');assert.ok(E.findPath(loaded,west.station.id,built.station.id,{platforms:{[built.station.id]:1}}));
  const before=E.serializeGame(loaded),rejected=E.updateStationWiring(loaded,built.station.id,{wiringMode:'platforms'});assert.equal(rejected.ok,false);assert.match(rejected.error,/路線/);assert.equal(E.serializeGame(loaded),before);
  E.deleteRoute(loaded,route.route.id);const money=loaded.money,ids=loaded.stations[0].platformTrackIds.slice(),converted=E.updateStationWiring(loaded,built.station.id,{wiringMode:'platforms'});assert.equal(converted.ok,true,converted.error);assert.equal(converted.cost,0);assert.equal(loaded.money,money);assert.deepEqual(converted.station.platformTrackIds,ids);
  const hostNumbers=E.getStationHostPlatformNumbers(converted.station);for(const platform of E.getStationPlatforms(loaded,converted.station))assert.equal(!!E.findPath(loaded,west.station.id,built.station.id,{platforms:{[built.station.id]:platform.number}}),hostNumbers.includes(platform.number));
  assert.ok(loaded.tracks.filter(track=>track.stationId===built.station.id).every(track=>track.existingHostConnections===null));E.setExistingNetwork(null);
});

test('owned-host station rewiring also preserves valid host routes and rejects edits to the original line rows',()=>{
  const {state}=owned(),built=E.buildStation(state,origin,8,'旧自作線駅',{placement:'track',layoutId:'island-4',wiringMode:'merged'}),west=E.buildStation(state,point(-700),1,'西'),east=E.buildStation(state,point(700),1,'東');
  assert.equal(built.ok,true,built.error);assert.equal(west.ok,true,west.error);assert.equal(east.ok,true,east.error);const route=E.createRoute(state,{startId:west.station.id,endId:east.station.id});assert.equal(route.ok,true,route.error);route.route.revenue=123;
  const converted=E.updateStationWiring(state,built.station.id,{wiringMode:'platforms'});assert.equal(converted.ok,true,converted.error);assert.equal(state.routes[0].id,route.route.id);assert.equal(state.routes[0].revenue,123);
  const hostNumber=E.getStationHostPlatformNumbers(converted.station)[0],configs=E.getStationTrackConfigs(converted.station);configs[hostNumber-1]={a:'group1',b:'buffer',direction:'both'};
  const before=E.serializeGame(state),invalid=E.updateStationWiring(state,built.station.id,{wiringMode:'platforms',trackConfigs:configs});assert.equal(invalid.ok,false);assert.match(invalid.error,/元の線路/);assert.equal(E.serializeGame(state),before);
});

test('independent private rails need only their host platform to fit, while explicitly merged yards still require their source approaches',()=>{
  const {state}=shared(100),options={placement:'track',layoutId:'island-8',existingTrackId:'existing:0'};
  const independent=E.previewStation(state,origin,8,options);assert.equal(independent.ok,true,independent.error);assert.equal(independent.wiringMode,'platforms');assert.equal(independent.geometry.connectionPorts.length,16);
  assert.equal(E.previewStation(state,origin,8,{...options,wiringMode:'merged'}).ok,false);
  E.setExistingNetwork(null);const own=owned('single',100);assert.equal(E.previewStation(own.state,origin,8,{placement:'track',layoutId:'island-8'}).ok,true);
});

test('legacy one-platform stations on owned double lines can keep their original line while opening independent editing',()=>{
  const {state}=owned('double'),built=E.buildStation(state,origin,1,'旧式駅');assert.equal(built.ok,true,built.error);assert.equal(built.station.layoutId,'side-1');
  const result=E.updateStationWiring(state,built.station.id,{wiringMode:'platforms'});assert.equal(result.ok,true,result.error);assert.equal(result.cost,0);assert.equal(E.deserializeGame(E.serializeGame(state)).stations[0].wiringMode,'platforms');
});
