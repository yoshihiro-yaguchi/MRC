import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ExistingRailwayNetwork } from '../dist/existing-network.js';

const line = coordinates => ({ type: 'Feature', properties: { type: 'rail' }, geometry: { type: 'LineString', coordinates } });
const station = (id, coordinates) => ({ type: 'Feature', properties: { type: 'station', id, name: id }, geometry: { type: 'Point', coordinates } });
const data = () => ({ type: 'FeatureCollection', features: [
  line([[139.76,35.68],[139.765,35.68],[139.77,35.68]]),
  line([[139.77,35.68],[139.78,35.68]]),
  line([[139.765,35.679],[139.765,35.681]]),
  station('east',[139.775,35.68003]), station('west',[139.762,35.68]), station('cross',[139.765,35.6808]),station('hub',[139.765,35.68003]),
  { ...line([[139.76,35.69],[139.78,35.69]]), properties:{type:'shinkansen'} },
  { ...station('bullet',[139.77,35.69]), properties:{type:'station',id:'bullet',shinkansen:true} },
] });
const emptyGraph = () => ({ nodes: new Map(), stationNodes: new Map() });
function reachable(graph, start, target) {
  const pending=[start],seen=new Set(pending);
  for(let i=0;i<pending.length;i++) {
    const key=pending[i];if(key===target)return true;
    for(const edge of graph.nodes.get(key)?.edges||[])if(!seen.has(edge.to)){seen.add(edge.to);pending.push(edge.to);}
  }
  return false;
}

test('existing railway snapping follows geometry and excludes purple high-speed tracks',()=>{
  const network=new ExistingRailwayNetwork(data());
  const hit=network.nearestTrack({lat:35.68002,lng:139.762});
  assert.ok(hit);assert.equal(hit.track.type,'existing');assert.equal(hit.track.id,'existing:0');
  assert.ok(Math.abs(hit.point.lat-35.68)<1e-9);assert.ok(hit.distance>1&&hit.distance<3);
  assert.ok(hit.offset>100);assert.equal(network.nearestTrack({lat:35.69,lng:139.77},80),null);
  assert.equal(network.getStation('bullet'),null);
});

test('shared track lookup provides detached construction geometry and tangent metadata',()=>{
  const network=new ExistingRailwayNetwork(data()),track=network.getTrack('existing:0');
  assert.equal(track.id,'existing:0');assert.equal(track.type,'existing');assert.ok(track.length>800);
  const before=network.nearestTrack({lat:35.68002,lng:139.762});
  assert.equal(before.angle,0);assert.equal(before.bearing,0);assert.equal(before.side,1);
  assert.equal(network.nearestTrack({lat:35.67998,lng:139.762}).side,-1);
  const vertical=network.nearestTrack({lat:35.6805,lng:139.76501});
  assert.ok(Math.abs(vertical.angle-Math.PI/2)<1e-12);assert.equal(vertical.bearing,90);
  track.points[0].lat=0;track.offsets[0]=99;track.junctions[0].point.lng=0;
  assert.equal(network.getTrack('existing:0').points[0].lat,35.68);
  assert.equal(network.getTrack('existing:0').offsets[0],0);
  assert.equal(network.getTrack('existing:0').junctions[0].point.lng,139.76);
  assert.equal(network.getTrack('existing:7'),null,'purple high-speed lines are not constructible');
  assert.equal(network.getTrack('missing'),null);
});

test('registered blue stations connect across exact source line endpoints and preserve edge geometry',()=>{
  const network=new ExistingRailwayNetwork(data()),graph=emptyGraph();
  network.augmentGraph(graph,{tracks:[],stations:[{id:'from',existing:true,sourceStationId:'west'},{id:'to',existing:true,sourceStationId:'east'}]});
  const from=graph.stationNodes.get('from')[0],to=graph.stationNodes.get('to')[0];
  assert.ok(reachable(graph,from,to));assert.ok(reachable(graph,to,from));
  for(const node of graph.nodes.values())for(const edge of node.edges){
    assert.deepEqual(edge.points[0],node.point);assert.deepEqual(edge.points.at(-1),graph.nodes.get(edge.to).point);
    assert.ok(edge.distance>=0);
  }
  const east=network.getStation('east');
  assert.equal(east.lat,35.68);assert.equal(east.sourceLat,35.68003);
});

