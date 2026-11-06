import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import pl.lont.core.Discovery;
import pl.lont.core.GameServer;
import pl.lont.core.Json;

/** Szybkie testy części, których nie widać przez HTTP: wyszukiwanie w sieci (UDP) i JSON. */
public final class SelfTest {
    static int failed = 0;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "OK    " : "BŁĄD ") + what);
        if (!ok) failed++;
    }

    static String http(String method, String url, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(3000);
        c.setReadTimeout(5000);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            OutputStream o = c.getOutputStream();
            o.write(body.getBytes(StandardCharsets.UTF_8));
            o.close();
        }
        InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return new String(b.toByteArray(), StandardCharsets.UTF_8);
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] a) throws Exception {
        // --- JSON ---
        Object o = Json.parse("{\"a\":[1,2.5,true,null,\"zażółć \\\"gęślą\\\" \\u0105\\n\"],\"b\":{\"c\":-3e2}}");
        Map<String, Object> m = (Map<String, Object>) o;
        List<Object> arr = (List<Object>) m.get("a");
        check(arr.size() == 5 && ((Number) arr.get(0)).intValue() == 1 && arr.get(2).equals(Boolean.TRUE) && arr.get(3) == null, "JSON: parsowanie typów");
        check("zażółć \"gęślą\" ą\n".equals(arr.get(4)), "JSON: polskie znaki i escape");
        check(Json.stringify(Json.parse(Json.stringify(m))).equals(Json.stringify(m)), "JSON: round-trip");
        boolean threw = false;
        try { Json.parse("{\"a\":"); } catch (IllegalArgumentException e) { threw = true; }
        check(threw, "JSON: uszkodzony tekst daje błąd, nie wyjątek runtime");
        check(Json.stringify(Collections.singletonMap("x", 3.0)).equals("{\"x\":3}"), "JSON: liczby całkowite bez .0");

        // --- serwer + wyszukiwanie UDP ---
        GameServer.Config cfg = new GameServer.Config();
        cfg.host = "127.0.0.1";
        cfg.port = 0;
        cfg.nativeMode = true;
        cfg.discoveryPort = 38000 + (int) (Math.random() * 1000);
        GameServer srv = new GameServer(cfg, new GameServer.Assets() {
            public byte[] load(String n) { return "<html>ok</html>".getBytes(StandardCharsets.UTF_8); }
        });
        srv.start();
        Discovery d = new Discovery(srv, cfg.discoveryPort);
        srv.setDiscovery(d);
        d.start();
        String base = "http://127.0.0.1:" + srv.port();

        check(Json.stringify(Json.parse(http("GET", base + "/api/info", null))).contains("\"native\":true"), "/api/info zgłasza tryb natywny");
        check(http("GET", base + "/api/discover", null).equals("{\"hosts\":[]}"), "/api/discover nie pokazuje własnego telefonu");

        List<Object> raw = Discovery.probe(cfg.discoveryPort, 900, Collections.<String>emptySet(), Collections.singletonList("127.0.0.1"));
        System.out.println("DIAG (bez filtrowania własnych adresów): " + Json.stringify(raw));
        // jak na telefonie: odpowiedzi z własnych adresów (poza pętlą zwrotną, której używa test) są pomijane
        java.util.Set<String> own = new java.util.HashSet<String>(pl.lont.core.Net.localAddresses());
        own.remove("127.0.0.1");
        List<Object> none = Discovery.probe(cfg.discoveryPort, 700, own, Collections.singletonList("127.0.0.1"));
        check(none.size() == 1 && ((Map<String, Object>) none.get(0)).get("rooms") instanceof List
            && ((List<Object>) ((Map<String, Object>) none.get(0)).get("rooms")).isEmpty(), "UDP: gospodarz bez pokoju odpowiada pustą listą");

        Map<String, Object> created = (Map<String, Object>) Json.parse(http("POST", base + "/api/create", "{\"name\":\"Ala\"}"));
        String code = (String) created.get("code");
        List<Object> found = Discovery.probe(cfg.discoveryPort, 1200, own, Collections.singletonList("127.0.0.1"));
        boolean has = false;
        String url = "";
        if (found.size() == 1) {
            Map<String, Object> h = (Map<String, Object>) found.get(0);
            url = (String) h.get("url");
            for (Object r : (List<Object>) h.get("rooms")) {
                Map<String, Object> rm = (Map<String, Object>) r;
                if (code.equals(rm.get("code")) && "Ala".equals(rm.get("host"))) has = true;
            }
        }
        check(has, "UDP: drugi telefon znajduje pokój " + code + " (Ala)");
        check(url.equals(base), "UDP: odpowiedź zawiera poprawny adres gry (" + url + ")");

        // Pokój pełny albo w trakcie gry nie jest ogłaszany
        http("POST", base + "/api/join", "{\"code\":\"" + code + "\",\"name\":\"Bartek\"}");
        List<Object> found2 = Discovery.probe(cfg.discoveryPort, 700, own, Collections.singletonList("127.0.0.1"));
        check(found2.size() == 1, "UDP: nadal odpowiada przy dwóch graczach w poczekalni");

        srv.stop();
        d.stop();
        System.out.println(failed == 0 ? "\nWSZYSTKO OK" : "\nBŁĘDÓW: " + failed);
        System.exit(failed == 0 ? 0 : 1);
    }
}
