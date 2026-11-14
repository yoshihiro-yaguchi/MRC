import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine.js';
import { ExistingRailwayNetwork } from '../dist/existing-network.js';

const location = lng => ({ lat:35.68,lng });
const config = (direction='both',a='independent',b='independent') => ({ a,b,direction });
const options = trackConfigs => ({placement:'free',layoutId:'island-2',wiringMode:'platforms',bearing:0,trackConfigs});
function addStation(state,lng,trackConfigs=[config(),config()]) {
  const result=E.buildStation(state,location(lng),8,`駅${lng}`,options(trackConfigs));
  assert.equal(result.ok,true,result.error);return result.station;
}
function port(station,number,end) {
  return E.stationGeometry(station).connectionPorts.find(port=>port.end===end&&port.platformNumbers.includes(number)).point;
}
function connect(state,from,to,number=1) {
  const result=E.buildTrack(state,[port(from,number,'b'),port(to,number,'a')],'single');
  assert.equal(result.ok,true,result.error);return result.track;
}
function pair(trackConfigs=[config(),config()]) {
  E.setExistingNetwork(null);const state=E.createGame();state.unlimited=true;
  const west=addStation(state,139.76,trackConfigs),east=addStation(state,139.78,trackConfigs);
  connect(state,west,east,1);connect(state,west,east,2);return {state,west,east};
}
const assignments=(west,east,forward=1,backward=2)=>({forward:{[west.id]:forward,[east.id]:forward},backward:{[east.id]:backward,[west.id]:backward}});

test('six-track wiring keeps north/south destination groups separate and exposes terminal buffer stops',()=>{
  const trackConfigs=[config('forward','group1','group1'),config('forward','group1','group1'),config('reverse','group2','group2'),config('reverse','group2','group2'),config('both','independent','buffer'),config('both','independent','buffer')];
  const geometry=E.stationGeometry({...location(139.76),cars:8,layoutId:'island-6',standalone:true,wiringMode:'platforms',bearing:90,trackConfigs});
  assert.equal(geometry.connections.length,6);assert.equal(geometry.bufferStops.length,2);
  assert.deepEqual(geometry.connectionPorts.find(p=>p.key==='b:group1').platformNumbers,[1,2]);
  assert.deepEqual(geometry.connectionPorts.find(p=>p.key==='a:group2').platformNumbers,[3,4]);
  assert.ok(E.distance(geometry.connectionPorts[0].point,geometry.connectionPorts[1].point)>17.9);
  for(const index of [4,5])assert.deepEqual(geometry.trackPaths[index][2],geometry.trackPaths[index][3]);
  for(const bearing of [0,45,90,180,270,359])assert.deepEqual(E.stationEndLabels(bearing),{a:'A側',b:'B側'});
});

test('one-way platforms enforce independently selected outward and return station tracks',()=>{
  const {state,west,east}=pair([config('forward'),config('reverse')]);
  const result=E.createRoute(state,{startId:west.id,endId:east.id,cars:8,platformAssignments:assignments(west,east)});
  assert.equal(result.ok,true,result.error);assert.deepEqual(result.route.selectedPlatforms,assignments(west,east));
  const wrong=E.createRoute(state,{startId:west.id,endId:east.id,platformAssignments:assignments(west,east,2,1)});
  assert.equal(wrong.ok,false);assert.match(wrong.error,/往路の番線/);
  assert.equal(E.findPath(state,east.id,west.id,{platforms:{[east.id]:1,[west.id]:1}}),null);
  assert.ok(result.route.trackIds.includes(E.getStationPlatforms(state,west)[1].trackId),'return platform tracks are part of route dependencies');
});

test('independent adjacent station rails never silently join through the old five metre tolerance',()=>{
  E.setExistingNetwork(null);const state=E.createGame();state.unlimited=true;
  const opts={placement:'free',layoutId:'island-4',wiringMode:'platforms'};
  const west=E.buildStation(state,location(139.76),8,'西',opts).station,east=E.buildStation(state,location(139.78),8,'東',opts).station;
  connect(state,west,east,2);connect(state,west,east,3);
  const first=E.getStationPlatforms(state,west)[1],second=E.getStationPlatforms(state,east)[2];
  assert.ok(E.findPath(state,west.id,east.id,{platforms:{[west.id]:2,[east.id]:2}}));
  assert.equal(E.findPath(state,west.id,east.id,{platforms:{[west.id]:2,[east.id]:3}}),null);
  const nativeFirst=state.tracks.find(t=>t.id===first.trackId),nativeSecond=state.tracks.find(t=>t.id===E.getStationPlatforms(state,west)[2].trackId);
  assert.ok(E.distance(nativeFirst.points[1],nativeSecond.points[1])<5,'platform rails only four metres apart must remain distinct');
  assert.notEqual(first.trackId,second.trackId);
});

