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
  if (Island && typeof Island.init === 'function') Island.init();
  setupPipDrag();

  const socket = io();

  let localStream = null;
  let peerConnection = null;
  let mediaAcquirePromise = null;
  let pendingMediaNotice = '';
  let pendingRoomId = null;
  let inServerRoom = false;
  let isOfferInitiator = false;
  let hasStartedOffer = false;
  let streamWatchdogTimer = null;
  let lobbyResetScheduled = false;
  /** @type {RTCIceCandidateInit[]} */
  let queuedRemoteCandidates = [];
  /** @type {RTCIceCandidateInit[]} */
  let pendingCandidatesBeforePc = [];

  function logStep(step, extra) {
    const sid = socket && socket.id ? socket.id : 'no-socket-id';
    const suffix = extra ? ` | ${extra}` : '';
    console.log(`[timeline][${sid}] ${step}${suffix}`);
  }

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
      pipGlass.style.transition = 'none';
      pipGlass.setPointerCapture(pointerId);
    });

    pipGlass.addEventListener('pointermove', (ev) => {
      if (!dragging || ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
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
      pipGlass.style.transition = 'transform 0.18s ease-out';
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
    const wrapped = new Error(userMediaErrorMessage(e));
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
      if (socket.connected) return resolve();
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
      const hasRemote =
        remoteVideo.srcObject && remoteVideo.srcObject.getTracks().some((t) => t.readyState === 'live');
      if (hasRemote) return;
      console.warn('[call] no remote media within timeout');
      scheduleLobbyReset('Could not connect in time. Tap Join to retry.', true);
    }, 35000);
  }

  function clearRemote() {
    remoteVideo.srcObject = null;
  }

  function closePeerConnection() {
    if (!peerConnection) return;
    try {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
    } catch (e) {
      /* ignore */
    }
    peerConnection = null;
    isOfferInitiator = false;
    hasStartedOffer = false;
    queuedRemoteCandidates = [];
    pendingCandidatesBeforePc = [];
  }

  function hangupMedia() {
    clearStreamWatchdog();
    closePeerConnection();
    if (Island) Island.detachPeerConnection();
    clearRemote();
  }

  function emitLeaveRoomIfJoined() {
    if (!inServerRoom) return;
    if (socket.connected) socket.emit('leave-room');
    inServerRoom = false;
    pendingRoomId = null;
  }

  function softReturnToLobby(opts) {
    opts = opts || {};
    clearStreamWatchdog();
    lobbyResetScheduled = false;
    hangupMedia();
    emitLeaveRoomIfJoined();
    pendingMediaNotice = '';

    if (!opts.keepMedia && localStream) {
      for (const t of localStream.getTracks()) t.stop();
      localStream = null;
      localVideo.srcObject = null;
    }

    joinPanel.classList.remove('hidden');
    callPanel.classList.add('hidden');
    document.body.classList.remove('on-call');
    if (Island) Island.hide();
    setJoinMessage(opts.joinMessage != null ? opts.joinMessage : 'Tap Join to try again.', !!opts.isError);
    setCallMessage(opts.callMessage != null ? opts.callMessage : '');
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
    if (localStream) {
      for (const t of localStream.getTracks()) t.stop();
      localStream = null;
      localVideo.srcObject = null;
    }
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
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      if (isDeviceBusyError(e)) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
          pendingMediaNotice = 'Camera already in use by another tab. Reusing stream.';
        } catch (eAudio) {
          try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            pendingMediaNotice = 'Microphone may be in use in another tab. Reusing stream (video only).';
          } catch (eVideo) {
            throw wrapUserMediaError(eVideo);
          }
        }
      } else {
        throw wrapUserMediaError(e);
      }
    }

    localVideo.srcObject = localStream;
    console.log('local stream started');
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
      if (localVideo.srcObject !== localStream) localVideo.srcObject = localStream;
      try {
        await localVideo.play();
      } catch (playErr) {
        console.warn('[call] localVideo.play failed', playErr && playErr.message);
      }
      return localStream;
    }

    if (!mediaAcquirePromise) {
      mediaAcquirePromise = acquireMediaOnce().finally(() => {
        mediaAcquirePromise = null;
      });
    }
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

  function createPeerConnection() {
    if (peerConnection) return peerConnection;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    peerConnection = pc;
    console.log('peer created');
    logStep('peer created', `initiator=${isOfferInitiator}`);

    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
      console.log('track added to peer connection', track.kind);
    });

    pc.ontrack = (event) => {
      console.log('ONTRACK FIRED', event.streams);
      const stream = event.streams && event.streams[0];
      if (!stream) return;
      console.log('track received');
      console.log('remote stream received');
      clearStreamWatchdog();
      console.log('remoteVideo exists?', !!remoteVideo);
      remoteVideo.srcObject = stream;
      console.log('remoteVideo srcObject assigned', !!remoteVideo.srcObject);
      tryPlayRemote();
      setCallMessage('In call');
      if (Island) {
        Island.setActive();
        const a = localStream && localStream.getAudioTracks()[0];
        Island.setMicMuted(a ? !a.enabled : false);
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate || !inServerRoom) return;
      console.log('ice sent');
      logStep('ice sent');
      socket.emit('ice-candidate', { candidate: event.candidate });
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log('[webrtc] connectionState', s);
      if (s === 'failed' || s === 'closed') {
        console.warn('[call] RTCPeerConnection', s);
        scheduleLobbyReset('Call disconnected. Tap Join to retry.', true);
      }
    };
    pc.oniceconnectionstatechange = () => {
      console.log('[webrtc] iceConnectionState', pc.iceConnectionState);
    };

    if (Island) Island.attachMediaConnection({ peerConnection: pc });
    if (pendingCandidatesBeforePc.length > 0) {
      queuedRemoteCandidates.push(...pendingCandidatesBeforePc);
      pendingCandidatesBeforePc = [];
    }
    return pc;
  }

  async function flushQueuedRemoteCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;
    if (queuedRemoteCandidates.length === 0) return;
    const pending = queuedRemoteCandidates;
    queuedRemoteCandidates = [];
    for (const candidate of pending) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('ice received');
      } catch (e) {
        console.warn('[call] queued addIceCandidate failed', e && e.message);
      }
    }
  }

  async function startCallerFlow() {
    if (!isOfferInitiator || !hasLiveLocalStream() || !inServerRoom || hasStartedOffer) return;
    try {
      hasStartedOffer = true;
      logStep('create offer start', `initiator=${isOfferInitiator}`);
      if (Island) Island.setRinging();
      const pc = createPeerConnection();
      const offer = await pc.createOffer();
      console.log('offer created');
      logStep('offer created');
      await pc.setLocalDescription(offer);
      socket.emit('offer', { offer: pc.localDescription });
      console.log('offer sent');
      logStep('offer sent');
      setCallMessage('Ringing…');
      armStreamWatchdog();
    } catch (e) {
      hasStartedOffer = false;
      console.warn('[call] startCallerFlow failed', e && e.message);
      scheduleLobbyReset('Could not start call. Tap Join to retry.', true);
    }
  }

  async function onOffer(payload) {
    try {
      if (!inServerRoom || !hasLiveLocalStream()) return;
      const offer = payload && payload.offer;
      if (!offer) return;
      console.log('offer received');
      logStep('offer received', `initiator=${isOfferInitiator}`);
      if (Island) Island.setConnecting('Connecting…');

      const pc = createPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      console.log('answer created');
      logStep('answer created');
      await pc.setLocalDescription(answer);
      socket.emit('answer', { answer: pc.localDescription });
      console.log('answer sent');
      logStep('answer sent');
      await flushQueuedRemoteCandidates();
      setCallMessage('Connecting…');
      armStreamWatchdog();
    } catch (e) {
      console.warn('[call] onOffer failed', e && e.message);
      scheduleLobbyReset('Could not answer call. Tap Join to retry.', true);
    }
  }

  async function onAnswer(payload) {
    try {
      const answer = payload && payload.answer;
      if (!answer || !peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      console.log('answer received');
      logStep('answer received');
      await flushQueuedRemoteCandidates();
    } catch (e) {
      console.warn('[call] onAnswer failed', e && e.message);
      scheduleLobbyReset('Call setup failed. Tap Join to retry.', true);
    }
  }

  async function onIceCandidate(payload) {
    try {
      const candidate = payload && payload.candidate;
      if (!candidate) return;
      if (!peerConnection) {
        pendingCandidatesBeforePc.push(candidate);
        logStep('ice received before pc (queued)', `count=${pendingCandidatesBeforePc.length}`);
        return;
      }
      if (!peerConnection.remoteDescription) {
        queuedRemoteCandidates.push(candidate);
        logStep('ice received before remoteDescription (queued)', `count=${queuedRemoteCandidates.length}`);
        return;
      }
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('ice received');
      logStep('ice received');
    } catch (e) {
      console.warn('[call] addIceCandidate failed', e && e.message);
    }
  }

  socket.on('join-error', (msg) => {
    cleanupPrepareFailure();
    setJoinMessage(String(msg), true);
    joinBtn.disabled = false;
  });

  socket.on('waiting', () => {
    inServerRoom = true;
    isOfferInitiator = false;
    hasStartedOffer = false;
    queuedRemoteCandidates = [];
    pendingCandidatesBeforePc = [];
    console.log('socket joined');
    logStep('socket joined', 'waiting');
    setJoinMessage('');
    enterCallView();
    joinBtn.disabled = false;
    if (Island) Island.setWaiting();
    const extra = pendingMediaNotice ? `${pendingMediaNotice} ` : '';
    pendingMediaNotice = '';
    setCallMessage(extra + 'Waiting for someone to join this room…');
  });

  socket.on('peer-present', async () => {
    inServerRoom = true;
    isOfferInitiator = true;
    console.log('socket joined');
    console.log('peer exists');
    logStep('socket joined', 'peer-present');
    logStep('peer exists', `initiator=${isOfferInitiator}`);
    enterCallView();
    joinBtn.disabled = false;
    if (Island) Island.setConnecting('Connecting…');
    const extra = pendingMediaNotice ? `${pendingMediaNotice} ` : '';
    pendingMediaNotice = '';
    setCallMessage(extra + 'Connecting…');
    await startCallerFlow();
  });

  socket.on('peer-joined', async () => {
    isOfferInitiator = false;
    console.log('peer exists');
    logStep('peer exists', `initiator=${isOfferInitiator}`);
    if (Island) Island.setPeerJoined();
    setCallMessage('Someone joined — connecting…');
    // Non-initiator path still runs through same gate; if already started this is a no-op.
    await startCallerFlow();
  });

  socket.on('offer', onOffer);
  socket.on('answer', onAnswer);
  socket.on('ice-candidate', onIceCandidate);

  socket.on('peer-left', () => {
    hangupMedia();
    if (Island) Island.onRemoteDisconnected();
    setCallMessage('Peer left. Waiting for someone else…');
  });

  socket.on('disconnect', (reason) => {
    if (callPanel.classList.contains('hidden')) return;
    console.warn('[call] socket disconnected', reason);
    hangupMedia();
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
    if (!video) return;
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
    if (localStream) {
      for (const t of localStream.getTracks()) t.stop();
      localStream = null;
      localVideo.srcObject = null;
    }
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

  window.__VIDEO_CALL_SOCKET__ = socket;
})();
