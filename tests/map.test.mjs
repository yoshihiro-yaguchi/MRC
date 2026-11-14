import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { RailwayMap, planStationLabelVisibility } from '../dist/map.js';
import { stationGeometry } from '../dist/engine.js';
import { ExistingRailwayNetwork } from '../dist/existing-network.js';

// Geometry and input regressions run without a DOM or remote map tiles.
function map() {
  const value = Object.create(RailwayMap.prototype);
  Object.assign(value, { width: 1200, height: 800, view: {lat:35.6812,lng:139.7671,zoom:14}, callbacks:{}, requestRender() {}, state:{tracks:[],stations:[],routes:[]} });
  return value;
}

test('Mercator round trip preserves Japanese coordinates across zoom levels', () => {
  const m = map();
  for (const zoom of [4, 9, 14, 19, 22]) {
    m.view.zoom = zoom;
    for (const point of [{lat:35.6812,lng:139.7671},{lat:43.0621,lng:141.3544},{lat:26.2124,lng:127.6809}]) {
      const restored = m.screenToLatLng(m.latLngToScreen(point));
      assert.ok(Math.abs(restored.lat-point.lat)<1e-9);
      assert.ok(Math.abs(restored.lng-point.lng)<1e-9);
    }
  }
});

test('wheel zoom preserves the geographic point underneath the pointer', () => {
  const m = map(), pointer={x:1090,y:170};
  const before=m.screenToLatLng(pointer);
  m.zoomAt(2,pointer);
  const after=m.screenToLatLng(pointer);
  assert.ok(Math.abs(before.lat-after.lat)<1e-9);
  assert.ok(Math.abs(before.lng-after.lng)<1e-9);
  assert.equal(m.view.zoom,16);
});

test('fitPoints includes both endpoints within its padding', () => {
  const m=map(), points=[{lat:35.6,lng:139.4},{lat:35.95,lng:140.1}];
  m.fitPoints(points,60);
  for (const point of points) {const p=m.latLngToScreen(point);assert.ok(p.x>=60&&p.x<=1140);assert.ok(p.y>=60&&p.y<=740);}
});

test('station snap projects onto a nearby built track and rejects distant points', () => {
  const m=map();
  m.state.tracks=[{id:'track',type:'double',points:[{lat:35.68,lng:139.76},{lat:35.68,lng:139.78}]}];
  const onTrack=m.nearestTrack({lat:35.6801,lng:139.77});
  assert.equal(onTrack.trackId,'track');
  assert.ok(Math.abs(onTrack.lat-35.68)<1e-8);
  assert.equal(m.nearestTrack({lat:35.7,lng:139.77}),null);
});

test('zoom bounds are enforced', () => {
  const m=map();m.setView({zoom:30});assert.equal(m.view.zoom,22);m.setView({zoom:-5});assert.equal(m.view.zoom,4);
});

test('high zoom reuses the maximum native tile zoom',()=>{
  const m=map();m.layer='standard';m.view.zoom=22;const requests=[];
  m.tile=(z,x,y)=>{requests.push({z,x,y});return null;};
  m.drawTiles({},m.center,m.worldSize);
  assert.ok(requests.length>0);assert.ok(requests.every(request=>request.z===19));
  m.layer='satellite';requests.length=0;m.drawTiles({},m.center,m.worldSize);assert.ok(requests.every(request=>request.z===18));
  m.layer='relief';requests.length=0;m.drawTiles({},m.center,m.worldSize);assert.ok(requests.every(request=>request.z===15));
});

test('relief tiles stay within GSI native zoom limits and scale down correctly at nationwide zoom',()=>{
  const m=map(),requests=[],drawn=[];m.layer='relief';
  m.tile=(z,x,y)=>{requests.push({z,x,y});return {ready:true,image:{}};};const ctx={drawImage(...args){drawn.push(args);}};
  for(const zoom of [4,5,10.6,15,18,22]){
    requests.length=0;drawn.length=0;m.view.zoom=zoom;m.drawTiles(ctx,m.center,m.worldSize);
    assert.ok(requests.length>0);assert.ok(requests.every(request=>request.z===Math.max(5,Math.min(15,Math.floor(zoom)))));
    const expectedSpan=256*2**(zoom-requests[0].z);
    assert.ok(drawn.every(args=>args[3]===Math.ceil(expectedSpan)+.5&&args[4]===Math.ceil(expectedSpan)+.5));
    assert.ok(drawn.every(args=>Number.isFinite(args[1])&&Number.isFinite(args[2])));
    if(zoom===4)assert.equal(drawn[0][3],128.5,'zoom5 tiles are underscaled rather than requesting nonexistent zoom4 relief tiles');
  }
});

test('relief uses official GSI tile URLs, separate layer caches, and a working retry without changing overlays',()=>{
  const m=map(),originalImage=globalThis.Image;m.tiles=new Map();m.tileErrors=0;m.retryButton={hidden:true};m.state.populationVisible=true;
  const state=m.state;m.options={populationVisible:true,mode:'track'};const errors=[];m.callbacks.onTileError=error=>errors.push(error);
  globalThis.Image=class {};
  try{
    m.setLayer('relief');const relief=m.tile(10,901,402);assert.equal(relief.image.src,'https://cyberjapandata.gsi.go.jp/xyz/relief/10/901/402.png');
    assert.equal(m.tile(10,901,402),relief);assert.equal(relief.image.crossOrigin,'anonymous');
    m.setLayer('standard');const standard=m.tile(10,901,402);assert.notEqual(standard,relief);assert.equal(standard.image.src,'https://tile.openstreetmap.org/10/901/402.png');
    relief.image.onerror();assert.equal(errors[0].layer,'relief');assert.equal(m.tileErrors,0,'a previous background failure cannot show a retry for the current layer');
    m.setLayer('relief');for(const x of [900,902,903])m.tile(10,x,402).image.onerror();assert.equal(m.retryButton.hidden,false);
    m.retryTiles();assert.equal(m.tiles.size,0);assert.equal(m.retryButton.hidden,true);assert.equal(m.tileErrors,0);assert.notEqual(m.tile(10,901,402),relief);
    assert.equal(m.state,state);assert.equal(m.state.populationVisible,true);assert.equal(m.options.populationVisible,true);
  }finally{globalThis.Image=originalImage;}
});

test('a two finger pinch doubles zoom while preserving its geographic center',()=>{
  const m=map();m.pointers=new Map([[1,{x:400,y:400}],[2,{x:600,y:400}]]);m.eventPoint=e=>e.point;
  const anchor=m.screenToLatLng({x:500,y:400});
  const normalized=m.center,size=m.worldSize;
  m.pinch={distance:100,zoom:14,anchor:{x:normalized.x+(500-m.width/2)/size,y:normalized.y}};
  m.pointerMove({pointerId:2,point:{x:600,y:400}});
  assert.equal(m.view.zoom,15);
  const after=m.screenToLatLng({x:500,y:400});assert.ok(Math.abs(after.lat-anchor.lat)<1e-9);assert.ok(Math.abs(after.lng-anchor.lng)<1e-9);
});

test('national railway data loads as drawable paths and queryable real stations',async()=>{
  const m=map();Object.assign(m,{railPaths:[],existingStations:[],container:{dataset:{}}});
  let suppliedData=null;m.callbacks.onRailwaysLoaded=data=>{suppliedData=data;};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>JSON.parse(await readFile(new URL('../dist/data/railways.json',import.meta.url),'utf8'))});
  try {
    await m.loadRailways();
    assert.ok(m.railPaths.length>20000);assert.ok(m.existingStations.length>9000);
    const tokyo=m.existingStations.find(station=>station.name==='東京');assert.ok(tokyo);
    assert.ok(Number.isFinite(tokyo.x));assert.ok(Number.isFinite(tokyo.y));
    assert.ok(m.railPaths.some(path=>path.type==='shinkansen'));
    assert.equal(m.container.dataset.railwaysError,undefined);
    assert.equal(suppliedData.type,'FeatureCollection');assert.ok(suppliedData.features.length>20000);
  } finally {globalThis.fetch=originalFetch;}
});

test('station preview marks endpoint overhang, overlap, and insufficient funds invalid',()=>{
  const m=map();m.state={money:1e11,tracks:[{id:'main',type:'double',points:[{lat:35.68,lng:139.76},{lat:35.68,lng:139.78}]}],stations:[],routes:[]};
  const middle=m.nearestTrack({lat:35.68,lng:139.77});assert.equal(m.stationPreviewValid(middle,5),true);
  const endpoint=m.nearestTrack({lat:35.68,lng:139.76});assert.equal(m.stationPreviewValid(endpoint,5),false);
  m.state.money=1;assert.equal(m.stationPreviewValid(middle,5),false);m.state.unlimited=true;assert.equal(m.stationPreviewValid(middle,5),true);
  m.state.stations.push({id:'other',trackId:'main',cars:5,offset:904});assert.equal(m.stationPreviewValid(middle,5),false);
});

test('scissors drawing mirrors the S path across its physical host rails',()=>{
  const m=map();m.view.zoom=22;
  m.state.tracks=[{id:'main',type:'double',points:[{lat:35.68,lng:139.76},{lat:35.68,lng:139.78}]}];
  const crossing={type:'scissors',hostTrackId:'main',points:[{lat:35.68001,lng:139.765},{lat:35.680007,lng:139.766},{lat:35.679993,lng:139.769},{lat:35.67999,lng:139.77}]};
  const reflected=m.mirrorScissorsPoints(crossing),hostY=m.latLngToScreen({lat:35.68,lng:139.765}).y;
  crossing.points.forEach((point,i)=>{const a=m.latLngToScreen(point),b=m.latLngToScreen(reflected[i]);assert.ok(Math.abs(a.x-b.x)<1e-4);assert.ok(Math.abs(a.y+b.y-2*hostY)<1e-4);});
});

test('a scissors preview resolves its missing host only once instead of querying once for every owned track',()=>{
  const m=map();let queries=0;
  m.state.tracks=Array.from({length:200},(_,index)=>({id:`track-${index}`,type:'single',points:[{lat:35.68,lng:139.76},{lat:35.68,lng:139.78}]}));
  m.nearestTrack=()=>{queries++;return {trackId:'track-199'};};
  const points=[{lat:35.68001,lng:139.765},{lat:35.67999,lng:139.77}];assert.equal(m.mirrorScissorsPoints({points}).length,2);assert.equal(queries,1);
});

test('planning draws supplied preview geometry without appending a straight hover segment',()=>{
  const m=map(),controlPoints=[{lat:35.68,lng:139.76},{lat:35.68,lng:139.77}],previewPoints=[...controlPoints,{lat:35.6802,lng:139.772},{lat:35.6808,lng:139.774}];
  m.options={plan:previewPoints,previewPoints,controlPoints,hover:{lat:35.682,lng:139.78},mode:'track',trackType:'double',previewInvalid:true};
  let drawn=null,dots=0;m.drawTrack=(_ctx,track)=>{drawn=track;};
  const ctx={beginPath(){},arc(){dots++;},fill(){},stroke(){}};
  m.drawPlan(ctx);
  assert.deepEqual(drawn.points,previewPoints);assert.equal(drawn.invalid,true);assert.equal(dots,controlPoints.length);
});

