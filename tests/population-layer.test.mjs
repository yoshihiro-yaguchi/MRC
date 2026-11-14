import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { PopulationLayer, populationColor } from '../dist/population-layer.js';

const view={lat:35.6812,lng:139.7671,zoom:14};

test('heat colors encode logarithmic density from cool blue through yellow to red',()=>{
  const low=populationColor(1),medium=populationColor(1000),high=populationColor(10000);
  assert.ok(low[2]>low[0]);assert.ok(medium[0]>medium[2]&&medium[1]>medium[2]);assert.ok(high[0]>high[1]);
  assert.deepEqual(populationColor(1e9),high);
});

test('the heat spatial query excludes distant cities and invalid census values',()=>{
  const layer=new PopulationLayer();
  layer.setData([{lat:view.lat,lng:view.lng,population:1000},{lat:view.lat+.001,lng:view.lng+.001,population:500},{lat:34.69,lng:135.5,population:10000},{lat:NaN,lng:139,population:20},{lat:35,lng:139,population:0}]);
  assert.equal(layer.count,3);
  const result=layer.rasterize(view,800,600);
  assert.equal(result.bins.reduce((total,bin)=>total+bin.total,0),1500);
  assert.ok(result.examined<layer.count);assert.ok(result.bins.every(bin=>bin.x>-bin.radius&&bin.x<800+bin.radius));
});

test('small scale cells aggregate without treating several cells as one inflated density',()=>{
  const layer=new PopulationLayer();layer.setData([{lat:view.lat,lng:view.lng,population:400},{lat:view.lat+.00001,lng:view.lng+.00001,population:600}]);
  const result=layer.rasterize({...view,zoom:9},800,600);
  assert.equal(result.bins.length,1);assert.equal(result.bins[0].cells,2);assert.equal(result.bins[0].total,1000);assert.equal(result.bins[0].population,500);
});

test('unchanged viewport reuses its heat raster while new census data invalidates the cache',()=>{
  const oldDocument=globalThis.document;let gradients=0,draws=0;
  const context={createRadialGradient(){gradients++;return {addColorStop(){}};},fillRect(){}};
  globalThis.document={createElement(){return {getContext(){return context;}};}};
  const layer=new PopulationLayer();layer.setData([{lat:view.lat,lng:view.lng,population:1000}]);
  const ctx={save(){},restore(){},drawImage(){draws++;}};
  try{
    layer.render(ctx,view,800,600);const first=gradients;assert.ok(first>0);
    layer.render(ctx,view,800,600);assert.equal(gradients,first);assert.equal(draws,2);
    layer.setData([{lat:view.lat,lng:view.lng,population:2000}]);layer.render(ctx,view,800,600);assert.ok(gradients>first);
  }finally{globalThis.document=oldDocument;}
});

test('the packaged nationwide census is indexed once and a city query examines only a local subset',async()=>{
  const data=JSON.parse(gunzipSync(await readFile(new URL('../dist/data/population.json.gz',import.meta.url))).toString('utf8'));
  const scale=data.coordinateScale||10000,popScale=data.populationScale||10;
  const cells=data.cells.map(row=>({lat:row[0]/scale,lng:row[1]/scale,population:row[2]/popScale}));
  const layer=new PopulationLayer();layer.setData(cells);
  assert.ok(layer.count>500000);
  const city=layer.rasterize(view,1200,800);assert.ok(city.bins.length>0);assert.ok(city.examined<layer.count*.03);
  const national=layer.rasterize({lat:37,lng:137,zoom:5},1200,800);assert.ok(national.bins.length<15000,'small map scales aggregate visible cells into bounded screen bins');
});
