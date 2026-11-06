# Lont

Gra dla dwojga na dwa telefony w tym samym WiFi. Jedna osoba rozbraja bombę i widzi ją na swoim ekranie. Druga ma instrukcję, ale bomby nie widzi. Trzeba gadać szybko i wyraźnie.

To oryginalna gra inspirowana ideą gier z asymetrią informacji. Moduły, reguły i teksty są własne, a instrukcja jest losowana od nowa w każdej rundzie, więc nie da się jej wykuć.

---

## A. Aplikacja na Androida (.apk)

Nie potrzeba komputera do grania. Jeden z telefonów sam jest serwerem gry. Plik .apk buduje za Ciebie GitHub, a Ty tylko go pobierasz.

**Jednorazowo, ok. 10 kliknięć (na komputerze, najlepiej):**

1. Wejdź na https://github.com i zaloguj się (albo załóż darmowe konto: Sign up).
2. Kliknij **+** w prawym górnym rogu, potem **New repository**. W polu *Repository name* wpisz `lont`. Zostaw **Public** (albo wybierz Private, zadziała tak samo). Kliknij **Create repository**.
3. Na stronie nowego repozytorium kliknij link **uploading an existing file**.
4. Rozpakuj ten ZIP. Zaznacz **całą zawartość** rozpakowanego folderu `lont` (foldery `android`, `public`, `test`, `scripts`, pliki `server.js`, `engine.js`, `apk.yml` itd.) i **przeciągnij na stronę**. Poczekaj, aż wszystko się wgra.
5. Kliknij zielone **Commit changes**.
6. **Ważny krok:** GitHub bywa, że pomija ukryty folder `.github`. Sprawdź, czy w repozytorium widzisz folder `.github`. Jeśli go nie ma:
   - kliknij **Add file → Create new file**,
   - w polu nazwy wpisz dokładnie: `.github/workflows/apk.yml` (ukośniki same utworzą foldery),
   - otwórz plik `apk.yml` z rozpakowanego folderu w Notatniku, skopiuj całą treść i wklej ją na dużym białym polu,
   - kliknij **Commit changes → Commit changes**.
7. Zakładka **Actions**: zobaczysz żółte kółko "Zbuduj APK". Poczekaj ok. 4–6 minut, aż zrobi się zielony znaczek.
8. Wróć na główną stronę repozytorium. Po prawej, w sekcji **Releases**, kliknij **Lont – najnowsza wersja na Androida**, a potem **Lont.apk**.

**Na każdym z dwóch telefonów:**

9. Otwórz stronę z punktu 8 w przeglądarce telefonu i dotknij **Lont.apk** (albo prześlij plik z komputera). Gdy telefon zapyta o instalację z nieznanych źródeł, zezwól tej jednej przeglądarce lub aplikacji "Pliki". Android ostrzeże, że plik nie pochodzi ze sklepu. To normalne, bo aplikacja nie jest w Google Play.
10. Otwórz **Lont**.

Gdy później coś poprawię, wystarczy podmienić pliki w repozytorium. Po kilku minutach pojawi się nowy Lont.apk i zainstaluje się na starej wersji bez odinstalowywania.

### Jak połączyć dwa telefony

1. **Telefon A** (gospodarz): wpisz imię i dotknij **Załóż pokój**. Pojawi się czteroliterowy kod.
2. **Telefon B**: wpisz imię i dotknij **Znajdź grę w sieci**. Pojawi się przycisk "Dołącz do pokoju XXXX".
3. Gospodarz wybiera poziom i dotyka **Start**.

Warunki: oba telefony w tym samym WiFi, a telefon gospodarza ma włączoną aplikację i świecący ekran (to on prowadzi grę, aplikacja sama pilnuje, żeby ekran nie gasł). Hotspot z jednego z telefonów powinien też zadziałać, ale tego nie sprawdzałem.

Jeśli "Znajdź grę" nic nie pokazuje: w poczekalni gospodarza jest adres w stylu `192.168.1.23:3000`. Na telefonie B rozwiń **Nie znajduję? Wpisz adres ręcznie**, wpisz ten adres i kod pokoju. Powodem jest zwykle router z włączoną izolacją klientów WiFi ("AP isolation"), czasem sieć gościnna. Wtedy pomaga przełączenie obu telefonów na główną sieć albo hotspot.

