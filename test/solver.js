'use strict';
// Wspólny solver testów: czyta WYŁĄCZNIE teksty widoczne dla graczy (widok bomby + strony instrukcji).
const assert = require('node:assert');
const E = require('../engine');

const NOM = Object.fromEntries(Object.entries(E.WIRE_GEN).map(([nom, gen]) => [gen, nom]));
const digitSum = (s) => [...String(s)].reduce((a, d) => a + Number(d), 0);

function textCond(text, wires, seal, code) {
  let m;
  if ((m = text.match(/^nie ma ani jednego (\S+) kabla$/))) return !wires.includes(NOM[m[1]]);
  if ((m = text.match(/^jest dokładnie jeden (\S+) kabel$/))) return wires.filter((w) => w === m[1]).length === 1;
  if ((m = text.match(/^jest więcej niż jeden (\S+) kabel$/))) return wires.filter((w) => w === m[1]).length > 1;
  if ((m = text.match(/^pierwszy kabel \(od góry\) jest (\S+)$/))) return wires[0] === m[1];
  if ((m = text.match(/^ostatni kabel \(na dole\) jest (\S+)$/))) return wires[wires.length - 1] === m[1];
  if ((m = text.match(/^plomba jest (\S+)$/))) return seal === m[1];
  if ((m = text.match(/^suma cyfr kodu jest (parzysta|nieparzysta)$/))) return (digitSum(code) % 2 === 0) === (m[1] === 'parzysta');
  throw new Error('nieznany warunek: ' + text);
}
function textAct(text, wires) {
  let m;
  if ((m = text.match(/^przetnij kabel nr (\d+)$/))) return Number(m[1]) - 1;
  if (text === 'przetnij ostatni kabel') return wires.length - 1;
  if ((m = text.match(/^przetnij pierwszy (\S+) kabel$/))) return wires.indexOf(m[1]);
  if ((m = text.match(/^przetnij ostatni (\S+) kabel$/))) return wires.lastIndexOf(m[1]);
  throw new Error('nieznana akcja: ' + text);
}

