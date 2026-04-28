/**
 * Dynamic Island–style call status UI.
 * State only — does not touch PeerJS or sockets.
 */
(() => {
  const root = () => document.getElementById('dynamicIsland');

  let leadEl;
  let timerEl;
  let connDotEl;
  let dotsEl;
  let micEl;
  let timerIntervalId = null;
  let activeStartedAt = null;
  let endedReturnTimerId = null;
  let pcCleanup = null;

  function $(sel, base) {
    return (base || root()).querySelector(sel);
  }

  function init() {
    const r = root();
    if (!r) return;
    leadEl = $('.di__lead', r);
    timerEl = $('.di__timer', r);
    connDotEl = $('.di__conn-dot', r);
    dotsEl = $('.di__dots', r);
    micEl = $('.di__mic', r);
  }

  function clearTimer() {
    if (timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
    activeStartedAt = null;
    if (timerEl) {
      timerEl.hidden = true;
      timerEl.textContent = '';
    }
  }

  function clearEndedReturn() {
    if (endedReturnTimerId) {
      clearTimeout(endedReturnTimerId);
      endedReturnTimerId = null;
    }
  }

  function detachPeerConnection() {
    if (typeof pcCleanup === 'function') {
      pcCleanup();
      pcCleanup = null;
    }
  }

  function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function startCallTimer() {
    clearTimer();
    activeStartedAt = Date.now();
    if (timerEl) {
      timerEl.hidden = false;
      timerEl.textContent = '0:00';
    }
    timerIntervalId = setInterval(() => {
      if (!timerEl || !activeStartedAt) return;
      timerEl.textContent = formatElapsed(Date.now() - activeStartedAt);
    }, 1000);
  }

  function setState(state) {
    const r = root();
    if (!r) return;
    r.dataset.state = state;
    r.classList.remove(
      'di--idle',
      'di--connecting',
      'di--waiting',
      'di--active',
      'di--ended',
      'di--issue',
    );
    r.classList.add('di--' + state);
  }

  function setIssue(message) {
    const r = root();
    if (!r) return;
    r.classList.remove('di--hidden');
    setState('issue');
    setLead(message || 'Something went wrong');
    setDotsVisible(false);
    setConnDotVisible(false);
    setMicVisible(false);
    clearTimer();
    detachPeerConnection();
  }

  function setLead(text) {
    if (leadEl) leadEl.textContent = text || '';
  }

  function setDotsVisible(on) {
    if (dotsEl) dotsEl.hidden = !on;
  }

  function setConnDotVisible(on) {
    if (connDotEl) connDotEl.hidden = !on;
  }

  function setMicVisible(on) {
    if (micEl) micEl.hidden = !on;
  }

  /** Lobby: island not shown (call panel hidden). */
  function hide() {
    const r = root();
    if (!r) return;
    setState('idle');
    setLead('');
    setDotsVisible(false);
    setConnDotVisible(false);
    setMicVisible(false);
    clearTimer();
    clearEndedReturn();
    detachPeerConnection();
    r.classList.add('di--hidden');
  }

  /** Call UI opened — compact → expanded “Connecting…”. */
  function enterCall() {
    const r = root();
    if (!r) return;
    r.classList.remove('di--hidden');
    setState('connecting');
    setLead('Connecting…');
    setDotsVisible(false);
    setConnDotVisible(false);
    setMicVisible(false);
    clearTimer();
    clearEndedReturn();
  }

  function setWaiting() {
    const r = root();
    if (!r) return;
    r.classList.remove('di--hidden');
    setState('waiting');
    setLead('Waiting');
    setDotsVisible(true);
    setConnDotVisible(false);
    setMicVisible(false);
    clearTimer();
    detachPeerConnection();
  }

  /** @param {{ dots?: boolean }} [opts] — animated dots (e.g. while waiting for peer). */
  function setConnecting(message, opts) {
    const o = opts || {};
    const r = root();
    if (!r) return;
    r.classList.remove('di--hidden');
    setState('connecting');
    setLead(message || 'Connecting…');
    setDotsVisible(o.dots === true);
    setConnDotVisible(false);
    setMicVisible(false);
    clearTimer();
  }

  function setRinging() {
    setConnecting('Ringing…', { dots: false });
  }

  function setPeerJoined() {
    setConnecting('Someone joined', { dots: true });
  }

  /** Remote media flowing — timer + status dot + mic hint. */
  function setActive() {
    const r = root();
    if (!r) return;
    r.classList.remove('di--hidden');
    setState('active');
    setLead('Call active');
    setDotsVisible(false);
    setConnDotVisible(true);
    setMicVisible(true);
    startCallTimer();
  }

  function setMicMuted(muted) {
    if (!micEl) return;
    micEl.dataset.muted = muted ? 'true' : 'false';
    micEl.setAttribute('aria-label', muted ? 'Microphone muted' : 'Microphone on');
  }

  /** Underlying RTCPeerConnection lifecycle (PeerJS exposes this). */
  function attachMediaConnection(call) {
    detachPeerConnection();
    const pc = call && call.peerConnection;
    if (!pc) return;

    const onConn = () => {
      const s = pc.connectionState;
      if (s === 'failed') {
        setState('issue');
        setLead('Connection lost');
        setDotsVisible(false);
        setConnDotVisible(false);
        clearTimer();
      }
    };
    pc.addEventListener('connectionstatechange', onConn);
    pcCleanup = () => {
      pc.removeEventListener('connectionstatechange', onConn);
    };
  }

  /** Remote party left — brief “Call ended” then back to waiting if still in the room. */
  function onRemoteDisconnected() {
    const r = root();
    if (!r) return;
    clearEndedReturn();
    detachPeerConnection();
    clearTimer();
    setState('ended');
    setLead('Call ended');
    setDotsVisible(false);
    setConnDotVisible(false);
    setMicVisible(false);

    endedReturnTimerId = setTimeout(() => {
      endedReturnTimerId = null;
      const panel = document.getElementById('callPanel');
      if (!panel || panel.classList.contains('hidden')) {
        hide();
        return;
      }
      setWaiting();
    }, 2200);
  }

  window.IslandUI = {
    init,
    hide,
    enterCall,
    setWaiting,
    setConnecting,
    setRinging,
    setPeerJoined,
    setActive,
    setMicMuted,
    setIssue,
    attachMediaConnection,
    detachPeerConnection,
    onRemoteDisconnected,
    clearTimer,
  };
})();