test('application validation can explicitly reject a station hover preview',()=>{
  const m=map();m.state.tracks=[{id:'main',type:'double',points:[{lat:35.68,lng:139.76},{lat:35.68,lng:139.78}]}];
  m.options={mode:'station',plan:[],hover:{lat:35.68,lng:139.77},platformCars:5,stationPreviewInvalid:true};
  let drawn;m.drawStation=(_ctx,station)=>{drawn=station;};
  m.drawPlan({});assert.equal(drawn.valid,false);assert.equal(drawn.cars,5);
});

test('plan point selection uses a constant screen tolerance before track snapping',()=>{
  const m=map(), control={lat:35.68,lng:139.77};
  m.options={controlPoints:[control]};
  for (const zoom of [9,14,22]) {
    m.setView({...control,zoom});
    const position=m.latLngToScreen(control);
    assert.equal(m.nearestPlanPoint(m.screenToLatLng({x:position.x+8,y:position.y})).index,0);
    assert.equal(m.nearestPlanPoint(m.screenToLatLng({x:position.x+12,y:position.y})),null);
  }
});

test('plan selection chooses the nearest control point rather than a sampled curve vertex',()=>{
  const m=map(), first=m.screenToLatLng({x:400,y:400}), second=m.screenToLatLng({x:412,y:400});
  m.options={controlPoints:[first,second],plan:[first,m.screenToLatLng({x:406,y:400}),second]};
  assert.equal(m.nearestPlanPoint(m.screenToLatLng({x:410,y:400})).index,1);
  m.options.controlPoints=[];
  assert.equal(m.nearestPlanPoint(first),null);
});

test('archived strokes and a new active stroke draw as separate geometries without a connecting segment',()=>{
  const m=map(),p=(x,y)=>m.screenToLatLng({x,y}),first=[p(200,300),p(350,300)],second=[p(700,500),p(850,500)],active=[p(500,100),p(600,100)];
  const curved=[first[0],p(270,280),first[1]],drawn=[],dots=[];
  m.options={mode:'track',draftStrokes:[{type:'single',points:first,previewPoints:curved},{type:'double',points:second,invalid:true}],plan:active,previewPoints:active,controlPoints:active};
  m.drawTrack=(_ctx,track)=>drawn.push(track);
  m.drawPlan({beginPath(){},arc(x,y,r){dots.push({x,y,r});},fill(){},stroke(){}});
  assert.equal(drawn.length,3);assert.deepEqual(drawn[0].points,curved);assert.deepEqual(drawn[1].points,second);assert.deepEqual(drawn[2].points,active);
  assert.equal(drawn[0].type,'single');assert.equal(drawn[1].type,'double');assert.equal(drawn[1].invalid,true);
  assert.equal(dots.length,6);assert.ok(dots.every(dot=>dot.r===4.5));
});

test('draft endpoint snapping selects archived ends and active last point using a fixed screen tolerance',()=>{
  const m=map();
  for(const zoom of [9,14,22]){
    m.view.zoom=zoom;const p=(x,y)=>m.screenToLatLng({x,y}),start=p(300,300),middle=p(400,200),end=p(500,300),activeFirst=p(700,200),activeEnd=p(800,300);
    m.options={draftStrokes:[{points:[start,middle,end]}],controlPoints:[activeFirst,activeEnd]};
    let hit=m.nearestDraftEndpoint(p(306,300));assert.equal(hit.active,false);assert.equal(hit.end,'start');assert.equal(hit.strokeIndex,0);assert.deepEqual(hit.point,start);
    hit=m.nearestDraftEndpoint(p(507,300));assert.equal(hit.end,'end');assert.equal(hit.active,false);
    hit=m.nearestDraftEndpoint(p(809,300));assert.equal(hit.active,true);assert.equal(hit.strokeIndex,-1);assert.deepEqual(hit.point,activeEnd);
    assert.equal(m.nearestDraftEndpoint(p(813,300)),null);assert.equal(m.nearestDraftEndpoint(middle),null);assert.equal(m.nearestDraftEndpoint(activeFirst),null);
    m.options.controlPoints=[start,end];assert.equal(m.nearestDraftEndpoint(end).active,true,'active last point wins a tie with an archived endpoint');
  }
});

test('draft snap cue enlarges only its endpoint and preserves active point cancellation feedback',()=>{
  const m=map(),location=m.screenToLatLng({x:600,y:400}),circles=[],labels=[],colors=[];
  const ctx={save(){},restore(){},beginPath(){},arc(x,y,r){circles.push({x,y,r});},fill(){},stroke(){colors.push(this.strokeStyle);},strokeText(){},fillText(text){labels.push(text);}};
  m.options={draftSnap:{point:location,active:false}};m.drawDraftSnap(ctx);
  assert.deepEqual(circles.map(circle=>circle.r),[12,8]);assert.deepEqual(labels,['端点に接続']);assert.ok(colors.includes('#087f8c'));
  circles.length=0;labels.length=0;colors.length=0;m.options={plan:[location],removePointIndex:0,draftSnap:{point:location,active:true}};m.drawDraftSnap(ctx);
  assert.deepEqual(labels,['点を取消']);assert.ok(colors.includes('#dc4b44'));
  m.options.draftSnap=null;m.drawDraftSnap(new Proxy({}, {get(){throw new Error('No endpoint hit must not paint a snap cue');}}));
});

test('right click suppresses the browser menu only when the editing action handles it',()=>{
  const m=map(); m.eventPoint=event=>event.position;
  const position={x:400,y:300}; let prevented=false,received=null;
  const event={position,preventDefault(){prevented=true;}};
  m.callbacks.onContextMenu=point=>{received=point;return true;};
  m.contextMenu(event);
  assert.deepEqual(received,m.screenToLatLng(position));assert.equal(prevented,true);
  prevented=false;m.callbacks.onContextMenu=()=>false;m.contextMenu(event);
  assert.equal(prevented,false);
});

test('rapidly re-clicking a plan point does not also zoom the map',()=>{
  const m=map();m.options={mode:'track'};m.eventPoint=event=>event.position;
  const event={position:{x:400,y:300},preventDefault(){}};
  const before=m.getView();m.doubleClick(event);assert.deepEqual(m.getView(),before);
  m.options.mode='pan';m.doubleClick(event);assert.equal(m.getView().zoom,before.zoom+1);
});

test('rapid two-point measurement clicks never trigger map double-click zoom',()=>{
  const m=map();m.eventPoint=event=>event.position;const before=m.getView();let prevented=0;
  const event={position:{x:500,y:350},preventDefault(){prevented++;}};
  m.options={mode:'measure',measureEnabled:true};m.doubleClick(event);assert.deepEqual(m.getView(),before);
  m.options={mode:'pan',measureEnabled:true};m.doubleClick(event);assert.deepEqual(m.getView(),before);assert.equal(prevented,2);
});

test('grade measurement draws its exact endpoints and a dashed line only when enabled',()=>{
  const m=map(),positions=[{x:400,y:300},{x:750,y:500}],labels=[],circles=[],lines=[],dashes=[],strokes=[];
  const points=positions.map(position=>m.screenToLatLng(position));m.options={measureEnabled:true,measurePoints:points};
  m.pixelPath=(_ctx,path)=>lines.push(path);
  const ctx={save(){},restore(){},beginPath(){},arc(x,y,r){circles.push({x,y,r});},fill(){},stroke(){strokes.push({color:this.strokeStyle,width:this.lineWidth});},setLineDash(dash){dashes.push([...dash]);},strokeText(){},fillText(text){labels.push(text);}};
  m.drawMeasurement(ctx);
  assert.equal(lines.length,1);assert.equal(circles.length,2);assert.deepEqual(labels,['A','A 始点','B','B 終点']);
  for(let i=0;i<2;i++){assert.ok(Math.abs(circles[i].x-positions[i].x)<1e-6);assert.ok(Math.abs(circles[i].y-positions[i].y)<1e-6);assert.deepEqual(lines[0][i],{x:circles[i].x,y:circles[i].y});}
  assert.deepEqual(dashes,[[8,5],[]]);assert.ok(strokes.some(stroke=>stroke.color==='#7c4dcc'&&stroke.width===2.2));
  lines.length=0;circles.length=0;labels.length=0;m.options.measurePoints=[points[0]];m.drawMeasurement(ctx);
  assert.equal(lines.length,0);assert.equal(circles.length,1);assert.deepEqual(labels,['A','A 始点']);
  m.options.measureEnabled=false;m.drawMeasurement(new Proxy({}, {get(){throw new Error('Disabled measurement must not draw');}}));
});

test('existing railway snap obeys both its pixel tolerance and maximum ground distance',()=>{
  const m=map(), query={lat:35.6812,lng:139.7671};let requestedLimit;
  assert.equal(m.nearestExistingTrack(query),null);
  const at=m.latLngToScreen(query),near=m.screenToLatLng({x:at.x+4,y:at.y});
  m.setExistingNetwork({nearestTrack(_point,limit){requestedLimit=limit;return {point:near,distance:4*m.metersPerPixel(),track:{id:'existing:1'}};}});
  const hit=m.nearestExistingTrack(query,10,80);
  assert.ok(Math.abs(hit.screenDistance-4)<1e-7);
  assert.equal(requestedLimit,Math.min(80,10*m.metersPerPixel(query.lat)));
  m.existingNetwork.nearestTrack=()=>({point:near,distance:81});
  assert.equal(m.nearestExistingTrack(query,10,80),null);
  m.existingNetwork.nearestTrack=()=>({point:m.screenToLatLng({x:at.x+11,y:at.y}),distance:1});
  assert.equal(m.nearestExistingTrack(query,10,80),null);
});

test('a small scale railway snap does not expand beyond the ground-distance cap',()=>{
  const m=map();m.view.zoom=9;let requestedLimit;
  m.setExistingNetwork({nearestTrack(_point,limit){requestedLimit=limit;return null;}});
  m.nearestExistingTrack(m.view,10,80);assert.equal(requestedLimit,80);
});

test('moving the station pointer between parallel blue lines selects the geographically closest host without pinning the old hit',()=>{
  const m=map();m.view.zoom=18;const p=(x,y)=>m.screenToLatLng({x,y}),coordinates=y=>[p(200,y),p(1000,y)].map(point=>[point.lng,point.lat]);
  const network=new ExistingRailwayNetwork({features:[{properties:{type:'rail'},geometry:{type:'LineString',coordinates:coordinates(397)}},{properties:{type:'rail'},geometry:{type:'LineString',coordinates:coordinates(403)}},{properties:{type:'rail',shinkansen:true},geometry:{type:'LineString',coordinates:coordinates(399)}}]});
  m.setExistingNetwork(network);
  for(let pass=0;pass<3;pass++){
    assert.equal(m.nearestExistingTrack(p(600,398),18,80).track.id,'existing:0');
    assert.equal(m.nearestExistingTrack(p(600,402),18,80).track.id,'existing:1');
  }
  const same=p(600,400),chosen=m.nearestExistingTrack(same,18,80).track.id;
  assert.equal(m.nearestExistingTrack(same,18,80).track.id,chosen,'identical pointer queries use a stable source tie-break');
});

