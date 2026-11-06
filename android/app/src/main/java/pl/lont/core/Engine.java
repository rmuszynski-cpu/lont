package pl.lont.core;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;

/**
 * LONT – silnik gry (wersja Java, odpowiednik engine.js).
 * Generuje bombę (co widzi rozbrajacz), instrukcję (co widzą eksperci) i sprawdza ruchy.
 * Czysta Java, bez zależności od Androida, więc da się ją testować na zwykłym komputerze.
 */
public final class Engine {
    private Engine() { }

    public static final String[] WIRE_COLORS = {"czerwony", "niebieski", "żółty", "zielony", "biały", "czarny"};
    public static final String[] COLORS4 = {"czerwona", "zielona", "niebieska", "żółta"};
    public static final String[] SYMBOL_NAMES = {"trójkąt", "koło", "kwadrat", "gwiazdka", "plus", "romb", "księżyc", "serce"};
    public static final String[] MODULE_TYPES = {"wires", "switches", "symbols", "cipher", "sliders", "grid", "dial"};
    public static final String[] SLIDER_COLORS = {"czerwony", "niebieski", "żółty", "zielony"};
    public static final String[] DIAL_POS = {"góra", "prawo-góra", "prawo", "prawo-dół", "dół", "lewo-dół", "lewo", "lewo-góra"};
    public static final String[] DIAL_ARROWS = {"↑", "↗", "→", "↘", "↓", "↙", "←", "↖"};
    public static final int MAX_STRIKES = 3;
    public static final long STRIKE_PENALTY_MS = 30000L;
    public static final int SWITCH_COUNT = 5;

    public static final class Difficulty {
        public final String label;
        public final int modules;
        public final int time;

        Difficulty(String label, int modules, int time) {
            this.label = label;
            this.modules = modules;
            this.time = time;
        }
    }

    public static final Map<String, Difficulty> DIFFICULTY = new LinkedHashMap<String, Difficulty>();
    private static final Map<String, String> TITLES = new LinkedHashMap<String, String>();
    private static final Map<String, String> WIRE_GEN = new LinkedHashMap<String, String>();

    static {
        DIFFICULTY.put("easy", new Difficulty("Łatwy", 3, 300));
        DIFFICULTY.put("normal", new Difficulty("Średni", 4, 360));
        DIFFICULTY.put("hard", new Difficulty("Trudny", 5, 360));
        TITLES.put("wires", "Kable");
        TITLES.put("switches", "Przełączniki");
        TITLES.put("symbols", "Symbole");
        TITLES.put("cipher", "Szyfr");
        TITLES.put("sliders", "Suwaki");
        TITLES.put("grid", "Siatka");
        TITLES.put("dial", "Pokrętło");
        WIRE_GEN.put("czerwony", "czerwonego");
        WIRE_GEN.put("niebieski", "niebieskiego");
        WIRE_GEN.put("żółty", "żółtego");
        WIRE_GEN.put("zielony", "zielonego");
        WIRE_GEN.put("biały", "białego");
        WIRE_GEN.put("czarny", "czarnego");
    }

    public static String title(String type) {
        return TITLES.get(type);
    }

    /* ---------- losowanie i pomocnicze ---------- */

    public static final class Rng {
        private final Random r;

        public Rng(Random r) {
            this.r = r;
        }

        public int next(int n) {
            return r.nextInt(n);
        }

        public double d() {
            return r.nextDouble();
        }

        public <T> T pick(T[] a) {
            return a[next(a.length)];
        }

        public <T> List<T> shuffle(List<T> src) {
            List<T> out = new ArrayList<T>(src);
            for (int i = out.size() - 1; i > 0; i--) {
                int j = next(i + 1);
                T t = out.get(i);
                out.set(i, out.get(j));
                out.set(j, t);
            }
            return out;
        }
    }

    static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    static List<Object> strs(String[] a) {
        return new ArrayList<Object>(Arrays.asList((Object[]) a));
    }

    static List<Object> ints(int[] a) {
        List<Object> l = new ArrayList<Object>();
        for (int x : a) l.add(Integer.valueOf(x));
        return l;
    }

