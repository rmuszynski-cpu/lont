'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine');
const { textCond, solveFromTexts } = require('./solver');

for (const diff of Object.keys(E.DIFFICULTY)) {
  test(`5000 losowych bomb (${diff}) da się rozbroić z samych tekstów instrukcji`, () => {
    const rng = E.mulberry32(12345 + diff.length);
    for (let i = 0; i < 5000; i++) {
      const game = E.generateGame(diff, rng);
      assert.strictEqual(game.modules.length, E.DIFFICULTY[diff].modules);
      const plan = solveFromTexts(game);
      for (const step of plan) {
        for (const act of step.actions) {
          const r = E.applyAction(game, step.id, act);
          assert.strictEqual(r.result, 'ok', `bomba #${i}, moduł ${step.id}: oczekiwano ok, jest ${r.result}`);
        }
      }
      assert.ok(E.allSolved(game), `bomba #${i} nie rozbrojona`);
    }
  });
}

test('zły ruch daje iskrę, śmieci nie karzą, rozwiązany moduł odrzuca ruchy', () => {
  const rng = E.mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const game = E.generateGame('hard', rng);
    for (const m of game.modules) {
      if (m.type === 'wires') {
        const wrong = m.pub.wires.map((_, k) => k).find((k) => k !== m.sol);
        assert.strictEqual(E.applyAction(game, m.id, { index: wrong }).result, 'strike');
        assert.strictEqual(E.applyAction(game, m.id, { index: wrong }).result, 'invalid'); // już przecięty
        assert.strictEqual(E.applyAction(game, m.id, { index: 99 }).result, 'invalid');
        assert.strictEqual(E.applyAction(game, m.id, { index: m.sol }).result, 'ok');
      } else if (m.type === 'switches') {
        const bad = m.sol.map((x) => !x);
        assert.strictEqual(E.applyAction(game, m.id, { states: bad }).result, 'strike');
        assert.strictEqual(E.applyAction(game, m.id, { states: [true] }).result, 'invalid');
        assert.strictEqual(E.applyAction(game, m.id, { states: m.sol }).result, 'ok');
      } else if (m.type === 'symbols') {
        const wrong = [0, 1, 2, 3].find((p) => p !== m.sol[0]);
        assert.strictEqual(E.applyAction(game, m.id, { pos: wrong }).result, 'strike');
        assert.strictEqual(E.applyAction(game, m.id, { pos: 7 }).result, 'invalid');
        for (const p of m.sol) assert.strictEqual(E.applyAction(game, m.id, { pos: p }).result, 'ok');
      } else if (m.type === 'cipher') {
        assert.strictEqual(E.applyAction(game, m.id, { value: String(m.sol + 1) }).result, 'strike');
        assert.strictEqual(E.applyAction(game, m.id, { value: 'abc' }).result, 'invalid');
        assert.strictEqual(E.applyAction(game, m.id, { value: '-3' }).result, 'invalid');
        assert.strictEqual(E.applyAction(game, m.id, { value: String(m.sol) }).result, 'ok');
      } else if (m.type === 'sliders') {
        const bad = m.sol.map((x, i) => (i === 0 ? (x + 1) % 10 : x));
        assert.strictEqual(E.applyAction(game, m.id, { levels: bad }).result, 'strike');
        assert.strictEqual(E.applyAction(game, m.id, { levels: [1, 2] }).result, 'invalid');
        assert.strictEqual(E.applyAction(game, m.id, { levels: [1, 2, 3, 10] }).result, 'invalid');
        assert.strictEqual(E.applyAction(game, m.id, { levels: [1, 2, 3, 1.5] }).result, 'invalid');
        assert.strictEqual(E.applyAction(game, m.id, { levels: m.sol }).result, 'ok');
      } else if (m.type === 'grid') {
        assert.ok(m.sol.length >= 3 && m.sol.length <= 6, 'reguła siatki powinna wskazywać 3–6 liczb');
        const wrong = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((p) => p !== m.sol[0]);
        assert.strictEqual(E.applyAction(game, m.id, { pos: wrong }).result, 'strike');
        assert.strictEqual(E.applyAction(game, m.id, { pos: 9 }).result, 'invalid');
        for (const p of m.sol) assert.strictEqual(E.applyAction(game, m.id, { pos: p }).result, 'ok');
      } else if (m.type === 'dial') {
        assert.strictEqual(E.applyAction(game, m.id, { pos: (m.sol + 1) % 8 }).result, 'strike');
        assert.strictEqual(E.applyAction(game, m.id, { pos: 8 }).result, 'invalid');
        assert.strictEqual(E.applyAction(game, m.id, { pos: m.sol }).result, 'ok');
      } else {
        assert.fail('nieznany moduł ' + m.type);
      }
      assert.ok(m.solved);
      assert.strictEqual(E.applyAction(game, m.id, { index: 0, states: [], pos: 0, value: '1' }).result, 'invalid');
    }
    assert.ok(E.allSolved(game));
  }
});