test('station host highlighting clips the chosen source line to the viewport and labels its actual anchor',()=>{
  const m=map(),p=(x,y)=>m.screenToLatLng({x,y}),paths=[],labels=[],circles=[],strokes=[];
  const hit={point:p(500,300),track:{id:'existing:chosen',existing:true,line:'テスト線',points:[p(-100000,200),p(500,300),p(100000,900)]}};
  m.pixelPath=(_ctx,path)=>paths.push(path);
  const ctx={save(){},restore(){},beginPath(){},arc(x,y,r){circles.push({x,y,r});},fill(){},stroke(){strokes.push(this.strokeStyle);},strokeText(){},fillText(text){labels.push(text);}};
  m.drawStationHostConnection(ctx,hit);
  assert.equal(paths.length,2);assert.ok(paths.every(path=>path.every(point=>point.x>=-8.001&&point.x<=m.width+8.001&&point.y>=-8.001&&point.y<=m.height+8.001)));
  assert.deepEqual(circles.map(circle=>circle.r),[7.5,2.8]);assert.ok(Math.abs(circles[0].x-500)<1e-6);assert.ok(Math.abs(circles[0].y-300)<1e-6);assert.deepEqual(labels,['接続先：テスト線']);assert.ok(strokes.includes('#c79025'));
  paths.length=0;labels.length=0;m.drawStationHostConnection(ctx,{point:p(-10000,-10000),track:{points:[p(-10010,-10010),p(-9990,-9990)]}});assert.equal(paths.length,0);assert.equal(labels.length,0);
  let rendered=0;m.drawStationHostConnection=()=>rendered++;
  m.options={mode:'station',plan:[],stationHostConnection:hit};m.drawPlan({});assert.equal(rendered,1);
  m.options.mode='route';m.drawPlan({});assert.equal(rendered,1);m.options.mode='station';m.options.stationHostConnection=null;m.drawPlan({});assert.equal(rendered,1,'station adoption without a new host does not highlight a line');
});

test('a private station-port connection gets a green target cue and an edge-safe label only in track drawing mode',()=>{
  const m=map(),hit={point:m.screenToLatLng({x:m.width-3,y:4}),portLabel:'8B',platformNumbers:[8],end:'b',existingHost:false},circles=[],labels=[],strokes=[];
  const ctx={save(){},restore(){},beginPath(){},arc(x,y,r){circles.push({x,y,r});},fill(){},stroke(){strokes.push(this.strokeStyle);},strokeText(){},fillText(text,x,y){labels.push({text,x,y});},measureText(){return {width:80};}};
  m.options={mode:'track',plan:[],stationPortConnection:hit};m.drawPlan(ctx);
  assert.deepEqual(circles.map(circle=>circle.r),[11,7]);assert.deepEqual(strokes,['#087f8c']);assert.equal(labels[0].text,'8Bへ接続');assert.ok(labels[0].x>=8&&labels[0].x+80<=m.width-8);assert.ok(labels[0].y>=19);
  circles.length=0;labels.length=0;m.options.mode='station';m.drawPlan(ctx);assert.equal(circles.length,0);assert.equal(labels.length,0);
  m.options.mode='track';m.options.stationPortConnection={...hit,existingHost:true};m.drawPlan(ctx);assert.equal(circles.length,0,'shared host retains its blue-line connection cue');
});

test('existing station selection can exclude purple shinkansen stations while popups retain them',()=>{
  const m=map(),c=m.center,offset=5/m.worldSize;
  m.existingStations=[{id:'purple',name:'新幹線駅',type:'shinkansen',shinkansen:true,x:c.x,y:c.y},{id:'blue',name:'在来線駅',type:'rail',x:c.x+offset,y:c.y}];
  assert.equal(m.nearestExistingStation(m.view).id,'purple');
  assert.equal(m.nearestExistingStation(m.view,12,{railOnly:true}).id,'blue');
});

test('shared station selection highlights the original blue marker and suppresses a duplicate platform',()=>{
  const m=map(),c=m.center,station={id:'adopted',sourceStationId:'blue',existing:true,lat:35.69,lng:139.78};
  m.state.stations=[station];m.options={selectedStationIds:['adopted']};m.railPaths=[];m.existingStations=[{id:'blue',name:'既設駅',x:c.x,y:c.y,type:'rail'}];
  const fills=[],labels=[];
  const ctx={beginPath(){},moveTo(){},arc(){},stroke(){},fill(){fills.push(this.fillStyle);},strokeText(){},fillText(text){labels.push({text,color:this.fillStyle});}};
  m.drawExisting(ctx,c,m.worldSize);
  assert.ok(fills.includes('#e07722'));
  assert.deepEqual(labels,[{text:'既設駅',color:'#a95520'}]);
  m.drawStation(new Proxy({}, {get(){throw new Error('Existing station must use its base marker');}}),station);
});

const labelCandidate=(key,x,y,width=15,priority=0)=>({key,position:{x,y},bounds:{left:x+7,right:x+7+width,top:y-15,bottom:y},priority});

test('station name density suppresses both close labels and keeps sparse labels at a 40 CSS pixel threshold',()=>{
  assert.equal(planStationLabelVisibility([labelCandidate('a',0,0),labelCandidate('b',40,0)]).visible.size,0);
  assert.deepEqual([...planStationLabelVisibility([labelCandidate('a',0,0),labelCandidate('b',41,0)]).visible],['a','b']);
  const selected=planStationLabelVisibility([labelCandidate('a',0,0),labelCandidate('b',10,0,15,1)]);
  assert.deepEqual([...selected.visible],['b'],'selected station keeps its label while its crowded neighbor remains hidden');
});

test('long sparse station names cannot overlap and priority names reserve their text box first',()=>{
  const candidates=[labelCandidate('ordinary',100,100,130),labelCandidate('selected',170,100,130,1),labelCandidate('far',400,100,130)];
  const plan=planStationLabelVisibility(candidates);assert.deepEqual([...plan.visible],['selected','far']);assert.ok(plan.stats.collisionChecks>0);
});

function stationLabelContext(labels,arcs=[]){
  return new Proxy({fillText(text){labels.push(String(text));},arc(...args){arcs.push(args);},measureText(text){return {width:[...String(text)].length*11};}}, {get(target,key){return key in target?target[key]:()=>{};}});
}

test('shared and owned names use one density plan without removing their station markers',()=>{
  const m=map(),c=m.center,labels=[],arcs=[],ctx=stationLabelContext(labels,arcs),owned={id:'owned',name:'自作駅',...m.screenToLatLng({x:620,y:400}),cars:1,trackId:'none'};
  m.options={selectedStationIds:[]};m.railPaths=[];m.existingStations=[{id:'blue',name:'既設駅',x:c.x,y:c.y,type:'rail'}];m.state.stations=[owned];
  m.drawExisting(ctx,c,m.worldSize);m.drawStation(ctx,owned);
  assert.deepEqual(labels,[]);assert.equal(arcs.length,2,'blue and player station markers remain drawable while their names are hidden');assert.equal(m.stationLabelPlan.size,0);
  labels.length=0;m.options.selectedStationIds=[owned.id];m.drawExisting(ctx,c,m.worldSize);m.drawStation(ctx,owned);
  assert.deepEqual(labels,['自作駅']);assert.equal(m.existingStations[0].name,'既設駅','popup and station selection retain the complete source name');
});

test('station label distance uses CSS pixels at every zoom and hidden labels return when zoomed apart',()=>{
  const m=map(),labels=[],ctx=stationLabelContext(labels);m.options={selectedStationIds:[]};m.railPaths=[];
  for(const zoom of [11,14,20]){
    m.view.zoom=zoom;const c=m.center;
    m.existingStations=[{id:'a',name:'A',x:c.x,y:c.y},{id:'b',name:'B',x:c.x+35/m.worldSize,y:c.y}];
    labels.length=0;m.drawExisting(ctx,c,m.worldSize);assert.deepEqual(labels,[],`35px density suppresses names at zoom ${zoom}`);
    m.view.zoom=zoom+1;labels.length=0;m.drawExisting(ctx,m.center,m.worldSize);assert.deepEqual(labels,['A','B'],`names restore after their spacing doubles at zoom ${zoom+1}`);
  }
});

test('national-size dense station sets use local grid comparisons rather than all-pairs name collision checks',()=>{
  const candidates=[];
  for(let index=0;index<5000;index++)for(let member=0;member<2;member++)candidates.push(labelCandidate(`${index}:${member}`,(index%100)*100+member*15,Math.floor(index/100)*100));
  const plan=planStationLabelVisibility(candidates);
  assert.equal(plan.visible.size,0);assert.equal(plan.stats.candidates,10000);assert.ok(plan.stats.distanceChecks<50000);assert.equal(plan.stats.collisionChecks,0);
});

test('railway load failures notify the application while leaving map interactions usable',async()=>{
  const m=map();m.container={dataset:{}};let received;
  m.callbacks.onRailwaysError=error=>{received=error;};
  const originalFetch=globalThis.fetch, originalWarn=console.warn;
  globalThis.fetch=async()=>{throw new Error('offline');};console.warn=()=>{};
  try {await m.loadRailways();assert.equal(received.message,'offline');assert.equal(m.container.dataset.railwaysError,'offline');}
  finally {globalThis.fetch=originalFetch;console.warn=originalWarn;}
});

test('owned double tracks retain two distinct strokes even at nationwide zoom levels',()=>{
  const m=map();
  for(const zoom of [4,9,14,19,22]){
    m.view.zoom=zoom;
    const single=m.trackVisualStyle({type:'single'}),double=m.trackVisualStyle({type:'double'});
    assert.equal(single.offsets.length,1);assert.equal(single.offsets[0],0);
    assert.equal(double.offsets.length,2);assert.ok(double.offsets[1]-double.offsets[0]>=6);
    assert.notEqual(single.color,double.color);
  }
});

test('a two-platform four-track station renders separate track paths and platform islands',()=>{
  const m=map(),station={id:'hub',lat:35.6812,lng:139.7671,cars:8,layoutId:'island-4',bearing:0,standalone:true};
  for(const zoom of [14,15,18]){
    m.view.zoom=zoom;
    const geometry=m.stationDisplayGeometry(station),physical=stationGeometry(station);
    assert.equal(geometry.paths.length,4);assert.equal(geometry.platforms.length,2);
    const across=geometry.paths.map(path=>path[1].y).sort((a,b)=>a-b);
    for(let i=1;i<across.length;i++)assert.ok(across[i]-across[i-1]>=5.99);
    assert.deepEqual(geometry.connections,physical.connections.map(point=>m.latLngToScreen(point)),'connectable throats remain at their physical coordinates');
  }
});

