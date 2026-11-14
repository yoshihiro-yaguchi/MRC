import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';
import {ExistingRailwayNetwork} from '../dist/existing-network.js';

const origin={lat:35.68,lng:139.76},rad=Math.PI/180,earth=6371008.8,cosine=Math.cos(origin.lat*rad);
const point=(x,y=0)=>({lat:origin.lat+y/earth/rad,lng:origin.lng+x/earth/rad/cosine});
const rail=(id='host')=>({id,type:'single',points:[point(-1000),point(1000)]});
const station=(pointValue=origin,hostId='host')=>({kind:'new',point:pointValue,cars:8,options:{placement:'track',layoutId:'island-4',bearing:0,wiringMode:'platforms',draftTrackId:hostId,hostPlatformNumber:2}});

test('stroke IDs, multiple station drafts and selected station order restore without building anything',()=>{
  const state=E.createGame();state.trackDrafts=[rail('x'.repeat(128)),{type:'single',points:[point(2000),point(3000)]}];state.trackDraft={...rail('active'),paused:false,orderIndex:0};
  state.stationDrafts=[station(point(-500),'x'.repeat(128)),{kind:'existing',point:point(3000),sourceStationId:'source'}];state.stationDraft={...station(point(500),'active'),orderIndex:1};
  const loaded=E.deserializeGame(E.serializeGame(state));assert.equal(loaded.trackDrafts[0].id,'x'.repeat(128));assert.equal(loaded.trackDrafts[1].id,undefined);assert.equal(loaded.trackDraft.id,'active');
  assert.equal(loaded.stationDrafts.length,2);assert.equal(loaded.stationDrafts[0].options.draftTrackId,'x'.repeat(128));assert.equal(loaded.stationDraft.orderIndex,1);assert.equal(loaded.stationDraft.options.draftTrackId,'active');
  assert.equal(loaded.tracks.length,0);assert.equal(loaded.stations.length,0);assert.equal(loaded.money,state.money);assert.equal(loaded.stats.construction,0);
  const old=E.createGame();delete old.stationDrafts;assert.deepEqual(E.deserializeGame(old).stationDrafts,[]);
});

test('invalid or duplicate draft identifiers never become ambiguous host mappings and do not damage a valid world',()=>{
  E.setExistingNetwork(null);const state=E.createGame();
  for(const id of ['', '  ',null,7,'x'.repeat(129),'bad\nline']){
    const before=E.serializeGame(state),preview=E.previewConstructionPlan(state,[rail(id)],[]);assert.equal(preview.ok,false);assert.equal(preview.geometryOk,false);assert.equal(E.buildConstructionPlan(state,[rail(id)],[]).ok,false);assert.equal(E.serializeGame(state),before);
    const loaded=E.deserializeGame({...state,trackDrafts:[rail(id),rail('valid')],trackDraft:{...rail(id),paused:false}});assert.equal(loaded.trackDrafts.length,1);assert.equal(loaded.trackDrafts[0].id,'valid');assert.equal(loaded.trackDraft,null);
  }
  const duplicate=E.previewConstructionPlan(state,[rail('same'),{...rail('same'),points:[point(2000),point(3000)]}],[station(origin,'same')]);assert.equal(duplicate.ok,false);assert.equal(duplicate.preparedTracks.length,0);assert.equal(duplicate.stationPreviews[0].ok,false);
  const loaded=E.deserializeGame({...state,trackDrafts:[rail('same'),rail('same')],trackDraft:{...rail('same'),paused:false}});assert.equal(loaded.trackDrafts.length,1);assert.equal(loaded.trackDraft,null);
  const unusual=E.previewConstructionPlan(state,[rail('__proto__')],[station(origin,'__proto__')]);assert.equal(unusual.ok,true,unusual.error);assert.equal(Object.hasOwn(unusual.trackIdMap,'__proto__'),true);assert.equal(unusual.stationPreviews[0].station.trackId,unusual.trackIdMap.__proto__);
});

test('construction previews retain complete station geometry when only the aggregate funds check fails',()=>{
  E.setExistingNetwork(null);const state=E.createGame();state.money=1;const tracks=[rail()],stations=[station()],before=E.serializeGame(state);
  const preview=E.previewConstructionPlan(state,tracks,stations);assert.equal(preview.ok,false);assert.equal(preview.geometryOk,true);assert.equal(preview.canBuild,false);assert.match(preview.error,/所持金/);
  assert.equal(preview.preparedTracks[0].draftTrackId,'host');assert.equal(preview.preparedTracks[0].id,preview.trackIdMap.host);assert.equal(preview.stationPreviews[0].preview.ok,true);assert.equal(preview.stationPreviews[0].station.trackId,preview.trackIdMap.host);assert.ok(preview.cost.stations>0);assert.equal(preview.cost.total,preview.cost.trackCost+preview.cost.landCost+preview.cost.stations);
  preview.stationPreviews[0].station.name='changed result';assert.equal(E.serializeGame(state),before);assert.equal(E.buildConstructionPlan(state,tracks,stations).ok,false);assert.equal(E.serializeGame(state),before);
  state.money=100_000_000_000;const funded=E.previewConstructionPlan(state,tracks,stations),built=E.buildConstructionPlan(state,tracks,stations);assert.equal(built.ok,true,built.error);assert.deepEqual(built.cost,funded.cost);assert.equal(built.stations[0].trackId,built.trackIdMap.host);assert.equal(state.money,100_000_000_000-built.cost.total);
});

