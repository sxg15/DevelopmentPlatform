let lockCount = 0;
let rootWasInert = false;
let previouslyFocused = null;

export function acquirePageInteractionLock(focusTarget) {
  const appRoot = document.getElementById('root');
  if (lockCount === 0) {
    rootWasInert = appRoot?.hasAttribute('inert') === true;
    previouslyFocused = document.activeElement;
    appRoot?.setAttribute('inert', '');
    document.documentElement.classList.add('global-page-interaction-lock');
    document.body.classList.add('global-page-interaction-lock');
  }
  lockCount += 1;
  window.requestAnimationFrame(() => focusTarget?.()?.focus?.());

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount > 0) {
      return;
    }

    if (!rootWasInert) {
      appRoot?.removeAttribute('inert');
    }
    document.documentElement.classList.remove('global-page-interaction-lock');
    document.body.classList.remove('global-page-interaction-lock');
    if (previouslyFocused?.isConnected && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
    rootWasInert = false;
    previouslyFocused = null;
  };
}