test('station bearing rotates the free station and its real connection points',()=>{
  const m=map(),station={id:'north-south',lat:35.6812,lng:139.7671,cars:8,layoutId:'island-4',bearing:90,standalone:true};
  assert.equal(m.stationAngle(station),-Math.PI/2);
  const geometry=m.stationDisplayGeometry(station);
  assert.ok(Math.abs(geometry.connections[0].x-geometry.connections[1].x)<1e-7);
  assert.ok(Math.abs(geometry.connections[0].y-geometry.connections[1].y)>20);
});

test('multi-platform stations preserve a curved blue host at its physical coordinates and place host numbers on the platform body',()=>{
  const m=map();m.view.zoom=15;const p=(x,y)=>m.screenToLatLng({x,y}),station={id:'on-blue',name:'新設駅',lat:m.view.lat,lng:m.view.lng,cars:8,layoutId:'island-8',bearing:0,standalone:false,hostTrackCount:1};
  const geometry=stationGeometry(station),hostIndex=geometry.hostSlotIndices[0],hostPoints=[p(440,430),p(540,380),p(660,410),p(760,440)],body=[p(550,385),p(650,405)];
  geometry.trackPaths[hostIndex]=hostPoints;geometry.hostPaths=[{platformIndex:hostIndex,points:hostPoints}];geometry.platformTrackBodies=geometry.trackPaths.map(path=>[path[1],path.at(-2)]);geometry.platformTrackBodies[hostIndex]=body;station.geometry=geometry;
  const display=m.stationDisplayGeometry(station);assert.ok(display.crossScale>1);
  assert.deepEqual(display.paths[hostIndex],hostPoints.map(point=>m.latLngToScreen(point)));assert.deepEqual(display.bodyPaths[hostIndex],body.map(point=>m.latLngToScreen(point)));
  const all=[...display.footprint,...display.paths.flat()];assert.equal(display.bounds.right,Math.max(...all.map(point=>point.x)),'horizontal bounds use x rather than the vertical maximum');
  m.options={mode:'station'};const labels=[];
  const ctx=new Proxy({fillText(text,x,y){labels.push({text:String(text),x,y});}}, {get(target,key){return key in target?target[key]:()=>{};}});
  m.drawStationFacility(ctx,station,true);const number=labels.find(label=>label.text===String(hostIndex+1)),t=hostIndex%2?.3:.1;
  assert.ok(Math.abs(number.x-(550+100*t))<1e-6);assert.ok(Math.abs(number.y-(385+20*t+.2))<1e-6);
  geometry.trackPaths[hostIndex]=[hostPoints[0],hostPoints.at(-1)];geometry.hostPaths[0].points=geometry.trackPaths[hostIndex];labels.length=0;m.drawStationFacility(ctx,station,true);
  assert.ok(labels.some(label=>label.text===String(hostIndex+1)),'a two-point host path remains drawable without reversing its number placement');
});

function onBlueIndependentStation(m,bearing=0,hostPlatformNumber=null){
  const station={id:'blue-platforms',name:'番線別の新駅',lat:m.view.lat,lng:m.view.lng,cars:8,layoutId:'island-8',bearing,standalone:false,hostTrackCount:1,existingTrack:true,trackId:'existing:host',wiringMode:'platforms',portGeometry:'straight',trackConfigs:Array.from({length:8},()=>({a:'independent',b:'independent',direction:'both'})),...(hostPlatformNumber?{hostPlatformNumber}:{})};
  const base=stationGeometry(station),index=base.hostSlotIndices[0],a=base.trackPaths[index][0],b=base.trackPaths[index].at(-1),pa=m.latLngToScreen(a),pb=m.latLngToScreen(b),dx=pb.x-pa.x,dy=pb.y-pa.y,length=Math.hypot(dx,dy),normal={x:-dy/length,y:dx/length};
  station.hostTrackPoints=[m.screenToLatLng({x:pa.x+normal.x*2,y:pa.y+normal.y*2}),m.screenToLatLng({x:pa.x+dx*.35+normal.x*8,y:pa.y+dy*.35+normal.y*8}),m.screenToLatLng({x:pa.x+dx*.7+normal.x*4,y:pa.y+dy*.7+normal.y*4}),m.screenToLatLng({x:pb.x+normal.x*2,y:pb.y+normal.y*2})];
  station.hostPlatformPoints=base.platformTrackBodies[index];return station;
}

test('all sixteen independent ports of an on-blue eight-track station remain distinct and snappable across rotations',()=>{
  const m=map();m.width=1600;m.height=1200;m.view.zoom=18;
  m.setExistingNetwork({nearestTrack(){throw new Error('Private station port selection must not be replaced by a nearest blue line query');}});
  for(const bearing of [0,35,90,135]){
    const station=onBlueIndependentStation(m,bearing),geometry=stationGeometry(station);m.state.stations=[station];
    assert.equal(geometry.connectionPorts.length,16);assert.equal(new Set(geometry.connections.map(point=>`${point.lat.toFixed(11)}:${point.lng.toFixed(11)}`)).size,16);
    const display=m.stationDisplayGeometry(station);assert.equal(display.crossScale,1);const hostIndex=geometry.hostSlotIndices[0];
    assert.deepEqual(display.paths[hostIndex],station.hostTrackPoints.map(point=>m.latLngToScreen(point)));
    const hostPorts=geometry.connectionPorts.filter(port=>port.platformNumbers.includes(hostIndex+1));
    assert.deepEqual(hostPorts.find(port=>port.end==='a').point,station.hostTrackPoints[0]);assert.deepEqual(hostPorts.find(port=>port.end==='b').point,station.hostTrackPoints.at(-1),'curved host ports must follow the real source endpoints rather than ideal tangent endpoints');
    for(const port of geometry.connectionPorts){
      const hit=m.nearestStationConnection(port.point,3);assert.ok(hit);assert.equal(hit.portKey,port.key);assert.deepEqual(hit.platformNumbers,port.platformNumbers);assert.deepEqual(hit.point,port.point);
      assert.equal(hit.existingHost,port.platformNumbers.includes(hostIndex+1));
    }
    for(let index=0;index<8;index++)if(index!==hostIndex){
      const path=display.paths[index],a=path[1],b=path[2],dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
      for(const endpoint of [path[0],path.at(-1)])assert.ok(Math.abs((endpoint.x-a.x)*dy-(endpoint.y-a.y)*dx)/length<.04,'private ports stay straight instead of fanning into the existing host');
    }
  }
});

test('on-blue independent stations distinguish the shared blue rail and ports from fourteen private green ports',()=>{
  const m=map();m.width=1600;m.height=1200;m.view.zoom=18;const station=onBlueIndependentStation(m),geometry=stationGeometry(station),hostIndex=geometry.hostSlotIndices[0],labels=[],strokes=[];
  m.options={mode:'track-edit',selectedStationIds:[]};const ctx=new Proxy({fillText(text){labels.push({text:String(text),color:this.fillStyle});},stroke(){strokes.push({color:this.strokeStyle,width:this.lineWidth});}}, {get(target,key){return key in target?target[key]:()=>{};}});
  m.drawStationFacility(ctx,station);const portLabels=labels.filter(label=>geometry.connectionPorts.some(port=>port.label===label.text));
  assert.equal(portLabels.length,16);assert.equal(portLabels.filter(label=>label.color==='#267ac7').length,2);assert.equal(portLabels.filter(label=>label.color==='#087f8c').length,14);
  assert.ok(strokes.some(stroke=>stroke.color==='#267ac7'&&stroke.width===1.8));
  labels.length=0;m.options.selectedStationIds=[station.id];m.drawStationFacility(ctx,station);
  assert.ok(labels.filter(label=>geometry.connectionPorts.some(port=>port.label===label.text)).every(label=>label.color==='#df7725'),'selected station highlights remain visible on its shared host');
  labels.length=0;m.options.selectedStationIds=[];station.valid=false;m.drawStationFacility(ctx,station,true);
  assert.ok(labels.filter(label=>geometry.connectionPorts.some(port=>port.label===label.text)).every(label=>label.color==='#dc4b44'),'invalid placement retains its warning color');
  let preview;m.drawStation=(_ctx,value)=>{preview=value;};m.options={mode:'station',plan:[],stationPreview:{...station,point:{lat:station.lat,lng:station.lng},geometry,ok:true}};m.drawPlan({});assert.equal(preview.existingTrack,true);
});

test('choosing blue host platform one, four or eight moves host colors, physical paths, snap identities and number labels together',()=>{
  const m=map();m.width=1600;m.height=1200;m.view.zoom=18;
  for(const number of [1,4,8])for(const bearing of [0,90]){
    const station=onBlueIndependentStation(m,bearing,number),geometry=stationGeometry(station),labels=[];m.state.stations=[station];m.options={mode:'track',selectedStationIds:[]};
    assert.deepEqual(geometry.hostSlotIndices,[number-1]);
    const display=m.stationDisplayGeometry(station);assert.deepEqual(display.paths[number-1],station.hostTrackPoints.map(point=>m.latLngToScreen(point)));
    const hostPorts=geometry.connectionPorts.filter(port=>port.platformNumbers.includes(number));assert.equal(hostPorts.length,2);
    for(const port of geometry.connectionPorts){const hit=m.nearestStationConnection(port.point,3);assert.equal(hit.portKey,port.key);assert.equal(hit.existingHost,port.platformNumbers.includes(number));}
    const ctx=new Proxy({fillText(text,x,y){labels.push({text:String(text),x,y,color:this.fillStyle});}}, {get(target,key){return key in target?target[key]:()=>{};}});
    m.drawStationFacility(ctx,station);
    assert.deepEqual(labels.filter(label=>label.color==='#267ac7').map(label=>label.text).sort(),[`${number}A`,`${number}B`]);
    assert.equal(labels.filter(label=>geometry.connectionPorts.some(port=>port.label===label.text)&&label.color==='#087f8c').length,14);
    const numeric=labels.find(label=>label.text===String(number)),[a,b]=display.bodyPaths[number-1],t=(number-1)%2?.3:.1;
    assert.ok(Math.abs(numeric.x-(a.x+(b.x-a.x)*t))<1e-6);assert.ok(Math.abs(numeric.y-(a.y+(b.y-a.y)*t+.2))<1e-6);
  }
  const legacy=onBlueIndependentStation(m,0,8);legacy.hostPlatformSelection='auto';const legacyGeometry=stationGeometry(legacy);assert.notDeepEqual(legacyGeometry.hostSlotIndices,[7]);
  m.state.stations=[legacy];for(const port of legacyGeometry.connectionPorts)assert.equal(m.nearestStationConnection(port.point,3).existingHost,port.platformNumbers.some(number=>legacyGeometry.hostSlotIndices.includes(number-1)),'legacy representative fields cannot override the resolved host slot');
});

test('station-first placement has a complete preview on an otherwise empty map',()=>{
  const m=map();m.options={mode:'station',plan:[],hover:{lat:35.68,lng:139.77},stationPlacement:'free',stationLayoutId:'island-4',stationBearing:35,platformCars:8,stationPreviewInvalid:false};
  let drawn;m.drawStation=(_ctx,station)=>{drawn=station;};
  m.drawPlan({});
  assert.equal(drawn.layoutId,'island-4');assert.equal(drawn.standalone,true);assert.equal(drawn.bearing,35);assert.equal(drawn.cars,8);assert.equal(drawn.valid,true);
});