test('station host reference normalization preserves exact owned and orphan draft selections without nearest fallback',()=>{
  E.setExistingNetwork(null);const state=E.createGame(),host=E.buildTrack(state,rail().points,'single');assert.equal(host.ok,true,host.error);
  const owned={...station(),options:{...station().options,ownedTrackId:host.track.id}};delete owned.options.draftTrackId;
  state.stationDraft=owned;assert.equal(E.deserializeGame(E.serializeGame(state)).stationDraft.options.ownedTrackId,host.track.id);
  const orphan=station(origin,'deleted');state.stationDraft=orphan;assert.equal(E.deserializeGame(E.serializeGame(state)).stationDraft.options.draftTrackId,'deleted');const preview=E.previewConstructionPlan(state,[],[orphan]);assert.equal(preview.ok,false);assert.equal(preview.stationPreviews[0].ok,false);
  assert.equal(E.previewStation(state,origin,8,orphan.options).ok,false);
  for(const options of [{...owned.options,draftTrackId:'also-present'},{...station().options,placement:'free'},{...owned.options,ownedTrackId:'x'.repeat(129)}])assert.equal(E.deserializeGame({...state,stationDraft:{...owned,options}}).stationDraft,null);
  for(const orderIndex of [-1,201,1.5])assert.equal(E.deserializeGame({...state,stationDraft:{...owned,orderIndex}}).stationDraft.orderIndex,undefined);
});

test('a connector to a pending private platform retains its exact endpoint instead of snapping to the earlier draft host four metres away',()=>{
  E.setExistingNetwork(null);const state=E.createGame(),draft=station(),ghost=E.stationGeometry({...origin,cars:8,layoutId:'island-4',hostTrackCount:1,hostPlatformNumber:2,wiringMode:'platforms'}),port=ghost.connectionPorts.find(p=>p.end==='b'&&p.platformNumbers.includes(3)).point;
  const tracks=[rail(),{id:'manual',type:'single',points:[port,point(300,100),point(500)],curveMode:'point',handles:[null,null,null]}],preview=E.previewConstructionPlan(state,tracks,[draft]);assert.equal(preview.ok,true,preview.error);assert.deepEqual(preview.preparedTracks[1].points[0],port);
  const built=E.buildConstructionPlan(state,tracks,[draft]);assert.equal(built.ok,true,built.error);assert.deepEqual(state.tracks.find(track=>track.id===built.trackIdMap.manual).points[0],port);
  const east=E.buildStation(state,point(700),1,'東');assert.equal(east.ok,true,east.error);const target=built.stations[0],path=E.findPath(state,east.station.id,target.id,{platforms:{[target.id]:3}});assert.ok(path);assert.ok(path.trackIds.includes(built.trackIdMap.manual));assert.ok(path.length>750,'the route must use the deliberately curved connector, not a phantom nearby-host link');
  for(const number of [1,4])assert.equal(E.findPath(state,east.station.id,target.id,{platforms:{[target.id]:number}}),null);
});

test('a connector to a pending paid-blue private platform also retains its private port until the station exists',()=>{
  const line={type:'Feature',properties:{type:'rail'},geometry:{type:'LineString',coordinates:[point(-1000),point(1000)].map(p=>[p.lng,p.lat])}},source={type:'Feature',properties:{type:'station',id:'west',name:'西'},geometry:{type:'Point',coordinates:[point(-700).lng,point(-700).lat]}};
  const provider=new ExistingRailwayNetwork({type:'FeatureCollection',features:[line,source]});E.setExistingNetwork(provider);const state=E.createGame(),draft={...station(),options:{...station().options,existingTrackId:'existing:0'}};delete draft.options.draftTrackId;
  const ghost=E.previewStation(state,origin,8,draft.options);assert.equal(ghost.ok,true,ghost.error);const port=ghost.geometry.connectionPorts.find(p=>p.end==='b'&&p.platformNumbers.includes(3)).point;
  const built=E.buildConstructionPlan(state,[{id:'manual',type:'single',points:[port,point(300,100),point(500)],curveMode:'point',handles:[null,null,null]}],[draft]);assert.equal(built.ok,true,built.error);assert.deepEqual(built.tracks[0].points[0],port);
  const east=E.buildStation(state,point(700),1,'東',{placement:'track',layoutId:'side-1',existingTrackId:'existing:0'});assert.equal(east.ok,true,east.error);const target=built.stations[0],path=E.findPath(state,east.station.id,target.id,{platforms:{[target.id]:3}});assert.ok(path);assert.ok(path.trackIds.includes(built.trackIdMap.manual));assert.ok(path.length>750);E.setExistingNetwork(null);
});
