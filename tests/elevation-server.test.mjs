import test from 'node:test';
import assert from 'node:assert/strict';
import { createElevationHandler } from '../elevation-server.mjs';

async function request(handler, query = '?lat=35&lon=139', method = 'GET') {
  let status, headers, body;
  const res = { writeHead(value, fields) { status=value;headers=fields; }, end(value) { body=JSON.parse(value); } };
  await handler({ method, url:`/api/elevation${query}` }, res);
  return { status, headers, body };
}

test('the elevation proxy accepts numeric coordinates and sends only a fixed GSI request',async()=>{
  let calls=0,seen;
  const handler=createElevationHandler({fetchImpl:async(value,options)=>{calls++;seen=new URL(value);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.ok(options.signal);return {ok:true,json:async()=>({elevation:'-2.3',hsrc:'5m（レーザ）',untrusted:'ignored'})};}});
  const result=await request(handler,'?lat=35.1234567&lon=139.7654321&url=https://example.com');
  assert.equal(result.status,200);assert.deepEqual(result.body,{elevation:-2.3,hsrc:'5m（レーザ）'});
  assert.equal(seen.origin,'https://cyberjapandata2.gsi.go.jp');assert.equal(seen.pathname,'/general/dem/scripts/getelevation.php');
  assert.equal(seen.searchParams.get('lat'),'35.123457');assert.equal(seen.searchParams.get('lon'),'139.765432');assert.equal(seen.searchParams.get('outtype'),'JSON');assert.equal(seen.searchParams.has('url'),false);
  assert.equal(result.headers['Content-Type'],'application/json; charset=utf-8');assert.equal(calls,1);
});

test('blank, missing, repeated, nonnumeric and out-of-range coordinates never reach GSI',async()=>{
  let calls=0;const handler=createElevationHandler({fetchImpl:async()=>{calls++;throw new Error('must not fetch');}});
  for(const query of ['', '?lat=&lon=139','?lat=%20&lon=139','?lat=35&lon=','?lat=Infinity&lon=139','?lat=NaN&lon=139','?lat=86&lon=139','?lat=35&lon=181','?lat=35&lat=36&lon=139','?lat=35&lon=139&lon=140','?lat=https://example.com&lon=139'])assert.equal((await request(handler,query)).status,400,query);
  const method=await request(handler,'?lat=35&lon=139','POST');assert.equal(method.status,405);assert.equal(method.headers.Allow,'GET');assert.equal(calls,0);
});

test('successful coordinates are cached with a bounded eviction policy while no-data responses stay uncached',async()=>{
  let calls=0;const handler=createElevationHandler({maxCacheEntries:2,fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({elevation:0,hsrc:'10m'})};}});
  await request(handler,'?lat=35&lon=139');await request(handler,'?lat=35.0000000&lon=139.000000');assert.equal(calls,1);
  await request(handler,'?lat=36&lon=139');await request(handler,'?lat=37&lon=139');await request(handler,'?lat=35&lon=139');assert.equal(calls,4);
  let missingCalls=0;const missing=createElevationHandler({fetchImpl:async()=>{missingCalls++;return {ok:true,json:async()=>({elevation:'-----',hsrc:'-----'})};}});
  assert.deepEqual((await request(missing)).body,{elevation:'-----',hsrc:'-----'});assert.equal((await request(missing)).status,200);assert.equal(missingCalls,2);
});

test('HTTP, connection and malformed upstream failures return 502 without caching a false elevation',async()=>{
  for(const fetchImpl of [async()=>({ok:false}),async()=>{throw new Error('offline');},async()=>({ok:true,json:async()=>{throw new Error('bad JSON');}}),async()=>({ok:true,json:async()=>({other:1})}),async()=>({ok:true,json:async()=>({elevation:false})}),async()=>({ok:true,json:async()=>({elevation:'nonsense'})})]){
    let calls=0;const handler=createElevationHandler({fetchImpl:(...args)=>{calls++;return fetchImpl(...args);}});
    assert.equal((await request(handler)).status,502);assert.equal((await request(handler)).status,502);assert.equal(calls,2);
  }
});

test('a timed-out upstream request is aborted and returns 504',async()=>{
  let signal;const handler=createElevationHandler({timeoutMs:5,fetchImpl:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}});
  const result=await request(handler);assert.equal(result.status,504);assert.equal(signal.aborted,true);
});
