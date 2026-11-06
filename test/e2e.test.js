'use strict';
// Test end-to-end: prawdziwy serwer HTTP + klienci SSE grający jak telefony.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { solveFromTexts, wrongAction } = require('./solver');

function startServer(port, env = {}) {
  return new Promise((resolve, reject) => {
    // LONT_IMPL=java uruchamia te same testy przeciwko wersji Java (ta sama, która działa w telefonie).
    const java = process.env.LONT_IMPL === 'java';
    const cmd = java ? 'java' : process.execPath;
    const args = java ? ['-cp', process.env.LONT_JAVA_CP, 'pl.lont.core.Main'] : [path.join(__dirname, '..', 'server.js')];
    const child = spawn(cmd, args, {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LONT_PUBLIC: path.join(__dirname, '..', 'public'), LONT_UDP: String(port + 2000), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('działa')) resolve(child); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => reject(new Error('serwer padł: ' + out + c)));
    setTimeout(() => reject(new Error('serwer nie wstał')), 5000).unref();
  });
}

const api = (base) => ({
  async post(p, body) {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  },
  async get(p) {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json() };
  },
});

function openSSE(base, code, pid) {
  let last = null;
  let waiters = [];
  let raw = '';
  const req = http.get(`${base}/api/events?code=${code}&pid=${pid}`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = block.match(/^event: state\ndata: (.*)$/m);
        if (!m) continue;
        raw = m[1];
        last = JSON.parse(m[1]);
        waiters = waiters.filter((w) => {
          if (w.pred(last)) { w.resolve(last); return false; }
          return true;
        });
      }
    });
  });
  req.on('error', () => {});
  return {
    get last() { return last; },
    get raw() { return raw; },
    waitFor(pred, ms = 4000) {
      if (last && pred(last)) return Promise.resolve(last);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waitFor; ostatni stan: ' + raw.slice(0, 300))), ms);
        waiters.push({ pred, resolve: (s) => { clearTimeout(t); resolve(s); } });
      });
    },
    close() { req.destroy(); },
  };
}

async function setup(base, names) {
  const A = api(base);
  const players = [];
  let code = null;
  for (const name of names) {
    const r = code ? await A.post('/api/join', { code, name }) : await A.post('/api/create', { name });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    code = r.body.code;
    players.push({ name, pid: r.body.pid, sse: openSSE(base, code, r.body.pid) });
  }
  await players[0].sse.waitFor((s) => s.players.length === names.length && s.players.every((p) => p.online));
  return { code, players, A };
}

function toGameShape(defuserView, expertViews) {
  const b = defuserView.game.bomb;
  const pages = [];
  for (const ev of expertViews) for (const p of ev.game.manual.pages) pages[p.index] = p;
  return {
    seal: b.seal, code: b.code, pages,
    modules: b.modules.map((m) => ({ id: m.id, type: m.type, pub: m })),
  };
}

