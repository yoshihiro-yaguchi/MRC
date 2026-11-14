import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';

const origin={lat:35.68,lng:139.76},rad=Math.PI/180,earth=6371008.8,cosine=Math.cos(origin.lat*rad);
const point=(x,y=0)=>({lat:origin.lat+y/earth/rad,lng:origin.lng+x/earth/rad/cosine});
function owned(type='single'){
  E.setExistingNetwork(null);const state=E.createGame(),host=E.buildTrack(state,[point(-1000),point(1000)],type);assert.equal(host.ok,true,host.error);return{state,host:host.track};
}

test('selecting any host platform shifts its body onto the original line without rotating or moving that line',()=>{
  for(const number of [1,4,8])for(const bearing of [0,45,90,175]){
    const geometry=E.stationGeometry({...origin,cars:8,layoutId:'island-8',hostTrackCount:1,hostPlatformNumber:number,wiringMode:'platforms',bearing});
    assert.deepEqual(geometry.hostSlotIndices,[number-1]);assert.equal(geometry.hostPlatformSelection,'explicit');assert.equal(geometry.trackOffsets[number-1],0);
    const angle=bearing*rad;
    for(const bodyPoint of geometry.platformTrackBodies[number-1]){
      const east=(bodyPoint.lng-origin.lng)*earth*rad*cosine,north=(bodyPoint.lat-origin.lat)*earth*rad;
      assert.ok(Math.abs(-east*Math.sin(angle)+north*Math.cos(angle))<1e-6,'the chosen platform stays on the original host axis');
    }
    if(number===1)assert.ok(geometry.trackOffsets.slice(1).every(offset=>offset>0));
    if(number===8)assert.ok(geometry.trackOffsets.slice(0,7).every(offset=>offset<0));
  }
});

for(const number of [1,4])test(`owned single host platform ${number} is the only automatic connection and survives saving and wiring edits`,()=>{
  const {state,host}=owned(),options={placement:'track',layoutId:'island-4',hostPlatformNumber:number};
  const preview=E.previewStation(state,origin,8,options),before=E.serializeGame(state);assert.equal(preview.ok,true,preview.error);assert.equal(E.serializeGame(state),before);
  const built=E.buildStation(state,origin,8,'選択した番線',options);assert.equal(built.ok,true,built.error);assert.equal(built.cost,preview.cost);assert.equal(built.station.hostPlatformNumber,number);assert.equal(built.station.hostPlatformSelection,'explicit');
  const platforms=E.getStationPlatforms(state,built.station);assert.equal(platforms[number-1].trackId,host.id);assert.deepEqual(E.getStationHostPlatformNumbers(built.station),[number]);
  const west=E.buildStation(state,point(-700),1,'西');assert.equal(west.ok,true,west.error);
  for(const platform of platforms)assert.equal(!!E.findPath(state,west.station.id,built.station.id,{platforms:{[built.station.id]:platform.number}}),platform.number===number);
  const loaded=E.deserializeGame(E.serializeGame(state));assert.equal(loaded.stations[0].hostPlatformSelection,'explicit');assert.deepEqual(E.getStationHostPlatformNumbers(loaded.stations[0]),[number]);
  const configs=E.getStationTrackConfigs(loaded.stations[0]);configs[number===1?1:0].direction='forward';
  const edited=E.updateStationWiring(loaded,built.station.id,{wiringMode:'platforms',trackConfigs:configs});assert.equal(edited.ok,true,edited.error);assert.equal(edited.station.hostPlatformNumber,number);assert.deepEqual(E.getStationHostPlatformNumbers(edited.station),[number]);assert.deepEqual(loaded.tracks.find(track=>track.id===host.id).points,host.points);
});

