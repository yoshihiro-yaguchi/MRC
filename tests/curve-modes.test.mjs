import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';

const origin={lat:35.68,lng:139.76},rad=Math.PI/180,earth=6371008.8,cosine=Math.cos(origin.lat*rad);
const point=(x,y)=>({lat:origin.lat+y/earth/rad,lng:origin.lng+x/earth/rad/cosine});
const controls=[point(0,0),point(500,400),point(1000,0)];
const xy=p=>({x:(p.lng-origin.lng)*earth*rad*cosine,y:(p.lat-origin.lat)*earth*rad});
const nearest=(points,target)=>Math.min(...points.map(p=>E.distance(p,target)));

test('tangent mode uses a quadratic control polygon instead of passing through its middle control',()=>{
  const result=E.planTrackPoints(controls,'double',null,{curveMode:'tangent'});
  assert.equal(result.ok,true,result.error);assert.deepEqual(result.points[0],controls[0]);assert.deepEqual(result.points.at(-1),controls.at(-1));
  assert.ok(nearest(result.points,controls[1])>100,'the tangent control limits shape instead of becoming a waypoint');
  for(const p of result.points){const value=xy(p);assert.ok(value.x>=-1e-6&&value.x<=1000+1e-6);assert.ok(value.y>=-1e-6&&value.y<=400+1e-6);}
  assert.ok(result.minRadius>19);assert.ok(result.points.length>20);
});

test('multi-control tangent curves meet with matching tangent directions at their midpoint joins',()=>{
  const values=[point(0,0),point(500,400),point(1000,400),point(1500,0)],result=E.planTrackPoints(values,'single',null,{curveMode:'tangent'});
  assert.equal(result.ok,true,result.error);const join=point(750,400),index=result.points.findIndex(p=>E.distance(p,join)<1e-6);assert.ok(index>0&&index<result.points.length-1);
  const before=xy(result.points[index-1]),at=xy(result.points[index]),after=xy(result.points[index+1]);
  const a={x:at.x-before.x,y:at.y-before.y},b={x:after.x-at.x,y:after.y-at.y};
  assert.ok((a.x*b.x+a.y*b.y)/(Math.hypot(a.x,a.y)*Math.hypot(b.x,b.y))>.99);
  assert.ok(nearest(result.points,values[1])>20);assert.ok(nearest(result.points,values[2])>20);
});

test('point mode passes every control and returns automatic outgoing handles that share a smooth tangent',()=>{
  const result=E.planTrackPoints(controls,'double',null,{curveMode:'point'});
  assert.equal(result.ok,true,result.error);assert.equal(result.tangentHandles.length,controls.length);
  for(const control of controls)assert.ok(nearest(result.points,control)<1e-6);
  assert.deepEqual(result.points[0],controls[0]);assert.deepEqual(result.points.at(-1),controls.at(-1));
  const middle=xy(result.tangentHandles[1]);assert.ok(Math.abs(middle.x-(500+1000/6))<1e-6);assert.ok(Math.abs(middle.y-400)<1e-6);
  const index=result.points.findIndex(p=>E.distance(p,controls[1])<1e-6),before=xy(result.points[index-1]),after=xy(result.points[index+1]);
  assert.ok(after.x>before.x);assert.ok(Math.abs(after.y-before.y)<1e-5);
});

test('an explicit outgoing handle changes the point curve and its mirrored incoming tangent while keeping the waypoint fixed',()=>{
  const handle=point(700,500),result=E.planTrackPoints(controls,'single',null,{curveMode:'point',handles:[null,handle,null]});
  assert.equal(result.ok,true,result.error);assert.ok(E.distance(result.tangentHandles[1],handle)<1e-6);
  const index=result.points.findIndex(p=>E.distance(p,controls[1])<1e-6);assert.ok(index>0);
  const before=xy(result.points[index-1]),after=xy(result.points[index+1]);assert.ok(before.y<400);assert.ok(after.y>400);
  const automatic=E.planTrackPoints(controls,'single',null,{curveMode:'point'});assert.notDeepEqual(result.points,automatic.points);
});