test('pełna runda: dwaj gracze, ukrywanie informacji, wygrana, rewanż z zamianą ról', async () => {
  const port = 3100 + Math.floor(Math.random() * 400);
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  try {
    const { code, players, A } = await setup(base, ['Ala', 'Bartek']);
    const [ala, bartek] = players;
    assert.strictEqual(ala.sse.last.phase, 'lobby');
    assert.match(code, /^[A-HJKMNP-Z]{4}$/);

    // zły kod
    assert.strictEqual((await A.post('/api/join', { code: 'ZZZZ', name: 'X' })).status, 404);

    // ustawienia + start
    assert.strictEqual((await A.post('/api/act', { code, pid: bartek.pid, op: 'setDifficulty', value: 'hard' })).status, 200);
    assert.strictEqual((await A.post('/api/act', { code, pid: bartek.pid, op: 'setDifficulty', value: 'xxx' })).status, 400);
    assert.strictEqual((await A.post('/api/act', { code, pid: bartek.pid, op: 'start' })).status, 200);
    await ala.sse.waitFor((s) => s.phase === 'playing');
    await bartek.sse.waitFor((s) => s.phase === 'playing');

    // role i ukrywanie informacji
    assert.strictEqual(ala.sse.last.game.role, 'defuser');
    assert.strictEqual(bartek.sse.last.game.role, 'expert');
    assert.ok(ala.sse.last.game.bomb && !ala.sse.last.game.manual, 'rozbrajacz nie może widzieć instrukcji');
    assert.ok(bartek.sse.last.game.manual && !bartek.sse.last.game.bomb, 'ekspert nie może widzieć bomby');
    assert.ok(!/"sol"|solutions|"state"/.test(ala.sse.raw) && !/"sol"|solutions|"state"/.test(bartek.sse.raw), 'wyciek rozwiązania');
    assert.strictEqual(bartek.sse.last.game.manual.pages.length, 5);
    assert.strictEqual(ala.sse.last.game.bomb.modules.length, 5);

    // ekspert nie może dotykać bomby
    const m0 = ala.sse.last.game.bomb.modules[0];
    assert.strictEqual((await A.post('/api/act', { code, pid: bartek.pid, op: 'play', moduleId: m0.id, action: {} })).status, 400);

    // zły ruch = iskra i kara czasu
    const before = ala.sse.last.game.endsAt;
    const shape = toGameShape(ala.sse.last, [bartek.sse.last]);
    const plan = solveFromTexts(shape);
    const good = plan.find((p) => p.id === m0.id).actions[0];
    const bad = wrongAction({ type: m0.type, pub: m0 }, good);
    const r = await A.post('/api/act', { code, pid: ala.pid, op: 'play', moduleId: m0.id, action: bad });
    assert.strictEqual(r.body.result, 'strike');
    const s1 = await ala.sse.waitFor((s) => s.game.strikes === 1);
    assert.strictEqual(before - s1.game.endsAt, 30000, 'kara 30 s');
    assert.strictEqual(s1.game.event.type, 'strike');

    // poprawne rozbrojenie z samych widocznych tekstów (po rozstrzelonym ruchu)
    const shape2 = toGameShape(s1, [bartek.sse.last]);
    for (const step of solveFromTexts(shape2)) {
      for (const action of step.actions) {
        const mod = ala.sse.last.game.bomb.modules.find((m) => m.id === step.id);
        // kabel mógł już być przecięty złym ruchem – wtedy poprawny i tak jest inny, więc ok
        const rr = await A.post('/api/act', { code, pid: ala.pid, op: 'play', moduleId: step.id, action });
        assert.strictEqual(rr.body.ok, true, `moduł ${mod.type}: ${JSON.stringify(rr.body)}`);
        assert.strictEqual(rr.body.result, 'ok', `moduł ${mod.type} powinien przyjąć rozwiązanie`);
      }
    }
    const done = await bartek.sse.waitFor((s) => s.phase === 'ended');
    assert.strictEqual(done.game.result.outcome, 'defused');
    assert.strictEqual(done.stats.wins, 1);
    assert.strictEqual(done.game.result.solutions.length, 5);

    // rewanż: role się zamieniają
    assert.strictEqual((await A.post('/api/act', { code, pid: ala.pid, op: 'again' })).status, 200);
    const nb = await bartek.sse.waitFor((s) => s.phase === 'playing');
    assert.strictEqual(nb.game.role, 'defuser', 'Bartek powinien teraz rozbrajać');
    assert.strictEqual(nb.round, 2);
    await ala.sse.waitFor((s) => s.phase === 'playing' && s.game.role === 'expert');
  } finally { srv.kill(); }
});

