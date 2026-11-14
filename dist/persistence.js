// Each record is recovered independently: a damaged current game must never hide
// or overwrite otherwise healthy named saves.
export function readProgress(storage, keys, createGame, deserializeGame) {
  const result = { game: createGame(), slots: [], activeSlot: null, warnings: [] };
  let restoredCurrent = false;
  try { const value = storage.getItem(keys.current); if (value) { result.game = deserializeGame(value); restoredCurrent = true; } }
  catch { result.warnings.push('現在のセーブを読み込めませんでした。名前付きセーブがあれば、セーブ画面から復元できます。'); }
  try {
    const value = storage.getItem(keys.slots);
    if (value) {
      const slots = JSON.parse(value);
      if (!Array.isArray(slots)) throw new Error('Invalid saved slots');
      result.slots = slots.filter(s => s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.data === 'string').slice(0, 100);
    }
  } catch { result.warnings.push('名前付きセーブの一覧を読み込めませんでした。'); }
  try { const active = storage.getItem(keys.active); if (restoredCurrent && result.slots.some(s => s.id === active)) result.activeSlot = active; }
  catch { /* Named saves remain usable even if their active pointer is unavailable. */ }
  try { if (storage.getItem(keys.unlimited) === '1') result.game.unlimited = true; }
  catch { /* The serialized game also records this setting. */ }
  return result;
}

export function hasUnlimitedLock(storage, keys) {
  try { return storage.getItem(keys.unlimited) === '1'; } catch { return false; }
}

// Remove only this game's records. Keep current last so other open tabs can use
// its removal as a reset notification after the lock and save selection cleared.
// Callers must discard their old in-memory game only after this returns ok.
export function resetProgress(storage, keys, { clearNamedSaves = false } = {}) {
  const appKeys = ['current', 'slots', 'active', 'unlimited'].map(name => keys?.[name]);
  if (appKeys.some(key => typeof key !== 'string' || !key) || new Set(appKeys).size !== appKeys.length
      || !storage || ['getItem', 'setItem', 'removeItem'].some(name => typeof storage[name] !== 'function')) {
    return { ok: false, error: '保存データの初期化設定が正しくありません。', rollbackFailed: false };
  }
  const clearedKeys = [keys.active, keys.unlimited, ...(clearNamedSaves ? [keys.slots] : []), keys.current];
  const before = new Map();
  try {
    for (const key of clearedKeys) before.set(key, storage.getItem(key));
  } catch {
    return { ok: false, error: '保存データを読み取れなかったため、初期化していません。', rollbackFailed: false };
  }
  try {
    for (const key of clearedKeys) storage.removeItem(key);
    // Detect adapters that silently reject writes, or another tab that wrote a
    // record during this reset, rather than reporting a reset that did not stick.
    if (clearedKeys.some(key => storage.getItem(key) !== null)) throw new Error('Reset was not retained');
    return { ok: true, clearNamedSaves: !!clearNamedSaves, clearedKeys };
  } catch {
    let rollbackFailed = false;
    for (const key of [...clearedKeys].reverse()) {
      try {
        const value = storage.getItem(key), previous = before.get(key);
        if (value === previous) continue;
        // A different non-null value belongs to a concurrent writer. Do not
        // replace that newer progress with this tab's stale backup.
        if (value !== null) { rollbackFailed = true; continue; }
        if (previous !== null) storage.setItem(key, previous);
        if (storage.getItem(key) !== previous) rollbackFailed = true;
      } catch { rollbackFailed = true; }
    }
    return {
      ok: false,
      rollbackFailed,
      error: rollbackFailed
        ? '初期化を完了できず、保存データの復元も一部失敗しました。ページを閉じずにファイルへ書き出してください。'
        : '初期化に失敗しました。元の保存データは保持されています。',
    };
  }
}