test('free station throat snapping is bounded by both screen and ground distances',()=>{
  const m=map(),station={id:'first',lat:35.6812,lng:139.7671,cars:8,layoutId:'island-4',bearing:0,standalone:true};
  m.state.stations=[station];
  const endpoint=stationGeometry(station).connections[0],pixel=m.latLngToScreen(endpoint);
  const cursor=m.screenToLatLng({x:pixel.x+5,y:pixel.y});
  assert.equal(m.nearestStationConnection(cursor).stationId,'first');
  assert.deepEqual(m.nearestStationConnection(cursor).point,endpoint);
  assert.equal(m.nearestStationConnection(m.screenToLatLng({x:pixel.x,y:pixel.y+14})),null);
  m.view.zoom=9;const far=m.latLngToScreen(endpoint);
  assert.equal(m.nearestStationConnection(m.screenToLatLng({x:far.x+5,y:far.y})),null,'a small-scale view cannot snap hundreds of metres away');
});

test('track decorations are clipped before sampling a world-spanning high-zoom line',()=>{
  const m=map();m.view.zoom=22;const points=[{lat:m.view.lat,lng:120},{lat:m.view.lat,lng:155}],coordinates=[];
  const ctx={beginPath(){},stroke(){},moveTo(x,y){coordinates.push([x,y]);},lineTo(x,y){coordinates.push([x,y]);}};
  m.drawTrackDetails(ctx,points,'double',m.trackVisualStyle({type:'double'}));
  assert.ok(coordinates.length>0);assert.ok(coordinates.length<2000,'work depends on the visible line rather than its country-wide length');
  assert.ok(coordinates.every(([x,y])=>Number.isFinite(x)&&Number.isFinite(y)));
});

function stationInputMap() {
  const m=map(),captured=new Set(),rotations=[];
  m.options={mode:'station',stationPlacement:'free',stationBearing:0,plan:[]};m.pointers=new Map();
  m.canvas={style:{},focus(){},setPointerCapture(id){captured.add(id);},hasPointerCapture(id){return captured.has(id);},releasePointerCapture(id){captured.delete(id);}};
  m.eventPoint=event=>event.position;
  m.callbacks.onMove=point=>{m.options.hover=point;};
  m.callbacks.onStationRotate=(bearing,anchor)=>{rotations.push(bearing);m.setState(m.state,{stationBearing:bearing,hover:anchor});};
  return {m,captured,rotations};
}
const pointerEvent=(x,y,extra={})=>({pointerId:1,button:2,buttons:2,position:{x,y},preventDefault(){},...extra});

test('right dragging rotates the full station preview around a fixed geographic center without panning or building',()=>{
  const {m,captured,rotations}=stationInputMap(),view=m.getView();let clicks=0,viewChanges=0,undos=0;
  m.callbacks.onClick=()=>clicks++;m.callbacks.onViewChange=()=>viewChanges++;m.callbacks.onContextMenu=()=>undos++;
  const start=pointerEvent(600,400),anchor=m.screenToLatLng(start.position);
  m.pointerDown(start);assert.ok(captured.has(1));
  m.pointerMove(pointerEvent(780,460));
  assert.deepEqual(rotations,[90]);assert.deepEqual(m.options.hover,anchor);assert.deepEqual(m.getView(),view);
  let preview;m.drawStation=(_ctx,station)=>{preview=station;};m.drawPlan({});
  assert.equal(preview.bearing,90);assert.equal(preview.lat,anchor.lat);assert.equal(preview.lng,anchor.lng);
  m.pointerUp(pointerEvent(780,460,{buttons:0}));
  assert.equal(m.stationRotation,null);assert.equal(captured.size,0);assert.equal(clicks,0);assert.equal(viewChanges,0);assert.equal(undos,0);
  let builtAt;m.callbacks.onClick=point=>{builtAt=point;};
  m.pointerDown(pointerEvent(780,460,{button:0,buttons:1}));m.pointerUp(pointerEvent(780,460,{button:0,buttons:0}));
  assert.deepEqual(builtAt,m.options.hover,'an immediate left click builds at the visible preview after releasing rotation');
});

test('right drag snaps angles in both directions and wraps across the undirected 180 degree axis',()=>{
  const {m}=stationInputMap();m.options.stationBearing=175;
  m.pointerDown(pointerEvent(600,400));m.pointerMove(pointerEvent(610,400));assert.equal(m.options.stationBearing,0);
  m.pointerMove(pointerEvent(590,400));assert.equal(m.options.stationBearing,170);
  m.pointerUp(pointerEvent(590,400,{buttons:0}));m.options.stationBearing=0;
  m.pointerDown(pointerEvent(600,400));m.pointerMove(pointerEvent(590,400));assert.equal(m.options.stationBearing,175);
  m.pointerMove(pointerEvent(613,400));assert.equal(m.options.stationBearing,5);
});

test('Shift wheel rotates in five degree steps at the pointer without changing the map zoom',()=>{
  const {m,rotations}=stationInputMap(),view=m.getView(),position={x:740,y:350};let prevented=0;
  const wheel={shiftKey:true,deltaY:-120,deltaX:0,position,preventDefault(){prevented++;}};
  m.lastWheel=performance.now(); // Rotation must not be swallowed by the map zoom throttle.
  m.wheel(wheel);m.wheel(wheel);assert.deepEqual(rotations,[5,10]);
  m.wheel({...wheel,deltaY:120});assert.equal(m.options.stationBearing,5);
  m.wheel({...wheel,deltaY:0,deltaX:120});assert.equal(m.options.stationBearing,0);
  m.wheel({...wheel,deltaY:0,deltaX:120});assert.equal(m.options.stationBearing,175);
  assert.deepEqual(m.getView(),view);assert.deepEqual(m.options.hover,m.screenToLatLng(position));assert.equal(prevented,5);
  m.wheel({...wheel,deltaY:0});assert.equal(rotations.length,5);
});

test('ordinary wheel still zooms and station-on-track or track mode does not rotate on Shift wheel',()=>{
  for(const options of [{mode:'station',stationPlacement:'free',shiftKey:false},{mode:'station',stationPlacement:'track',shiftKey:true},{mode:'track',stationPlacement:'free',shiftKey:true},{mode:'pan',stationPlacement:'free',shiftKey:true}]){
    const {m,rotations}=stationInputMap();Object.assign(m.options,options);m.lastWheel=-1000;
    m.wheel({position:{x:600,y:400},deltaY:-120,shiftKey:options.shiftKey,preventDefault(){}});
    assert.equal(m.view.zoom,15);assert.equal(rotations.length,0);
  }
});

test('a right click in station-first placement suppresses the native menu without calling track undo',()=>{
  const {m}=stationInputMap();let prevented=false,undos=0;
  m.callbacks.onContextMenu=()=>{undos++;return true;};
  m.contextMenu(pointerEvent(600,400,{preventDefault(){prevented=true;}}));assert.equal(prevented,true);assert.equal(undos,0);
  m.options.mode='track';prevented=false;
  m.contextMenu(pointerEvent(600,400,{preventDefault(){prevented=true;}}));assert.equal(prevented,true);assert.equal(undos,1);
  m.options.mode='station';m.options.stationPlacement='track';m.pointerDown(pointerEvent(600,400));assert.equal(m.stationRotation,undefined);
});

test('station rotation releases pointer capture on cancellation or a mode change',()=>{
  for(const cancel of [m=>m.pointerCancel(),m=>m.setState(m.state,{mode:'track'})]){
    const {m,captured}=stationInputMap();let clicks=0;m.callbacks.onClick=()=>clicks++;
    m.pointerDown(pointerEvent(600,400));m.pointerMove(pointerEvent(620,400));cancel(m);
    assert.equal(m.stationRotation,null);assert.equal(captured.size,0);
    m.pointerUp(pointerEvent(620,400,{buttons:0}));assert.equal(clicks,0);
  }
});

test('extra pointer and mouse button events during station rotation cannot accidentally build or leave rotation stuck',()=>{
  const {m,rotations,captured}=stationInputMap();let clicks=0;m.callbacks.onClick=()=>clicks++;
  m.pointerDown(pointerEvent(600,400));m.pointerDown(pointerEvent(650,400,{pointerId:2,button:0,buttons:1}));
  m.pointerMove(pointerEvent(650,400,{pointerId:2,button:0,buttons:1}));m.pointerUp(pointerEvent(650,400,{pointerId:2,button:0,buttons:0}));
  assert.equal(rotations.length,0);assert.ok(m.stationRotation);assert.equal(m.pointers.size,0);assert.equal(clicks,0);
  m.pointerMove(pointerEvent(630,400,{button:2,buttons:1})); // Right was released while left was still held.
  assert.equal(m.stationRotation,null);assert.equal(captured.size,0);
  assert.deepEqual(m.options.hover,m.screenToLatLng({x:630,y:400}));
  m.pointerUp(pointerEvent(630,400,{button:0,buttons:0}));assert.equal(clicks,0);
});

test('wheel rotation during a right drag preserves its anchor and continues smoothly from the updated angle',()=>{
  const {m}=stationInputMap(),view=m.getView();m.pointerDown(pointerEvent(600,400));const anchor=m.options.hover;
  m.pointerMove(pointerEvent(620,400));assert.equal(m.options.stationBearing,10);
  m.wheel({position:{x:900,y:500},shiftKey:true,deltaY:-120,preventDefault(){}});assert.equal(m.options.stationBearing,15);
  m.pointerMove(pointerEvent(630,400));assert.equal(m.options.stationBearing,20);assert.deepEqual(m.options.hover,anchor);
  m.wheel({position:{x:900,y:500},deltaY:-120,preventDefault(){}});assert.deepEqual(m.getView(),view);
});

test('a context menu from a station drag canceled by changing mode cannot undo a track point',()=>{
  const {m}=stationInputMap();let undos=0,prevented=0;m.callbacks.onContextMenu=()=>{undos++;return true;};
  const context=pointerEvent(640,400,{preventDefault(){prevented++;}});
  m.pointerDown(pointerEvent(600,400));m.pointerMove(pointerEvent(640,400));m.setState(m.state,{mode:'track'});
  m.pointerUp(pointerEvent(640,400,{buttons:0}));m.contextMenu(context);
  assert.equal(undos,0);assert.equal(prevented,1);
  m.pointerDown(pointerEvent(640,400));m.contextMenu(context);assert.equal(undos,1);
  // Some browsers suppress the canceled gesture's menu entirely; a fresh click must still undo.
  m.options.mode='station';m.pointerDown(pointerEvent(600,400));m.setState(m.state,{mode:'track'});
  m.pointerDown(pointerEvent(640,400));m.contextMenu(context);assert.equal(undos,2);
});

function wiredStation(configs=null){
  return {id:'wired',lat:35.6812,lng:139.7671,cars:8,layoutId:'island-4',bearing:35,standalone:true,wiringMode:'platforms',trackConfigs:configs||[
    {a:'independent',b:'independent',direction:'forward'},
    {a:'independent',b:'independent',direction:'reverse'},
    {a:'independent',b:'independent',direction:'both'},
    {a:'independent',b:'buffer',direction:'both'},
  ]};
}