    static List<Object> bools(boolean[] a) {
        List<Object> l = new ArrayList<Object>();
        for (boolean x : a) l.add(Boolean.valueOf(x));
        return l;
    }

    static List<Object> falses(int n) {
        List<Object> l = new ArrayList<Object>();
        for (int i = 0; i < n; i++) l.add(Boolean.FALSE);
        return l;
    }

    public static int digitSum(String s) {
        int t = 0;
        for (int i = 0; i < s.length(); i++) t += s.charAt(i) - '0';
        return t;
    }

    static int indexOf(String[] a, String v) {
        for (int i = 0; i < a.length; i++) if (a[i].equals(v)) return i;
        return -1;
    }

    /* ---------- modele danych ---------- */

    public static final class Module {
        public final String id;
        public final String type;
        public boolean solved;
        public final Map<String, Object> pub;
        public final Map<String, Object> page;
        int solInt;
        int[] solArr;
        boolean[] solBool;
        int next;

        Module(String id, String type, Map<String, Object> pub, Map<String, Object> page) {
            this.id = id;
            this.type = type;
            this.pub = pub;
            this.page = page;
        }
    }

    public static final class Game {
        public String difficulty;
        public String seal;
        public String code;
        public int timeSec;
        public final List<Module> modules = new ArrayList<Module>();
        public final List<Map<String, Object>> pages = new ArrayList<Map<String, Object>>();
    }

    public static final class Result {
        public final String result; // "ok" | "strike" | "invalid"
        public final boolean solved;

        Result(String result, boolean solved) {
            this.result = result;
            this.solved = solved;
        }
    }

    private static final Result INVALID = new Result("invalid", false);
    private static final Result STRIKE = new Result("strike", false);

    /* ---------- moduł: KABLE ---------- */

    private static final class Cond {
        String t;
        String c;
        String s;
        boolean even;
    }

    private static final class Act {
        String t;
        String c;
        int k;

        Act(String t, String c, int k) {
            this.t = t;
            this.c = c;
            this.k = k;
        }
    }

    private static final class WRule {
        String key;
        Cond cond;
        Act act;
        String ifText;
        String thenText;
    }

    private static final class WSection {
        int n;
        List<WRule> rules = new ArrayList<WRule>();
        Act fallback;
        String fallbackText;
    }

    private static String wireCondText(Cond c) {
        switch (c.t) {
            case "none": return "nie ma ani jednego " + WIRE_GEN.get(c.c) + " kabla";
            case "one": return "jest dokładnie jeden " + c.c + " kabel";
            case "multi": return "jest więcej niż jeden " + c.c + " kabel";
            case "first": return "pierwszy kabel (od góry) jest " + c.c;
            case "last": return "ostatni kabel (na dole) jest " + c.c;
            case "seal": return "plomba jest " + c.s;
            case "parity": return "suma cyfr kodu jest " + (c.even ? "parzysta" : "nieparzysta");
            default: throw new IllegalStateException("cond?");
        }
    }

    private static String wireActText(Act a) {
        switch (a.t) {
            case "index": return "przetnij kabel nr " + a.k;
            case "last": return "przetnij ostatni kabel";
            case "firstOf": return "przetnij pierwszy " + a.c + " kabel";
            case "lastOf": return "przetnij ostatni " + a.c + " kabel";
            default: throw new IllegalStateException("act?");
        }
    }

    private static int count(List<String> w, String c) {
        int n = 0;
        for (String x : w) if (x.equals(c)) n++;
        return n;
    }

    private static boolean wireCond(Cond c, List<String> wires, String seal, String code) {
        switch (c.t) {
            case "none": return !wires.contains(c.c);
            case "one": return count(wires, c.c) == 1;
            case "multi": return count(wires, c.c) >= 2;
            case "first": return wires.get(0).equals(c.c);
            case "last": return wires.get(wires.size() - 1).equals(c.c);
            case "seal": return seal.equals(c.s);
            case "parity": return (digitSum(code) % 2 == 0) == c.even;
            default: return false;
        }
    }

    private static int wireAct(Act a, List<String> wires) {
        switch (a.t) {
            case "index": return a.k - 1;
            case "last": return wires.size() - 1;
            case "firstOf": return wires.indexOf(a.c);
            case "lastOf": return wires.lastIndexOf(a.c);
            default: return -1;
        }
    }