function solveFromTexts(game) {
  const plan = [];
  for (const mod of game.modules) {
    const page = game.pages.find((p) => p.type === mod.type);
    if (mod.type === 'wires') {
      const { wires } = mod.pub;
      const sec = page.sections.find((s) => s.n === wires.length);
      let idx = null;
      for (const r of sec.rules) {
        if (textCond(r.if, wires, game.seal, game.code)) { idx = textAct(r.then, wires); break; }
      }
      if (idx === null) idx = textAct(sec.fallback.then, wires);
      plan.push({ id: mod.id, actions: [{ index: idx }] });
    } else if (mod.type === 'switches') {
      const flip = page.flip.text.match(/plomba jest (\S+):/)[1] === game.seal;
      const out = [];
      let prev = false;
      for (const led of mod.pub.leds) {
        const t = page.map.find((x) => x.led === led).text;
        let v;
        if (t === 'ustaw WŁ') v = true;
        else if (t === 'ustaw WYŁ') v = false;
        else if (t.startsWith('ustaw tak samo')) v = prev;
        else if (t.startsWith('ustaw odwrotnie')) v = !prev;
        else throw new Error('?' + t);
        out.push(v);
        prev = v;
      }
      plan.push({ id: mod.id, actions: [{ states: flip ? out.map((x) => !x) : out }] });
    } else if (mod.type === 'symbols') {
      const pos = [0, 1, 2, 3].sort((p, q) => page.order.indexOf(mod.pub.symbols[p]) - page.order.indexOf(mod.pub.symbols[q]));
      plan.push({ id: mod.id, actions: pos.map((p) => ({ pos: p })) });
    } else if (mod.type === 'cipher') {
      const { a, b, c, led } = mod.pub;
      const t = page.formulas.find((x) => x.led === led).text;
      const table = {
        'A + B': a + b, 'B + C': b + c, 'A + C': a + c, 'A × C': a * c, 'B × 2': b * 2,
        'różnica A i B (większa minus mniejsza)': Math.abs(a - b),
        'różnica B i C (większa minus mniejsza)': Math.abs(b - c),
        'największa z liczb A, B, C': Math.max(a, b, c),
        'najmniejsza z liczb A, B, C': Math.min(a, b, c),
        'A + B + C': a + b + c,
      };
      let v = table[t];
      assert.notStrictEqual(v, undefined, 'nieznany wzór: ' + t);
      const pm = page.parity.text.match(/^Jeśli suma cyfr kodu jest (parzysta|nieparzysta), dodaj (\d+) do wyniku\.$/);
      if ((digitSum(game.code) % 2 === 0) === (pm[1] === 'parzysta')) v += Number(pm[2]);
      plan.push({ id: mod.id, actions: [{ value: String(v) }] });
    } else if (mod.type === 'sliders') {
      const digits = [...String(game.code)].map(Number);
      const ORD = { pierwszą: 1, drugą: 2, trzecią: 3, pierwsza: 1, druga: 2, trzecia: 3 };
      const bm = page.bonus.text.match(/^Jeśli plomba jest (\S+), dodaj (\d) do każdego suwaka\./);
      const add = bm[1] === game.seal ? Number(bm[2]) : 0;
      const levels = mod.pub.colors.map((color) => {
        const t = page.rules.find((r) => r.color === color).text;
        let m;
        let v;
        if ((m = t.match(/^ustaw (\d)$/))) v = Number(m[1]);
        else if ((m = t.match(/^ustaw na (\S+) cyfrę kodu$/))) v = digits[ORD[m[1]] - 1];
        else if ((m = t.match(/^ustaw na 9 minus (\S+) cyfra kodu$/))) v = 9 - digits[ORD[m[1]] - 1];
        else if (t === 'ustaw na ostatnią cyfrę sumy cyfr kodu') v = digitSum(game.code) % 10;
        else throw new Error('nieznana reguła suwaka: ' + t);
        return (v + add) % 10;
      });
      plan.push({ id: mod.id, actions: [{ levels }] });
    } else if (mod.type === 'grid') {
      const t = page.rules.find((r) => r.seal === game.seal).text;
      const m = t.match(/^wciśnij liczby (.+), od (najmniejszej do największej|największej do najmniejszej)$/);
      assert.ok(m, 'nieznana reguła siatki: ' + t);
      const w = m[1];
      let ok;
      let k;
      if (w === 'parzyste') ok = (n) => n % 2 === 0;
      else if (w === 'nieparzyste') ok = (n) => n % 2 === 1;
      else if (w === 'podzielne przez 3') ok = (n) => n % 3 === 0;
      else if ((k = w.match(/^większe niż (\d)$/))) ok = (n) => n > Number(k[1]);
      else if ((k = w.match(/^mniejsze niż (\d)$/))) ok = (n) => n < Number(k[1]);
      else throw new Error('nieznany warunek siatki: ' + w);
      const desc = m[2].startsWith('największej');
      const cells = mod.pub.cells;
      const idx = cells.map((n, i) => i).filter((i) => ok(cells[i]));
      idx.sort((p, q) => (desc ? cells[q] - cells[p] : cells[p] - cells[q]));
      plan.push({ id: mod.id, actions: idx.map((p) => ({ pos: p })) });
    } else if (mod.type === 'dial') {
      const r = page.rows.indexOf(mod.pub.a);
      const c = page.cols.indexOf(mod.pub.b);
      const word = page.cells[r][c].text.split(' ')[1];
      const pos = E.DIAL_POS.indexOf(word);
      assert.ok(pos >= 0, 'nieznany kierunek pokrętła: ' + page.cells[r][c].text);
      plan.push({ id: mod.id, actions: [{ pos }] });
    }
  }
  return plan;
}

/** Ruch, który na pewno jest zły, dla modułu `mod`, gdy `good` to pierwsza poprawna akcja. */
function wrongAction(mod, good) {
  switch (mod.type) {
    case 'wires': return { index: mod.pub.wires.findIndex((_, i) => i !== good.index && !(mod.pub.cut && mod.pub.cut[i])) };
    case 'switches': return { states: good.states.map((x) => !x) };
    case 'symbols': return { pos: [0, 1, 2, 3].find((p) => p !== good.pos) };
    case 'cipher': return { value: String(Number(good.value) + 1) };
    case 'sliders': return { levels: good.levels.map((x, i) => (i === 0 ? (x + 1) % 10 : x)) };
    case 'grid': return { pos: [0, 1, 2, 3, 4, 5, 6, 7, 8].find((p) => p !== good.pos) };
    case 'dial': return { pos: (good.pos + 1) % 8 };
    default: throw new Error('nieznany moduł ' + mod.type);
  }
}

module.exports = { textCond, textAct, solveFromTexts, digitSum, wrongAction };
