'use strict';
/*
 * LONT – serwer gry. Czysty Node.js, zero zależności.
 *   node server.js          (domyślnie port 3000, zmiana: PORT=8080 node server.js)
 * Komunikacja: Server-Sent Events (stan do graczy) + POST (ruchy graczy).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const E = require('./engine');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TIME_OVERRIDE = process.env.LONT_TIME ? Number(process.env.LONT_TIME) : null; // tylko do testów
const FORCE_TYPES = process.env.LONT_TYPES ? process.env.LONT_TYPES.split(',').map((s) => s.trim()) : null; // tylko do testów
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 8;
const MAX_ROOMS = 300;
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // bez I, L, O – łatwiej przepisać

const rooms = new Map();

/* ---------- pomocnicze ---------- */

const cleanName = (s) => {
  const n = String(s == null ? '' : s).replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, 16);
  return n || 'Gracz';
};

function makeCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function uniqueName(room, name) {
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 20; i++) {
    const cand = `${name.slice(0, 13)} ${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return name;
}

function addPlayer(room, name) {
  const id = crypto.randomUUID();
  const player = { id, name: uniqueName(room, name), conns: new Set(), removeTimer: null };
  room.players.set(id, player);
  room.order.push(id);
  if (!room.defuserId) room.defuserId = id;
  return player;
}

const online = (room) => room.order.filter((id) => room.players.get(id).conns.size > 0);

function nextDefuser(room) {
  const on = online(room);
  if (on.length === 0) return room.defuserId;
  const cur = room.game ? room.game.defuserId : room.defuserId;
  const i = on.indexOf(cur);
  return on[(i + 1) % on.length];
}

/* ---------- widok dla konkretnego gracza ---------- */

function viewFor(room, pid) {
  const g = room.game;
  const v = {
    code: room.code,
    me: pid,
    players: room.order.map((id) => ({ id, name: room.players.get(id).name, online: room.players.get(id).conns.size > 0 })),
    phase: room.phase,
    difficulty: room.difficulty,
    defuserId: g && room.phase !== 'lobby' ? g.defuserId : room.defuserId,
    round: room.round,
    stats: room.stats,
    serverNow: Date.now(),
    maxPlayers: MAX_PLAYERS,
  };
  if (g && (room.phase === 'playing' || room.phase === 'ended')) {
    const eng = g.engine;
    const role = pid === g.defuserId ? 'defuser' : g.expertIds.includes(pid) ? 'expert' : 'spectator';
    const game = {
      role,
      defuserId: g.defuserId,
      expertIds: g.expertIds,
      endsAt: g.endsAt,
      strikes: g.strikes,
      maxStrikes: E.MAX_STRIKES,
      penaltyMs: E.STRIKE_PENALTY_MS,
      solved: eng.modules.filter((m) => m.solved).length,
      total: eng.modules.length,
      seq: g.seq,
      event: g.lastEvent,
      difficulty: eng.difficulty,
      timeSec: eng.timeSec,
    };
    if (role === 'defuser') {
      game.bomb = {
        seal: eng.seal,
        code: eng.code,
        modules: eng.modules.map((m) => ({ id: m.id, type: m.type, title: E.MODULE_TITLES[m.type], solved: m.solved, ...m.pub })),
      };
    }
    if (role === 'expert') {
      game.manual = {
        pages: g.pageAssign[pid].map((j) => ({ index: j, ...eng.pages[j] })),
        totalPages: eng.pages.length,
        shared: g.expertIds.length > 1,
      };
    }
    if (room.phase === 'ended') {
      game.result = {
        outcome: g.outcome,
        reason: g.reason,
        timeLeftMs: g.timeLeftMs,
        solutions: E.solutionsText(eng),
        seal: eng.seal,
        code: eng.code,
      };
    }
    v.game = game;
  }
  return v;
}

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* połączenie padło */ }
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.conns.size === 0) continue;
    const v = viewFor(room, p.id);
    for (const res of p.conns) send(res, 'state', v);
  }
}

/* ---------- przebieg gry ---------- */

function scheduleTimeout(room) {
  clearTimeout(room.timer);
  const g = room.game;
  if (!g || room.phase !== 'playing') return;
  const ms = Math.max(0, g.endsAt - Date.now());
  room.timer = setTimeout(() => {
    if (room.phase !== 'playing') return;
    if (Date.now() >= room.game.endsAt - 5) finish(room, 'boom', 'time');
    else scheduleTimeout(room);
  }, ms + 30);
}

function finish(room, outcome, reason) {
  const g = room.game;
  if (!g || room.phase !== 'playing') return;
  clearTimeout(room.timer);
  room.phase = 'ended';
  g.outcome = outcome;
  g.reason = reason;
  g.timeLeftMs = Math.max(0, g.endsAt - Date.now());
  g.seq += 1;
  g.lastEvent = { seq: g.seq, type: outcome === 'defused' ? 'win' : 'boom' };
  if (outcome === 'defused') room.stats.wins += 1;
  else room.stats.losses += 1;
  broadcast(room);
}

function startGame(room) {
  const on = online(room);
  if (on.length < 2) return 'Do gry potrzeba co najmniej 2 graczy online.';
  const defuserId = on.includes(room.defuserId) ? room.defuserId : on[0];
  const expertIds = on.filter((id) => id !== defuserId);
  const engine = E.generateGame(room.difficulty, Math.random, FORCE_TYPES);
  if (TIME_OVERRIDE) engine.timeSec = TIME_OVERRIDE;

  // Strony instrukcji rozdzielone między ekspertów (jedna osoba = wszystkie strony).
  const nPages = engine.pages.length;
  const pageAssign = {};
  expertIds.forEach((id, k) => {
    let mine = [];
    for (let j = 0; j < nPages; j++) if (j % expertIds.length === k) mine.push(j);
    if (mine.length === 0) mine = [k % nPages]; // nadmiarowy ekspert dostaje kopię strony
    pageAssign[id] = mine;
  });

  const now = Date.now();
  room.game = {
    engine, defuserId, expertIds, pageAssign,
    startedAt: now, endsAt: now + engine.timeSec * 1000,
    strikes: 0, seq: 0, lastEvent: null, outcome: null, reason: null, timeLeftMs: 0,
  };
  room.defuserId = defuserId;
  room.phase = 'playing';
  room.round += 1;
  scheduleTimeout(room);
  broadcast(room);
  return null;
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  clearTimeout(p.removeTimer);
  for (const res of p.conns) { try { res.end(); } catch { /* nic */ } }
  room.players.delete(id);
  room.order = room.order.filter((x) => x !== id);
  if (room.players.size === 0) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }
  if (room.defuserId === id) room.defuserId = nextDefuser(room);
  broadcast(room);
}

/* ---------- akcje graczy ---------- */

function handleAct(room, player, body) {
  const op = body && body.op;
  const g = room.game;

  switch (op) {
    case 'setDifficulty':
      if (room.phase === 'playing') return { error: 'Trwa gra.' };
      if (!E.DIFFICULTY[body.value]) return { error: 'Zły poziom.' };
      room.difficulty = body.value;
      broadcast(room);
      return { ok: true };

    case 'setDefuser':
      if (room.phase === 'playing') return { error: 'Trwa gra.' };
      if (!room.players.has(body.value)) return { error: 'Nie ma takiego gracza.' };
      room.defuserId = body.value;
      broadcast(room);
      return { ok: true };

    case 'start': {
      if (room.phase !== 'lobby') return { error: 'Gra już trwa.' };
      const err = startGame(room);
      return err ? { error: err } : { ok: true };
    }

    case 'again': {
      if (room.phase !== 'ended') return { error: 'Runda jeszcze trwa.' };
      room.defuserId = nextDefuser(room);
      const err = startGame(room);
      return err ? { error: err } : { ok: true };
    }

    case 'lobby':
      if (room.phase !== 'ended') return { error: 'Runda jeszcze trwa.' };
      room.defuserId = nextDefuser(room);
      room.phase = 'lobby';
      room.game = null;
      broadcast(room);
      return { ok: true };

    case 'leave':
      if (room.phase === 'playing') return { error: 'Nie można wyjść w trakcie rundy.' };
      removePlayer(room, player.id);
      return { ok: true };

    case 'play': {
      if (room.phase !== 'playing' || !g) return { error: 'Gra nie trwa.' };
      if (g.defuserId !== player.id) return { error: 'Tylko rozbrajacz może dotykać bomby.' };
      if (Date.now() >= g.endsAt) { finish(room, 'boom', 'time'); return { ok: true, late: true }; }
      const r = E.applyAction(g.engine, String(body.moduleId), body.action);
      if (r.result === 'invalid') return { error: 'Niepoprawny ruch.' };
      g.seq += 1;
      if (r.result === 'strike') {
        g.strikes += 1;
        g.endsAt -= E.STRIKE_PENALTY_MS;
        g.lastEvent = { seq: g.seq, type: 'strike', moduleId: body.moduleId };
        if (g.strikes >= E.MAX_STRIKES) { finish(room, 'boom', 'strikes'); return { ok: true, result: 'strike' }; }
        if (Date.now() >= g.endsAt) { finish(room, 'boom', 'time'); return { ok: true, result: 'strike' }; }
        scheduleTimeout(room);
      } else if (r.solved) {
        g.lastEvent = { seq: g.seq, type: 'module', moduleId: body.moduleId };
        if (E.allSolved(g.engine)) { finish(room, 'defused', 'solved'); return { ok: true, result: 'ok' }; }
      } else {
        g.lastEvent = { seq: g.seq, type: 'step', moduleId: body.moduleId };
      }
      broadcast(room);
      return { ok: true, result: r.result };
    }

    default:
      return { error: 'Nieznana akcja.' };
  }
}

/* ---------- HTTP ---------- */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 8192) { reject(new Error('za duże')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#14110f"/><circle cx="30" cy="38" r="16" fill="#2a2420" stroke="#c9a24a" stroke-width="3"/><path d="M38 24 Q46 12 54 14" stroke="#c9a24a" stroke-width="4" fill="none" stroke-linecap="round"/><circle cx="55" cy="13" r="5" fill="#ffb02e"/></svg>`;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out.sort((a, b) => (b.startsWith('192.168.') ? 1 : 0) - (a.startsWith('192.168.') ? 1 : 0));
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); res.end(); return; }
  const p = url.pathname;

  try {
    /* --- statyki --- */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && p === '/favicon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(FAVICON);
      return;
    }
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && p === '/api/health') { json(res, 200, { ok: true, rooms: rooms.size }); return; }

    /* --- API --- */
    if (req.method === 'GET' && p === '/api/info') {
      json(res, 200, { lan: lanAddresses().map((a) => `http://${a}:${PORT}`), port: PORT });
      return;
    }

    if (req.method === 'GET' && p === '/api/room') {
      const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
      const pid = url.searchParams.get('pid');
      json(res, 200, { exists: !!room, hasPlayer: !!(room && pid && room.players.has(pid)) });
      return;
    }

    if (req.method === 'POST' && (p === '/api/create' || p === '/api/join')) {
      const body = await readBody(req);
      const name = cleanName(body.name);
      if (p === '/api/create') {
        if (rooms.size >= MAX_ROOMS) { json(res, 503, { error: 'Serwer jest pełny, spróbuj za chwilę.' }); return; }
        const code = makeCode();
        if (!code) { json(res, 503, { error: 'Nie udało się utworzyć pokoju.' }); return; }
        const room = {
          code, players: new Map(), order: [], phase: 'lobby', difficulty: 'normal', defuserId: null,
          round: 0, stats: { wins: 0, losses: 0 }, game: null, timer: null, lastActive: Date.now(),
        };
        rooms.set(code, room);
        const player = addPlayer(room, name);
        json(res, 200, { code, pid: player.id, name: player.name });
        return;
      }
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      const room = rooms.get(code);
      if (!room) { json(res, 404, { error: 'Nie ma takiego pokoju. Sprawdź kod.' }); return; }
      room.lastActive = Date.now();
      if (body.pid && room.players.has(body.pid)) {
        json(res, 200, { code, pid: body.pid, name: room.players.get(body.pid).name });
        return;
      }
      if (room.players.size >= MAX_PLAYERS) { json(res, 409, { error: `Pokój jest pełny (max ${MAX_PLAYERS} osób).` }); return; }
      const player = addPlayer(room, name);
      broadcast(room);
      json(res, 200, { code, pid: player.id, name: player.name });
      return;
    }

    if (req.method === 'GET' && p === '/api/events') {
      const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
      const player = room && room.players.get(url.searchParams.get('pid'));
      if (!player) { json(res, 404, { error: 'Brak pokoju lub gracza.' }); return; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...SECURITY_HEADERS,
      });
      res.write('retry: 1500\n\n');
      clearTimeout(player.removeTimer);
      player.conns.add(res);
      room.lastActive = Date.now();
      broadcast(room); // wszyscy widzą, że ktoś wrócił; nowy klient dostaje pierwszy stan
      req.on('close', () => {
        player.conns.delete(res);
        if (!rooms.has(room.code) || !room.players.has(player.id)) return;
        if (player.conns.size === 0) {
          if (room.phase !== 'playing') {
            player.removeTimer = setTimeout(() => {
              if (room.players.has(player.id) && player.conns.size === 0 && room.phase !== 'playing') removePlayer(room, player.id);
            }, 60000);
          }
          broadcast(room);
        }
      });
      return;
    }

    if (req.method === 'POST' && p === '/api/act') {
      const body = await readBody(req);
      const room = rooms.get(String(body.code || '').toUpperCase());
      const player = room && room.players.get(body.pid);
      if (!player) { json(res, 404, { error: 'Brak pokoju lub gracza.' }); return; }
      room.lastActive = Date.now();
      const out = handleAct(room, player, body);
      json(res, out.error ? 400 : 200, out);
      return;
    }

    json(res, 404, { error: 'Nie ma takiej strony.' });
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: 'Zły request.' });
    else res.end();
  }
});

