# Protokół zdawczo-odbiorczy mieszkania – PDF ze zdjęciami i podpisem + kalkulatory 2026

**[PL]** Mobilna aplikacja internetowa (po polsku) do sporządzania protokołu zdawczo-odbiorczego mieszkania bezpośrednio w lokalu, na telefonie: stany liczników ze zdjęciami, klucze, stan pomieszczeń, dwa podpisy palcem na ekranie i jeden plik PDF A4 ze skrótem SHA-256 oraz (w wersji płatnej) pieczęcią czasu serwera z kodem QR. Do tego kalkulator taksy notarialnej, PCC i opłat sądowych oraz kalkulator ryczałtu od najmu prywatnego i rentowności.

**[EN]** A mobile-first Polish web app for apartment handover protocols (photos of utility meters, key list, room-by-room condition, two on-screen finger signatures, one A4 PDF with a SHA-256 hash and an optional server-signed timestamp seal with QR code), plus a Polish notary fee / PCC / land-registry fee calculator and a private-rental flat-rate tax (ryczałt) and ROI calculator. English summary at the bottom.

Przewodnik uruchomienia i zarabiania (EN): [`docs/LAUNCH-GUIDE.md`](docs/LAUNCH-GUIDE.md)

---

## Funkcje

**Moduł 1 – Protokół zdawczo-odbiorczy**
- Rodzaj: najem zwykły, najem okazjonalny, sprzedaż (rynek wtórny / pierwotny); dla najmu kierunek: wydanie lub zwrot lokalu (role stron zmieniają się automatycznie).
- Strony: imię i nazwisko, PESEL / nr dokumentu (opcjonalnie), telefon, e-mail.
- Liczniki: prąd G11/G12 (dwa odczyty), woda zimna, woda ciepła, gaz, C.O. / podzielniki (GJ, jedn., kWh, MWh), inne; numer seryjny, odczyt, zdjęcie (`capture="environment"` lub galeria); możliwość dodania kolejnych liczników.
- Klucze i piloty, pomieszczenia z elementami (stan: Nowy / Bardzo dobry / Dobry – normalne ślady zużycia / Uszkodzony – patrz uwagi), do 3 zdjęć usterek na element, dodawanie i usuwanie pomieszczeń i elementów.
- Kompresja zdjęć w przeglądarce (maks. 800 px szerokości, JPEG 0,75), znacznik daty i godziny na zdjęciu, usunięcie metadanych EXIF/GPS, limit 30 zdjęć.
- Dwa pola podpisu (Pointer Events + Touch Events z `preventDefault`, `touch-action: none`), „Wyczyść podpis”; **każda zmiana danych po podpisaniu usuwa podpisy**.
- PDF (pdfmake, czcionka Roboto z polskimi znakami): tabele, załącznik fotograficzny, podpisy, skrót SHA-256 dokumentu; w trybie płatnym pieczęć czasu serwera (ECDSA P-256) z kodem QR do weryfikacji.
- Bezpłatna wersja tekstowa do druku i odręcznego podpisu (w trybie płatnym ze znakiem wodnym „PODGLĄD”).
- Plik danych `.json` (do weryfikacji i dalszej edycji), automatyczny szkic w IndexedDB (usuwany po 7 dniach), przycisk „Usuń wszystkie dane z urządzenia”.
- Udostępnianie PDF przez Web Share API (e-mail, WhatsApp itd.) na telefonach.

**Moduł 2 – Kalkulatory**
- Taksa notarialna wg § 3 rozporządzenia MS w sprawie maksymalnych stawek taksy notarialnej (7 progów, limit 10 000 zł / 7 500 zł dla I grupy podatkowej), 23% VAT, wypisy (6 zł netto za stronę), wniosek wieczystoksięgowy (200 zł netto), PCC 2% (zaokrąglenie wg art. 63 Ordynacji podatkowej), zwolnienie z PCC dla pierwszego mieszkania (art. 9 pkt 17 ustawy o PCC), opłaty sądowe: wpis własności 200 zł, wpis hipoteki 200 zł, założenie księgi wieczystej 100 zł.
- Ryczałt od najmu prywatnego 8,5% / 12,5% (próg 100 000 zł lub 200 000 zł dla małżonków), rentowność brutto i netto, okres zwrotu.
- Boks leadów „Kancelarie notarialne i eksperci kredytowi w Łodzi” (wiadomość e-mail ze zgodą RODO) i lista partnerów z pliku konfiguracyjnego.

**SEO**: polskie meta tagi, Open Graph, `SoftwareApplication` i `FAQPage` JSON-LD (treść FAQ widoczna na stronie), `sitemap.xml`, `robots.txt`.

