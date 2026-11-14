import test from 'node:test';
import assert from 'node:assert/strict';
import { readProgress, resetProgress } from '../dist/persistence.js';
import { createGame, deserializeGame, serializeGame } from '../dist/engine.js';

const keys = { current: 'current', slots: 'slots', active: 'active', unlimited: 'unlimited' };
const storage = data => ({ getItem: key => data[key] ?? null });

test('corrupt current state preserves named saves and detaches autosave to protect them', () => {
  const slots = [{ id: 'healthy', name: 'バックアップ', data: serializeGame(createGame()), updatedAt: 1 }];
  const restored = readProgress(storage({ current: '{bad json', slots: JSON.stringify(slots), active: 'healthy', unlimited: '1' }), keys, createGame, deserializeGame);
  assert.deepEqual(restored.slots, slots);
  assert.equal(restored.activeSlot, null);
  assert.equal(restored.game.unlimited, true);
  assert.equal(restored.warnings.length, 1);
});

test('corrupt slot metadata does not discard a healthy current game', () => {
  const game = createGame(); game.money = 555; game.speed = 3600;
  const restored = readProgress(storage({ current: serializeGame(game), slots: 'broken' }), keys, createGame, deserializeGame);
  assert.equal(restored.game.money, 555);
  assert.equal(restored.game.speed, 3600);
  assert.equal(restored.slots.length, 0);
  assert.equal(restored.warnings.length, 1);
});

test('storage access failures leave a usable initial game', () => {
  const restored = readProgress({ getItem() { throw new Error('Storage disabled'); } }, keys, createGame, deserializeGame);
  assert.equal(restored.game.money, 100_000_000_000);
  assert.equal(restored.slots.length, 0);
  assert.equal(restored.activeSlot, null);
});

function writableStorage(initial = {}) {
  const values = new Map(Object.entries(initial)), calls = [];
  return {
    values, calls,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { calls.push(['set', key]); values.set(key, String(value)); },
    removeItem(key) { calls.push(['remove', key]); values.delete(key); },
  };
}

test('new game clears current progress, selected save, and unlimited lock while preserving named saves', () => {
  const game = createGame(); game.money = 123; game.unlimited = true;
  const savedSlots = JSON.stringify([{ id: 'backup', name: '保存枠', data: serializeGame(game) }]);
  const records = writableStorage({ current: serializeGame(game), active: 'backup', unlimited: '1', slots: savedSlots, unrelated: 'keep' });
  const result = resetProgress(records, keys);
  assert.equal(result.ok, true);
  assert.equal(result.clearNamedSaves, false);
  assert.equal(records.getItem(keys.slots), savedSlots);
  assert.equal(records.getItem('unrelated'), 'keep');
  assert.equal(records.getItem(keys.current), null);
  assert.equal(records.getItem(keys.active), null);
  assert.equal(records.getItem(keys.unlimited), null);
  assert.deepEqual(records.calls.at(-1), ['remove', keys.current], 'current is the final cross-tab notification');
  const restored = readProgress(records, keys, createGame, deserializeGame);
  assert.equal(restored.game.money, 100_000_000_000);
  assert.equal(restored.game.unlimited, false);
  assert.equal(restored.activeSlot, null);
  assert.equal(restored.slots.length, 1);
});

test('full reset removes only the game keys and leaves other local storage records intact', () => {
  const records = writableStorage({ current: 'progress', active: 'save', unlimited: '1', slots: 'named saves', 'other-app.session': 'untouched', 'railway-clone.unrelated': 'also untouched' });
  const result = resetProgress(records, keys, { clearNamedSaves: true });
  assert.equal(result.ok, true);
  assert.equal(result.clearNamedSaves, true);
  assert.deepEqual(Object.fromEntries(records.values), { 'other-app.session': 'untouched', 'railway-clone.unrelated': 'also untouched' });
  assert.deepEqual(result.clearedKeys, [keys.active, keys.unlimited, keys.slots, keys.current]);
});

test('a failed reset restores exact original records, including malformed save strings', () => {
  const initial = { current: '{malformed current', active: 'save', unlimited: '1', slots: '{malformed slots', unrelated: 'keep' };
  for (const failedKey of [keys.active, keys.unlimited, keys.slots, keys.current]) {
    const records = writableStorage(initial), remove = records.removeItem; let failOnce = true;
    records.removeItem = function(key) { if (key === failedKey && failOnce) { failOnce = false; throw new Error('Storage failure'); } return remove.call(this, key); };
    const result = resetProgress(records, keys, { clearNamedSaves: true });
    assert.equal(result.ok, false, failedKey);
    assert.equal(result.rollbackFailed, false, failedKey);
    assert.deepEqual(Object.fromEntries(records.values), initial, failedKey);
  }
});

test('unreadable storage does not begin a reset and does not discard records', () => {
  const records = writableStorage({ current: 'saved', slots: 'backups' });
  records.getItem = () => { throw new Error('Access denied'); };
  const result = resetProgress(records, keys, { clearNamedSaves: true });
  assert.equal(result.ok, false);
  assert.equal(result.rollbackFailed, false);
  assert.deepEqual(records.calls, []);
  assert.deepEqual(Object.fromEntries(records.values), { current: 'saved', slots: 'backups' });
});

test('a reset reports restoration failures instead of claiming data was safely reset', () => {
  const records = writableStorage({ current: 'old', active: 'selected', unlimited: '1', slots: 'saved slots' });
  const remove = records.removeItem;
  records.removeItem = function(key) { if (key === keys.unlimited) throw new Error('Remove failed'); return remove.call(this, key); };
  records.setItem = () => { throw new Error('Quota exceeded'); };
  const result = resetProgress(records, keys, { clearNamedSaves: true });
  assert.equal(result.ok, false);
  assert.equal(result.rollbackFailed, true);
  assert.equal(records.getItem(keys.current), 'old');
  assert.equal(records.getItem(keys.slots), 'saved slots');
});

test('a concurrent newer save is not overwritten by reset rollback', () => {
  const records = writableStorage({ current: 'old progress', active: 'save', unlimited: '1' }), remove = records.removeItem;
  records.removeItem = function(key) {
    remove.call(this, key);
    if (key === keys.current) this.values.set(key, 'newer progress from another tab');
  };
  const result = resetProgress(records, keys);
  assert.equal(result.ok, false);
  assert.equal(result.rollbackFailed, true);
  assert.equal(records.getItem(keys.current), 'newer progress from another tab');
  assert.equal(records.getItem(keys.active), 'save');
  assert.equal(records.getItem(keys.unlimited), '1');
});

test('a reset rejects overlapping key names that could erase a preserved save slot', () => {
  const records = writableStorage({ slots: 'backups' });
  const result = resetProgress(records, { ...keys, current: keys.slots });
  assert.equal(result.ok, false);
  assert.equal(records.getItem(keys.slots), 'backups');
  assert.deepEqual(records.calls, []);
});