test('a common destination port connects only the grouped platforms, leaving a third port isolated',()=>{
  E.setExistingNetwork(null);const state=E.createGame();state.unlimited=true;
  const groupConfigs=[config('both','group1','group1'),config('both','group1','group1'),config()];
  const opts={placement:'free',layoutId:'mixed-3',wiringMode:'platforms',trackConfigs:groupConfigs};
  const west=E.buildStation(state,location(139.76),8,'西',opts).station,east=E.buildStation(state,location(139.78),8,'東',opts).station;
  connect(state,west,east,1);
  assert.ok(E.findPath(state,west.id,east.id,{platforms:{[west.id]:1,[east.id]:2}}));
  assert.equal(E.findPath(state,west.id,east.id,{platforms:{[west.id]:1,[east.id]:3}}),null);
});

test('terminal platforms allow arrival and turnback while buffers reject physical connections',()=>{
  E.setExistingNetwork(null);const state=E.createGame();state.unlimited=true;
  const west=addStation(state,139.76),east=addStation(state,139.78,[config('both','independent','buffer'),config('both','independent','buffer')]);
  connect(state,west,east,1);connect(state,west,east,2);
  const result=E.createRoute(state,{startId:west.id,endId:east.id,platformAssignments:assignments(west,east,1,1)});
  assert.equal(result.ok,true,result.error);
  const buffer=E.stationGeometry(east).bufferStops[0].point,before=E.serializeGame(state);
  const rejected=E.buildTrack(state,[buffer,{lat:buffer.lat,lng:buffer.lng+.01}],'single');
  assert.equal(rejected.ok,false);assert.match(rejected.error,/車止め/);assert.equal(E.serializeGame(state),before);
  state.tracks.push({id:'invalid-buffer-attachment',type:'single',points:[buffer,location(139.80)]});
  const outside=E.buildStation(state,location(139.795),1,'車止めの外',{placement:'track'});
  assert.equal(outside.ok,true,outside.error);
  assert.equal(E.findPath(state,east.id,outside.station.id,{platforms:{[east.id]:1}}),null,'even malformed saved tracks cannot enter a buffer');
});

test('explicit intermediate platform choices are enforced and cannot silently skip the selected station',()=>{
  E.setExistingNetwork(null);const state=E.createGame();state.unlimited=true;
  const west=addStation(state,139.76),middle=addStation(state,139.77),east=addStation(state,139.78);
  for(const number of [1,2]){connect(state,west,middle,number);connect(state,middle,east,number);}
  const good=E.createRoute(state,{startId:west.id,endId:east.id,platformAssignments:{forward:{[west.id]:1,[middle.id]:1,[east.id]:1},backward:{[east.id]:2,[middle.id]:2,[west.id]:2}}});
  assert.equal(good.ok,true,good.error);assert.equal(good.route.selectedPlatforms.forward[middle.id],1);assert.equal(good.route.selectedPlatforms.backward[middle.id],2);
  const bad=E.findPath(state,west.id,east.id,{platforms:{[west.id]:1,[middle.id]:2,[east.id]:1}});assert.equal(bad,null);
  const unrelated=addStation(state,139.81);
  assert.equal(E.findPath(state,west.id,east.id,{platforms:{[unrelated.id]:1}}),null);
});

test('invalid terminal, direction and platform requests fail without mutating construction or routes',()=>{
  const state=E.createGame(),before=E.serializeGame(state);
  for(const trackConfigs of [[config('forward','independent','buffer'),config()],[config('both','buffer','buffer'),config()],[{a:'bogus',b:'independent',direction:'both'},config()]]){
    assert.equal(E.buildStation(state,location(139.76),8,'無効',options(trackConfigs)).ok,false);assert.equal(E.serializeGame(state),before);
  }
  const {state:connected,west,east}=pair();const saved=E.serializeGame(connected);
  for(const platformAssignments of [{forward:{[west.id]:3}},{backward:{missing:1}},{forward:{[west.id]:1.5}},[]]){
    assert.equal(E.createRoute(connected,{startId:west.id,endId:east.id,platformAssignments}).ok,false);assert.equal(E.serializeGame(connected),saved);
  }
});

