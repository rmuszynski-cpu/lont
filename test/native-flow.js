'use strict';
// Dwa „telefony” w trybie aplikacji (serwer Java): drugi dołącza do gospodarza przez ekran „Znajdź grę”.
// Użycie: LONT_JAVA_CP=<klasy> node test/native-flow.js <katalog-na-zrzuty>
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const OUT = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const PA = 5600 + Math.floor(Math.random() * 100);
const PB = PA + 150;

function start(port) {
  return new Promise((resolve, reject) => {
    const c = spawn('java', ['-cp', process.env.LONT_JAVA_CP, 'pl.lont.core.Main'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LONT_NATIVE: '1', LONT_UDP: String(port + 2000), LONT_PUBLIC: path.join(__dirname, '..', 'public') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; if (out.includes('działa')) resolve(c); });
    c.stderr.on('data', (d) => { out += d; });
    setTimeout(() => reject(new Error('serwer nie wstał: ' + out)), 6000).unref();
  });
}

(async () => {
  const errors = [];
  const sa = await start(PA);
  const sb = await start(PB);
  const browser = await chromium.launch();
  try {
    const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    const A = await (await browser.newContext(phone)).newPage();
    const B = await (await browser.newContext(phone)).newPage();
    for (const [n, p] of [['A', A], ['B', B]]) {
      p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
      p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n} console: ${m.text()}`); });
    }

    // Gospodarz zakłada pokój na swoim serwerze.
    await A.goto(`http://127.0.0.1:${PA}`);
    await A.fill('#name', 'Ala');
    await A.screenshot({ path: path.join(OUT, 'n1-start-gospodarz.png'), fullPage: true });
    await A.click('[data-act=create]');
    await A.waitForSelector('.roomcode');
    const code = (await A.textContent('.roomcode')).trim();
    const hint = await A.textContent('.card .hint');
    if (!hint.includes('Znajdź grę w sieci')) errors.push('poczekalnia gospodarza nie wspomina o „Znajdź grę w sieci”');
    await A.screenshot({ path: path.join(OUT, 'n2-poczekalnia-gospodarz.png'), fullPage: true });

    // Drugi telefon: ekran startowy w trybie aplikacji.
    await B.goto(`http://127.0.0.1:${PB}`);
    await B.fill('#name', 'Bartek');
    if (await B.locator('#code[data-x]').count()) errors.push('?');
    if (!(await B.isVisible('[data-act=find]'))) errors.push('brak przycisku „Znajdź grę w sieci” w trybie aplikacji');
    if (await B.locator('[data-act=join]').count()) errors.push('w trybie aplikacji nie powinno być zwykłego przycisku „Dołącz”');
    await B.click('[data-act=find]');
    await B.waitForSelector('#found .hint:has-text("Nie znalazłem")'); // własny komputer jest odfiltrowany
    await B.screenshot({ path: path.join(OUT, 'n3-znajdz-nic.png'), fullPage: true });

    // Ręczny adres gospodarza + kod → strona gospodarza w tej samej „aplikacji” i automatyczne dołączenie.
    await B.click('details.how summary');
    await B.fill('#host', `127.0.0.1:${PA}`);
    await B.fill('#code', code);
    await B.screenshot({ path: path.join(OUT, 'n4-reczny-adres.png'), fullPage: true });
    await B.click('[data-act=joinhost]');
    await B.waitForSelector('.roomcode', { timeout: 8000 });
    const codeB = (await B.textContent('.roomcode')).trim();
    if (codeB !== code) errors.push(`drugi telefon w złym pokoju: ${codeB} ≠ ${code}`);
    if (!B.url().includes(`:${PA}`)) errors.push('drugi telefon nie przeszedł na serwer gospodarza: ' + B.url());
    await A.waitForFunction(() => document.querySelectorAll('.player').length === 2);
    const names = await A.$$eval('.pname', (els) => els.map((e) => e.textContent.trim()));
    if (!names.some((n) => n.startsWith('Bartek'))) errors.push('gospodarz nie widzi Bartka: ' + names);
    await B.screenshot({ path: path.join(OUT, 'n5-bartek-w-poczekalni.png'), fullPage: true });

    // Zła próba: nieistniejący pokój → czytelny błąd, nie biała strona.
    const C = await (await browser.newContext(phone)).newPage();
    await C.goto(`http://127.0.0.1:${PA}/?room=ZZZZ&name=Celina&go=1`);
    await C.waitForSelector('#err:not(:empty)');
    const msg = await C.textContent('#err');
    if (!msg.includes('Nie ma takiego pokoju')) errors.push('zły komunikat dla nieistniejącego pokoju: ' + msg);
    console.log('błąd dla złego pokoju:', msg);

    // Gra działa przez serwer gospodarza.
    await A.click('[data-act=start]');
    await B.waitForSelector('.manual, .mods', { timeout: 6000 });
    console.log('start gry: OK, role:', (await A.locator('.mods').count()) ? 'A rozbraja' : 'A ma instrukcję');
  } catch (e) {
    errors.push('WYJĄTEK: ' + e.stack);
  } finally {
    await browser.close();
    sa.kill(); sb.kill();
  }
  if (errors.length) { console.log('\nBŁĘDY:\n' + errors.join('\n')); process.exit(1); }
  console.log('Przepływ natywny OK, zrzuty w', OUT);
})();
