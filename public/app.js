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

  let socket = null;
  let roomId = null, selfId = null, myName = 'Guest';
  let applyingRemoteState = false; // guard to avoid feedback loops
  let localStream = null;
  const peers = new Map(); // peerId -> RTCPeerConnection
  const remoteVideoEls = new Map();

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
  createRoomBtn.addEventListener('click', () => {
    const code = genRoomCode();
    enterRoom(code);
  });

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

  // auto-join if URL has ?room=
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
    socket.on('room-joined', ({ selfId: id, members, lastState }) => {
      selfId = id;
      systemMsg(`You joined as ${myName}.`);
      members.forEach((m) => callPeer(m.id, m.name));
      if (lastState) applyRemoteState(lastState);
    });

    socket.on('peer-joined', ({ id, name }) => {
      systemMsg(`${name} joined the room.`);
    });

    socket.on('peer-left', ({ id }) => {
      const pc = peers.get(id);
      if (pc) { pc.close(); peers.delete(id); }
      const el = remoteVideoEls.get(id);
      if (el) { el.parentElement.remove(); remoteVideoEls.delete(id); }
    });

    socket.on('roster', ({ members }) => {
      // no-op display hook; tiles are managed via peer-joined/left + rtc
    });

    socket.on('sync-event', (state) => applyRemoteState(state));

    socket.on('chat-message', ({ name, text, ts, id }) => {
      addChatLine(name, text, ts, id === selfId);
    });

    socket.on('rtc-signal', async ({ from, data }) => {
      let pc = peers.get(from);
      if (!pc) pc = createPeerConnection(from, 'peer');

      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('rtc-signal', { to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
      }
    });
  }

  // ---------- video file + local controls ----------
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    player.src = URL.createObjectURL(file);
    stageEmpty.classList.add('hidden');
    player.load();
  });

  player.addEventListener('play', () => broadcast('play'));
  player.addEventListener('pause', () => broadcast('pause'));
  player.addEventListener('seeked', () => broadcast('seek'));
  player.addEventListener('ratechange', () => broadcast('rate'));
  player.addEventListener('timeupdate', () => {
    seekBar.value = player.duration ? (player.currentTime / player.duration) * 100 : 0;
    timeLabel.textContent = `${fmt(player.currentTime)} / ${fmt(player.duration)}`;
  });

  playPauseBtn.addEventListener('click', () => {
    if (player.paused) player.play(); else player.pause();
  });
  player.addEventListener('play', () => (playPauseBtn.textContent = '⏸'));
  player.addEventListener('pause', () => (playPauseBtn.textContent = '▶'));

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

  function broadcast(action) {
    if (applyingRemoteState || !socket) return;
    socket.emit('sync-event', {
      action,
      time: player.currentTime,
      speed: player.playbackRate
    });
    flashSync(true);
  }

  function applyRemoteState(state) {
    if (!state) return;
    applyingRemoteState = true;
    const elapsed = (Date.now() - (state.ts || Date.now())) / 1000;
    const target = state.time + (state.action === 'play' ? elapsed * (state.speed || 1) : 0);
    if (Math.abs(player.currentTime - target) > 0.35) player.currentTime = Math.max(0, target);
    if (state.speed) { player.playbackRate = state.speed; speedSelect.value = state.speed; }
    if (state.action === 'play') player.play().catch(() => {});
    if (state.action === 'pause') player.pause();
    flashSync(false);
    setTimeout(() => (applyingRemoteState = false), 150);
  }

  function flashSync() {
    syncDot.classList.remove('off');
    syncLabel.textContent = 'synced';
  }

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

  // ---------- WebRTC calls ----------
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

  function createPeerConnection(peerId, name) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers.set(peerId, pc);

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('rtc-signal', { to: peerId, data: { candidate: e.candidate } });
    };

    pc.ontrack = (e) => {
      let tile = remoteVideoEls.get(peerId);
      if (!tile) {
        tile = document.createElement('video');
        tile.autoplay = true; tile.playsInline = true;
        const wrap = document.createElement('div');
        wrap.className = 'tile';
        wrap.appendChild(tile);
        const label = document.createElement('span'); label.className = 'tile-name'; label.textContent = name || 'Friend';
        wrap.appendChild(label);
        remoteTiles.appendChild(wrap);
        remoteVideoEls.set(peerId, tile);
      }
      tile.srcObject = e.streams[0];
    };

    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    return pc;
  }

  async function callPeer(peerId, name) {
    await ensureLocalStream().catch(() => {});
    const pc = createPeerConnection(peerId, name);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rtc-signal', { to: peerId, data: { sdp: pc.localDescription } });
  }
})();