---

## B. Co jest sprawdzone, a co nie

Uczciwie: w środowisku, w którym to powstało, nie dało się zainstalować narzędzi Androida, więc **nigdy nie zbudowałem ani nie uruchomiłem pliku .apk**.

**Sprawdzone testami (automatycznie, wszystkie przechodzą):**
- generator bomb: 5000 losowych bomb na każdym poziomie oraz 3000 bomb ze wszystkimi 7 modułami da się rozbroić **wyłącznie z tekstów, które widzą gracze**, więc żadna runda nie jest niewykonalna;
- serwer w wersji dla Node.js i jego **wierna kopia w Javie** (ta sama, która siedzi w aplikacji) przechodzą te same testy dwóch graczy, w tym pełna runda, 3 iskry, koniec czasu, powrót po zerwaniu połączenia i 450 rund z rzędu;
- wyszukiwanie telefonu w sieci (UDP) działa na kopii Javy;
- interfejs przeszedłem w prawdziwej przeglądarce na rozmiarze telefonu, ze wszystkimi modułami, wygraną, wybuchem i zamianą ról.

**Niesprawdzone (zrobione starannie, ale nie uruchomione):**
- budowanie projektu Gradle (to zrobi GitHub; jeśli się wywali, w zakładce Actions zobaczysz czerwony znaczek i komunikat, który mi wklej);
- sama powłoka Androida (`MainActivity.java`): skompilowałem ją tylko na atrapach API, więc nie ma literówek, ale nie wiem, jak zachowa się na prawdziwym telefonie;
- ikona aplikacji, dźwięki i wibracje w WebView, zachowanie przy wygaszeniu ekranu, wyszukiwanie w sieciach z dziwnymi ustawieniami routera.

Aplikacja jest podpisana kluczem "debug". Do użytku prywatnego jest to bez znaczenia, ale do sklepu Google Play by się nie nadawała.

---

## C. Jak się gra

- Rozbrajacz opisuje na głos to, co widzi: kolory kabli, symbole, liczby, diody, plombę i kod na obudowie. Ekspert znajduje to w instrukcji i mówi, co zrobić.
- Błąd to iskra: minus 30 sekund. Trzy iskry albo koniec czasu i bomba wybucha.
- Po każdej rundzie role się zamieniają.
- Poziomy: łatwy (3 moduły, 5 minut), średni (4 moduły, 6 minut), trudny (5 modułów, 6 minut).
- Moduły: Kable, Przełączniki, Symbole, Szyfr, Suwaki, Siatka liczb, Pokrętło. Każdy ma własne reguły w instrukcji, a część odwołuje się do plomby i kodu na obudowie.
- Gra obsługuje do 8 osób (jedna rozbraja, reszta to eksperci), ale jest ustawiona pod dwie.

---

## D. Alternatywy

**Na komputerze (bez Androida i GitHuba).** Zainstaluj Node.js 18 lub nowszy (https://nodejs.org), w folderze wpisz `node server.js`. Program wypisze adres w stylu `http://192.168.1.23:3000`. Oba telefony otwierają ten adres w przeglądarce. Jedna osoba zakłada pokój, druga wpisuje kod albo klika link z przycisku "Kopiuj". Jeśli telefony nie widzą komputera, zezwól Node.js w zaporze systemowej na sieć prywatną.

**Android Studio.** Otwórz folder `android` i wybierz *Build → Build APK(s)*. Nie testowałem tej drogi.

## E. Dla ciekawych

- `engine.js` generuje bomby i instrukcje oraz sprawdza ruchy, `server.js` to serwer w Node.js (bez zależności), `public/index.html` to cały interfejs.
- `android/` to projekt aplikacji. W `android/app/src/main/java/pl/lont/core/` jest ta sama gra napisana w Javie, a `MainActivity.java` to okno z przeglądarką (WebView), które ładuje stronę z serwera działającego w tym samym telefonie.
- Po zmianie interfejsu uruchom `npm run sync-android`, żeby skopiować go do aplikacji. Test `npm test` pilnuje, żeby kopie były zgodne.
- Serwer pilnuje zegara i ukrywa przed każdym graczem informacje, których nie powinien mieć: rozbrajacz nie dostaje instrukcji, ekspert nie dostaje bomby, a rozwiązania nie wychodzą z serwera przed końcem rundy.
