import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGrade, ElevationLookup } from '../dist/elevation.js';

test('grade uses horizontal geographic distance and reverses its sign when the two points reverse',()=>{
  const a={lat:35,lng:139,elevation:50},b={lat:35.0089932,lng:139,elevation:75};
  const forward=calculateGrade(a,b),back=calculateGrade(b,a);
  assert.ok(Math.abs(forward.horizontalDistance-1000)<.01);assert.ok(Math.abs(forward.permille-25)<.001);
  assert.equal(forward.elevationDifference,25);assert.equal(back.elevationDifference,-25);assert.ok(Math.abs(forward.permille+back.permille)<1e-9);
  assert.equal(calculateGrade(a,{...b,elevation:50}).permille,0);
  assert.throws(()=>calculateGrade(a,{...a,elevation:100}),/1m/);
  assert.throws(()=>calculateGrade(a,{...b,elevation:null}),/標高/);
});

test('elevation lookup encodes coordinates, preserves negative heights and caches successful point results',async()=>{
  let calls=0,url;const lookup=new ElevationLookup(async(value,options)=>{calls++;url=new URL(value,'http://localhost');assert.equal(url.pathname,'/api/elevation');assert.equal(options.credentials,'omit');return {ok:true,json:async()=>({elevation:-2.3,hsrc:'5m（レーザ）'})};});
  const point={lat:35.1234567,lng:139.7654321},first=await lookup.get(point);first.elevation=999;
  assert.equal((await lookup.get(point)).elevation,-2.3);assert.equal(calls,1);assert.equal(url.searchParams.get('lat'),'35.123457');assert.equal(url.searchParams.get('lon'),'139.765432');assert.equal(url.searchParams.get('outtype'),'JSON');
});

test('missing height, network failures and cancelled requests never become cached zero metre elevations',async()=>{
  let calls=0;const lookup=new ElevationLookup(async()=>{calls++;return {ok:true,json:async()=>({elevation:'-----',hsrc:'-----'})};});
  const point={lat:35,lng:139};await assert.rejects(lookup.get(point),/標高データがありません/);await assert.rejects(lookup.get(point),/標高/);assert.equal(calls,2);assert.equal(lookup.cache.size,0);
  const offline=new ElevationLookup(async()=>({ok:false}));await assert.rejects(offline.get(point),/通信/);
  const controller=new AbortController();controller.abort();const canceled=new ElevationLookup(async(_url,{signal})=>{signal.throwIfAborted();});
  await assert.rejects(canceled.get(point,controller.signal),{name:'AbortError'});assert.equal(canceled.cache.size,0);
  await assert.rejects(lookup.get({lat:100,lng:139}),/地点/);
});

test('browser fetch keeps its global receiver when used through the elevation lookup',async()=>{
  const lookup=new ElevationLookup(function(value){assert.equal(this,globalThis);assert.ok(value.startsWith('/api/elevation?'));return Promise.resolve({ok:true,json:async()=>({elevation:10,hsrc:'10m'})});});
  assert.equal((await lookup.get({lat:35,lng:139})).elevation,10);
});
