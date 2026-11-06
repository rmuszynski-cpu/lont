'use strict';
/*
 * LONT – silnik gry.
 * Generuje bombę (co zobaczy rozbrajacz), instrukcję (co zobaczą eksperci)
 * i sprawdza ruchy. Reguły są losowane co rundę, więc nie da się ich wykuć.
 * Brak zależności – czysty Node.js.
 */

const WIRE_COLORS = ['czerwony', 'niebieski', 'żółty', 'zielony', 'biały', 'czarny'];
const WIRE_GEN = {
  czerwony: 'czerwonego', niebieski: 'niebieskiego', żółty: 'żółtego',
  zielony: 'zielonego', biały: 'białego', czarny: 'czarnego',
};
const COLORS4 = ['czerwona', 'zielona', 'niebieska', 'żółta']; // plomba i diody
const SYMBOL_NAMES = ['trójkąt', 'koło', 'kwadrat', 'gwiazdka', 'plus', 'romb', 'księżyc', 'serce'];
const MODULE_TYPES = ['wires', 'switches', 'symbols', 'cipher', 'sliders', 'grid', 'dial'];
const MODULE_TITLES = {
  wires: 'Kable', switches: 'Przełączniki', symbols: 'Symbole', cipher: 'Szyfr',
  sliders: 'Suwaki', grid: 'Siatka', dial: 'Pokrętło',
};

// Gra jest pomyślana dla dwóch osób, więc modułów jest sporo: jedna osoba opisuje, druga czyta.
const DIFFICULTY = {
  easy: { label: 'Łatwy', modules: 3, time: 300 },
  normal: { label: 'Średni', modules: 4, time: 360 },
  hard: { label: 'Trudny', modules: 5, time: 360 },
};
const MAX_STRIKES = 3;
const STRIKE_PENALTY_MS = 30000;
const SWITCH_COUNT = 5;

/* ---------- losowanie ---------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (rng, n) => Math.floor(rng() * n);
const pick = (rng, arr) => arr[int(rng, arr.length)];
function shuffle(rng, arr) {
  const r = arr.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = int(rng, i + 1);
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
const digitSum = (s) => String(s).split('').reduce((a, d) => a + Number(d), 0);

/* ---------- moduł: KABLE ---------- */

function wireCondText(c) {
  switch (c.t) {
    case 'none': return `nie ma ani jednego ${WIRE_GEN[c.c]} kabla`;
    case 'one': return `jest dokładnie jeden ${c.c} kabel`;
    case 'multi': return `jest więcej niż jeden ${c.c} kabel`;
    case 'first': return `pierwszy kabel (od góry) jest ${c.c}`;
    case 'last': return `ostatni kabel (na dole) jest ${c.c}`;
    case 'seal': return `plomba jest ${c.s}`;
    case 'parity': return `suma cyfr kodu jest ${c.even ? 'parzysta' : 'nieparzysta'}`;
    default: throw new Error('cond?');
  }
}
function wireActText(a) {
  switch (a.t) {
    case 'index': return `przetnij kabel nr ${a.k}`;
    case 'last': return 'przetnij ostatni kabel';
    case 'firstOf': return `przetnij pierwszy ${a.c} kabel`;
    case 'lastOf': return `przetnij ostatni ${a.c} kabel`;
    default: throw new Error('act?');
  }
}
function wireCond(c, wires, seal, code) {
  switch (c.t) {
    case 'none': return !wires.includes(c.c);
    case 'one': return wires.filter((w) => w === c.c).length === 1;
    case 'multi': return wires.filter((w) => w === c.c).length >= 2;
    case 'first': return wires[0] === c.c;
    case 'last': return wires[wires.length - 1] === c.c;
    case 'seal': return seal === c.s;
    case 'parity': return (digitSum(code) % 2 === 0) === c.even;
    default: return false;
  }
}
function wireAct(a, wires) {
  switch (a.t) {
    case 'index': return a.k - 1;
    case 'last': return wires.length - 1;
    case 'firstOf': return wires.indexOf(a.c);
    case 'lastOf': return wires.lastIndexOf(a.c);
    default: return -1;
  }
}

