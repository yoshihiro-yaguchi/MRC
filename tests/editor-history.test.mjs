import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorHistory } from '../dist/editor-history.js';

test('editor history traverses labeled edits in both directions and exposes the next actions', () => {
  const history = createEditorHistory();
  assert.equal(history.canUndo, false); assert.equal(history.canRedo, false);
  assert.equal(history.undoLabel, ''); assert.equal(history.redoLabel, '');
  assert.equal(history.undo(), null); assert.equal(history.redo(), null);
  history.record({ points: [] }, { points: [1] }, '点を追加');
  history.record({ points: [1] }, { points: [1, 2] }, '2点目を追加');
  assert.equal(history.undoLabel, '2点目を追加');
  assert.deepEqual(history.undo(), { snapshot: { points: [1] }, label: '2点目を追加' });
  assert.equal(history.undoLabel, '点を追加'); assert.equal(history.redoLabel, '2点目を追加');
  assert.deepEqual(history.undo(), { snapshot: { points: [] }, label: '点を追加' });
  assert.equal(history.canUndo, false); assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(), { snapshot: { points: [1] }, label: '点を追加' });
  assert.deepEqual(history.redo(), { snapshot: { points: [1, 2] }, label: '2点目を追加' });
  assert.equal(history.canRedo, false); assert.equal(history.redoLabel, '');
});

test('recorded and returned nested snapshots cannot be mutated through caller references', () => {
  const history = createEditorHistory(), before = { drafts: [{ points: [{ lat: 35, lng: 139 }] }] }, after = structuredClone(before);
  after.drafts[0].points[0].lat = 36;
  history.record(before, after, '点を移動');
  before.drafts[0].points[0].lat = 0; after.drafts[0].points.push({ lat: 0, lng: 0 });
  const undone = history.undo(); assert.equal(undone.snapshot.drafts[0].points[0].lat, 35);
  undone.snapshot.drafts[0].points[0].lat = 1;
  const redone = history.redo(); assert.equal(redone.snapshot.drafts[0].points.length, 1); assert.equal(redone.snapshot.drafts[0].points[0].lat, 36);
  redone.snapshot.drafts.length = 0;
  assert.equal(history.undo().snapshot.drafts[0].points[0].lat, 35);
});

test('no-op and repeated records are ignored without destroying redo, including property-order-only changes', () => {
  const history = createEditorHistory();
  const before = { point: { lat: 35, lng: 139 }, type: 'single' }, after = { point: { lat: 36, lng: 139 }, type: 'single' };
  assert.equal(history.record(before, after, '移動'), true);
  assert.equal(history.record(before, after, '重複通知'), false);
  history.undo();
  assert.equal(history.record(before, { type: 'single', point: { lng: 139, lat: 35 } }, '変化なし'), false);
  assert.equal(history.canRedo, true); assert.equal(history.redoLabel, '移動');
  assert.deepEqual(history.redo(before).snapshot, after);
  assert.deepEqual(history.undo().snapshot, before); assert.equal(history.undo(), null);
});

test('a new edit after undo invalidates the old future while keeping earlier undo actions', () => {
  const history = createEditorHistory();
  history.record(0, 1, '1'); history.record(1, 2, '2'); history.record(2, 3, '3');
  assert.equal(history.undo(3).snapshot, 2);
  history.record(2, 4, '別の編集');
  assert.equal(history.canRedo, false); assert.equal(history.redo(4), null);
  assert.equal(history.undo(4).snapshot, 2); assert.equal(history.undo(2).snapshot, 1); assert.equal(history.undo(1).snapshot, 0);
});

test('capacity evicts only the oldest edits and remains bounded across redo and a new branch', () => {
  const history = createEditorHistory({ limit: 3 });
  for (let i = 0; i < 5; i++) history.record(i, i + 1, String(i));
  assert.equal(history.undo(5).snapshot, 4); assert.equal(history.undo(4).snapshot, 3); assert.equal(history.undo(3).snapshot, 2);
  assert.equal(history.undo(2), null);
  assert.equal(history.redo(2).snapshot, 3); assert.equal(history.redo(3).snapshot, 4); assert.equal(history.redo(4).snapshot, 5);
  history.undo(5); history.record(4, 8, '分岐');
  assert.equal(history.undo(8).snapshot, 4); assert.equal(history.undo(4).snapshot, 3); assert.equal(history.undo(3).snapshot, 2);
  assert.equal(history.undo(2), null); assert.equal(history.redoLabel, '2');
});

test('default capacity retains the latest eighty editing operations', () => {
  const history = createEditorHistory();
  for (let i = 0; i < 85; i++) history.record(i, i + 1);
  let current = 85, count = 0;
  while (history.canUndo) { current = history.undo(current).snapshot; count++; }
  assert.equal(count, 80); assert.equal(current, 5);
});

test('optional current-state guards prevent overwriting outside changes without moving either stack', () => {
  const history = createEditorHistory(); history.record({ x: 1 }, { x: 2 }, '移動');
  assert.equal(history.undo({ x: 3 }), null); assert.equal(history.canUndo, true); assert.equal(history.canRedo, false);
  assert.deepEqual(history.undo({ x: 2 }), { snapshot: { x: 1 }, label: '移動' });
  assert.equal(history.redo({ x: 4 }), null); assert.equal(history.canUndo, false); assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo({ x: 1 }), { snapshot: { x: 2 }, label: '移動' });
  assert.deepEqual(history.undo(undefined).snapshot, { x: 1 });
});

test('clear detaches both history directions and permits a different world to start fresh', () => {
  const history = createEditorHistory(); history.record(0, 1); history.record(1, 2); history.undo(); history.clear();
  assert.equal(history.canUndo, false); assert.equal(history.canRedo, false); assert.equal(history.undoLabel, ''); assert.equal(history.redoLabel, '');
  assert.equal(history.undo(), null); assert.equal(history.redo(), null);
  history.record(null, { world: 'new' }); assert.equal(history.undo().snapshot, null);
});

test('invalid limits and non-JSON input fail before changing valid history', () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity, '3']) assert.throws(() => createEditorHistory({ limit }), RangeError);
  const history = createEditorHistory(), circular = {}; circular.self = circular;
  history.record(0, 1, '有効');
  for (const invalid of [undefined, circular, 1n]) assert.throws(() => history.record(1, invalid), TypeError);
  assert.equal(history.undoLabel, '有効'); assert.equal(history.canRedo, false);
  assert.equal(history.undo(1).snapshot, 0); assert.equal(history.undo(), null);
});
