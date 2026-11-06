'use strict';
// Przechodzi przez grę w prawdziwej przeglądarce (dwa konteksty = dwa telefony) i robi zrzuty ekranu.
// Użycie: node test/ui-shots.js <katalog-wyjściowy>
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { solveFromTexts } = require('./solver');

const OUT = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 4900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

function startServer() {
  return new Promise((resolve, reject) => {
    const java = process.env.LONT_IMPL === 'java';
    const c = spawn(java ? 'java' : process.execPath, java ? ['-cp', process.env.LONT_JAVA_CP, 'pl.lont.core.Main'] : [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LONT_PUBLIC: path.join(__dirname, '..', 'public'), LONT_UDP: String(PORT + 2000) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; if (out.includes('działa')) resolve(c); });
    c.stderr.on('data', (d) => { out += d; });
    setTimeout(() => reject(new Error('serwer nie wstał: ' + out)), 5000).unref();
  });
}

(async () => {
  const srv = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    const ctxA = await browser.newContext(phone);
    const ctxB = await browser.newContext(phone);
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    for (const [n, p] of [['A', A], ['B', B]]) {
      p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
      p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n} console: ${m.text()}`); });
    }

    // ekran startowy
    await A.goto(BASE);
    await A.fill('#name', 'Ala');
    await A.screenshot({ path: path.join(OUT, '01-start.png') });
    await A.click('[data-act=create]');
    await A.waitForSelector('.roomcode');
    const code = (await A.textContent('.roomcode')).trim();

    // drugi telefon dołącza przez link ?room=
    await B.goto(`${BASE}/?room=${code}`);
    await B.fill('#name', 'Bartek');
    await B.screenshot({ path: path.join(OUT, '02-dolacz-link.png') });
    await B.click('[data-act=join]');
    await B.waitForSelector('.roomcode');
    await A.waitForFunction(() => document.querySelectorAll('.player').length === 2);
    await A.click('[data-act=diff][data-v=hard]');
    await A.waitForSelector('[data-act=diff][data-v=hard][aria-pressed=true]');
    await A.screenshot({ path: path.join(OUT, '03-poczekalnia.png'), fullPage: true });
    await A.click('[data-act=start]');
    await A.waitForSelector('.mods');
    await B.waitForSelector('.manual');

    // regresja: start z dołu poczekalni nie może zostawić ekranu przewiniętego (rozbrajacz musi widzieć plombę i kod)
    const sy = await A.evaluate(() => window.scrollY);
    if (sy !== 0) errors.push(`po starcie rundy ekran rozbrajacza jest przewinięty o ${sy}px`);
    if (!(await A.isVisible('.casing'))) errors.push('plomba i kod nie są widoczne po starcie');
    const overflow = async (p, n) => {
      const w = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      if (w[0] > w[1]) errors.push(`${n}: poziome przewijanie (${w[0]} > ${w[1]})`);
    };
    await overflow(A, 'rozbrajacz'); await overflow(B, 'ekspert');

    // zrzuty widoków gry
    await A.screenshot({ path: path.join(OUT, '04-rozbrajacz-gora.png') });
    await A.screenshot({ path: path.join(OUT, '05-rozbrajacz-calosc.png'), fullPage: true });
    await B.screenshot({ path: path.join(OUT, '06-ekspert.png') });
    await B.screenshot({ path: path.join(OUT, '07-ekspert-calosc.png'), fullPage: true });
    const nTabs = await B.locator('.tab').count();
    for (let i = 0; i < nTabs; i++) {
      await B.locator('.tab').nth(i).click();
      const title = (await B.locator('.tab').nth(i).textContent()).trim();
      await B.locator('.manual').screenshot({ path: path.join(OUT, `instrukcja-${i}-${title}.png`) });
      await overflow(B, `instrukcja ${title}`);
    }
    await B.locator('.tab').nth(0).click();

    // pobierz stany z DOM-u i rozwiąż wyłącznie z widocznych treści: używamy API stanu przez SSE w osobnym kliencie
    const pidA = JSON.parse(await A.evaluate(() => localStorage.getItem('lont.session'))).pid;
    const pidB = JSON.parse(await B.evaluate(() => localStorage.getItem('lont.session'))).pid;
    const grab = async (pid) => {
      const r = await fetch(`${BASE}/api/events?code=${code}&pid=${pid}`);
      const reader = r.body.getReader();
      let buf = '';
      for (;;) {
        const { value } = await reader.read();
        buf += Buffer.from(value).toString('utf8');
        const m = buf.match(/event: state\ndata: (.*)\n\n/);
        if (m) { reader.cancel(); return JSON.parse(m[1]); }
      }
    };
    const sa = await grab(pidA);
    const sb = await grab(pidB);
    const shape = {
      seal: sa.game.bomb.seal, code: sa.game.bomb.code,
      pages: (() => { const p = []; for (const x of sb.game.manual.pages) p[x.index] = x; return p; })(),
      modules: sa.game.bomb.modules.map((m) => ({ id: m.id, type: m.type, pub: m })),
    };
    const plan = solveFromTexts(shape);
    const types = sa.game.bomb.modules.map((m) => m.type);
    console.log('moduły tej rundy:', types.join(', '));

    // rozwiąż po kolei klikając w UI; najpierw jedna celowa pomyłka (iskra)
    const bad = sa.game.bomb.modules.find((m) => m.type === 'cipher');
    if (bad) {
      const good = plan.find((p) => p.id === bad.id).actions[0].value;
      const wrong = String(Number(good) + 1);
      for (const ch of wrong) await A.click(`[data-act=key][data-k="${ch}"]`);
      await A.click('[data-act=key][data-k=ok]');
      await A.waitForSelector('.bulb.lit');
      await A.waitForTimeout(120);
      await A.screenshot({ path: path.join(OUT, '08-iskra.png') });
      await A.waitForTimeout(500);
    }
    for (const step of plan) {
      const m = sa.game.bomb.modules.find((x) => x.id === step.id);
      if (m.type === 'wires') {
        await A.click(`[data-act=wire][data-m=${m.id}][data-i="${step.actions[0].index}"]`);
        await A.screenshot({ path: path.join(OUT, '09-kabel-zaznaczony.png') });
        await A.click(`[data-act=cut][data-m=${m.id}]`);
      } else if (m.type === 'switches') {
        const want = step.actions[0].states;
        const cur = m.states;
        for (let i = 0; i < want.length; i++) if (want[i] !== cur[i]) await A.click(`[data-act=toggle][data-m=${m.id}][data-i="${i}"]`);
        await A.click(`[data-act=swsubmit][data-m=${m.id}]`);
      } else if (m.type === 'symbols') {
        for (const a of step.actions) await A.click(`[data-act=sym][data-m=${m.id}][data-i="${a.pos}"]`);
      } else if (m.type === 'cipher') {
        for (const ch of step.actions[0].value) await A.click(`[data-act=key][data-m=${m.id}][data-k="${ch}"]`);
        await A.click(`[data-act=key][data-m=${m.id}][data-k=ok]`);
      } else if (m.type === 'sliders') {
        const want = step.actions[0].levels;
        for (let i = 0; i < want.length; i++) {
          const d = want[i] - m.levels[i];
          for (let k = 0; k < Math.abs(d); k++) await A.click(`[data-act=slstep][data-m=${m.id}][data-i="${i}"][data-d="${d > 0 ? 1 : -1}"]`);
        }
        await A.locator('.mod', { has: A.locator(`[data-m=${m.id}]`) }).first().screenshot({ path: path.join(OUT, 'modul-suwaki.png') });
        await A.click(`[data-act=slsubmit][data-m=${m.id}]`);
      } else if (m.type === 'grid') {
        await A.locator('.mod', { has: A.locator(`[data-m=${m.id}]`) }).first().screenshot({ path: path.join(OUT, 'modul-siatka.png') });
        for (const a of step.actions) await A.click(`[data-act=cell][data-m=${m.id}][data-i="${a.pos}"]`);
      } else if (m.type === 'dial') {
        await A.click(`[data-act=dialpick][data-m=${m.id}][data-i="${step.actions[0].pos}"]`);
        await A.locator('.mod', { has: A.locator(`[data-m=${m.id}]`) }).first().screenshot({ path: path.join(OUT, 'modul-pokretlo.png') });
        await A.click(`[data-act=dialset][data-m=${m.id}]`);
      }
      await A.waitForTimeout(250);
    }
    await A.waitForSelector('.verdict');
    await B.waitForSelector('.verdict');
    await A.waitForTimeout(700);
    await A.screenshot({ path: path.join(OUT, '10-koniec-wygrana.png'), fullPage: true });
    await overflow(A, 'ekran końca (wygrana)');
    const verdict = (await B.textContent('.verdict')).trim();
    console.log('werdykt u eksperta:', verdict);
    if (verdict !== 'Rozbrojona.') errors.push('oczekiwano wygranej, jest: ' + verdict);

    // rewanż: Bartek ma teraz bombę; zostaw czas wybuchnąć? – tylko sprawdź zamianę ról
    await A.click('[data-act=again]');
    await B.waitForSelector('.mods');
    await A.waitForSelector('.manual');
    await B.screenshot({ path: path.join(OUT, '11-runda2-bartek-rozbraja.png') });
    console.log('runda 2: role zamienione OK');

    // przeładowanie telefonu w trakcie gry zachowuje sesję
    await B.reload();
    await B.waitForSelector('.mods');
    console.log('reload w trakcie gry: sesja zachowana OK');

    // wymuś wybuch trzema błędami, żeby zobaczyć ekran porażki
    const sb2 = await grab(pidB);
    const m0 = sb2.game.bomb.modules.find((m) => m.type === 'cipher') || null;
    if (m0) {
      for (let i = 0; i < 3; i++) {
        for (const ch of String(900 + i)) await B.click(`[data-act=key][data-m=${m0.id}][data-k="${ch}"]`);
        await B.click(`[data-act=key][data-m=${m0.id}][data-k=ok]`);
        await B.waitForTimeout(300);
      }
      await B.waitForSelector('.verdict');
      await B.waitForTimeout(900);
      await B.screenshot({ path: path.join(OUT, '12-koniec-wybuch.png'), fullPage: true });
      await overflow(B, 'ekran końca (wybuch)');
      console.log('werdykt po 3 iskrach:', (await B.textContent('.verdict')).trim());
    }
  } catch (e) {
    errors.push('WYJĄTEK: ' + e.stack);
  } finally {
    await browser.close();
    srv.kill();
  }
  if (errors.length) { console.log('\nBŁĘDY:\n' + errors.join('\n')); process.exit(1); }
  console.log('UI OK, zrzuty w', OUT);
})();
