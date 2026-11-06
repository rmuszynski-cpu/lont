package pl.lont;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

import pl.lont.core.Discovery;
import pl.lont.core.GameServer;

/**
 * Cała aplikacja to jedno okno przeglądarki (WebView) i serwer gry działający w tym telefonie.
 * Telefon-gospodarz zakłada pokój na swoim serwerze, a drugi telefon znajduje go w WiFi
 * (albo wpisuje adres ręcznie) i otwiera stronę gospodarza w tym samym oknie.
 */
public class MainActivity extends Activity {
    private static final int PORT = 3000;

    private WebView web;
    private GameServer server;
    private Discovery discovery;
    private WifiManager.MulticastLock multicastLock;
    private long lastBack;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); // ekran nie gaśnie w trakcie gry

        web = new WebView(this);
        web.setBackgroundColor(0xFF2B3127);
        setContentView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false); // dźwięki gry (tykanie, iskry)
        web.setWebViewClient(new WebViewClient()); // przejście na stronę gospodarza zostaje w aplikacji
        web.setWebChromeClient(new WebChromeClient());

        acquireMulticastLock();
        startServerAsync();
    }

    /** Część telefonów gubi pakiety rozgłoszeniowe bez tej blokady – a na nich opiera się „Znajdź grę w sieci”. */
    private void acquireMulticastLock() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                multicastLock = wm.createMulticastLock("lont");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
        } catch (RuntimeException e) {
            multicastLock = null; // bez tego wyszukiwanie może nie działać, ale można wpisać adres ręcznie
        }
    }

    private void startServerAsync() {
        final Activity self = this;
        new Thread(new Runnable() {
            @Override
            public void run() {
                IOException last = null;
                for (int i = 0; i < 6 && server == null; i++) { // gdyby port 3000 był zajęty, próbujemy kolejne
                    GameServer.Config cfg = new GameServer.Config();
                    cfg.port = PORT + i;
                    cfg.nativeMode = true;
                    GameServer s = new GameServer(cfg, new GameServer.Assets() {
                        @Override
                        public byte[] load(String name) throws IOException {
                            InputStream in = getAssets().open(name);
                            try {
                                ByteArrayOutputStream out = new ByteArrayOutputStream();
                                byte[] buf = new byte[8192];
                                int n;
                                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                                return out.toByteArray();
                            } finally {
                                in.close();
                            }
                        }
                    });
                    try {
                        s.start();
                        server = s;
                    } catch (IOException e) {
                        last = e;
                        s.stop();
                    }
                }
                if (server == null) {
                    final String msg = "Nie mogę uruchomić gry: " + (last != null ? last.getMessage() : "brak wolnego portu");
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(self, msg, Toast.LENGTH_LONG).show();
                        }
                    });
                    return;
                }
                discovery = new Discovery(server, Discovery.DEFAULT_PORT);
                server.setDiscovery(discovery);
                discovery.start();
                final String url = "http://127.0.0.1:" + server.port() + "/";
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (web != null) web.loadUrl(url);
                    }
                });
            }
        }, "lont-start").start();
    }

    @Override
    public void onBackPressed() {
        long now = System.currentTimeMillis();
        if (now - lastBack < 2000) {
            super.onBackPressed();
            return;
        }
        lastBack = now; // przypadkowe „Wstecz” nie ma zabijać trwającej gry
        Toast.makeText(this, "Naciśnij Wstecz jeszcze raz, aby wyjść z gry", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() {
        if (discovery != null) discovery.stop();
        if (server != null) server.stop();
        try {
            if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        } catch (RuntimeException ignored) {
            // nic
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