test('independent station ports retain physical snap positions while a buffer remains attached to its displayed platform rail',()=>{
  const m=map(),station=wiredStation();m.view.zoom=15;
  const physical=stationGeometry(station),display=m.stationDisplayGeometry(station);
  assert.equal(display.connectionPorts.length,7);assert.equal(display.bufferStops.length,1);
  assert.deepEqual(display.connections,physical.connectionPorts.map(port=>m.latLngToScreen(port.point)));
  for(const port of display.connectionPorts){
    const index=port.platformNumbers[0]-1,position=display.paths[index][port.end==='a'?0:display.paths[index].length-1];
    assert.deepEqual(position,port.screen,'drawn open endpoints match the external line connection exactly');
  }
  const stop=display.bufferStops[0];assert.equal(stop.platformIndex,3);assert.equal(stop.end,'b');
  assert.deepEqual(stop.screen,display.paths[3].at(-1));assert.deepEqual(stop.screen,display.paths[3].at(-2));
  assert.deepEqual(stop.screen,m.latLngToScreen(physical.bufferStops[0].point),'straight stations keep platform rails, buffers and ports at their physical positions');
});

test('independent station rails extend straight into their ports at every map scale and rotation',()=>{
  const m=map(),station=wiredStation();
  for(const zoom of [12,15,18,21])for(const bearing of [0,35,90,135]){
    m.view.zoom=zoom;station.bearing=bearing;const display=m.stationDisplayGeometry(station);
    assert.equal(display.crossScale,1);
    for(const path of display.paths){
      const a=path[1],b=path[2],dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
      for(const p of [path[0],path.at(-1)])assert.ok(Math.abs((p.x-a.x)*dy-(p.y-a.y)*dx)/length<.04,'ports stay on the extension of the platform rail');
    }
    for(const port of display.connectionPorts)assert.deepEqual(port.screen,m.latLngToScreen(port.point));
  }
});

test('a paused track draft stays visible without extending to the mouse and permits map zoom',()=>{
  const m=map(),plan=[{lat:35.68,lng:139.76},{lat:35.68,lng:139.77}],paths=[];let controls=0;
  m.options={mode:'draft',plan,controlPoints:plan,hover:{lat:35.69,lng:139.78},trackType:'single'};
  m.drawTrack=(_ctx,track)=>paths.push(track.points);m.drawPlan({beginPath(){},arc(){controls++;},fill(){},stroke(){}});
  assert.deepEqual(paths,[plan]);assert.equal(controls,2);
  m.eventPoint=event=>event.position;m.doubleClick({position:{x:600,y:400},preventDefault(){}});assert.equal(m.view.zoom,15);
});

test('a pinned station draft is drawn after the mouse leaves the map',()=>{
  const m=map(),station=wiredStation();let drawn;
  m.options={mode:'station',hover:null,plan:[],stationPreview:{ok:true,point:{lat:station.lat,lng:station.lng},cars:station.cars,layoutId:station.layoutId,bearing:station.bearing,wiringMode:station.wiringMode,trackConfigs:station.trackConfigs,geometry:stationGeometry(station)}};
  m.drawStation=(_ctx,value)=>{drawn=value;};m.drawPlan({});assert.ok(drawn);assert.equal(drawn.layoutId,station.layoutId);assert.equal(drawn.lat,station.lat);
});

function stationDraftPreview(m,x,y,draftIndex=0,selected=false){
  const station={...wiredStation(),...m.screenToLatLng({x,y})},geometry=stationGeometry(station);
  return {draftIndex,selected,preview:{...station,point:{lat:station.lat,lng:station.lng},geometry,ok:true}};
}

test('multiple station drafts remain visible and independently selected in every map mode',()=>{
  const m=map(),entries=[stationDraftPreview(m,350,400,2),stationDraftPreview(m,900,400,5,true)],drawn=[];entries[1].preview.ok=false;
  const ctx={save(){},restore(){}};m.drawStation=(_ctx,station,preview)=>drawn.push({station,preview,alpha:ctx.globalAlpha});
  for(const mode of ['track','track-edit','station','route','pan','measure']){
    drawn.length=0;m.options={mode,stationDraftPreviews:entries};m.drawStationDrafts(ctx);
    assert.equal(drawn.length,2);assert.ok(drawn.every(value=>value.preview&&value.station.constructionDraft));
    assert.deepEqual(drawn.map(value=>value.station.stationDraftIndex),[2,5]);assert.deepEqual(drawn.map(value=>value.station.selectedDraft),[false,true]);assert.deepEqual(drawn.map(value=>value.station.valid),[true,false]);
    assert.ok(drawn[0].alpha<drawn[1].alpha,'selected station draft has stronger emphasis');
  }
  const order=[];m.options={mode:'route',stationDraftPreviews:entries};m.layer='blank';m.ctx={setTransform(){},clearRect(){},fillRect(){},save(){},restore(){}};m.ratio=1;
  m.drawExisting=()=>order.push('existing');m.drawPlan=()=>order.push('plan');m.drawStation=()=>order.push('station-draft');m.drawScale=()=>{};m.drawMeasurement=()=>order.push('measurement');m.positionStationPopup=()=>{};
  m.render();assert.deepEqual(order,['existing','plan','station-draft','station-draft','measurement'],'unbuilt stations are retained above rail drafts while measurements stay on top');
});

test('station drafts use dashed rails, explicit draft labels and a stronger selected outline',()=>{
  const m=map();m.width=1600;m.height=1200;m.view.zoom=18;m.options={mode:'track',stationDraftPreviews:[stationDraftPreview(m,400,600,0),stationDraftPreview(m,1100,600,1,true)]};
  const labels=[],strokes=[];let dash=[];
  const ctx=new Proxy({fillText(text){labels.push(String(text));},setLineDash(value){dash=[...value];},stroke(){strokes.push({dash:[...dash],color:this.strokeStyle,width:this.lineWidth});}}, {get(target,key){return key in target?target[key]:()=>{};}});
  m.drawStationDrafts(ctx);assert.ok(labels.some(label=>label.startsWith('駅の下書き1')));assert.ok(labels.some(label=>label.startsWith('駅の下書き2')));
  assert.ok(strokes.some(stroke=>stroke.dash.join(',')==='6,3'),'unbuilt private tracks use a dashed stroke');
  assert.ok(strokes.some(stroke=>stroke.dash.join(',')==='4,3'&&stroke.color==='#df7725'&&stroke.width===2),'selected station draft has a stronger orange perimeter');
});

test('station draft selection picks its footprint and returns stable draft indices, including invalid fallback previews',()=>{
  const m=map();m.width=1600;m.height=1200;m.view.zoom=18;const first=stationDraftPreview(m,400,600,7),second=stationDraftPreview(m,1100,600,11);
  m.options={stationDraftPreviews:[first,second]};const polygon=m.stationDisplayGeometry(first.preview).footprint,inside={x:400+((polygon[1].x+polygon[2].x)/2-400)*.7,y:600+((polygon[1].y+polygon[2].y)/2-600)*.7};
  assert.ok(Math.hypot(inside.x-400,inside.y-600)>12);assert.equal(m.nearestStationDraft(m.screenToLatLng(inside)),7,'a large station is selectable beyond the 12px center radius');assert.equal(m.nearestStationDraft(second.preview.point),11);assert.equal(m.nearestStationDraft(m.screenToLatLng({x:780,y:100})),null);
  m.options.stationDraftPreviews=[first,{...first,draftIndex:12,selected:true}];assert.equal(m.nearestStationDraft(first.preview.point),12,'selected duplicate wins an exact position tie');
  const anchor=m.screenToLatLng({x:800,y:600});m.state.stationDrafts=[{kind:'new',point:anchor,cars:4,options:{layoutId:'island-4',placement:'free',wiringMode:'platforms'}}];
  m.options.stationDraftPreviews=[{draftIndex:0,preview:{ok:false,error:'pending'}}];const fallback=m.stationDraftEntries()[0];assert.deepEqual(fallback.point,anchor);assert.equal(fallback.station.valid,false);assert.equal(m.nearestStationDraft(anchor),0);
});

test('station draft ports and committed station ports are both snappable without exposing adoption drafts as new facilities',()=>{
  const m=map();m.width=1600;m.height=1200;m.view.zoom=18;const draft=stationDraftPreview(m,400,600,5),built={...wiredStation(),...m.screenToLatLng({x:1100,y:600}),id:'built'};
  m.options={stationDraftPreviews:[draft,{draftIndex:9,source:{name:'青い既設駅',...m.screenToLatLng({x:800,y:150})}}]};m.state.stations=[built];
  for(const port of draft.preview.geometry.connectionPorts){const hit=m.nearestStationConnection(port.point,3);assert.equal(hit.stationDraftIndex,5);assert.equal(hit.previewStation,true);assert.equal(hit.portKey,port.key);assert.deepEqual(hit.point,port.point);}
  for(const port of stationGeometry(built).connectionPorts){const hit=m.nearestStationConnection(port.point,3);assert.equal(hit.stationId,'built');assert.equal(hit.stationDraftIndex,undefined);assert.equal(hit.previewStation,undefined);}
  assert.equal(m.nearestStationConnection(draft.preview.geometry.bufferStops[0].point,3,20),null,'buffer remains closed while the station is only a draft');
});

test('adoption drafts mark the original blue station position and remain selectable without drawing station rails',()=>{
  const m=map(),anchor=m.screenToLatLng({x:300,y:300}),routing=m.screenToLatLng({x:360,y:300}),labels=[],circles=[];let facilities=0;
  m.options={mode:'route',stationDraftPreviews:[{draftIndex:3,selected:true,source:{id:'blue',name:'共有駅',...routing,sourceLat:anchor.lat,sourceLng:anchor.lng}}]};m.drawStation=()=>facilities++;
  const ctx=new Proxy({fillText(text){labels.push(String(text));},arc(x,y,r){circles.push({x,y,r});}}, {get(target,key){return key in target?target[key]:()=>{};}});
  m.drawStationDrafts(ctx);assert.equal(facilities,0);assert.equal(circles.length,1);assert.ok(Math.abs(circles[0].x-300)<1e-6);assert.equal(circles[0].r,12);assert.ok(labels[0].includes('利用登録の下書き4'));assert.ok(labels[0].includes('共有駅'));
  assert.equal(m.nearestStationDraft(anchor),3);assert.equal(m.nearestStationDraft(routing),null);
});

