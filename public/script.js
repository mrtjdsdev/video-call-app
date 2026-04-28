(() => {
  const joinPanel = document.getElementById('joinPanel');
  const callPanel = document.getElementById('callPanel');
  const roomInput = document.getElementById('roomInput');
  const joinBtn = document.getElementById('joinBtn');
  const joinStatus = document.getElementById('joinStatus');
  const callStatus = document.getElementById('callStatus');
  const localVideo = document.getElementById('localVideo');
  const pipGlass = document.querySelector('.pip-glass');
  const remoteVideo = document.getElementById('remoteVideo');
  const muteBtn = document.getElementById('muteBtn');
  const cameraBtn = document.getElementById('cameraBtn');
  const leaveBtn = document.getElementById('leaveBtn');

  const Island = window.IslandUI;

  if (Island && typeof Island.init === 'function') {
    Island.init();
  }
  setupPipDrag();

  const socket = io();

  let localStream = null;
  let peer = null;
  let activeCall = null;
  let didRegisterPeerjs = false;
  let mediaAcquirePromise = null;
  let pendingMediaNotice = '';

  /** Room id for the current join attempt; cleared when we leave the server room or reset. */
  let pendingRoomId = null;
  /** True after server accepted us into a room until we `leave-room` or full cleanup. */
  let inServerRoom = false;
  let streamWatchdogTimer = null;
  let lobbyResetScheduled = false;

  /** Optional mobile UX: drag the local PiP to a better spot. */
  function setupPipDrag() {
    if (!pipGlass) return;
    let dragging = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;
    let moveX = 0;
    let moveY = 0;
    let moved = false;

    function applyTransform() {
      pipGlass.style.transform = `translate(${moveX}px, ${moveY}px)`;
    }

    function clampMove(nextX, nextY) {
      const margin = 8;
      const maxX = Math.max(0, window.innerWidth - pipGlass.offsetWidth - margin * 2);
      const maxY = Math.max(0, window.innerHeight - pipGlass.offsetHeight - margin * 2);
      return {
        x: Math.min(maxX, Math.max(0, nextX)),
        y: Math.min(maxY, Math.max(0, nextY)),
      };
    }

    pipGlass.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      pointerId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      baseX = moveX;
      baseY = moveY;
      moved = false;
      pipGlass.style.transition = 'none';
      pipGlass.setPointerCapture(pointerId);
    });

    pipGlass.addEventListener('pointermove', (ev) => {
      if (!dragging || ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
      const clamped = clampMove(baseX + dx, baseY + dy);
      moveX = clamped.x;
      moveY = clamped.y;
      applyTransform();
    });

    function endDrag(ev) {
      if (!dragging || ev.pointerId !== pointerId) return;
      dragging = false;
      try {
        pipGlass.releasePointerCapture(pointerId);
      } catch (e) {
        /* ignore */
      }
      pointerId = null;
      pipGlass.style.transition = moved ? 'transform 0.18s ease-out' : '';
    }

    pipGlass.addEventListener('pointerup', endDrag);
    pipGlass.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => {
      const clamped = clampMove(moveX, moveY);
      moveX = clamped.x;
      moveY = clamped.y;
      applyTransform();
    });
  }

  function peerPort() {
    if (location.port) return Number(location.port);
    return location.protocol === 'https:' ? 443 : 80;
  }

  function peerOptions() {
    return {
      host: location.hostname,
      port: peerPort(),
      path: '/peerjs',
      secure: location.protocol === 'https:',
    };
  }

  function setJoinMessage(text, isError = false) {
    joinStatus.textContent = text;
    joinStatus.classList.toggle('error', isError);
  }

  function setCallMessage(text) {
    callStatus.textContent = text;
  }

  function userMediaErrorMessage(e) {
    if (!e || !e.name) return 'Could not access camera or microphone';
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      return 'Camera/Mic permission denied — allow access in your browser settings';
    }
    if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
      return 'No camera or microphone found';
    }
    if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
      return 'Camera or microphone is already in use';
    }
    return e.message || 'Could not access camera or microphone';
  }

  function wrapUserMediaError(e) {
    const msg = userMediaErrorMessage(e);
    const wrapped = new Error(msg);
    wrapped.cause = e;
    return wrapped;
  }

  function isDeviceBusyError(e) {
    if (!e) return false;
    if (e.name === 'NotReadableError' || e.name === 'TrackStartError') return true;
    const msg = String(e.message || '').toLowerCase();
    return msg.includes('could not start') || msg.includes('in use') || msg.includes('busy');
  }

  function hasLiveLocalStream() {
    if (!localStream) return false;
    const tracks = localStream.getTracks();
    if (tracks.length === 0) return false;
    return tracks.some((t) => t.readyState === 'live');
  }

  function waitForSocketConnect() {
    return new Promise((resolve) => {
      if (socket.connected) {
        resolve();
        return;
      }
      socket.once('connect', resolve);
    });
  }

  function clearStreamWatchdog() {
    if (streamWatchdogTimer) {
      clearTimeout(streamWatchdogTimer);
      streamWatchdogTimer = null;
    }
  }

  function armStreamWatchdog() {
    clearStreamWatchdog();
    streamWatchdogTimer = setTimeout(() => {
      streamWatchdogTimer = null;
      const hasRemote = remoteVideo.srcObject && remoteVideo.srcObject.getTracks().some((t) => t.readyState === 'live');
      if (hasRemote) return;
      console.warn('[call] no remote media within timeout');
      hangupMedia();
      try {
        if (activeCall) activeCall.close();
      } catch (e) {
        /* ignore */
      }
      activeCall = null;
      scheduleLobbyReset('Could not connect in time. Tap Join to retry.', true);
    }, 35000);
  }

  function emitLeaveRoomIfJoined() {
    if (!inServerRoom) return;
    if (socket.connected) {
      socket.emit('leave-room');
    }
    inServerRoom = false;
    pendingRoomId = null;
  }

  /**
   * Return to lobby without full page reload: leave server room, tear down PeerJS call, optional media.
   */
  function softReturnToLobby(opts) {
    opts = opts || {};
    clearStreamWatchdog();
    lobbyResetScheduled = false;
    hangupMedia();
    emitLeaveRoomIfJoined();
    if (peer) {
      try {
        peer.destroy();
      } catch (e) {
        /* ignore */
      }
      peer = null;
    }
    didRegisterPeerjs = false;
    pendingMediaNotice = '';
    if (!opts.keepMedia) {
      if (localStream) {
        for (const t of localStream.getTracks()) {
          t.stop();
        }
        localStream = null;
        localVideo.srcObject = null;
      }
    }
    joinPanel.classList.remove('hidden');
    callPanel.classList.add('hidden');
    document.body.classList.remove('on-call');
    if (Island) Island.hide();
    setJoinMessage(opts.joinMessage != null ? opts.joinMessage : 'Tap Join to try again.', !!opts.isError);
    if (opts.callMessage != null) setCallMessage(opts.callMessage);
    else setCallMessage('');
    joinBtn.disabled = false;
  }

  function scheduleLobbyReset(joinMessage, isError) {
    if (lobbyResetScheduled) return;
    lobbyResetScheduled = true;
    softReturnToLobby({
      keepMedia: true,
      joinMessage: joinMessage || 'Connection problem. Tap Join to retry.',
      isError: !!isError,
    });
    setTimeout(() => {
      lobbyResetScheduled = false;
    }, 1500);
  }

  function cleanupPrepareFailure() {
    clearStreamWatchdog();
    hangupMedia();
    emitLeaveRoomIfJoined();
    if (peer) {
      try {
        peer.destroy();
      } catch (e) {
        /* ignore */
      }
      peer = null;
    }
    if (localStream) {
      for (const t of localStream.getTracks()) {
        t.stop();
      }
      localStream = null;
      localVideo.srcObject = null;
    }
    didRegisterPeerjs = false;
    pendingMediaNotice = '';
    inServerRoom = false;
    pendingRoomId = null;
  }

  function enterCallView() {
    joinPanel.classList.add('hidden');
    callPanel.classList.remove('hidden');
    document.body.classList.add('on-call');
    if (Island) Island.enterCall();
  }

  function attachLocalTrackEndedGuards() {
    if (!localStream) return;
    for (const track of localStream.getTracks()) {
      track.addEventListener(
        'ended',
        () => {
          if (!hasLiveLocalStream()) {
            console.warn('[call] local media track ended');
            scheduleLobbyReset('Camera or microphone stopped. Tap Join again.', true);
          }
        },
        { once: true },
      );
    }
  }

  async function acquireMediaOnce() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
    } catch (e) {
      if (isDeviceBusyError(e)) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: true,
          });
          pendingMediaNotice = 'Camera already in use by another tab. Reusing stream.';
        } catch (eAudio) {
          try {
            localStream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
            pendingMediaNotice =
              'Microphone may be in use in another tab. Reusing stream (video only).';
          } catch (eVideo) {
            throw wrapUserMediaError(eVideo);
          }
        }
      } else {
        throw wrapUserMediaError(e);
      }
    }

    localVideo.srcObject = localStream;
    try {
      await localVideo.play();
    } catch (playErr) {
      console.warn('[call] localVideo.play failed', playErr && playErr.message);
    }
    attachLocalTrackEndedGuards();
    return localStream;
  }

  async function ensureLocalStream() {
    if (hasLiveLocalStream()) {
      if (localVideo.srcObject !== localStream) {
        localVideo.srcObject = localStream;
      }
      try {
        await localVideo.play();
      } catch (playErr) {
        console.warn('[call] localVideo.play failed', playErr && playErr.message);
      }
      return localStream;
    }

    if (mediaAcquirePromise) {
      return mediaAcquirePromise;
    }

    mediaAcquirePromise = acquireMediaOnce().finally(() => {
      mediaAcquirePromise = null;
    });

    return mediaAcquirePromise;
  }

  async function tryPlayRemote() {
    try {
      await remoteVideo.play();
    } catch (e) {
      console.warn('[call] remoteVideo.play failed', e && e.message);
      setCallMessage('In call — click anywhere on the page once if video or sound does not start.');
    }
  }

  function clearRemote() {
    remoteVideo.srcObject = null;
  }

  function hangupMedia() {
    clearStreamWatchdog();
    if (Island) Island.detachPeerConnection();
    if (activeCall) {
      try {
        activeCall.close();
      } catch (e) {
        /* ignore */
      }
      activeCall = null;
    }
    clearRemote();
  }

  function bindPeerConnectionRecovery(call) {
    const pc = call && call.peerConnection;
    if (!pc) return;

    const onState = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') {
        pc.removeEventListener('connectionstatechange', onState);
        console.warn('[call] RTCPeerConnection', s);
        scheduleLobbyReset('Call disconnected. Tap Join to retry.', true);
      }
    };
    pc.addEventListener('connectionstatechange', onState);
    call.once('close', () => {
      pc.removeEventListener('connectionstatechange', onState);
    });
  }

  function emitPeerjsRegister() {
    if (!peer || !peer.id) {
      return;
    }
    if (didRegisterPeerjs) {
      return;
    }
    didRegisterPeerjs = true;
    socket.emit('peerjs-register', { peerjsId: peer.id });
  }

  function wireMediaConnection(call) {
    hangupMedia();
    activeCall = call;

    if (Island) Island.attachMediaConnection(call);
    bindPeerConnectionRecovery(call);

    call.on('stream', (remoteStream) => {
      clearStreamWatchdog();
      remoteVideo.srcObject = remoteStream;
      tryPlayRemote();
      setCallMessage('In call');
      if (Island) {
        Island.setActive();
        const a = localStream && localStream.getAudioTracks()[0];
        Island.setMicMuted(a ? !a.enabled : false);
      }
    });

    call.on('close', () => {
      if (Island) Island.detachPeerConnection();
      if (activeCall === call) {
        activeCall = null;
      }
      clearRemote();
    });

    call.on('error', (err) => {
      console.warn('[call] MediaConnection error', err && err.message);
      setCallMessage('Call error — tap Join to retry.');
      if (Island) Island.setIssue('Call interrupted');
      scheduleLobbyReset('Call error. Tap Join to retry.', true);
    });
  }

  function onIncomingCall(call) {
    if (!localStream) {
      try {
        call.close();
      } catch (e) {
        /* ignore */
      }
      return;
    }
    if (Island) Island.setConnecting('Connecting…');
    wireMediaConnection(call);
    armStreamWatchdog();
    call.answer(localStream);
    setCallMessage('Connecting…');
  }

  function createPeerAwaitOpen() {
    return new Promise((resolve, reject) => {
      if (typeof Peer === 'undefined') {
        reject(new Error('PeerJS failed to load'));
        return;
      }

      if (peer) {
        try {
          peer.destroy();
        } catch (e) {
          /* ignore */
        }
        peer = null;
      }
      didRegisterPeerjs = false;

      const p = new Peer(undefined, peerOptions());
      peer = p;

      p.on('call', (call) => {
        onIncomingCall(call);
      });

      p.on('disconnected', () => {
        if (peer !== p) return;
        console.warn('[call] PeerJS disconnected from signaling server');
        try {
          if (typeof p.reconnect === 'function') {
            p.reconnect();
          }
        } catch (e) {
          console.warn('[call] peer.reconnect failed', e && e.message);
        }
      });

      let opened = false;
      p.on('error', (err) => {
        console.warn('[call] Peer error', err && err.message);
        setCallMessage('Peer error: ' + (err && err.message ? err.message : 'unknown'));
        if (!opened && Island) {
          Island.setIssue(err && err.message ? err.message : 'Peer error');
        }
        if (!opened) {
          opened = true;
          try {
            p.destroy();
          } catch (e) {
            /* ignore */
          }
          peer = null;
          reject(err);
        }
      });

      p.on('open', () => {
        if (opened) return;
        opened = true;
        resolve(p);
      });
    });
  }

  socket.on('join-error', (msg) => {
    cleanupPrepareFailure();
    setJoinMessage(String(msg), true);
    joinBtn.disabled = false;
  });

  socket.on('waiting', () => {
    inServerRoom = true;
    setJoinMessage('');
    enterCallView();
    joinBtn.disabled = false;
    try {
      if (Island) Island.setConnecting('Connecting…');
      emitPeerjsRegister();
      if (Island) Island.setWaiting();
      const extra = pendingMediaNotice ? `${pendingMediaNotice} ` : '';
      pendingMediaNotice = '';
      setCallMessage(extra + 'Waiting for someone to join this room…');
    } catch (e) {
      console.warn('[call] waiting handler', e && e.message);
    }
  });

  socket.on('peer-present', () => {
    inServerRoom = true;
    enterCallView();
    joinBtn.disabled = false;
    try {
      if (Island) Island.setConnecting('Connecting…');
      emitPeerjsRegister();
      const extra = pendingMediaNotice ? `${pendingMediaNotice} ` : '';
      pendingMediaNotice = '';
      setCallMessage(extra + 'Connecting…');
    } catch (e) {
      console.warn('[call] peer-present handler', e && e.message);
    }
  });

  socket.on('peer-joined', () => {
    if (Island) Island.setPeerJoined();
    setCallMessage('Someone joined — connecting…');
  });

  socket.on('you-call', ({ partnerPeerId }) => {
    const id = partnerPeerId && String(partnerPeerId);
    if (!id || !peer || !localStream) {
      console.warn('[call] you-call ignored — missing peer, stream, or partner id');
      return;
    }

    try {
      if (Island) Island.setRinging();
      const call = peer.call(id, localStream);
      wireMediaConnection(call);
      armStreamWatchdog();
      setCallMessage('Ringing…');
    } catch (e) {
      console.warn('[call] peer.call failed', e && e.message);
      setCallMessage('Could not place call: ' + (e && e.message ? e.message : 'error'));
      if (Island) Island.setIssue('Could not place call');
      scheduleLobbyReset('Could not start call. Tap Join to retry.', true);
    }
  });

  socket.on('peer-left', () => {
    hangupMedia();
    if (Island) Island.onRemoteDisconnected();
    setCallMessage('Peer left. Waiting for someone else…');
  });

  socket.on('disconnect', (reason) => {
    if (!callPanel.classList.contains('hidden')) {
      console.warn('[call] socket disconnected', reason);
      hangupMedia();
      if (peer) {
        try {
          peer.destroy();
        } catch (e) {
          /* ignore */
        }
        peer = null;
      }
      didRegisterPeerjs = false;
      inServerRoom = false;
      pendingRoomId = null;
      clearStreamWatchdog();
      joinPanel.classList.remove('hidden');
      callPanel.classList.add('hidden');
      document.body.classList.remove('on-call');
      if (Island) Island.hide();
      setJoinMessage('Disconnected. Tap Join when the connection is back.', true);
      setCallMessage('');
      joinBtn.disabled = false;
    }
  });

  joinBtn.addEventListener('click', async () => {
    const roomId = roomInput.value.trim();
    if (!roomId) {
      setJoinMessage('Enter a room ID', true);
      return;
    }

    joinBtn.disabled = true;
    setJoinMessage('Preparing…');

    try {
      await waitForSocketConnect();
      await ensureLocalStream();
      await createPeerAwaitOpen();
      pendingRoomId = roomId;
      setJoinMessage('Joining room…');
      socket.emit('join-room', roomId);
    } catch (e) {
      console.warn('[call] join prepare failed', e && e.message);
      const msg = e && e.message ? e.message : 'Could not start';
      setJoinMessage(msg, true);
      setCallMessage(msg);
      if (Island) Island.setIssue(msg);
      cleanupPrepareFailure();
      joinBtn.disabled = false;
    }
  });

  muteBtn.addEventListener('click', () => {
    if (!localStream) return;
    const audio = localStream.getAudioTracks()[0];
    if (!audio) return;
    audio.enabled = !audio.enabled;
    const off = !audio.enabled;
    muteBtn.setAttribute('aria-pressed', off ? 'true' : 'false');
    muteBtn.setAttribute('aria-label', off ? 'Unmute microphone' : 'Mute microphone');
    muteBtn.title = off ? 'Unmute' : 'Mute';
    if (Island) Island.setMicMuted(off);
  });

  cameraBtn.addEventListener('click', () => {
    if (!localStream) return;
    const video = localStream.getVideoTracks()[0];
    if (!video) {
      return;
    }
    video.enabled = !video.enabled;
    const off = !video.enabled;
    cameraBtn.setAttribute('aria-pressed', off ? 'true' : 'false');
    cameraBtn.setAttribute('aria-label', off ? 'Turn camera on' : 'Turn camera off');
    cameraBtn.title = off ? 'Camera on' : 'Camera off';
  });

  leaveBtn.addEventListener('click', () => {
    clearStreamWatchdog();
    hangupMedia();
    emitLeaveRoomIfJoined();
    if (peer) {
      try {
        peer.destroy();
      } catch (e) {
        /* ignore */
      }
      peer = null;
    }
    if (localStream) {
      for (const t of localStream.getTracks()) {
        t.stop();
      }
      localStream = null;
      localVideo.srcObject = null;
    }
    didRegisterPeerjs = false;
    pendingMediaNotice = '';
    inServerRoom = false;
    pendingRoomId = null;
    socket.disconnect();
    joinPanel.classList.remove('hidden');
    callPanel.classList.add('hidden');
    document.body.classList.remove('on-call');
    setCallMessage('');
    setJoinMessage('Disconnected. Connect again to rejoin.');
    if (Island) Island.hide();
    location.reload();
  });

  /** Exposed for optional admin / dev tools (Socket.IO); not used by call logic. */
  window.__VIDEO_CALL_SOCKET__ = socket;
})();
