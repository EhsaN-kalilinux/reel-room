# Reel Room

A private watch-party platform: everyone plays their **own local copy** of a movie file, and this app keeps play/pause/seek/speed perfectly in sync — no video streaming, so no buffering or lag. Includes a built-in peer-to-peer voice/video call for the room, plus text chat. Dark, red, cinema-themed UI.

## Why there's no lag or buffering
The movie file never travels over the internet — each person opens their own file from their own disk. The server only relays tiny sync messages ("play at 12:34.2", "paused", "speed 1.25x") and WebRTC call signaling. That's why playback stays smooth even on average internet connections.

**Important:** everyone in the room needs the *same cut/rip* of the movie already downloaded, so timestamps line up.

## Run it locally (2 minutes)
```bash
cd reel-room
npm install
npm start
```
Open `http://localhost:3000` — this works for you and anyone on your same network. To share with friends elsewhere, deploy it (below).

## Get a real shareable link (free, ~5 minutes)
Any Node.js host works. Easiest options:

**Render.com**
1. Push this folder to a GitHub repo.
2. On render.com → New → Web Service → connect the repo.
3. Build command: `npm install`, Start command: `npm start`.
4. Deploy — Render gives you a public URL like `https://your-app.onrender.com`.

**Railway.app**
1. `railway login`, then `railway init` inside this folder.
2. `railway up` — it detects Node and deploys automatically, giving you a public URL.

Once deployed, that URL *is* your permanent Reel Room link. Share `https://your-app.onrender.com` with friends — creating a room there auto-generates a shareable invite link (`?room=CODE`) they can click to join instantly.

## How to use it
1. Open the link, enter your name, hit **Create room**.
2. Click **Copy invite link** and send it to friends.
3. Each person clicks **Choose video file** and loads their own copy of the movie.
4. Anyone plays/pauses/seeks/changes speed — everyone else follows automatically.
5. Tap the 🎙 and 📷 icons to join the voice/video call in the room.

## Notes & honest limitations
- This is a from-scratch build, not a hosted product — you (or a friend) need to deploy it once to get a live link, per the steps above.
- Voice/video calls are peer-to-peer (WebRTC), which works great for small groups (2–6). Very restrictive corporate/school networks can occasionally block P2P connections.
- No files are ever uploaded to the server — "uploading" a movie just loads it locally into your browser's video player.
