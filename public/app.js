(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- elements ----------
  const gate = $('gate'), roomSection = $('room');
  const nameInput = $('nameInput'), joinCodeInput = $('joinCodeInput'), gateNote = $('gateNote');
  const createRoomBtn = $('createRoomBtn'), joinRoomBtn = $('joinRoomBtn');
  const roomIdText = $('roomIdText'), roomIdPill = $('roomIdPill'), copyLinkBtn = $('copyLinkBtn'), leaveBtn = $('leaveBtn');
  const syncDot = $('syncDot'), syncLabel = $('syncLabel');
  const player = $('player'), fileInput = $('fileInput'), stageEmpty = $('stageEmpty'), soundGate = $('soundGate');
  const playPauseBtn = $('playPauseBtn'), seekBar = $('seekBar'), timeLabel = $('timeLabel'), speedSelect = $('speedSelect'), fsBtn = $('fsBtn');
  const micBtn = $('micBtn'), camBtn = $('camBtn'), localTileWrap = $('localTileWrap'), remoteTiles = $('remoteTiles');
  const chatLog = $('chatLog'), chatForm = $('chatForm'), chatInput = $('chatInput');
  const controls = $('controls');
  const stageEmptyTitle = stageEmpty.querySelector('h2');
  const stageEmptyLede = stageEmpty.querySelector('.lede');
  const fileBtnLabel = stageEmpty.querySelector('.file-btn');

  let socket = null;
  let roomId = null, selfId = null, myName = 'Guest';
  let localStream = null;      // mic/cam for the call
  let movieStream = null;      // captured from OUR video element, only exists if we are host
  let hostId = null;
  const callPeers = new Map();   // peerId -> RTCPeerConnection (voice/video call, always active)
  const moviePeers = new Map();  // peerId -> RTCPeerConnection (movie stream, host -> each viewer)
  const remoteCallEls = new Map();
  const knownCamOff = new Map(); // peerId -> true, for members already cam-off when we join

  const fmt = (s) => {
    if (!isFinite(s)) return '00:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  function genRoomCode() {
    return Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  function note(msg, cls) {
    gateNote.textContent = msg;
    gateNote.className = 'gate-note' + (cls ? ' ' + cls : '');
  }

  // ---------- gate actions ----------
  createRoomBtn.addEventListener('click', () => enterRoom(genRoomCode()));

  joinRoomBtn.addEventListener('click', () => {
    let raw = joinCodeInput.value.trim();
    if (!raw) { note('Paste a room code or link first.', 'err'); return; }
    try {
      if (raw.includes('://')) {
        const u = new URL(raw);
        raw = u.searchParams.get('room') || raw;
      }
    } catch (e) { /* not a url, treat as raw code */ }
    enterRoom(raw.toUpperCase());
  });

  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) joinCodeInput.value = urlRoom;

  function enterRoom(code) {
    myName = nameInput.value.trim() || 'Guest';
    roomId = code;
    gate.classList.add('hidden');
    roomSection.classList.remove('hidden');
    roomIdText.textContent = roomId;
    history.replaceState(null, '', `?room=${encodeURIComponent(roomId)}`);

    socket = io();
    wireSocket();
    socket.emit('join-room', { roomId, name: myName });
  }

  leaveBtn.addEventListener('click', () => location.reload());

  copyLinkBtn.addEventListener('click', copyInviteLink);
  roomIdPill.addEventListener('click', copyInviteLink);
  function copyInviteLink() {
    const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
    navigator.clipboard?.writeText(link).then(() => {
      copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => (copyLinkBtn.textContent = 'Copy invite link'), 1500);
    }).catch(() => note('Copy failed — link: ' + link));
  }

  // ---------- socket wiring ----------
  function wireSocket() {
    socket.on('room-joined', ({ selfId: id, members, hostId: currentHost }) => {
      selfId = id;
      systemMsg(`You joined as ${myName}.`);
      members.forEach((m) => {
        if (m.cam === false) knownCamOff.set(m.id, true);
        callPeer(m.id, m.name);
      });
      setHost(currentHost, null);
    });

    socket.on('peer-joined', ({ id, name }) => {
      systemMsg(`${name} joined the room.`);
      if (selfId && hostId === selfId && movieStream) startMovieBroadcastTo(id);
    });

    socket.on('peer-left', ({ id }) => {
      const cpc = callPeers.get(id);
      if (cpc) { cpc.close(); callPeers.delete(id); }
      const mpc = moviePeers.get(id);
      if (mpc) { mpc.close(); moviePeers.delete(id); }
      const el = remoteCallEls.get(id);
      if (el) { el.parentElement.remove(); remoteCallEls.delete(id); }
    });

    socket.on('roster', () => {});

    socket.on('media-state', ({ id, cam }) => {
      const tile = remoteCallEls.get(id);
      if (!tile) return;
      const wrap = tile.parentElement;
      const label = wrap.querySelector('.tile-name');
      setAvatar(wrap, cam === false, label ? label.textContent : 'Friend');
    });

    socket.on('host-info', ({ hostId: newHostId, hostName }) => setHost(newHostId, hostName));

    socket.on('chat-message', ({ name, text, ts, id }) => {
      addChatLine(name, text, ts, id === selfId);
    });

    socket.on('rtc-signal', async ({ from, data }) => {
      const kind = data.kind || 'call';
      const map = kind === 'movie' ? moviePeers : callPeers;
      let pc = map.get(from);
      if (!pc) pc = kind === 'movie' ? createMoviePeerConnection(from) : createCallPeerConnection(from, 'peer');

      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('rtc-signal', { to: from, data: { sdp: pc.localDescription, kind } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
      }
    });
  }

  // ---------- host / viewer state ----------
  function setHost(newHostId, hostName) {
    hostId = newHostId;
    const iAmHost = selfId && hostId === selfId;

    if (!hostId) {
      stageEmpty.classList.remove('hidden');
      stageEmptyTitle.textContent = 'Choose the movie to host';
      stageEmptyLede.textContent = "Pick a file from your computer. You'll stream it live to everyone else in the room — they don't need the file.";
      fileBtnLabel.style.display = 'inline-block';
      controls.classList.add('hidden');
      player.removeAttribute('src');
    } else if (iAmHost) {
      controls.classList.remove('hidden');
    } else {
      fileBtnLabel.style.display = 'none';
      controls.classList.add('hidden');
      if (!player.srcObject) {
        stageEmpty.classList.remove('hidden');
        stageEmptyTitle.textContent = `${hostName || 'A friend'} is hosting`;
        stageEmptyLede.textContent = 'Waiting for their stream to connect…';
      }
    }
  }

  // ---------- host: load + broadcast the movie ----------
  let audioCtx = null;
  let mediaElSource = null; // tied to the <video> element, created once and reused across files

  function buildMovieStream() {
    let raw;
    try {
      raw = player.captureStream ? player.captureStream() : (player.mozCaptureStream ? player.mozCaptureStream() : null);
    } catch (e) {
      raw = null;
    }
    if (!raw) {
      note('Your browser blocked capturing the video stream. Try Chrome, Edge, or Firefox.', 'err');
      return null;
    }

    const ms = new MediaStream();
    raw.getVideoTracks().forEach((t) => ms.addTrack(t));

    // Route audio through the Web Audio API instead of trusting captureStream()'s
    // own audio track. That native track is unreliable in practice — several
    // browsers attach it late, drop it, or omit it depending on autoplay state.
    // A MediaStreamDestination fed by a MediaElementSourceNode is guaranteed to
    // carry real audio data as long as the file has a soundtrack. Note this also
    // takes over the element's audio output, so we reconnect it back to the
    // speakers below — otherwise the host would go silent themselves.
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      if (!mediaElSource) mediaElSource = audioCtx.createMediaElementSource(player);
      const dest = audioCtx.createMediaStreamDestination();
      mediaElSource.connect(dest);
      mediaElSource.connect(audioCtx.destination); // host still hears the movie locally
      dest.stream.getAudioTracks().forEach((t) => ms.addTrack(t));
    } catch (e) {
      // Fallback: whatever audio track captureStream() itself managed to attach
      raw.getAudioTracks().forEach((t) => ms.addTrack(t));
    }

    if (ms.getAudioTracks().length === 0) {
      note("Couldn't attach the movie's audio — everyone will see picture but no sound. Make sure the file actually has an audio track, and host from Chrome, Edge, or Firefox.", 'err');
    }
    return ms;
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    // Create/resume the AudioContext synchronously, in direct response to this
    // click — browsers require that for audio to be allowed to actually play.
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
    } catch (e) { /* handled again inside buildMovieStream */ }

    player.src = URL.createObjectURL(file);
    stageEmpty.classList.add('hidden');
    player.load();
    socket.emit('become-host');

    player.addEventListener('loadedmetadata', () => {
      movieStream = buildMovieStream();
      if (!movieStream) return;
      if (player.paused) player.play().catch(() => {});
      callPeers.forEach((_pc, peerId) => startMovieBroadcastTo(peerId));
    }, { once: true });
  }, false);

  function startMovieBroadcastTo(peerId) {
    if (!movieStream) return;
    const pc = createMoviePeerConnection(peerId);
    movieStream.getTracks().forEach((t) => pc.addTrack(t, movieStream));
    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('rtc-signal', { to: peerId, data: { sdp: pc.localDescription, kind: 'movie' } });
    })();
  }

  playPauseBtn.addEventListener('click', () => {
    if (player.paused) player.play(); else player.pause();
  });
  player.addEventListener('play', () => (playPauseBtn.textContent = '⏸'));
  player.addEventListener('pause', () => (playPauseBtn.textContent = '▶'));
  player.addEventListener('timeupdate', () => {
    seekBar.value = player.duration ? (player.currentTime / player.duration) * 100 : 0;
    timeLabel.textContent = `${fmt(player.currentTime)} / ${fmt(player.duration)}`;
  });
  seekBar.addEventListener('input', () => {
    if (!player.duration) return;
    player.currentTime = (seekBar.value / 100) * player.duration;
  });
  speedSelect.addEventListener('change', () => {
    player.playbackRate = parseFloat(speedSelect.value);
  });
  const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as Mac

  function goFullscreen() {
    // iOS Safari has no support for fullscreening a <div> — only the actual
    // <video> element supports native fullscreen there, via a webkit-only API.
    if (isIOS && player.webkitEnterFullscreen) {
      player.webkitEnterFullscreen();
      return;
    }
    const stage = document.getElementById('stageInner');
    const isFull = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFull) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
    }
  }

  fsBtn.addEventListener('click', goFullscreen);

  // Mobile-friendly: double-tap the video itself to toggle fullscreen, same as
  // every mainstream video app.
  let lastTap = 0;
  player.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTap < 350) goFullscreen();
    lastTap = now;
  });

  // ---------- chat ----------
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !socket) return;
    socket.emit('chat-message', text);
    chatInput.value = '';
  });

  function addChatLine(name, text, ts, isSelf) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `<span class="who" style="color:${isSelf ? '#e12441' : '#c9c2d0'}">${escapeHtml(name)}</span>${escapeHtml(text)}<span class="when">${time}</span>`;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function systemMsg(text) {
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.textContent = text;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- WebRTC: voice/video call (always on, separate from movie) ----------
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  function initials(name) {
    const parts = (name || '?').trim().split(/\s+/).slice(0, 2);
    return parts.map((w) => w[0]?.toUpperCase() || '').join('') || '?';
  }

  function setAvatar(wrap, show, name) {
    let av = wrap.querySelector('.avatar');
    if (show) {
      if (!av) {
        av = document.createElement('div');
        av.className = 'avatar';
        wrap.appendChild(av);
      }
      av.textContent = initials(name);
    } else if (av) {
      av.remove();
    }
  }

  function broadcastMediaState() {
    if (!socket || !localStream) return;
    socket.emit('media-state', {
      mic: localStream.getAudioTracks()[0]?.enabled ?? true,
      cam: localStream.getVideoTracks()[0]?.enabled ?? true
    });
  }

  let localTileWrap2 = null; // wrapper element for the local preview tile

  async function ensureLocalStream() {
    if (localStream) return localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 24, max: 30 },
          facingMode: 'user'
        }
      });
    } catch (e) {
      note("Couldn't access your mic/camera — check your browser's permission prompt, or the call will run without them.", 'err');
      throw e;
    }
    const tile = document.createElement('div');
    tile.className = 'tile';
    const v = document.createElement('video');
    v.srcObject = localStream; v.autoplay = true; v.muted = true; v.playsInline = true;
    tile.appendChild(v);
    const label = document.createElement('span'); label.className = 'tile-name'; label.textContent = `${myName} (you)`;
    tile.appendChild(label);
    localTileWrap.appendChild(tile);
    localTileWrap2 = tile;

    // Icons reflect the real, default-on track state rather than guessing.
    micBtn.classList.add('active'); micBtn.classList.remove('muted-off');
    camBtn.classList.add('active'); camBtn.classList.remove('muted-off');
    broadcastMediaState();
    return localStream;
  }

  micBtn.addEventListener('click', async () => {
    const stream = await ensureLocalStream().catch(() => null);
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      micBtn.classList.toggle('active', track.enabled);
      micBtn.classList.toggle('muted-off', !track.enabled);
      broadcastMediaState();
    }
  });
  camBtn.addEventListener('click', async () => {
    const stream = await ensureLocalStream().catch(() => null);
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      camBtn.classList.toggle('active', track.enabled);
      camBtn.classList.toggle('muted-off', !track.enabled);
      if (localTileWrap2) setAvatar(localTileWrap2, !track.enabled, `${myName} (you)`);
      broadcastMediaState();
    }
  });

  // Push a healthier bitrate ceiling for the call's video track so it doesn't
  // get squeezed down to a blurry mess by default WebRTC bandwidth estimation.
  function boostCallQuality(pc) {
    pc.getSenders().forEach((sender) => {
      if (!sender.track) return;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      if (sender.track.kind === 'video') {
        params.encodings[0].maxBitrate = 1_200_000; // ~1.2 Mbps: clear video without hogging bandwidth
      } else if (sender.track.kind === 'audio') {
        params.encodings[0].maxBitrate = 64_000; // clear voice
      }
      sender.setParameters(params).catch(() => {});
    });
  }

  function createCallPeerConnection(peerId, name) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    callPeers.set(peerId, pc);

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('rtc-signal', { to: peerId, data: { candidate: e.candidate, kind: 'call' } });
    };

    pc.ontrack = (e) => {
      let tile = remoteCallEls.get(peerId);
      if (!tile) {
        tile = document.createElement('video');
        tile.autoplay = true; tile.playsInline = true;
        const wrap = document.createElement('div');
        wrap.className = 'tile';
        wrap.appendChild(tile);
        const label = document.createElement('span'); label.className = 'tile-name'; label.textContent = name || 'Friend';
        wrap.appendChild(label);
        remoteTiles.appendChild(wrap);
        remoteCallEls.set(peerId, tile);
        if (knownCamOff.get(peerId)) setAvatar(wrap, true, name || 'Friend');
      }
      tile.srcObject = e.streams[0];
    };

    // If the connection drops (flaky wifi, phone locking, etc.) try to recover
    // instead of leaving the friend's tile frozen/silent for the rest of the call.
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        pc.restartIce?.();
      }
    };

    if (localStream) {
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      boostCallQuality(pc);
    }
    return pc;
  }

  async function callPeer(peerId, name) {
    await ensureLocalStream().catch(() => {});
    const pc = createCallPeerConnection(peerId, name);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rtc-signal', { to: peerId, data: { sdp: pc.localDescription, kind: 'call' } });
  }

  // ---------- WebRTC: movie stream (host -> each viewer) ----------
  function createMoviePeerConnection(peerId) {
    let pc = moviePeers.get(peerId);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    moviePeers.set(peerId, pc);

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('rtc-signal', { to: peerId, data: { candidate: e.candidate, kind: 'movie' } });
    };

    pc.ontrack = (e) => {
      stageEmpty.classList.add('hidden');
      player.srcObject = e.streams[0];
      player.muted = false;
      player.volume = 1;
      attemptPlayWithSound();
      syncLabel.textContent = 'live from host';
    };

    return pc;
  }

  // ---------- audio autoplay fix ----------
  // Browsers (especially on mobile) block auto-playing video WITH SOUND unless
  // the user just interacted with the page. Since the stream arrives async over
  // WebRTC, that interaction has usually "expired" by the time it shows up — so
  // play() used to silently fail and the movie would play muted with no warning.
  // We detect that and show a one-tap "turn on sound" button instead.
  function attemptPlayWithSound() {
    const p = player.play();
    if (p && typeof p.catch === 'function') {
      p.then(() => soundGate.classList.add('hidden'))
        .catch(() => {
          // Autoplay-with-sound was blocked. Fall back to muted autoplay so the
          // picture still shows up immediately, and prompt for one tap to unmute.
          player.muted = true;
          player.play().catch(() => {});
          soundGate.classList.remove('hidden');
        });
    }
  }

  soundGate.addEventListener('click', () => {
    player.muted = false;
    player.volume = 1;
    player.play().catch(() => {});
    soundGate.classList.add('hidden');
  });
})();