    private static Act randIndex(Rng rng, int n) {
        return new Act("index", null, 1 + rng.next(n));
    }

    private static WRule makeWireRule(Rng rng, int kind, int n) {
        WRule r = new WRule();
        Cond c = new Cond();
        r.cond = c;
        switch (kind) {
            case 0:
                c.t = "none"; c.c = rng.pick(WIRE_COLORS);
                r.act = rng.d() < 0.3 ? new Act("last", null, 0) : randIndex(rng, n);
                break;
            case 1:
                c.t = "multi"; c.c = rng.pick(WIRE_COLORS);
                r.act = new Act(rng.d() < 0.5 ? "firstOf" : "lastOf", c.c, 0);
                break;
            case 2:
                c.t = "one"; c.c = rng.pick(WIRE_COLORS);
                r.act = new Act("firstOf", c.c, 0);
                break;
            case 3:
                c.t = "first"; c.c = rng.pick(WIRE_COLORS);
                r.act = rng.d() < 0.5 ? new Act("last", null, 0) : randIndex(rng, n);
                break;
            case 4:
                c.t = "last"; c.c = rng.pick(WIRE_COLORS);
                r.act = randIndex(rng, n);
                break;
            case 5:
                c.t = "seal"; c.s = rng.pick(COLORS4);
                r.act = randIndex(rng, n);
                break;
            default:
                c.t = "parity"; c.even = rng.d() < 0.5;
                r.act = randIndex(rng, n);
                break;
        }
        r.key = kind <= 4 ? c.t + ":" + c.c : c.t;
        r.ifText = wireCondText(c);
        r.thenText = wireActText(r.act);
        return r;
    }

    private static WSection genWireSection(Rng rng, int n) {
        WSection s = new WSection();
        s.n = n;
        Set<String> keys = new HashSet<String>();
        while (s.rules.size() < 3) {
            WRule r = makeWireRule(rng, rng.next(7), n);
            if (keys.contains(r.key)) continue;
            keys.add(r.key);
            s.rules.add(r);
        }
        s.fallback = rng.d() < 0.4 ? new Act("last", null, 0) : randIndex(rng, n);
        s.fallbackText = wireActText(s.fallback);
        return s;
    }

    private static int solveWires(WSection s, List<String> wires, String seal, String code) {
        for (WRule r : s.rules) {
            if (wireCond(r.cond, wires, seal, code)) return wireAct(r.act, wires);
        }
        return wireAct(s.fallback, wires);
    }

    private static Module buildWires(Rng rng, String id, String seal, String code) {
        List<WSection> sections = new ArrayList<WSection>();
        for (int n = 3; n <= 6; n++) sections.add(genWireSection(rng, n));
        int n = 3 + rng.next(4);
        List<String> wires = new ArrayList<String>();
        for (int i = 0; i < n; i++) wires.add(rng.pick(WIRE_COLORS));
        WSection section = sections.get(n - 3);
        List<Object> pageSections = new ArrayList<Object>();
        for (WSection s : sections) {
            List<Object> rules = new ArrayList<Object>();
            for (WRule r : s.rules) rules.add(map("if", r.ifText, "then", r.thenText));
            pageSections.add(map("n", Integer.valueOf(s.n), "rules", rules, "fallback", map("then", s.fallbackText)));
        }
        Map<String, Object> pub = map("wires", new ArrayList<Object>(wires), "cut", falses(n));
        Map<String, Object> page = map("type", "wires", "title", TITLES.get("wires"), "sections", pageSections);
        Module m = new Module(id, "wires", pub, page);
        m.solInt = solveWires(section, wires, seal, code);
        return m;
    }

    /* ---------- moduł: PRZEŁĄCZNIKI ---------- */

    private static final String[] SW_KEYS = {"on", "off", "same", "opp"};
    private static final String[] SW_TEXTS = {
        "ustaw WŁ", "ustaw WYŁ", "ustaw tak samo jak poprzedni (po lewej)", "ustaw odwrotnie niż poprzedni (po lewej)"};

