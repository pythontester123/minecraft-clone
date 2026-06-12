// VoxelCraft Multiplayer Server
// Usage: npm install && node server.js
// Open http://localhost:3000  |  LAN: http://<YOUR_IP>:3000
// Forward port 3000 TCP for internet access.

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

const PORT       = process.env.PORT || 3000;
const HTML_FILE  = path.join(__dirname, 'minecraft-clone.html');
const WORLD_FILE = path.join(__dirname, 'world.json');

// ── World state ────────────────────────────────────────────────────────────────
let worldSeed    = (Math.random() * 1e9) | 0;
const worldOverrides = new Map(); // "dim,x,y,z" -> blockId (0 = broken)

// Load persisted world from disk
try {
  const data = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'));
  if (typeof data.seed === 'number') worldSeed = data.seed | 0;
  for (const [k, v] of Object.entries(data.overrides || {}))
    worldOverrides.set(k, v);
  console.log(`Loaded world.json  seed=${worldSeed}  overrides=${worldOverrides.size}`);
} catch {
  console.log(`No world.json found — new world  seed=${worldSeed}`);
  saveWorldFile();
}

function saveWorldFile() {
  const overridesObj = {};
  worldOverrides.forEach((v, k) => { overridesObj[k] = v; });
  try {
    fs.writeFileSync(WORLD_FILE, JSON.stringify({ seed: worldSeed, overrides: overridesObj }));
  } catch (e) {
    console.error('Failed to write world.json:', e.message);
  }
}

// Debounce saves: write at most once per 5 seconds after last block change
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWorldFile, 5000);
}

// ── Players ────────────────────────────────────────────────────────────────────
let nextId = 1;
const clients = new Map(); // id -> { ws, id, name, loggedIn, pos, yaw, pitch, dim }

// ── HTTP: serve the game HTML ──────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html' || req.url === '/minecraft-clone.html') {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('Cannot read game file'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── WebSocket ──────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const id = nextId++;
  const player = {
    ws, id,
    name     : null,
    loggedIn : false,
    pos      : { x: 0, y: 20, z: 0 },
    yaw: 0, pitch: 0,
    dim: 'overworld'
  };
  clients.set(id, player);

  // ── Welcome: send the authoritative seed + block history + peer list ──────────
  const overridesObj = {};
  worldOverrides.forEach((blockId, key) => { overridesObj[key] = blockId; });

  ws.send(JSON.stringify({
    type     : 'welcome',
    id,
    seed     : worldSeed,          // ← clients MUST use this seed
    overrides: overridesObj,
    players  : [...clients.values()]
      .filter(p => p.id !== id && p.loggedIn)
      .map(p => ({ id: p.id, name: p.name, pos: p.pos, yaw: p.yaw, dim: p.dim }))
  }));

  // ── Incoming messages ─────────────────────────────────────────────────────────
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'login': {
        if (player.loggedIn) break;
        player.name     = sanitize(msg.name) || `Player${id}`;
        player.loggedIn = true;
        broadcast   ({ type: 'playerJoin', id, name: player.name, pos: player.pos, yaw: 0, dim: player.dim }, id);
        broadcastAll({ type: 'system', text: `${player.name} a rejoint la partie` });
        log(`"${player.name}" (id=${id}) connected. Online: ${clients.size}`);
        break;
      }

      case 'move':
        if (!player.loggedIn) break;
        player.pos   = msg.pos   || player.pos;
        player.yaw   = msg.yaw   ?? player.yaw;
        player.pitch = msg.pitch ?? player.pitch;
        player.dim   = msg.dim   || 'overworld';
        broadcast({ type: 'move', id, pos: player.pos, yaw: player.yaw, dim: player.dim }, id);
        break;

      case 'setBlock': {
        if (!player.loggedIn) break;
        const dim = msg.dim || 'overworld';
        const key = `${dim},${msg.x},${msg.y},${msg.z}`;
        worldOverrides.set(key, msg.blockId);
        scheduleSave();
        broadcast({ type: 'setBlock', dim, x: msg.x, y: msg.y, z: msg.z, blockId: msg.blockId }, id);
        break;
      }

      case 'chat': {
        if (!player.loggedIn) break;
        const text = sanitize(msg.text || '').slice(0, 200);
        if (!text) break;
        log(`[CHAT] ${player.name}: ${text}`);
        broadcastAll({ type: 'chat', id, name: player.name, text });
        break;
      }

      case 'attack': {
        if (!player.loggedIn) break;
        const target = clients.get(msg.targetId | 0);
        if (!target || !target.loggedIn || target.ws.readyState !== WebSocket.OPEN) break;
        // Clamp damage 1-10 — clients are trusted but values are bounded server-side
        const damage = Math.min(10, Math.max(1, msg.damage | 0));
        // Knockback direction: attacker → target (normalised)
        const dx = target.pos.x - player.pos.x;
        const dz = target.pos.z - player.pos.z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        target.ws.send(JSON.stringify({
          type: 'hit',
          fromId: id,
          fromName: player.name,
          damage,
          kx: (dx / len) * 3,
          kz: (dz / len) * 3
        }));
        break;
      }

      case 'playerDied': {
        if (!player.loggedIn) break;
        broadcastAll({ type: 'playerDeath', id, name: player.name });
        log(`"${player.name}" died.`);
        break;
      }

      case 'respawn': {
        if (!player.loggedIn) break;
        player.pos = msg.pos || player.pos;
        broadcast({ type: 'playerRespawn', id, pos: player.pos }, id);
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    broadcast({ type: 'playerLeave', id }, -1);
    if (player.loggedIn) {
      broadcastAll({ type: 'system', text: `${player.name} a quitté la partie` });
      log(`"${player.name}" (id=${id}) disconnected. Online: ${clients.size}`);
    }
  });

  ws.on('error', () => {});
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function broadcast(msg, excludeId) {
  const data = JSON.stringify(msg);
  clients.forEach(p => {
    if (p.id !== excludeId && p.ws.readyState === WebSocket.OPEN)
      p.ws.send(data);
  });
}
function broadcastAll(msg) { broadcast(msg, -1); }

function sanitize(s) {
  return String(s || '').replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ── Start ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  const ifaces  = require('os').networkInterfaces();
  const localIp = Object.values(ifaces).flat()
    .find(i => i.family === 'IPv4' && !i.internal)?.address || '?';

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   VoxelCraft Multiplayer Server      ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  Seed   : ${worldSeed}`);
  console.log(`  Local  ➜  http://localhost:${PORT}`);
  console.log(`  LAN    ➜  http://${localIp}:${PORT}`);
  console.log(`  Port-forward ${PORT}/tcp to share over internet\n`);
});