test('station port snapping distinguishes adjacent platforms, reports shared destinations and excludes buffer stops',()=>{
  const m=map(),station=wiredStation();station.bearing=90;m.view.zoom=18;m.state.stations=[station];
  station.trackConfigs[0].a='group1';station.trackConfigs[1].a='group1';
  const geometry=stationGeometry(station),shared=geometry.connectionPorts.find(port=>port.end==='a'&&port.platformNumbers.length===2);
  const sharedHit=m.nearestStationConnection(shared.point,3);
  assert.deepEqual(sharedHit.platformNumbers,[1,2]);assert.equal(sharedHit.end,'a');assert.equal(sharedHit.portKey,shared.key);assert.equal(sharedHit.portLabel,shared.label);
  for(const port of geometry.connectionPorts){
    const hit=m.nearestStationConnection(port.point,3);
    assert.deepEqual(hit.point,port.point);assert.deepEqual(hit.platformNumbers,port.platformNumbers);assert.equal(hit.end,port.end);
  }
  assert.equal(m.nearestStationConnection(geometry.bufferStops[0].point,3,20),null);
});

test('station one-way arrow tips follow the selected direction and bidirectional rails show both directions',()=>{
  const m=map(),path=[{x:0,y:0},{x:10,y:0},{x:110,y:0},{x:120,y:0}],drawn=[];
  m.pixelPath=(_ctx,points)=>drawn.push(points);const ctx={stroke(){}};
  m.drawStationTrackDirection(ctx,path,'forward','#087f8c');assert.equal(drawn.length,1);assert.ok(drawn[0][1].x>drawn[0][0].x);
  drawn.length=0;m.drawStationTrackDirection(ctx,path,'reverse','#087f8c');assert.equal(drawn.length,1);assert.ok(drawn[0][1].x<drawn[0][0].x);
  drawn.length=0;m.drawStationTrackDirection(ctx,path,'both','#087f8c');assert.equal(drawn.length,2);assert.ok(drawn[0][1].x>drawn[0][0].x);assert.ok(drawn[1][1].x<drawn[1][0].x);
});

test('wired station previews and facilities render destination labels, direction arrows and terminal buffer bars',()=>{
  const m=map(),station=wiredStation();m.view.zoom=17;m.options={mode:'track'};
  const labels=[],strokes=[];const ctx={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},setLineDash(){},arc(){},fill(){},stroke(){strokes.push({color:this.strokeStyle,width:this.lineWidth});},strokeText(){},fillText(text){labels.push(String(text));}};
  m.drawStationFacility(ctx,station);
  for(const port of stationGeometry(station).connectionPorts)assert.ok(labels.includes(port.label));
  assert.ok(strokes.some(stroke=>stroke.color==='#a24c3a'&&stroke.width===2.6),'closed station end has a distinct buffer bar');
  assert.ok(strokes.some(stroke=>stroke.width===1.3),'configured rails have visible direction arrow strokes');
  const options={mode:'station',plan:[],hover:{lat:station.lat,lng:station.lng},stationPlacement:'free',stationLayoutId:station.layoutId,stationBearing:station.bearing,platformCars:station.cars,stationWiringMode:station.wiringMode,stationTrackConfigs:station.trackConfigs};
  m.options=options;let preview;m.drawStation=(_ctx,value)=>{preview=value;};m.drawPlan({});
  assert.equal(preview.wiringMode,'platforms');assert.deepEqual(preview.trackConfigs,station.trackConfigs);
  const geometry=stationGeometry(station);m.options.stationPreview={point:options.hover,...station,geometry,ok:true};m.drawPlan({});
  assert.equal(preview.geometry,geometry);assert.equal(preview.wiringMode,'platforms');assert.deepEqual(preview.trackConfigs,station.trackConfigs);
});

function curveInputMap(){
  const {m,captured}=stationInputMap(),p=(x,y)=>m.screenToLatLng({x,y}),events=[];
  m.options={mode:'track',trackType:'single',curveMode:'point',curveGuides:true,removePointIndex:-1,controlPoints:[p(400,400),p(800,400)],curveHandles:[p(500,360),p(900,440)],plan:[p(400,400),p(800,400)]};
  m.callbacks.onCurveHandle=(index,handle,phase)=>{events.push({index,handle,phase});const handles=[...m.options.curveHandles];handles[index]=handle;m.setState(m.state,{curveHandles:handles});};
  return {m,captured,events};
}

test('curve handle hit detection distinguishes incoming and outgoing squares at a constant screen tolerance',()=>{
  const {m}=curveInputMap(),anchor=m.options.controlPoints[0],outgoing=m.options.curveHandles[0],incoming={lat:2*anchor.lat-outgoing.lat,lng:2*anchor.lng-outgoing.lng};
  for(const zoom of [12,14,18]){
    m.view.zoom=zoom;const out=m.latLngToScreen(outgoing),inc=m.latLngToScreen(incoming);
    const hit=m.nearestCurveHandle(m.screenToLatLng({x:out.x+6,y:out.y}));assert.equal(hit.index,0);assert.equal(hit.side,'outgoing');
    assert.equal(m.nearestCurveHandle(m.screenToLatLng({x:inc.x-6,y:inc.y})).side,'incoming');
    assert.equal(m.nearestCurveHandle(m.screenToLatLng({x:out.x+12,y:out.y})),null);
    assert.equal(m.nearestCurveHandle(anchor),null,'anchor clicks continue to use point cancellation');
  }
  m.options.trackType='crossover';assert.equal(m.nearestCurveHandle(outgoing),null);
  m.options.trackType='single';m.options.curveMode='tangent';assert.equal(m.nearestCurveHandle(outgoing),null);
});

test('dragging a curve handle edits geometry without moving the map or placing a new control point',()=>{
  const {m,captured,events}=curveInputMap(),before=m.getView();let clicks=0,viewChanges=0,menus=0;
  m.callbacks.onClick=()=>clicks++;m.callbacks.onViewChange=()=>viewChanges++;m.callbacks.onContextMenu=()=>menus++;
  m.pointerDown(pointerEvent(500,360,{button:0,buttons:1}));assert.ok(m.curveHandleDrag);assert.ok(captured.has(1));
  m.pointerMove(pointerEvent(560,320,{button:-1,buttons:1}));
  let prevented=false;m.contextMenu(pointerEvent(560,320,{preventDefault(){prevented=true;}}));assert.equal(prevented,true);assert.equal(menus,0);
  m.wheel({deltaY:-120,position:{x:560,y:320},preventDefault(){}});assert.deepEqual(m.getView(),before);
  m.pointerUp(pointerEvent(560,320,{button:0,buttons:0}));
  assert.deepEqual(events.map(event=>event.phase),['start','move','end']);assert.equal(events.at(-1).index,0);
  const target=m.screenToLatLng({x:560,y:320});assert.ok(Math.abs(events.at(-1).handle.lat-target.lat)<1e-10);assert.ok(Math.abs(events.at(-1).handle.lng-target.lng)<1e-10);assert.equal(clicks,0);assert.equal(viewChanges,0);assert.deepEqual(m.getView(),before);
  assert.equal(captured.size,0);assert.equal(m.pointers.size,0);assert.equal(m.curveHandleDrag,null);
});

test('dragging the incoming curve handle mirrors its position into the stored outgoing tangent',()=>{
  const {m,events}=curveInputMap(),anchor=m.options.controlPoints[0],outgoing=m.options.curveHandles[0],incoming={lat:2*anchor.lat-outgoing.lat,lng:2*anchor.lng-outgoing.lng},start=m.latLngToScreen(incoming);
  m.options.curveGuides=false;m.options.previewInvalid=true;
  m.pointerDown(pointerEvent(start.x,start.y,{button:0,buttons:1}));assert.equal(m.curveHandleDrag.side,'incoming');
  m.pointerMove(pointerEvent(280,500,{button:-1,buttons:1}));m.pointerUp(pointerEvent(280,500,{button:0,buttons:0}));
  const moved=m.screenToLatLng({x:280,y:500}),stored=events.at(-1).handle;
  assert.ok(Math.abs(stored.lat-(2*anchor.lat-moved.lat))<1e-12);assert.ok(Math.abs(stored.lng-(2*anchor.lng-moved.lng))<1e-12);
  assert.equal(events.at(-1).phase,'end','handles remain editable while invalid or prediction guides are disabled');
});

test('curve handle cancellation and mode changes release capture without falling through into a map click',()=>{
  for(const cancel of [m=>m.pointerCancel(),m=>m.setState(m.state,{mode:'pan'})]){
    const {m,captured,events}=curveInputMap();let clicks=0;m.callbacks.onClick=()=>clicks++;
    m.pointerDown(pointerEvent(500,360,{button:0,buttons:1}));m.pointerMove(pointerEvent(550,330,{button:-1,buttons:1}));cancel(m);
    assert.equal(m.curveHandleDrag,null);assert.equal(captured.size,0);m.pointerUp(pointerEvent(550,330,{button:0,buttons:0}));assert.equal(clicks,0);
    assert.deepEqual(events.map(event=>event.phase),['start','move','cancel']);
  }
  const {m,events}=curveInputMap();let clicked;m.callbacks.onClick=point=>{clicked=point;};
  m.pointerDown(pointerEvent(400,400,{button:0,buttons:1}));m.pointerUp(pointerEvent(400,400,{button:0,buttons:0}));
  assert.deepEqual(clicked,m.options.controlPoints[0]);assert.equal(events.length,0);
});

test('a second touch transitions curve handle editing into pinch zoom without accidental placement',()=>{
  const {m,events,captured}=curveInputMap();let clicks=0;m.callbacks.onClick=()=>clicks++;
  m.pointerDown(pointerEvent(500,360,{button:0,buttons:1,pointerType:'touch'}));
  m.pointerMove(pointerEvent(510,360,{button:-1,buttons:1,pointerType:'touch'}));
  m.pointerDown(pointerEvent(710,360,{pointerId:2,button:0,buttons:1,pointerType:'touch'}));
  assert.equal(m.curveHandleDrag,null);assert.ok(m.pinch);assert.equal(m.pointers.size,2);assert.equal(events.at(-1).phase,'end');
  m.pointerMove(pointerEvent(910,360,{pointerId:2,button:-1,buttons:1,pointerType:'touch'}));assert.equal(m.view.zoom,15);
  m.pointerUp(pointerEvent(910,360,{pointerId:2,button:0,buttons:0,pointerType:'touch'}));m.pointerUp(pointerEvent(510,360,{button:0,buttons:0,pointerType:'touch'}));
  assert.equal(clicks,0);assert.equal(captured.size,0);
});

test('prediction guides draw clipped tangent extensions, off-curve control polygon and cursor metrics',()=>{
  const m=map(),p=(x,y)=>m.screenToLatLng({x,y}),fixed=[p(200,400),p(400,400)],candidate=[...fixed,p(600,200)],paths=[],labels=[],circles=[],dashes=[];
  m.options={mode:'track',curveMode:'tangent',curveGuides:true,controlPoints:fixed,plan:fixed,previewControlPoints:candidate,previewPoints:candidate,previewMetrics:{length:2000,minRadius:500}};
  m.pixelPath=(_ctx,path)=>paths.push(path);
  const ctx={save(){},restore(){},stroke(){},fill(){},setLineDash(dash){dashes.push([...dash]);},beginPath(){},arc(x,y){circles.push({x,y});},fillRect(){},fillText(text){labels.push(text);},measureText(text){return {width:text.length*6};}};
  m.drawCurveGuides(ctx);
  assert.ok(paths.length>=5,'control polygon, both tangent extensions and their intersection are visible');
  assert.ok(paths.every(path=>path.every(point=>point.x>=-16.001&&point.x<=m.width+16.001&&point.y>=-16.001&&point.y<=m.height+16.001)));
  assert.ok(circles.some(point=>Math.abs(point.x-600)<1e-6&&Math.abs(point.y-200)<1e-6));assert.deepEqual(dashes,[[5,5],[]]);
  assert.ok(labels[0].includes('全長 2.00 km'));assert.ok(labels[0].includes('最小R 500 m'));assert.ok(labels[0].includes('交角 45.0°'));
  m.options.curveGuides=false;m.drawCurveGuides(new Proxy({}, {get(){throw new Error('Disabled guides must not draw');}}));
});