function genWireSection(rng, n) {
  const randIndex = () => ({ t: 'index', k: 1 + int(rng, n) });
  const colorMaker = (t, mkAct) => () => {
    const c = pick(rng, WIRE_COLORS);
    return { key: `${t}:${c}`, cond: { t, c }, act: mkAct(c) };
  };
  const makers = [
    colorMaker('none', () => (rng() < 0.3 ? { t: 'last' } : randIndex())),
    colorMaker('multi', (c) => ({ t: rng() < 0.5 ? 'firstOf' : 'lastOf', c })),
    colorMaker('one', (c) => ({ t: 'firstOf', c })),
    colorMaker('first', () => (rng() < 0.5 ? { t: 'last' } : randIndex())),
    colorMaker('last', () => randIndex()),
    () => ({ key: 'seal', cond: { t: 'seal', s: pick(rng, COLORS4) }, act: randIndex() }),
    () => ({ key: 'parity', cond: { t: 'parity', even: rng() < 0.5 }, act: randIndex() }),
  ];
  const keys = new Set();
  const rules = [];
  while (rules.length < 3) {
    const r = pick(rng, makers)();
    if (keys.has(r.key)) continue;
    keys.add(r.key);
    rules.push({ cond: r.cond, act: r.act, if: wireCondText(r.cond), then: wireActText(r.act) });
  }
  const fbAct = rng() < 0.4 ? { t: 'last' } : randIndex();
  return { n, rules, fallback: { act: fbAct, then: wireActText(fbAct) } };
}

function solveWires(section, wires, seal, code) {
  for (const r of section.rules) {
    if (wireCond(r.cond, wires, seal, code)) return wireAct(r.act, wires);
  }
  return wireAct(section.fallback.act, wires);
}

function buildWires(rng, ctx) {
  const sections = [3, 4, 5, 6].map((n) => genWireSection(rng, n));
  const n = 3 + int(rng, 4);
  const wires = Array.from({ length: n }, () => pick(rng, WIRE_COLORS));
  const section = sections.find((s) => s.n === n);
  const sol = solveWires(section, wires, ctx.seal, ctx.code);
  return {
    pub: { wires, cut: Array(n).fill(false) },
    sol,
    state: {},
    page: { type: 'wires', title: MODULE_TITLES.wires, sections },
  };
}

/* ---------- moduł: PRZEŁĄCZNIKI ---------- */

const SWITCH_BEHAVIOURS = {
  on: 'ustaw WŁ',
  off: 'ustaw WYŁ',
  same: 'ustaw tak samo jak poprzedni (po lewej)',
  opp: 'ustaw odwrotnie niż poprzedni (po lewej)',
};

function solveSwitches(leds, map, flipSeal, seal) {
  const target = [];
  let prev = false; // dla pierwszego przełącznika „poprzedni” = WYŁ
  for (const led of leds) {
    const b = map.find((m) => m.led === led).do;
    let v;
    if (b === 'on') v = true;
    else if (b === 'off') v = false;
    else if (b === 'same') v = prev;
    else v = !prev;
    target.push(v);
    prev = v;
  }
  return seal === flipSeal ? target.map((x) => !x) : target;
}

function buildSwitches(rng, ctx) {
  const behaviours = shuffle(rng, Object.keys(SWITCH_BEHAVIOURS));
  const map = COLORS4.map((led, i) => ({ led, do: behaviours[i], text: SWITCH_BEHAVIOURS[behaviours[i]] }));
  const flipSeal = pick(rng, COLORS4);
  const leds = Array.from({ length: SWITCH_COUNT }, () => pick(rng, COLORS4));
  const initial = Array.from({ length: SWITCH_COUNT }, () => rng() < 0.5);
  const sol = solveSwitches(leds, map, flipSeal, ctx.seal);
  return {
    pub: { leds, states: initial },
    sol,
    state: {},
    page: {
      type: 'switches',
      title: MODULE_TITLES.switches,
      map,
      flip: {
        seal: flipSeal,
        text: `Jeśli plomba jest ${flipSeal}: po wyliczeniu wszystkich przełączników odwróć każdy z nich (WŁ ↔ WYŁ).`,
      },
      notes: [
        'Przełączniki liczysz od lewej do prawej. Dla pierwszego przełącznika „poprzedni” to WYŁ.',
        '„Poprzedni” oznacza stan, w jakim przełącznik MA BYĆ według reguł (a nie stan początkowy).',
      ],
    },
  };
}