    private static Module buildSwitches(Rng rng, String id, String seal) {
        List<Integer> order = rng.shuffle(Arrays.asList(0, 1, 2, 3));
        String[] ledBehaviour = new String[4];
        List<Object> map = new ArrayList<Object>();
        for (int i = 0; i < 4; i++) {
            ledBehaviour[i] = SW_KEYS[order.get(i)];
            map.add(map("led", COLORS4[i], "text", SW_TEXTS[order.get(i)]));
        }
        String flipSeal = rng.pick(COLORS4);
        String[] leds = new String[SWITCH_COUNT];
        boolean[] initial = new boolean[SWITCH_COUNT];
        for (int i = 0; i < SWITCH_COUNT; i++) leds[i] = rng.pick(COLORS4);
        for (int i = 0; i < SWITCH_COUNT; i++) initial[i] = rng.d() < 0.5;
        boolean[] target = new boolean[SWITCH_COUNT];
        boolean prev = false;
        for (int i = 0; i < SWITCH_COUNT; i++) {
            String b = ledBehaviour[indexOf(COLORS4, leds[i])];
            boolean v;
            if (b.equals("on")) v = true;
            else if (b.equals("off")) v = false;
            else if (b.equals("same")) v = prev;
            else v = !prev;
            target[i] = v;
            prev = v;
        }
        if (seal.equals(flipSeal)) for (int i = 0; i < SWITCH_COUNT; i++) target[i] = !target[i];
        Map<String, Object> pub = map("leds", strs(leds), "states", bools(initial));
        List<Object> notes = new ArrayList<Object>();
        notes.add("Przełączniki liczysz od lewej do prawej. Dla pierwszego przełącznika „poprzedni” to WYŁ.");
        notes.add("„Poprzedni” oznacza stan, w jakim przełącznik MA BYĆ według reguł (a nie stan początkowy).");
        Map<String, Object> page = map("type", "switches", "title", TITLES.get("switches"), "map", map,
            "flip", map("seal", flipSeal, "text", "Jeśli plomba jest " + flipSeal
                + ": po wyliczeniu wszystkich przełączników odwróć każdy z nich (WŁ ↔ WYŁ)."),
            "notes", notes);
        Module m = new Module(id, "switches", pub, page);
        m.solBool = target;
        return m;
    }

    /* ---------- moduł: SYMBOLE ---------- */

    private static Module buildSymbols(Rng rng, String id) {
        final List<Integer> order = rng.shuffle(Arrays.asList(0, 1, 2, 3, 4, 5, 6, 7));
        final List<Integer> symbols = new ArrayList<Integer>(rng.shuffle(Arrays.asList(0, 1, 2, 3, 4, 5, 6, 7)).subList(0, 4));
        List<Integer> seq = new ArrayList<Integer>(Arrays.asList(0, 1, 2, 3));
        Collections.sort(seq, new java.util.Comparator<Integer>() {
            @Override
            public int compare(Integer p, Integer q) {
                return order.indexOf(symbols.get(p)) - order.indexOf(symbols.get(q));
            }
        });
        Map<String, Object> pub = map("symbols", new ArrayList<Object>(symbols), "pressed", falses(4));
        Map<String, Object> page = map("type", "symbols", "title", TITLES.get("symbols"), "order", new ArrayList<Object>(order),
            "names", strs(SYMBOL_NAMES),
            "note", "Naciskaj symbole z bomby w kolejności z tej listy (od 1 do 8). Symbole, których na bombie nie ma, pomijasz.");
        Module m = new Module(id, "symbols", pub, page);
        m.solArr = new int[]{seq.get(0), seq.get(1), seq.get(2), seq.get(3)};
        return m;
    }

    /* ---------- moduł: SZYFR ---------- */

    private static final String[] FORMULA_TEXTS = {
        "A + B", "B + C", "A + C", "A × C", "B × 2",
        "różnica A i B (większa minus mniejsza)", "różnica B i C (większa minus mniejsza)",
        "największa z liczb A, B, C", "najmniejsza z liczb A, B, C", "A + B + C"};

