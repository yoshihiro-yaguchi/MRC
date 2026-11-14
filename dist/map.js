import { getStationLayout, stationGeometry } from './engine.js';
import { PopulationLayer } from './population-layer.js';

const TILE_SIZE = 256;
const EARTH_CIRCUMFERENCE = 40075016.686;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toWorld = ({ lat, lng }) => {
  const sin = Math.sin(clamp(Number(lat), -85.05112878, 85.05112878) * Math.PI / 180);
  return { x: (Number(lng) + 180) / 360, y: .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
};
const fromWorld = ({ x, y }) => ({ lng: x * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI });
const point = value => Array.isArray(value) ? { lng: value[0], lat: value[1] } : value;

function clipSegment(a, b, width, height, padding = 24) {
  const dx = b.x - a.x, dy = b.y - a.y; let first = 0, last = 1;
  for (const [p, q] of [[-dx, a.x + padding], [dx, width + padding - a.x], [-dy, a.y + padding], [dy, height + padding - a.y]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) first = Math.max(first, t); else last = Math.min(last, t);
    if (first > last) return null;
  }
  return [{ x: a.x + first * dx, y: a.y + first * dy }, { x: a.x + last * dx, y: a.y + last * dy }];
}

function pathSamples(positions, width, height, spacing, maximum = 160) {
  const result = []; let next = spacing * .5;
  for (let i = 1; i < positions.length && result.length < maximum; i++) {
    const visible = clipSegment(positions[i - 1], positions[i], width, height);
    if (!visible) { next = spacing * .5; continue; }
    const [a, b] = visible, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (length < .001) continue;
    for (; next < length && result.length < maximum; next += spacing) result.push({ x: a.x + dx * next / length, y: a.y + dy * next / length, angle: Math.atan2(dy, dx) });
    next -= length;
  }
  return result;
}

/** Screen-space station name planning shared by the blue and owned networks. */
export function planStationLabelVisibility(candidates, spacing = 40) {
  const radius=Math.max(1,spacing),buckets=new Map(),visible=new Set(),stats={candidates:candidates.length,distanceChecks:0,collisionChecks:0};
  const cell=(x,y,size)=>`${Math.floor(x/size)}:${Math.floor(y/size)}`;
  for(const item of candidates){
    const key=cell(item.position.x,item.position.y,radius);
    if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(item);
  }
  const sparse=[];
  for(const item of candidates){
    if(!item.bounds)continue;
    let crowded=false;
    if(!item.priority){
      const cx=Math.floor(item.position.x/radius),cy=Math.floor(item.position.y/radius);
      nearby:for(let x=cx-1;x<=cx+1;x++)for(let y=cy-1;y<=cy+1;y++)for(const other of buckets.get(`${x}:${y}`)||[]){
        if(other===item)continue;stats.distanceChecks++;
        if(Math.hypot(item.position.x-other.position.x,item.position.y-other.position.y)<=radius){crowded=true;break nearby;}
      }
    }
    if(!crowded)sparse.push(item);
  }
  // Priority labels reserve their space first. Ordinary player names come
  // before shared infrastructure names when only their text boxes overlap.
  sparse.sort((a,b)=>(b.priority||0)-(a.priority||0)||(b.owned?1:0)-(a.owned?1:0));
  const occupied=new Map(),boxSize=64,padding=3;
  const cellsFor=bounds=>{
    const keys=[];for(let x=Math.floor((bounds.left-padding)/boxSize);x<=Math.floor((bounds.right+padding)/boxSize);x++)for(let y=Math.floor((bounds.top-padding)/boxSize);y<=Math.floor((bounds.bottom+padding)/boxSize);y++)keys.push(`${x}:${y}`);return keys;
  };
  for(const item of sparse){
    const keys=cellsFor(item.bounds),seen=new Set();let collision=false;
    outer:for(const key of keys)for(const other of occupied.get(key)||[]){
      if(seen.has(other))continue;seen.add(other);stats.collisionChecks++;
      const a=item.bounds,b=other.bounds;
      if(a.left<=b.right+padding&&a.right+padding>=b.left&&a.top<=b.bottom+padding&&a.bottom+padding>=b.top){collision=true;break outer;}
    }
    if(collision)continue;
    visible.add(item.key);for(const key of keys){if(!occupied.has(key))occupied.set(key,[]);occupied.get(key).push(item);}
  }
  return {visible,stats};
}

/** A dependency-free map surface. All editing decisions stay with the application. */
export class RailwayMap {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.view = { lat: 35.6812, lng: 139.7671, zoom: 10.6 };
    this.layer = 'standard';
    this.state = { tracks: [], stations: [], routes: [] };
    this.options = { plan: [], mode: 'track', trackType: 'double', platformCars: 1, selectedStationIds: [] };
    this.tiles = new Map();
    this.railPaths = [];
    this.existingStations = [];
    this.populationLayer = new PopulationLayer();
    this.pointers = new Map();
    this.tileErrors = 0;
    this.pendingFrame = 0;
    this.destroyed = false;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'railway-map-canvas';
    this.canvas.id = 'railmap';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '地図。ドラッグで移動、ホイールで拡大縮小、クリックで敷設操作。');
    Object.assign(this.canvas.style, { width: '100%', height: '100%', display: 'block', touchAction: 'none', outline: 'none', cursor: 'crosshair' });
    this.container.append(this.canvas);
    this.retryButton = document.createElement('button');
    this.retryButton.type = 'button'; this.retryButton.textContent = '地図を再読み込み';
    this.retryButton.setAttribute('aria-label', '地図タイルを再読み込み'); this.retryButton.hidden = true;
    Object.assign(this.retryButton.style, { position: 'absolute', top: '12px', left: '12px', zIndex: '5', padding: '7px 10px', border: '1px solid #d5e0e2', borderRadius: '5px', background: 'rgba(255,255,255,.95)', color: '#426575', font: '12px system-ui,sans-serif', cursor: 'pointer', boxShadow: '0 2px 7px #22374412' });
    this.retryButton.addEventListener('click', () => this.retryTiles()); this.container.append(this.retryButton);
    this.ctx = this.canvas.getContext('2d');
    this.listeners = [];
    this.listen('pointerdown', this.pointerDown.bind(this));
    this.listen('pointermove', this.pointerMove.bind(this));
    this.listen('pointerup', this.pointerUp.bind(this));
    this.listen('pointercancel', this.pointerCancel.bind(this));
    this.listen('lostpointercapture', event => { if (this.stationRotation?.pointerId === event.pointerId) this.endStationRotation();if(this.curveHandleDrag?.pointerId===event.pointerId)this.endCurveHandleDrag(true);if(this.planPointDrag?.pointerId===event.pointerId)this.endPlanPointDrag(true); });
    this.listen('pointerleave', () => { if (!this.dragging && !this.stationRotation && !this.curveHandleDrag && !this.planPointDrag) { this.callbacks.onMove?.(null, null); } });
    this.listen('wheel', this.wheel.bind(this), { passive: false });
    this.listen('contextmenu', this.contextMenu.bind(this));
    this.listen('dblclick', this.doubleClick.bind(this));
    this.listen('keydown', this.keyDown.bind(this));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.loadRailways();
  }

  listen(name, fn, options) { this.canvas.addEventListener(name, fn, options); this.listeners.push([name, fn, options]); }
  resize() {
    const bounds = this.container.getBoundingClientRect();
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    this.ratio = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(this.width * this.ratio);
    this.canvas.height = Math.round(this.height * this.ratio);
    this.requestRender();
  }
  eventPoint(event) { const b = this.canvas.getBoundingClientRect(); return { x: event.clientX - b.left, y: event.clientY - b.top }; }
  get worldSize() { return TILE_SIZE * 2 ** this.view.zoom; }
  get center() { return toWorld(this.view); }
  latLngToScreen(value) {
    const w = toWorld(point(value)), c = this.center, size = this.worldSize;
    return { x: (w.x - c.x) * size + this.width / 2, y: (w.y - c.y) * size + this.height / 2 };
  }
  screenToLatLng({ x, y }) { const c = this.center, size = this.worldSize; return fromWorld({ x: c.x + (x - this.width / 2) / size, y: c.y + (y - this.height / 2) / size }); }
  metersPerPixel(lat = this.view.lat) { return EARTH_CIRCUMFERENCE * Math.cos(lat * Math.PI / 180) / this.worldSize; }
  getView() { return { ...this.view }; }
  setView(view) {
    this.view = { lat: clamp(Number(view.lat ?? this.view.lat), -84, 84), lng: clamp(Number(view.lng ?? this.view.lng), -180, 180), zoom: clamp(Number(view.zoom ?? this.view.zoom), 4, 22) };
    this.requestRender();
    this.callbacks.onViewChange?.(this.getView());
  }
  focus(value, zoom = 14) { this.setView({ ...point(value), zoom: Math.max(zoom, this.view.zoom) }); }
  fitPoints(values, padding = 60) {
    const points = (values || []).map(point).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)).map(toWorld);
    if (!points.length) return;
    if (points.length === 1) { this.focus(fromWorld(points[0])); return; }
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    const width = Math.max(100, this.width - padding * 2), height = Math.max(100, this.height - padding * 2);
    const zoom = Math.floor(Math.min(Math.log2(width / TILE_SIZE / Math.max(right - left, 1e-8)), Math.log2(height / TILE_SIZE / Math.max(bottom - top, 1e-8))));
    this.setView({ ...fromWorld({ x: (left + right) / 2, y: (top + bottom) / 2 }), zoom: clamp(zoom, 4, 22) });
  }
  setLayer(layer) { this.layer = ['standard', 'satellite', 'relief', 'blank'].includes(layer) ? layer : 'standard'; this.retryButton.hidden = true; this.tileErrors = 0; this.requestRender(); }
  setExistingNetwork(network) { this.existingNetwork = network; this.requestRender(); }
  setPopulationData(cells) { if (!this.populationLayer) this.populationLayer = new PopulationLayer(); this.populationLayer.setData(cells); this.requestRender(); }
  nearestExistingTrack(value, maxPixels = 10, maxMetres = 80) {
    if (!this.existingNetwork) return null;
    const metresPerPixel = this.metersPerPixel(value.lat), limit = Math.min(maxMetres, maxPixels * metresPerPixel);
    const hit = this.existingNetwork.nearestTrack(value, limit);
    if (!hit) return null;
    const cursor = this.latLngToScreen(value), at = this.latLngToScreen(hit.point);
    const screenDistance = Math.hypot(cursor.x - at.x, cursor.y - at.y);
    return screenDistance <= maxPixels && hit.distance <= maxMetres ? { ...hit, screenDistance } : null;
  }
  setState(state, options = {}) {
    this.state = state || this.state; this.options = { ...this.options, ...options };
    if (this.stationRotation && !this.canRotateStation()) this.endStationRotation();
    if(this.curveHandleDrag&&(!this.canEditCurve()||this.curveHandleDrag.index>=(this.options.controlPoints||[]).length))this.endCurveHandleDrag(false);
    if(this.planPointDrag&&(!this.canEditPlanPoints()||this.planPointDrag.index>=(this.options.controlPoints||[]).length))this.endPlanPointDrag(false);
    if(!this.canEditCurve())this.curveHandleHover=null;
    if(!this.canEditPlanPoints())this.planPointHover=null;
    this.canvas.style.cursor = this.curveHandleDrag || this.planPointDrag ? 'grabbing' : this.stationRotation ? 'ew-resize' : this.dragging ? 'grabbing' : this.options.removePointIndex >= 0 ? 'pointer' : this.planPointHover ? 'move' : this.curveHandleHover ? 'grab' : ['pan','draft'].includes(this.options.mode) ? 'grab' : 'crosshair'; this.requestRender();
  }
  nearestPlanPoint(value, maxPixels = 10) {
    const target = this.latLngToScreen(value), controls = this.options.controlPoints || this.options.plan || [];
    let nearest = null, bestDistance = maxPixels;
    controls.forEach((value, index) => {
      const location = point(value), position = this.latLngToScreen(location), distance = Math.hypot(position.x - target.x, position.y - target.y);
      if (distance <= bestDistance) { nearest = { index, point: location, distance }; bestDistance = distance; }
    });
    return nearest;
  }
  nearestDraftEndpoint(value, maxPixels = 12) {
    const target=this.latLngToScreen(value);let nearest=null,best=maxPixels;
    const consider=(value,details)=>{
      const location=point(value),position=this.latLngToScreen(location),screenDistance=Math.hypot(position.x-target.x,position.y-target.y);
      if(screenDistance<=best){nearest={point:{lat:location.lat,lng:location.lng},screenDistance,...details};best=screenDistance;}
    };
    (this.options.draftStrokes||[]).forEach((stroke,strokeIndex)=>{
      const points=stroke.points||[];if(!points.length)return;
      if(points.length>1)consider(points[0],{strokeIndex,end:'start',active:false});
      consider(points.at(-1),{strokeIndex,end:'end',active:false});
    });
    const active=this.options.controlPoints||this.options.plan||[];
    if(active.length)consider(active.at(-1),{strokeIndex:-1,end:'end',active:true});
    return nearest;
  }
  nearestPolyline(value,points,maxPixels=10,offset=0){
    const target=this.latLngToScreen(value);let nearest=null,best=maxPixels;
    const raw=(points||[]).map(value=>this.latLngToScreen(point(value))),positions=offset?raw.map((p,index)=>{
      const a=raw[Math.max(0,index-1)],b=raw[Math.min(raw.length-1,index+1)],length=Math.hypot(b.x-a.x,b.y-a.y)||1;
      return {x:p.x-(b.y-a.y)/length*offset,y:p.y+(b.x-a.x)/length*offset};
    }):raw;
    for(let index=1;index<positions.length;index++){
      const a=positions[index-1],b=positions[index];
      if(target.x<Math.min(a.x,b.x)-best||target.x>Math.max(a.x,b.x)+best||target.y<Math.min(a.y,b.y)-best||target.y>Math.max(a.y,b.y)+best)continue;
      const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy,t=length?clamp(((target.x-a.x)*dx+(target.y-a.y)*dy)/length,0,1):0,p={x:a.x+dx*t,y:a.y+dy*t},screenDistance=Math.hypot(target.x-p.x,target.y-p.y);
      if(screenDistance<=best){nearest={point:this.screenToLatLng(p),screenDistance};best=screenDistance;}
    }
    return nearest;
  }
  nearestRenderedTrack(value,track,maxPixels=10){
    const geometries=[track.points||[]],offsets=[...new Set([0,...this.trackVisualStyle(track).offsets])];let nearest=null,best=maxPixels;
    if(track.type==='scissors')geometries.push(this.mirrorScissorsPoints(track));
    for(const points of geometries)for(const offset of offsets){const hit=this.nearestPolyline(value,points,best,offset);if(hit&&hit.screenDistance<=best){nearest=hit;best=hit.screenDistance;}}
    return nearest;
  }
  nearestDraftStroke(value,maxPixels=10){
    const target=this.latLngToScreen(value);let nearest=null,best=maxPixels;
    (this.options.draftStrokes||[]).forEach((stroke,index)=>{
      const geometry=stroke.previewPoints||stroke.points||[],hit=this.nearestRenderedTrack(value,{...stroke,points:geometry},best);
      if(hit&&hit.screenDistance<=best){nearest=index;best=hit.screenDistance;}
      for(const control of stroke.controlPoints||stroke.rawPoints||stroke.points||[]){const p=this.latLngToScreen(point(control)),distance=Math.hypot(p.x-target.x,p.y-target.y);if(distance<=best){nearest=index;best=distance;}}
    });
    return nearest;
  }
  nearestOwnTrack(value,maxPixels=10){
    let nearest=null,best=maxPixels;
    for(const track of this.state.tracks||[]){
      if(track.stationTrack||track.existing||String(track.id).startsWith('existing:'))continue;
      const hit=this.nearestRenderedTrack(value,track,best);
      if(hit&&hit.screenDistance<=best){nearest={track,...hit};best=hit.screenDistance;}
    }
    return nearest;
  }
  canEditPlanPoints(){return ['track','track-edit'].includes(this.options?.mode);}
  canEditCurve(){return this.canEditPlanPoints()&&this.options.curveMode==='point'&&!['crossover','scissors'].includes(this.options.trackType);}
  curveHandlePoints(controls=this.options.controlPoints||[],provided=this.options.curveHandles||[]){
    return controls.map((value,index)=>{
      const anchor=point(value),manual=provided[index]&&point(provided[index]);
      if(manual&&Number.isFinite(manual.lat)&&Number.isFinite(manual.lng))return manual;
      const before=point(controls[Math.max(0,index-1)]),after=point(controls[Math.min(controls.length-1,index+1)]),divisor=index===0||index===controls.length-1?3:6;
      return {lat:anchor.lat+(after.lat-before.lat)/divisor,lng:anchor.lng+(after.lng-before.lng)/divisor};
    });
  }
  nearestCurveHandle(value,maxPixels=10){
    if(!this.canEditCurve())return null;
    const controls=this.options.controlPoints||[],handles=this.curveHandlePoints(controls),target=this.latLngToScreen(value);let nearest=null,best=maxPixels;
    controls.forEach((value,index)=>{
      const anchor=point(value),outgoing=handles[index],at=this.latLngToScreen(anchor),incoming={lat:2*anchor.lat-outgoing.lat,lng:2*anchor.lng-outgoing.lng};
      if(Math.hypot(this.latLngToScreen(outgoing).x-at.x,this.latLngToScreen(outgoing).y-at.y)<8)return;
      for(const [side,location] of [['incoming',incoming],['outgoing',outgoing]]){
        const p=this.latLngToScreen(location),screenDistance=Math.hypot(p.x-target.x,p.y-target.y);
        if(screenDistance<=best){nearest={index,side,point:{...location},screenDistance};best=screenDistance;}
      }
    });
    return nearest;
  }
  draggedCurveHandle(screen){
    const drag=this.curveHandleDrag,location=this.screenToLatLng({x:screen.x+(drag.offset?.x||0),y:screen.y+(drag.offset?.y||0)});
    return drag.side==='incoming'?{lat:2*drag.anchor.lat-location.lat,lng:2*drag.anchor.lng-location.lng}:location;
  }
  moveCurveHandleDrag(screen){
    const drag=this.curveHandleDrag;if(!drag)return;
    drag.last=screen;this.pointers.set(drag.pointerId,screen);
    if(!drag.started&&Math.hypot(screen.x-drag.start.x,screen.y-drag.start.y)>4){drag.started=true;this.callbacks.onCurveHandle?.(drag.index,drag.original,'start');}
    if(this.curveHandleDrag===drag&&drag.started){drag.outgoing=this.draggedCurveHandle(screen);this.callbacks.onCurveHandle?.(drag.index,drag.outgoing,'move');}
  }
  endCurveHandleDrag(commit=false,event=null,keepPointer=false){
    const drag=this.curveHandleDrag;if(!drag)return;
    if(commit&&event&&!drag.started)this.moveCurveHandleDrag(this.eventPoint(event));
    if(this.curveHandleDrag!==drag)return;
    const outgoing=event?this.draggedCurveHandle(this.eventPoint(event)):drag.outgoing;
    this.curveHandleDrag=null;
    if(!keepPointer){this.pointers.delete(drag.pointerId);if(this.canvas.hasPointerCapture(drag.pointerId))this.canvas.releasePointerCapture(drag.pointerId);}
    this.canvas.style.cursor=['pan','draft'].includes(this.options.mode)?'grab':'crosshair';
    if(drag.started)this.callbacks.onCurveHandle?.(drag.index,commit?outgoing:drag.original,commit?'end':'cancel');
  }
  movedPlanPoint(screen){
    const drag=this.planPointDrag,anchor=this.latLngToScreen(drag.original);
    return this.screenToLatLng({x:anchor.x+screen.x-drag.start.x,y:anchor.y+screen.y-drag.start.y});
  }
  movePlanPointDrag(screen){
    const drag=this.planPointDrag;if(!drag)return;
    drag.last=screen;this.pointers.set(drag.pointerId,screen);
    if(!drag.started&&Math.hypot(screen.x-drag.start.x,screen.y-drag.start.y)>4){drag.started=true;this.callbacks.onPlanPoint?.(drag.index,drag.original,'start');}
    if(this.planPointDrag===drag&&drag.started){drag.current=this.movedPlanPoint(screen);this.callbacks.onPlanPoint?.(drag.index,drag.current,'move');}
  }
  endPlanPointDrag(commit=false,event=null,keepPointer=false){
    const drag=this.planPointDrag;if(!drag)return;
    if(commit&&event&&!drag.started)this.movePlanPointDrag(this.eventPoint(event));
    if(this.planPointDrag!==drag)return;
    const location=commit&&event?this.movedPlanPoint(this.eventPoint(event)):drag.current;
    this.planPointDrag=null;
    if(!keepPointer){this.pointers.delete(drag.pointerId);if(this.canvas.hasPointerCapture(drag.pointerId))this.canvas.releasePointerCapture(drag.pointerId);}
    this.canvas.style.cursor=['pan','draft'].includes(this.options.mode)?'grab':'crosshair';
    if(drag.started)this.callbacks.onPlanPoint?.(drag.index,commit?location:drag.original,commit?'end':'cancel');
    else if(commit&&event&&!keepPointer){this.closeStationPopup();this.callbacks.onClick?.(this.screenToLatLng(this.eventPoint(event)),event);}
  }
  cancelEditGesture(){
    const editing=!!(this.curveHandleDrag||this.planPointDrag);
    this.endCurveHandleDrag(false);this.endPlanPointDrag(false);return editing;
  }
  contextMenu(event) {
    if(this.curveHandleDrag||this.planPointDrag){event.preventDefault();return;}
    if (this.canRotateStation() || this.stationRotation || this.rotationContextMenuPending) {
      this.rotationContextMenuPending = false; event.preventDefault(); return;
    }
    if (this.callbacks.onContextMenu?.(this.screenToLatLng(this.eventPoint(event)), event) === true) event.preventDefault();
  }
  canRotateStation() { return this.options?.mode === 'station' && this.options.stationPlacement === 'free'; }
  rotateStation(bearing, anchor) {
    const snapped = ((Math.round(bearing / 5) * 5) % 180 + 180) % 180;
    this.callbacks.onStationRotate?.(snapped, anchor);
  }
  endStationRotation() {
    const rotation = this.stationRotation;
    this.stationRotation = null;
    if (rotation && this.canvas.hasPointerCapture(rotation.pointerId)) this.canvas.releasePointerCapture(rotation.pointerId);
    this.canvas.style.cursor = ['pan','draft'].includes(this.options.mode) ? 'grab' : 'crosshair';
  }
  doubleClick(event) {
    event.preventDefault();
    // A quick second click toggles a plan point; it must not also move the map.
    if (!['track','track-edit','measure'].includes(this.options.mode) && !this.options.measureEnabled) this.zoomAt(1, this.eventPoint(event));
  }
  requestRender() { if (!this.pendingFrame && !this.destroyed) this.pendingFrame = requestAnimationFrame(() => { this.pendingFrame = 0; this.render(); }); }

  pointerDown(event) {
    if (this.stationRotation) return;
    if(this.planPointDrag){
      if(event.pointerType==='touch'&&event.pointerId!==this.planPointDrag.pointerId){const last=this.planPointDrag.last;this.endPlanPointDrag(true,null,true);this.dragging={start:last,last,center:this.center,moved:true,button:0};}else return;
    }
    if(this.curveHandleDrag){
      if(event.pointerType==='touch'&&event.pointerId!==this.curveHandleDrag.pointerId){
        const last=this.curveHandleDrag.last;this.endCurveHandleDrag(true,null,true);
        this.dragging={start:last,last,center:this.center,moved:true,button:0};
      }else return;
    }
    this.rotationContextMenuPending = false;
    if (event.button === 2 && this.canRotateStation() && !this.pointers.size) {
      event.preventDefault();
      const start = this.eventPoint(event), anchor = this.screenToLatLng(start);
      this.stationRotation = { pointerId: event.pointerId, start, bearing: this.options.stationBearing || 0, anchor };
      this.rotationContextMenuPending = true;
      this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = 'ew-resize';
      this.callbacks.onMove?.(anchor, event);
      return;
    }
    if (event.button !== 0 && event.button !== 1) return;
    const p = this.eventPoint(event);
    if(event.button===0&&this.pointers.size===0){
      const location=this.screenToLatLng(p),hit=this.nearestCurveHandle(location),control=this.canEditPlanPoints()?this.nearestPlanPoint(location,10):null;
      if(hit&&(!control||(control.distance>5&&control.distance>hit.screenDistance))){
        event.preventDefault();const anchor=point(this.options.controlPoints[hit.index]),outgoing=this.curveHandlePoints()[hit.index];
        const at=this.latLngToScreen(hit.point);
        this.curveHandleDrag={...hit,pointerId:event.pointerId,anchor:{...anchor},outgoing:{...outgoing},original:{...outgoing},start:p,last:p,started:false,offset:{x:at.x-p.x,y:at.y-p.y}};
        this.pointers.set(event.pointerId,p);this.canvas.focus({preventScroll:true});this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor='grabbing';return;
      }
      if(control){
        event.preventDefault();this.planPointDrag={index:control.index,pointerId:event.pointerId,original:{...control.point},current:{...control.point},start:p,last:p,started:false};
        this.pointers.set(event.pointerId,p);this.canvas.focus({preventScroll:true});this.canvas.setPointerCapture(event.pointerId);this.canvas.style.cursor='grabbing';return;
      }
    }
    this.pointers.set(event.pointerId, p);
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(event.pointerId);
    if (this.pointers.size > 1) {
      const [a,b] = [...this.pointers.values()];
      const middle = { x:(a.x+b.x)/2, y:(a.y+b.y)/2 };
      this.pinch = { distance:Math.max(1,Math.hypot(b.x-a.x,b.y-a.y)), zoom:this.view.zoom, anchor:toWorld(this.screenToLatLng(middle)) };
      if (this.dragging) this.dragging.moved = true;
    } else this.dragging = { start: p, last: p, center: this.center, moved: false, button: event.button };
  }
  pointerMove(event) {
    const p = this.eventPoint(event);
    if(this.planPointDrag){
      if(event.pointerId===this.planPointDrag.pointerId){
        if(event.buttons!==undefined&&!(event.buttons&1)){this.endPlanPointDrag(true,event);this.callbacks.onMove?.(this.screenToLatLng(p),event);return;}
        this.movePlanPointDrag(p);
      }
      return;
    }
    if(this.curveHandleDrag){
      const drag=this.curveHandleDrag;
      if(event.pointerId===drag.pointerId){
        if(event.buttons!==undefined&&!(event.buttons&1)){this.endCurveHandleDrag(true,event);this.callbacks.onMove?.(this.screenToLatLng(p),event);return;}
        this.moveCurveHandleDrag(p);
      }
      return;
    }
    if (this.stationRotation) {
      const rotation = this.stationRotation;
      if (event.pointerId === rotation.pointerId) {
        if (event.buttons !== undefined && !(event.buttons & 2)) {
          this.endStationRotation(); this.callbacks.onMove?.(this.screenToLatLng(p), event); return;
        }
        rotation.last = p;
        // Ten horizontal pixels rotate one 5-degree step; the station center stays fixed.
        this.rotateStation(rotation.bearing + (p.x - rotation.start.x) / 2, rotation.anchor);
      }
      return;
    }
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId,p);
    if (this.pinch && this.pointers.size > 1) {
      const [a,b]=[...this.pointers.values()], middle={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      const distance=Math.max(1,Math.hypot(b.x-a.x,b.y-a.y)), zoom=clamp(this.pinch.zoom+Math.log2(distance/this.pinch.distance),4,22), size=TILE_SIZE*2**zoom;
      this.view={...fromWorld({x:this.pinch.anchor.x-(middle.x-this.width/2)/size,y:this.pinch.anchor.y-(middle.y-this.height/2)/size}),zoom};
      this.requestRender(); return;
    }
    if (this.dragging) {
      const d = this.dragging, dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (Math.hypot(dx, dy) > 4) d.moved = true;
      if (d.moved) { this.view = { ...this.view, ...fromWorld({ x: d.center.x - dx / this.worldSize, y: clamp(d.center.y - dy / this.worldSize, 0, 1) }) }; this.canvas.style.cursor = 'grabbing'; this.requestRender(); }
      d.last = p;
    } else {
      const location=this.screenToLatLng(p);this.callbacks.onMove?.(location,event);
      this.curveHandleHover=this.nearestCurveHandle(location);
      this.planPointHover=this.canEditPlanPoints()?this.nearestPlanPoint(location):null;
      if(this.planPointHover&&(!this.curveHandleHover||this.planPointHover.distance<=this.curveHandleHover.screenDistance))this.canvas.style.cursor=this.options.mode==='track-edit'?'move':'pointer';
      else if(this.curveHandleHover&&!(this.options.removePointIndex>=0))this.canvas.style.cursor='grab';
    }
  }
  pointerUp(event) {
    if(this.planPointDrag){if(event.pointerId===this.planPointDrag.pointerId)this.endPlanPointDrag(true,event);return;}
    if(this.curveHandleDrag){if(event.pointerId===this.curveHandleDrag.pointerId)this.endCurveHandleDrag(true,event);return;}
    if (this.stationRotation) {
      if (event.pointerId === this.stationRotation.pointerId) {
        this.endStationRotation();
        // Resume following the cursor so the next click builds exactly at the preview.
        this.callbacks.onMove?.(this.screenToLatLng(this.eventPoint(event)), event);
      }
      return;
    }
    const d = this.dragging;
    this.pointers.delete(event.pointerId);
    if (this.pointers.size) {
      this.pinch=null;
      const p=this.pointers.values().next().value;
      this.dragging={start:p,last:p,center:this.center,moved:true,button:0};
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      return;
    }
    this.pinch=null;
    this.dragging = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.canvas.style.cursor = ['pan','draft'].includes(this.options.mode) ? 'grab' : 'crosshair';
    if (!d) return;
    if (d.moved) this.callbacks.onViewChange?.(this.getView());
    else if (d.button === 0) {
      const location=this.screenToLatLng(this.eventPoint(event));
      if (['pan','draft','save','settings','idle'].includes(this.options.mode)) {
        const station=this.nearestExistingStation(location);
        if (station) {this.showStationPopup(station);return;}
      }
      this.closeStationPopup(); this.callbacks.onClick?.(location,event);
    }
  }
  pointerCancel() { this.cancelEditGesture();this.endStationRotation(); this.rotationContextMenuPending = false; this.dragging = null; this.pinch=null; this.pointers.clear(); this.canvas.style.cursor = 'crosshair'; }
  wheel(event) {
    event.preventDefault();
    if(this.curveHandleDrag||this.planPointDrag)return;
    if (event.shiftKey && this.canRotateStation()) {
      const delta = event.deltaY || event.deltaX;
      if (!delta) return;
      const anchor = this.stationRotation?.anchor || this.screenToLatLng(this.eventPoint(event));
      const bearing = (this.options.stationBearing || 0) + (delta < 0 ? 5 : -5);
      if (this.stationRotation) {
        this.stationRotation.start = this.stationRotation.last || this.stationRotation.start;
        this.stationRotation.bearing = bearing;
      }
      this.rotateStation(bearing, anchor);
      return;
    }
    if (this.stationRotation) return;
    const now = performance.now();
    if (now - (this.lastWheel || 0) < 90) return;
    this.lastWheel = now;
    this.zoomAt(event.deltaY < 0 ? 1 : -1, this.eventPoint(event));
  }
  zoomAt(delta, p = { x: this.width / 2, y: this.height / 2 }) {
    const before = toWorld(this.screenToLatLng(p));
    const zoom = clamp(this.view.zoom + delta, 4, 22), size = TILE_SIZE * 2 ** zoom;
    this.setView({ ...fromWorld({ x: before.x - (p.x - this.width / 2) / size, y: before.y - (p.y - this.height / 2) / size }), zoom });
  }
  keyDown(event) {
    if(event.key==='Escape'&&this.cancelEditGesture()){event.preventDefault();event.stopPropagation?.();return;}
    if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoomAt(.7); }
    if (event.key === '-') { event.preventDefault(); this.zoomAt(-.7); }
    if (event.key === 'Escape') this.closeStationPopup();
    const direction = { ArrowLeft: [-100, 0], ArrowRight: [100, 0], ArrowUp: [0, -100], ArrowDown: [0, 100] }[event.key];
    if (direction) { event.preventDefault(); const c = this.center; this.setView({ ...fromWorld({ x: c.x + direction[0] / this.worldSize, y: c.y + direction[1] / this.worldSize }) }); }
  }

  async loadRailways() {
    try {
      const response = await fetch(new URL('./data/railways.json', import.meta.url));
      if (!response.ok) throw new Error(`Railway map data: ${response.status}`);
      const data = await response.json();
      const addLine = (coordinates, type) => {
        if (coordinates.length < 2) return;
        const projected = coordinates.map(c => toWorld(point(c)));
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const xy = new Float64Array(projected.length * 2);
        projected.forEach((p, i) => { xy[i * 2] = p.x; xy[i * 2 + 1] = p.y; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
        this.railPaths.push({ xy, type, minX, minY, maxX, maxY });
      };
      const addFeature = feature => {
        const g = feature.geometry || {}, p = feature.properties || {}, type = p.type || (p.shinkansen ? 'shinkansen' : 'rail');
        if (g.type === 'LineString') addLine(g.coordinates, type);
        else if (g.type === 'MultiLineString') g.coordinates.forEach(line => addLine(line, type));
        else if (g.type === 'Point') this.existingStations.push({ ...toWorld(point(g.coordinates)), name: p.name || '', type, id:p.id, line:p.line, shinkansen:p.shinkansen });
        else if (g.type === 'MultiPoint') g.coordinates.forEach(c => this.existingStations.push({ ...toWorld(point(c)), name: p.name || '', type }));
      };
      if (data.type === 'FeatureCollection') data.features.forEach(addFeature);
      else {
        (data.lines || data.railways || []).forEach(line => {
          if (line.type === 'Feature') addFeature(line);
          else addLine(line.coordinates || line.points || line, line.type || 'rail');
        });
        (data.stations || []).forEach(s => this.existingStations.push({ ...toWorld(point(s.coordinates || s)), name: s.name || '', type: s.type || 'rail' }));
      }
      this.container.dataset.railwaysLoaded = String(this.railPaths.length);
      this.requestRender();
      await this.callbacks.onRailwaysLoaded?.(data);
    } catch (error) {
      this.container.dataset.railwaysError = error.message;
      console.warn('全国鉄道データを読み込めませんでした。', error);
      this.callbacks.onRailwaysError?.(error);
    }
  }

  tile(z, x, y) {
    const n = 2 ** z;
    if (y < 0 || y >= n) return null;
    x = ((x % n) + n) % n;
    const layer=this.layer,key = `${layer}/${z}/${x}/${y}`;
    if (this.tiles.has(key)) return this.tiles.get(key);
    const item = { image: new Image(), ready: false, error: false };
    item.image.crossOrigin = 'anonymous';
    item.image.onload = () => { item.ready = true; this.requestRender(); };
    item.image.onerror = () => {
      item.error = true;
      if(this.layer===layer){this.tileErrors++;if(this.tileErrors>=3&&layer!=='blank')this.retryButton.hidden=false;}
      this.callbacks.onTileError?.({layer,url:item.image.src}); this.requestRender();
    };
    const photoSource=z>=14?'seamlessphoto':z>=9?'lndst':'modis';
    item.image.src = layer==='relief' ? `https://cyberjapandata.gsi.go.jp/xyz/relief/${z}/${x}/${y}.png` : layer === 'satellite' ? `https://cyberjapandata.gsi.go.jp/xyz/${photoSource}/${z}/${x}/${y}.${photoSource==='seamlessphoto'?'jpg':'png'}` : `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    this.tiles.set(key, item);
    if (this.tiles.size > 512) this.tiles.delete(this.tiles.keys().next().value);
    return item;
  }
  retryTiles() { this.tiles.clear(); this.tileErrors=0; this.retryButton.hidden=true; this.requestRender(); }
  drawTiles(ctx, c, size) {
    const nativeMin=this.layer==='relief'?5:0,nativeMax=this.layer==='relief'?15:this.layer==='satellite'?18:19;
    const z = clamp(Math.floor(this.view.zoom),nativeMin,nativeMax), tileScale = 2 ** (this.view.zoom - z), span = TILE_SIZE * tileScale;
    const left = c.x * size - this.width / 2, top = c.y * size - this.height / 2;
    const x0 = Math.floor(left / span), x1 = Math.floor((left + this.width) / span), y0 = Math.floor(top / span), y1 = Math.floor((top + this.height) / span);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const tile = this.tile(z, x, y), px = x * span - left, py = y * span - top;
      if (tile?.ready) ctx.drawImage(tile.image, Math.round(px), Math.round(py), Math.ceil(span) + .5, Math.ceil(span) + .5);
    }
  }
  prepareStationLabels(ctx,c=this.center,size=this.worldSize){
    if(this.view.zoom<=10.65){this.stationLabelPlan=new Set();this.stationLabelStats={candidates:0,distanceChecks:0,collisionChecks:0};return;}
    const candidates=[],selected=new Set(this.options.selectedStationIds||[]),selectedSources=new Set((this.state.stations||[]).filter(station=>station.existing&&selected.has(station.id)).map(station=>String(station.sourceStationId)));
    const inside=p=>p.x>=-40&&p.x<=this.width+40&&p.y>=-40&&p.y<=this.height+40;
    const textWidth=(text,font,size)=>{ctx.font=font;return ctx.measureText?ctx.measureText(text).width:[...String(text)].length*size;};
    for(const station of this.existingStations||[]){
      const position={x:(station.x-c.x)*size+this.width/2,y:(station.y-c.y)*size+this.height/2};if(!inside(position))continue;
      const x=position.x+7,y=position.y-6,width=station.name?textWidth(station.name,'11px "Noto Sans JP",system-ui,sans-serif',11):0;
      candidates.push({key:station,position,priority:station===this.popupStation||selectedSources.has(String(station.id))?1:0,bounds:width?{left:x-2,right:x+width+2,top:y-13,bottom:y+3}:null});
    }
    for(const station of this.state.stations||[]){
      if(station.existing)continue;
      const position=this.latLngToScreen(station);if(!inside(position))continue;
      let x=position.x+9,y=position.y-10,top=y-14,width=station.name?textWidth(station.name,'600 12px "Noto Sans JP",system-ui,sans-serif',12):0;
      if(station.layoutId||station.standalone||station.geometry){
        const geometry=this.stationDisplayGeometry(station);x=Math.max(5,geometry.bounds.left);y=Math.max(17,geometry.bounds.top-10);top=y-(this.view.zoom>=12?27:14);
        if(this.view.zoom>=12){const layout=geometry.layout||getStationLayout(station.layoutId);width=Math.max(width,textWidth(`${layout.platforms}面${layout.tracks}線`,'10px system-ui,sans-serif',10));}
      }
      candidates.push({key:station,position,owned:true,priority:selected.has(station.id)?1:0,bounds:station.name?{left:x-2,right:x+width+2,top,bottom:y+3}:null});
    }
    const plan=planStationLabelVisibility(candidates,40);this.stationLabelPlan=plan.visible;this.stationLabelStats=plan.stats;
  }
  stationLabelVisible(station){return !this.stationLabelPlan||this.stationLabelPlan.has(station);}
  drawExisting(ctx, c, size) {
    this.prepareStationLabels(ctx,c,size);
    const left = c.x - this.width / size / 2, right = c.x + this.width / size / 2, top = c.y - this.height / size / 2, bottom = c.y + this.height / size / 2;
    const offsetX = this.width / 2 - c.x * size, offsetY = this.height / 2 - c.y * size;
    const selectedIds = new Set(this.options.selectedStationIds || []);
    const selectedSources = new Set((this.state.stations || []).filter(s => s.existing && selectedIds.has(s.id)).map(s => String(s.sourceStationId)));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const type of ['rail', 'shinkansen']) {
      ctx.beginPath();
      for (const line of this.railPaths) {
        if ((line.type === 'shinkansen') !== (type === 'shinkansen') || line.maxX < left || line.minX > right || line.maxY < top || line.minY > bottom) continue;
        const xy = line.xy;
        ctx.moveTo(xy[0] * size + offsetX, xy[1] * size + offsetY);
        let lastX = xy[0] * size + offsetX, lastY = xy[1] * size + offsetY;
        for (let i = 2; i < xy.length; i += 2) {
          const x = xy[i] * size + offsetX, y = xy[i + 1] * size + offsetY;
          if (i + 2 < xy.length && Math.abs(x - lastX) + Math.abs(y - lastY) < 1.5) continue;
          ctx.lineTo(x, y); lastX = x; lastY = y;
        }
      }
      ctx.strokeStyle = type === 'shinkansen' ? '#9163af' : '#267ac7';
      ctx.lineWidth = this.view.zoom <= 7 ? 1 : 3;
      ctx.globalAlpha = this.layer === 'satellite' ? .94 : .84;
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    const radius = this.stationRadius();
    ctx.beginPath();
    for (const s of this.existingStations) {
      if (s.x < left || s.x > right || s.y < top || s.y > bottom) continue;
      const x = s.x * size + offsetX, y = s.y * size + offsetY;
      ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
    ctx.fillStyle = '#267ac7'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = this.view.zoom <= 7 ? .5 : 1; ctx.fill(); ctx.stroke();
    for (const s of this.existingStations) {
      if (s !== this.popupStation && !selectedSources.has(String(s.id))) continue;
      if (s.x < left || s.x > right || s.y < top || s.y > bottom) continue;
      const x=s.x*size+offsetX,y=s.y*size+offsetY;ctx.beginPath();ctx.arc(x,y,radius+1,0,Math.PI*2);ctx.fillStyle='#e07722';ctx.fill();ctx.stroke();
    }
    if (this.view.zoom > 10.65) {
      ctx.font = '11px "Noto Sans JP", system-ui, sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#176589';
      for (const s of this.existingStations) { if (!s.name || !this.stationLabelVisible(s) || s.x < left || s.x > right || s.y < top || s.y > bottom) continue; const x = s.x * size + offsetX + 7, y = s.y * size + offsetY - 6; ctx.fillStyle=selectedSources.has(String(s.id))?'#a95520':'#176589';ctx.strokeText(s.name, x, y); ctx.fillText(s.name, x, y); }
    }
  }
  nearestExistingStation(location,maxPixels=12,options={}) {
    const p=this.latLngToScreen(location),c=this.center,size=this.worldSize;let best=null,bestDistance=maxPixels;
    for (const station of this.existingStations) {
      if (options.railOnly && (station.type === 'shinkansen' || station.shinkansen)) continue;
      const x=(station.x-c.x)*size+this.width/2,y=(station.y-c.y)*size+this.height/2,distance=Math.hypot(p.x-x,p.y-y);if(distance<bestDistance){best=station;bestDistance=distance;}
    }
    return best;
  }
  showStationPopup(station) {
    this.closeStationPopup(); this.popupStation=station;
    const popup=document.createElement('section'); popup.id='existing-station-popup';popup.setAttribute('role','dialog');popup.setAttribute('aria-label',`${station.name}駅の情報`);
    Object.assign(popup.style,{position:'absolute',zIndex:'7',padding:'12px 32px 12px 13px',maxWidth:'250px',minWidth:'150px',background:'#fff',border:'1px solid #d7e1e6',borderRadius:'7px',boxShadow:'0 4px 18px #18343c25',font:'12px system-ui,sans-serif',color:'#294855',transform:'translate(-50%,-100%)',pointerEvents:'auto'});
    const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','駅情報を閉じる');
    Object.assign(close.style,{position:'absolute',top:'3px',right:'5px',border:'none',background:'transparent',fontSize:'20px',color:'#87979f',cursor:'pointer'});close.addEventListener('click',()=>this.closeStationPopup());
    const title=document.createElement('strong');title.textContent=station.name || '既設駅';title.style.fontSize='14px';title.style.display='block';
    const details=document.createElement('div');details.style.marginTop='5px';details.style.color='#71818a';
    details.textContent=[station.shinkansen?'新幹線':'既設駅',station.line].filter(Boolean).join(' · ');
    popup.append(close,title,details);this.container.append(popup);this.stationPopup=popup;this.positionStationPopup();this.requestRender();
  }
  positionStationPopup() {
    if(!this.stationPopup||!this.popupStation)return;
    const p=this.latLngToScreen(fromWorld(this.popupStation));
    this.stationPopup.style.left=`${clamp(p.x,90,this.width-90)}px`;this.stationPopup.style.top=`${Math.max(75,p.y-12)}px`;
    this.stationPopup.hidden=p.x<-50||p.x>this.width+50||p.y<-50||p.y>this.height+50;
  }
  closeStationPopup() {this.stationPopup?.remove();this.stationPopup=null;this.popupStation=null;this.requestRender();}
  path(ctx, points, offset = 0) {
    if (!points?.length) return;
    const positions = points.map(p => this.latLngToScreen(p));
    ctx.beginPath();
    positions.forEach((p, i) => {
      let x = p.x, y = p.y;
      if (offset) { const a = positions[Math.max(0, i - 1)], b = positions[Math.min(positions.length - 1, i + 1)], d = Math.hypot(b.x - a.x, b.y - a.y) || 1; x += -(b.y - a.y) / d * offset; y += (b.x - a.x) / d * offset; }
      if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
  }
  drawTrack(ctx, track, plan = false) {
    const points = track.points || [];
    if (points.length < 2) return;
    const style = this.trackVisualStyle(track, plan), color = style.color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if(!plan&&this.options.selectedTrackId&&this.options.selectedTrackId===track.id&&!track.stationTrack&&!track.existing&&!String(track.id).startsWith('existing:')){
      this.path(ctx,points);ctx.strokeStyle='rgba(222,119,37,.25)';ctx.lineWidth=style.gap+16;ctx.stroke();
      this.path(ctx,points);ctx.strokeStyle='#de7725';ctx.lineWidth=style.gap+9;ctx.stroke();
    }
    this.path(ctx, points); ctx.strokeStyle = plan ? 'rgba(255,255,255,.94)' : 'rgba(255,255,255,.9)'; ctx.lineWidth = style.gap + 7; ctx.stroke();
    if (!plan) { this.path(ctx, points); ctx.strokeStyle = track.type === 'double' ? '#d9e4dc' : '#d8e6e6'; ctx.lineWidth = style.gap + 4; ctx.stroke(); }
    for (const offset of style.offsets) {
      this.path(ctx, points, offset); ctx.strokeStyle = color; ctx.lineWidth = plan ? 2.2 : 2.4;
      if (plan) ctx.setLineDash([7, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (!plan) this.drawTrackDetails(ctx, points, track.type, style);
    if (track.type === 'scissors') {
      const mirrored=this.mirrorScissorsPoints(track);
      this.path(ctx,mirrored);ctx.strokeStyle=plan?'rgba(255,255,255,.9)':'rgba(255,255,255,.84)';ctx.lineWidth=6;ctx.stroke();
      this.path(ctx,mirrored);ctx.strokeStyle=color;ctx.lineWidth=plan?2.7:3;if(plan)ctx.setLineDash([7,4]);ctx.stroke();ctx.setLineDash([]);
    }
  }
  trackVisualStyle(track, plan = false) {
    const gap = track.type === 'double' ? Math.max(6, 2.5 / this.metersPerPixel()) : 0;
    return { gap, offsets: gap ? [-gap / 2, gap / 2] : [0], color: track.invalid ? '#dc4b44' : plan ? '#e4a22d' : track.type === 'double' ? '#198754' : ['crossover','scissors'].includes(track.type) ? '#a67e35' : '#087f8c' };
  }
  drawTrackDetails(ctx, points, type, style) {
    const positions = points.map(p => this.latLngToScreen(p));
    if (this.view.zoom >= 16) {
      const sleepers = pathSamples(positions, this.width, this.height, 13, 220);
      ctx.strokeStyle = '#36554666'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const sample of sleepers) for (const offset of style.offsets) {
        const nx = -Math.sin(sample.angle), ny = Math.cos(sample.angle), x = sample.x + nx * offset, y = sample.y + ny * offset;
        ctx.moveTo(x - nx * 3.7, y - ny * 3.7); ctx.lineTo(x + nx * 3.7, y + ny * 3.7);
      }
      ctx.stroke();
    }
    if (!['single','double'].includes(type)) return;
    const arrows = pathSamples(positions, this.width, this.height, 135, 48);
    ctx.strokeStyle = type === 'double' ? '#075d37' : '#04535c'; ctx.lineWidth = 1.4;
    for (const sample of arrows) for (const direction of [-1,1]) {
      const offset = type === 'double' ? -direction * style.gap / 2 : 0;
      const along = type === 'single' ? direction * 7 : 0;
      const x = sample.x - Math.sin(sample.angle) * offset + Math.cos(sample.angle) * along, y = sample.y + Math.cos(sample.angle) * offset + Math.sin(sample.angle) * along;
      const a = sample.angle + (direction < 0 ? Math.PI : 0), tx = Math.cos(a), ty = Math.sin(a), nx = -ty, ny = tx;
      ctx.beginPath(); ctx.moveTo(x - tx * 3 - nx * 2.5, y - ty * 3 - ny * 2.5); ctx.lineTo(x + tx * 2.5, y + ty * 2.5); ctx.lineTo(x - tx * 3 + nx * 2.5, y - ty * 3 + ny * 2.5); ctx.stroke();
    }
  }
  mirrorScissorsPoints(track) {
    const tracks=this.state.tracks||[];let host=tracks.find(t=>t.id===track.hostTrackId);
    if(!host){const hostId=this.nearestTrack(track.points[0])?.trackId;host=tracks.find(t=>t.id===hostId);}
    if(!host?.points?.length)return track.points;
    const hostPixels=host.points.map(p=>this.latLngToScreen(p));
    return track.points.map(point=>{
      const p=this.latLngToScreen(point);let nearest=null,distance=Infinity;
      for(let i=1;i<hostPixels.length;i++){
        const a=hostPixels[i-1],b=hostPixels[i],dx=b.x-a.x,dy=b.y-a.y,d=dx*dx+dy*dy,t=d?clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/d,0,1):0;
        const x=a.x+dx*t,y=a.y+dy*t,delta=Math.hypot(p.x-x,p.y-y);if(delta<distance){distance=delta;nearest={x,y};}
      }
      return nearest?this.screenToLatLng({x:2*nearest.x-p.x,y:2*nearest.y-p.y}):point;
    });
  }
  stationAngle(station) {
    if (Number.isFinite(station.bearing)) return -station.bearing * Math.PI / 180;
    const track = (this.state.tracks || []).find(t => t.id === station.trackId);
    if (!track?.points?.length) return Number(station.angle) || 0;
    const p = this.latLngToScreen(station);
    let best = Infinity, angle = 0;
    for (let i = 1; i < track.points.length; i++) {
      const a = this.latLngToScreen(track.points[i - 1]), b = this.latLngToScreen(track.points[i]);
      const dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy;
      const t = d ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / d, 0, 1) : 0;
      const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
      if (distance < best) { best = distance; angle = Math.atan2(dy, dx); }
    }
    return angle;
  }
  stationRadius() {
    const zoom = this.view.zoom;
    if (zoom <= 5) return 1;
    if (zoom <= 7) return 1 + (zoom - 5) * .25;
    if (zoom <= 9) return 1.5 + (zoom - 7) * .25;
    return Math.min(3, 2 + zoom - 9);
  }
  stationDraftEntries(){
    return (this.options?.stationDraftPreviews||[]).map((entry,index)=>{
      const draftIndex=Number.isInteger(entry.draftIndex)?entry.draftIndex:index,raw=entry.draft||this.state.stationDrafts?.[draftIndex],preview=entry.preview||{},source=entry.source;
      const adoption=!!source||entry.kind==='existing'||raw?.kind==='existing';
      const sourcePoint=source?{lat:source.sourceLat??source.lat,lng:source.sourceLng??source.lng}:null;
      const anchor=point(adoption?(sourcePoint||entry.point||raw?.point||preview.point):(preview.point||entry.point||raw?.point));
      if(!anchor||!Number.isFinite(anchor.lat)||!Number.isFinite(anchor.lng))return null;
      const settings=raw?.options||{},station={...settings,...preview,...anchor,id:`station-draft:${draftIndex}`,cars:preview.cars||raw?.cars||this.options.platformCars||1,layoutId:preview.layoutId||settings.layoutId||this.options.stationLayoutId||'side-1',standalone:preview.standalone??settings.placement==='free',constructionDraft:true,stationDraftIndex:draftIndex,selectedDraft:!!entry.selected,valid:preview.ok!==false};
      return {...entry,preview,source,adoption,point:anchor,draftIndex,station};
    }).filter(Boolean);
  }
  nearestStationDraft(value,maxPixels=12){
    const target=this.latLngToScreen(value);let best=null,bestDistance=maxPixels,bestCenter=Infinity;
    for(const entry of this.stationDraftEntries()){
      const center=this.latLngToScreen(entry.point),centerDistance=Math.hypot(target.x-center.x,target.y-center.y);let screenDistance=centerDistance;
      if(!entry.adoption){
        const polygon=this.stationDisplayGeometry(entry.station).footprint;let positive=false,negative=false,edgeDistance=Infinity;
        for(let index=0;index<polygon.length;index++){
          const a=polygon[index],b=polygon[(index+1)%polygon.length],dx=b.x-a.x,dy=b.y-a.y,cross=dx*(target.y-a.y)-dy*(target.x-a.x);positive ||= cross>1e-5;negative ||= cross < -1e-5;
          const t=clamp(((target.x-a.x)*dx+(target.y-a.y)*dy)/(dx*dx+dy*dy||1),0,1);edgeDistance=Math.min(edgeDistance,Math.hypot(target.x-a.x-t*dx,target.y-a.y-t*dy));
        }
        screenDistance=positive&&negative?edgeDistance:0;
      }
      if(screenDistance<bestDistance-1e-5||screenDistance<=bestDistance+1e-5&&(centerDistance<bestCenter-1e-5||entry.selected&&Math.abs(centerDistance-bestCenter)<1e-5)){
        best=entry.draftIndex;bestDistance=screenDistance;bestCenter=centerDistance;
      }
    }
    return best;
  }
  drawStationDrafts(ctx){
    for(const entry of this.stationDraftEntries()){
      ctx.save();ctx.globalAlpha=entry.selected ? .95 : .65;
      if(entry.adoption)this.drawStationAdoptionDraft(ctx,entry);
      else this.drawStation(ctx,entry.station,true);
      ctx.restore();
    }
  }
  drawStationAdoptionDraft(ctx,entry){
    const p=this.latLngToScreen(entry.point);if(p.x < -30||p.x>this.width+30||p.y < -30||p.y>this.height+30)return;
    const color=entry.preview.ok===false?'#dc4b44':entry.selected?'#df7725':'#267ac7';
    ctx.beginPath();ctx.arc(p.x,p.y,entry.selected?12:10,0,Math.PI*2);ctx.fillStyle='rgba(255,255,255,.5)';ctx.fill();ctx.setLineDash([4,3]);ctx.strokeStyle=color;ctx.lineWidth=entry.selected?2.5:1.8;ctx.stroke();ctx.setLineDash([]);
    const label=`利用登録の下書き${entry.draftIndex+1} · ${entry.source?.name||'既設駅'}`,x=clamp(p.x+14,8,Math.max(8,this.width-180)),y=clamp(p.y-23,18,Math.max(18,this.height-8));
    ctx.font='600 11px "Noto Sans JP",system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.strokeStyle='#fff';ctx.lineWidth=4;ctx.strokeText(label,x,y);ctx.fillStyle=color;ctx.fillText(label,x,y);
  }
  drawStation(ctx, station, preview = false) {
    // Shared stations keep the original blue station marker and name. Their
    // projected routing anchor must not create a second platform on the map.
    if (station.existing && !preview) return;
    if (station.layoutId || station.standalone || station.geometry) { this.drawStationFacility(ctx, station, preview); return; }
    const p = this.latLngToScreen(station);
    if (p.x < -200 || p.x > this.width + 200 || p.y < -100 || p.y > this.height + 100) return;
    const cars = Number(station.cars || station.platformCars || 1), length = cars * 20 / this.metersPerPixel(station.lat), width = 4.5 / this.metersPerPixel(station.lat);
    const selected = this.options.selectedStationIds?.includes(station.id);
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(this.stationAngle(station));
    const previewInvalid=preview&&station.valid===false;
    ctx.fillStyle = preview ? previewInvalid?'rgba(220,75,68,.3)':'rgba(22,142,193,.35)' : selected ? '#e07722' : 'rgba(38,122,199,.4)'; ctx.strokeStyle = preview ? previewInvalid?'#dc4b44':'#168ec1' : selected ? '#e07722' : '#267ac7';
    ctx.lineWidth = selected ? 2.4 : 1.7;
    if (selected) { ctx.shadowColor = '#4fb0d8'; ctx.shadowBlur = 10; }
    if (preview || width > this.stationRadius() * 2) { ctx.fillRect(-length / 2, -width / 2, length, width); ctx.strokeRect(-length / 2, -width / 2, length, width); } ctx.restore();
    if (!preview) {
      ctx.beginPath(); ctx.arc(p.x, p.y, this.stationRadius(), 0, Math.PI * 2);
      ctx.fillStyle = selected ? '#e07722' : '#267ac7'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
    }
    if (!preview && station.name && this.view.zoom > 10.65 && this.stationLabelVisible(station)) {
      ctx.font = '600 12px "Noto Sans JP", system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.lineWidth = 3.8; ctx.strokeStyle = '#fff'; ctx.fillStyle = selected ? '#05759c' : '#1c343f';
      ctx.strokeText(station.name, p.x + 9, p.y - 10); ctx.fillText(station.name, p.x + 9, p.y - 10);
    } else if (preview) {
      ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.fillStyle = previewInvalid?'#dc4b44':'#168ec1';
      ctx.strokeText(`${cars}両`, p.x + 10, p.y - 9); ctx.fillText(`${cars}両`, p.x + 10, p.y - 9);
    }
  }
  stationDisplayGeometry(station, suppliedGeometry = null) {
    const geometry = suppliedGeometry || station.geometry || stationGeometry(station), center = this.latLngToScreen(station), angle = -geometry.bearing * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle), mpp = this.metersPerPixel(station.lat);
    const offsets = [...geometry.trackOffsets].sort((a,b)=>a-b), gaps = offsets.slice(1).map((value,index)=>value-offsets[index]).filter(value=>value>.01);
    const minimumGap = gaps.length ? Math.min(...gaps) : 4;
    // New independent ports and platform rails use the same physical scale so
    // their straight extensions also meet outside tracks at the drawn point.
    const straight = geometry.wiringMode === 'platforms' && geometry.portGeometry !== 'spread';
    const crossScale = !straight && this.view.zoom >= 12 ? Math.max(1, (this.view.zoom >= 14 ? 6 : 4) * mpp / minimumGap) : 1;
    const transform = value => {
      const p = this.latLngToScreen(value), dx = p.x - center.x, dy = p.y - center.y;
      const along = dx * cos + dy * sin, across = (-dx * sin + dy * cos) * crossScale;
      return { x:center.x + along*cos - across*sin, y:center.y + along*sin + across*cos };
    };
    const physicalHosts=new Set((geometry.hostPaths||[]).map(path=>path.platformIndex));
    const paths = geometry.trackPaths.map((path,platformIndex) => path.map((value,index)=>{
      if(physicalHosts.has(platformIndex))return this.latLngToScreen(value);
      const end = index === 0 ? 'a' : index === path.length - 1 ? 'b' : null;
      // Connectable ports stay at their real geographic coordinates. A buffer
      // belongs to the exaggerated platform body and must move with its rail.
      return end && geometry.trackConfigs?.[platformIndex]?.[end] !== 'buffer' ? this.latLngToScreen(value) : transform(value);
    }));
    const bodyPaths=(geometry.platformTrackBodies||geometry.trackPaths.map(path=>[path[1]||path[0],path.at(-2)||path.at(-1)])).map((path,index)=>path.map(value=>physicalHosts.has(index)?this.latLngToScreen(value):transform(value)));
    const platforms = geometry.platforms.map(platform => ({ ...platform, points:platform.points.map(transform) }));
    const physicalPorts = Array.isArray(geometry.connectionPorts) ? geometry.connectionPorts : geometry.connections.map((point,index)=>({point,key:String(index),label:'',platformNumbers:[],end:index?'b':'a'}));
    const connectionPorts = physicalPorts.map(port=>({...port,screen:this.latLngToScreen(port.point)}));
    const bufferStops = (geometry.bufferStops||[]).map(buffer=>({...buffer,screen:paths[buffer.platformIndex]?.[buffer.end==='a'?0:paths[buffer.platformIndex].length-1]||transform(buffer.point)}));
    const footprint = geometry.footprint.map(transform), all = [...footprint,...paths.flat()];
    return { ...geometry, center, angle, crossScale, paths, bodyPaths, platforms, footprint, connectionPorts, bufferStops, connections:connectionPorts.map(port=>port.screen), bounds:{left:Math.min(...all.map(p=>p.x)),right:Math.max(...all.map(p=>p.x)),top:Math.min(...all.map(p=>p.y)),bottom:Math.max(...all.map(p=>p.y))} };
  }
  pixelPath(ctx, points, close = false) {
    if (!points?.length) return;
    ctx.beginPath(); points.forEach((p,index)=>index ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y)); if(close)ctx.closePath();
  }
  drawStationFacility(ctx, station, preview = false) {
    const geometry = this.stationDisplayGeometry(station), bounds = geometry.bounds;
    if (bounds.right < -100 || bounds.left > this.width + 100 || bounds.bottom < -100 || bounds.top > this.height + 100) return;
    const selected = !!station.selectedDraft||this.options.selectedStationIds?.includes(station.id), invalid = preview && station.valid === false;
    const color = invalid ? '#dc4b44' : selected ? '#df7725' : '#087f8c';
    const existingHostIndices=new Set(station.existingTrack?(geometry.hostPaths||[]).map(path=>path.platformIndex):[]);
    const railColor=index=>existingHostIndices.has(index)&&!invalid&&!selected?'#267ac7':color;
    ctx.save(); ctx.lineJoin='round';ctx.lineCap='round';
    if (this.view.zoom >= 12 || preview) {
      this.pixelPath(ctx,geometry.footprint,true);ctx.fillStyle=invalid?'rgba(220,75,68,.1)':preview?'rgba(219,240,243,.52)':'rgba(248,247,239,.8)';ctx.fill();ctx.strokeStyle=invalid?'#dc4b44':selected?'#df7725':preview?'#5e9ba7':'#98ada7';ctx.lineWidth=station.selectedDraft?2:1;
      if(preview)ctx.setLineDash([4,3]);ctx.stroke();ctx.setLineDash([]);
      for (const [index,path] of geometry.paths.entries()) {
        this.pixelPath(ctx,path);ctx.strokeStyle='rgba(255,255,255,.94)';ctx.lineWidth=5;ctx.stroke();
        this.pixelPath(ctx,path);ctx.strokeStyle=railColor(index);ctx.lineWidth=1.8;if(station.constructionDraft&&!existingHostIndices.has(index))ctx.setLineDash([6,3]);ctx.stroke();ctx.setLineDash([]);
      }
      for(const platform of geometry.platforms){
        this.pixelPath(ctx,platform.points,true);ctx.fillStyle=invalid?'#f4bbb6':selected?'#f4d29e':preview?'#d4e9d6':'#e7d7ac';ctx.fill();ctx.strokeStyle=invalid?'#dc4b44':'#a5905d';ctx.lineWidth=1;ctx.stroke();
      }
      if(this.view.zoom>=15)geometry.paths.forEach((path,index)=>{
        const [a,b]=geometry.bodyPaths[index],t=index%2?.3:.1,p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
        ctx.beginPath();ctx.arc(p.x,p.y,4.1,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.strokeStyle=railColor(index);ctx.lineWidth=.8;ctx.stroke();
        ctx.font='7px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#295c63';ctx.fillText(String(index+1),p.x,p.y+.2);
      });
      if(geometry.wiringMode==='platforms'){
        geometry.paths.forEach((path,index)=>this.drawStationTrackDirection(ctx,path,geometry.trackConfigs?.[index]?.direction||'both',railColor(index),geometry.bodyPaths[index]));
        for(const buffer of geometry.bufferStops){
          const p=buffer.screen,across={x:-Math.sin(geometry.angle)*5,y:Math.cos(geometry.angle)*5};
          this.pixelPath(ctx,[{x:p.x-across.x,y:p.y-across.y},{x:p.x+across.x,y:p.y+across.y}]);
          ctx.strokeStyle='#fff';ctx.lineWidth=5;ctx.stroke();ctx.strokeStyle=invalid?'#dc4b44':'#a24c3a';ctx.lineWidth=2.6;ctx.stroke();
        }
      }
    } else {
      ctx.beginPath();ctx.arc(geometry.center.x,geometry.center.y,4,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.stroke();
    }
    const portOrdinals={a:0,b:0};
    if (['track','track-edit'].includes(this.options.mode) || preview || selected) for(const port of geometry.connectionPorts){
      const p=port.screen,portColor=port.platformNumbers?.some(number=>existingHostIndices.has(number-1))&&!invalid&&!selected?'#267ac7':color;
      ctx.beginPath();ctx.arc(p.x,p.y,preview?3.5:4.5,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.strokeStyle=portColor;ctx.lineWidth=1.8;ctx.stroke();
      if(geometry.wiringMode==='platforms'&&port.label&&this.view.zoom>=15){
        const index=portOrdinals[port.end]++||0,sign=port.end==='a'?-1:1,along=12+(index%4)*12,x=p.x+Math.cos(geometry.angle)*sign*along,y=p.y+Math.sin(geometry.angle)*sign*along;
        ctx.font='600 8.5px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineWidth=3;ctx.strokeStyle='#fff';ctx.strokeText(port.label,x,y);ctx.fillStyle=portColor;ctx.fillText(port.label,x,y);
      }
    }
    const layout = geometry.layout || getStationLayout(station.layoutId), label = station.constructionDraft?`駅の下書き${station.stationDraftIndex+1} · ${layout.platforms}面${layout.tracks}線`:preview ? `${layout.platforms}面${layout.tracks}線 · ${station.cars || 1}両` : station.name;
    if(label&&(preview||(this.view.zoom>10.65&&this.stationLabelVisible(station)))){
      const x=Math.max(5,bounds.left),y=Math.max(17,bounds.top-10);ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.font='600 12px "Noto Sans JP",system-ui,sans-serif';ctx.lineWidth=3.5;ctx.strokeStyle='#fff';ctx.strokeText(label,x,y);ctx.fillStyle=invalid?'#b43b35':selected?'#9f541c':'#244a50';ctx.fillText(label,x,y);
      if(!preview&&this.view.zoom>=12){const detail=`${layout.platforms}面${layout.tracks}線`;ctx.font='10px system-ui,sans-serif';ctx.strokeText(detail,x,y-14);ctx.fillStyle='#587880';ctx.fillText(detail,x,y-14);}
    }
    ctx.restore();
  }
  drawStationTrackDirection(ctx,path,direction,color,body=null){
    const [a,b]=body||[path[1],path[path.length-2]],dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    if(length<18)return;
    const ux=dx/length,uy=dy/length;
    for(const [sign,t] of direction==='both'?[[1,.6],[-1,.84]]:[[direction==='reverse'?-1:1,.68]]){
      const x=a.x+dx*t,y=a.y+dy*t;
      this.pixelPath(ctx,[{x:x-ux*sign*4-uy*2.5,y:y-uy*sign*4+ux*2.5},{x:x+ux*sign*2,y:y+uy*sign*2},{x:x-ux*sign*4+uy*2.5,y:y-uy*sign*4-ux*2.5}]);
      ctx.strokeStyle='#fff';ctx.lineWidth=3.8;ctx.stroke();ctx.strokeStyle=color;ctx.lineWidth=1.3;ctx.stroke();
    }
  }
  nearestStationConnection(value, maxPixels = 12, maxMetres = 80) {
    const cursor = this.latLngToScreen(value); let best = null;
    const draftStations=this.stationDraftEntries().filter(entry=>!entry.adoption).map(entry=>entry.station);
    for (const station of [...this.state.stations||[],...draftStations]) {
      if(station.existing || (!station.layoutId&&!station.standalone&&!station.connectionPoints&&station.wiringMode!=='platforms'))continue;
      const geometry=station.geometry||stationGeometry(station);
      const ports=Array.isArray(geometry.connectionPorts)?geometry.connectionPorts:geometry.connections.map(point=>({point}));
      for(const port of ports){
        const connection=port.point;
        const p=this.latLngToScreen(connection),screenDistance=Math.hypot(p.x-cursor.x,p.y-cursor.y),distance=screenDistance*this.metersPerPixel(value.lat);
        if(p.x<0||p.x>this.width||p.y<0||p.y>this.height)continue;
        const selectedTie=best?.stationDraftIndex!=null&&station.selectedDraft&&Math.abs(screenDistance-best.screenDistance)<1e-5;
        if(screenDistance<=maxPixels&&distance<=maxMetres&&(!best||screenDistance<best.screenDistance||selectedTie))best={point:{...connection},distance,screenDistance,stationId:station.id,portKey:port.key,portLabel:port.label,label:port.label,platformNumbers:port.platformNumbers?[...port.platformNumbers]:[],end:port.end,existingHost:!!(station.existingTrack&&port.platformNumbers?.some(number=>geometry.hostSlotIndices.includes(number-1))),...(station.constructionDraft?{stationDraftIndex:station.stationDraftIndex,previewStation:true}: {})};
      }
    }
    return best;
  }
  nearestTrack(value, maxPixels = 18, options={}) {
    const p = this.latLngToScreen(value); let best = null;
    for (const track of this.state.tracks || []) {
      if(options.mainOnly&&!['single','double'].includes(track.type))continue;
      for (let i = 1; i < track.points.length; i++) {
      const a = this.latLngToScreen(track.points[i - 1]), b = this.latLngToScreen(track.points[i]), dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy;
      const t = d ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / d, 0, 1) : 0, x = a.x + dx * t, y = a.y + dy * t, distance = Math.hypot(p.x - x, p.y - y);
      if (distance <= maxPixels && (!best || distance < best.distance)) best = { ...this.screenToLatLng({ x, y }), trackId: track.id, distance, angle: Math.atan2(dy, dx), segment: i - 1, fraction: t };
    }
    }
    return best;
  }
  stationPreviewValid(snapped,cars) {
    const track=(this.state.tracks||[]).find(t=>t.id===snapped.trackId);
    if(!track)return false;
    const pixels=track.points.map(p=>this.latLngToScreen(p)),mpp=this.metersPerPixel(snapped.lat);
    let length=0,offset=0;
    for(let i=1;i<pixels.length;i++){
      const metres=Math.hypot(pixels[i].x-pixels[i-1].x,pixels[i].y-pixels[i-1].y)*mpp;
      if(i-1<snapped.segment)offset+=metres;else if(i-1===snapped.segment)offset+=metres*snapped.fraction;
      length+=metres;
    }
    if(length<cars*20||offset<cars*10||length-offset<cars*10)return false;
    if((this.state.stations||[]).some(s=>s.trackId===track.id&&Math.abs(Number(s.offset)-offset)<(Number(s.cars)+cars)*10+2))return false;
    return this.state.unlimited||this.state.money==null||this.state.money>=100_000_000+cars*80_000_000;
  }
  drawPlan(ctx) {
    const options = this.options, plan = options.plan || [];
    for(const stroke of options.draftStrokes||[]){
      const controls=stroke.controlPoints||stroke.rawPoints||stroke.points||[],geometry=(stroke.previewPoints||stroke.points||controls).map(point);
      if(geometry.length>1)this.drawTrack(ctx,{type:stroke.type,points:geometry,invalid:!!stroke.invalid},true);
      controls.forEach((value,index)=>{
        const p=this.latLngToScreen(point(value)),endpoint=index===0||index===controls.length-1;
        ctx.beginPath();ctx.arc(p.x,p.y,endpoint?4.5:2.8,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.lineWidth=1.7;ctx.strokeStyle=stroke.invalid?'#dc4b44':'#6f8d97';ctx.stroke();
      });
    }
    this.drawCurveGuides(ctx);
    const points = (options.previewPoints || plan).map(point), controls=options.controlPoints||plan;
    if (!options.previewPoints && options.hover && points.length && options.mode === 'track') points.push(point(options.hover));
    if (points.length > 1) this.drawTrack(ctx, { type: options.trackType, points, invalid:!!options.previewInvalid }, true);
    for (const [index, p] of controls.entries()) {
      const removable = index === options.removePointIndex;
      const at = this.latLngToScreen(point(p)); ctx.beginPath(); ctx.arc(at.x, at.y, removable ? 6 : 4.5, 0, Math.PI * 2); ctx.fillStyle = removable ? '#ffe7e5' : '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = removable || options.previewInvalid?'#dc4b44':'#d38b1e'; ctx.stroke();
    }
    this.drawCurveHandles(ctx);
    if (options.mode === 'station' && (options.hover || options.stationPreview?.point)) {
      const supplied = options.stationPreview, previewPoint = supplied?.point || options.hover;
      if (supplied?.geometry && supplied.point) this.drawStation(ctx,{...supplied.point,cars:supplied.cars||options.platformCars,layoutId:supplied.layoutId||options.stationLayoutId,bearing:supplied.bearing,standalone:supplied.standalone,existingTrack:supplied.existingTrack,wiringMode:supplied.wiringMode,trackConfigs:supplied.trackConfigs,geometry:supplied.geometry,valid:supplied.ok},true);
      else if(options.stationPlacement==='free') this.drawStation(ctx,{...previewPoint,cars:options.platformCars,layoutId:options.stationLayoutId||'island-4',bearing:Number(options.stationBearing)||0,standalone:true,wiringMode:options.stationWiringMode,trackConfigs:options.stationTrackConfigs,valid:!options.stationPreviewInvalid},true);
      else {
        const snapped = this.nearestTrack(previewPoint,18,{mainOnly:true});
        if (snapped) this.drawStation(ctx, { ...snapped, cars: options.platformCars,layoutId:options.stationLayoutId,bearing:options.stationLayoutId?-snapped.angle*180/Math.PI:undefined,valid:options.stationPreviewInvalid==null?this.stationPreviewValid(snapped,Number(options.platformCars)||1):!options.stationPreviewInvalid }, true);
      }
    }
    if(options.mode==='station'&&options.stationHostConnection)this.drawStationHostConnection(ctx,options.stationHostConnection);
    if (options.existingConnection?.point && options.mode === 'track') this.drawExistingConnection(ctx, options.existingConnection);
    if(options.mode==='track'&&options.stationPortConnection)this.drawStationPortConnection(ctx,options.stationPortConnection);
    this.drawDraftSnap(ctx);
  }
  curveTerminalTangent(controls,provided,geometry,mode){
    if(!controls?.length&&!geometry?.length)return null;
    const anchor=point(controls?.at(-1)||geometry.at(-1)),at=this.latLngToScreen(anchor);let toward=null;
    if(mode==='point'&&controls?.length)toward=this.latLngToScreen(this.curveHandlePoints(controls,provided||[]).at(-1));
    else if(mode==='tangent'&&controls?.length>1){const before=this.latLngToScreen(point(controls.at(-2)));toward={x:2*at.x-before.x,y:2*at.y-before.y};}
    else if(geometry?.length>1){
      for(let index=geometry.length-2;index>=0;index--){const before=this.latLngToScreen(point(geometry[index]));if(Math.hypot(at.x-before.x,at.y-before.y)>.2){toward={x:2*at.x-before.x,y:2*at.y-before.y};break;}}
    }
    if(!toward||Math.hypot(toward.x-at.x,toward.y-at.y)<.2)return null;
    return {point:at,vector:{x:toward.x-at.x,y:toward.y-at.y}};
  }
  drawExtendedTangent(ctx,tangent){
    if(!tangent)return;
    const p=tangent.point,v=tangent.vector,length=Math.hypot(v.x,v.y),extent=Math.hypot(this.width,this.height)*2+Math.hypot(p.x-this.width/2,p.y-this.height/2);
    const visible=clipSegment({x:p.x-v.x/length*extent,y:p.y-v.y/length*extent},{x:p.x+v.x/length*extent,y:p.y+v.y/length*extent},this.width,this.height,16);
    if(visible){this.pixelPath(ctx,visible);ctx.stroke();}
  }
  drawCurveGuides(ctx){
    const options=this.options;
    if(!['track','track-edit'].includes(options.mode)||options.curveGuides===false||!['legacy','tangent','point'].includes(options.curveMode))return;
    const controls=options.controlPoints||[],candidate=options.previewControlPoints||controls,geometry=options.plan||[],preview=options.previewPoints||geometry;
    if(!controls.length)return;
    const fixed=this.curveTerminalTangent(controls,options.curveHandles,geometry,options.curveMode),future=this.curveTerminalTangent(candidate,options.previewCurveHandles,preview,options.curveMode);
    let ghost=candidate.length>controls.length?this.latLngToScreen(point(candidate.at(-1))):null;
    if(!ghost&&preview.length&&geometry.length){const p=this.latLngToScreen(point(preview.at(-1))),last=this.latLngToScreen(point(geometry.at(-1)));if(Math.hypot(p.x-last.x,p.y-last.y)>.5)ghost=p;}
    const invalid=!!options.previewInvalid,color=invalid?'#b66c68':'#7d8991';
    ctx.save();ctx.strokeStyle=color;ctx.lineWidth=1.1;ctx.setLineDash([5,5]);
    if(options.curveMode==='tangent')for(let index=1;index<candidate.length;index++){
      const visible=clipSegment(this.latLngToScreen(point(candidate[index-1])),this.latLngToScreen(point(candidate[index])),this.width,this.height,16);
      if(visible){this.pixelPath(ctx,visible);ctx.stroke();}
    }
    this.drawExtendedTangent(ctx,fixed);
    if(ghost)this.drawExtendedTangent(ctx,future);
    ctx.setLineDash([]);let angle=null;
    if(fixed&&future&&ghost){
      const a=fixed.point,b=future.point,u=fixed.vector,v=future.vector,lu=Math.hypot(u.x,u.y),lv=Math.hypot(v.x,v.y),cross=u.x*v.y-u.y*v.x;
      angle=Math.acos(clamp((u.x*v.x+u.y*v.y)/lu/lv,-1,1))*180/Math.PI;
      if(Math.abs(cross)/lu/lv>.025){
        const t=((b.x-a.x)*v.y-(b.y-a.y)*v.x)/cross,p={x:a.x+t*u.x,y:a.y+t*u.y};
        if(p.x>=0&&p.x<=this.width&&p.y>=0&&p.y<=this.height){this.pixelPath(ctx,[{x:p.x-3.5,y:p.y},{x:p.x,y:p.y-3.5},{x:p.x+3.5,y:p.y},{x:p.x,y:p.y+3.5}],true);ctx.fillStyle='#fff';ctx.fill();ctx.stroke();}
      }
    }
    if(ghost&&ghost.x>=-16&&ghost.x<=this.width+16&&ghost.y>=-16&&ghost.y<=this.height+16){
      ctx.beginPath();ctx.arc(ghost.x,ghost.y,4.5,0,Math.PI*2);ctx.fillStyle=invalid?'#fff0ee':'#eef1f3';ctx.fill();ctx.strokeStyle=color;ctx.lineWidth=1.7;ctx.stroke();
      const metrics=options.previewMetrics||{},parts=[],format=value=>value>=1000?`${(value/1000).toFixed(2)} km`:`${Math.round(value)} m`;
      if(Number.isFinite(metrics.length))parts.push(`全長 ${format(metrics.length)}`);
      const radius=metrics.minRadius??metrics.radius;
      if(Number.isFinite(radius))parts.push(`最小R ${format(radius)}`);else if(radius===Infinity)parts.push('R ∞');
      const degrees=Number.isFinite(metrics.angle)?metrics.angle:angle;
      if(Number.isFinite(degrees))parts.push(`交角 ${degrees.toFixed(1)}°`);
      if(parts.length){
        const label=parts.join(' · ');ctx.font='11px "Noto Sans JP",system-ui,sans-serif';const width=ctx.measureText?.(label)?.width||label.length*6.5,x=clamp(ghost.x+14,8,Math.max(8,this.width-width-12)),y=clamp(ghost.y+24,22,Math.max(22,this.height-12));
        ctx.fillStyle='rgba(255,255,255,.9)';ctx.fillRect(x-5,y-14,width+10,20);ctx.fillStyle=invalid?'#a8524e':'#54646d';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillText(label,x,y);
      }
    }
    ctx.restore();
  }
  drawCurveHandles(ctx){
    if(!this.canEditCurve())return;
    const controls=this.options.controlPoints||[],handles=this.curveHandlePoints(controls);if(!controls.length)return;
    ctx.save();
    controls.forEach((value,index)=>{
      const anchor=point(value),outgoing=handles[index],incoming={lat:2*anchor.lat-outgoing.lat,lng:2*anchor.lng-outgoing.lng},a=this.latLngToScreen(anchor),out=this.latLngToScreen(outgoing),inc=this.latLngToScreen(incoming);
      if(Math.hypot(out.x-a.x,out.y-a.y)<8)return;
      const active=this.curveHandleDrag?.index===index,color=this.options.previewInvalid?'#c36c65':active?'#d6811b':'#697fa8';
      ctx.setLineDash([3,3]);ctx.strokeStyle=color;ctx.lineWidth=1.1;
      for(const p of [inc,out]){const line=clipSegment(a,p,this.width,this.height,8);if(line){this.pixelPath(ctx,line);ctx.stroke();}}
      ctx.setLineDash([]);
      for(const [side,p] of [['incoming',inc],['outgoing',out]]){
        if(p.x < -8||p.x>this.width+8||p.y < -8||p.y>this.height+8)continue;
        const half=side==='outgoing'?4:3.5;ctx.fillStyle=side==='outgoing'?'#f6e5c5':'#fff';ctx.strokeStyle=color;ctx.lineWidth=active?2:1.4;ctx.fillRect(p.x-half,p.y-half,half*2,half*2);ctx.strokeRect(p.x-half,p.y-half,half*2,half*2);
      }
    });
    ctx.restore();
  }
  drawDraftSnap(ctx){
    const hit=this.options.draftSnap;
    if(!hit?.point)return;
    const p=this.latLngToScreen(point(hit.point));
    if(p.x < -16||p.x>this.width+16||p.y < -16||p.y>this.height+16)return;
    const controls=this.options.controlPoints||this.options.plan||[];
    const removable=hit.active&&controls.length>0&&this.options.removePointIndex===controls.length-1;
    const color=removable?'#dc4b44':'#087f8c';
    ctx.save();ctx.beginPath();ctx.arc(p.x,p.y,12,0,Math.PI*2);ctx.fillStyle='rgba(255,255,255,.86)';ctx.fill();
    ctx.beginPath();ctx.arc(p.x,p.y,8,0,Math.PI*2);ctx.fillStyle=removable?'#ffe7e5':'#e6f5f2';ctx.fill();ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.stroke();
    const label=removable?'点を取消':'端点に接続',x=clamp(p.x+16,8,Math.max(8,this.width-100)),y=clamp(p.y-15,18,Math.max(18,this.height-8));
    ctx.font='600 11px "Noto Sans JP",system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.strokeStyle='#fff';ctx.lineWidth=4;ctx.strokeText(label,x,y);ctx.fillStyle=color;ctx.fillText(label,x,y);ctx.restore();
  }
  drawExistingConnection(ctx, hit) {
    const at = this.latLngToScreen(hit.point);
    if (at.x < 0 || at.x > this.width || at.y < 0 || at.y > this.height) return;
    ctx.save(); ctx.beginPath();ctx.arc(at.x,at.y,8,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,.88)';ctx.fill();ctx.strokeStyle='#267ac7';ctx.lineWidth=2.5;ctx.stroke();
    ctx.beginPath();ctx.arc(at.x,at.y,3.5,0,Math.PI*2);ctx.fillStyle='#e07722';ctx.fill();
    ctx.font='600 11px "Noto Sans JP",system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='alphabetic';
    const text='既存線路に接続',x=clamp(at.x+13,8,Math.max(8,this.width-106)),y=Math.max(22,at.y-12);
    ctx.strokeStyle='#fff';ctx.lineWidth=4;ctx.strokeText(text,x,y);ctx.fillStyle='#216f9e';ctx.fillText(text,x,y);ctx.restore();
  }
  drawStationHostConnection(ctx,hit){
    if(!hit?.point||!hit.track?.points?.length)return;
    const positions=hit.track.points.map(value=>this.latLngToScreen(point(value))),segments=[];
    for(let index=1;index<positions.length;index++){const line=clipSegment(positions[index-1],positions[index],this.width,this.height,8);if(line)segments.push(line);}
    if(!segments.length)return;
    ctx.save();ctx.lineCap='round';ctx.lineJoin='round';
    for(const segment of segments){
      this.pixelPath(ctx,segment);ctx.strokeStyle='rgba(222,160,40,.32)';ctx.lineWidth=7;ctx.stroke();ctx.strokeStyle='#c79025';ctx.lineWidth=2;ctx.stroke();
    }
    const p=this.latLngToScreen(hit.point);
    if(p.x>=0&&p.x<=this.width&&p.y>=0&&p.y<=this.height){
      ctx.beginPath();ctx.arc(p.x,p.y,7.5,0,Math.PI*2);ctx.fillStyle='rgba(255,255,255,.93)';ctx.fill();ctx.strokeStyle='#c79025';ctx.lineWidth=2;ctx.stroke();
      ctx.beginPath();ctx.arc(p.x,p.y,2.8,0,Math.PI*2);ctx.fillStyle='#c79025';ctx.fill();
      const name=hit.track.name||hit.track.line||hit.line||hit.name,label=name?`接続先：${String(name).slice(0,32)}`:hit.track.existing||String(hit.track.id).startsWith('existing:')?'青い線路を選択中':'自作線路を選択中';
      const x=clamp(p.x+14,8,Math.max(8,this.width-170)),y=clamp(p.y-15,20,Math.max(20,this.height-8));
      ctx.font='600 11px "Noto Sans JP",system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.lineWidth=4;ctx.strokeStyle='#fff';ctx.strokeText(label,x,y);ctx.fillStyle='#986610';ctx.fillText(label,x,y);
    }
    ctx.restore();
  }
  drawStationPortConnection(ctx,hit){
    if(!hit?.point||hit.existingHost)return;
    const p=this.latLngToScreen(hit.point);if(p.x < -12||p.x>this.width+12||p.y < -12||p.y>this.height+12)return;
    ctx.save();ctx.beginPath();ctx.arc(p.x,p.y,11,0,Math.PI*2);ctx.fillStyle='rgba(255,255,255,.9)';ctx.fill();
    ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);ctx.fillStyle='#e6f5ef';ctx.fill();ctx.strokeStyle='#087f8c';ctx.lineWidth=2.5;ctx.stroke();
    const port=hit.portLabel||hit.label||(hit.platformNumbers?.length?`${hit.platformNumbers.join('・')}${String(hit.end||'').toUpperCase()}`:'番線接続口'),label=`${port}へ接続`;
    ctx.font='600 11px "Noto Sans JP",system-ui,sans-serif';const width=ctx.measureText?.(label)?.width||label.length*11;
    const x=clamp(p.x+14,8,Math.max(8,this.width-width-8)),y=clamp(p.y-15,19,Math.max(19,this.height-8));
    ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.strokeStyle='#fff';ctx.lineWidth=4;ctx.strokeText(label,x,y);ctx.fillStyle='#087f8c';ctx.fillText(label,x,y);ctx.restore();
  }
  drawMeasurement(ctx) {
    if (!this.options.measureEnabled) return;
    const points=(this.options.measurePoints||[]).slice(0,2).map(point).filter(value=>Number.isFinite(value?.lat)&&Number.isFinite(value?.lng)).map(value=>this.latLngToScreen(value));
    if (!points.length) return;
    ctx.save();ctx.lineCap='round';ctx.lineJoin='round';
    if(points.length===2){
      const visible=clipSegment(points[0],points[1],this.width,this.height,24);
      if(visible){
        this.pixelPath(ctx,visible);ctx.strokeStyle='rgba(255,255,255,.9)';ctx.lineWidth=5;ctx.stroke();
        ctx.setLineDash([8,5]);ctx.strokeStyle='#7c4dcc';ctx.lineWidth=2.2;ctx.stroke();ctx.setLineDash([]);
      }
    }
    points.forEach((p,index)=>{
      if(p.x < -24 || p.x > this.width+24 || p.y < -24 || p.y > this.height+24)return;
      ctx.beginPath();ctx.arc(p.x,p.y,9,0,Math.PI*2);ctx.fillStyle='#7c4dcc';ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();
      ctx.font='700 10px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#fff';ctx.fillText(index?'B':'A',p.x,p.y+.3);
      const label=index?'B 終点':'A 始点',x=clamp(p.x+14,8,Math.max(8,this.width-65)),y=clamp(p.y-13,16,Math.max(16,this.height-8));
      ctx.font='600 11px system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.lineWidth=3.5;ctx.strokeStyle='#fff';ctx.strokeText(label,x,y);ctx.fillStyle='#6b3db8';ctx.fillText(label,x,y);
    });
    ctx.restore();
  }
  drawScale(ctx) {
    const target = 95 * this.metersPerPixel(), unit = 10 ** Math.floor(Math.log10(target)), candidate = target / unit;
    const distance = (candidate >= 5 ? 5 : candidate >= 2 ? 2 : 1) * unit, pixels = distance / this.metersPerPixel();
    const x = this.width - pixels - 16, y = 35;
    ctx.fillStyle = 'rgba(255,255,255,.86)'; ctx.fillRect(x - 5, y - 21, pixels + 10, 28);
    ctx.strokeStyle = '#56666d'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + pixels, y); ctx.lineTo(x + pixels, y - 4); ctx.stroke();
    ctx.fillStyle = '#46565c'; ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.fillText(distance >= 1000 ? `${distance / 1000} km` : `${distance} m`, x, y - 7);
  }
  render() {
    if (this.destroyed || !this.ctx) return;
    const ctx = this.ctx, c = this.center, size = this.worldSize;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = this.layer === 'blank' ? '#ffffff' : this.layer === 'satellite' ? '#ced5ca' : '#e8eee7'; ctx.fillRect(0, 0, this.width, this.height);
    if (this.layer !== 'blank') this.drawTiles(ctx, c, size);
    if (this.options.populationVisible ?? this.state.populationVisible) this.populationLayer?.render(ctx,this.view,this.width,this.height);
    this.drawExisting(ctx, c, size);
    const selectedRoute = (this.state.routes || []).find(r => r.id === this.options.selectedRouteId);
    if (selectedRoute?.points?.length) { this.path(ctx, selectedRoute.points); ctx.strokeStyle = selectedRoute.color || '#318fba'; ctx.globalAlpha = .3; ctx.lineWidth = 14; ctx.stroke(); ctx.globalAlpha = 1; }
    for (const track of this.state.tracks || []) if(!track.stationTrack || !(this.state.stations||[]).some(station=>station.id===track.stationId))this.drawTrack(ctx, track);
    for (const station of this.state.stations || []) this.drawStation(ctx, station);
    this.drawPlan(ctx);
    this.drawStationDrafts(ctx);
    this.drawScale(ctx);
    this.drawMeasurement(ctx);
    this.positionStationPopup();
  }
  destroy() {
    this.destroyed = true; cancelAnimationFrame(this.pendingFrame); this.resizeObserver.disconnect();
    this.listeners.forEach(([name, fn, options]) => this.canvas.removeEventListener(name, fn, options)); this.canvas.remove(); this.retryButton.remove();this.stationPopup?.remove(); this.tiles.clear();
  }
}