test('trzy iskry = wybuch, a w lobby można wrócić', async () => {
  const port = 3500 + Math.floor(Math.random() * 400);
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  try {
    const { code, players, A } = await setup(base, ['Ala', 'Bartek']);
    const [ala, bartek] = players;
    await A.post('/api/act', { code, pid: ala.pid, op: 'setDifficulty', value: 'hard' }); // trudny = 5 modułów
    await A.post('/api/act', { code, pid: ala.pid, op: 'start' });
    const st = await ala.sse.waitFor((s) => s.phase === 'playing');
    const shape = toGameShape(st, [await bartek.sse.waitFor((s) => s.phase === 'playing')]);
    const plan = solveFromTexts(shape);
    const bomb = st.game.bomb;
    const m = bomb.modules.find((x) => x.type !== 'wires'); // kable mają skończoną liczbę błędnych cięć
    const good = plan.find((p) => p.id === m.id).actions[0];
    const bad = wrongAction({ type: m.type, pub: m }, good);
    for (let i = 0; i < 3; i++) {
      // kable i symbole „zużywają” złe ruchy (przecięty kabel nie wraca), więc bierzemy świeży zły ruch za każdym razem
      const cur = (await ala.sse.waitFor((s) => s.game && s.game.strikes === i)).game.bomb.modules.find((x) => x.id === m.id);
      const again = wrongAction({ type: cur.type, pub: cur }, good);
      const r = await A.post('/api/act', { code, pid: ala.pid, op: 'play', moduleId: m.id, action: i === 0 ? bad : again });
      assert.strictEqual(r.body.result, 'strike', `iskra ${i + 1} (${m.type}): ${JSON.stringify(r.body)}`);
    }
    const end = await bartek.sse.waitFor((s) => s.phase === 'ended');
    assert.strictEqual(end.game.result.outcome, 'boom');
    assert.strictEqual(end.game.result.reason, 'strikes');
    assert.strictEqual(end.stats.losses, 1);
    assert.strictEqual((await A.post('/api/act', { code, pid: bartek.pid, op: 'lobby' })).status, 200);
    const lob = await ala.sse.waitFor((s) => s.phase === 'lobby');
    assert.strictEqual(lob.defuserId, bartek.pid, 'następny rozbrajacz');
  } finally { srv.kill(); }
});

test('wielu ekspertów: strony instrukcji są podzielone, obserwator nie widzi niczego tajnego', async () => {
  const port = 3900 + Math.floor(Math.random() * 400);
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  try {
    const { code, players, A } = await setup(base, ['Ala', 'Bartek', 'Celina', 'Darek']);
    await A.post('/api/act', { code, pid: players[0].pid, op: 'setDifficulty', value: 'hard' });
    await A.post('/api/act', { code, pid: players[0].pid, op: 'start' });
    const views = [];
    for (const p of players) views.push(await p.sse.waitFor((s) => s.phase === 'playing'));
    assert.strictEqual(views[0].game.role, 'defuser');
    const expertPages = views.slice(1).map((v) => v.game.manual.pages.map((p) => p.index));
    const flat = expertPages.flat().sort();
    assert.deepStrictEqual([...new Set(flat)].sort(), [0, 1, 2, 3, 4], 'wszystkie strony rozdane');
    assert.ok(expertPages.every((a) => a.length >= 1), 'każdy ekspert ma coś do czytania');
    // z podzielonych stron da się złożyć rozwiązanie
    const shape = toGameShape(views[0], views.slice(1));
    for (const step of solveFromTexts(shape)) {
      for (const action of step.actions) {
        const r = await A.post('/api/act', { code, pid: players[0].pid, op: 'play', moduleId: step.id, action });
        assert.strictEqual(r.body.result, 'ok');
      }
    }
    const end = await players[3].sse.waitFor((s) => s.phase === 'ended');
    assert.strictEqual(end.game.result.outcome, 'defused');

    // spóźniony gracz = obserwator
    await A.post('/api/act', { code, pid: players[0].pid, op: 'again' });
    await players[0].sse.waitFor((s) => s.phase === 'playing');
    const late = await A.post('/api/join', { code, name: 'Ewa' });
    const ls = openSSE(base, code, late.body.pid);
    const lv = await ls.waitFor((s) => s.phase === 'playing');
    assert.strictEqual(lv.game.role, 'spectator');
    assert.ok(!lv.game.bomb && !lv.game.manual);
    ls.close();
  } finally { srv.kill(); }
});