test('a physical user track endpoint connects to a blue line and then to a registered station',()=>{
  const network=new ExistingRailwayNetwork(data()),graph=emptyGraph();
  const track={id:'custom',type:'double',points:[{lat:35.679,lng:139.762},{lat:35.68,lng:139.762}]};
  graph.nodes.set('custom|start|1',{key:'custom|start|1',point:track.points[0],track,edges:[{to:'custom|end|1',distance:111,trackId:track.id,type:'double'}]});
  graph.nodes.set('custom|end|1',{key:'custom|end|1',point:track.points[1],track,edges:[]});
  graph.stationNodes.set('home',['custom|start|1']);
  const state={tracks:[track],stations:[{id:'dest',existing:true,sourceStationId:'east'}]};
  const before=JSON.stringify(state);network.augmentGraph(graph,state);
  assert.ok(reachable(graph,graph.stationNodes.get('home')[0],graph.stationNodes.get('dest')[0]));
  assert.equal(JSON.stringify(state),before);
});

test('configured station tracks attach to blue rails only at exact open ports and never through a buffer',()=>{
  for(const [latitude,open,configured,expected] of [[35.68,true,true,true],[35.68,false,true,false],[35.68002,true,true,false],[35.68002,true,false,true]]){
    const network=new ExistingRailwayNetwork(data()),graph=emptyGraph();
    const track={id:'platform',type:'single',stationTrack:true,stationWiring:configured,stationPorts:{a:open,b:true},points:[{lat:latitude,lng:139.762},{lat:35.679,lng:139.762}]};
    graph.nodes.set('platform|start|0',{key:'platform|start|0',point:track.points[0],track,edges:[{to:'platform|end|0',distance:111,trackId:track.id,type:'single'}]});
    graph.nodes.set('platform|end|0',{key:'platform|end|0',point:track.points[1],track,edges:[{to:'platform|start|0',distance:111,trackId:track.id,type:'single'}]});
    graph.stationNodes.set('home',['platform|end|0']);
    network.augmentGraph(graph,{tracks:[track],stations:[{id:'dest',existing:true,sourceStationId:'east'}]});
    assert.equal(reachable(graph,'platform|end|0',graph.stationNodes.get('dest')[0]),expected,`lat=${latitude} open=${open} configured=${configured}`);
  }
});

test('crossing blue lines do not connect without a shared source endpoint',()=>{
  const network=new ExistingRailwayNetwork(data()),graph=emptyGraph();
  network.augmentGraph(graph,{tracks:[],stations:[{id:'main',existing:true,sourceStationId:'west'},{id:'cross',existing:true,sourceStationId:'cross'}]});
  assert.equal(reachable(graph,graph.stationNodes.get('main')[0],graph.stationNodes.get('cross')[0]),false);
});

test('only an explicitly registered source station shares platforms within 80 metres',()=>{
  const network=new ExistingRailwayNetwork(data()),graph=emptyGraph(),hub=network.getStation('hub');
  const state={tracks:[],stations:[{id:'main',existing:true,sourceStationId:'west'},{id:'cross',existing:true,sourceStationId:'cross'},{...hub,id:'chosen-hub',existing:true,sourceStationId:'hub'}]};
  network.augmentGraph(graph,state);
  assert.ok(reachable(graph,graph.stationNodes.get('main')[0],graph.stationNodes.get('cross')[0]));
  const hubKey=graph.stationNodes.get('chosen-hub')[0];assert.ok(graph.stationNodes.get('chosen-hub').length>1);
  assert.deepEqual(graph.nodes.get(hubKey).point,{lat:hub.lat,lng:hub.lng});
  const connectedTracks=graph.nodes.get(hubKey).edges.map(edge=>edge.trackId);
  assert.equal(new Set(connectedTracks).size,connectedTracks.length);
  const fresh=emptyGraph();network.augmentGraph(fresh,{tracks:[],stations:state.stations.slice(0,2)});
  assert.equal(reachable(fresh,fresh.stationNodes.get('main')[0],fresh.stationNodes.get('cross')[0]),false);
});

test('a new player platform does not implicitly merge nearby pre-existing lines',()=>{
  const network=new ExistingRailwayNetwork(data()),graph=emptyGraph();
  network.augmentGraph(graph,{tracks:[],stations:[{id:'new',onExistingTrack:true,lat:35.68,lng:139.765,trackId:'existing:0'},{id:'cross',existing:true,sourceStationId:'cross'}]});
  assert.equal(reachable(graph,graph.stationNodes.get('new')[0],graph.stationNodes.get('cross')[0]),false);
});

test('an exact source endpoint meeting an intermediate source vertex is a real T junction',()=>{
  const fixture={features:[line([[139.76,35.68],[139.765,35.68],[139.77,35.68]]),line([[139.765,35.68],[139.765,35.685]]),station('a',[139.762,35.68]),station('b',[139.765,35.684])]};
  const network=new ExistingRailwayNetwork(fixture),graph=emptyGraph();
  network.augmentGraph(graph,{tracks:[],stations:[{id:'a',existing:true,sourceStationId:'a'},{id:'b',existing:true,sourceStationId:'b'}]});
  assert.ok(reachable(graph,graph.stationNodes.get('a')[0],graph.stationNodes.get('b')[0]));
});