    private static int formula(int f, int a, int b, int c) {
        switch (f) {
            case 0: return a + b;
            case 1: return b + c;
            case 2: return a + c;
            case 3: return a * c;
            case 4: return b * 2;
            case 5: return Math.abs(a - b);
            case 6: return Math.abs(b - c);
            case 7: return Math.max(a, Math.max(b, c));
            case 8: return Math.min(a, Math.min(b, c));
            default: return a + b + c;
        }
    }

    private static Module buildCipher(Rng rng, String id, String seal, String code) {
        List<Integer> chosen = rng.shuffle(Arrays.asList(0, 1, 2, 3, 4, 5, 6, 7, 8, 9));
        List<Object> formulas = new ArrayList<Object>();
        for (int i = 0; i < 4; i++) formulas.add(map("led", COLORS4[i], "text", FORMULA_TEXTS[chosen.get(i)]));
        boolean even = rng.d() < 0.5;
        int add = 2 + rng.next(4);
        String ptext = "Jeśli suma cyfr kodu jest " + (even ? "parzysta" : "nieparzysta") + ", dodaj " + add + " do wyniku.";
        int a = 1 + rng.next(15);
        int b = 1 + rng.next(15);
        int c = 1 + rng.next(15);
        int led = rng.next(4);
        int sol = formula(chosen.get(led), a, b, c);
        if ((digitSum(code) % 2 == 0) == even) sol += add;
        Map<String, Object> pub = map("a", Integer.valueOf(a), "b", Integer.valueOf(b), "c", Integer.valueOf(c), "led", COLORS4[led]);
        Map<String, Object> page = map("type", "cipher", "title", TITLES.get("cipher"), "formulas", formulas,
            "parity", map("text", ptext),
            "note", "Na bombie widać liczby A, B, C i kolor diody. Znajdź wzór dla koloru diody, policz wynik i dopisz ewentualną premię z reguły poniżej.");
        Module m = new Module(id, "cipher", pub, page);
        m.solInt = sol;
        return m;
    }

    /* ---------- moduł: SUWAKI ---------- */

    private static final String[] ORD_ACC = {"", "pierwszą", "drugą", "trzecią"};
    private static final String[] ORD_NOM = {"", "pierwsza", "druga", "trzecia"};

    private static Module buildSliders(Rng rng, String id, String seal, String code) {
        int[] digits = {code.charAt(0) - '0', code.charAt(1) - '0', code.charAt(2) - '0'};
        List<Object> rules = new ArrayList<Object>();
        int[] base = new int[4];
        for (int i = 0; i < 4; i++) {
            int roll = rng.next(4);
            String text;
            if (roll == 0) {
                int v = rng.next(10);
                text = "ustaw " + v;
                base[i] = v;
            } else if (roll == 1) {
                int k = 1 + rng.next(3);
                text = "ustaw na " + ORD_ACC[k] + " cyfrę kodu";
                base[i] = digits[k - 1];
            } else if (roll == 2) {
                int k = 1 + rng.next(3);
                text = "ustaw na 9 minus " + ORD_NOM[k] + " cyfra kodu";
                base[i] = 9 - digits[k - 1];
            } else {
                text = "ustaw na ostatnią cyfrę sumy cyfr kodu";
                base[i] = digitSum(code) % 10;
            }
            rules.add(map("color", SLIDER_COLORS[i], "text", text));
        }
        String bonusSeal = rng.pick(COLORS4);
        int bonusAdd = 1 + rng.next(3);
        int add = seal.equals(bonusSeal) ? bonusAdd : 0;
        int[] sol = new int[4];
        int[] initial = new int[4];
        for (int i = 0; i < 4; i++) sol[i] = (base[i] + add) % 10;
        for (int i = 0; i < 4; i++) initial[i] = rng.next(10);
        Map<String, Object> pub = map("colors", strs(SLIDER_COLORS), "levels", ints(initial));
        Map<String, Object> page = map("type", "sliders", "title", TITLES.get("sliders"), "rules", rules,
            "bonus", map("seal", bonusSeal, "text", "Jeśli plomba jest " + bonusSeal + ", dodaj " + bonusAdd
                + " do każdego suwaka. Po 9 liczysz dalej od 0."),
            "note", "Rozbrajacz ma cztery suwaki o poziomach od 0 do 9. Dla każdego koloru podaj mu poziom. Kod jest na obudowie bomby.");
        Module m = new Module(id, "sliders", pub, page);
        m.solArr = sol;
        return m;
    }

