package pl.lont.core;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Wyszukiwanie gry w sieci WiFi (UDP). Telefon-gospodarz odpowiada na zapytanie "LONT?",
 * a drugi telefon wysyła je do całej sieci i zbiera odpowiedzi. Błąd tu nigdy nie psuje reszty gry:
 * w razie czego zostaje ręczne wpisanie adresu.
 */
public final class Discovery {
    public static final int DEFAULT_PORT = 3001;
    private static final String PROBE = "LONT?";

    private final GameServer server;
    private final int udpPort;
    private volatile boolean running;
    private DatagramSocket sock;

    public Discovery(GameServer server, int udpPort) {
        this.server = server;
        this.udpPort = udpPort;
    }

    public void start() {
        try {
            sock = new DatagramSocket(null);
            sock.setReuseAddress(true);
            sock.bind(new InetSocketAddress(udpPort));
            sock.setBroadcast(true);
        } catch (IOException e) {
            sock = null; // port zajęty – wyszukiwanie będzie niedostępne, gra działa dalej
            return;
        }
        running = true;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                byte[] buf = new byte[512];
                while (running) {
                    try {
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        sock.receive(p);
                        String msg = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                        if (!msg.startsWith(PROBE)) continue;
                        byte[] reply = Json.stringify(server.discoveryReply()).getBytes(StandardCharsets.UTF_8);
                        sock.send(new DatagramPacket(reply, reply.length, p.getAddress(), p.getPort()));
                    } catch (IOException e) {
                        if (!running) return;
                    } catch (RuntimeException e) {
                        // zły pakiet – ignorujemy
                    }
                }
            }
        }, "lont-discovery");
        t.setDaemon(true);
        t.start();
    }

    public void stop() {
        running = false;
        if (sock != null) sock.close();
    }

    public int port() {
        return udpPort;
    }

    /** Szuka gospodarzy w sieci. Zwraca listę map {url, ip, port, rooms:[{code, host, players}]}. */
    @SuppressWarnings("unchecked")
    public static List<Object> probe(int udpPort, int timeoutMs, Set<String> ownAddrs, List<String> extraTargets) {
        List<Object> hosts = new ArrayList<Object>();
        Set<String> seen = new HashSet<String>();
        DatagramSocket s = null;
        try {
            s = new DatagramSocket();
            s.setBroadcast(true);
            s.setSoTimeout(150);
            List<InetAddress> targets = new ArrayList<InetAddress>(Net.broadcastAddresses());
            try {
                targets.add(InetAddress.getByName("255.255.255.255"));
                if (extraTargets != null) for (String t : extraTargets) targets.add(InetAddress.getByName(t));
            } catch (IOException ignored) {
                // nic
            }
            byte[] probe = PROBE.getBytes(StandardCharsets.UTF_8);
            long end = System.currentTimeMillis() + timeoutMs;
            long nextSend = 0;
            int sends = 0;
            byte[] buf = new byte[2048];
            while (System.currentTimeMillis() < end) {
                if (sends < 3 && System.currentTimeMillis() >= nextSend) { // 3 próby, bo UDP bywa gubiony
                    for (InetAddress t : targets) {
                        try {
                            s.send(new DatagramPacket(probe, probe.length, t, udpPort));
                        } catch (IOException ignored) {
                            // ten adres nie działa – próbujemy kolejne
                        }
                    }
                    sends++;
                    nextSend = System.currentTimeMillis() + 400;
                }
                try {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    s.receive(p);
                    String ip = p.getAddress().getHostAddress();
                    if ((ownAddrs != null && ownAddrs.contains(ip)) || seen.contains(ip)) continue;
                    Object o = Json.parse(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                    if (!(o instanceof Map)) continue;
                    Map<String, Object> m = (Map<String, Object>) o;
                    if (!"lont".equals(m.get("app"))) continue;
                    Object port = m.get("port");
                    int port2 = port instanceof Number ? ((Number) port).intValue() : 3000;
                    seen.add(ip);
                    Map<String, Object> h = Engine.map("ip", ip, "port", Integer.valueOf(port2),
                        "url", "http://" + ip + ":" + port2, "rooms", m.get("rooms"));
                    hosts.add(h);
                } catch (SocketTimeoutException e) {
                    // czekamy dalej do końca czasu
                } catch (RuntimeException e) {
                    // zły pakiet
                }
            }
        } catch (IOException e) {
            // brak sieci – pusta lista
        } finally {
            if (s != null) s.close();
        }
        return hosts;
    }
}
