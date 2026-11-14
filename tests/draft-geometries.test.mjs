import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';

const point=(lng,lat=35.68)=>({lat,lng});
const host={type:'double',points:[point(139.76),point(139.78)],curveMode:'tangent',handles:[null,null]};
const crossover={type:'crossover',points:[point(139.765),point(139.77)],curveMode:'legacy',handles:[null,null]};

test('sequential visual geometry sees an earlier draft host without charging money or changing the world',()=>{
  E.setExistingNetwork(null);const state=E.createGame();state.money=1;state.trackDrafts=[host,crossover];const before=E.serializeGame(state);
  const geometries=E.planTrackDraftGeometries(state,[host,crossover]);assert.equal(geometries.length,2);
  assert.equal(geometries[0].ok,true,geometries[0].error);assert.equal(geometries[1].ok,true,geometries[1].error);assert.ok(geometries[1].points.length>=17);assert.ok(geometries[1].points[0].lat>35.68);assert.ok(geometries[1].points.at(-1).lat<35.68);
  assert.equal(E.serializeGame(state),before);assert.equal(E.previewTrackDrafts(state,[host,crossover]).ok,false,'funds still correctly block actual construction, not the visible shape');
  const funded=E.createGame(),built=E.buildTrackDrafts(funded,[host,crossover]);assert.equal(built.ok,true,built.error);assert.deepEqual(geometries.map(g=>g.points),built.tracks.map(track=>track.points));
});

test('visual geometry respects original stroke order and updates a later switch when the earlier host is edited',()=>{
  E.setExistingNetwork(null);const state=E.createGame();
  const reverse=E.planTrackDraftGeometries(state,[crossover,host]);assert.equal(reverse[0].ok,false);assert.equal(reverse[1].ok,true);
  const original=E.planTrackDraftGeometries(state,[host,crossover]);assert.equal(original[1].ok,true);
  const edited={...host,points:[point(139.76),point(139.764)]},updated=E.planTrackDraftGeometries(state,[edited,crossover]);
  assert.equal(updated[0].ok,true);assert.equal(updated[1].ok,false);assert.match(updated[1].error,/線路上/);assert.equal(state.tracks.length,0);
});

test('one-point and malformed draft geometry stays aligned, leaves valid later strokes usable and retains handles on repairable curves',()=>{
  E.setExistingNetwork(null);const state=E.createGame(),before=E.serializeGame(state),single={type:'single',points:[point(139.74)],curveMode:'point',handles:[null]};
  const inputs=[null,{type:'bad',points:[]},{type:'single',points:[null]},single,host,crossover],values=E.planTrackDraftGeometries(state,inputs);
  assert.equal(values.length,inputs.length);assert.deepEqual(values.slice(0,3).map(value=>value.ok),[false,false,false]);assert.equal(values[3].ok,true);assert.deepEqual(values[3].points,single.points);assert.equal(values[4].ok,true);assert.equal(values[5].ok,true);assert.equal(E.serializeGame(state),before);
  const tight={type:'single',points:[point(139.76),point(139.7601),point(139.7601,35.68003)],curveMode:'point',handles:[null,null,null]},failed=E.planTrackDraftGeometries(state,[tight])[0];
  assert.equal(failed.ok,false);assert.equal(failed.tangentHandles.length,3);assert.deepEqual(failed.points,tight.points);assert.equal(E.serializeGame(state),before);
});
