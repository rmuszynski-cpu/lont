package pl.lont.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Minimalny parser i serializator JSON (bez zależności). Obiekty to Map, tablice to List. */
public final class Json {
    private final String s;
    private int i;

    private Json(String s) {
        this.s = s;
    }

    public static Object parse(String text) {
        Json p = new Json(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != p.s.length()) throw new IllegalArgumentException("śmieci po JSON");
        return v;
    }

    private void ws() {
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == ' ' || c == '\n' || c == '\r' || c == '\t') i++;
            else break;
        }
    }

    private Object value() {
        if (i >= s.length()) throw new IllegalArgumentException("koniec danych");
        char c = s.charAt(i);
        if (c == '{') return object();
        if (c == '[') return array();
        if (c == '"') return string();
        if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
        if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
        if (s.startsWith("null", i)) { i += 4; return null; }
        return number();
    }

    private Map<String, Object> object() {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        i++;
        ws();
        if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
        while (true) {
            ws();
            if (i >= s.length() || s.charAt(i) != '"') throw new IllegalArgumentException("oczekiwano klucza");
            String k = string();
            ws();
            if (i >= s.length() || s.charAt(i) != ':') throw new IllegalArgumentException("oczekiwano :");
            i++;
            ws();
            m.put(k, value());
            ws();
            if (i >= s.length()) throw new IllegalArgumentException("koniec danych");
            char c = s.charAt(i++);
            if (c == '}') return m;
            if (c != ',') throw new IllegalArgumentException("oczekiwano , lub }");
        }
    }

    private List<Object> array() {
        List<Object> l = new ArrayList<Object>();
        i++;
        ws();
        if (i < s.length() && s.charAt(i) == ']') { i++; return l; }
        while (true) {
            ws();
            l.add(value());
            ws();
            if (i >= s.length()) throw new IllegalArgumentException("koniec danych");
            char c = s.charAt(i++);
            if (c == ']') return l;
            if (c != ',') throw new IllegalArgumentException("oczekiwano , lub ]");
        }
    }

    private String string() {
        StringBuilder b = new StringBuilder();
        i++;
        while (true) {
            if (i >= s.length()) throw new IllegalArgumentException("nieskończony napis");
            char c = s.charAt(i++);
            if (c == '"') return b.toString();
            if (c == '\\') {
                if (i >= s.length()) throw new IllegalArgumentException("zły escape");
                char e = s.charAt(i++);
                switch (e) {
                    case '"': b.append('"'); break;
                    case '\\': b.append('\\'); break;
                    case '/': b.append('/'); break;
                    case 'b': b.append('\b'); break;
                    case 'f': b.append('\f'); break;
                    case 'n': b.append('\n'); break;
                    case 'r': b.append('\r'); break;
                    case 't': b.append('\t'); break;
                    case 'u':
                        if (i + 4 > s.length()) throw new IllegalArgumentException("zły \\u");
                        b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                        break;
                    default: throw new IllegalArgumentException("zły escape");
                }
            } else {
                b.append(c);
            }
        }
    }

    private Double number() {
        int st = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        if (st == i) throw new IllegalArgumentException("nieoczekiwany znak");
        try {
            return Double.valueOf(s.substring(st, i));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("zła liczba");
        }
    }

    /* ---------- serializacja ---------- */

    public static String stringify(Object o) {
        StringBuilder b = new StringBuilder(256);
        write(b, o);
        return b.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder b, Object o) {
        if (o == null) { b.append("null"); return; }
        if (o instanceof String) { quote(b, (String) o); return; }
        if (o instanceof Boolean) { b.append(((Boolean) o).booleanValue() ? "true" : "false"); return; }
        if (o instanceof Integer || o instanceof Long || o instanceof Short || o instanceof Byte) { b.append(((Number) o).longValue()); return; }
        if (o instanceof Number) {
            double d = ((Number) o).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) b.append("null");
            else if (d == Math.rint(d) && Math.abs(d) < 1e15) b.append((long) d);
            else b.append(d);
            return;
        }
        if (o instanceof Map) {
            b.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                if (!first) b.append(',');
                first = false;
                quote(b, e.getKey());
                b.append(':');
                write(b, e.getValue());
            }
            b.append('}');
            return;
        }
        if (o instanceof Iterable) {
            b.append('[');
            boolean first = true;
            for (Object x : (Iterable<Object>) o) {
                if (!first) b.append(',');
                first = false;
                write(b, x);
            }
            b.append(']');
            return;
        }
        throw new IllegalArgumentException("nieserializowalny typ: " + o.getClass());
    }

    private static void quote(StringBuilder b, String s) {
        b.append('"');
        for (int k = 0; k < s.length(); k++) {
            char c = s.charAt(k);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        b.append('"');
    }
}
