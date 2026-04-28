/**
 * Socket.IO relay for admin effects / soundboard — room-scoped events from server.
 */
(function adminSyncModule() {
  'use strict';

  function wireSocket(s) {
    if (s.__adminSyncWired) return;
    s.__adminSyncWired = true;

    s.on('admin-sync-effect', function (payload) {
      console.log('[admin-sync] effect received', payload);
      if (window.EffectsSync && payload && payload.action) {
        window.EffectsSync.applyAction(payload.action, 'remote');
      }
      window.dispatchEvent(
        new CustomEvent('admin-received-hint', {
          detail: { kind: 'effect', action: payload && payload.action },
        }),
      );
    });

    s.on('admin-sync-sound', function (payload) {
      console.log('[admin-sync] sound received', payload);
      if (window.SoundboardSfx && payload && payload.id) {
        window.SoundboardSfx.play(payload.id, 'remote');
      }
      window.dispatchEvent(
        new CustomEvent('admin-received-hint', {
          detail: { kind: 'sound', id: payload && payload.id },
        }),
      );
    });
  }

  function tryWire() {
    var s = window.__VIDEO_CALL_SOCKET__;
    if (s) {
      wireSocket(s);
      return;
    }
    setTimeout(tryWire, 80);
  }

  tryWire();
})();
