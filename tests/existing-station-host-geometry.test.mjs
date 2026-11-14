import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';
import {ExistingRailwayNetwork} from '../dist/existing-network.js';

const origin={lat:35.68,lng:139.76},rad=Math.PI/180,earth=6371008.8,cosine=Math.cos(origin.lat*rad);
const point=(x,y=0)=>({lat:origin.lat+y/earth/rad,lng:origin.lng+x/earth/rad/cosine});
const line=(a,b)=>({type:'Feature',properties:{type:'rail'},geometry:{type:'LineString',coordinates:[a,b].map(p=>[p.lng,p.lat])}});
const source=(id,x)=>({type:'Feature',properties:{type:'station',id,name:id},geometry:{type:'Point',coordinates:[point(x).lng,point(x).lat]}});
const opts={placement:'track',layoutId:'island-8',existingTrackId:'existing:1',wiringMode:'merged'};
const network=()=>new ExistingRailwayNetwork({type:'FeatureCollection',features:[line(point(-1000),point(-40)),line(point(-40),point(40)),line(point(40),point(1000)),source('west',-600),source('east',600)]});

test('large blue-line stations span artificial source fragments and route through their real privately built platforms',()=>{
  const provider=network();E.setExistingNetwork(provider);const state=E.createGame(),before=E.serializeGame(state),sourceBefore=JSON.stringify([...provider.tracks.values()]);
  const preview=E.previewStation(state,origin,8,opts);assert.equal(preview.ok,true,preview.error);assert.equal(E.serializeGame(state),before);
  assert.deepEqual(preview.existingHostConnections.map(connection=>connection.trackId),['existing:0','existing:2']);assert.ok(preview.hostTrackPoints.length>=4);
  const built=E.buildStation(state,origin,8,'分割データを跨ぐ駅',opts);assert.equal(built.ok,true,built.error);assert.equal(built.cost,preview.cost);assert.equal(state.tracks.length,7);
  const west=E.useExistingStation(state,provider.getStation('west')),east=E.useExistingStation(state,provider.getStation('east'));assert.equal(west.ok,true,west.error);assert.equal(east.ok,true,east.error);
  const requested={forward:{[built.station.id]:1},backward:{[built.station.id]:8}},route=E.createRoute(state,{startId:west.station.id,endId:east.station.id,platformAssignments:requested});assert.equal(route.ok,true,route.error);
  const platforms=E.getStationPlatforms(state,built.station);assert.ok(route.route.trackIds.includes(platforms[0].trackId));assert.ok(route.route.trackIds.includes(platforms[7].trackId));
  assert.equal(JSON.stringify([...provider.tracks.values()]),sourceBefore);
  E.setExistingNetwork(null);const loaded=E.deserializeGame(E.serializeGame(state));assert.deepEqual(loaded.stations[0].existingHostConnections,built.station.existingHostConnections);
  E.setExistingNetwork(provider);assert.ok(E.findPath(loaded,west.station.id,east.station.id,{platforms:requested.forward}));E.setExistingNetwork(null);
});

test('source continuation picks the tangent-connected rail and never jumps onto a nearby unconnected parallel line',()=>{
  const provider=new ExistingRailwayNetwork({type:'FeatureCollection',features:[line(point(-1000),point(-40)),line(point(-40),point(40)),line(point(40),point(1000)),line(point(-1000,5),point(1000,5)),line(point(40),point(40,1000))]});
  E.setExistingNetwork(provider);const state=E.createGame(),preview=E.previewStation(state,origin,8,opts);assert.equal(preview.ok,true,preview.error);
  assert.deepEqual(preview.existingHostConnections.map(connection=>connection.trackId),['existing:0','existing:2']);assert.ok(preview.hostTrackPoints.every(p=>Math.abs(p.lat-origin.lat)<1e-9));
  const parallelOnly=new ExistingRailwayNetwork({type:'FeatureCollection',features:[line(point(-40),point(40)),line(point(-1000,5),point(1000,5))]});E.setExistingNetwork(parallelOnly);
  const invalid=E.previewStation(state,origin,8,{...opts,existingTrackId:'existing:0'});assert.equal(invalid.ok,false);assert.match(invalid.error,/長さが不足/);assert.equal(state.tracks.length,0);E.setExistingNetwork(null);
});

test('a real shared-rail dead end rejects yards that cannot fit without folding and preserves the world',()=>{
  const provider=new ExistingRailwayNetwork({type:'FeatureCollection',features:[line(point(-50),point(50))]});E.setExistingNetwork(provider);const state=E.createGame(),saved=E.serializeGame(state);
  const result=E.buildStation(state,origin,8,'短すぎる駅',{...opts,existingTrackId:'existing:0'});assert.equal(result.ok,false);assert.match(result.error,/長さが不足/);assert.equal(E.serializeGame(state),saved);
  assert.equal(E.previewStation(state,origin,8,{placement:'track',layoutId:'side-1',existingTrackId:'existing:0',wiringMode:'merged'}).ok,true,'old single-platform source placements remain compatible');E.setExistingNetwork(null);
});

test('a multi-platform station at a selected source feature start preserves its zero source offset when reloaded beside its own sidings',()=>{
  const provider=network();E.setExistingNetwork(provider);const state=E.createGame(),built=E.buildStation(state,point(-40),8,'区切り点の駅',opts);
  assert.equal(built.ok,true,built.error);assert.equal(built.station.offset,0);assert.equal(state.tracks.length,7);
  E.setExistingNetwork(null);const loaded=E.deserializeGame(E.serializeGame(state));assert.equal(loaded.stations[0].offset,0);assert.deepEqual(loaded.stations[0].existingHostConnections,built.station.existingHostConnections);
});
