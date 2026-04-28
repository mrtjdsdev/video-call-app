/**
 * Developer admin panel — passcode UI; effects + soundboard sync via Socket.IO
 * (see admin-sync.js, effects.js, soundboard.js). Does not patch WebRTC.
 */
(function adminPanelModule() {
  'use strict';

  const PASSCODE = 'afa0009914';

  const SOUND_IDS = ['beep', 'buzzer', 'horn', 'pop', 'alert'];

  let rootEl = null;
  let revealBtn = null;
  let passFlashEl = null;
  let passFlashTimer = null;
  let overlayEl = null;
  let panelEl = null;
  let toastEl = null;
  let recvDetailEl = null;
  let recvHideTimer = null;

  function getSocket() {
    return window.__VIDEO_CALL_SOCKET__ || null;
  }

  function emitEffect(action) {
    const s = getSocket();
    if (!s || !s.connected) {
      showToast('Not connected — join a room first', true);
      return;
    }
    console.log('[admin-panel] emit effect', action);
    s.emit('admin-effect', { action });
  }

  function emitSound(id) {
    const s = getSocket();
    if (!s || !s.connected) {
      showToast('Not connected — join a room first', true);
      return;
    }
    console.log('[admin-panel] emit sound', id);
    s.emit('admin-sound', { id });
  }

  function applyEffectLocalThenSync(action) {
    if (window.EffectsSync) window.EffectsSync.applyAction(action, 'local');
    emitEffect(action);
  }

  function playSoundLocalThenSync(id) {
    if (window.SoundboardSfx) window.SoundboardSfx.play(id, 'local');
    emitSound(id);
  }

  function syncFxButtons() {
    if (!panelEl || !window.EffectsSync) return;
    const h = document.documentElement;
    const CL = window.EffectsSync.CL;
    const setActive = function (name, on) {
      const b = panelEl.querySelector('[data-admin-fx="' + name + '"]');
      if (b) b.classList.toggle('admin-panel__btn--active', on);
    };
    setActive('glow', h.classList.contains(CL.glow));
    setActive('pulse', h.classList.contains(CL.pulse));
    setActive('dim', h.classList.contains(CL.dim));
  }

  function showToast(msg, isError) {
    if (!toastEl) return;
    toastEl.textContent = msg || '';
    toastEl.style.color = isError ? '#ff8a80' : 'rgba(255,255,255,0.5)';
  }

  function clearToast() {
    showToast('', false);
  }

  function showRecvDetail(text) {
    if (!recvDetailEl) return;
    recvDetailEl.textContent = text || '';
    if (recvHideTimer) clearTimeout(recvHideTimer);
    recvHideTimer = setTimeout(function () {
      recvHideTimer = null;
      if (recvDetailEl) recvDetailEl.textContent = '';
    }, 4500);
  }

  function onReceivedHint(ev) {
    const d = ev && ev.detail;
    if (!d) return;
    if (d.kind === 'effect') {
      showRecvDetail('Effect: ' + (d.action || ''));
    } else if (d.kind === 'sound') {
      showRecvDetail('Sound: ' + (d.id || ''));
    }
  }

  function openPanel() {
    if (!overlayEl || !panelEl) return;
    overlayEl.classList.add('admin-overlay--open');
    panelEl.classList.add('admin-panel--open');
    overlayEl.setAttribute('aria-hidden', 'false');
    panelEl.setAttribute('aria-hidden', 'false');
    clearToast();
    syncFxButtons();
  }

  function closePanel() {
    if (!overlayEl || !panelEl) return;
    overlayEl.classList.remove('admin-overlay--open');
    panelEl.classList.remove('admin-panel--open');
    overlayEl.setAttribute('aria-hidden', 'true');
    panelEl.setAttribute('aria-hidden', 'true');
    clearToast();
  }

  function showPassFlash(msg) {
    if (!passFlashEl) return;
    passFlashEl.textContent = msg;
    passFlashEl.classList.add('admin-pass-flash--show');
    if (passFlashTimer) clearTimeout(passFlashTimer);
    passFlashTimer = setTimeout(function () {
      passFlashTimer = null;
      passFlashEl.classList.remove('admin-pass-flash--show');
      passFlashEl.textContent = '';
    }, 2200);
  }

  function onRevealClick() {
    clearToast();
    var entered = window.prompt('Passcode:');
    if (entered === null) return;
    if (entered !== PASSCODE) {
      showPassFlash('Incorrect passcode');
      if (revealBtn) {
        revealBtn.classList.remove('admin-reveal--shake');
        void revealBtn.offsetWidth;
        revealBtn.classList.add('admin-reveal--shake');
      }
      return;
    }
    openPanel();
  }

  function buildDom() {
    revealBtn = document.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = 'admin-reveal';
    revealBtn.title = 'Developer';
    revealBtn.setAttribute('aria-label', 'Open developer panel');
    revealBtn.innerHTML = '<span class="admin-reveal__glyph" aria-hidden="true">◇</span>';
    revealBtn.addEventListener('click', onRevealClick);

    passFlashEl = document.createElement('div');
    passFlashEl.className = 'admin-pass-flash';
    passFlashEl.setAttribute('aria-live', 'polite');

    overlayEl = document.createElement('div');
    overlayEl.className = 'admin-overlay';
    overlayEl.setAttribute('aria-hidden', 'true');
    overlayEl.addEventListener('click', closePanel);

    panelEl = document.createElement('aside');
    panelEl.className = 'admin-panel';
    panelEl.setAttribute('aria-hidden', 'true');
    panelEl.setAttribute('aria-label', 'Developer panel');
    panelEl.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });

    var soundButtons = SOUND_IDS.map(function (id) {
      return (
        '<button type="button" class="admin-panel__btn" data-admin-sound="' +
        id +
        '">' +
        id.charAt(0).toUpperCase() +
        id.slice(1) +
        '</button>'
      );
    }).join('');

    panelEl.innerHTML =
      '<div class="admin-panel__head">' +
      '<h2 class="admin-panel__title">Developer</h2>' +
      '<button type="button" class="admin-panel__close" aria-label="Close panel">&times;</button>' +
      '</div>' +
      '<p class="admin-panel__hint">When two people are in the same room, effects and sounds sync to the other client. WebRTC is unchanged.</p>' +
      '<div class="admin-panel__toast" aria-live="polite"></div>' +
      '<div>' +
      '<span class="admin-panel__send-label">Send to other user</span>' +
      '<h3 class="admin-panel__section-title">Effects</h3>' +
      '<div class="admin-panel__grid">' +
      '<button type="button" class="admin-panel__btn" data-admin-fx="glow">Glow mode</button>' +
      '<button type="button" class="admin-panel__btn" data-admin-fx="pulse">Pulse background</button>' +
      '<button type="button" class="admin-panel__btn" data-admin-action="screen-pulse">Screen pulse</button>' +
      '<button type="button" class="admin-panel__btn" data-admin-action="shake">Screen shake</button>' +
      '<button type="button" class="admin-panel__btn" data-admin-fx="dim">Dim mode</button>' +
      '<button type="button" class="admin-panel__btn" data-admin-action="reset-fx">Reset effects</button>' +
      '</div></div>' +
      '<div>' +
      '<h3 class="admin-panel__section-title">Soundboard</h3>' +
      '<div class="admin-panel__grid">' +
      soundButtons +
      '</div></div>' +
      '<div class="admin-panel__row">' +
      '<span class="admin-panel__toggle">Soundboard mute</span>' +
      '<button type="button" class="admin-panel__btn" data-admin-action="toggle-mute" style="max-width:100px;padding:0.4rem 0.6rem;font-size:0.75rem;">Toggle</button>' +
      '</div>' +
      '<div class="admin-panel__recv" aria-live="polite">' +
      '<span class="admin-panel__recv-label">Received from other user</span>' +
      '<span class="admin-panel__recv-detail"></span>' +
      '</div>';

    toastEl = panelEl.querySelector('.admin-panel__toast');
    recvDetailEl = panelEl.querySelector('.admin-panel__recv-detail');

    panelEl.querySelector('.admin-panel__close').addEventListener('click', closePanel);

    panelEl.querySelector('[data-admin-fx="glow"]').addEventListener('click', function () {
      applyEffectLocalThenSync('toggleGlow');
    });
    panelEl.querySelector('[data-admin-fx="pulse"]').addEventListener('click', function () {
      applyEffectLocalThenSync('togglePulse');
    });
    panelEl.querySelector('[data-admin-fx="dim"]').addEventListener('click', function () {
      applyEffectLocalThenSync('toggleDim');
    });
    panelEl.querySelector('[data-admin-action="screen-pulse"]').addEventListener('click', function () {
      applyEffectLocalThenSync('screenPulse');
    });
    panelEl.querySelector('[data-admin-action="shake"]').addEventListener('click', function () {
      applyEffectLocalThenSync('shake');
    });
    panelEl.querySelector('[data-admin-action="reset-fx"]').addEventListener('click', function () {
      applyEffectLocalThenSync('reset');
    });

    panelEl.querySelectorAll('[data-admin-sound]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-admin-sound');
        if (!id) return;
        playSoundLocalThenSync(id);
      });
    });

    panelEl.querySelector('[data-admin-action="toggle-mute"]').addEventListener('click', function () {
      if (!window.SoundboardSfx) return;
      var nowMuted = !window.SoundboardSfx.isMuted();
      window.SoundboardSfx.setMuted(nowMuted);
      showToast(nowMuted ? 'Soundboard muted' : 'Soundboard on', false);
    });

    rootEl = document.createElement('div');
    rootEl.id = 'admin-panel-root';
    rootEl.appendChild(passFlashEl);
    rootEl.appendChild(revealBtn);
    rootEl.appendChild(overlayEl);
    rootEl.appendChild(panelEl);
    document.body.appendChild(rootEl);

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && panelEl && panelEl.classList.contains('admin-panel--open')) {
        closePanel();
      }
    });

    window.addEventListener('admin-received-hint', onReceivedHint);

    if (window.EffectsSync) {
      window.EffectsSync.setUiSyncCallback(syncFxButtons);
    }
  }

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
      return;
    }
    if (document.getElementById('admin-panel-root')) return;
    buildDom();
  }

  init();
})();
