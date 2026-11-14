export const CLOCK_SPEED_PRESETS = Object.freeze([1, 10, 60, 300]);
export const MAX_CLOCK_SPEED = 86_400;

function parseSpeed(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
    value = Number(text);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_CLOCK_SPEED) return null;
  return value === 0 ? 0 : value;
}

/** Clock speed is game seconds per real second. No game or DOM is mutated. */
export function createClockControls(initialSpeed = 0) {
  let speed = parseSpeed(initialSpeed);
  if (speed === null) throw new RangeError('進行速度は0〜86,400秒の数値で指定してください。');
  let lastRunningSpeed = speed > 0 ? speed : CLOCK_SPEED_PRESETS[0];

  function getState() {
    const chosen = speed > 0 ? speed : lastRunningSpeed;
    return { speed, lastRunningSpeed, paused: speed === 0, activePreset: CLOCK_SPEED_PRESETS.includes(chosen) ? chosen : null };
  }

  return Object.freeze({
    getState,
    setSpeed(value) {
      const next = parseSpeed(value);
      if (next === null) return { ok: false, error: '進行速度は0〜86,400秒の数値で入力してください。', state: getState() };
      speed = next;
      if (speed > 0) lastRunningSpeed = speed;
      return { ok: true, state: getState() };
    },
    togglePause() {
      speed = speed > 0 ? 0 : lastRunningSpeed;
      return { ok: true, state: getState() };
    },
  });
}
