import * as E from './engine.js';
import { RailwayMap } from './map.js';
import { readProgress, hasUnlimitedLock, resetProgress } from './persistence.js';
import { ExistingRailwayNetwork } from './existing-network.js';
import { ElevationLookup, calculateGrade } from './elevation.js';
import { createEditorHistory } from './editor-history.js';
import { captureTrackNetwork, trackNetworkKey, applyTrackNetwork } from './track-edit-state.js';
import { createClockControls } from './game-clock-controls.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const KEYS = { current: 'railway-clone.current.v1', slots: 'railway-clone.slots.v1', active: 'railway-clone.active.v1', unlimited: 'railway-clone.unlimited.v1' };
let game = E.createGame();
let tab = 'build', buildMode = 'track', trackType = 'double', platformCars = 8;
let stationLayoutId = 'island-4', stationPlacement = 'free', stationBearing = 0;
let stationWiringMode = 'platforms', stationTrackConfigs = [];
let stationHostPlatformNumbers = [];
let stationHostPlatformNumber = null, stationHostTrackCount = 1;
let routePlatformAssignments = { forward: {}, backward: {} };
let editingStationId = null, editingStationWiring = null, editingRouteId = null, editingRoutePlatforms = null;
let gradeEnabled = false, gradePoints = [], gradeResult = null, gradePending = false, gradeError = '', gradeVersion = 0, gradeController = null;
const elevationLookup = new ElevationLookup();
let populationReady = false;
let plan = [], hover = null, routeStart = null, routeEnd = null, selectedRouteId = null;
let draftStrokes = [];
let curveMode = 'tangent', curveHandles = [];
let trackInteraction = 'draw', activeDraftIndex = null, selectedTrackId = null;
let activeTrackDraftId = newDraftId(), stationInteraction = 'place', activeStationDraftIndex = null;
let constructionCache = null;
let trackLedger = { paid: 0, construction: 0 }, trackHistoryKey = '', trackGesture = null;
const trackHistory = createEditorHistory();
let activeSlot = null, slots = [], savePage = 10, loading = true, dirty = false, saveErrorShown = false;
let currentMessage = '', messageTimer;
let inspectorCollapsed = false;
const panelScrollPositions = { build: 0, route: 0, save: 0, settings: 0 };
let existingNetwork = null;
const nameBuckets = new Map();
const automaticStationNames = new Map();
let namesReady = null;

try {
  const restored = readProgress(localStorage, KEYS, E.createGame, E.deserializeGame);
  game = restored.game; slots = restored.slots; activeSlot = restored.activeSlot;
  currentMessage = restored.warnings.join('\n');
} catch { currentMessage = 'ブラウザの保存機能を利用できません。ファイルへの書き出しをご利用ください。'; }
let clockControls = createClockControls(game.speed || 0);
game.stationDrafts ||= [];
restoreTrackDraft();
$('#game-speed').value = String(game.speed || 0);

for (const select of [$('#station-platform'), $('#route-cars')]) {
  for (let n = 1; n <= 20; n++) select.add(new Option(`${n}両`, String(n)));
}
$('#station-platform').value = String(platformCars);
for (const layout of E.STATION_LAYOUTS) $('#station-layout').add(new Option(layout.name, layout.id));
$('#station-layout').value = stationLayoutId;
restoreStationDraft();

const map = new RailwayMap($('#map-content'), {
  onClick: mapClick,
  onMove: mapMove,
  onPlanPoint: editPlanPoint,
  onCurveHandle: (index, handle, phase) => {
    if (phase === 'cancel') { cancelTrackGesture(); return; }
    if (tab !== 'build' || buildMode !== 'track' || curveMode !== 'point' || !plan[index] || isDialogOpen()) return;
    if (phase === 'start') { beginTrackGesture('接線を調整'); return; }
    if (!trackGesture) beginTrackGesture('接線を調整');
    curveHandles = plan.map((_, i) => i === index ? { lat: handle.lat, lng: handle.lng } : curveHandles[i] || null);
    hover = null; renderCost(); updateMap(); markDirty();
    if (phase === 'end') endTrackGesture();
  },
  onStationRotate: (bearing, anchor) => {
    if (tab !== 'build' || buildMode !== 'station' || stationPlacement !== 'free' || isDialogOpen()) return;
    hover = game.stationDraft?.kind === 'new' ? game.stationDraft.point : anchor;
    setStationBearing(bearing);
  },
  onRailwaysLoaded: data => {
    try {
      existingNetwork = new ExistingRailwayNetwork(data);
      constructionCache = null;
      E.setExistingNetwork(existingNetwork);
      map.setExistingNetwork(existingNetwork);
      $('#existing-network-status').textContent = '青い既存線路にも接続できます。既存の青い駅は「路線」で選べます。';
      updateMap();
    } catch (error) {
      console.warn('既存鉄道の接続データを準備できませんでした。', error);
      $('#existing-network-status').textContent = '既存線路の接続データを準備できませんでした。再読み込みしてください。';
    }
  },
  onRailwaysError: () => { $('#existing-network-status').textContent = '既存鉄道データを読み込めませんでした。再読み込みしてください。'; },
  onContextMenu: () => {
    if (gradeEnabled) return true;
    if (tab !== 'build' || buildMode !== 'track' || isDialogOpen()) return false;
    if (trackInteraction === 'draw' && plan.length) removePlanPoint(plan.length - 1);
    return true;
  },
  onViewChange: view => { game.view = view; if (!loading) markDirty(); },
});
map.setView(game.view);
map.setLayer(game.layer);
loading = false;

function message(text, type = 'success', temporary = true) {
  clearTimeout(messageTimer);
  currentMessage = text;
  const node = $('#message');
  node.textContent = text;
  node.className = type === 'success' ? '' : type;
  node.hidden = !text;
  if (temporary && text) messageTimer = setTimeout(() => { node.hidden = true; currentMessage = ''; }, 10000);
}