test('point mode shows both adjustable tangent squares even while invalid or prediction guides are off',()=>{
  const {m}=curveInputMap(),squares=[],paths=[],colors=[];m.options.curveGuides=false;m.options.previewInvalid=true;m.pixelPath=(_ctx,path)=>paths.push(path);
  const ctx={save(){},restore(){},setLineDash(){},stroke(){colors.push(this.strokeStyle);},fillRect(x,y,w,h){squares.push({x,y,w,h});},strokeRect(){}};
  m.drawCurveHandles(ctx);assert.equal(squares.length,4);assert.equal(paths.length,4);assert.ok(colors.every(color=>color==='#c36c65'));
  const m2=map(),p=(x,y)=>m2.screenToLatLng({x,y});m2.options={mode:'track',curveMode:'point',trackType:'single',controlPoints:[p(200,300),p(500,300),p(800,500)],curveHandles:[null,null,null]};
  const handles=m2.curveHandlePoints();assert.equal(handles.length,3);assert.ok(handles.every(handle=>Number.isFinite(handle.lat)&&Number.isFinite(handle.lng)));
  assert.notDeepEqual(handles[1],m2.options.controlPoints[1],'missing handles retain automatic editable tangents after validation failure');
});

function pointInputMap(mode='track'){
  const {m,captured}=curveInputMap(),events=[];m.options.mode=mode;m.options.curveMode='legacy';
  m.callbacks.onPlanPoint=(index,location,phase)=>{events.push({index,location,phase});const controls=[...m.options.controlPoints];controls[index]=location;m.setState(m.state,{controlPoints:controls,plan:controls});};
  return {m,captured,events};
}

test('point clicks retain click behavior while actual drags emit a single grouped edit without map movement',()=>{
  for(const mode of ['track','track-edit']){
    const {m,captured,events}=pointInputMap(mode),before=m.getView();let clicks=0;m.callbacks.onClick=()=>clicks++;
    m.pointerDown(pointerEvent(400,400,{button:0,buttons:1}));m.pointerMove(pointerEvent(403,400,{button:-1,buttons:1}));m.pointerUp(pointerEvent(403,400,{button:0,buttons:0}));
    assert.equal(clicks,1);assert.deepEqual(events,[],'three-pixel hand jitter remains an ordinary click');
    const original={...m.options.controlPoints[0]};
    m.pointerDown(pointerEvent(404,400,{button:0,buttons:1}));m.pointerMove(pointerEvent(450,440,{button:-1,buttons:1}));m.pointerUp(pointerEvent(450,440,{button:0,buttons:0}));
    assert.deepEqual(events.map(event=>event.phase),['start','move','end']);assert.deepEqual(events[0].location,original);
    const moved=m.latLngToScreen(events.at(-1).location);assert.ok(Math.abs(moved.x-446)<1e-6);assert.ok(Math.abs(moved.y-440)<1e-6,'drag preserves the pointer-to-point grab offset');
    assert.equal(clicks,1);assert.deepEqual(m.getView(),before);assert.equal(captured.size,0);assert.equal(m.planPointDrag,null);
  }
});

test('Escape cancels a point edit and consumes the key before the global archive action',()=>{
  const {m,events,captured}=pointInputMap(),original={...m.options.controlPoints[0]};let prevented=0,stopped=0,clicks=0;m.callbacks.onClick=()=>clicks++;
  m.pointerDown(pointerEvent(400,400,{button:0,buttons:1}));m.pointerMove(pointerEvent(470,430,{button:-1,buttons:1}));
  m.keyDown({key:'Escape',preventDefault(){prevented++;},stopPropagation(){stopped++;}});
  assert.deepEqual(events.map(event=>event.phase),['start','move','cancel']);assert.deepEqual(m.options.controlPoints[0],original);assert.equal(prevented,1);assert.equal(stopped,1);assert.equal(captured.size,0);
  m.pointerUp(pointerEvent(470,430,{button:0,buttons:0}));assert.equal(clicks,0);
});

test('pointer cancellation and mode changes roll back point drags without committing or clicking',()=>{
  for(const cancel of [m=>m.pointerCancel(),m=>m.setState(m.state,{mode:'station'})]){
    const {m,events,captured}=pointInputMap(),original={...m.options.controlPoints[0]};let clicks=0;m.callbacks.onClick=()=>clicks++;
    m.pointerDown(pointerEvent(400,400,{button:0,buttons:1}));m.pointerMove(pointerEvent(460,430,{button:-1,buttons:1}));cancel(m);
    assert.deepEqual(events.map(event=>event.phase),['start','move','cancel']);assert.deepEqual(m.options.controlPoints[0],original);assert.equal(captured.size,0);
    m.pointerUp(pointerEvent(460,430,{button:0,buttons:0}));assert.equal(clicks,0);
  }
});

test('touch point editing commits once before a second finger takes over pinch zoom',()=>{
  const {m,events,captured}=pointInputMap('track-edit');let clicks=0;m.callbacks.onClick=()=>clicks++;
  m.pointerDown(pointerEvent(400,400,{button:0,buttons:1,pointerType:'touch'}));m.pointerMove(pointerEvent(410,400,{button:-1,buttons:1,pointerType:'touch'}));
  m.pointerDown(pointerEvent(610,400,{pointerId:2,button:0,buttons:1,pointerType:'touch'}));assert.equal(m.planPointDrag,null);assert.deepEqual(events.map(event=>event.phase),['start','move','end']);
  m.pointerMove(pointerEvent(810,400,{pointerId:2,button:-1,buttons:1,pointerType:'touch'}));assert.equal(m.view.zoom,15);
  m.pointerUp(pointerEvent(810,400,{pointerId:2,button:0,buttons:0,pointerType:'touch'}));m.pointerUp(pointerEvent(410,400,{button:0,buttons:0,pointerType:'touch'}));
  assert.equal(clicks,0);assert.equal(captured.size,0);
});

test('archived draft selection finds the closest geometry or an off-curve raw control point',()=>{
  const m=map(),p=(x,y)=>m.screenToLatLng({x,y});
  m.options={draftStrokes:[{points:[p(200,300),p(300,250),p(400,300)],controlPoints:[p(200,300),p(300,100),p(400,300)]},{points:[p(200,320),p(400,320)],controlPoints:[p(200,320),p(400,320)]}]};
  assert.equal(m.nearestDraftStroke(p(300,100)),0,'off-curve tangent control points can select their draft');
  assert.equal(m.nearestDraftStroke(p(300,254)),0);assert.equal(m.nearestDraftStroke(p(300,317)),1);assert.equal(m.nearestDraftStroke(p(900,700)),null);
});

test('built track selection ignores blue and station internal rails while returning the closest owned line',()=>{
  const m=map(),p=(x,y)=>m.screenToLatLng({x,y});
  m.state.tracks=[{id:'owned',type:'single',points:[p(200,300),p(800,300)]},{id:'second',type:'double',points:[p(200,340),p(800,340)]},{id:'yard',stationTrack:true,type:'single',points:[p(200,302),p(800,302)]},{id:'existing:blue',type:'single',points:[p(200,301),p(800,301)]}];
  let hit=m.nearestOwnTrack(p(500,301));assert.equal(hit.track.id,'owned');assert.ok(Math.abs(hit.screenDistance-1)<1e-6);
  hit=m.nearestOwnTrack(p(500,335));assert.equal(hit.track.id,'second');assert.ok(Math.abs(m.latLngToScreen(hit.point).y-337)<1e-6,'selection projects to the nearest visible double-track rail');
  assert.equal(m.nearestOwnTrack(p(500,370)),null);
});

test('selection follows both visible rails of a high-zoom double track and its archived preview',()=>{
  const m=map();m.view.zoom=22;const p=(x,y)=>m.screenToLatLng({x,y}),track={id:'double',type:'double',points:[p(200,400),p(1000,400)]};
  m.state.tracks=[track];m.options={draftStrokes:[track]};const style=m.trackVisualStyle(track);assert.ok(style.gap>40);
  for(const offset of style.offsets){
    const location=p(600,400+offset+3),built=m.nearestOwnTrack(location,10);
    assert.equal(built.track.id,'double');assert.ok(Math.abs(built.screenDistance-3)<1e-6);assert.equal(m.nearestDraftStroke(location,10),0);
  }
});

test('selected owned tracks get a visible halo without highlighting station or preview rails',()=>{
  const m=map(),points=[m.screenToLatLng({x:200,y:300}),m.screenToLatLng({x:800,y:300})],strokes=[];
  m.options={selectedTrackId:'chosen'};m.path=()=>{};m.drawTrackDetails=()=>{};
  const ctx={setLineDash(){},stroke(){strokes.push({color:this.strokeStyle,width:this.lineWidth});}};
  m.drawTrack(ctx,{id:'chosen',type:'double',points});assert.ok(strokes.some(stroke=>stroke.color==='#de7725'&&stroke.width>10));
  strokes.length=0;m.drawTrack(ctx,{id:'chosen',stationTrack:true,type:'single',points});assert.ok(strokes.every(stroke=>stroke.color!=='#de7725'));
  strokes.length=0;m.drawTrack(ctx,{id:'chosen',type:'single',points},true);assert.ok(strokes.every(stroke=>stroke.color!=='#de7725'));
  m.eventPoint=event=>event.position;m.options.mode='track-edit';const before=m.getView();m.doubleClick({position:{x:600,y:400},preventDefault(){}});assert.deepEqual(m.getView(),before);
});

test('curve handle click jitter makes no history edit and Escape restores a started handle drag',()=>{
  const {m,events,captured}=curveInputMap(),original={...m.options.curveHandles[0]};let stopped=0;
  m.pointerDown(pointerEvent(500,360,{button:0,buttons:1}));m.pointerMove(pointerEvent(503,360,{button:-1,buttons:1}));m.pointerUp(pointerEvent(503,360,{button:0,buttons:0}));assert.deepEqual(events,[]);
  m.pointerDown(pointerEvent(500,360,{button:0,buttons:1}));m.pointerMove(pointerEvent(560,320,{button:-1,buttons:1}));m.keyDown({key:'Escape',preventDefault(){},stopPropagation(){stopped++;}});
  assert.deepEqual(events.map(event=>event.phase),['start','move','cancel']);assert.deepEqual(m.options.curveHandles[0],original);assert.equal(stopped,1);assert.equal(captured.size,0);
});
