const TOOL_MODES = new Set(['developer', 'target']);

export function normalizeToolMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return TOOL_MODES.has(mode) ? mode : '';
}

export function resolveStartupMode(savedMode, requestedMode) {
  return normalizeToolMode(requestedMode) || normalizeToolMode(savedMode);
}