test('koniec czasu = wybuch (serwer pilnuje zegara)', async () => {
  const port = 4300 + Math.floor(Math.random() * 400);
  const srv = await startServer(port, { LONT_TIME: '2' });
  const base = `http://127.0.0.1:${port}`;
  try {
    const { code, players, A } = await setup(base, ['Ala', 'Bartek']);
    await A.post('/api/act', { code, pid: players[0].pid, op: 'start' });
    const t0 = Date.now();
    const end = await players[1].sse.waitFor((s) => s.phase === 'ended', 5000);
    assert.strictEqual(end.game.result.reason, 'time');
    assert.ok(Date.now() - t0 >= 1800, 'nie za wcześnie');
    assert.ok(Date.now() - t0 < 3500, 'nie za późno');
  } finally { srv.kill(); }
});

test('powrót po rozłączeniu w trakcie gry zachowuje stan', async () => {
  const port = 4700 + Math.floor(Math.random() * 300);
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  try {
    const { code, players, A } = await setup(base, ['Ala', 'Bartek']);
    await A.post('/api/act', { code, pid: players[0].pid, op: 'start' });
    await players[0].sse.waitFor((s) => s.phase === 'playing');
    players[0].sse.close();
    await players[1].sse.waitFor((s) => s.players.find((p) => p.name === 'Ala' && !p.online));
    const back = openSSE(base, code, players[0].pid);
    const s = await back.waitFor((x) => x.phase === 'playing');
    assert.strictEqual(s.game.role, 'defuser');
    assert.ok(s.game.bomb.modules.length >= 2);
    const chk = await A.get(`/api/room?code=${code}&pid=${players[0].pid}`);
    assert.deepStrictEqual(chk.body, { exists: true, hasPlayer: true });
    back.close();
  } finally { srv.kill(); }
});

test('masowy: wiele rund na wszystkich poziomach, każda rozwiązana z samych tekstów instrukcji', async () => {
  const ROUNDS = Number(process.env.LONT_ROUNDS || 40); // na poziom
  const port = 5100 + Math.floor(Math.random() * 300);
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  try {
    const { code, players, A } = await setup(base, ['Ala', 'Bartek']);
    const post = (p, op, extra = {}) => A.post('/api/act', { code, pid: p.pid, op, ...extra });
    const types = {};
    let round = 0;
    for (const diff of ['easy', 'normal', 'hard']) {
      assert.strictEqual((await post(players[0], 'setDifficulty', { value: diff })).status, 200);
      for (let i = 0; i < ROUNDS; i++) {
        const r = await (i === 0 ? post(players[0], 'start') : post(players[0], 'again'));
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        round += 1;
        const views = [];
        for (const p of players) views.push(await p.sse.waitFor((s) => s.phase === 'playing' && s.round === round));
        const def = views.find((v) => v.game.role === 'defuser');
        const exp = views.find((v) => v.game.role === 'expert');
        const defPlayer = players.find((p) => p.pid === def.me);
        assert.strictEqual(def.game.bomb.modules.length, { easy: 3, normal: 4, hard: 5 }[diff]);
        const plan = solveFromTexts(toGameShape(def, [exp]));
        for (const step of plan) {
          types[def.game.bomb.modules.find((m) => m.id === step.id).type] = true;
          for (const action of step.actions) {
            const res = await A.post('/api/act', { code, pid: defPlayer.pid, op: 'play', moduleId: step.id, action });
            assert.strictEqual(res.body.result, 'ok', `runda ${round} (${diff}), moduł ${step.id}: ${JSON.stringify(res.body)}`);
          }
        }
        const end = await players[0].sse.waitFor((s) => s.phase === 'ended' && s.round === round);
        assert.strictEqual(end.game.result.outcome, 'defused', `runda ${round} (${diff}) nie rozbrojona`);
        assert.strictEqual(end.game.result.solutions.length, def.game.bomb.modules.length);
      }
      await post(players[0], 'lobby');
      await players[0].sse.waitFor((s) => s.phase === 'lobby');
    }
    assert.strictEqual(Object.keys(types).length, 7, 'w rundach powinny wystąpić wszystkie 7 modułów: ' + Object.keys(types));
  } finally { srv.kill(); }
});