/* ---------- moduł: SYMBOLE ---------- */

function buildSymbols(rng) {
  const order = shuffle(rng, [0, 1, 2, 3, 4, 5, 6, 7]);
  const symbols = shuffle(rng, [0, 1, 2, 3, 4, 5, 6, 7]).slice(0, 4);
  const seq = [0, 1, 2, 3].sort((p, q) => order.indexOf(symbols[p]) - order.indexOf(symbols[q]));
  return {
    pub: { symbols, pressed: [false, false, false, false] },
    sol: seq,
    state: { next: 0 },
    page: {
      type: 'symbols',
      title: MODULE_TITLES.symbols,
      order,
      names: SYMBOL_NAMES,
      note: 'Naciskaj symbole z bomby w kolejności z tej listy (od 1 do 8). Symbole, których na bombie nie ma, pomijasz.',
    },
  };
}

/* ---------- moduł: SZYFR ---------- */

const FORMULAS = [
  { f: 'A+B', text: 'A + B', fn: (a, b) => a + b },
  { f: 'B+C', text: 'B + C', fn: (a, b, c) => b + c },
  { f: 'A+C', text: 'A + C', fn: (a, b, c) => a + c },
  { f: 'A*C', text: 'A × C', fn: (a, b, c) => a * c },
  { f: 'B*2', text: 'B × 2', fn: (a, b) => b * 2 },
  { f: '|A-B|', text: 'różnica A i B (większa minus mniejsza)', fn: (a, b) => Math.abs(a - b) },
  { f: '|B-C|', text: 'różnica B i C (większa minus mniejsza)', fn: (a, b, c) => Math.abs(b - c) },
  { f: 'MAX', text: 'największa z liczb A, B, C', fn: (a, b, c) => Math.max(a, b, c) },
  { f: 'MIN', text: 'najmniejsza z liczb A, B, C', fn: (a, b, c) => Math.min(a, b, c) },
  { f: 'SUM', text: 'A + B + C', fn: (a, b, c) => a + b + c },
];

function buildCipher(rng, ctx) {
  const chosen = shuffle(rng, FORMULAS).slice(0, 4);
  const formulas = COLORS4.map((led, i) => ({ led, f: chosen[i].f, text: chosen[i].text }));
  const parity = { even: rng() < 0.5, add: 2 + int(rng, 4) };
  parity.text = `Jeśli suma cyfr kodu jest ${parity.even ? 'parzysta' : 'nieparzysta'}, dodaj ${parity.add} do wyniku.`;
  const a = 1 + int(rng, 15);
  const b = 1 + int(rng, 15);
  const c = 1 + int(rng, 15);
  const led = pick(rng, COLORS4);
  const fm = FORMULAS.find((x) => x.f === formulas.find((y) => y.led === led).f);
  let sol = fm.fn(a, b, c);
  if ((digitSum(ctx.code) % 2 === 0) === parity.even) sol += parity.add;
  return {
    pub: { a, b, c, led },
    sol,
    state: {},
    page: {
      type: 'cipher',
      title: MODULE_TITLES.cipher,
      formulas,
      parity,
      note: 'Na bombie widać liczby A, B, C i kolor diody. Znajdź wzór dla koloru diody, policz wynik i dopisz ewentualną premię z reguły poniżej.',
    },
  };
}

/* ---------- moduł: SUWAKI ---------- */

const SLIDER_COLORS = ['czerwony', 'niebieski', 'żółty', 'zielony'];
const ORD_ACC = { 1: 'pierwszą', 2: 'drugą', 3: 'trzecią' };
const ORD_NOM = { 1: 'pierwsza', 2: 'druga', 3: 'trzecia' };

