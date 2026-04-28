/**
 * Shared visual effects for admin sync — toggles classes on <html> / <body>.
 * Does not touch WebRTC or media streams.
 */
(function effectsModule(global) {
  'use strict';

  const CL = {
    glow: 'admin-fx-glow',
    pulse: 'admin-fx-pulse',
    dim: 'admin-fx-dim',
    screenPulse: 'admin-fx-screen-pulse',
    shake: 'admin-fx-screen-shake',
  };

  /** @type {(() => void) | null} */
  let onUiSync = null;

  function setUiSyncCallback(fn) {
    onUiSync = typeof fn === 'function' ? fn : null;
  }

  function notifyUi() {
    if (typeof onUiSync === 'function') onUiSync();
  }

  let pulseTimer = null;

  /**
   * @param {string} action
   * @param {'local' | 'remote' | undefined} source
   */
  function applyAction(action, source) {
    const h = document.documentElement;
    const body = document.body;
    if (!body) return;

    const reduceMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    switch (action) {
      case 'toggleGlow':
        h.classList.toggle(CL.glow);
        break;
      case 'togglePulse':
        h.classList.toggle(CL.pulse);
        break;
      case 'toggleDim':
        h.classList.toggle(CL.dim);
        break;
      case 'screenPulse':
        if (pulseTimer) {
          clearTimeout(pulseTimer);
          pulseTimer = null;
        }
        body.classList.remove(CL.screenPulse);
        void body.offsetWidth;
        body.classList.add(CL.screenPulse);
        pulseTimer = setTimeout(function () {
          pulseTimer = null;
          body.classList.remove(CL.screenPulse);
        }, reduceMotion ? 200 : 650);
        break;
      case 'shake':
        body.classList.remove(CL.shake);
        void body.offsetWidth;
        if (!reduceMotion) body.classList.add(CL.shake);
        setTimeout(function () {
          body.classList.remove(CL.shake);
        }, reduceMotion ? 50 : 480);
        break;
      case 'reset':
        if (pulseTimer) {
          clearTimeout(pulseTimer);
          pulseTimer = null;
        }
        h.classList.remove(CL.glow, CL.pulse, CL.dim);
        body.classList.remove(CL.screenPulse, CL.shake);
        break;
      default:
        return;
    }

    notifyUi();

    if (source === 'remote') {
      global.dispatchEvent(new CustomEvent('admin-fx-remote-applied', { detail: { action } }));
    }
  }

  global.EffectsSync = {
    applyAction,
    setUiSyncCallback,
    CL,
  };
})(window);