    /* ---------- moduł: SIATKA ---------- */

    private static final class GRule {
        String p;
        int k;
        boolean desc;
    }

    private static boolean gridMatch(GRule r, int n) {
        switch (r.p) {
            case "even": return n % 2 == 0;
            case "odd": return n % 2 == 1;
            case "gt": return n > r.k;
            case "lt": return n < r.k;
            case "div3": return n % 3 == 0;
            default: return false;
        }
    }

    private static String gridRuleText(GRule r) {
        String what;
        switch (r.p) {
            case "even": what = "parzyste"; break;
            case "odd": what = "nieparzyste"; break;
            case "gt": what = "większe niż " + r.k; break;
            case "lt": what = "mniejsze niż " + r.k; break;
            default: what = "podzielne przez 3"; break;
        }
        return "wciśnij liczby " + what + ", " + (r.desc ? "od największej do najmniejszej" : "od najmniejszej do największej");
    }

    private static final String[] GRID_PREDS = {"even", "odd", "gt", "lt", "div3"};

    private static Module buildGrid(Rng rng, String id, String seal) {
        List<Object> rulesOut = new ArrayList<Object>();
        Set<String> seen = new HashSet<String>();
        GRule mine = null;
        for (String s : COLORS4) {
            GRule r = null;
            String text = null;
            for (int tries = 0; tries < 50; tries++) {
                r = new GRule();
                r.p = rng.pick(GRID_PREDS);
                r.k = r.p.equals("gt") ? 3 + rng.next(3) : r.p.equals("lt") ? 5 + rng.next(3) : 0;
                r.desc = rng.d() < 0.5;
                text = gridRuleText(r);
                if (!seen.contains(text)) break;
            }
            seen.add(text);
            rulesOut.add(map("seal", s, "text", text));
            if (s.equals(seal)) mine = r;
        }
        final List<Integer> cells = rng.shuffle(Arrays.asList(1, 2, 3, 4, 5, 6, 7, 8, 9));
        List<Integer> idx = new ArrayList<Integer>();
        for (int i = 0; i < 9; i++) if (gridMatch(mine, cells.get(i))) idx.add(i);
        final boolean desc = mine.desc;
        Collections.sort(idx, new java.util.Comparator<Integer>() {
            @Override
            public int compare(Integer p, Integer q) {
                return desc ? cells.get(q) - cells.get(p) : cells.get(p) - cells.get(q);
            }
        });
        Map<String, Object> pub = map("cells", new ArrayList<Object>(cells), "pressed", falses(9));
        Map<String, Object> page = map("type", "grid", "title", TITLES.get("grid"), "rules", rulesOut,
            "note", "Rozbrajacz widzi siatkę 3 × 3 z liczbami od 1 do 9. Znajdź regułę dla koloru plomby i prowadź go po kolei. Liczby spoza reguły omijacie.");
        Module m = new Module(id, "grid", pub, page);
        m.solArr = new int[idx.size()];
        for (int i = 0; i < idx.size(); i++) m.solArr[i] = idx.get(i);
        return m;
    }

    /* ---------- moduł: POKRĘTŁO ---------- */

    private static Module buildDial(Rng rng, String id) {
        int[][] grid = new int[4][4];
        List<Object> cells = new ArrayList<Object>();
        for (int r = 0; r < 4; r++) {
            List<Object> row = new ArrayList<Object>();
            for (int c = 0; c < 4; c++) {
                grid[r][c] = rng.next(8);
                row.add(map("text", DIAL_ARROWS[grid[r][c]] + " " + DIAL_POS[grid[r][c]]));
            }
            cells.add(row);
        }
        int a = rng.next(4);
        int b = rng.next(4);
        Map<String, Object> pub = map("a", COLORS4[a], "b", COLORS4[b], "pos", Integer.valueOf(DIAL_POS.length));
        Map<String, Object> page = map("type", "dial", "title", TITLES.get("dial"), "rows", strs(COLORS4), "cols", strs(COLORS4),
            "cells", cells,
            "note", "Rozbrajacz widzi dwie diody: lewą i prawą. Wiersz tabeli to kolor lewej diody, kolumna to kolor prawej. Na przecięciu jest kierunek, w który ma ustawić pokrętło.");
        Module m = new Module(id, "dial", pub, page);
        m.solInt = grid[a][b];
        return m;
    }