test('invalid, excessive, tight and reversing curve settings fail safely and retain repairable point handles',()=>{
  for(const options of [{curveMode:'unknown'},{curveMode:'point',handles:[null]},{curveMode:'point',handles:[null,{lat:99,lng:139},null]},{curveMode:'point',handles:[null,point(100000,0),null]}])assert.equal(E.planTrackPoints(controls,'single',null,options).ok,false);
  const tight=E.planTrackPoints([point(0,0),point(10,0),point(10,3)],'double',null,{curveMode:'point'});assert.equal(tight.ok,false);assert.equal(tight.tangentHandles.length,3);assert.match(tight.error,/曲線/);
  const reverse=E.planTrackPoints([point(0,0),point(100,0),point(0,0)],'single',null,{curveMode:'point'});assert.equal(reverse.ok,false);assert.equal(reverse.tangentHandles.length,3);
  const state=E.createGame(),before=E.serializeGame(state);assert.equal(E.buildTrack(state,controls,'single',{curveMode:'point',handles:[null]}).ok,false);assert.equal(E.serializeGame(state),before);
});

test('curve metadata survives draft and owned-track saving, and batch preview matches committed curved geometry and costs',()=>{
  E.setExistingNetwork(null);const state=E.createGame(),draft={type:'single',points:controls,curveMode:'point',handles:[null,point(700,500),null]};
  state.trackDrafts=[draft];state.trackDraft={type:'double',points:[point(0,2000),point(500,2400),point(1000,2000)],paused:false,curveMode:'tangent',handles:[null,null,null]};
  const loaded=E.deserializeGame(E.serializeGame(state));assert.deepEqual(loaded.trackDrafts[0],draft);assert.deepEqual(loaded.trackDraft,state.trackDraft);
  const before=E.serializeGame(state),preview=E.previewTrackDrafts(state,[draft]);assert.equal(preview.ok,true,preview.error);assert.equal(E.serializeGame(state),before);
  const built=E.buildTrackDrafts(state,[draft]);assert.equal(built.ok,true,built.error);assert.deepEqual(built.cost,preview.cost);assert.deepEqual(built.tracks[0].points,preview.tracks[0].points);
  assert.equal(built.tracks[0].curveMode,'point');assert.deepEqual(built.tracks[0].controlPoints,controls);assert.deepEqual(built.tracks[0].handles,draft.handles);
  const restored=E.deserializeGame(E.serializeGame(state));assert.deepEqual(restored.tracks[0].controlPoints,controls);assert.deepEqual(restored.tracks[0].handles,draft.handles);assert.equal(restored.tracks[0].curveMode,'point');
  assert.ok(nearest(restored.tracks[0].points,controls[1])<1e-6);
});

test('missing curve mode keeps legacy geometry while corrupt optional curve metadata does not discard a valid world',()=>{
  const implicit=E.planTrackPoints(controls),legacy=E.planTrackPoints(controls,'double',null,{curveMode:'legacy'});assert.equal(implicit.ok,true,implicit.error);assert.deepEqual(implicit.points,legacy.points);
  const state=E.createGame(),built=E.buildTrack(state,[point(0,0),point(1000,0)],'single');assert.equal(built.ok,true,built.error);
  built.track.curveMode='bad';built.track.controlPoints=controls;
  state.trackDrafts=[{type:'single',points:controls,curveMode:'bad'},{type:'single',points:[point(0,2000),point(1000,2000)]}];
  const loaded=E.deserializeGame(E.serializeGame(state));assert.equal(loaded.tracks.length,1);assert.equal(loaded.tracks[0].curveMode,undefined);assert.equal(loaded.trackDrafts.length,1);assert.equal(loaded.trackDrafts[0].curveMode,undefined);
});