test('route platform edits are atomic and preserve accumulated operation history',()=>{
  const {state,west,east}=pair();
  const created=E.createRoute(state,{startId:west.id,endId:east.id,platformAssignments:assignments(west,east,1,1)});assert.equal(created.ok,true,created.error);
  Object.assign(created.route,{revenue:500,cost:20,passengers:9,trips:3});const id=created.route.id,money=state.money;
  const updated=E.updateRoutePlatforms(state,id,assignments(west,east,2,2));assert.equal(updated.ok,true,updated.error);
  assert.equal(updated.route.id,id);assert.equal(updated.route.revenue,500);assert.equal(updated.route.trips,3);assert.equal(updated.route.selectedPlatforms.forward[west.id],2);assert.equal(state.money,money);
  const saved=E.serializeGame(state);assert.equal(E.updateRoutePlatforms(state,id,assignments(west,east,3,1)).ok,false);assert.equal(E.serializeGame(state),saved);
});

test('station rewiring recalculates routes, preserves rail identities and rejects changes that strand a route',()=>{
  const {state,west,east}=pair();const created=E.createRoute(state,{startId:west.id,endId:east.id});assert.equal(created.ok,true,created.error);
  created.route.revenue=999;const id=created.route.id,railIds=west.platformTrackIds.slice();
  const updated=E.updateStationWiring(state,west.id,{wiringMode:'platforms',trackConfigs:[config('forward'),config('reverse')]});
  assert.equal(updated.ok,true,updated.error);assert.deepEqual(updated.station.platformTrackIds,railIds);assert.equal(state.routes[0].id,id);assert.equal(state.routes[0].revenue,999);
  assert.equal(state.routes[0].selectedPlatforms.forward[west.id],1);assert.equal(state.routes[0].selectedPlatforms.backward[west.id],2);
  const saved=E.serializeGame(state);
  const failed=E.updateStationWiring(state,west.id,{wiringMode:'platforms',trackConfigs:[config('forward'),config('forward')]});
  assert.equal(failed.ok,false);assert.match(failed.error,/路線/);assert.equal(E.serializeGame(state),saved);
});

test('wiring, turnback ends and route selections survive save reload and old merged station saves still work',()=>{
  const {state,west,east}=pair([config('forward'),config('reverse')]);state.layer='relief';state.populationVisible=true;E.createRoute(state,{startId:west.id,endId:east.id,platformAssignments:assignments(west,east)});
  const loaded=E.deserializeGame(E.serializeGame(state));assert.deepEqual(loaded.stations[0].trackConfigs,west.trackConfigs);assert.equal(loaded.stations[0].wiringMode,'platforms');
  assert.equal(loaded.layer,'relief');assert.equal(loaded.populationVisible,true);
  assert.deepEqual(loaded.routes[0].platformAssignments,state.routes[0].platformAssignments);assert.deepEqual(loaded.routes[0].selectedPlatforms,state.routes[0].selectedPlatforms);
  assert.ok(E.findPath(loaded,west.id,east.id,{platforms:loaded.routes[0].platformAssignments.forward}));
  assert.equal(E.findPath(loaded,east.id,west.id,{platforms:{[east.id]:1}}),null);
  const old=E.createGame();old.unlimited=true;const legacy=E.buildStation(old,location(139.76),8,'旧駅',{placement:'free',layoutId:'island-4'}).station;
  delete legacy.wiringMode;delete legacy.trackConfigs;const restored=E.deserializeGame(E.serializeGame(old));
  assert.equal(E.stationGeometry(restored.stations[0]).connections.length,2);assert.equal(restored.stations[0].wiringMode,'merged');
  assert.deepEqual(E.getStationTrackConfigs({...legacy,wiringMode:'merged',trackConfigs:[config('reverse','buffer','independent')]}),Array.from({length:4},()=>config('both','group1','group1')));
});

