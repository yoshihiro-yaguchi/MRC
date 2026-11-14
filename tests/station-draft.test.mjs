import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';

const point={lat:35.68,lng:139.76};
const options={placement:'free',layoutId:'island-2',bearing:45,wiringMode:'platforms',trackConfigs:[{a:'independent',b:'independent',direction:'forward'},{a:'independent',b:'independent',direction:'reverse'}]};

test('station and track drafts coexist and restore without building infrastructure or charging money',()=>{
  const state=E.createGame(),originalMoney=state.money,originalStats={...state.stats};
  state.trackDraft={type:'double',points:[point,{lat:35.69,lng:139.77}],paused:true};
  state.stationDraft={kind:'new',point,cars:8,options};
  const loaded=E.deserializeGame(E.serializeGame(state));
  assert.deepEqual(loaded.stationDraft,state.stationDraft);assert.deepEqual(loaded.trackDraft,state.trackDraft);
  assert.deepEqual(loaded.tracks,[]);assert.deepEqual(loaded.stations,[]);assert.deepEqual(loaded.routes,[]);assert.equal(loaded.money,originalMoney);assert.deepEqual(loaded.stats,originalStats);
  loaded.stationDraft.point.lat=0;loaded.stationDraft.options.trackConfigs[0].a='buffer';assert.equal(point.lat,35.68);assert.equal(options.trackConfigs[0].a,'independent');
});

test('new paid blue-line station drafts and existing-station adoption drafts preserve only their selected configuration',()=>{
  const state=E.createGame();
  state.stationDraft={kind:'new',point,cars:4,options:{placement:'track',layoutId:'side-1',bearing:360,wiringMode:'merged',existingTrackId:'existing:123',infrastructure:[1],cost:999},cost:999};
  const loaded=E.deserializeGame(E.serializeGame(state));
  assert.deepEqual(loaded.stationDraft,{kind:'new',point,cars:4,options:{placement:'track',layoutId:'side-1',bearing:0,wiringMode:'merged',trackConfigs:[{a:'group1',b:'group1',direction:'both'}],existingTrackId:'existing:123'}});
  assert.equal(loaded.stations.length,0);assert.equal(loaded.tracks.length,0);assert.equal(loaded.money,state.money);
  state.stationDraft={kind:'existing',point,sourceStationId:'blue-station-123',cost:999,tracks:[1]};
  assert.deepEqual(E.deserializeGame(E.serializeGame(state)).stationDraft,{kind:'existing',point,sourceStationId:'blue-station-123'});
});

test('invalid station drafts are discarded independently of the world and valid track draft',()=>{
  const state=E.createGame();state.money=12345;state.trackDraft={type:'single',points:[point],paused:true};
  const draft={kind:'new',point,cars:8,options};
  const invalid=[null,[],42,{...draft,kind:'other'},{...draft,point:{lat:99,lng:139}},{...draft,cars:0},{...draft,cars:1.5},{...draft,cars:21},{...draft,options:{...options,bearing:Infinity}},{...draft,options:{...options,layoutId:'unknown'}},{...draft,options:{...options,placement:'unknown'}},{...draft,options:{...options,wiringMode:'unknown'}},{...draft,options:{...options,trackConfigs:[]}},{...draft,options:{...options,trackConfigs:[{a:'buffer',b:'buffer',direction:'both'},options.trackConfigs[1]]}},{...draft,options:{...options,existingTrackId:'https://example.com'}},{kind:'existing',point,sourceStationId:''},{kind:'existing',point,sourceStationId:123}];
  for(const stationDraft of invalid){
    const loaded=E.deserializeGame({...state,stationDraft});assert.equal(loaded.stationDraft,null);assert.equal(loaded.money,12345);assert.deepEqual(loaded.trackDraft,state.trackDraft);assert.deepEqual(loaded.stations,[]);
    assert.equal(E.deserializeGame(JSON.stringify({...state,stationDraft})).stationDraft,null);
  }
  delete state.stationDraft;assert.equal(E.deserializeGame(state).stationDraft,null);assert.equal(E.createGame().stationDraft,null);
});