function sliderRuleText(r) {
  switch (r.t) {
    case 'const': return `ustaw ${r.v}`;
    case 'digit': return `ustaw na ${ORD_ACC[r.k]} cyfrę kodu`;
    case 'comp': return `ustaw na 9 minus ${ORD_NOM[r.k]} cyfra kodu`;
    case 'sum': return 'ustaw na ostatnią cyfrę sumy cyfr kodu';
    default: throw new Error('slider rule?');
  }
}
function sliderRuleValue(r, code) {
  const d = String(code).split('').map(Number);
  switch (r.t) {
    case 'const': return r.v;
    case 'digit': return d[r.k - 1];
    case 'comp': return 9 - d[r.k - 1];
    case 'sum': return digitSum(code) % 10;
    default: throw new Error('slider rule?');
  }
}

function buildSliders(rng, ctx) {
  const rules = SLIDER_COLORS.map((color) => {
    const roll = int(rng, 4);
    let r;
    if (roll === 0) r = { t: 'const', v: int(rng, 10) };
    else if (roll === 1) r = { t: 'digit', k: 1 + int(rng, 3) };
    else if (roll === 2) r = { t: 'comp', k: 1 + int(rng, 3) };
    else r = { t: 'sum' };
    return { color, r, text: sliderRuleText(r) };
  });
  const bonus = { seal: pick(rng, COLORS4), add: 1 + int(rng, 3) };
  bonus.text = `Jeśli plomba jest ${bonus.seal}, dodaj ${bonus.add} do każdego suwaka. Po 9 liczysz dalej od 0.`;
  const add = ctx.seal === bonus.seal ? bonus.add : 0;
  const sol = rules.map(({ r }) => (sliderRuleValue(r, ctx.code) + add) % 10);
  return {
    pub: { colors: SLIDER_COLORS.slice(), levels: SLIDER_COLORS.map(() => int(rng, 10)) },
    sol,
    state: {},
    page: {
      type: 'sliders',
      title: MODULE_TITLES.sliders,
      rules: rules.map(({ color, text }) => ({ color, text })),
      bonus: { seal: bonus.seal, text: bonus.text },
      note: 'Rozbrajacz ma cztery suwaki o poziomach od 0 do 9. Dla każdego koloru podaj mu poziom. Kod jest na obudowie bomby.',
    },
  };
}

/* ---------- moduł: SIATKA ---------- */

function gridMatch(r, n) {
  switch (r.p) {
    case 'even': return n % 2 === 0;
    case 'odd': return n % 2 === 1;
    case 'gt': return n > r.k;
    case 'lt': return n < r.k;
    case 'div3': return n % 3 === 0;
    default: return false;
  }
}
function gridRuleText(r) {
  const what = { even: 'parzyste', odd: 'nieparzyste', gt: `większe niż ${r.k}`, lt: `mniejsze niż ${r.k}`, div3: 'podzielne przez 3' }[r.p];
  return `wciśnij liczby ${what}, ${r.desc ? 'od największej do najmniejszej' : 'od najmniejszej do największej'}`;
}

