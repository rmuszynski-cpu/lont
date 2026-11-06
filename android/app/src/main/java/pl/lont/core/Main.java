package pl.lont.core;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Uruchomienie na zwykłym komputerze (JVM) – służy głównie do testów tej samej wersji serwera, którą
 * aplikacja na Androida uruchamia w telefonie. Zmienne: PORT, HOST, LONT_PUBLIC (katalog z index.html),
 * LONT_UDP (port wyszukiwania), LONT_TIME, LONT_TYPES (tylko testy).
 */
public final class Main {
    private Main() { }

    public static void main(String[] args) throws Exception {
        PrintStream out = new PrintStream(System.out, true, "UTF-8");
        GameServer.Config cfg = new GameServer.Config();
        String v;
        if ((v = System.getenv("PORT")) != null) cfg.port = Integer.parseInt(v);
        if ((v = System.getenv("HOST")) != null) cfg.host = v;
        if ((v = System.getenv("LONT_UDP")) != null) cfg.discoveryPort = Integer.parseInt(v);
        if ((v = System.getenv("LONT_TIME")) != null) cfg.timeOverrideSec = Integer.valueOf(v);
        if ((v = System.getenv("LONT_TYPES")) != null) {
            cfg.forceTypes = new ArrayList<String>();
            for (String t : v.split(",")) cfg.forceTypes.add(t.trim());
        }
        cfg.nativeMode = "1".equals(System.getenv("LONT_NATIVE"));
        final File pub = new File(System.getenv("LONT_PUBLIC") != null ? System.getenv("LONT_PUBLIC") : "public");

        GameServer server = new GameServer(cfg, new GameServer.Assets() {
            @Override
            public byte[] load(String name) throws IOException {
                FileInputStream in = new FileInputStream(new File(pub, name));
                try {
                    java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
                    return b.toByteArray();
                } finally {
                    in.close();
                }
            }
        });
        server.start();
        Discovery d = new Discovery(server, cfg.discoveryPort);
        server.setDiscovery(d);
        d.start();
        out.println();
        out.println("  LONT (Java) działa na porcie " + server.port());
        List<String> lan = Net.lanAddresses();
        for (String a : lan) out.println("  http://" + a + ":" + server.port());
        Thread.currentThread().join();
    }
}
