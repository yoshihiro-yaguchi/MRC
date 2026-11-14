// Independent topology adapter for the public N02-25 railway geography.
// Only exact source endpoints join lines. Geometric crossings never create
// connections, and the nationwide network is not copied into the saved world.
const EARTH = 6371008.8, RAD = Math.PI / 180, GRID = .01;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const valid = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng);
const geo = coordinates => ({ lng: coordinates[0], lat: coordinates[1] });
const distance = (a, b) => {
  const y = (b.lat - a.lat) * RAD, x = (b.lng - a.lng) * RAD;
  return EARTH * 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin(y / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(x / 2) ** 2)));
};
const keyFor = point => `existing-node:${point.lng.toFixed(6)},${point.lat.toFixed(6)}`;
const bucketFor = point => [Math.floor(point.lng / GRID), Math.floor(point.lat / GRID)];

function project(point, a, b) {
  const cos = Math.cos((a.lat + b.lat) * RAD / 2), dx = (b.lng - a.lng) * cos, dy = b.lat - a.lat;
  const t = clamp(((point.lng - a.lng) * cos * dx + (point.lat - a.lat) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  const snapped = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  return { point: snapped, distance: distance(point, snapped), t };
}

export class ExistingRailwayNetwork {
  constructor(data) {
    this.tracks = new Map(); this.stationSources = new Map(); this.stationCache = new Map();
    this.segmentBuckets = new Map(); this.stationBuckets = new Map(); this.baseNodes = new Map();
    for (const [featureIndex, feature] of (data?.features || []).entries()) {
      const geometry = feature.geometry || {}, properties = feature.properties || {};
      if (geometry.type === 'LineString' && properties.type === 'rail' && !properties.shinkansen) {
        this.addTrack(`existing:${featureIndex}`, geometry.coordinates);
      } else if (geometry.type === 'Point' && properties.type === 'station' && !properties.shinkansen && properties.id != null) {
        const station = { id: String(properties.id), name: String(properties.name || '既設駅'), ...geo(geometry.coordinates), line: properties.line || '' };
        this.stationSources.set(station.id, station);
        const [x, y] = bucketFor(station), key = `${x}:${y}`;
        if (!this.stationBuckets.has(key)) this.stationBuckets.set(key, []);
        this.stationBuckets.get(key).push(station);
      }
    }
    this.connectSourceJunctions();
  }

  addTrack(id, coordinates) {
    const points = coordinates.map(geo).filter(valid);
    if (points.length < 2) return;
    const offsets = [0];
    for (let i = 1; i < points.length; i++) offsets.push(offsets[i - 1] + distance(points[i - 1], points[i]));
    const track = { id, type: 'existing', existing: true, points, length: offsets.at(-1), offsets, startKey: keyFor(points[0]), endKey: keyFor(points.at(-1)) };
    track.junctions = [{ offset: 0, point: points[0], key: track.startKey }, { offset: track.length, point: points.at(-1), key: track.endKey }];
    this.tracks.set(id, track);
    for (const point of [points[0], points.at(-1)]) {
      const key = keyFor(point);
      if (!this.baseNodes.has(key)) this.baseNodes.set(key, { key, point, edges: [] });
    }
    this.baseNodes.get(track.startKey).edges.push({ to: track.endKey, distance: track.length, trackId: id, type: 'existing', points });
    this.baseNodes.get(track.endKey).edges.push({ to: track.startKey, distance: track.length, trackId: id, type: 'existing', points: [...points].reverse() });
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], segment = { track, a, b, segmentIndex: i - 1 };
      const [ax, ay] = bucketFor(a), [bx, by] = bucketFor(b);
      for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) {
        const key = `${x}:${y}`;
        if (!this.segmentBuckets.has(key)) this.segmentBuckets.set(key, []);
        this.segmentBuckets.get(key).push(segment);
      }
    }
  }

  slice(track, from, to) {
    const points = [from.point];
    track.points.forEach((point, index) => { if (track.offsets[index] > from.offset + .001 && track.offsets[index] < to.offset - .001) points.push(point); });
    points.push(to.point);return points;
  }

  connectSourceJunctions() {
    // Some N02 lines end at an exact intermediate vertex of another source
    // line. Preserve those explicit T junctions without joining mere crossings.
    for (const track of this.tracks.values()) {
      for (let i = 1; i < track.points.length - 1; i++) {
        const point = track.points[i], key = keyFor(point);
        if (this.baseNodes.has(key)) track.junctions.push({ key, point, offset: track.offsets[i] });
      }
      track.junctions.sort((a, b) => a.offset - b.offset);
      if (track.junctions.length === 2) continue;
      for (const cut of track.junctions) this.baseNodes.get(cut.key).edges = this.baseNodes.get(cut.key).edges.filter(edge => edge.trackId !== track.id);
      for (let i = 1; i < track.junctions.length; i++) {
        const from = track.junctions[i - 1], to = track.junctions[i], points = this.slice(track, from, to), metres = to.offset - from.offset;
        this.baseNodes.get(from.key).edges.push({ to: to.key, distance: metres, trackId: track.id, type: 'existing', points });
        this.baseNodes.get(to.key).edges.push({ to: from.key, distance: metres, trackId: track.id, type: 'existing', points: [...points].reverse() });
      }
    }
  }

  nearby(buckets, point, maxDistance) {
    const latitudeSpan = maxDistance / 111000, longitudeSpan = latitudeSpan / Math.max(.1, Math.cos(point.lat * RAD));
    const [left, top] = bucketFor({ lng: point.lng - longitudeSpan, lat: point.lat - latitudeSpan });
    const [right, bottom] = bucketFor({ lng: point.lng + longitudeSpan, lat: point.lat + latitudeSpan });
    const found = new Set();
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) for (const item of buckets.get(`${x}:${y}`) || []) found.add(item);
    return found;
  }

  nearestTrack(point, maxDistance = 80) {
    if (!valid(point) || !Number.isFinite(maxDistance) || maxDistance < 0) return null;
    let best = null;
    for (const segment of this.nearby(this.segmentBuckets, point, maxDistance)) {
      const hit = project(point, segment.a, segment.b);
      if (hit.distance <= maxDistance && (!best || hit.distance < best.distance)) {
        const cos = Math.cos((segment.a.lat + segment.b.lat) * RAD / 2), dx = (segment.b.lng - segment.a.lng) * cos, dy = segment.b.lat - segment.a.lat;
        const angle = Math.atan2(dy, dx), side = Math.sign(dx * (point.lat - segment.a.lat) - dy * (point.lng - segment.a.lng) * cos) || 1;
        best = { ...hit, track: segment.track, id: segment.track.id, trackId: segment.track.id, segmentIndex: segment.segmentIndex, offset: segment.track.offsets[segment.segmentIndex] + distance(segment.a, hit.point), angle, bearing: angle / RAD, side };
      }
    }
    return best;
  }

  // Geometry is available to construction validation without importing shared
  // tracks into player ownership or exposing mutable cached source arrays.
  getTrack(id) {
    const track = this.tracks.get(String(id));
    if (!track) return null;
    return { ...track, points: track.points.map(point => ({ ...point })), offsets: track.offsets.slice(), junctions: track.junctions.map(cut => ({ ...cut, point: { ...cut.point } })) };
  }

  pointOnTrack(track, offset) {
    offset = clamp(offset, 0, track.length);
    for (let i = 1; i < track.offsets.length; i++) {
      if (track.offsets[i] < offset) continue;
      const t = (offset - track.offsets[i - 1]) / (track.offsets[i] - track.offsets[i - 1] || 1), a = track.points[i - 1], b = track.points[i];
      return { point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }, t, segmentIndex: i - 1, offset, track };
    }
    return { point: track.points.at(-1), t: 1, segmentIndex: track.points.length - 2, offset, track };
  }

  getStation(id) {
    id = String(id);
    if (!this.stationSources.has(id)) return null;
    if (!this.stationCache.has(id)) {
      const source = this.stationSources.get(id), hit = this.nearestTrack(source, 250);
      this.stationCache.set(id, hit ? { id, name: source.name, line: source.line, ...hit.point, sourceLat: source.lat, sourceLng: source.lng, trackId: hit.track.id, offset: hit.offset, segmentIndex: hit.segmentIndex, t: hit.t, distance: hit.distance, existing: true } : null);
    }
    const station = this.stationCache.get(id);
    return station ? { ...station } : null;
  }

  nearestStation(point, maxDistance = 80) {
    if (!valid(point) || !Number.isFinite(maxDistance) || maxDistance < 0) return null;
    let best = null, bestDistance = maxDistance;
    for (const source of this.nearby(this.stationBuckets, point, maxDistance)) {
      const metres = distance(point, source);
      if (metres <= bestDistance) {
        const station = this.getStation(source.id);
        if (station) { best = { ...station, distance: metres }; bestDistance = metres; }
      }
    }
    return best;
  }

  stationAnchor(station) {
    if (station.sourceStationId != null) {
      const source = this.getStation(station.sourceStationId), track = source && this.tracks.get(source.trackId);
      return track ? this.pointOnTrack(track, source.offset) : null;
    }
    const track = this.tracks.get(station.trackId);
    if (track) {
      let best = null;
      for (let i = 1; i < track.points.length; i++) {
        const hit = project(station, track.points[i - 1], track.points[i]);
        if (!best || hit.distance < best.distance) best = { ...hit, track, segmentIndex: i - 1, offset: track.offsets[i - 1] + distance(track.points[i - 1], hit.point) };
      }
      return best && best.distance <= 250 ? best : null;
    }
    return this.nearestTrack(station, 5);
  }

  stationAnchors(station) {
    const primary = this.stationAnchor(station);
    if (!primary) return [];
    if (!station.existing || station.sourceStationId == null) return [primary];
    // Explicitly registered source stations share their nearby platforms in
    // this simplified through-service model. This is deliberately NOT applied
    // to unregistered stations, ordinary crossings, or a new player platform.
    const source = this.getStation(station.sourceStationId);
    const origin = source ? { lat: source.sourceLat, lng: source.sourceLng } : station;
    const closestByTrack = new Map([[primary.track.id, primary]]);
    for (const segment of this.nearby(this.segmentBuckets, origin, 80)) {
      const hit = project(origin, segment.a, segment.b);
      if (hit.distance > 80) continue;
      const old = closestByTrack.get(segment.track.id);
      if (!old || hit.distance < (old.distance ?? Infinity)) closestByTrack.set(segment.track.id, { ...hit, track: segment.track, offset: segment.track.offsets[segment.segmentIndex] + distance(segment.a, hit.point), segmentIndex: segment.segmentIndex });
    }
    return [...closestByTrack.values()];
  }

  // Called on a fresh user graph. Every edge array is cloned so dynamic cuts and
  // chosen stations cannot leak into the cached nationwide topology or saves.
  augmentGraph(graph, state) {
    const cuts = new Map(), stationAnchors = [], userAnchors = [];
    graph.stationHostNodes = new Map();
    const addCut = hit => {
      if (!cuts.has(hit.track.id)) cuts.set(hit.track.id, []);
      const list = cuts.get(hit.track.id), old = list.find(cut => Math.abs(cut.offset - hit.offset) < .01);
      if (old) return old;
      const sourceJunction = hit.track.junctions.find(cut => Math.abs(cut.offset - hit.offset) < .01);
      const key = sourceJunction?.key || `existing-attach:${hit.track.id}:${Math.round(hit.offset * 1000)}`;
      const cut = { offset: hit.offset, point: hit.point, key, trackId: hit.track.id };
      list.push(cut); return cut;
    };
    for (const station of state.stations || []) {
      if (!station.existing && !station.onExistingTrack && !String(station.trackId || '').startsWith('existing:')) continue;
      const hits = this.stationAnchors(station);
      if (hits.length) stationAnchors.push({ stationId: station.id, point: valid(station) ? { lat: station.lat, lng: station.lng } : hits[0].point, shared: station.existing && station.sourceStationId != null, paid: station.existingTrack === true, cuts: hits.map(addCut) });
    }
    const userNodes = [...graph.nodes.values()];
    // An outside link may start at an independent platform only four metres
    // from a shared source rail. Preserve that deliberate port attachment:
    // its other endpoint can still connect to the shared railway normally.
    const independentPorts = (state.tracks || []).filter(track => track.stationTrack && track.points?.length && (track.stationWiring || Object.hasOwn(track, 'existingHostConnections') && !(Array.isArray(track.existingHostConnections) && track.existingHostConnections.length === 2)))
      .flatMap(track => [['a', track.points[0]], ['b', track.points.at(-1)]].filter(([end]) => !track.stationWiring || track.stationPorts?.[end]).map(([, point]) => point));
    for (const track of state.tracks || []) {
      if (track.existing || track.type === 'existing' || !track.points?.length) continue;
      for (const [index, [end, endpoint]] of [['a', track.points[0]], ['b', track.points.at(-1)]].entries()) {
        // Configured platform tracks only attach at their actual open ports.
        // A nearby shared railway must not defeat a buffer stop or bridge two
        // adjacent station tracks merely because they lie within five metres.
        if (track.stationWiring && !track.stationPorts?.[end]) continue;
        let hit;
        if (Object.hasOwn(track, 'existingHostConnections')) {
          const bindings = track.existingHostConnections, binding = Array.isArray(bindings) && bindings.length === 2 ? bindings[index] : null;
          const host = binding && this.tracks.get(binding.trackId);
          if (!host || !Number.isFinite(binding.offset) || binding.offset < -1e-6 || binding.offset > host.length + 1e-6) continue;
          hit = this.pointOnTrack(host, binding.offset);
          if (distance(endpoint, hit.point) > .25) continue;
        } else {
          if (!track.stationTrack && independentPorts.some(port => distance(endpoint, port) <= .25)) continue;
          hit = this.nearestTrack(endpoint, track.stationWiring ? .25 : 5);
        }
        if (!hit) continue;
        const attached = userNodes.filter(node => (node.track?.id === track.id || node.key.startsWith(`${track.id}|`)) && distance(node.point, endpoint) < 1);
        if (attached.length) userAnchors.push({ nodes: attached, cut: addCut(hit) });
      }
    }
    if (!stationAnchors.length && !userAnchors.length) return graph;
    for (const [key, node] of this.baseNodes) graph.nodes.set(key, { key, point: node.point, edges: node.edges.slice() });
    const connect = (from, to, points, trackId, metres) => {
      graph.nodes.get(from).edges.push({ to, distance: metres, trackId, type: 'existing', points });
      graph.nodes.get(to).edges.push({ to: from, distance: metres, trackId, type: 'existing', points: [...points].reverse() });
    };
    for (const [trackId, entries] of cuts) {
      const track = this.tracks.get(trackId);
      const sorted = [...track.junctions, ...entries].sort((a, b) => a.offset - b.offset);
      const all = sorted.filter((cut, index) => !index || cut.offset - sorted[index - 1].offset >= .01);
      for (const cut of track.junctions) graph.nodes.get(cut.key).edges = graph.nodes.get(cut.key).edges.filter(edge => edge.trackId !== trackId);
      for (const cut of all) if (!graph.nodes.has(cut.key)) graph.nodes.set(cut.key, { key: cut.key, point: cut.point, edges: [] });
      for (let i = 1; i < all.length; i++) {
        const from = all[i - 1], to = all[i], points = this.slice(track, from, to);
        connect(from.key, to.key, points, track.id, to.offset - from.offset);
      }
    }
    for (const { stationId, point, shared, paid, cuts: stationCuts } of stationAnchors) {
      if (!shared) {
        const hosts = [...new Set(stationCuts.map(cut => cut.key))];
        if (paid) {
          graph.stationHostNodes.set(stationId, hosts);
          graph.stationNodes.set(stationId, [...new Set([...(graph.stationNodes.get(stationId) || []), ...hosts])]);
        } else graph.stationNodes.set(stationId, [stationCuts[0].key]);
        continue;
      }
      const key = `existing-station:${stationId}`;
      graph.nodes.set(key, { key, point, edges: [] });
      graph.stationNodes.set(stationId, [key, ...new Set(stationCuts.map(cut => cut.key))]);
      for (const cut of stationCuts) connect(key, cut.key, [point, cut.point], cut.trackId, distance(point, cut.point));
    }
    for (const { nodes, cut } of userAnchors) for (const node of nodes) {
      connect(node.key, cut.key, [node.point, cut.point], node.track?.id || 'existing-connection', distance(node.point, cut.point));
    }
    return graph;
  }
}
