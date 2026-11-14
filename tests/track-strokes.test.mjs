import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';

const point=(lng,lat=35.68)=>({lat,lng});
const strokes=()=>[
  {type:'single',points:[point(139.76),point(139.765)]},
  {type:'single',points:[point(139.78),point(139.785)]},
];

test('separate archived draft strokes and the active stroke save independently without joining or charging construction',()=>{
  const state=E.createGame();state.trackDrafts=strokes();state.trackDraft={type:'double',points:[point(139.80),point(139.805)],paused:false};
  const loaded=E.deserializeGame(E.serializeGame(state));
  assert.deepEqual(loaded.trackDrafts,state.trackDrafts);assert.deepEqual(loaded.trackDraft,state.trackDraft);assert.equal(loaded.tracks.length,0);assert.equal(loaded.money,state.money);assert.equal(loaded.stats.construction,0);
  loaded.trackDrafts[0].points[0].lng=0;assert.equal(state.trackDrafts[0].points[0].lng,139.76);
  const old={...state};delete old.trackDrafts;assert.deepEqual(E.deserializeGame(old).trackDrafts,[]);
});

test('invalid archived strokes are dropped independently and archive limits preserve a usable world',()=>{
  const state=E.createGame(),valid=strokes()[0];state.money=54321;
  const loaded=E.deserializeGame({...state,trackDrafts:[null,{type:'bad',points:valid.points},{type:'single',points:[]},{type:'single',points:[null]},{type:'single',points:Array(2)},valid,{type:'double',points:[point(139.77)]}]});
  assert.deepEqual(loaded.trackDrafts,[valid,{type:'double',points:[point(139.77)]}]);assert.equal(loaded.money,54321);assert.deepEqual(loaded.tracks,[]);
  const capped=E.deserializeGame({...state,trackDrafts:Array.from({length:201},()=>valid)});assert.equal(capped.trackDrafts.length,200);
  const large={type:'single',points:Array.from({length:9999},()=>point(139.76))};
  assert.deepEqual(E.deserializeGame({...state,trackDrafts:[large,valid,{type:'single',points:[point(139.77)]}]}).trackDrafts.map(stroke=>stroke.points.length),[9999,1]);
});

test('building multiple separate strokes creates no implicit bridge and reports their aggregate cost',()=>{
  E.setExistingNetwork(null);const state=E.createGame(),money=state.money;
  const result=E.buildTrackDrafts(state,strokes());assert.equal(result.ok,true,result.error);assert.equal(result.tracks.length,2);assert.equal(state.tracks.length,2);
  assert.equal(state.money,money-result.cost.total);assert.equal(state.stats.construction,result.cost.total);assert.equal(result.totalCost,result.cost.total);
  assert.deepEqual(result.tracks.map(track=>track.points),strokes().map(stroke=>stroke.points));
  const west=E.buildStation(state,point(139.762),1,'西'),east=E.buildStation(state,point(139.782),1,'東');
  assert.equal(west.ok,true,west.error);assert.equal(east.ok,true,east.error);assert.equal(E.findPath(state,west.station.id,east.station.id),null);
});

test('connected separate strokes retain a shared snapped endpoint and form a continuous route',()=>{
  E.setExistingNetwork(null);const state=E.createGame(),drafts=[{type:'single',points:[point(139.76),point(139.765)]},{type:'single',points:[point(139.765),point(139.77)]}];
  const built=E.buildTrackDrafts(state,drafts);assert.equal(built.ok,true,built.error);assert.deepEqual(built.tracks[0].points.at(-1),built.tracks[1].points[0]);
  const west=E.buildStation(state,point(139.762),1,'西'),east=E.buildStation(state,point(139.768),1,'東');
  assert.equal(west.ok,true,west.error);assert.equal(east.ok,true,east.error);const route=E.createRoute(state,{startId:west.station.id,endId:east.station.id});assert.equal(route.ok,true,route.error);
  assert.ok(route.route.trackIds.includes(built.tracks[0].id));assert.ok(route.route.trackIds.includes(built.tracks[1].id));
});

test('any invalid stroke or late funds failure rolls back every draft construction and charge',()=>{
  E.setExistingNetwork(null);const drafts=strokes(),state=E.createGame();state.trackDrafts=drafts;state.trackDraft={type:'single',points:[point(139.80)],paused:false};
  const crossing={type:'single',points:[point(139.763,35.679),point(139.763,35.681)]};
  for(const invalid of [[drafts[0],crossing],[drafts[0],{type:'single',points:[point(139.78)]}],[drafts[0],{type:'unknown',points:drafts[1].points}],[drafts[0],{type:'single',points:Array(2)}]]){
    const before=E.serializeGame(state);assert.equal(E.buildTrackDrafts(state,invalid).ok,false);assert.equal(E.serializeGame(state),before);
  }
  state.money=E.estimateTrackCost(drafts[0].points,'single',state).total+Math.floor(E.estimateTrackCost(drafts[1].points,'single',state).total/2);
  const before=E.serializeGame(state),failed=E.buildTrackDrafts(state,drafts);assert.equal(failed.ok,false);assert.match(failed.error,/所持金/);assert.equal(E.serializeGame(state),before);
});

test('batch preview validates a later crossover against its earlier draft host and matches committed costs without changing the world',()=>{
  E.setExistingNetwork(null);const state=E.createGame();
  const drafts=[{type:'double',points:[point(139.76),point(139.78)]},{type:'crossover',points:[point(139.765),point(139.77)]}];
  state.trackDrafts=drafts;const before=E.serializeGame(state);
  assert.equal(E.previewTrackDrafts(state,[drafts[1]]).ok,false,'a crossover alone has no built host');
  const preview=E.previewTrackDrafts(state,drafts);assert.equal(preview.ok,true,preview.error);assert.equal(preview.tracks.length,2);assert.equal(E.serializeGame(state),before);
  assert.equal(preview.tracks[1].hostTrackId,preview.tracks[0].id);
  const built=E.buildTrackDrafts(state,drafts);assert.equal(built.ok,true,built.error);assert.deepEqual(built.cost,preview.cost);assert.equal(built.totalCost,preview.totalCost);assert.equal(built.tracks[1].hostTrackId,built.tracks[0].id);
  const blank=E.createGame(),invalid=[drafts[0],{type:'crossover',points:[point(139.765,35.69),point(139.77,35.69)]}],saved=E.serializeGame(blank);
  const rejected=E.previewTrackDrafts(blank,invalid);assert.equal(rejected.ok,false);assert.equal(rejected.invalidStrokeIndex,1);assert.equal(E.serializeGame(blank),saved);
  assert.equal(E.buildTrackDrafts(blank,invalid).ok,false);assert.equal(E.serializeGame(blank),saved);
});