for(const start of [1,3])test(`owned double host selection starts at ${start} and preserves the two source directions`,()=>{
  const {state,host}=owned('double'),built=E.buildStation(state,origin,8,'複線の選択番線',{placement:'track',layoutId:'island-4',hostPlatformNumber:start});assert.equal(built.ok,true,built.error);
  assert.deepEqual(E.getStationHostPlatformNumbers(built.station),[start,start+1]);const platforms=E.getStationPlatforms(state,built.station);
  assert.equal(platforms[start-1].trackId,host.id);assert.equal(platforms[start].trackId,host.id);assert.equal(platforms[start-1].lane,-1);assert.equal(platforms[start].lane,1);
  const west=E.buildStation(state,point(-700),1,'西');assert.equal(west.ok,true,west.error);
  const route=E.createRoute(state,{startId:west.station.id,endId:built.station.id,platformAssignments:{forward:{[built.station.id]:start+1},backward:{[built.station.id]:start}}});assert.equal(route.ok,true,route.error);
  for(const platform of platforms.filter(platform=>platform.trackId!==host.id))assert.equal(E.findPath(state,west.station.id,built.station.id,{platforms:{[built.station.id]:platform.number}}),null);
  const loaded=E.deserializeGame(E.serializeGame(state));assert.deepEqual(E.getStationHostPlatformNumbers(loaded.stations[0]),[start,start+1]);assert.equal(loaded.stations[0].hostPlatformSelection,'explicit');
  const edited=E.updateStationWiring(loaded,built.station.id,{wiringMode:'platforms'});assert.equal(edited.ok,true,edited.error);assert.deepEqual(E.getStationHostPlatformNumbers(edited.station),[start,start+1]);assert.equal(loaded.routes[0].id,route.route.id);
});

test('old automatic mixed-three-track double stations retain their nearest-first slots rather than reinterpreting the old representative number',()=>{
  const {state}=owned('double'),built=E.buildStation(state,origin,8,'旧自動選択',{placement:'track',layoutId:'mixed-3',wiringMode:'merged'});assert.equal(built.ok,true,built.error);
  const expected=E.stationGeometry(built.station).hostSlotIndices;assert.deepEqual(expected,[1,0]);assert.equal(built.station.hostPlatformNumber,2);assert.equal(built.station.hostPlatformSelection,'auto');
  delete built.station.hostPlatformSelection;const oldPoints=state.tracks.map(track=>track.points),loaded=E.deserializeGame(E.serializeGame(state));
  assert.equal(loaded.stations[0].hostPlatformSelection,'auto');assert.equal(loaded.stations[0].hostPlatformNumber,2);assert.deepEqual(E.stationGeometry(loaded.stations[0]).hostSlotIndices,expected);assert.deepEqual(loaded.tracks.map(track=>track.points),oldPoints);
  const updated=E.updateStationWiring(loaded,built.station.id,{wiringMode:'platforms'});assert.equal(updated.ok,true,updated.error);assert.deepEqual(E.stationGeometry(updated.station).hostSlotIndices,expected);assert.equal(updated.station.hostPlatformSelection,'auto');
  assert.deepEqual(E.stationGeometry({...built.station,hostPlatformNumber:2,hostPlatformSelection:'explicit'}).hostSlotIndices,[1,2],'a newly explicit number still means the start of a consecutive pair');
});

test('invalid new host selections fail without construction and edited station drafts preserve only valid choices',()=>{
  const {state}=owned('double'),options={placement:'track',layoutId:'island-4'},before=E.serializeGame(state);
  for(const hostPlatformNumber of [0,-1,4,9,1.5,null,NaN,Infinity,'bad',true]){
    const result=E.buildStation(state,origin,8,'無効な選択',{...options,hostPlatformNumber});assert.equal(result.ok,false);assert.match(result.error,/番線/);assert.equal(E.serializeGame(state),before);
  }
  assert.equal(E.previewStation(state,origin,8,{placement:'free',layoutId:'island-4',hostPlatformNumber:1}).ok,false);
  state.stationDraft={kind:'new',point:origin,cars:8,options:{...options,hostPlatformNumber:3,wiringMode:'platforms',bearing:0}};
  const loaded=E.deserializeGame(E.serializeGame(state));assert.equal(loaded.stationDraft.options.hostPlatformNumber,3);assert.equal(loaded.stations.length,0);assert.equal(loaded.money,state.money);
  state.stationDraft.options.hostPlatformNumber=4;assert.equal(E.deserializeGame(E.serializeGame(state)).stationDraft,null);
});

test('explicit saved choices are validated and a placed host cannot be silently reassigned by a wiring edit',()=>{
  const {state}=owned(),built=E.buildStation(state,origin,8,'固定する番線',{placement:'track',layoutId:'island-4',hostPlatformNumber:4});assert.equal(built.ok,true,built.error);
  const before=E.serializeGame(state),edited=E.updateStationWiring(state,built.station.id,{wiringMode:'platforms',hostPlatformNumber:1});assert.equal(edited.ok,false);assert.match(edited.error,/設置時/);assert.equal(E.serializeGame(state),before);
  const malformed=JSON.parse(before);malformed.stations[0].hostPlatformNumber=5;assert.throws(()=>E.deserializeGame(malformed),/番線/);
  delete malformed.stations[0].hostPlatformNumber;assert.throws(()=>E.deserializeGame(malformed),/番線/);
});
