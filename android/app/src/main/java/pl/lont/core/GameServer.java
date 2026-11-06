package pl.lont.core;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * LONT – serwer gry w czystej Javie (odpowiednik server.js).
 * HTTP + Server-Sent Events: stan gry płynie do graczy, ruchy wracają przez POST.
 * Działa na zwykłej JVM (testy) i wewnątrz aplikacji na Androida (telefon-gospodarz).
 */
public final class GameServer {

    public interface Assets {
        byte[] load(String name) throws IOException;
    }

    public static final class Config {
        public int port = 3000;
        public String host = "0.0.0.0";
        public int discoveryPort = Discovery.DEFAULT_PORT;
        public boolean nativeMode = false;
        public Integer timeOverrideSec = null;   // tylko do testów
        public List<String> forceTypes = null;   // tylko do testów
    }

    private static final int MAX_PLAYERS = 8;
    private static final int MAX_ROOMS = 300;
    private static final String CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ"; // bez I, L, O
    private static final String FAVICON = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" rx=\"14\" fill=\"#14110f\"/><circle cx=\"30\" cy=\"38\" r=\"16\" fill=\"#2a2420\" stroke=\"#c9a24a\" stroke-width=\"3\"/><path d=\"M38 24 Q46 12 54 14\" stroke=\"#c9a24a\" stroke-width=\"4\" fill=\"none\" stroke-linecap=\"round\"/><circle cx=\"55\" cy=\"13\" r=\"5\" fill=\"#ffb02e\"/></svg>";
    private static final String SECURITY = "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n"
        + "Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'\r\n";

    private final Config cfg;
    private final Assets assets;
    private final Object lock = new Object();
    private final Map<String, Room> rooms = new HashMap<String, Room>();
    private final SecureRandom secure = new SecureRandom();
    private final Random gameRandom = new Random();
    private ExecutorService pool;
    private ScheduledExecutorService sched;
    private ServerSocket serverSocket;
    private volatile boolean running;
    private Discovery discovery;

    public GameServer(Config cfg, Assets assets) {
        this.cfg = cfg;
        this.assets = assets;
    }

    public void setDiscovery(Discovery d) {
        this.discovery = d;
    }

    public int port() {
        return serverSocket != null ? serverSocket.getLocalPort() : cfg.port;
    }

    /* ---------- modele ---------- */

    private static final class Conn {
        final Socket socket;
        final BlockingQueue<String> queue = new LinkedBlockingQueue<String>();
        volatile boolean closed;
        Room room;
        Player player;

        Conn(Socket socket) {
            this.socket = socket;
        }

        void close() {
            closed = true;
            try {
                socket.close();
            } catch (IOException ignored) {
                // nic
            }
        }
    }

    private static final class Player {
        String id;
        String name;
        final Set<Conn> conns = new LinkedHashSet<Conn>();
        ScheduledFuture<?> removeTimer;
    }

    private static final class GState {
        Engine.Game engine;
        String defuserId;
        List<String> expertIds;
        Map<String, List<Integer>> pageAssign;
        long endsAt;
        int strikes;
        int seq;
        Map<String, Object> lastEvent;
        String outcome;
        String reason;
        long timeLeftMs;
    }

    private static final class Room {
        String code;
        final Map<String, Player> players = new LinkedHashMap<String, Player>();
        List<String> order = new ArrayList<String>();
        String phase = "lobby";
        String difficulty = "normal";
        String defuserId;
        int round;
        int wins;
        int losses;
        GState game;
        ScheduledFuture<?> timer;
        long lastActive = System.currentTimeMillis();
    }

    /* ---------- start / stop ---------- */