// Podtrzymanie SSE (proxy/telefony potrafią ubić „ciche” połączenia).
setInterval(() => {
  for (const room of rooms.values()) {
    for (const pl of room.players.values()) for (const res of pl.conns) { try { res.write(': ping\n\n'); } catch { /* nic */ } }
  }
}, 15000).unref();

// Sprzątanie starych, pustych pokoi.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = [...room.players.values()].some((p) => p.conns.size > 0);
    if (!anyone && now - room.lastActive > 2 * 3600 * 1000) { clearTimeout(room.timer); rooms.delete(code); }
  }
}, 5 * 60 * 1000).unref();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} jest zajęty. Użyj innego: PORT=3001 node server.js`);
  else console.error(e);
  process.exit(1);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const lan = lanAddresses();
    console.log('\n  💣  LONT działa!\n');
    console.log(`  Na tym komputerze:            http://localhost:${PORT}`);
    if (lan.length) {
      console.log('  Na telefonach (to samo WiFi): ' + lan.map((a) => `http://${a}:${PORT}`).join('   '));
    } else {
      console.log('  (nie widzę sieci WiFi/LAN – połącz komputer z siecią, do której podepniesz telefony)');
    }
    console.log('\n  Zatrzymanie: Ctrl+C\n');
  });
}

module.exports = { server, rooms };