test('reguły naprawdę mają znaczenie (fallback nie dominuje) i odpowiedzi są zróżnicowane', () => {
  const rng = E.mulberry32(99);
  let fallback = 0;
  let total = 0;
  const idxCount = {};
  for (let i = 0; i < 3000; i++) {
    const game = E.generateGame('hard', rng);
    const m = game.modules.find((x) => x.type === 'wires');
    if (!m) continue;
    const page = game.pages.find((p) => p.type === 'wires');
    const sec = page.sections.find((s) => s.n === m.pub.wires.length);
    total++;
    if (!sec.rules.some((r) => textCond(r.if, m.pub.wires, game.seal, game.code))) fallback++;
    idxCount[m.sol] = (idxCount[m.sol] || 0) + 1;
  }
  assert.ok(fallback / total < 0.6, `fallback zbyt częsty: ${fallback}/${total}`);
  assert.ok(Object.keys(idxCount).length >= 5, 'za mało różnych odpowiedzi w kablach');
  console.log(`  kable: fallback w ${(100 * fallback / total).toFixed(1)}% przypadków, rozkład indeksów`, idxCount);
});

test('bomby różnią się między rundami (losowanie instrukcji)', () => {
  const rng = E.mulberry32(5);
  const sigs = new Set();
  for (let i = 0; i < 200; i++) sigs.add(JSON.stringify(E.generateGame('normal', rng).pages));
  assert.ok(sigs.size > 190, 'instrukcje powtarzają się za często: ' + sigs.size);
});

test('wszystkie 7 modułów naraz: 3000 bomb rozbrajalnych z samych tekstów', () => {
  const rng = E.mulberry32(2026);
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const game = E.generateGame('hard', rng, E.MODULE_TYPES);
    assert.strictEqual(game.modules.length, 7);
    for (const step of solveFromTexts(game)) {
      for (const act of step.actions) {
        const r = E.applyAction(game, step.id, act);
        assert.strictEqual(r.result, 'ok', `bomba #${i}, moduł ${step.id}: ${r.result}`);
      }
    }
    assert.ok(E.allSolved(game), `bomba #${i} nie rozbrojona`);
    for (const m of game.modules) seen.add(m.type);
    assert.strictEqual(E.solutionsText(game).filter((s) => !s).length, 0, 'brak opisu rozwiązania');
  }
  assert.strictEqual(seen.size, 7);
});

test('każdy moduł występuje w losowych bombach, a rozmiar zależy od poziomu', () => {
  const rng = E.mulberry32(31);
  const counts = {};
  for (const [diff, cfg] of Object.entries(E.DIFFICULTY)) {
    for (let i = 0; i < 400; i++) {
      const g = E.generateGame(diff, rng);
      assert.strictEqual(g.modules.length, cfg.modules);
      assert.strictEqual(new Set(g.modules.map((m) => m.type)).size, cfg.modules, 'moduły nie mogą się powtarzać');
      for (const m of g.modules) counts[m.type] = (counts[m.type] || 0) + 1;
    }
  }
  assert.strictEqual(Object.keys(counts).length, 7, JSON.stringify(counts));
});