    public void start() throws IOException {
        pool = Executors.newCachedThreadPool(daemonFactory("lont-http"));
        sched = Executors.newScheduledThreadPool(2, daemonFactory("lont-timer"));
        serverSocket = new ServerSocket();
        serverSocket.setReuseAddress(true);
        serverSocket.bind(new InetSocketAddress(InetAddress.getByName(cfg.host), cfg.port), 64);
        running = true;
        Thread acceptor = new Thread(new Runnable() {
            @Override
            public void run() {
                while (running) {
                    try {
                        final Socket s = serverSocket.accept();
                        pool.execute(new Runnable() {
                            @Override
                            public void run() {
                                handle(s);
                            }
                        });
                    } catch (IOException e) {
                        if (!running) return;
                    } catch (RuntimeException e) {
                        if (!running) return;
                    }
                }
            }
        }, "lont-accept");
        acceptor.setDaemon(true);
        acceptor.start();

        sched.scheduleAtFixedRate(safe(new Runnable() { // podtrzymanie SSE
            @Override
            public void run() {
                synchronized (lock) {
                    for (Room r : rooms.values()) {
                        for (Player p : r.players.values()) for (Conn c : p.conns) offer(c, ": ping\n\n");
                    }
                }
            }
        }), 15, 15, TimeUnit.SECONDS);
        sched.scheduleAtFixedRate(safe(new Runnable() { // sprzątanie starych pokoi
            @Override
            public void run() {
                synchronized (lock) {
                    long now = System.currentTimeMillis();
                    Iterator<Room> it = rooms.values().iterator();
                    while (it.hasNext()) {
                        Room r = it.next();
                        boolean anyone = false;
                        for (Player p : r.players.values()) if (!p.conns.isEmpty()) anyone = true;
                        if (!anyone && now - r.lastActive > 2L * 3600 * 1000) {
                            if (r.timer != null) r.timer.cancel(false);
                            it.remove();
                        }
                    }
                }
            }
        }), 5, 5, TimeUnit.MINUTES);
    }

