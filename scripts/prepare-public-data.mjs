/**
 * Convert publicly distributed factual GIS data to GeoJSON.
 * This script is independently written. No Railway Canvas application source
 * is copied. See dist/data/ATTRIBUTION.md for original data attribution.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'data');
const base = 'https://g-9c0a390112994967af07c259f105e629.raconasu.com/_rgsandbox/game/9c0a3901-1299-4967-af07-c259f105e629/_v/27bc09ae-51aa-4195-b988-404b76d6262c/data/';
const get = async name => {
  const response = await fetch(base + name);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const decode = (buffer, offset, length) => JSON.parse(gunzipSync(buffer.subarray(offset, offset + length)));
const round = n => Math.round(n * 1e6) / 1e6;
const unproject = (x, y) => [round(x / 256 * 360 - 180), round(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 256))) * 180 / Math.PI)];

function lineFeatures(bytes, kind) {
  if (bytes.toString('ascii', 0, 4) !== 'WRA1') throw new Error('Unexpected geometry header');
  const count = bytes.readUInt32LE(4);
  let at = 8;
  const features = [];
  for (let i = 0; i < count; i++) {
    const n = bytes.readUInt16LE(at); at += 2;
    const coordinates = [];
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (let j = 0; j < n; j++) {
      const point = unproject(bytes.readUInt32LE(at) / 1e7, bytes.readUInt32LE(at + 4) / 1e7); at += 8;
      const previous = coordinates.at(-1);
      if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
      coordinates.push(point);
      bbox[0] = Math.min(bbox[0], point[0]); bbox[1] = Math.min(bbox[1], point[1]);
      bbox[2] = Math.max(bbox[2], point[0]); bbox[3] = Math.max(bbox[3], point[1]);
    }
    if (coordinates.length > 1) features.push({ type: 'Feature', properties: { type: kind }, bbox, geometry: { type: 'LineString', coordinates } });
  }
  if (at !== bytes.length) throw new Error('Unexpected geometry trailing bytes');
  return features;
}

await fs.mkdir(out, { recursive: true });
const [core, demand, town] = await Promise.all([
  get('core-351ea5834c33bd04.pack'),
  get('demand2-39025d0a1dcabfed.pack'),
  get('town-b1a68a9abc2a4ca4.pack'),
]);
const network = decode(core, 0, 298494);
const shinkansen = decode(core, 298494, 2193);
const lines = [
  ...lineFeatures(gunzipSync(core.subarray(300687, 2246256)), 'rail'),
  ...lineFeatures(gunzipSync(core.subarray(2246256, 2402944)), 'shinkansen'),
];
const stations = network.stations
  .filter(s => Number.isFinite(s[2]) && Number.isFinite(s[3]) && s[4] !== false)
  .map(s => ({ type: 'Feature', properties: { type: 'station', id: s[0], name: s[1], shinkansen: false }, geometry: { type: 'Point', coordinates: [s[3], s[2]] } }));
for (let i = 0; i < shinkansen.stations.length; i++) {
  const s = shinkansen.stations[i];
  stations.push({ type: 'Feature', properties: { type: 'station', id: `shinkansen-${i}`, name: s[0], line: s[1], shinkansen: true }, geometry: { type: 'Point', coordinates: [s[3], s[2]] } });
}
const geography = {
  type: 'FeatureCollection',
  metadata: {
    source: 'MLIT National Land Numerical Information N02-25 (2025) via publicly distributed Railway Canvas geography pack',
    sourceUrl: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    stationMetadataSource: network.source,
    transformation: 'Decoded WRA1 geographic coordinates to WGS84 GeoJSON, rounded to six decimals; application source not included.',
    retrievedAt: '2026-11-13',
    lineCount: lines.length,
    stationCount: stations.length,
  },
  features: [...lines, ...stations],
};
const land = decode(core, 2835251, 228347);
land.transformation = 'Extracted public CC BY 4.0 factual land-appraisal dataset from distribution container. Coordinate and price values unchanged.';
const populationGzip = demand.subarray(0, 2472492);
const population = JSON.parse(gunzipSync(populationGzip));
if (population.license !== 'CC BY 4.0') throw new Error('Population license changed');
const placenamesGzip = town.subarray(0, 2889015);
const names = JSON.parse(gunzipSync(placenamesGzip));
if (!names.source.includes('CC BY 4.0')) throw new Error('Placenames license changed');
await Promise.all([
  fs.writeFile(path.join(out, 'railways.json'), JSON.stringify(geography)),
  fs.writeFile(path.join(out, 'land-prices.json'), JSON.stringify(land)),
  fs.writeFile(path.join(out, 'population.json.gz'), populationGzip),
  fs.writeFile(path.join(out, 'placenames.json.gz'), placenamesGzip),
  fs.writeFile(path.join(out, 'metadata.json'), JSON.stringify({
    geography: geography.metadata,
    land: { ...land, points: undefined, pointsCount: land.points.length },
    population: { ...population, cells: undefined, cellsCount: population.cells.length },
    placenames: { source: names.source, pointsCount: names.points.length, namesCount: names.names.length, coordinateScale: 100000 },
  }, null, 2)),
]);
console.log(JSON.stringify({ lines: lines.length, stations: stations.length, landPoints: land.points.length, populationCells: population.cells.length, townPoints: names.points.length }));
