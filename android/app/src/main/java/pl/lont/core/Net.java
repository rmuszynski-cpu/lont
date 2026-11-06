package pl.lont.core;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Pomocnik: adresy IP tego urządzenia. */
public final class Net {
    private Net() { }

    /** Adresy IPv4 w sieci lokalnej (bez pętli zwrotnej i link-local), najpierw 192.168.x.x. */
    public static List<String> lanAddresses() {
        List<String> pref = new ArrayList<String>();
        List<String> rest = new ArrayList<String>();
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs != null && ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> as = ni.getInetAddresses();
                while (as.hasMoreElements()) {
                    InetAddress a = as.nextElement();
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    String s = a.getHostAddress();
                    if (s.startsWith("192.168.")) pref.add(s);
                    else rest.add(s);
                }
            }
        } catch (Exception ignored) {
            // brak informacji o sieci – zwracamy to, co mamy
        }
        pref.addAll(rest);
        return pref;
    }

    /** Wszystkie lokalne adresy IPv4 (także pętla zwrotna) – do odfiltrowania własnego urządzenia. */
    public static Set<String> localAddresses() {
        Set<String> out = new HashSet<String>();
        out.add("127.0.0.1");
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs != null && ifs.hasMoreElements()) {
                Enumeration<InetAddress> as = ifs.nextElement().getInetAddresses();
                while (as.hasMoreElements()) {
                    InetAddress a = as.nextElement();
                    if (a instanceof Inet4Address) out.add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) {
            // nic
        }
        return Collections.unmodifiableSet(out);
    }

    /** Adresy rozgłoszeniowe wszystkich interfejsów (np. 192.168.1.255). */
    public static List<InetAddress> broadcastAddresses() {
        List<InetAddress> out = new ArrayList<InetAddress>();
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs != null && ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (java.net.InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getBroadcast() != null) out.add(ia.getBroadcast());
                }
            }
        } catch (Exception ignored) {
            // nic
        }
        return out;
    }
}
