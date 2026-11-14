import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';

test('paused plan control points survive save reload without becoming owned tracks or charging money',()=>{
  const state=E.createGame(),money=state.money,construction=state.stats.construction;
  const points=[{lat:35.68,lng:139.76},{lat:35.681,lng:139.765},{lat:35.685,lng:139.77}];
  state.trackDraft={type:'double',points,paused:true};
  const loaded=E.deserializeGame(E.serializeGame(state));
  assert.deepEqual(loaded.trackDraft,{type:'double',points,paused:true});assert.equal(loaded.money,money);assert.equal(loaded.stats.construction,construction);assert.deepEqual(loaded.tracks,[]);
  loaded.trackDraft.points[0].lat=0;assert.equal(points[0].lat,35.68,'restoring a draft copies control points');
  for(const type of ['single','double','crossover','scissors']){
    state.trackDraft={type,points:[points[0]],paused:false};assert.deepEqual(E.deserializeGame(E.serializeGame(state)).trackDraft,state.trackDraft);
  }
});

test('malformed and oversized draft data is discarded without losing the valid game world',()=>{
  const state=E.createGame();state.money=12_345;state.layer='relief';
  const point={lat:35.68,lng:139.76};
  for(const trackDraft of [{type:'double',points:[],paused:true},{type:'bad',points:[point],paused:true},{type:'single',points:[{lat:999,lng:139}],paused:true},{type:'single',points:[null],paused:true},{type:'single',points:[point],paused:'yes'},{type:'single',points:Array.from({length:10_001},()=>point),paused:true},[],42]){
    const loaded=E.deserializeGame({...state,trackDraft});assert.equal(loaded.trackDraft,null);assert.equal(loaded.money,12_345);assert.equal(loaded.layer,'relief');assert.deepEqual(loaded.tracks,[]);
  }
  delete state.trackDraft;assert.equal(E.deserializeGame(state).trackDraft,null);assert.equal(E.createGame().trackDraft,null);
});

test('an archived stroke being edited preserves its original build-order index while invalid optional indices are omitted',()=>{
  const state=E.createGame(),draft={type:'single',points:[{lat:35.68,lng:139.76},{lat:35.69,lng:139.77}],paused:false};
  for(const orderIndex of [0,2,200]){
    state.trackDraft={...draft,orderIndex};assert.deepEqual(E.deserializeGame(E.serializeGame(state)).trackDraft,state.trackDraft);
  }
  for(const orderIndex of [-1,201,1.5,'2',null,Infinity]){
    state.trackDraft={...draft,orderIndex};assert.deepEqual(E.deserializeGame(E.serializeGame(state)).trackDraft,draft,'invalid ordering metadata must not discard the edited stroke');
  }
});