test('paid stations on arbitrary blue line positions reuse the source geometry and survive saving without provider data loaded',()=>{
  const source={type:'FeatureCollection',features:[{type:'Feature',properties:{type:'rail'},geometry:{type:'LineString',coordinates:[[139.76,35.68],[139.765,35.68]]}},{type:'Feature',properties:{type:'rail'},geometry:{type:'LineString',coordinates:[[139.765,35.68],[139.78,35.68]]}}]};
  const provider=new ExistingRailwayNetwork(source);E.setExistingNetwork(provider);const state=E.createGame(),before=state.money;
  const first=E.buildStation(state,location(139.76499),8,'新設青線駅',{placement:'track',layoutId:'side-1',existingTrackId:'existing:0'});
  assert.equal(first.ok,true,first.error);assert.equal(first.station.existingTrack,true);assert.equal(first.station.existing,undefined);assert.equal(state.tracks.length,0);assert.equal(first.costBreakdown.tracks,0);assert.equal(state.money,before-first.cost);
  const second=E.buildStation(state,location(139.775),8,'青線東駅',{placement:'track',layoutId:'side-1',existingTrackId:'existing:1'});assert.equal(second.ok,true,second.error);
  const route=E.createRoute(state,{startId:first.station.id,endId:second.station.id,platformAssignments:assignments(first.station,second.station,1,1)});assert.equal(route.ok,true,route.error);
  assert.ok(route.route.points.some(point=>Math.abs(point.lng-.0-139.765)<1e-7));
  E.setExistingNetwork(null);const loaded=E.deserializeGame(E.serializeGame(state));assert.equal(loaded.stations[0].existingTrack,true);assert.equal(loaded.stations[0].cost,first.cost);assert.equal(loaded.tracks.length,0);
  E.setExistingNetwork(provider);assert.ok(E.findPath(loaded,first.station.id,second.station.id));E.setExistingNetwork(null);
});

test('every independent preset track extends straight through its physical ports at every station rotation',()=>{
  for(const layout of E.STATION_LAYOUTS)for(let bearing=0;bearing<360;bearing+=15){
    const geometry=E.stationGeometry({...location(139.76),cars:8,layoutId:layout.id,standalone:true,wiringMode:'platforms',bearing});
    assert.equal(geometry.portGeometry,'straight');
    const cosine=Math.cos(35.68*Math.PI/180);
    const vector=(a,b)=>({x:(b.lng-a.lng)*cosine,y:b.lat-a.lat});
    for(const [index,path] of geometry.trackPaths.entries()){
      const body=vector(path[1],path[2]);
      for(const [start,end] of [[path[0],path[1]],[path[2],path[3]]]){
        const approach=vector(start,end);
        assert.ok(Math.abs(body.x*approach.y-body.y*approach.x)<1e-13,`${layout.id}, ${bearing}°, ${index+1}番線 must not flare`);
        assert.ok(body.x*approach.x+body.y*approach.y>0,'the port extends outward, never folds back');
      }
    }
    for(const end of ['a','b']){
      const ports=geometry.connectionPorts.filter(port=>port.end===end);
      assert.equal(ports.length,layout.tracks);
      assert.equal(new Set(ports.map(port=>`${port.point.lat},${port.point.lng}`)).size,layout.tracks);
    }
    assert.deepEqual(E.stationEndLabels(bearing),{a:'A側',b:'B側'});
  }
});

test('new straight port construction uses its actual shorter rails and narrower footprint',()=>{
  const state=E.createGame(),opts={placement:'free',layoutId:'island-8',wiringMode:'platforms',bearing:30};state.unlimited=true;
  const preview=E.previewStation(state,location(139.76),8,opts),spread=E.previewStation(state,location(139.76),8,{...opts,portGeometry:'spread'});
  assert.equal(preview.ok,true,preview.error);assert.equal(spread.ok,true,spread.error);
  assert.ok(preview.geometry.width<spread.geometry.width);assert.ok(preview.costBreakdown.tracks<spread.costBreakdown.tracks);
  const built=E.buildStation(state,location(139.76),8,'直線駅',opts);assert.equal(built.ok,true,built.error);assert.equal(built.station.portGeometry,'straight');assert.equal(built.cost,preview.cost);
  for(const track of state.tracks)assert.deepEqual(track.points,preview.geometry.trackPaths[track.platformIndex]);
  const loaded=E.deserializeGame(E.serializeGame(state));assert.equal(loaded.stations[0].portGeometry,'straight');assert.deepEqual(E.stationGeometry(loaded.stations[0]).connections,preview.geometry.connections);
});