function buildGrid(rng, ctx) {
  const rules = [];
  const seen = new Set();
  for (const seal of COLORS4) {
    let r;
    let text;
    for (let tries = 0; tries < 50; tries++) {
      const p = pick(rng, ['even', 'odd', 'gt', 'lt', 'div3']);
      r = { p, k: p === 'gt' ? 3 + int(rng, 3) : p === 'lt' ? 5 + int(rng, 3) : 0, desc: rng() < 0.5 };
      text = gridRuleText(r);
      if (!seen.has(text)) break;
    }
    seen.add(text);
    rules.push({ seal, r, text });
  }
  const cells = shuffle(rng, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const mine = rules.find((x) => x.seal === ctx.seal).r;
  const sol = cells.map((n, i) => i).filter((i) => gridMatch(mine, cells[i]));
  sol.sort((p, q) => (mine.desc ? cells[q] - cells[p] : cells[p] - cells[q]));
  return {
    pub: { cells, pressed: Array(9).fill(false) },
    sol,
    state: { next: 0 },
    page: {
      type: 'grid',
      title: MODULE_TITLES.grid,
      rules: rules.map(({ seal, text }) => ({ seal, text })),
      note: 'Rozbrajacz widzi siatkę 3 × 3 z liczbami od 1 do 9. Znajdź regułę dla koloru plomby i prowadź go po kolei. Liczby spoza reguły omijacie.',
    },
  };
}

/* ---------- moduł: POKRĘTŁO ---------- */

const DIAL_POS = ['góra', 'prawo-góra', 'prawo', 'prawo-dół', 'dół', 'lewo-dół', 'lewo', 'lewo-góra'];
const DIAL_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

function buildDial(rng) {
  const grid = COLORS4.map(() => COLORS4.map(() => int(rng, 8)));
  const a = int(rng, 4);
  const b = int(rng, 4);
  return {
    pub: { a: COLORS4[a], b: COLORS4[b], pos: DIAL_POS.length },
    sol: grid[a][b],
    state: {},
    page: {
      type: 'dial',
      title: MODULE_TITLES.dial,
      rows: COLORS4.slice(),
      cols: COLORS4.slice(),
      cells: grid.map((row) => row.map((p) => ({ text: `${DIAL_ARROWS[p]} ${DIAL_POS[p]}` }))),
      note: 'Rozbrajacz widzi dwie diody: lewą i prawą. Wiersz tabeli to kolor lewej diody, kolumna to kolor prawej. Na przecięciu jest kierunek, w który ma ustawić pokrętło.',
    },
  };
}

/* ---------- gra ---------- */

const BUILDERS = {
  wires: buildWires, switches: buildSwitches, symbols: buildSymbols, cipher: buildCipher,
  sliders: buildSliders, grid: buildGrid, dial: buildDial,
};

/** `forceTypes` (opcjonalnie) wymusza zestaw modułów – używane w testach. */
function generateGame(difficulty = 'normal', rng = Math.random, forceTypes = null) {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const seal = pick(rng, COLORS4);
  const code = String(100 + int(rng, 900));
  const types = forceTypes && forceTypes.length && forceTypes.every((t) => MODULE_TYPES.includes(t))
    ? forceTypes.slice()
    : shuffle(rng, MODULE_TYPES).slice(0, cfg.modules);
  const modules = [];
  const pages = [];
  types.forEach((type, i) => {
    const b = BUILDERS[type](rng, { seal, code });
    modules.push({ id: `m${i}`, type, solved: false, pub: b.pub, sol: b.sol, state: b.state });
    pages.push(b.page);
  });
  return { difficulty: cfg === DIFFICULTY[difficulty] ? difficulty : 'normal', seal, code, timeSec: cfg.time, modules, pages };
}

/**
 * Ruch rozbrajacza. Zwraca { result: 'ok' | 'strike' | 'invalid', solved: bool }.
 * 'ok' = dobry ruch, 'strike' = zły ruch (iskra), 'invalid' = śmieciowe dane (bez kary).
 */
function applyAction(game, moduleId, action) {
  const m = game.modules.find((x) => x.id === moduleId);
  if (!m || m.solved || !action || typeof action !== 'object') return { result: 'invalid', solved: false };

  if (m.type === 'wires') {
    const i = action.index;
    if (!Number.isInteger(i) || i < 0 || i >= m.pub.wires.length || m.pub.cut[i]) return { result: 'invalid', solved: false };
    m.pub.cut[i] = true;
    if (i === m.sol) { m.solved = true; return { result: 'ok', solved: true }; }
    return { result: 'strike', solved: false };
  }

  if (m.type === 'switches') {
    const s = action.states;
    if (!Array.isArray(s) || s.length !== SWITCH_COUNT || s.some((x) => typeof x !== 'boolean')) return { result: 'invalid', solved: false };
    if (s.every((x, i) => x === m.sol[i])) {
      m.solved = true;
      m.pub.states = m.sol.slice();
      return { result: 'ok', solved: true };
    }
    return { result: 'strike', solved: false };
  }

  if (m.type === 'symbols') {
    const p = action.pos;
    if (!Number.isInteger(p) || p < 0 || p > 3 || m.pub.pressed[p]) return { result: 'invalid', solved: false };
    if (p === m.sol[m.state.next]) {
      m.pub.pressed[p] = true;
      m.state.next += 1;
      if (m.state.next === 4) { m.solved = true; return { result: 'ok', solved: true }; }
      return { result: 'ok', solved: false };
    }
    return { result: 'strike', solved: false };
  }

  if (m.type === 'cipher') {
    const v = String(action.value);
    if (!/^\d{1,3}$/.test(v)) return { result: 'invalid', solved: false };
    if (Number(v) === m.sol) { m.solved = true; return { result: 'ok', solved: true }; }
    return { result: 'strike', solved: false };
  }

  if (m.type === 'sliders') {
    const s = action.levels;
    if (!Array.isArray(s) || s.length !== SLIDER_COLORS.length || s.some((x) => !Number.isInteger(x) || x < 0 || x > 9)) {
      return { result: 'invalid', solved: false };
    }
    if (s.every((x, i) => x === m.sol[i])) {
      m.solved = true;
      m.pub.levels = m.sol.slice();
      return { result: 'ok', solved: true };
    }
    return { result: 'strike', solved: false };
  }

  if (m.type === 'grid') {
    const p = action.pos;
    if (!Number.isInteger(p) || p < 0 || p > 8 || m.pub.pressed[p]) return { result: 'invalid', solved: false };
    if (p === m.sol[m.state.next]) {
      m.pub.pressed[p] = true;
      m.state.next += 1;
      if (m.state.next === m.sol.length) { m.solved = true; return { result: 'ok', solved: true }; }
      return { result: 'ok', solved: false };
    }
    return { result: 'strike', solved: false };
  }

  if (m.type === 'dial') {
    const p = action.pos;
    if (!Number.isInteger(p) || p < 0 || p >= DIAL_POS.length) return { result: 'invalid', solved: false };
    if (p === m.sol) { m.solved = true; m.pub.pos = p; return { result: 'ok', solved: true }; }
    return { result: 'strike', solved: false };
  }

  return { result: 'invalid', solved: false };
}

const allSolved = (game) => game.modules.every((m) => m.solved);

/** Teksty „jak to się rozwiązywało” – pokazywane po rundzie. */
function solutionsText(game) {
  return game.modules.map((m) => {
    switch (m.type) {
      case 'wires': return `Kable: przetnij kabel nr ${m.sol + 1} (${m.pub.wires[m.sol]})`;
      case 'switches': return `Przełączniki: ${m.sol.map((x) => (x ? 'WŁ' : 'WYŁ')).join(' · ')}`;
      case 'symbols': return `Symbole: ${m.sol.map((p) => SYMBOL_NAMES[m.pub.symbols[p]]).join(' → ')}`;
      case 'cipher': return `Szyfr: wpisz ${m.sol}`;
      case 'sliders': return `Suwaki: ${SLIDER_COLORS.map((c, i) => `${c} ${m.sol[i]}`).join(', ')}`;
      case 'grid': return `Siatka: ${m.sol.map((i) => m.pub.cells[i]).join(' → ')}`;
      case 'dial': return `Pokrętło: ${DIAL_ARROWS[m.sol]} ${DIAL_POS[m.sol]}`;
      default: return '';
    }
  });
}

module.exports = {
  DIFFICULTY, MAX_STRIKES, STRIKE_PENALTY_MS, MODULE_TITLES, MODULE_TYPES, SYMBOL_NAMES, WIRE_COLORS, WIRE_GEN, COLORS4,
  FORMULAS, SWITCH_COUNT, SLIDER_COLORS, DIAL_POS, DIAL_ARROWS,
  mulberry32, generateGame, applyAction, allSolved, solutionsText, digitSum,
};