## Bezpieczeństwo (najważniejsze)

| Zagrożenie | Zabezpieczenie |
|---|---|
| Wyciek danych osobowych (PESEL, adresy, zdjęcia) | Dane nigdy nie opuszczają urządzenia – brak bazy danych do włamania. Do serwera trafia tylko skrót SHA-256. |
| XSS / wstrzyknięcie skryptu | Brak `innerHTML`/`eval`; tekst tylko przez `textContent`; ścisła polityka CSP (`script-src 'self'`, bez skryptów inline); walidacja (whitelist) danych z plików i pamięci. |
| Atak na bibliotekę z CDN | pdfmake 0.3.11 skopiowany do repozytorium (`public/assets/vendor`) i ładowany z kontrolą integralności SRI (sha384); Tailwind skompilowany do pliku CSS. Brak skryptów zewnętrznych (poza opcjonalnym, wyłączonym domyślnie Cloudflare Web Analytics). |
| Clickjacking, sniffing | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, HSTS, COOP, CORP, `Permissions-Policy` (plik `public/_headers`). |
| Obejście płatności przez sfałszowany powrót | Płatność sprawdza serwer (`functions/api/pieczec.js`) kluczem Stripe z ograniczeniami: status `paid`, **nasz** link płatności, waluta PLN, minimalna kwota, tryb live, wiek sesji ≤ 24 h, opcjonalny limit dokumentów na płatność (KV), limit żądań na IP. |
| Podrobienie pieczęci / daty | Pieczęć to podpis ECDSA P-256 z kluczem prywatnym przechowywanym wyłącznie jako sekret w Cloudflare. Weryfikacja na stronie kluczem publicznym. |
| Podmiana treści po podpisaniu | Każda zmiana danych usuwa podpisy; skrót SHA-256 obejmuje dane, zdjęcia i podpisy; import pliku nie przywraca podpisów. |
| Wyciek sekretów | Sekrety tylko w panelu Cloudflare; test automatyczny sprawdza, że w `public/` nie ma kluczy Stripe ani kluczy prywatnych; katalogi `tools/`, `scripts/`, `tests/`, `functions/` nie są publikowane jako pliki. |
| Przekierowanie płatności na obcy adres | Link płatności akceptowany wyłącznie z domeny `buy.stripe.com`; linki partnerów tylko `https://`. |

**Uczciwe ograniczenie:** PDF powstaje na telefonie użytkownika, więc programista może zmodyfikować kod we własnej przeglądarce i wygenerować PDF ze zdjęciami bez płacenia. Nie da się tego zablokować w żadnej aplikacji, która tworzy dokumenty na urządzeniu (i właśnie dzięki temu dane klientów nie trafiają na Twój serwer). Takiej osobie **nie uda się jednak podrobić pieczęci czasu serwera** – weryfikacja wykaże, że pieczęci brak lub jest fałszywa. Szczegóły: [`SECURITY.md`](SECURITY.md).

## Struktura

```
public/                     ← to publikuje Cloudflare Pages (Build output directory)
  index.html                  aplikacja (PL)
  regulamin.html              wzór regulaminu (uzupełnij pola [ ... ])
  polityka-prywatnosci.html   wzór polityki prywatności (uzupełnij pola [ ... ])
  _headers                    nagłówki bezpieczeństwa (CSP, HSTS…)
  assets/config.js            ← JEDYNY plik do edycji: tryb płatności, link Stripe, e-maile, partnerzy
  assets/app.js, core.js, calc.js, app.css, vendor/pdfmake-0.3.11/
functions/api/pieczec.js    ← funkcja serwerowa: weryfikacja płatności Stripe + pieczęć czasu
tools/generator-kluczy.html ← generator kluczy pieczęci (otwierasz lokalnie, NIE publikujesz)
scripts/                    ← build CSS, kopiowanie pdfmake, serwer lokalny, zmiana domeny, obrazki
tests/                      ← testy jednostkowe (npm test) i end-to-end w Chromium (npm run test:e2e)
src/input.css               ← źródło stylów Tailwind
```

## Wdrożenie (Cloudflare Pages – bezpłatnie)

1. Cloudflare → **Workers & Pages** → **Create** → zakładka **Pages** → **Connect to Git** → wybierz to repozytorium.
2. Ustawienia budowania: **Framework preset:** `None`, **Build command:** *(puste)*, **Build output directory:** `public`. **Save and Deploy**.
3. Strona działa od razu w trybie `free` (pełny PDF za darmo). Własna domena: projekt → **Custom domains** → **Set up a custom domain**.
4. Zmiana domeny w plikach: `npm run domain -- twojadomena.pl "TwojaMarka.pl"` (albo ręczna zamiana `protokolzdawczy.pl` w plikach z `public/`).