    /* ---------- gra ---------- */

    /** forceTypes (opcjonalnie) wymusza zestaw modułów – tylko do testów. */
    public static Game generate(String difficulty, Rng rng, List<String> forceTypes) {
        Difficulty cfg = DIFFICULTY.get(difficulty);
        String diff = difficulty;
        if (cfg == null) {
            cfg = DIFFICULTY.get("normal");
            diff = "normal";
        }
        Game g = new Game();
        g.difficulty = diff;
        g.seal = rng.pick(COLORS4);
        g.code = String.valueOf(100 + rng.next(900));
        g.timeSec = cfg.time;
        List<String> types;
        List<String> all = Arrays.asList(MODULE_TYPES);
        if (forceTypes != null && !forceTypes.isEmpty() && all.containsAll(forceTypes)) {
            types = new ArrayList<String>(forceTypes);
        } else {
            types = new ArrayList<String>(rng.shuffle(all).subList(0, cfg.modules));
        }
        for (int i = 0; i < types.size(); i++) {
            String t = types.get(i);
            String id = "m" + i;
            Module m;
            switch (t) {
                case "wires": m = buildWires(rng, id, g.seal, g.code); break;
                case "switches": m = buildSwitches(rng, id, g.seal); break;
                case "symbols": m = buildSymbols(rng, id); break;
                case "cipher": m = buildCipher(rng, id, g.seal, g.code); break;
                case "sliders": m = buildSliders(rng, id, g.seal, g.code); break;
                case "grid": m = buildGrid(rng, id, g.seal); break;
                default: m = buildDial(rng, id); break;
            }
            g.modules.add(m);
            g.pages.add(m.page);
        }
        return g;
    }

    /* ---------- ruchy ---------- */

    private static Integer asInt(Object o) {
        if (!(o instanceof Number)) return null;
        double d = ((Number) o).doubleValue();
        if (Double.isNaN(d) || Double.isInfinite(d) || d != Math.rint(d) || Math.abs(d) > 1e9) return null;
        return Integer.valueOf((int) d);
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Object o) {
        return (List<Object>) o;
    }

    private static Result ok(Module m, boolean solved) {
        if (solved) m.solved = true;
        return new Result("ok", solved);
    }

