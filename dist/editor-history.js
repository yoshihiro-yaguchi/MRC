// History contains editor snapshots only. Callers decide which operations form
// one edit, and clear it when loading or replacing the editor's world.
function snapshotKey(value) {
  let json;
  try { json = JSON.stringify(value); }
  catch { throw new TypeError('編集履歴の状態はJSONとして保存できる値にしてください。'); }
  if (json === undefined) throw new TypeError('編集履歴の状態はJSONとして保存できる値にしてください。');
  // JSON normalization takes an independent copy. Sorted object keys make
  // equal snapshots compare equally even when their properties were reordered.
  const canonical = item => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
  };
  return canonical(JSON.parse(json));
}

/**
 * record(before, after, label) returns whether an edit was added.
 * undo(current?) / redo(current?) return { snapshot, label }, or null.
 * When supplied, current must equal the expected state before moving history.
 * Each successful read returns a new JSON copy; no caller-owned references stay.
 */
export function createEditorHistory({ limit = 80 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('編集履歴の上限は1以上の整数にしてください。');
  const past = [], future = [];
  return Object.freeze({
    record(before, after, label = '編集') {
      const from = snapshotKey(before), to = snapshotKey(after);
      if (from === to) return false;
      const previous = past.at(-1);
      if (previous?.before === from && previous.after === to) return false;
      const entry = { before: from, after: to, label: typeof label === 'string' && label.trim() ? label : '編集' };
      future.length = 0; past.push(entry);
      if (past.length > limit) past.splice(0, past.length - limit);
      return true;
    },
    undo(current) {
      const entry = past.at(-1);
      if (!entry || (current !== undefined && snapshotKey(current) !== entry.after)) return null;
      past.pop(); future.push(entry);
      return { snapshot: JSON.parse(entry.before), label: entry.label };
    },
    redo(current) {
      const entry = future.at(-1);
      if (!entry || (current !== undefined && snapshotKey(current) !== entry.before)) return null;
      future.pop(); past.push(entry);
      return { snapshot: JSON.parse(entry.after), label: entry.label };
    },
    clear() { past.length = 0; future.length = 0; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get undoLabel() { return past.at(-1)?.label || ''; },
    get redoLabel() { return future.at(-1)?.label || ''; },
  });
}