test('a user track crossing a blue line in its middle does not create a junction',()=>{
  const network=new ExistingRailwayNetwork(data()),graph=emptyGraph();
  const track={id:'crossing',type:'single',points:[{lat:35.679,lng:139.763},{lat:35.681,lng:139.763}]};
  graph.nodes.set('crossing|a|0',{key:'crossing|a|0',point:track.points[0],track,edges:[{to:'crossing|b|0',distance:222}]});
  graph.nodes.set('crossing|b|0',{key:'crossing|b|0',point:track.points[1],track,edges:[]});
  network.augmentGraph(graph,{tracks:[track],stations:[{id:'dest',existing:true,sourceStationId:'east'}]});
  assert.equal(reachable(graph,'crossing|a|0',graph.stationNodes.get('dest')[0]),false);
});

test('new stations directly on an existing line participate without source station identifiers',()=>{
  const network=new ExistingRailwayNetwork(data()),graph=emptyGraph();
  network.augmentGraph(graph,{tracks:[],stations:[{id:'new',onExistingTrack:true,lat:35.68,lng:139.763,trackId:'existing:0'},{id:'dest',existing:true,sourceStationId:'east'}]});
  assert.ok(reachable(graph,graph.stationNodes.get('new')[0],graph.stationNodes.get('dest')[0]));
});

test('paid new blue-line stations are real intermediate stops in both directions without becoming shared interchange stations',()=>{
  const network=new ExistingRailwayNetwork(data()),graph=emptyGraph(),middle={id:'new-paid',existingTrack:true,lat:35.68,lng:139.763,trackId:'existing:0'};
  const state={tracks:[],stations:[{id:'west',existing:true,sourceStationId:'west'},middle,{id:'east',existing:true,sourceStationId:'east'},{id:'cross',existing:true,sourceStationId:'cross'}]},before=JSON.stringify(state);
  network.augmentGraph(graph,state);
  const mid=graph.stationNodes.get(middle.id)[0],west=graph.stationNodes.get('west')[0],east=graph.stationNodes.get('east')[0],cross=graph.stationNodes.get('cross')[0];
  assert.ok(reachable(graph,west,mid));assert.ok(reachable(graph,mid,east));assert.ok(reachable(graph,east,mid));assert.ok(reachable(graph,mid,west));
  assert.equal(reachable(graph,mid,cross),false);assert.equal(graph.stationNodes.get(middle.id).length,1);
  const incoming=[...graph.nodes.values()].flatMap(node=>node.edges.filter(edge=>edge.to===mid));
  assert.ok(incoming.length>=2);assert.ok(incoming.every(edge=>edge.type==='existing'));
  assert.equal(state.tracks.length,0);assert.equal(JSON.stringify(state),before);
});

test('dynamic query cuts cannot contaminate the cached topology or subsequent route queries',()=>{
  const network=new ExistingRailwayNetwork(data()),before=[...network.baseNodes.values()].map(n=>[n.key,n.edges.length]);
  const first=emptyGraph();network.augmentGraph(first,{tracks:[],stations:[{id:'old',existing:true,sourceStationId:'east'}]});
  const second=emptyGraph();network.augmentGraph(second,{tracks:[],stations:[{id:'new',existing:true,sourceStationId:'west'}]});
  assert.equal(second.stationNodes.has('old'),false);
  assert.deepEqual([...network.baseNodes.values()].map(n=>[n.key,n.edges.length]),before);
  for(let i=0;i<100;i++)network.nearestTrack({lat:35.68+i*.0000001,lng:139.762});
  assert.equal(network.stationCache.size,2);
});

test('actual national topology connects Tokyo and Shinjuku without importing tracks into the game',async()=>{
  const source=JSON.parse(await readFile(new URL('../dist/data/railways.json',import.meta.url),'utf8'));
  const network=new ExistingRailwayNetwork(source);assert.ok(network.tracks.size>20000);assert.ok(network.baseNodes.size<25000);
  const tokyo=network.getStation('tokyo'),shinjuku=network.getStation('shinjuku');assert.ok(tokyo&&shinjuku);
  const state={tracks:[],stations:[{id:'tokyo',existing:true,sourceStationId:'tokyo'},{id:'shinjuku',existing:true,sourceStationId:'shinjuku'}]},graph=emptyGraph();
  network.augmentGraph(graph,state);
  assert.ok(reachable(graph,graph.stationNodes.get('tokyo')[0],graph.stationNodes.get('shinjuku')[0]));
  assert.equal(state.tracks.length,0);assert.ok(network.getStation('kanto5_95ab80bcddc07dc'));
});
