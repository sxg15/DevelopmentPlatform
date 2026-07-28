import { normalizeToolMode } from './startupMode.js';

export function decorateRoleState(roleState, configuredMode, openAtLogin) {
  const mode = normalizeToolMode(configuredMode);
  if (!mode || roleState?.mode !== mode) {
    return null;
  }
  return {
    ...roleState,
    appMode: mode,
    openAtLogin: Boolean(openAtLogin),
  };
}