function markDirty() { dirty = true; constructionCache = null; $('#save-indicator').dataset.state = 'pending'; }
function newDraftId() { return `draft-${crypto.randomUUID()}`; }
function copyStationDraft(draft) { return draft ? JSON.parse(JSON.stringify(draft)) : null; }
function isDialogOpen() { return !!$('dialog[open]'); }
function ensureTrackHistory() {
  const key = trackNetworkKey(game);
  if (trackHistoryKey && key !== trackHistoryKey) { trackHistory.clear(); trackLedger = { paid: 0, construction: 0 }; }
  trackHistoryKey = key;
}
function captureTrackEdit() {
  return { active: copyStroke(activeStroke()), archives: draftStrokes.map(copyStroke), activeDraftIndex, trackInteraction, selectedTrackId,
    stationDraft: copyStationDraft(game.stationDraft), stationDrafts: (game.stationDrafts || []).map(copyStationDraft), stationInteraction, activeStationDraftIndex,
    ledger: { ...trackLedger }, network: captureTrackNetwork(game) };
}
function beforeTrackEdit() { ensureTrackHistory(); return captureTrackEdit(); }
function recordTrackEdit(before, label, networkChange = false) {
  if (!networkChange) {
    ensureTrackHistory();
    // A station name may finish loading during a drag. Draft edits must never
    // put that independent world change into the undo transaction.
    before.network = captureTrackNetwork(game); before.ledger = { ...trackLedger };
  }
  trackHistory.record(before, captureTrackEdit(), label); trackHistoryKey = trackNetworkKey(game); renderTrackEditor();
}
function restoreTrackEdit(snapshot) {
  for (const station of snapshot.network.stations) {
    const automatic = automaticStationNames.get(station.id);
    if (automatic && station.name === automatic.from) station.name = automatic.to;
  }
  const result = applyTrackNetwork(game, snapshot.network, {
    paidDelta: snapshot.ledger.paid - trackLedger.paid,
    constructionDelta: snapshot.ledger.construction - trackLedger.construction,
  });
  if (!result.ok) return result;
  const active = copyStroke(snapshot.active);
  plan = active.points; curveHandles = active.handles; trackType = active.type; curveMode = active.curveMode;
  activeTrackDraftId = active.id;
  game.stationDraft = copyStationDraft(snapshot.stationDraft); game.stationDrafts = (snapshot.stationDrafts || []).map(copyStationDraft);
  stationInteraction = snapshot.stationInteraction || 'place'; activeStationDraftIndex = snapshot.activeStationDraftIndex ?? null;
  if (game.stationDraft) { if (activeStationDraftIndex == null) delete game.stationDraft.orderIndex; else game.stationDraft.orderIndex = activeStationDraftIndex; }
  restoreStationDraft(); constructionCache = null;
  draftStrokes = snapshot.archives.map(copyStroke); activeDraftIndex = snapshot.activeDraftIndex;
  trackInteraction = snapshot.trackInteraction; selectedTrackId = snapshot.selectedTrackId; trackLedger = { ...snapshot.ledger };
  trackHistoryKey = trackNetworkKey(game); hover = null;
  if (!game.stations.some(s => s.id === routeStart)) routeStart = null;
  if (!game.stations.some(s => s.id === routeEnd)) routeEnd = null;
  if (!game.routes.some(r => r.id === selectedRouteId)) selectedRouteId = null;
  renderTrackTypeControls(); renderCost(); renderLists(); renderEndpoints(); renderHeader(); renderHint(); updateMap(); markDirty(); saveNow();
  return { ok: true };
}
function traverseTrackHistory(direction) {
  if (trackGesture || isDialogOpen()) return;
  ensureTrackHistory();
  const entry = trackHistory[direction]();
  if (!entry) { renderTrackEditor(); return; }
  const result = restoreTrackEdit(entry.snapshot);
  if (!result.ok) { trackHistory[direction === 'undo' ? 'redo' : 'undo'](); renderTrackEditor(); message(result.error, 'error'); return; }
  renderTrackEditor(); message(`${entry.label}：${direction === 'undo' ? '元に戻しました' : 'やり直しました'}。`, 'info');
}
function beginTrackGesture(label) { if (!trackGesture) trackGesture = { before: beforeTrackEdit(), label }; }
function endTrackGesture() {
  if (!trackGesture) return;
  const gesture = trackGesture; trackGesture = null; recordTrackEdit(gesture.before, gesture.label); saveNow();
}
function cancelTrackGesture() {
  if (!trackGesture) return;
  const gesture = trackGesture; trackGesture = null;
  ensureTrackHistory(); gesture.before.network = captureTrackNetwork(game); gesture.before.ledger = { ...trackLedger };
  restoreTrackEdit(gesture.before); renderTrackEditor();
}
function editPlanPoint(index, point, phase) {
  if (phase === 'cancel') { cancelTrackGesture(); return; }
  if (tab !== 'build' || buildMode !== 'track' || !plan[index] || isDialogOpen()) return;
  if (phase === 'start') { beginTrackGesture('計画点を移動'); return; }
  if (!trackGesture) beginTrackGesture('計画点を移動');
  const original = trackGesture.before.active, anchor = original.points[index];
  const moved = (index === 0 || index === plan.length - 1) && phase === 'end' ? snapMovedPoint(point, index) : point;
  plan[index] = { lat: moved.lat, lng: moved.lng };
  curveHandles = original.points.map((_, i) => original.handles[i] ? i === index ? { lat: original.handles[i].lat + moved.lat - anchor.lat, lng: original.handles[i].lng + moved.lng - anchor.lng } : { ...original.handles[i] } : null);
  hover = null; renderCost(); updateMap(); markDirty();
  if (phase === 'end') endTrackGesture();
}
function copyStroke(stroke) {
  return { id: stroke.id || newDraftId(), type: stroke.type, points: stroke.points.map(point => ({ lat: point.lat, lng: point.lng })),
    curveMode: stroke.curveMode || 'legacy', handles: stroke.points.map((_, i) => stroke.handles?.[i] ? { lat: stroke.handles[i].lat, lng: stroke.handles[i].lng } : null) };
}
function activeStroke() { return { id: activeTrackDraftId, type: trackType, points: plan, curveMode, handles: plan.map((_, i) => curveHandles[i] || null) }; }
function syncTrackDraft() {
  game.trackDrafts = draftStrokes.map(copyStroke);
  game.trackDraft = plan.length ? { ...copyStroke(activeStroke()), paused: false, ...(activeDraftIndex != null ? { orderIndex: activeDraftIndex } : {}) } : null;
}
function restoreTrackDraft() {
  const draft = game.trackDraft;
  plan = []; curveHandles = []; curveMode = 'tangent'; activeDraftIndex = null; trackInteraction = 'draw'; selectedTrackId = null;
  activeTrackDraftId = newDraftId();
  draftStrokes = (game.trackDrafts || []).map(copyStroke);
  if (draft?.points?.length) {
    const restored = copyStroke(draft);
    if (draftStrokes.length < 200 && draftStrokes.reduce((sum, stroke) => sum + stroke.points.length, 0) + restored.points.length <= 10000) draftStrokes.splice(draft.orderIndex ?? draftStrokes.length, 0, restored);
    else { plan = restored.points; curveHandles = restored.handles; curveMode = restored.curveMode; activeDraftIndex = draft.orderIndex ?? null; activeTrackDraftId = restored.id; }
    trackType = draft.type;
  }
  else if (draftStrokes.length) trackType = draftStrokes.at(-1).type;
  renderTrackTypeControls();
}
function renderTrackTypeControls() {
  for (const button of $$('[data-track]')) { const active = button.dataset.track === trackType; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  $('#track-instruction').textContent = trackType === 'scissors' ? '同じ既設複線上の2か所を選択して、対角の渡線を2本建設します。' : trackType === 'crossover' ? '接続する既設線路の上で、始点と終点を選択してください。' : '地図をクリックして計画線を描きます。既設の自作線路に接続して、延伸・分岐できます。';
  $('#track-instruction').textContent += ' 点の再クリックで取消、右クリックで1点戻る。Escで区間を区切り、次のクリックから別の線を描けます。端点に近づくと吸着します。';
  if (trackInteraction === 'edit') $('#track-instruction').textContent = '地図または一覧から下書きを選択し、点とハンドルをドラッグして編集します。自作の敷設済み線路も地図で選択できます。Deleteまたは削除ボタンで選択した区間を削除、Escで保存して新しく描きます。';
  const mainLine = ['single', 'double'].includes(trackType);
  $('#curve-controls').hidden = !mainLine;
  for (const button of $$('[data-curve]')) { const active = button.dataset.curve === curveMode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  $('#curve-instruction').textContent = curveMode === 'point' ? '置いた点を通る曲線。ハンドルで曲がり方を整えます。' : curveMode === 'tangent' ? '制御点の内側を通る曲線。中間の点で形を整えます。' : '保存済みの旧方式の下書きです。新しく描く線は接線モードになります。';
}
function archiveActiveDraft() {
  if (!plan.length) return true;
  if (draftStrokes.length >= 200 || draftStrokes.reduce((sum, stroke) => sum + stroke.points.length, 0) + plan.length > 10000) {
    message('下書きは200区間・合計10,000点までです。現在の線は残しています。先に敷設または取消をしてください。', 'info'); return false;
  }
  draftStrokes.splice(activeDraftIndex ?? draftStrokes.length, 0, copyStroke(activeStroke()));
  activeDraftIndex = null;
  plan = []; curveHandles = []; if (curveMode === 'legacy') curveMode = 'tangent'; hover = null;
  activeTrackDraftId = newDraftId(); constructionCache = null;
  return true;
}
function finishTrackDraft() {
  if (!plan.length) return;
  const before = beforeTrackEdit();
  if (!archiveActiveDraft()) return false;
  trackInteraction = 'draw'; selectedTrackId = null;
  renderTrackTypeControls();
  recordTrackEdit(before, '区間を下書きに保存');
  renderCost(); renderHint(); updateMap(); markDirty(); return saveNow();
}
function allTrackDrafts() {
  const strokes = [...draftStrokes];
  if (plan.length) strokes.splice(activeDraftIndex ?? strokes.length, 0, activeStroke());
  return strokes;
}
function selectDraft(index) {
  const selected = draftStrokes[index]; if (!selected) return;
  ensureTrackHistory();
  if (!archiveActiveDraft()) return;
  const position = draftStrokes.indexOf(selected), stroke = copyStroke(selected);
  draftStrokes.splice(position, 1); activeDraftIndex = position;
  plan = stroke.points; curveHandles = stroke.handles; trackType = stroke.type; curveMode = stroke.curveMode;
  activeTrackDraftId = stroke.id;
  trackInteraction = 'edit'; selectedTrackId = null; hover = null;
  renderTrackTypeControls(); renderCost(); renderHint(); updateMap(); markDirty(); saveNow();
}
function selectBuiltTrack(id) {
  ensureTrackHistory(); if (!archiveActiveDraft()) return;
  selectedTrackId = id; trackInteraction = 'edit'; hover = null;
  renderCost(); renderHint(); updateMap(); markDirty(); saveNow();
}
function renderTrackEditor() {
  for (const button of $$('[data-track-mode]')) { const active = button.dataset.trackMode === trackInteraction; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  $('#track-undo').disabled = !trackHistory.canUndo || !!trackGesture; $('#track-redo').disabled = !trackHistory.canRedo || !!trackGesture;
  $('#track-undo').title = `元に戻す（Ctrl+Z）${trackHistory.undoLabel ? `：${trackHistory.undoLabel}` : ''}`;
  $('#track-redo').title = `やり直す（Ctrl+Y / Ctrl+Shift+Z）${trackHistory.redoLabel ? `：${trackHistory.redoLabel}` : ''}`;
  $('#station-undo').disabled = $('#track-undo').disabled; $('#station-redo').disabled = $('#track-redo').disabled;
  $('#station-undo').title = $('#track-undo').title; $('#station-redo').title = $('#track-redo').title;
  const built = game.tracks.find(track => track.id === selectedTrackId);
  $('#track-selection').hidden = !built && !plan.length && trackInteraction !== 'edit';
  const typeName = { single: '単線', double: '複線', crossover: '渡線', scissors: '両渡線' };
  $('#track-selection-status').textContent = built ? `敷設済みの${typeName[built.type]} · ${(built.length / 1000).toFixed(3)} km` : plan.length ? `下書き${(activeDraftIndex ?? draftStrokes.length) + 1}を${trackInteraction === 'edit' ? '選択中' : '描画中'} · ${plan.length}点` : '線を選択して編集・削除できます';
  $('#track-delete').disabled = !built && !plan.length;
  $('#track-delete').textContent = built ? '選択した線路を削除' : 'この下書きを削除';
  const list = $('#track-draft-list'); list.replaceChildren();
  $('#track-draft-list-section').hidden = !allTrackDrafts().length;
  let number = 0;
  for (let i = 0; i <= draftStrokes.length; i++) {
    if (plan.length && i === (activeDraftIndex ?? draftStrokes.length)) {
      const activeButton = document.createElement('button'); activeButton.type = 'button'; activeButton.className = 'draft-select selected'; activeButton.setAttribute('aria-pressed', 'true');
      activeButton.textContent = `下書き${++number} · ${typeName[trackType]} · ${plan.length}点（選択中）`;
      activeButton.addEventListener('click', () => { trackInteraction = 'edit'; selectedTrackId = null; hover = null; renderCost(); renderHint(); updateMap(); }); list.append(activeButton);
    }
    const stroke = draftStrokes[i]; if (!stroke) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'draft-select'; button.setAttribute('aria-pressed', 'false');
    button.textContent = `下書き${++number} · ${typeName[stroke.type]} · ${stroke.points.length}点`; button.addEventListener('click', () => selectDraft(i)); list.append(button);
  }
}
async function deleteSelectedTrack() {
  if (isDialogOpen() || trackGesture) return;
  if (selectedTrackId) {
    const preview = E.previewDeleteTrack(game, selectedTrackId);
    if (!preview.ok) { message(preview.error, 'error'); return; }
    const effects = [preview.trackIds.length > 1 ? `関連する線路を含む${preview.trackIds.length}区間を削除します。` : '選択した線路を削除します。',
      preview.stationNames.length ? `駅：${preview.stationNames.join('、')}` : '', preview.routeNames.length ? `路線・ダイヤ：${preview.routeNames.join('、')}` : '', '建設費の払戻しはありません。この画面の「元に戻す」で復元できます。'].filter(Boolean).join('\n');
    if (!await ask({ title: '線路を削除', body: effects, confirm: '削除' })) return;
    const before = beforeTrackEdit(), result = E.deleteTrack(game, selectedTrackId);
    if (!result.ok) { message(result.error, 'error'); return; }
    selectedTrackId = null; recordTrackEdit(before, '線路を削除', true);
    if (!game.stations.some(s => s.id === routeStart)) routeStart = null;
    if (!game.stations.some(s => s.id === routeEnd)) routeEnd = null;
    if (!game.routes.some(r => r.id === selectedRouteId)) selectedRouteId = null;
    renderLists(); renderEndpoints(); renderHeader();
    message('選択した線路を削除しました。「元に戻す」で復元できます。', 'info');
  } else if (plan.length) {
    const before = beforeTrackEdit(); plan = []; curveHandles = []; activeDraftIndex = null; if (curveMode === 'legacy') curveMode = 'tangent';
    recordTrackEdit(before, '下書きを削除'); message('選択した下書きを削除しました。', 'info');
  } else return;
  hover = null; renderCost(); renderHint(); updateMap(); markDirty(); saveNow();
}
function stationOptions(point = null) {
  const hit = point && stationPlacement === 'track' ? stationPlacementHit(point) : null;
  return { layoutId: stationLayoutId, placement: stationPlacement, bearing: stationBearing,
    wiringMode: stationWiringMode, trackConfigs: stationTrackConfigs,
    ...(stationPlacement === 'track' && stationHostPlatformNumber != null ? { hostPlatformNumber: stationHostPlatformNumber } : {}),
    ...(hit?.track?.draftTrackId ? { draftTrackId: hit.track.draftTrackId } : hit && !hit.track.existing ? { ownedTrackId: hit.track.id } : {}),
    ...(hit?.track?.existing ? { existingTrackId: hit.track.id } : {}) };
}
function allStationDrafts() {
  const drafts = [...(game.stationDrafts || [])];
  if (game.stationDraft) drafts.splice(activeStationDraftIndex ?? drafts.length, 0, game.stationDraft);
  return drafts;
}
function archiveStationDraft() {
  if (!game.stationDraft) return;
  game.stationDrafts ||= [];
  const saved = copyStationDraft(game.stationDraft); delete saved.orderIndex;
  game.stationDrafts.splice(activeStationDraftIndex ?? game.stationDrafts.length, 0, saved);
  game.stationDraft = null; activeStationDraftIndex = null; constructionCache = null;
}
function constructionPreview() {
  const tracks = allTrackDrafts().filter(stroke => stroke.points.length >= 2), stations = allStationDrafts();
  const key = JSON.stringify([tracks, stations, game.money, game.unlimited]);
  if (constructionCache?.key === key && constructionCache.worldTracks === game.tracks && constructionCache.worldStations === game.stations) return constructionCache.result;
  const result = E.previewConstructionPlan(game, tracks, stations);
  constructionCache = { key, result, worldTracks: game.tracks, worldStations: game.stations };
  return result;
}
function planningState() {
  const preview = constructionPreview();
  return { ...game, unlimited: true, tracks: [...game.tracks, ...(preview.preparedTracks || [])], stations: [...game.stations, ...(preview.stations || [])] };
}
function selectStationDraft(index) {
  const selected = allStationDrafts()[index]; if (!selected) return;
  if (selected !== game.stationDraft) {
    const before = beforeTrackEdit(); archiveStationDraft();
    const position = game.stationDrafts.indexOf(selected); if (position < 0) return;
    game.stationDrafts.splice(position, 1); game.stationDraft = { ...selected, orderIndex: position }; activeStationDraftIndex = position;
    stationInteraction = 'edit'; restoreStationDraft(); recordTrackEdit(before, '駅の下書きを選択');
  } else stationInteraction = 'edit';
  hover = null; constructionCache = null; renderCost(); renderHint(); updateMap(); markDirty(); saveNow();
}
function removeStationDraft(index) {
  const drafts = allStationDrafts(), selected = drafts[index]; if (!selected) return;
  const before = beforeTrackEdit();
  if (selected === game.stationDraft) { game.stationDraft = null; activeStationDraftIndex = null; }
  else { game.stationDrafts.splice(game.stationDrafts.indexOf(selected), 1); if (activeStationDraftIndex != null && index < activeStationDraftIndex) activeStationDraftIndex--; }
  constructionCache = null; recordTrackEdit(before, '駅の下書きを削除'); renderCost(); renderHint(); updateMap(); markDirty(); saveNow();
}
function renderStationDraftList() {
  const drafts = allStationDrafts(), list = $('#station-draft-list'); list.replaceChildren();
  $('#station-draft-list-section').hidden = !drafts.length;
  for (const [index, draft] of drafts.entries()) {
    const row = document.createElement('div'); row.className = 'station-draft-row';
    const select = document.createElement('button'); select.type = 'button'; select.className = 'draft-select';
    const selected = draft === game.stationDraft && stationInteraction === 'edit'; select.classList.toggle('selected', selected); select.setAttribute('aria-pressed', String(selected));
    select.textContent = draft.kind === 'existing' ? `駅${index + 1} · 既設駅の利用登録` : `駅${index + 1} · ${E.getStationLayout(draft.options.layoutId).name} · ${draft.cars}両`;
    select.addEventListener('click', () => { selectStationDraft(index); map.focus(draft.point, Math.max(15, map.getView().zoom)); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '削除'; remove.className = 'mini-button'; remove.setAttribute('aria-label', `駅の下書き${index + 1}を削除`); remove.addEventListener('click', () => removeStationDraft(index));
    row.append(select, remove); list.append(row);
  }
  for (const button of $$('[data-station-mode]')) { const active = button.dataset.stationMode === stationInteraction; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
}
function restoreStationDraft() {
  const draft = game.stationDraft;
  if (draft) stationInteraction = 'edit';
  activeStationDraftIndex = Number.isInteger(draft?.orderIndex) ? draft.orderIndex : null;
  if (draft?.kind === 'new') {
    const options = draft.options;
    stationLayoutId = options.layoutId; stationPlacement = options.placement; stationBearing = options.bearing || 0;
    stationWiringMode = options.wiringMode || 'merged'; stationTrackConfigs = E.getStationTrackConfigs(options); platformCars = draft.cars;
    stationHostPlatformNumber = options.hostPlatformNumber ?? null;
  } else if (draft?.kind === 'existing') stationPlacement = 'track';
  $('#station-platform').value = String(platformCars); $('#station-layout').value = stationLayoutId; $('#station-bearing').value = String(stationBearing);
  renderStationOptions();
}
function syncStationDraftOptions() {
  const draft = game.stationDraft;
  if (draft?.kind !== 'new') return;
  const options = stationOptions(draft.point);
  // Keep the host chosen by the placement click, including during data loading.
  // A new placement click replaces this selection using the cursor position.
  if (options.placement === 'track' && draft.options.placement === 'track') {
    const key = ['existingTrackId', 'ownedTrackId', 'draftTrackId'].find(name => draft.options[name]);
    if (key) { delete options.existingTrackId; delete options.ownedTrackId; delete options.draftTrackId; options[key] = draft.options[key]; }
  }
  const next = { ...draft, cars: platformCars, options, ...(activeStationDraftIndex != null ? { orderIndex: activeStationDraftIndex } : {}) };
  if (activeStationDraftIndex == null) delete next.orderIndex;
  if (JSON.stringify(next) !== JSON.stringify(draft)) { game.stationDraft = next; markDirty(); }
}
function renderStationDraft(preview, source) {
  const draft = game.stationDraft;
  $('#station-draft').hidden = !draft;
  $('#station-draft-status').textContent = draft?.kind === 'existing' ? '既設駅の利用登録ドラフト（未確定）' : '駅のドラフト（未確定）';
  $('#station-confirm').textContent = 'まとめて敷設';
  $('#station-draft-description').textContent = draft?.kind === 'existing' ? `${source?.name || '既設駅'} · 計画の確定時に利用登録します。` : stationInteraction === 'edit' ? '地図をクリックして移動できます。構成・配線も確定するまで調整できます。' : '次のクリックで別の駅を追加します。選択・移動から個別に編集できます。';
}
function confirmConstructionPlan() {
  map.cancelEditGesture();
  syncStationDraftOptions();
  const before = beforeTrackEdit(), result = E.buildConstructionPlan(game, allTrackDrafts().filter(stroke => stroke.points.length >= 2), allStationDrafts());
  if (!result.ok) { message(result.error, 'error'); updateMap(); return; }
  trackLedger.paid += game.unlimited ? 0 : result.cost.total; trackLedger.construction += result.cost.total;
  const retainedActiveIndex = activeDraftIndex == null ? null : draftStrokes.slice(0, activeDraftIndex).filter(stroke => stroke.points.length < 2).length;
  draftStrokes = draftStrokes.filter(stroke => stroke.points.length < 2); if (plan.length >= 2) { plan = []; curveHandles = []; activeDraftIndex = null; activeTrackDraftId = newDraftId(); } else activeDraftIndex = retainedActiveIndex;
  game.stationDraft = null; game.stationDrafts = []; activeStationDraftIndex = null; stationInteraction = 'place'; hover = null; selectedTrackId = null; constructionCache = null;
  recordTrackEdit(before, '建設計画をまとめて敷設', true);
  renderHeader(); renderLists(); renderEndpoints(); renderHint(); updateMap(); markDirty(); saveNow();
  renderCost(); message(`線路${result.tracks.length}区間・駅${result.stations.length}駅をまとめて敷設しました。`);
  for (const station of result.stations) if (!station.existing) autoNameStation(station);
}
function discardConstructionPlan() {
  map.cancelEditGesture(); const before = beforeTrackEdit(); plan = []; curveHandles = []; draftStrokes = []; activeDraftIndex = null; selectedTrackId = null;
  game.stationDraft = null; game.stationDrafts = []; activeStationDraftIndex = null; stationInteraction = 'place'; hover = null; constructionCache = null;
  recordTrackEdit(before, '建設計画を破棄'); renderCost(); renderHint(); updateMap(); markDirty(); saveNow(); message('建設計画を破棄しました。元に戻すで復元できます。', 'info');
}
function setStationBearing(bearing) {
  const before = game.stationDraft && stationInteraction === 'edit' ? beforeTrackEdit() : null;
  stationBearing = ((Math.round(bearing / 5) * 5) % 180 + 180) % 180;
  $('#station-bearing').value = stationBearing;
  renderStationOptions(); updateMap();
  if (before) { syncStationDraftOptions(); recordTrackEdit(before, '駅の下書きの向きを変更'); markDirty(); saveNow(); }
}

function renderStationOptions() {
  const layout = E.getStationLayout(stationLayoutId);
  renderStationHostChoice();
  const diagram = $('#station-layout-diagram'); diagram.replaceChildren();
  diagram.setAttribute('aria-label', `${layout.name}の配線図`);
  let trackNumber = 0;
  for (const kind of layout.platformPattern) {
    const row = document.createElement('div'); row.className = kind === 'P' ? 'diagram-platform' : 'diagram-track';
    row.textContent = kind === 'P' ? 'ホーム' : `${++trackNumber}番線`;
    if (kind === 'T' && stationPlacement === 'track' && stationHostPlatformNumbers.includes(trackNumber)) { row.classList.add('diagram-host-track'); row.title = `${trackNumber}番線を既存線に合わせます`; }
    diagram.append(row);
  }
  $('#station-orientation').hidden = stationPlacement !== 'free';
  $('#station-wiring-options').hidden = false;
  $('#station-wiring-mode').value = stationWiringMode;
  $('#station-wiring-summary').textContent = stationWiringMode === 'platforms' ? '独立した接続口' : '両端で合流';
  stationTrackConfigs = E.getStationTrackConfigs({ layoutId: stationLayoutId, wiringMode: stationWiringMode, trackConfigs: stationTrackConfigs });
  renderWiringTable($('#station-track-configs'), stationLayoutId, stationBearing, stationWiringMode, stationTrackConfigs, configs => {
    stationTrackConfigs = configs; renderStationOptions(); renderCost(); updateMap();
  }, stationPlacement === 'track' ? stationHostPlatformNumbers : []);
  $('#station-bearing-value').textContent = `${stationBearing}°`;
  $('#station-instruction').textContent = stationPlacement === 'free' ? '地図上をクリックして駅のドラフトを配置し、「まとめて敷設」で建設します。番線の専用口・共通口へ外部線路を接続できます。' : '青い既存線路でも、すべての駅構成を選択できます。追加番線は独立した線路として配置します。必要な番線の接続口へ、ご自身で線路を敷設してください。「まとめて敷設」で建設します。';
  for (const button of $$('[data-station-placement]')) { const active = button.dataset.stationPlacement === stationPlacement; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
}
function renderStationHostChoice() {
  const count = E.getStationLayout(stationLayoutId).tracks, hostCount = Math.min(stationHostTrackCount, count);
  const select = $('#station-host-platform'); select.replaceChildren(new Option('自動（中央の番線）', ''));
  for (let number = 1; number <= count; number++) {
    const valid = number + hostCount - 1 <= count;
    const label = hostCount > 1 && valid ? `${number}・${number + 1}番線` : `${number}番線${valid ? '' : '（2線分の番線が不足）'}`;
    const option = new Option(label, String(number)); option.disabled = !valid; select.add(option);
  }
  select.value = stationHostPlatformNumber == null ? '' : String(stationHostPlatformNumber);
  $('#station-host-platform-field').hidden = stationPlacement !== 'track';
  $('#station-host-platform-help').textContent = hostCount > 1 ? '隣り合う2番線を既存線に重ねます。' : '選んだ番線を既存線に重ねます。';
}
function syncStationHostPlatforms(hit) {
  const hostTrackCount = hit?.track.type === 'double' ? 2 : 1, countChanged = stationHostTrackCount !== hostTrackCount;
  stationHostTrackCount = hostTrackCount;
  const count = E.getStationLayout(stationLayoutId).tracks, actualCount = Math.min(hostTrackCount, count);
  const valid = stationHostPlatformNumber == null || stationHostPlatformNumber + actualCount - 1 <= count;
  const numbers = stationPlacement === 'track' && valid ? E.stationGeometry({ lat: 0, lng: 0, cars: platformCars, layoutId: stationLayoutId, hostTrackCount: actualCount, ...(stationHostPlatformNumber != null ? { hostPlatformNumber: stationHostPlatformNumber } : {}) }).hostSlotIndices.map(index => index + 1).sort((a, b) => a - b) : [];
  const configs = E.getStationTrackConfigs({ layoutId: stationLayoutId, wiringMode: stationWiringMode, trackConfigs: stationTrackConfigs }).map((config, index) => stationWiringMode === 'platforms' && numbers.includes(index + 1) ? { a: 'independent', b: 'independent', direction: 'both' } : config);
  if (countChanged || JSON.stringify(numbers) !== JSON.stringify(stationHostPlatformNumbers) || JSON.stringify(configs) !== JSON.stringify(stationTrackConfigs)) {
    stationHostPlatformNumbers = numbers; stationTrackConfigs = configs; renderStationOptions();
  }
}

function renderWiringTable(container, layoutId, bearing, mode, configs, onChange, hostNumbers = []) {
  container.replaceChildren();
  const help = document.createElement('p'); help.className = 'instruction wiring-help';
  help.textContent = mode === 'platforms' ? '標準は各番線の専用口です。必要な接続は地図上で線路を敷設します。共通口を指定した番線だけ合流します。車止めも設定できます。' : '全番線が両端の共通口へ合流します。';
  if (hostNumbers.length) help.textContent += ` ${hostNumbers.join('・')}番線は元の線路を利用するため、接続と方向を保持します。`;
  container.append(help); if (mode !== 'platforms') return;
  const labels = E.stationEndLabels(bearing), table = document.createElement('table'); table.className = 'wiring-table';
  const head = table.createTHead().insertRow();
  for (const name of ['番線', '進行方向', `${labels.a}接続先`, `${labels.b}接続先`]) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = name; head.append(th); }
  const body = table.createTBody();
  for (let index = 0; index < E.getStationLayout(layoutId).tracks; index++) {
    const config = configs[index], row = body.insertRow(), number = row.insertCell(); number.textContent = String(index + 1);
    const choices = {
      direction: [['both','双方向'],['forward',`${labels.a} → ${labels.b}`],['reverse',`${labels.b} → ${labels.a}`]],
      a: [['independent','番線専用口'],['group1','共通口1'],['group2','共通口2'],['group3','共通口3'],['group4','共通口4'],['buffer','車止め（終着）']],
      b: [['independent','番線専用口'],['group1','共通口1'],['group2','共通口2'],['group3','共通口3'],['group4','共通口4'],['buffer','車止め（終着）']],
    };
    for (const key of ['direction','a','b']) {
      const select = document.createElement('select'); select.setAttribute('aria-label', `${index + 1}番線 ${key === 'direction' ? '進行方向' : `${key.toUpperCase()}側接続先`}`);
      for (const [value,label] of choices[key]) select.add(new Option(label,value)); select.value = config[key];
      select.disabled = hostNumbers.includes(index + 1) || key === 'direction' && (config.a === 'buffer' || config.b === 'buffer');
      select.addEventListener('change', () => {
        const next = configs.map(value => ({ ...value })); next[index][key] = select.value;
        if (key !== 'direction' && select.value === 'buffer') { next[index].direction = 'both'; const other = key === 'a' ? 'b' : 'a'; if (next[index][other] === 'buffer') next[index][other] = 'independent'; }
        onChange(next);
      }); row.insertCell().append(select);
    }
  }
  container.append(table);
}

function renderPlatformChoices(container, assignments, stationIds = null) {
  container.replaceChildren();
  for (const direction of ['forward','backward']) for (const id of Object.keys(assignments[direction])) if (!game.stations.some(station => station.id === id)) delete assignments[direction][id];
  const stations = game.stations.filter(station => !stationIds || stationIds.includes(station.id));
  if (!stations.length) { container.append(empty('まだ使用する駅がありません。')); return; }
  const table = document.createElement('table'); table.className = 'platform-choice-table';
  const head = table.createTHead().insertRow();
  for (const name of ['駅', '往路', '復路']) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = name; head.append(th); }
  const body = table.createTBody();
  for (const station of stations) {
    const row = body.insertRow(); row.insertCell().textContent = station.name;
    for (const direction of ['forward','backward']) {
      const select = document.createElement('select'); select.setAttribute('aria-label', `${station.name} ${direction === 'forward' ? '往路' : '復路'}の番線`); select.add(new Option('自動',''));
      for (const platform of E.getStationPlatforms(game, station)) select.add(new Option(`${platform.number}番線`, String(platform.number)));
      select.value = String(assignments[direction]?.[station.id] || '');
      select.addEventListener('change', () => { if (select.value) assignments[direction][station.id] = Number(select.value); else delete assignments[direction][station.id]; });
      row.insertCell().append(select);
    }
  }
  container.append(table);
}

function openStationWiring(station) {
  editingStationId = station.id; editingStationWiring = { wiringMode: station.wiringMode || 'merged', trackConfigs: E.getStationTrackConfigs(station) };
  $('#station-wiring-title').textContent = `${station.name}の番線・配線`; $('#edit-wiring-mode').value = editingStationWiring.wiringMode;
  $('#station-wiring-error').hidden = true; renderEditingWiring(); $('#station-wiring-dialog').showModal();
}
function renderEditingWiring() {
  const station = game.stations.find(value => value.id === editingStationId); if (!station) return;
  const hosts = station.standalone ? [] : E.stationGeometry(station).hostSlotIndices.map(index => index + 1);
  renderWiringTable($('#edit-track-configs'), station.layoutId, station.bearing, editingStationWiring.wiringMode, editingStationWiring.trackConfigs, configs => { editingStationWiring.trackConfigs = configs; renderEditingWiring(); }, hosts);
}
function openRoutePlatforms(route) {
  editingRouteId = route.id; editingRoutePlatforms = { forward: { ...route.platformAssignments?.forward }, backward: { ...route.platformAssignments?.backward } };
  $('#route-platform-title').textContent = `${route.name}の使用番線`; $('#route-platform-error').hidden = true;
  renderPlatformChoices($('#edit-route-platforms'), editingRoutePlatforms, route.stationIds); $('#route-platform-dialog').showModal();
}

function renderStationCost(preview = null) {
  const cost = preview?.costBreakdown || E.stationCostBreakdown(platformCars, stationOptions());
  $('#platform-metres').textContent = platformCars * 20;
  $('#platform-cars').textContent = platformCars;
  $('#station-base-cost').textContent = money(cost.base);
  $('#platform-cost').textContent = money(cost.platforms);
  $('#station-track-cost').textContent = money(cost.tracks);
  $('#station-total').textContent = money(cost.total);
  renderConstructionCost();
}

function renderConstructionCost() {
  const tracks = allTrackDrafts(), stations = allStationDrafts(), hasPlan = tracks.some(track => track.points.length >= 2) || !!stations.length;
  const preview = constructionPreview();
  $('#commit-label').textContent = '計画全体の建設費';
  $('#commit-cost').textContent = preview.geometryOk === false ? '—' : money(preview.cost?.total || 0);
  $('#track-build').disabled = $('#station-confirm').disabled = !hasPlan || !preview.ok;
  $('#track-cancel').disabled = $('#station-draft-cancel').disabled = !tracks.length && !stations.length;
  $('#track-build').textContent = $('#station-confirm').textContent = 'まとめて敷設';
  $('#track-cancel').textContent = $('#station-draft-cancel').textContent = '計画を破棄';
  $('#commit-status').textContent = tracks.length || stations.length ? `線路${tracks.length}区間・駅${stations.length}駅` : '線路・駅を仮置き';
  $('#commit-status').classList.toggle('has-draft', !!tracks.length || !!stations.length);
  $('#construction-overview').hidden = !tracks.length && !stations.length;
  $('#construction-overview').textContent = `建設計画 · 線路${tracks.length}区間 / 駅${stations.length}駅`;
  $('#construction-error').hidden = !hasPlan || preview.ok;
  $('#construction-error').textContent = preview.error || '';
  renderStationDraftList();
}

function saveNow() {
  try {
    game.view = map.getView();
    syncTrackDraft();
    syncStationDraftOptions();
    const data = E.serializeGame(game);
    localStorage.setItem(KEYS.current, data);
    if (game.unlimited) localStorage.setItem(KEYS.unlimited, '1');
    const slot = slots.find(s => s.id === activeSlot);
    if (slot) {
      slot.data = data;
      slot.updatedAt = Date.now();
      localStorage.setItem(KEYS.slots, JSON.stringify(slots));
    }
    if (activeSlot) localStorage.setItem(KEYS.active, activeSlot);
    else localStorage.removeItem(KEYS.active);
    dirty = false;
    saveErrorShown = false;
    $('#autosave-state').textContent = `自動保存済み · ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
    $('#save-indicator').textContent = '保存済み'; $('#save-indicator').dataset.state = 'saved';
    $('#save-indicator').title = $('#autosave-state').textContent;
    return true;
  } catch {
    $('#autosave-state').textContent = '保存できません。ファイルに書き出してください。';
    $('#save-indicator').textContent = '保存に失敗'; $('#save-indicator').dataset.state = 'error';
    if (!saveErrorShown) message('ブラウザの保存容量が不足しているか、保存が許可されていません。セーブからファイルに書き出せます。', 'error', false);
    saveErrorShown = true;
    return false;
  }
}

function saveSlots() {
  try { localStorage.setItem(KEYS.slots, JSON.stringify(slots)); return true; }
  catch { message('保存容量が不足しています。不要な保存枠を整理するか、ファイルに書き出してください。', 'error', false); return false; }
}

function money(value) { return E.formatMoney(value); }

function renderHeader() {
  $('#money').textContent = game.unlimited ? '¥ ∞' : money(game.money);
  $('#money').classList.toggle('negative', !game.unlimited && game.money < 0);
  $('#unlimited-badge').hidden = !game.unlimited;
  $('#game-time').textContent = E.formatDate(game.time);
  $('#settings-unlimited').checked = game.unlimited;
  $('#settings-unlimited').disabled = game.unlimited;
  renderClockControls();
}

function renderClockControls() {
  const state = clockControls.getState(), pause = $('#clock-pause');
  pause.classList.toggle('playing', !state.paused);
  pause.setAttribute('aria-label', state.paused ? '運行を再開' : '運行を一時停止');
  $('#clock-state-label').textContent = state.paused ? '再開' : '停止';
  for (const button of $$('[data-speed]')) { const active = Number(button.dataset.speed) === state.activePreset; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  if (document.activeElement !== $('#game-speed')) $('#game-speed').value = String(state.speed);
  $('#clock-custom summary').textContent = state.activePreset == null ? `${state.lastRunningSpeed}×` : '速度';
}

function setPanelOpen(open) {
  inspectorCollapsed = !open; $('#world').classList.toggle('inspector-collapsed', inspectorCollapsed);
  $('#controls-pane').inert = inspectorCollapsed;
  $('#panel-toggle').setAttribute('aria-expanded', String(open));
  $('#panel-toggle').title = open ? '操作パネルを隠す' : '操作パネルを表示';
}

function renderWorkbench() {
  const track = buildMode === 'track', editing = track && trackInteraction === 'edit';
  const headings = { build: track ? editing ? '線路を選択・編集' : '線路を敷く' : '駅を配置する', route: '路線とダイヤ', save: 'セーブと読込', settings: '設定・操作ガイド' };
  const descriptions = { build: track ? editing ? '下書きの点を動かす・選んだ区間を削除する' : '地図に描き、形を整えてから建設します' : '構成を選び、地図に仮配置してから建設します', route: '地図で起点と終点を選んでください', save: '現在のプレイと名前付きの保存枠', settings: 'プレイ環境とキー操作' };
  $('#workbench-section').textContent = tab === 'build' ? `敷設 / ${track ? '線路' : '駅'}` : { route: '運行', save: 'データ', settings: '環境' }[tab];
  $('#workbench-heading').textContent = headings[tab]; $('#workbench-description').textContent = descriptions[tab];
  $('#build-commit-bar').hidden = tab !== 'build' || gradeEnabled;
  $('#track-commit-controls').hidden = !track; $('#station-commit-controls').hidden = track;
  const drafts = allStationDrafts();
  $('#workbench-description').textContent = tab === 'build' ? track ? '線路と駅を下書きに置き、まとめて建設します' : stationInteraction === 'edit' ? '下書きを選び、位置・構成・配線を調整します' : 'クリックで駅を追加。線路と一緒に確定できます' : descriptions[tab];
}

function planGeometry(points = plan) {
  if (typeof E.planTrackPoints === 'function') {
    return E.planTrackPoints(points, trackType, game, { curveMode, handles: points.map((_, i) => curveHandles[i] || null) });
  }
  return { ok: true, points };
}
function draftGeometries(strokes) {
  return strokes.some(stroke => ['crossover', 'scissors'].includes(stroke.type)) ? E.planTrackDraftGeometries(game, strokes) : strokes.map(stroke => E.planTrackPoints(stroke.points, stroke.type, game, stroke));
}

function updateMap() {
  const mode = gradeEnabled ? 'measure' : tab === 'build' ? buildMode === 'track' && trackInteraction === 'edit' ? 'track-edit' : buildMode : tab === 'route' ? 'route' : 'pan';
  const strokes = allTrackDrafts(), geometries = draftGeometries(strokes), activePosition = plan.length ? activeDraftIndex ?? draftStrokes.length : -1;
  const planned = activePosition >= 0 ? geometries[activePosition] : planGeometry();
  const draftSnap = mode === 'track' && hover ? map.nearestDraftEndpoint(hover, 14) : null;
  const removable = mode === 'track' && hover ? map.nearestPlanPoint(hover) || (draftSnap?.active ? { index: plan.length - 1 } : null) : null;
  const archivedPlans = draftStrokes.map((stroke, index) => {
    const geometry = geometries[index + (activePosition >= 0 && index >= activePosition ? 1 : 0)];
    return { type: stroke.type, points: geometry.ok ? geometry.points : stroke.points, controlPoints: stroke.points, curveMode: stroke.curveMode, invalid: !geometry.ok };
  });
  let previewPoints = null, previewControlPoints = null, previewCurveHandles = null, previewMetrics = null, previewInvalid = !planned.ok, stationPreviewInvalid = false;
  if (mode === 'track' && plan.length && hover && !removable && E.distance(hover, plan.at(-1)) >= 2) {
    const last = plan.length >= 2 ? nearestBuildConnection(plan.at(-1)) : null;
    const finished = (['crossover', 'scissors'].includes(trackType) && plan.length >= 2) || (last && last.distance < 1);
    if (!finished) {
      const candidate = [...plan, snapPoint(hover)];
      const candidateStrokes = [...strokes]; candidateStrokes[activePosition] = { ...activeStroke(), points: candidate, handles: candidate.map((_, i) => curveHandles[i] || null) };
      const geometry = draftGeometries(candidateStrokes)[activePosition];
      previewPoints = geometry?.ok ? geometry.points : candidate;
      previewControlPoints = candidate;
      previewCurveHandles = geometry?.tangentHandles || null;
      previewMetrics = { length: E.lineLength(previewPoints), minRadius: geometry?.minRadius ?? Infinity };
      previewInvalid = geometry ? !geometry.ok : false;
    }
  }
  if (mode === 'station' && stationInteraction === 'edit' && game.stationDraft?.kind === 'new') {
    const options = game.stationDraft.options;
    syncStationHostPlatforms(options.placement === 'track' ? stationPlacementHit(game.stationDraft.point, options.existingTrackId, options.ownedTrackId, options.draftTrackId) : null);
  }
  syncStationDraftOptions();
  const stationDrafts = allStationDrafts(), construction = constructionPreview();
  const stationDraftPreviews = stationDrafts.map((draft, index) => ({ ...(construction.stationPreviews?.[index] || {}), point: draft.point, draft, draftIndex: index, selected: draft === game.stationDraft && stationInteraction === 'edit' }));
  let stationPreview = null, stationSource = null, stationHostConnection = null;
  if (mode === 'station') {
    const draft = game.stationDraft, editing = stationInteraction === 'edit';
    const anchor = editing ? draft?.point : hover;
    const selectedPreview = draft ? construction.stationPreviews?.[stationDrafts.indexOf(draft)] : null;
    stationSource = editing && draft?.kind === 'existing' ? existingNetwork?.getStation(draft.sourceStationId) : !editing && hover && stationPlacement === 'track' ? existingStationAt(hover) : null;
    if (editing) stationPreview = selectedPreview?.preview || null;
    else if (anchor && !stationSource) {
      const options = stationOptions(anchor);
      const hit = options.placement === 'track' ? stationPlacementHit(anchor, options.existingTrackId, options.ownedTrackId, options.draftTrackId) : null;
      syncStationHostPlatforms(hit);
      Object.assign(options, { wiringMode: stationWiringMode, trackConfigs: stationTrackConfigs });
      if (hit?.track?.existing) stationHostConnection = hit;
      const resolved = { ...options }; if (hit?.track.draftTrackId) { delete resolved.draftTrackId; resolved.ownedTrackId = hit.track.id; }
      stationPreview = options.placement === 'track' && !hit ? { ok: false, error: '下書きの線路・自作線路・青い既存線路の近くを選択してください。' } : E.previewStation(planningState(), hit?.point || anchor, platformCars, resolved);
      stationPreviewInvalid = !stationPreview.ok;
    }
    const existingPreview = !!stationSource;
    $('#station-wiring-options').hidden = existingPreview;
    $('#station-host-platform-field').hidden = stationPlacement !== 'track' || existingPreview;
    $('#station-cost-preview').hidden = existingPreview;
    $('#existing-station-preview').hidden = !existingPreview;
    $('#existing-station-preview-name').textContent = stationSource?.name || '既設駅の情報を読み込んでいます…';
    $('#station-preview-error').hidden = !anchor || existingPreview || stationPreview?.ok !== false;
    $('#station-preview-error').textContent = stationPreview?.error || '';
    renderStationCost(stationPreview || selectedPreview?.preview);
    renderStationDraft(stationPreview, stationSource);
    $('#station-host-status').hidden = stationPlacement !== 'track' || existingPreview || !stationPreview?.track;
    $('#station-host-status').textContent = stationPreview?.track && stationHostPlatformNumbers.length ? `${E.getStationLayout(stationLayoutId).name} · ${stationHostPlatformNumbers.join('・')}番線で元の線路を利用${stationWiringMode === 'platforms' ? '／追加番線は独立' : '／追加番線は両端で合流'}` : '線路へカーソルを近づけると、設置位置と駅のプレビューを表示します。';
  }
  const stationPort = mode === 'track' && hover && !removable && ['single', 'double'].includes(trackType) ? map.nearestStationConnection(hover, 12) : null;
  const stationPortConnection = stationPort && !stationPort.existingHost && (!draftSnap || stationPort.screenDistance < draftSnap.screenDistance) ? stationPort : null;
  const blueConnection = mode === 'track' && hover && !removable && !(stationPort && !stationPort.existingHost) && ['single', 'double'].includes(trackType) ? map.nearestExistingTrack(hover) : null;
  map.setState(game, { plan: planned.ok ? planned.points : plan, controlPoints: plan, curveMode, curveHandles: planned.tangentHandles || curveHandles, curveGuides: $('#curve-guides').checked, draftStrokes: archivedPlans, draftSnap, previewPoints, previewControlPoints, previewCurveHandles, previewMetrics, previewInvalid, removePointIndex: removable?.index ?? -1, stationDraftPreviews, stationPreviewInvalid, stationPreview: stationInteraction === 'place' ? stationPreview : null, stationLayoutId, stationPlacement, stationBearing, stationWiringMode, stationTrackConfigs, existingConnection: blueConnection, stationPortConnection, stationHostConnection, populationVisible: !!game.populationVisible, measureEnabled: gradeEnabled, measurePoints: gradePoints, hover: ['track', 'track-edit'].includes(mode) || gradeEnabled || stationInteraction === 'edit' || stationSource ? null : hover, mode, trackType, platformCars, selectedTrackId, selectedStationIds: [routeStart, routeEnd].filter(Boolean), selectedRouteId });
}

function renderCost() {
  syncStationDraftOptions();
  renderTrackTypeControls();
  const strokes = allTrackDrafts(), eligible = strokes.filter(stroke => stroke.points.length >= 2);
  const preview = eligible.length ? E.previewTrackDrafts(game, eligible) : { ok: true, cost: { trackCost: 0, landCost: 0, total: 0, length: 0 } };
  const error = preview.error || '', total = preview.cost || { trackCost: 0, landCost: 0, total: 0, length: 0 };
  $('#track-construction').textContent = error ? '—' : money(total.trackCost);
  $('#track-land').textContent = error ? '—' : money(total.landCost);
  $('#track-total').textContent = error ? '—' : money(total.total);
  if (tab === 'build' && buildMode === 'track') { $('#commit-label').textContent = '確定時の建設費'; $('#commit-cost').textContent = error ? '—' : money(total.total); }
  $('#track-build').disabled = !eligible.length || !preview.ok;
  $('#track-cancel').disabled = !strokes.length;
  $('#track-cancel').textContent = strokes.length > 1 ? 'すべて破棄' : '破棄';
  $('#plan-meta').hidden = !strokes.length;
  const summary = `${strokes.length}区間 · ${strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)}点 · ${(total.length / 1000).toFixed(3)} km`;
  $('#plan-meta').textContent = error ? `${summary} · ${error}` : `${summary}${!game.unlimited && total.total > game.money ? ' · 所持金が不足しています' : ''}`;
  $('#track-draft').hidden = !strokes.length;
  $('#track-draft-status').textContent = draftStrokes.length ? `${draftStrokes.length}区間を下書きに保存${plan.length ? ` · ${plan.length}点を描画中` : ''}` : `${plan.length}点の線路を下書き中`;
  if (trackInteraction === 'edit' && plan.length) $('#track-draft-status').textContent = `下書き${(activeDraftIndex ?? draftStrokes.length) + 1}を編集中（${plan.length}点） · Escで保存して新しく描く`;
  renderTrackEditor();
  renderWorkbench();
  renderStationCost();
}

function renderEndpoints() {
  for (const [selector, id] of [['#route-start', routeStart], ['#route-end', routeEnd]]) {
    const station = game.stations.find(s => s.id === id);
    $(`${selector} strong`).textContent = station?.name || '未選択';
    $(selector).classList.toggle('selected', !!station);
  }
  renderPlatformChoices($('#route-platform-options'), routePlatformAssignments);
}

function renderLists() {
  $('#station-count').textContent = game.stations.length || '';
  const stationList = $('#station-list');
  stationList.replaceChildren();
  if (!game.stations.length) stationList.append(empty('まだ駅はありません。'));
  for (const station of game.stations) {
    const row = document.createElement('div');
    row.className = 'station-row'; row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', `${station.name}を地図に表示`);
    const info = document.createElement('div'); info.className = 'station-info';
    const input = document.createElement('input'); input.className = 'station-name'; input.value = station.name; input.maxLength = 48; input.setAttribute('aria-label', '駅名'); input.title = '駅名を編集';
    if (station.existing) { input.readOnly = true; input.title = '既設駅'; }
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('input', () => { if (input.value.trim()) { E.renameStation(game, station.id, input.value); station.userRenamed = true; updateMap(); markDirty(); } });
    input.addEventListener('change', () => { if (!input.value.trim()) input.value = station.name; renderEndpoints(); markDirty(); saveNow(); });
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { input.blur(); saveNow(); } });
    const cap = document.createElement('span'); cap.className = 'station-capacity';
    const hostPlatforms = !station.existing && !station.standalone ? E.getStationHostPlatformNumbers(station).sort((a, b) => a - b) : [];
    cap.textContent = [station.existing ? '既設駅' : E.getStationLayout(station.layoutId).name, `${station.cars}両対応`, station.existingTrack ? '青い既存線路上の新駅' : '', hostPlatforms.length ? `${hostPlatforms.join('・')}番線で元の線路を利用` : '', station.existing ? '' : station.wiringMode === 'platforms' ? '番線別の配線' : '両端で合流'].filter(Boolean).join(' · ');
    const actions = document.createElement('div'); actions.className = 'row-actions';
    if (!station.existing) {
      const wiring = document.createElement('button'); wiring.className = 'mini-button'; wiring.textContent = '番線・配線'; wiring.setAttribute('aria-label', `${station.name}の番線・配線を編集`);
      wiring.addEventListener('click', event => { event.stopPropagation(); openStationWiring(station); }); actions.append(wiring);
    }
    const del = document.createElement('button'); del.className = 'mini-button'; del.textContent = station.existing ? '利用解除' : '削除'; del.setAttribute('aria-label', `${station.name}を${station.existing ? '利用解除' : '削除'}`);
    del.addEventListener('click', async e => {
      e.stopPropagation();
      const accepted = await ask(station.existing ? { title: '既設駅の利用を解除', body: `「${station.name}」を利用駅から外します。この駅を起点・終点にする路線も削除されます。青い駅と既存線路は地図に残ります。`, confirm: '利用解除' } : { title: '駅を削除', body: `「${station.name}」と駅専用の構内線路を削除します。関係する路線も削除されます。駅の外へ敷いた線路は残ります。建設費の払戻しはありません。`, confirm: '削除' });
      if (!accepted) return;
      E.deleteStation(game, station.id);
      delete routePlatformAssignments.forward[station.id]; delete routePlatformAssignments.backward[station.id];
      if (routeStart === station.id) routeStart = null;
      if (routeEnd === station.id) routeEnd = null;
      renderLists(); renderEndpoints(); updateMap(); markDirty(); saveNow(); message(station.existing ? '既設駅の利用を解除しました。' : '駅を削除しました。');
    });
    const focus = () => map.focus(station, 14);
    row.addEventListener('click', focus);
    row.addEventListener('keydown', e => { if (e.target !== row) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focus(); } });
    info.append(input, cap); actions.append(del); row.append(info, actions); stationList.append(row);
  }
  $('#route-count').textContent = game.routes.length || '';
  const routeList = $('#route-list'); routeList.replaceChildren();
  if (!game.routes.length) routeList.append(empty('まだ路線はありません。'));
  for (const route of game.routes) {
    const row = document.createElement('div'); row.className = 'route-row' + (route.id === selectedRouteId ? ' selected' : ''); row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', `${route.name}を地図に表示`);
    const color = document.createElement('span'); color.className = 'route-color'; color.style.backgroundColor = route.color || '#32936c';
    const info = document.createElement('div'); info.className = 'route-info';
    const name = document.createElement('strong'); name.className = 'route-name'; name.textContent = route.name;
    const meta = document.createElement('div'); meta.className = 'route-meta'; meta.textContent = `${Number(route.oneWayMinutes || 0).toFixed(1)}分 / ${Number(route.intervalMinutes || 0).toFixed(1)}分間隔 / ${route.cars}両 × ${route.fleet}編成`;
    const assignments = route.platformAssignments || {}, selections = [];
    for (const [direction,label] of [['forward','往路'],['backward','復路']]) for (const [id,number] of Object.entries(assignments[direction] || {})) {
      const station = game.stations.find(value => value.id === id); if (station) selections.push(`${label} ${station.name}${number}番線`);
    }
    const platformMeta = document.createElement('div'); platformMeta.className = 'route-meta platform-meta'; platformMeta.textContent = selections.join(' / ') || '使用番線：自動';
    const actions = document.createElement('div'); actions.className = 'row-actions';
    const platformButton = document.createElement('button'); platformButton.className = 'mini-button'; platformButton.textContent = '使用番線'; platformButton.setAttribute('aria-label', `${route.name}の使用番線を編集`);
    platformButton.addEventListener('click', event => { event.stopPropagation(); openRoutePlatforms(route); }); actions.append(platformButton);
    const del = document.createElement('button'); del.className = 'mini-button'; del.textContent = '削除'; del.setAttribute('aria-label', `${route.name}を削除`);
    del.addEventListener('click', async e => { e.stopPropagation(); if (!(await ask({ title: '路線を削除', body: `「${route.name}」の路線・ダイヤを削除します。線路と駅は残ります。`, confirm: '削除' }))) return; E.deleteRoute(game, route.id); if (selectedRouteId === route.id) selectedRouteId = null; renderLists(); updateMap(); markDirty(); saveNow(); message('路線を削除しました。'); });
    const focus = () => { selectedRouteId = route.id; map.fitPoints(route.points || [], 60); updateMap(); renderLists(); };
    row.addEventListener('click', focus); row.addEventListener('keydown', e => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); focus(); } });
    info.append(name, meta, platformMeta); actions.append(del); row.append(color, info, actions); routeList.append(row);
  }
}

function empty(text) { const node = document.createElement('div'); node.className = 'empty-state'; node.textContent = text; return node; }

function renderSaves() {
  const current = slots.find(slot => slot.id === activeSlot);
  $('#current-save-target').textContent = current ? `自動保存先：${current.name}` : '自動保存先：現在のプレイ（このブラウザ）';
  const list = $('#save-list'); list.replaceChildren();
  if (!slots.length) list.append(empty('まだ名前付きセーブはありません。'));
  for (const slot of [...slots].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, savePage)) {
    const row = document.createElement('div'); row.className = 'save-row';
    const titleLine = document.createElement('div'); titleLine.className = 'save-title-line'; titleLine.tabIndex = 0; titleLine.setAttribute('role', 'button'); titleLine.setAttribute('aria-label', `${slot.name}を読み込む`);
    const title = document.createElement('strong'); title.className = 'save-title'; title.textContent = slot.name;
    titleLine.append(title);
    if (slot.id === activeSlot) { const badge = document.createElement('span'); badge.className = 'save-current'; badge.textContent = '現在プレイ中'; titleLine.append(badge); }
    const date = document.createElement('div'); date.className = 'save-date'; date.textContent = `更新 ${new Date(slot.updatedAt).toLocaleString('ja-JP')}`;
    const buttons = document.createElement('div'); buttons.className = 'save-buttons';
    const load = async () => {
      if (!(await ask({ title: 'セーブを読み込む', body: `「${slot.name}」を読み込みます。現在のプレイ内容を置き換え、この保存枠を自動更新の対象にします。`, confirm: '読み込む' }))) return;
      try { saveNow(); applyGame(E.deserializeGame(slot.data), slot.id); message(`「${slot.name}」を読み込みました。`); } catch { message('このセーブは読み込めませんでした。', 'error'); }
    };
    titleLine.addEventListener('click', load); titleLine.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); load(); } });
    for (const [label, action] of [
      ['読込', load],
      ['名前変更', async () => { const name = await ask({ title: 'セーブ名を変更', body: '新しい名前を入力してください。', value: slot.name, confirm: '変更' }); if (typeof name === 'string' && name.trim()) { slot.name = name.trim().slice(0, 60); saveSlots(); renderSaves(); } }],
      ['共有', () => shareSave(slot)],
      ['削除', async () => { if (!(await ask({ title: '保存枠を削除', body: `「${slot.name}」の保存枠を削除します。現在のプレイと、すでに作成した共有コピーは残ります。`, confirm: '削除' }))) return; slots = slots.filter(s => s.id !== slot.id); if (activeSlot === slot.id) activeSlot = null; saveSlots(); markDirty(); saveNow(); renderSaves(); }],
    ]) { const button = document.createElement('button'); button.className = 'mini-button'; button.textContent = label; button.addEventListener('click', action); buttons.append(button); }
    row.append(titleLine, date, buttons); list.append(row);
  }
  $('#save-more').hidden = slots.length <= savePage;
}

function setTab(value) {
  panelScrollPositions[tab] = $('#panel-scroll').scrollTop;
  setPanelOpen(true);
  map.cancelEditGesture();
  if (gradeEnabled) setGradeEnabled(false);
  if (value !== 'build' && plan.length) finishTrackDraft();
  tab = value; hover = null; message('');
  for (const button of $$('[data-tab]')) { const active = button.dataset.tab === value; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  for (const name of ['build', 'route', 'save', 'settings']) $(`#panel-${name}`).hidden = name !== value;
  if (tab === 'save') renderSaves();
  renderCost(); renderHint(); updateMap();
  $('#panel-scroll').scrollTop = panelScrollPositions[value] || 0;
}

function renderHint() {
  renderWorkbench();
  if (gradeEnabled) { $('#map-hint').textContent = gradePoints.length === 1 ? '勾配測定：終点Bをクリック' : '勾配測定：始点A・終点Bをクリック · もう一度クリックで新しい測定'; return; }
  if (tab === 'build' && buildMode === 'track' && trackInteraction === 'edit') { $('#map-hint').textContent = '下書き・自作線路をクリックして選択 · 点とハンドルをドラッグ · Deleteで区間を削除 · Escで新しく描く'; return; }
  if (tab === 'build' && buildMode === 'track' && !plan.length && draftStrokes.length) { $('#map-hint').textContent = '下書きを保持中 · クリックで新しい線を開始 · 端点に近づくと吸着 · 敷設でまとめて確定'; return; }
  if (tab === 'build' && buildMode === 'station') { $('#map-hint').textContent = stationInteraction === 'edit' ? '駅の下書きを選択 · 地図をクリックして移動 · Escで追加に戻る' : 'クリックで駅を追加 · 下書きの線路にも配置可能 · 最後にまとめて敷設'; return; }
  const hints = { build: buildMode === 'station' ? (stationPlacement === 'free' ? 'クリックで駅のドラフトを配置 · 「まとめて敷設」で建設' : '自作線路・青い線で新駅のドラフト / 青い駅で利用登録のドラフト') : trackType === 'scissors' ? '同じ複線上の2か所を選択して両渡線を建設' : trackType === 'crossover' ? '接続したい自作線路の2点を選択' : 'クリックで計画線を描画 · 青い既存線路にも接続できます', route: !routeStart ? '自作駅や青い既設駅をクリックして起点を選択' : !routeEnd ? '終点となる駅をクリック' : '編成と運行時刻を設定して路線を作成', save: 'ドラッグで移動 · ホイールで拡大縮小', settings: 'ドラッグで移動 · ホイールで拡大縮小' };
  $('#map-hint').textContent = tab === 'build' && buildMode === 'track' && ['single', 'double'].includes(trackType) ? 'クリックで点を置く · 右クリックで1点戻る · Escで区切る' : hints[tab];
}

function screenDistance(a, b) { const p = map.latLngToScreen(a), q = map.latLngToScreen(b); return Math.hypot(p.x - q.x, p.y - q.y); }
function stationPlacementHit(point, existingTrackId = null, ownedTrackId = null, draftTrackId = null) {
  if (existingTrackId) {
    const host = existingNetwork?.getTrack(existingTrackId);
    if (!host) return null;
    const hit = E.nearestTrack({ tracks: [{ ...host, type: 'single' }] }, point, { mainOnly: true });
    return hit && hit.distance <= 100 ? { ...hit, track: host } : null;
  }
  const tracks = [...game.tracks, ...(constructionPreview().preparedTracks || [])];
  if (ownedTrackId || draftTrackId) {
    const host = tracks.find(track => draftTrackId ? track.draftTrackId === draftTrackId : track.id === ownedTrackId); if (!host) return null;
    const hit = E.nearestTrack({ tracks: [host] }, point, { mainOnly: true });
    return hit && hit.distance <= 100 ? hit : null;
  }
  const owned = E.nearestTrack({ tracks }, point, { mainOnly: true }), blue = map.nearestExistingTrack(point, 18, 80);
  const own = owned && owned.distance <= 100 && screenDistance(point, owned.point) <= 18 ? owned : null;
  return blue && (!own || blue.distance < own.distance) ? blue : own;
}

function nearestBuildConnection(point) {
  const own = E.nearestTrack(game, point, { mainOnly: true });
  const blue = ['single', 'double'].includes(trackType) ? existingNetwork?.nearestTrack(point, 80) : null;
  return blue && (!own || blue.distance < own.distance) ? blue : own;
}

function snapPoint(point, force = false) {
  const port = ['single', 'double'].includes(trackType) ? map.nearestStationConnection(point, 12) : null;
  const endpoint = map.nearestDraftEndpoint(point, 14);
  if (endpoint && (!port || endpoint.screenDistance <= port.screenDistance)) return { ...endpoint.point };
  if (port && port.distance <= 80) return { ...port.point };
  const hit = nearestBuildConnection(point);
  return hit && hit.distance <= 80 && (force || screenDistance(point, hit.point) <= 10) ? { ...hit.point } : { ...point };
}
function snapMovedPoint(point, index) {
  const port = ['single', 'double'].includes(trackType) ? map.nearestStationConnection(point, 12) : null;
  let endpoint = null;
  const candidates = draftStrokes.flatMap(stroke => [stroke.points[0], stroke.points.at(-1)]);
  for (const i of [0, plan.length - 1]) if (i !== index) candidates.push(plan[i]);
  for (const candidate of candidates) {
    const pixels = screenDistance(point, candidate);
    if (pixels <= 14 && (!endpoint || pixels < endpoint.pixels)) endpoint = { point: candidate, pixels };
  }
  if (endpoint && (!port || endpoint.pixels <= port.screenDistance)) return { ...endpoint.point };
  if (port && port.distance <= 80) return { ...port.point };
  const hit = nearestBuildConnection(point);
  return hit && hit.distance <= 80 && screenDistance(point, hit.point) <= 10 ? { ...hit.point } : { ...point };
}

function existingStationAt(point) {
  if (!existingNetwork) return null;
  const station = map.nearestExistingStation(point, 12, { railOnly: true });
  return station ? existingNetwork.getStation(station.id) : null;
}

function registerExistingStation(source) {
  const result = E.useExistingStation(game, source, 20);
  if (!result.ok) { message(result.error, 'error'); return null; }
  renderLists(); updateMap(); markDirty(); saveNow();
  return result.station;
}

function mapMove(point) {
  hover = point;
  $('#map-coordinates').textContent = point ? `${point.lat.toFixed(5)}°N, ${point.lng.toFixed(5)}°E · z${map.getView().zoom.toFixed(1)}` : '';
  if (tab === 'build') updateMap();
}

function clearGradeMeasurement() {
  gradeController?.abort(); gradeController = null; gradeVersion++;
  gradePoints = []; gradeResult = null; gradePending = false; gradeError = '';
}
function renderGradeMeasurement() {
  $('#grade-panel').hidden = !gradeEnabled; $('#grade-toggle').setAttribute('aria-pressed', String(gradeEnabled));
  $('#grade-value').hidden = !gradeResult;
  $('#grade-status').textContent = gradeError || (gradePending ? '国土地理院から標高を取得しています…' : gradeResult ? '始点A → 終点B の平均勾配' : gradePoints.length === 1 ? '始点Aを選択しました。終点Bをクリックしてください。' : '地図上で始点A・終点Bをクリックしてください。');
  $('#grade-detail').textContent = '';
  if (gradeResult) {
    const value = gradeResult.permille, direction = Math.abs(value) < .05 ? 'ほぼ水平' : value > 0 ? '上り' : '下り';
    $('#grade-value').textContent = `${value >= 0 ? '+' : ''}${value.toFixed(1)}‰（${direction}）`;
    $('#grade-detail').textContent = `A ${gradeResult.elevationA.toFixed(1)}m → B ${gradeResult.elevationB.toFixed(1)}m / 標高差 ${gradeResult.elevationDifference >= 0 ? '+' : ''}${gradeResult.elevationDifference.toFixed(1)}m / 水平距離 ${gradeResult.horizontalDistance >= 1000 ? `${(gradeResult.horizontalDistance / 1000).toFixed(3)}km` : `${gradeResult.horizontalDistance.toFixed(1)}m`}`;
  }
}
function setGradeEnabled(enabled) {
  if (enabled && plan.length) finishTrackDraft();
  gradeEnabled = enabled; clearGradeMeasurement(); hover = null;
  renderGradeMeasurement(); renderHint(); updateMap();
}
async function addGradePoint(point) {
  if (gradePoints.length === 2) clearGradeMeasurement();
  gradePoints.push({ ...point }); gradeError = ''; gradeResult = null;
  if (gradePoints.length < 2) { renderGradeMeasurement(); renderHint(); updateMap(); return; }
  if (E.distance(gradePoints[0],gradePoints[1]) < 1) { gradePoints.pop(); gradeError = '始点と終点を1m以上離して選択してください。'; renderGradeMeasurement(); updateMap(); return; }
  const version = ++gradeVersion; gradeController?.abort(); gradeController = new AbortController();
  const controller = gradeController, timeout = setTimeout(() => controller.abort(), 15000);
  gradePending = true; renderGradeMeasurement(); renderHint(); updateMap();
  try {
    const points = await Promise.all(gradePoints.map(value => elevationLookup.get(value,controller.signal)));
    if (version !== gradeVersion || !gradeEnabled) return;
    gradeResult = calculateGrade(points[0],points[1]);
  } catch (error) {
    if (version !== gradeVersion || !gradeEnabled) return;
    gradeError = error.name === 'AbortError' ? '標高の取得に時間がかかっています。測り直してください。' : error.message || '標高データを取得できませんでした。';
  } finally {
    clearTimeout(timeout);
    if (version === gradeVersion) { gradePending = false; gradeController = null; renderGradeMeasurement(); }
  }
}

function mapClick(point) {
  if (isDialogOpen()) return;
  if (gradeEnabled) { addGradePoint(point); return; }
  if (tab === 'build' && buildMode === 'track') {
    if (trackInteraction === 'edit') {
      if (map.nearestPlanPoint(point)) return;
      const active = map.nearestRenderedTrack(point, { type: trackType, points: planGeometry().points || plan });
      const activeDistance = active?.screenDistance ?? Infinity;
      const index = map.nearestDraftStroke(point, Math.min(10, activeDistance - .1));
      if (index != null) { selectDraft(index); return; }
      if (activeDistance <= 10) return;
      const built = map.nearestOwnTrack(point);
      if (built) { selectBuiltTrack(built.track.id); return; }
      if (!archiveActiveDraft()) return;
      selectedTrackId = null; hover = null; renderCost(); renderHint(); updateMap(); markDirty(); saveNow(); return;
    }
    const endpoint = map.nearestDraftEndpoint(point, 14);
    const existing = map.nearestPlanPoint(point) || (endpoint?.active ? { index: plan.length - 1 } : null);
    if (existing) { removePlanPoint(existing.index); return; }
    const pointCount = draftStrokes.reduce((sum, stroke) => sum + stroke.points.length, 0) + plan.length;
    if ((!plan.length && draftStrokes.length >= 200) || pointCount >= 10000) { message('下書きは200区間・合計10,000点までです。先に敷設または取消をしてください。', 'info'); return; }
    const snapped = snapPoint(point);
    if (plan.length && E.distance(snapped, plan.at(-1)) < 2) { message('直前の点から2m以上離れた位置を選択してください。', 'error'); return; }
    if (['crossover', 'scissors'].includes(trackType) && plan.length >= 2) { message('2点を選択済みです。「まとめて敷設」または「計画を破棄」を選択してください。', 'info'); return; }
    if (plan.length >= 2) {
      const last = nearestBuildConnection(plan.at(-1));
      if (last && last.distance < 1) { message('線路への接続点を選択済みです。「まとめて敷設」または「計画を破棄」を選択してください。', 'info'); return; }
    }
    const candidate = [...plan, snapped];
    if (candidate.length >= 3 && typeof E.planTrackPoints === 'function') {
      const geometry = planGeometry(candidate);
      if (!geometry.ok) { message(geometry.error, 'error'); return; }
    }
    const before = beforeTrackEdit();
    if (!plan.length) activeTrackDraftId = newDraftId();
    if (!plan.length && curveMode === 'legacy') { curveMode = 'tangent'; renderTrackTypeControls(); }
    curveHandles = candidate.map((_, i) => curveHandles[i] || null); plan = candidate; selectedTrackId = null;
    recordTrackEdit(before, '計画点を追加'); renderCost(); updateMap(); markDirty(); saveNow();
  } else if (tab === 'build' && buildMode === 'station') {
    if (stationInteraction === 'edit') {
      const picked = map.nearestStationDraft(point, 12);
      if (picked != null && picked !== allStationDrafts().indexOf(game.stationDraft)) { selectStationDraft(picked); return; }
      if (!game.stationDraft) { message('地図または一覧から、編集する駅の下書きを選択してください。', 'info'); return; }
    } else if (allStationDrafts().length >= 200) { message('駅の下書きは200駅までです。先に敷設または削除してください。', 'info'); return; }
    const existing = stationPlacement === 'track' ? existingStationAt(point) : null;
    const before = beforeTrackEdit();
    let draft;
    if (existing) {
      draft = { kind: 'existing', point: { lat: existing.lat, lng: existing.lng }, sourceStationId: String(existing.id) };
    } else {
      const hit = stationPlacement === 'track' ? stationPlacementHit(point) : null;
      if (stationPlacement === 'track' && !hit) { message('下書きの線路・自作線路・青い既存線路の上をクリックしてください。', 'error'); return; }
      if (hit) syncStationHostPlatforms(hit);
      const anchor = stationPlacement === 'free' ? point : hit.point;
      draft = { kind: 'new', point: { lat: anchor.lat, lng: anchor.lng }, cars: platformCars, options: stationOptions(point) };
    }
    if (stationInteraction === 'edit') game.stationDraft = { ...draft, ...(activeStationDraftIndex != null ? { orderIndex: activeStationDraftIndex } : {}) };
    else { archiveStationDraft(); game.stationDrafts.push(draft); }
    constructionCache = null; hover = null; recordTrackEdit(before, stationInteraction === 'edit' ? '駅の仮配置を移動' : '駅を下書きに追加');
    renderCost(); renderHint(); updateMap(); markDirty(); saveNow();
    message(stationInteraction === 'edit' ? '駅の下書きを移動しました。' : '駅を下書きに追加しました。続けて別の駅を配置できます。', 'info');
  } else if (tab === 'route') {
    const candidate = game.stations.filter(s => !s.existing).map(s => ({ station: s, distance: screenDistance(s, point) })).sort((a, b) => a.distance - b.distance)[0];
    const source = existingStationAt(point);
    const selected = candidate && candidate.distance <= 12 ? candidate.station : source ? registerExistingStation(source) : candidate && candidate.distance <= 18 ? candidate.station : null;
    if (!selected) { message('自作駅または既存の青い駅をクリックして起点・終点を選択してください。', 'info'); return; }
    const id = selected.id;
    if (!routeStart || routeEnd) { routeStart = id; routeEnd = null; routePlatformAssignments = { forward: {}, backward: {} }; message(`${selected.name}を起点に選択しました。`); }
    else if (routeStart === id) { message('起点とは別の駅を選択してください。', 'error'); return; }
    else { routeEnd = id; message(`${game.stations.find(s => s.id === routeStart).name} → ${selected.name} を選択しました。`); }
    selectedRouteId = null; renderEndpoints(); renderHint(); updateMap();
  }
}

function removePlanPoint(index) {
  if (index < 0 || index >= plan.length) return;
  const before = beforeTrackEdit();
  plan = plan.filter((_, i) => i !== index);
  curveHandles = curveHandles.filter((_, i) => i !== index);
  if (!plan.length) { activeDraftIndex = null; if (curveMode === 'legacy') curveMode = 'tangent'; renderTrackTypeControls(); }
  hover = null;
  recordTrackEdit(before, '計画点を取消');
  renderCost(); renderHint(); updateMap(); markDirty();
  const geometry = planGeometry();
  message(geometry.ok ? '計画点を1つ取り消しました。' : `計画点を1つ取り消しました。${geometry.error}`, geometry.ok ? 'info' : 'error');
  saveNow();
}

async function loadNames() {
  if (!namesReady) namesReady = (async () => {
    try {
      const response = await fetch('./data/placenames.json.gz');
      if (!response.ok || typeof DecompressionStream === 'undefined') return false;
      const data = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
      for (const row of data.points || []) {
        const p = { lat: row[0] / 100000, lng: row[1] / 100000, name: data.names[row[2]] };
        const key = `${Math.floor(p.lat / .05)}:${Math.floor(p.lng / .05)}`;
        if (!nameBuckets.has(key)) nameBuckets.set(key, []);
        nameBuckets.get(key).push(p);
      }
      return true;
    } catch { return false; }
  })();
  return namesReady;
}

async function autoNameStation(station) {
  const originalName = station.name;
  if (!(await loadNames()) || station.userRenamed || station.name !== originalName || !game.stations.includes(station)) return;
  const y = Math.floor(station.lat / .05), x = Math.floor(station.lng / .05);
  let nearest = null, metres = 5000;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const p of nameBuckets.get(`${y + dy}:${x + dx}`) || []) { const d = E.distance(p, station); if (d < metres) { metres = d; nearest = p; } }
  if (nearest?.name) {
    const previousKey = trackNetworkKey(game);
    automaticStationNames.set(station.id, { from: originalName, to: nearest.name });
    E.renameStation(game, station.id, nearest.name);
    if (trackHistoryKey === previousKey) trackHistoryKey = trackNetworkKey(game);
    renderLists(); renderEndpoints(); updateMap(); markDirty(); saveNow();
  }
}

function applyGame(next, slot = null) {
  automaticStationNames.clear();
  map.cancelEditGesture(); trackHistory.clear(); trackHistoryKey = ''; trackLedger = { paid: 0, construction: 0 }; trackGesture = null;
  if (gradeEnabled) setGradeEnabled(false);
  const locked = game.unlimited || hasUnlimitedLock({ getItem: key => localStorage.getItem(key) }, KEYS);
  game = next; game.unlimited ||= locked;
  routePlatformAssignments = { forward: {}, backward: {} };
  activeSlot = slot; game.stationDrafts ||= []; constructionCache = null; stationInteraction = 'place'; activeStationDraftIndex = null; restoreTrackDraft(); restoreStationDraft(); routeStart = routeEnd = selectedRouteId = null; hover = null;
  $('#game-speed').value = String(game.speed || 0);
  clockControls = createClockControls(game.speed || 0);
  map.setView(game.view); map.setLayer(game.layer); renderLayers();
  renderHeader(); renderCost(); renderLists(); renderSaves(); renderEndpoints(); renderHint(); updateMap(); markDirty(); saveNow();
  E.loadEconomicData?.(game).then(() => { constructionCache = null; renderCost(); updateMap(); });
}

function ask({ title, body = '', confirm = '実行', value, share }) {
  return new Promise(resolve => {
    const dialog = $('#app-dialog');
    $('#dialog-title').textContent = title; $('#dialog-body').textContent = body; $('#dialog-confirm').textContent = confirm;
    $('#dialog-input').hidden = value === undefined; $('#dialog-input').value = value ?? '';
    $('#dialog-share').hidden = share === undefined; $('#dialog-share').value = share ?? '';
    dialog.returnValue = 'cancel';
    const close = () => { dialog.removeEventListener('close', close); resolve(dialog.returnValue === 'confirm' ? value !== undefined ? $('#dialog-input').value : true : false); };
    dialog.addEventListener('close', close); dialog.showModal();
    if (value !== undefined) { $('#dialog-input').focus(); $('#dialog-input').select(); }
    else if (share !== undefined) { $('#dialog-share').focus(); $('#dialog-share').select(); }
    else $('#dialog-cancel').focus();
  });
}

async function encodeShare(data) {
  const bytes = new TextEncoder().encode(data);
  let payload = bytes, prefix = 'j';
  if (typeof CompressionStream !== 'undefined') { payload = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); prefix = 'g'; }
  let binary = '';
  for (let offset = 0; offset < payload.length; offset += 8192) binary += String.fromCharCode(...payload.subarray(offset, offset + 8192));
  return prefix + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function decodeShare(encoded) {
  if (encoded.length > 3_000_000) throw new Error('Share too large');
  const text = atob(encoded.slice(1).replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
  if (encoded[0] === 'g') {
    if (typeof DecompressionStream === 'undefined') throw new Error('Gzip is not supported');
    const decompressed = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    if (decompressed.length > 10_000_000) throw new Error('Share too large');
    return E.deserializeGame(decompressed);
  }
  return E.deserializeGame(new TextDecoder().decode(bytes));
}

async function shareSave(slot) {
  if (slot.id === activeSlot) saveNow();
  try {
    const encoded = await encodeShare(slot.data);
    const url = new URL(location.href); url.hash = `share=${encoded}`;
    let copied = false;
    try { await navigator.clipboard.writeText(url.href); copied = true; } catch { /* A selectable link is shown below. */ }
    await ask({ title: '共有リンク', body: `「${slot.name}」の現在の状態をコピーしました。読み込んだ相手のプレイは独立します。${copied ? '\nリンクをクリップボードにコピーしました。' : '\n下のリンクを選択してコピーしてください。'}${url.href.length > 16000 ? '\n大きなデータではリンクが長くなります。ファイルでの共有も利用できます。' : ''}`, share: url.href, confirm: '閉じる' });
  } catch { message('共有リンクを生成できませんでした。ファイルに書き出して共有できます。', 'error'); }
}

async function receiveShare() {
  if (!location.hash.startsWith('#share=')) return;
  try {
    const next = await decodeShare(location.hash.slice(7));
    const accepted = await ask({ title: '共有されたプレイを読み込む', body: `線路 ${next.tracks.length}本・駅 ${next.stations.length}駅・路線 ${next.routes.length}本の共有コピーです。読み込むと現在のプレイを置き換えます。名前付きセーブは残ります。`, confirm: '読み込む' });
    if (accepted) { saveNow(); applyGame(next); message('共有コピーを読み込みました。元の保存枠には影響しません。'); }
    history.replaceState(null, '', location.pathname + location.search);
  } catch { message('この共有リンクは無効か、データが壊れています。', 'error', false); }
}

function renderLayers() {
  for (const button of $$('[data-layer]')) { const selected = button.dataset.layer === game.layer; button.classList.toggle('selected', selected); button.querySelector('.choice-check').textContent = selected ? '✓' : ''; }
  const credit = $('#base-credit'); credit.replaceChildren();
  if (game.layer === 'standard') { credit.append('地図 © '); const link = document.createElement('a'); link.href = 'https://www.openstreetmap.org/copyright'; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = 'OpenStreetMap contributors'; credit.append(link); }
  else if (game.layer === 'satellite' || game.layer === 'relief') { const link = document.createElement('a'); link.href = 'https://maps.gsi.go.jp/development/ichiran.html'; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = game.layer === 'relief' ? '色別標高図：国土地理院' : '地図・航空写真：国土地理院'; credit.append(link); if (game.layer === 'relief') credit.append(' · 海域部は海上保安庁海洋情報部の資料を使用して作成'); }
  else credit.textContent = '白紙';
  $('#population-layer-toggle').classList.toggle('selected', !!game.populationVisible);
  $('#population-layer-toggle').setAttribute('aria-pressed', String(!!game.populationVisible));
  $('#population-layer-toggle .choice-check').textContent = game.populationVisible ? '✓' : '';
  $('#population-legend').hidden = !game.populationVisible;
  $('#population-data-status').textContent = populationReady ? '2020年の推計値です' : '人口データを読み込んでいます…';
}

function resetEditor() {
  automaticStationNames.clear();
  clearGradeMeasurement(); gradeEnabled = false; renderGradeMeasurement();
  plan = []; curveHandles = []; curveMode = 'tangent'; draftStrokes = []; hover = null; routeStart = routeEnd = selectedRouteId = null;
  activeDraftIndex = null; selectedTrackId = null; trackInteraction = 'draw'; trackGesture = null;
  activeTrackDraftId = newDraftId(); stationInteraction = 'place'; activeStationDraftIndex = null; constructionCache = null;
  trackHistory.clear(); trackHistoryKey = ''; trackLedger = { paid: 0, construction: 0 };
  buildMode = 'track'; trackType = 'double'; platformCars = 8;
  stationLayoutId = 'island-4'; stationPlacement = 'free'; stationBearing = 0;
  stationWiringMode = 'platforms'; stationTrackConfigs = []; stationHostPlatformNumbers = []; stationHostPlatformNumber = null; stationHostTrackCount = 1; routePlatformAssignments = { forward: {}, backward: {} };
  $('#station-platform').value = '8'; $('#station-layout').value = stationLayoutId; $('#station-bearing').value = '0';
  $('#route-form').reset(); $('#save-name').value = '';
  for (const button of $$('[data-build]')) { const active = button.dataset.build === buildMode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  for (const button of $$('[data-track]')) { const active = button.dataset.track === trackType; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  renderTrackTypeControls();
  $('#panel-track').hidden = false; $('#panel-station').hidden = true;
  $('#layer-menu').hidden = true; $('#map-layer-toggle').setAttribute('aria-expanded', 'false');
  map.closeStationPopup(); renderStationOptions();
}

function renderNewGameDialog() {
  const clearAll = $('#clear-named-saves').checked;
  $('#new-game-description').textContent = clearAll ? `名前付きセーブ${slots.length}件もすべて削除します。この操作は取り消せません。` : `名前付きセーブ${slots.length}件は残します。現在のゲームを保存中の枠があれば、最後の状態を保存してから新しいゲームを始めます。`;
  $('#new-game-confirm').textContent = clearAll ? 'すべてリセット' : '新規ゲームを開始';
  $('#new-game-confirm').classList.toggle('destructive', clearAll);
}

function openNewGameDialog() {
  $('#clear-named-saves').checked = false; $('#new-game-error').hidden = true;
  renderNewGameDialog(); $('#new-game-dialog').showModal(); $('#new-game-cancel').focus();
}

function handleNewGame(event) {
  event.preventDefault();
  const clearNamedSaves = $('#clear-named-saves').checked;
  if (!clearNamedSaves && activeSlot && !saveNow()) {
    $('#new-game-error').textContent = '現在の保存枠を更新できませんでした。セーブ画面からファイルへ書き出してから、もう一度お試しください。'; $('#new-game-error').hidden = false; return;
  }
  let result;
  try { result = resetProgress(localStorage, KEYS, { clearNamedSaves }); }
  catch { result = { ok: false, error: 'ブラウザの保存機能を利用できないため、リセットできませんでした。' }; }
  if (!result.ok) { $('#new-game-error').textContent = result.error; $('#new-game-error').hidden = false; return; }
  $('#new-game-dialog').close();
  if (clearNamedSaves) slots = [];
  activeSlot = null; savePage = 10; game = E.createGame();
  resetEditor(); applyGame(game); setTab('build'); $('#panel-scroll').scrollTop = 0;
  message(clearNamedSaves ? '保存枠を含めてすべてリセットしました。新しいゲームを開始します。' : '新しいゲームを開始しました。名前付きセーブは残っています。');
}

for (const button of $$('[data-tab]')) button.addEventListener('click', () => setTab(button.dataset.tab));
for (const button of $$('[data-build]')) button.addEventListener('click', () => {
  map.cancelEditGesture(); ensureTrackHistory();
  if (gradeEnabled) setGradeEnabled(false);
  if (button.dataset.build !== 'track' && plan.length) finishTrackDraft();
  buildMode = button.dataset.build; hover = null;
  for (const b of $$('[data-build]')) { const active = b === button; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }
  $('#panel-track').hidden = buildMode !== 'track'; $('#panel-station').hidden = buildMode !== 'station';
  renderCost(); renderHint(); updateMap(); message('');
});
for (const button of $$('[data-track]')) button.addEventListener('click', () => {
  map.cancelEditGesture(); const before = beforeTrackEdit();
  trackType = button.dataset.track; hover = null;
  if (plan.length) recordTrackEdit(before, '線路の種類を変更');
  renderTrackTypeControls(); renderCost(); renderHint(); updateMap(); markDirty(); saveNow();
  message(plan.length ? '下書きの点を残して線路の種類を変更しました。' : '', 'info');
});
for (const button of $$('[data-curve]')) button.addEventListener('click', () => {
  map.cancelEditGesture(); const before = beforeTrackEdit();
  curveMode = button.dataset.curve; curveHandles = []; hover = null;
  if (plan.length) recordTrackEdit(before, '曲線モードを変更');
  renderTrackTypeControls(); renderCost(); renderHint(); updateMap(); markDirty(); saveNow();
  message(plan.length ? '点を残して曲線モードを変更しました。' : '', 'info');
});
$('#curve-guides').addEventListener('change', updateMap);
for (const button of $$('[data-track-mode]')) button.addEventListener('click', () => {
  map.cancelEditGesture(); ensureTrackHistory();
  if (button.dataset.trackMode === 'draw' && trackInteraction !== 'draw' && plan.length) { if (!finishTrackDraft()) return; }
  trackInteraction = button.dataset.trackMode; selectedTrackId = null; hover = null;
  renderCost(); renderHint(); updateMap();
});
$('#track-undo').addEventListener('click', () => traverseTrackHistory('undo'));
$('#track-redo').addEventListener('click', () => traverseTrackHistory('redo'));
$('#station-undo').addEventListener('click', () => traverseTrackHistory('undo'));
$('#station-redo').addEventListener('click', () => traverseTrackHistory('redo'));
$('#track-delete').addEventListener('click', deleteSelectedTrack);
$('#track-build').addEventListener('click', confirmConstructionPlan);
$('#station-confirm').addEventListener('click', confirmConstructionPlan);
$('#track-cancel').addEventListener('click', discardConstructionPlan);
$('#station-draft-cancel').addEventListener('click', discardConstructionPlan);
let stationParameterBefore = null;
$('#panel-station').addEventListener('change', event => { if (event.target.matches('select') && game.stationDraft && stationInteraction === 'edit') stationParameterBefore = beforeTrackEdit(); }, true);
$('#panel-station').addEventListener('change', () => { if (!stationParameterBefore) return; const before = stationParameterBefore; stationParameterBefore = null; syncStationDraftOptions(); recordTrackEdit(before, '駅の下書きの設定を変更'); markDirty(); saveNow(); });
for (const button of $$('[data-station-mode]')) button.addEventListener('click', () => {
  syncStationDraftOptions(); if (button.dataset.stationMode === 'place') archiveStationDraft();
  stationInteraction = button.dataset.stationMode; hover = null; renderCost(); renderHint(); updateMap(); markDirty(); saveNow();
});
$('#station-platform').addEventListener('change', e => { platformCars = Number(e.target.value); renderCost(); updateMap(); });
$('#station-layout').addEventListener('change', e => { stationLayoutId = e.target.value; stationTrackConfigs = []; if (stationHostPlatformNumber > E.getStationLayout(stationLayoutId).tracks) stationHostPlatformNumber = null; hover = null; syncStationHostPlatforms(null); renderStationOptions(); renderCost(); updateMap(); });
$('#station-host-platform').addEventListener('change', e => { stationHostPlatformNumber = e.target.value ? Number(e.target.value) : null; const anchor = game.stationDraft?.point || hover, options = game.stationDraft?.options; syncStationHostPlatforms(anchor ? stationPlacementHit(anchor, options?.existingTrackId, options?.ownedTrackId, options?.draftTrackId) : null); renderStationOptions(); renderCost(); updateMap(); });
for (const button of $$('[data-station-placement]')) button.addEventListener('click', () => { stationPlacement = button.dataset.stationPlacement; hover = null; syncStationHostPlatforms(null); renderStationOptions(); renderCost(); renderHint(); updateMap(); });
$('#station-bearing').addEventListener('input', e => setStationBearing(Number(e.target.value)));
$('#station-rotate').addEventListener('click', () => setStationBearing(stationBearing + 45));
$('#grade-toggle').addEventListener('click', () => setGradeEnabled(!gradeEnabled));
$('#grade-close').addEventListener('click', () => setGradeEnabled(false));
$('#grade-reset').addEventListener('click', () => { clearGradeMeasurement(); renderGradeMeasurement(); renderHint(); updateMap(); });
$('#station-wiring-mode').addEventListener('change', event => { stationWiringMode = event.target.value; stationTrackConfigs = []; renderStationOptions(); renderCost(); updateMap(); });
$('#edit-wiring-mode').addEventListener('change', event => {
  const station = game.stations.find(value => value.id === editingStationId); if (!station) return;
  editingStationWiring.wiringMode = event.target.value;
  editingStationWiring.trackConfigs = E.getStationTrackConfigs({ ...station, ...editingStationWiring, trackConfigs: [] }); renderEditingWiring();
});
$('#station-wiring-cancel').addEventListener('click', () => $('#station-wiring-dialog').close());
$('#station-wiring-form').addEventListener('submit', event => {
  event.preventDefault(); const result = E.updateStationWiring(game, editingStationId, { ...editingStationWiring, portGeometry: 'straight' });
  if (!result.ok) { $('#station-wiring-error').textContent = result.error; $('#station-wiring-error').hidden = false; return; }
  $('#station-wiring-dialog').close(); renderHeader(); renderLists(); renderEndpoints(); updateMap(); markDirty(); saveNow(); message('番線の配線を保存しました。変更した接続口へ線路を接続してください。');
});
$('#route-platform-cancel').addEventListener('click', () => $('#route-platform-dialog').close());
$('#route-platform-form').addEventListener('submit', event => {
  event.preventDefault(); const result = E.updateRoutePlatforms(game, editingRouteId, editingRoutePlatforms);
  if (!result.ok) { $('#route-platform-error').textContent = result.error; $('#route-platform-error').hidden = false; return; }
  $('#route-platform-dialog').close(); renderLists(); updateMap(); markDirty(); saveNow(); message('使用番線と経路・ダイヤを更新しました。');
});
$('#route-start').addEventListener('click', () => { routeStart = routeEnd = null; routePlatformAssignments = { forward: {}, backward: {} }; renderEndpoints(); renderHint(); updateMap(); });
$('#route-end').addEventListener('click', () => { if (routeEnd) { delete routePlatformAssignments.forward[routeEnd]; delete routePlatformAssignments.backward[routeEnd]; } routeEnd = null; renderEndpoints(); renderHint(); updateMap(); });
$('#route-form').addEventListener('submit', event => {
  event.preventDefault();
  const result = E.createRoute(game, { name: $('#route-name').value.trim(), startId: routeStart, endId: routeEnd, cars: Number($('#route-cars').value), fleet: Number($('#route-fleet').value), first: $('#route-first').value, last: $('#route-last').value, platformAssignments: routePlatformAssignments });
  if (!result.ok) { message(result.error, 'error'); return; }
  const route = result.route; selectedRouteId = route?.id || null; routeStart = routeEnd = null; $('#route-name').value = '';
  routePlatformAssignments = { forward: {}, backward: {} };
  renderHeader(); renderEndpoints(); renderHint(); renderLists(); updateMap(); markDirty(); saveNow(); message(`${route.name}のダイヤを作成しました（${Number(route.intervalMinutes).toFixed(1)}分間隔）。`);
});
function setGameSpeed(event) {
  const result = clockControls.setSpeed(event.target.value);
  if (!result.ok) { if (event.type === 'change') { event.target.value = game.speed; message(result.error, 'error'); } return; }
  game.speed = result.state.speed;
  renderClockControls();
  markDirty();
  if (event.type === 'change') saveNow();
}
$('#game-speed').addEventListener('input', setGameSpeed);
$('#game-speed').addEventListener('change', setGameSpeed);
$('#clock-pause').addEventListener('click', () => { game.speed = clockControls.togglePause().state.speed; renderHeader(); markDirty(); saveNow(); });
for (const button of $$('[data-speed]')) button.addEventListener('click', () => { game.speed = clockControls.setSpeed(Number(button.dataset.speed)).state.speed; renderHeader(); markDirty(); saveNow(); });
$('#panel-toggle').addEventListener('click', () => setPanelOpen(inspectorCollapsed));
$('#save-form').addEventListener('submit', event => {
  event.preventDefault(); const name = $('#save-name').value.trim().slice(0, 60);
  if (!name) return;
  if (slots.length >= 100) { message('保存枠は100件までです。ファイルに書き出すか、不要な枠を削除してください。', 'error'); return; }
  saveNow();
  const slot = { id: `save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name, updatedAt: Date.now(), data: E.serializeGame(game) };
  slots.unshift(slot);
  if (!saveSlots()) { slots.shift(); return; }
  activeSlot = slot.id; markDirty(); saveNow(); $('#save-name').value = ''; renderSaves(); message(`「${name}」を保存しました。この枠を自動更新します。`);
});
$('#save-more').addEventListener('click', () => { savePage += 10; renderSaves(); });
$('#export-save').addEventListener('click', () => {
  saveNow(); const blob = new Blob([E.serializeGame(game)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `railway-canvas-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 3000); message('セーブデータを書き出しました。');
});
$('#import-save').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (file.size > 10_000_000) throw new Error('too large');
    const next = E.deserializeGame(await file.text());
    if (await ask({ title: 'ファイルを読み込む', body: `「${file.name}」から線路 ${next.tracks.length}本・駅 ${next.stations.length}駅・路線 ${next.routes.length}本を読み込み、現在のプレイを置き換えます。`, confirm: '読み込む' })) { saveNow(); applyGame(next); message('セーブファイルを読み込みました。'); }
  } catch { message('クローン用の有効なセーブファイルを選択してください。', 'error'); }
  event.target.value = '';
});
for (const selector of ['#save-reset', '#settings-new-game', '#new-game-menu']) $(selector).addEventListener('click', openNewGameDialog);
$('#new-game-cancel').addEventListener('click', () => $('#new-game-dialog').close());
$('#clear-named-saves').addEventListener('change', renderNewGameDialog);
$('#new-game-form').addEventListener('submit', handleNewGame);
$('#settings-unlimited').addEventListener('change', async event => {
  event.target.checked = game.unlimited;
  if (game.unlimited) return;
  if (!(await ask({ title: '資金無制限を有効にする', body: '資金を減らさずに建設・運行できるようにします。一度有効にすると、このプレイを初期化するまで解除できません。', confirm: '有効にする' }))) return;
  game.unlimited = true; renderHeader(); markDirty(); saveNow(); message('資金無制限を有効にしました。');
});
$('#help-button').addEventListener('click', () => { setTab('settings'); const details = $('#operation-guide'); details.open = true; details.scrollIntoView({ block: 'nearest' }); });
$('#map-layer-toggle').addEventListener('click', () => { const open = $('#layer-menu').hidden; $('#layer-menu').hidden = !open; $('#map-layer-toggle').setAttribute('aria-expanded', String(open)); });
for (const button of $$('[data-layer]')) button.addEventListener('click', () => { game.layer = button.dataset.layer; map.setLayer(game.layer); renderLayers(); $('#layer-menu').hidden = true; $('#map-layer-toggle').setAttribute('aria-expanded', 'false'); markDirty(); saveNow(); });
$('#population-layer-toggle').addEventListener('click', () => { game.populationVisible = !game.populationVisible; renderLayers(); updateMap(); $('#layer-menu').hidden = true; $('#map-layer-toggle').setAttribute('aria-expanded', 'false'); markDirty(); saveNow(); });
document.addEventListener('pointerdown', event => { if (!event.target.closest('.map-tools')) { $('#layer-menu').hidden = true; $('#map-layer-toggle').setAttribute('aria-expanded', 'false'); } if (!event.target.closest('#clock-custom')) $('#clock-custom').open = false; });
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || isDialogOpen()) return;
  const typing = event.target.closest?.('input, textarea, select, [contenteditable="true"]');
  if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.code === 'Space' && !event.repeat && (!event.target.closest?.('button, summary') || event.target.closest?.('[data-speed]'))) { event.preventDefault(); $('#clock-pause').click(); return; }
    const tool = event.key.toLowerCase();
    if (['t', 's', 'v', 'l'].includes(tool)) {
      event.preventDefault();
      if (tool === 'l') setTab('route');
      else { setTab('build'); $(`[data-build="${tool === 's' ? 'station' : 'track'}"]`).click(); if (tool === 'v' || tool === 't') $(`[data-track-mode="${tool === 'v' ? 'edit' : 'draw'}"]`).click(); }
      return;
    }
  }
  if (tab === 'build' && !gradeEnabled && !typing) {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
      event.preventDefault(); traverseTrackHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo'); return;
    }
    if (event.key === 'Delete' && buildMode === 'track') { event.preventDefault(); deleteSelectedTrack(); return; }
    if (event.key === 'Delete' && buildMode === 'station' && game.stationDraft) { event.preventDefault(); removeStationDraft(allStationDrafts().indexOf(game.stationDraft)); return; }
  }
  if (event.key !== 'Escape') return;
  if (trackGesture) { map.cancelEditGesture(); return; }
  if (gradeEnabled) { setGradeEnabled(false); return; }
  $('#layer-menu').hidden = true; $('#map-layer-toggle').setAttribute('aria-expanded', 'false');
  if (tab === 'build' && buildMode === 'track' && plan.length) {
    event.preventDefault();
    if (finishTrackDraft()) message('区間を下書きに残しました。次のクリックから別の線を描けます。', 'info');
  } else if (tab === 'build' && buildMode === 'track') {
    trackInteraction = 'draw'; selectedTrackId = null; hover = null; renderCost(); renderHint(); updateMap();
  } else if (tab === 'build' && buildMode === 'station' && game.stationDraft) {
    event.preventDefault(); syncStationDraftOptions(); archiveStationDraft(); stationInteraction = 'place'; hover = null; renderCost(); renderHint(); updateMap(); markDirty();
    if (saveNow()) message('駅の下書きを残しました。続けて別の駅を配置できます。', 'info');
  }
});
window.addEventListener('beforeunload', saveNow);
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
window.addEventListener('hashchange', receiveShare);
window.addEventListener('storage', event => {
  if (event.key !== KEYS.current || event.newValue !== null) return;
  try {
    const restored = readProgress(localStorage, KEYS, E.createGame, E.deserializeGame);
    for (const dialog of $$('dialog[open]')) dialog.close('cancel');
    slots = restored.slots; activeSlot = null; game = E.createGame();
    resetEditor(); applyGame(restored.game, restored.activeSlot); setTab('build');
    message('別のタブで新規ゲームが開始されたため、この画面も更新しました。', 'info');
  } catch { game.speed = 0; clockControls.setSpeed(0); renderHeader(); dirty = false; message('別のタブでゲームがリセットされました。この画面を再読み込みしてください。', 'info', false); }
});

let lastTime = performance.now(), lastSave = lastTime;
setInterval(() => {
  const now = performance.now(); const dt = Math.min(2, (now - lastTime) / 1000); lastTime = now;
  if (game.speed > 0 && !isDialogOpen()) { E.tick(game, dt * game.speed); renderHeader(); dirty = true; }
  if (dirty && now - lastSave >= 1600) { saveNow(); lastSave = now; }
}, 250);

renderHeader(); renderCost(); renderLists(); renderEndpoints(); renderLayers(); renderGradeMeasurement(); renderHint(); updateMap();
if (currentMessage) message(currentMessage, 'error');
if (E.loadEconomicData) E.loadEconomicData(game).then(result => { constructionCache = null; renderCost(); const cells = E.getPopulationCells(); populationReady = cells.length > 0; map.setPopulationData(cells); renderLayers(); updateMap(); if (!result.landPrices) message('地価データを取得できないため、用地費は仮の地価で計算しています。', 'info'); if (game.populationVisible && !populationReady) message('人口データを取得できませんでした。再読み込みしてください。', 'info'); });
receiveShare();