    /**
     * Ruch rozbrajacza. "ok" = dobry ruch, "strike" = zły ruch (iskra), "invalid" = śmieciowe dane (bez kary).
     */
    @SuppressWarnings("unchecked")
    public static Result apply(Game game, String moduleId, Object actionObj) {
        Module m = null;
        for (Module x : game.modules) if (x.id.equals(moduleId)) m = x;
        if (m == null || m.solved || !(actionObj instanceof Map)) return INVALID;
        Map<String, Object> action = (Map<String, Object>) actionObj;

        switch (m.type) {
            case "wires": {
                Integer i = asInt(action.get("index"));
                List<Object> cut = list(m.pub.get("cut"));
                if (i == null || i < 0 || i >= cut.size() || Boolean.TRUE.equals(cut.get(i))) return INVALID;
                cut.set(i, Boolean.TRUE);
                return i == m.solInt ? ok(m, true) : STRIKE;
            }
            case "switches": {
                Object s = action.get("states");
                if (!(s instanceof List) || list(s).size() != SWITCH_COUNT) return INVALID;
                for (Object x : list(s)) if (!(x instanceof Boolean)) return INVALID;
                for (int i = 0; i < SWITCH_COUNT; i++) {
                    if (((Boolean) list(s).get(i)).booleanValue() != m.solBool[i]) return STRIKE;
                }
                m.pub.put("states", bools(m.solBool));
                return ok(m, true);
            }
            case "symbols": {
                Integer p = asInt(action.get("pos"));
                List<Object> pressed = list(m.pub.get("pressed"));
                if (p == null || p < 0 || p > 3 || Boolean.TRUE.equals(pressed.get(p))) return INVALID;
                if (p == m.solArr[m.next]) {
                    pressed.set(p, Boolean.TRUE);
                    m.next++;
                    return ok(m, m.next == 4);
                }
                return STRIKE;
            }
            case "cipher": {
                Object v = action.get("value");
                String vs;
                if (v instanceof Number) {
                    Integer iv = asInt(v);
                    vs = iv != null ? String.valueOf(iv) : "x";
                } else {
                    vs = String.valueOf(v);
                }
                if (!vs.matches("\\d{1,3}")) return INVALID;
                return Integer.parseInt(vs) == m.solInt ? ok(m, true) : STRIKE;
            }
            case "sliders": {
                Object s = action.get("levels");
                if (!(s instanceof List) || list(s).size() != SLIDER_COLORS.length) return INVALID;
                int[] lv = new int[SLIDER_COLORS.length];
                for (int i = 0; i < lv.length; i++) {
                    Integer x = asInt(list(s).get(i));
                    if (x == null || x < 0 || x > 9) return INVALID;
                    lv[i] = x;
                }
                if (!Arrays.equals(lv, m.solArr)) return STRIKE;
                m.pub.put("levels", ints(m.solArr));
                return ok(m, true);
            }
            case "grid": {
                Integer p = asInt(action.get("pos"));
                List<Object> pressed = list(m.pub.get("pressed"));
                if (p == null || p < 0 || p > 8 || Boolean.TRUE.equals(pressed.get(p))) return INVALID;
                if (p == m.solArr[m.next]) {
                    pressed.set(p, Boolean.TRUE);
                    m.next++;
                    return ok(m, m.next == m.solArr.length);
                }
                return STRIKE;
            }
            case "dial": {
                Integer p = asInt(action.get("pos"));
                if (p == null || p < 0 || p >= DIAL_POS.length) return INVALID;
                if (p == m.solInt) {
                    m.pub.put("pos", Integer.valueOf(p));
                    return ok(m, true);
                }
                return STRIKE;
            }
            default:
                return INVALID;
        }
    }

    public static boolean allSolved(Game g) {
        for (Module m : g.modules) if (!m.solved) return false;
        return true;
    }

    /** Teksty „jak to się rozwiązywało” – pokazywane po rundzie. */
    public static List<Object> solutionsText(Game g) {
        List<Object> out = new ArrayList<Object>();
        for (Module m : g.modules) {
            switch (m.type) {
                case "wires":
                    out.add("Kable: przetnij kabel nr " + (m.solInt + 1) + " (" + list(m.pub.get("wires")).get(m.solInt) + ")");
                    break;
                case "switches": {
                    StringBuilder b = new StringBuilder("Przełączniki: ");
                    for (int i = 0; i < m.solBool.length; i++) b.append(i > 0 ? " · " : "").append(m.solBool[i] ? "WŁ" : "WYŁ");
                    out.add(b.toString());
                    break;
                }
                case "symbols": {
                    StringBuilder b = new StringBuilder("Symbole: ");
                    for (int i = 0; i < m.solArr.length; i++) {
                        int sym = (Integer) list(m.pub.get("symbols")).get(m.solArr[i]);
                        b.append(i > 0 ? " → " : "").append(SYMBOL_NAMES[sym]);
                    }
                    out.add(b.toString());
                    break;
                }
                case "cipher":
                    out.add("Szyfr: wpisz " + m.solInt);
                    break;
                case "sliders": {
                    StringBuilder b = new StringBuilder("Suwaki: ");
                    for (int i = 0; i < SLIDER_COLORS.length; i++) b.append(i > 0 ? ", " : "").append(SLIDER_COLORS[i]).append(' ').append(m.solArr[i]);
                    out.add(b.toString());
                    break;
                }
                case "grid": {
                    StringBuilder b = new StringBuilder("Siatka: ");
                    for (int i = 0; i < m.solArr.length; i++) b.append(i > 0 ? " → " : "").append(list(m.pub.get("cells")).get(m.solArr[i]));
                    out.add(b.toString());
                    break;
                }
                default:
                    out.add("Pokrętło: " + DIAL_ARROWS[m.solInt] + " " + DIAL_POS[m.solInt]);
                    break;
            }
        }
        return out;
    }
}