    public void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
            // nic
        }
        synchronized (lock) {
            for (Room r : rooms.values()) for (Player p : r.players.values()) for (Conn c : new ArrayList<Conn>(p.conns)) c.close();
            rooms.clear();
        }
        if (sched != null) sched.shutdownNow();
        if (pool != null) pool.shutdownNow();
    }

    private static ThreadFactory daemonFactory(final String name) {
        return new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, name);
                t.setDaemon(true);
                return t;
            }
        };
    }

    private static Runnable safe(final Runnable r) {
        return new Runnable() {
            @Override
            public void run() {
                try {
                    r.run();
                } catch (RuntimeException e) {
                    // zadanie cykliczne nie może paść przez jeden błąd
                }
            }
        };
    }

    /* ---------- pomocnicze ---------- */

    private static String cleanName(Object o) {
        String s = o == null ? "" : String.valueOf(o);
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c == '<' || c == '>' || c == '&' || c == '"') continue;
            b.append(c);
        }
        String n = b.toString().trim();
        if (n.length() > 16) n = n.substring(0, 16).trim();
        return n.isEmpty() ? "Gracz" : n;
    }

    private String makeCode() {
        for (int tries = 0; tries < 200; tries++) {
            StringBuilder c = new StringBuilder();
            for (int i = 0; i < 4; i++) c.append(CODE_LETTERS.charAt(secure.nextInt(CODE_LETTERS.length())));
            if (!rooms.containsKey(c.toString())) return c.toString();
        }
        return null;
    }

    private static String uniqueName(Room room, String name) {
        Set<String> taken = new HashSet<String>();
        for (Player p : room.players.values()) taken.add(p.name.toLowerCase());
        if (!taken.contains(name.toLowerCase())) return name;
        for (int i = 2; i < 20; i++) {
            String cand = (name.length() > 13 ? name.substring(0, 13) : name) + " " + i;
            if (!taken.contains(cand.toLowerCase())) return cand;
        }
        return name;
    }

    private static Player addPlayer(Room room, String name) {
        Player p = new Player();
        p.id = UUID.randomUUID().toString();
        p.name = uniqueName(room, name);
        room.players.put(p.id, p);
        room.order.add(p.id);
        if (room.defuserId == null) room.defuserId = p.id;
        return p;
    }

    private static List<String> online(Room room) {
        List<String> out = new ArrayList<String>();
        for (String id : room.order) if (!room.players.get(id).conns.isEmpty()) out.add(id);
        return out;
    }

    private static String nextDefuser(Room room) {
        List<String> on = online(room);
        if (on.isEmpty()) return room.defuserId;
        String cur = room.game != null ? room.game.defuserId : room.defuserId;
        int i = on.indexOf(cur);
        return on.get((i + 1) % on.size());
    }

    /* ---------- widok dla konkretnego gracza ---------- */

    private Map<String, Object> viewFor(Room room, String pid) {
        GState g = room.game;
        Map<String, Object> v = new LinkedHashMap<String, Object>();
        v.put("code", room.code);
        v.put("me", pid);
        List<Object> pl = new ArrayList<Object>();
        for (String id : room.order) {
            Player p = room.players.get(id);
            pl.add(Engine.map("id", id, "name", p.name, "online", Boolean.valueOf(!p.conns.isEmpty())));
        }
        v.put("players", pl);
        v.put("phase", room.phase);
        v.put("difficulty", room.difficulty);
        v.put("defuserId", g != null && !room.phase.equals("lobby") ? g.defuserId : room.defuserId);
        v.put("round", Integer.valueOf(room.round));
        v.put("stats", Engine.map("wins", Integer.valueOf(room.wins), "losses", Integer.valueOf(room.losses)));
        v.put("serverNow", Long.valueOf(System.currentTimeMillis()));
        v.put("maxPlayers", Integer.valueOf(MAX_PLAYERS));
        if (g != null && (room.phase.equals("playing") || room.phase.equals("ended"))) {
            Engine.Game eng = g.engine;
            String role = pid.equals(g.defuserId) ? "defuser" : g.expertIds.contains(pid) ? "expert" : "spectator";
            int solved = 0;
            for (Engine.Module m : eng.modules) if (m.solved) solved++;
            Map<String, Object> game = new LinkedHashMap<String, Object>();
            game.put("role", role);
            game.put("defuserId", g.defuserId);
            game.put("expertIds", new ArrayList<Object>(g.expertIds));
            game.put("endsAt", Long.valueOf(g.endsAt));
            game.put("strikes", Integer.valueOf(g.strikes));
            game.put("maxStrikes", Integer.valueOf(Engine.MAX_STRIKES));
            game.put("penaltyMs", Long.valueOf(Engine.STRIKE_PENALTY_MS));
            game.put("solved", Integer.valueOf(solved));
            game.put("total", Integer.valueOf(eng.modules.size()));
            game.put("seq", Integer.valueOf(g.seq));
            game.put("event", g.lastEvent);
            game.put("difficulty", eng.difficulty);
            game.put("timeSec", Integer.valueOf(eng.timeSec));
            if (role.equals("defuser")) {
                List<Object> mods = new ArrayList<Object>();
                for (Engine.Module m : eng.modules) {
                    Map<String, Object> mm = Engine.map("id", m.id, "type", m.type, "title", Engine.title(m.type), "solved", Boolean.valueOf(m.solved));
                    mm.putAll(m.pub);
                    mods.add(mm);
                }
                game.put("bomb", Engine.map("seal", eng.seal, "code", eng.code, "modules", mods));
            }
            if (role.equals("expert")) {
                List<Object> pages = new ArrayList<Object>();
                for (Integer j : g.pageAssign.get(pid)) {
                    Map<String, Object> pg = Engine.map("index", j);
                    pg.putAll(eng.pages.get(j));
                    pages.add(pg);
                }
                game.put("manual", Engine.map("pages", pages, "totalPages", Integer.valueOf(eng.pages.size()),
                    "shared", Boolean.valueOf(g.expertIds.size() > 1)));
            }
            if (room.phase.equals("ended")) {
                game.put("result", Engine.map("outcome", g.outcome, "reason", g.reason, "timeLeftMs", Long.valueOf(g.timeLeftMs),
                    "solutions", Engine.solutionsText(eng), "seal", eng.seal, "code", eng.code));
            }
            v.put("game", game);
        }
        return v;
    }

    private void offer(Conn c, String msg) {
        if (c.closed) return;
        if (c.queue.size() > 200) { // klient nie nadąża – odcinamy, wróci i dostanie świeży stan
            c.close();
            return;
        }
        c.queue.offer(msg);
    }

    private void broadcast(Room room) {
        for (Player p : room.players.values()) {
            if (p.conns.isEmpty()) continue;
            String json = Json.stringify(viewFor(room, p.id));
            String msg = "event: state\ndata: " + json + "\n\n";
            for (Conn c : new ArrayList<Conn>(p.conns)) offer(c, msg);
        }
    }

    /* ---------- przebieg gry ---------- */

    private void scheduleTimeout(final Room room) {
        if (room.timer != null) room.timer.cancel(false);
        GState g = room.game;
        if (g == null || !room.phase.equals("playing")) return;
        long ms = Math.max(0, g.endsAt - System.currentTimeMillis());
        room.timer = sched.schedule(safe(new Runnable() {
            @Override
            public void run() {
                synchronized (lock) {
                    if (!room.phase.equals("playing")) return;
                    if (System.currentTimeMillis() >= room.game.endsAt - 5) finish(room, "boom", "time");
                    else scheduleTimeout(room);
                }
            }
        }), ms + 30, TimeUnit.MILLISECONDS);
    }

    private void finish(Room room, String outcome, String reason) {
        GState g = room.game;
        if (g == null || !room.phase.equals("playing")) return;
        if (room.timer != null) room.timer.cancel(false);
        room.phase = "ended";
        g.outcome = outcome;
        g.reason = reason;
        g.timeLeftMs = Math.max(0, g.endsAt - System.currentTimeMillis());
        g.seq += 1;
        g.lastEvent = Engine.map("seq", Integer.valueOf(g.seq), "type", outcome.equals("defused") ? "win" : "boom");
        if (outcome.equals("defused")) room.wins += 1;
        else room.losses += 1;
        broadcast(room);
    }

    private String startGame(Room room) {
        List<String> on = online(room);
        if (on.size() < 2) return "Do gry potrzeba co najmniej 2 graczy online.";
        String defuserId = on.contains(room.defuserId) ? room.defuserId : on.get(0);
        List<String> experts = new ArrayList<String>();
        for (String id : on) if (!id.equals(defuserId)) experts.add(id);
        Engine.Game eng = Engine.generate(room.difficulty, new Engine.Rng(gameRandom), cfg.forceTypes);
        if (cfg.timeOverrideSec != null) eng.timeSec = cfg.timeOverrideSec.intValue();

        int nPages = eng.pages.size();
        Map<String, List<Integer>> assign = new HashMap<String, List<Integer>>();
        for (int k = 0; k < experts.size(); k++) {
            List<Integer> mine = new ArrayList<Integer>();
            for (int j = 0; j < nPages; j++) if (j % experts.size() == k) mine.add(Integer.valueOf(j));
            if (mine.isEmpty()) mine.add(Integer.valueOf(k % nPages)); // nadmiarowy ekspert dostaje kopię strony
            assign.put(experts.get(k), mine);
        }

        long now = System.currentTimeMillis();
        GState g = new GState();
        g.engine = eng;
        g.defuserId = defuserId;
        g.expertIds = experts;
        g.pageAssign = assign;
        g.endsAt = now + eng.timeSec * 1000L;
        room.game = g;
        room.defuserId = defuserId;
        room.phase = "playing";
        room.round += 1;
        scheduleTimeout(room);
        broadcast(room);
        return null;
    }

    private void removePlayer(Room room, String id) {
        Player p = room.players.get(id);
        if (p == null) return;
        if (p.removeTimer != null) p.removeTimer.cancel(false);
        room.players.remove(id);
        room.order.remove(id);
        for (Conn c : new ArrayList<Conn>(p.conns)) c.close();
        if (room.players.isEmpty()) {
            if (room.timer != null) room.timer.cancel(false);
            rooms.remove(room.code);
            return;
        }
        if (id.equals(room.defuserId)) room.defuserId = nextDefuser(room);
        broadcast(room);
    }

    private static Map<String, Object> err(String msg) {
        return Engine.map("error", msg);
    }

    private static Map<String, Object> okMap() {
        return Engine.map("ok", Boolean.TRUE);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> handleAct(Room room, Player player, Map<String, Object> body) {
        String op = body.get("op") instanceof String ? (String) body.get("op") : "";
        GState g = room.game;
        switch (op) {
            case "setDifficulty": {
                if (room.phase.equals("playing")) return err("Trwa gra.");
                Object v = body.get("value");
                if (!(v instanceof String) || !Engine.DIFFICULTY.containsKey(v)) return err("Zły poziom.");
                room.difficulty = (String) v;
                broadcast(room);
                return okMap();
            }
            case "setDefuser": {
                if (room.phase.equals("playing")) return err("Trwa gra.");
                Object v = body.get("value");
                if (!(v instanceof String) || !room.players.containsKey(v)) return err("Nie ma takiego gracza.");
                room.defuserId = (String) v;
                broadcast(room);
                return okMap();
            }
            case "start": {
                if (!room.phase.equals("lobby")) return err("Gra już trwa.");
                String e = startGame(room);
                return e != null ? err(e) : okMap();
            }
            case "again": {
                if (!room.phase.equals("ended")) return err("Runda jeszcze trwa.");
                room.defuserId = nextDefuser(room);
                String e = startGame(room);
                return e != null ? err(e) : okMap();
            }
            case "lobby":
                if (!room.phase.equals("ended")) return err("Runda jeszcze trwa.");
                room.defuserId = nextDefuser(room);
                room.phase = "lobby";
                room.game = null;
                broadcast(room);
                return okMap();
            case "leave":
                if (room.phase.equals("playing")) return err("Nie można wyjść w trakcie rundy.");
                removePlayer(room, player.id);
                return okMap();
            case "play": {
                if (!room.phase.equals("playing") || g == null) return err("Gra nie trwa.");
                if (!player.id.equals(g.defuserId)) return err("Tylko rozbrajacz może dotykać bomby.");
                if (System.currentTimeMillis() >= g.endsAt) {
                    finish(room, "boom", "time");
                    Map<String, Object> m = okMap();
                    m.put("late", Boolean.TRUE);
                    return m;
                }
                String moduleId = String.valueOf(body.get("moduleId"));
                Engine.Result r = Engine.apply(g.engine, moduleId, body.get("action"));
                if (r.result.equals("invalid")) return err("Niepoprawny ruch.");
                g.seq += 1;
                if (r.result.equals("strike")) {
                    g.strikes += 1;
                    g.endsAt -= Engine.STRIKE_PENALTY_MS;
                    g.lastEvent = Engine.map("seq", Integer.valueOf(g.seq), "type", "strike", "moduleId", moduleId);
                    Map<String, Object> out = okMap();
                    out.put("result", "strike");
                    if (g.strikes >= Engine.MAX_STRIKES) { finish(room, "boom", "strikes"); return out; }
                    if (System.currentTimeMillis() >= g.endsAt) { finish(room, "boom", "time"); return out; }
                    scheduleTimeout(room);
                } else if (r.solved) {
                    g.lastEvent = Engine.map("seq", Integer.valueOf(g.seq), "type", "module", "moduleId", moduleId);
                    if (Engine.allSolved(g.engine)) {
                        finish(room, "defused", "solved");
                        Map<String, Object> out = okMap();
                        out.put("result", "ok");
                        return out;
                    }
                } else {
                    g.lastEvent = Engine.map("seq", Integer.valueOf(g.seq), "type", "step", "moduleId", moduleId);
                }
                broadcast(room);
                Map<String, Object> out = okMap();
                out.put("result", r.result);
                return out;
            }
            default:
                return err("Nieznana akcja.");
        }
    }

    /** Dane dla odpowiedzi na zapytanie wyszukiwania (UDP). */
    public Map<String, Object> discoveryReply() {
        List<Object> rs = new ArrayList<Object>();
        synchronized (lock) {
            for (Room r : rooms.values()) {
                if (!r.phase.equals("lobby") || r.players.size() >= MAX_PLAYERS) continue;
                String host = r.order.isEmpty() ? "" : r.players.get(r.order.get(0)).name;
                rs.add(Engine.map("code", r.code, "host", host, "players", Integer.valueOf(r.players.size())));
            }
        }
        return Engine.map("app", "lont", "port", Integer.valueOf(port()), "rooms", rs);
    }

    /* ---------- HTTP ---------- */

    private static final class Request {
        String method;
        String path;
        Map<String, String> query = new HashMap<String, String>();
        String body = "";
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new IOException("za długa linia");
        }
        if (c == -1 && b.size() == 0) return null;
        return new String(b.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static Request readRequest(InputStream in) throws IOException {
        String line = readLine(in);
        if (line == null || line.isEmpty()) return null;
        String[] parts = line.split(" ");
        if (parts.length < 2) return null;
        Request r = new Request();
        r.method = parts[0];
        String target = parts[1];
        int q = target.indexOf('?');
        r.path = q >= 0 ? target.substring(0, q) : target;
        if (q >= 0) {
            for (String kv : target.substring(q + 1).split("&")) {
                if (kv.isEmpty()) continue;
                int e = kv.indexOf('=');
                String k = e >= 0 ? kv.substring(0, e) : kv;
                String v = e >= 0 ? kv.substring(e + 1) : "";
                try {
                    r.query.put(URLDecoder.decode(k, "UTF-8"), URLDecoder.decode(v, "UTF-8"));
                } catch (IllegalArgumentException ignored) {
                    // zły escape – pomijamy parametr
                }
            }
        }
        int len = 0;
        String h;
        while ((h = readLine(in)) != null && !h.isEmpty()) {
            int c = h.indexOf(':');
            if (c > 0 && h.substring(0, c).trim().equalsIgnoreCase("content-length")) {
                try {
                    len = Integer.parseInt(h.substring(c + 1).trim());
                } catch (NumberFormatException e) {
                    throw new IOException("zły Content-Length");
                }
            }
        }
        if (len > 8192) throw new IOException("za duże");
        if (len > 0) {
            byte[] buf = new byte[len];
            int off = 0;
            while (off < len) {
                int n = in.read(buf, off, len - off);
                if (n < 0) throw new IOException("urwane dane");
                off += n;
            }
            r.body = new String(buf, StandardCharsets.UTF_8);
        }
        return r;
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 409: return "Conflict";
            case 503: return "Service Unavailable";
            default: return "OK";
        }
    }

    private static void respond(OutputStream out, int status, String ctype, byte[] body, String cache) throws IOException {
        String head = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
            + "Content-Type: " + ctype + "\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Cache-Control: " + cache + "\r\n"
            + "Connection: close\r\n"
            + SECURITY + "\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    private static void json(OutputStream out, int status, Object o) throws IOException {
        respond(out, status, "application/json; charset=utf-8", Json.stringify(o).getBytes(StandardCharsets.UTF_8), "no-store");
    }

    private void handle(Socket s) {
        try {
            s.setTcpNoDelay(true);
            s.setSoTimeout(10000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            Request req = readRequest(in);
            if (req == null) return;
            route(req, s, in, out);
        } catch (IOException e) {
            // klient się rozłączył albo wysłał coś dziwnego
        } catch (RuntimeException e) {
            // nie wywracamy serwera przez jeden zły request
        } finally {
            try {
                s.close();
            } catch (IOException ignored) {
                // nic
            }
        }
    }

    @SuppressWarnings("unchecked")
    private void route(Request req, Socket s, InputStream in, OutputStream out) throws IOException {
        String p = req.path;
        boolean get = req.method.equals("GET");
        boolean post = req.method.equals("POST");

        if (get && (p.equals("/") || p.equals("/index.html"))) {
            respond(out, 200, "text/html; charset=utf-8", assets.load("index.html"), "no-cache");
            return;
        }
        if (get && p.equals("/favicon.svg")) {
            respond(out, 200, "image/svg+xml", FAVICON.getBytes(StandardCharsets.UTF_8), "public, max-age=86400");
            return;
        }
        if (p.equals("/favicon.ico")) { respond(out, 204, "image/x-icon", new byte[0], "no-cache"); return; }
        if (get && p.equals("/api/health")) {
            synchronized (lock) {
                json(out, 200, Engine.map("ok", Boolean.TRUE, "rooms", Integer.valueOf(rooms.size())));
            }
            return;
        }
        if (get && p.equals("/api/info")) {
            List<Object> lan = new ArrayList<Object>();
            for (String a : Net.lanAddresses()) lan.add("http://" + a + ":" + port());
            json(out, 200, Engine.map("lan", lan, "port", Integer.valueOf(port()), "native", Boolean.valueOf(cfg.nativeMode)));
            return;
        }
        if (get && p.equals("/api/discover")) {
            List<Object> hosts = new ArrayList<Object>();
            if (cfg.nativeMode && discovery != null) hosts = Discovery.probe(discovery.port(), 1600, Net.localAddresses(), null);
            json(out, 200, Engine.map("hosts", hosts));
            return;
        }
        if (get && p.equals("/api/room")) {
            String code = String.valueOf(req.query.get("code") == null ? "" : req.query.get("code")).toUpperCase();
            String pid = req.query.get("pid");
            synchronized (lock) {
                Room room = rooms.get(code);
                json(out, 200, Engine.map("exists", Boolean.valueOf(room != null),
                    "hasPlayer", Boolean.valueOf(room != null && pid != null && room.players.containsKey(pid))));
            }
            return;
        }
        if (post && (p.equals("/api/create") || p.equals("/api/join") || p.equals("/api/act"))) {
            Map<String, Object> body;
            try {
                Object o = req.body.isEmpty() ? new LinkedHashMap<String, Object>() : Json.parse(req.body);
                if (!(o instanceof Map)) throw new IllegalArgumentException("nie obiekt");
                body = (Map<String, Object>) o;
            } catch (IllegalArgumentException e) {
                json(out, 400, err("Zły request."));
                return;
            }
            if (p.equals("/api/create")) { createRoom(out, body); return; }
            if (p.equals("/api/join")) { joinRoom(out, body); return; }
            Object code = body.get("code");
            synchronized (lock) {
                Room room = rooms.get(String.valueOf(code == null ? "" : code).toUpperCase());
                Player player = room == null ? null : room.players.get(String.valueOf(body.get("pid")));
                if (player == null) { json(out, 404, err("Brak pokoju lub gracza.")); return; }
                room.lastActive = System.currentTimeMillis();
                Map<String, Object> res = handleAct(room, player, body);
                json(out, res.containsKey("error") ? 400 : 200, res);
            }
            return;
        }
        if (get && p.equals("/api/events")) { events(req, s, in, out); return; }
        json(out, 404, err("Nie ma takiej strony."));
    }

    private void createRoom(OutputStream out, Map<String, Object> body) throws IOException {
        String name = cleanName(body.get("name"));
        synchronized (lock) {
            if (rooms.size() >= MAX_ROOMS) { json(out, 503, err("Serwer jest pełny, spróbuj za chwilę.")); return; }
            String code = makeCode();
            if (code == null) { json(out, 503, err("Nie udało się utworzyć pokoju.")); return; }
            Room room = new Room();
            room.code = code;
            rooms.put(code, room);
            Player pl = addPlayer(room, name);
            json(out, 200, Engine.map("code", code, "pid", pl.id, "name", pl.name));
        }
    }

    private void joinRoom(OutputStream out, Map<String, Object> body) throws IOException {
        String name = cleanName(body.get("name"));
        String raw = String.valueOf(body.get("code") == null ? "" : body.get("code")).toUpperCase();
        StringBuilder c = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) if (raw.charAt(i) >= 'A' && raw.charAt(i) <= 'Z') c.append(raw.charAt(i));
        String code = c.length() > 4 ? c.substring(0, 4) : c.toString();
        synchronized (lock) {
            Room room = rooms.get(code);
            if (room == null) { json(out, 404, err("Nie ma takiego pokoju. Sprawdź kod.")); return; }
            room.lastActive = System.currentTimeMillis();
            Object pidO = body.get("pid");
            if (pidO instanceof String && room.players.containsKey(pidO)) {
                json(out, 200, Engine.map("code", code, "pid", pidO, "name", room.players.get(pidO).name));
                return;
            }
            if (room.players.size() >= MAX_PLAYERS) { json(out, 409, err("Pokój jest pełny (max " + MAX_PLAYERS + " osób).")); return; }
            Player pl = addPlayer(room, name);
            broadcast(room);
            json(out, 200, Engine.map("code", code, "pid", pl.id, "name", pl.name));
        }
    }

    /** Strumień zdarzeń: ten wątek zapisuje do klienta, a drugi wykrywa jego rozłączenie. */
    private void events(Request req, Socket s, InputStream in, OutputStream out) throws IOException {
        final Conn conn = new Conn(s);
        final Room room;
        final Player player;
        synchronized (lock) {
            String code = String.valueOf(req.query.get("code") == null ? "" : req.query.get("code")).toUpperCase();
            room = rooms.get(code);
            player = room == null ? null : room.players.get(req.query.get("pid"));
            if (player == null) { json(out, 404, err("Brak pokoju lub gracza.")); return; }
            String head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache, no-transform\r\n"
                + "Connection: close\r\nX-Accel-Buffering: no\r\n" + SECURITY + "\r\n";
            out.write(head.getBytes(StandardCharsets.ISO_8859_1));
            out.write("retry: 1500\n\n".getBytes(StandardCharsets.UTF_8));
            out.flush();
            if (player.removeTimer != null) player.removeTimer.cancel(false);
            conn.room = room;
            conn.player = player;
            player.conns.add(conn);
            room.lastActive = System.currentTimeMillis();
            broadcast(room); // nowy klient dostaje pierwszy stan, reszta widzi, że ktoś wrócił
        }
        s.setSoTimeout(0);
        pool.execute(new Runnable() { // wykrywanie rozłączenia: read() zwraca -1, gdy klient zamknie połączenie
            @Override
            public void run() {
                try {
                    InputStream i2 = conn.socket.getInputStream();
                    byte[] sink = new byte[64];
                    while (i2.read(sink) != -1) { /* ignorujemy */ }
                } catch (IOException ignored) {
                    // rozłączony
                }
                conn.close();
            }
        });
        try {
            while (!conn.closed && running) {
                String m = conn.queue.poll(1, TimeUnit.SECONDS);
                if (m == null) continue;
                out.write(m.getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        } catch (IOException ignored) {
            // klient zniknął
        } finally {
            conn.close();
            connClosed(room, player, conn);
        }
    }

    private void connClosed(final Room room, final Player player, Conn conn) {
        synchronized (lock) {
            player.conns.remove(conn);
            if (rooms.get(room.code) != room || !room.players.containsKey(player.id)) return;
            if (player.conns.isEmpty()) {
                if (!room.phase.equals("playing")) {
                    player.removeTimer = sched.schedule(safe(new Runnable() {
                        @Override
                        public void run() {
                            synchronized (lock) {
                                if (room.players.containsKey(player.id) && player.conns.isEmpty() && !room.phase.equals("playing")) {
                                    removePlayer(room, player.id);
                                }
                            }
                        }
                    }), 60, TimeUnit.SECONDS);
                }
                broadcast(room);
            }
        }
    }
}