## Włączenie płatności (Stripe, BLIK)

1. Stripe: włącz BLIK (Settings → Payment methods), utwórz produkt 9,99 PLN i **Payment Link** z przekierowaniem po płatności na `https://TWOJA-DOMENA/?platnosc={CHECKOUT_SESSION_ID}`.
2. Stripe → Developers → API keys → **Create restricted key** z jednym uprawnieniem: *Checkout Sessions – Read*.
3. Klucze pieczęci: otwórz lokalnie `tools/generator-kluczy.html` (lub `npm run keys`).
4. Cloudflare Pages → Settings → **Variables and Secrets** (Production):
   - `STRIPE_SECRET_KEY` (Secret) = `rk_live_…`
   - `STRIPE_PAYMENT_LINK_ID` (Text) = `plink_…`
   - `SEAL_PRIVATE_JWK` (Secret) = klucz prywatny z kroku 3
   - `MIN_AMOUNT_GROSZE` (Text) = `999`
   - opcjonalnie powiązanie KV `SEAL_KV` i `MAX_SEALS_PER_PAYMENT` = `5`
5. `public/assets/config.js`: `mode: 'stripe'`, `stripePaymentLink: 'https://buy.stripe.com/…'`, `publicKeyJwk: { … }` (klucz publiczny z kroku 3). Zapisz → Cloudflare wdroży automatycznie.
6. Test: Stripe w trybie testowym + `ALLOW_TEST_PAYMENTS=true`; po teście wróć do kluczy live i **usuń** `ALLOW_TEST_PAYMENTS`.

## Praca lokalna i testy

```bash
npm ci                 # narzędzia deweloperskie (Tailwind, pdfmake)
npm test               # 27 testów jednostkowych: kalkulatory, walidacja, kryptografia, funkcja płatności
npm run serve          # podgląd na http://localhost:8788 (z nagłówkami i funkcją /api/pieczec)
npm run test:e2e       # test w Chromium (wymaga Playwright i pdftotext)
npm run build:css      # po zmianie klas Tailwind w HTML/JS
```

Aktualizacja pdfmake: zmień wersję w `package.json` → `npm install` → `npm run vendor` → wpisz nowe skróty SRI i katalog w `VENDOR` w `public/assets/app.js` → `npm test` (test sprawdza zgodność SRI).

## Zastrzeżenia prawne

Kalkulatory podają stawki maksymalne i szacunki według przepisów obowiązujących w 2026 r. (stan sprawdzony: październik 2026). Narzędzie nie jest poradą prawną ani podatkową. Podpis na ekranie to zwykły podpis elektroniczny, nie kwalifikowany. Regulamin i polityka prywatności to wzory – uzupełnij dane i najlepiej skonsultuj z prawnikiem przed uruchomieniem płatności.

---

## English summary

**What it is:** a Polish-language, mobile-first static web app (HTML + compiled Tailwind CSS + vanilla JS + HTML5 canvas + self-hosted pdfmake) for apartment handover protocols with embedded meter/defect photos, two touchscreen signatures, a SHA-256 document hash and an optional server-signed (ECDSA P-256) timestamp seal with a QR verification link; plus Polish notary-fee/PCC/court-fee and rental flat-tax/ROI calculators.

**Privacy & security model:** all protocol data, photos and signatures stay in the user's browser; the only server call (`/api/pieczec`, a Cloudflare Pages Function) receives a Stripe Checkout Session ID and a SHA-256 hash, verifies the payment server-side with a restricted Stripe key (paid, our payment link, PLN, minimum amount, live mode, ≤ 24 h old, optional per-payment KV limit, per-IP rate limit) and returns a signed seal. Strict CSP without inline scripts, SRI for vendored libraries, no `innerHTML`, whitelist sanitisation of imported data, security headers in `public/_headers`. Client-side PDF generation means a developer can bypass the paywall locally, but cannot forge the server seal.

**Deploy:** Cloudflare Pages → connect this repo → build command empty → output directory `public`. Payments: set `STRIPE_SECRET_KEY`, `STRIPE_PAYMENT_LINK_ID`, `SEAL_PRIVATE_JWK`, `MIN_AMOUNT_GROSZE` in Cloudflare, then set `mode: 'stripe'`, the payment link and the public key in `public/assets/config.js`.

**Tests:** `npm test` (unit: calculators, sanitiser, crypto, payment function) and `npm run test:e2e` (Chromium end-to-end: photos, mouse + touch signatures, PDF text extraction, Stripe flow with a mocked API, seal verification, zero CSP violations).

License: all rights reserved (no open-source licence granted).