test('older spread-port saves retain physical connections and valid routes instead of silently moving their ports',()=>{
  E.setExistingNetwork(null);const state=E.createGame();state.unlimited=true;
  const opts={...options([config(),config()]),portGeometry:'spread'};
  const west=E.buildStation(state,location(139.76),8,'旧西駅',opts).station,east=E.buildStation(state,location(139.78),8,'旧東駅',opts).station;
  connect(state,west,east,1);connect(state,west,east,2);
  assert.equal(E.createRoute(state,{startId:west.id,endId:east.id,platformAssignments:assignments(west,east)}).ok,true);
  const oldConnections=E.stationGeometry(west).connections,oldTracks=state.tracks.map(track=>track.points);
  delete west.portGeometry;delete east.portGeometry;
  const loaded=E.deserializeGame(E.serializeGame(state));
  assert.equal(loaded.stations[0].portGeometry,'spread');assert.deepEqual(E.stationGeometry(loaded.stations[0]).connections,oldConnections);assert.deepEqual(loaded.tracks.map(track=>track.points),oldTracks);
  assert.ok(E.findPath(loaded,west.id,east.id,{platforms:assignments(west,east).forward}));
  const kept=E.updateStationWiring(loaded,west.id,{wiringMode:'platforms',trackConfigs:[config(),config()]});assert.equal(kept.ok,true,kept.error);assert.equal(kept.station.portGeometry,'spread');
  const saved=E.serializeGame(loaded),migration=E.updateStationWiring(loaded,west.id,{wiringMode:'platforms',portGeometry:'straight',trackConfigs:[config(),config()]});
  assert.equal(migration.ok,false,'a deliberate geometry migration must reject a route whose old external endpoints would disconnect');assert.equal(E.serializeGame(loaded),saved);
});

test('mixed shared and straight independent ports never collide or connect separately wired routes',()=>{
  E.setExistingNetwork(null);
  const trackConfigs=[config('both','group1','group1'),config(),config('both','group1','group1'),config(),config(),config('both','group1','group1')];
  const opts={placement:'free',layoutId:'island-6',wiringMode:'platforms',trackConfigs};
  for(const bearing of [0,30,90,175,270]){
    const geometry=E.stationGeometry({...location(139.76),...opts,standalone:true,cars:8,bearing});
    for(const end of ['a','b']){
      const ports=geometry.connectionPorts.filter(port=>port.end===end);
      for(let i=0;i<ports.length;i++)for(let j=i+1;j<ports.length;j++)assert.ok(E.distance(ports[i].point,ports[j].point)>.99,'a shared port must remain at least one metre from every independent port');
    }
    const cosine=Math.cos(35.68*Math.PI/180);
    for(const index of [1,3,4]){
      const path=geometry.trackPaths[index],body={x:(path[2].lng-path[1].lng)*cosine,y:path[2].lat-path[1].lat};
      for(const [a,b] of [[path[0],path[1]],[path[2],path[3]]])assert.ok(Math.abs(body.x*(b.lat-a.lat)-body.y*(b.lng-a.lng)*cosine)<1e-13,'collision avoidance must never move an independent port');
    }
  }
  const state=E.createGame();state.unlimited=true;
  const west=E.buildStation(state,location(139.76),8,'共有口混在西駅',opts).station,east=E.buildStation(state,location(139.78),8,'共有口混在東駅',opts).station;
  connect(state,west,east,1);connect(state,west,east,2);
  assert.ok(E.findPath(state,west.id,east.id,{platforms:{[west.id]:1,[east.id]:1}}));
  assert.ok(E.findPath(state,west.id,east.id,{platforms:{[west.id]:2,[east.id]:2}}));
  assert.equal(E.findPath(state,west.id,east.id,{platforms:{[west.id]:1,[east.id]:2}}),null,'the group route cannot switch into the independently wired second platform');
  const spread=E.stationGeometry({...location(139.76),...opts,standalone:true,cars:8,portGeometry:'spread'});
  const oldGroup=spread.connectionPorts.find(port=>port.key==='a:group1'),oldIndependent=spread.connectionPorts.find(port=>port.key==='a:track2');
  assert.ok(Math.abs(E.distance(oldGroup.point,oldIndependent.point)-18)<.01,'legacy spread geometry remains unchanged');
});
