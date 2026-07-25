(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- elements ----------
  const gate = $('gate'), roomSection = $('room');
  const nameInput = $('nameInput'), joinCodeInput = $('joinCodeInput'), gateNote = $('gateNote');
  const createRoomBtn = $('createRoomBtn'), joinRoomBtn = $('joinRoomBtn');
  const roomIdText = $('roomIdText'), roomIdPill = $('roomIdPill'), copyLinkBtn = $('copyLinkBtn'), leaveBtn = $('leaveBtn');
  const syncDot = $('syncDot'), syncLabel = $('syncLabel');
  const player = $('player'), fileInput = $('fileInput'), stageEmpty = $('stageEmpty');
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
      members.forEach((m) => callPeer(m.id, m.name));
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
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    player.src = URL.createObjectURL(file);
    stageEmpty.classList.add('hidden');
    player.load();
    socket.emit('become-host');

    player.addEventListener('loadedmetadata', () => {
      try {
        movieStream = player.captureStream ? player.captureStream() : player.mozCaptureStream();
      } catch (e) {
        note('Your browser blocked capturing the video stream. Try Chrome or Firefox.', 'err');
        return;
      }
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
  fsBtn.addEventListener('click', () => {
    const stage = document.getElementById('stageInner');
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen?.();
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

  async function ensureLocalStream() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const tile = document.createElement('div');
    tile.className = 'tile';
    const v = document.createElement('video');
    v.srcObject = localStream; v.autoplay = true; v.muted = true; v.playsInline = true;
    tile.appendChild(v);
    const label = document.createElement('span'); label.className = 'tile-name'; label.textContent = `${myName} (you)`;
    tile.appendChild(label);
    localTileWrap.appendChild(tile);
    return localStream;
  }

  micBtn.addEventListener('click', async () => {
    const stream = await ensureLocalStream();
    const track = stream.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; micBtn.classList.toggle('active', track.enabled); }
  });
  camBtn.addEventListener('click', async () => {
    const stream = await ensureLocalStream();
    const track = stream.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; camBtn.classList.toggle('active', track.enabled); }
  });

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
      }
      tile.srcObject = e.streams[0];
    };

    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
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
      player.play().catch(() => {});
      syncLabel.textContent = 'live from host';
    };

    return pc;
  }
})();
