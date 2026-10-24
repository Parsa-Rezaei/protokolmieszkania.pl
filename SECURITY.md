# Bezpieczeństwo / Security

## Zgłaszanie podatności
Napisz na adres z `public/.well-known/security.txt` (domyślnie kontakt@protokolzdawczy.pl). Nie publikuj szczegółów przed naprawą.

## Model zagrożeń (skrót)

1. **Dane osobowe** – protokół, PESEL, zdjęcia i podpisy są przetwarzane wyłącznie w przeglądarce. Serwer nie ma bazy danych z danymi klientów, więc nie ma czego wykraść.
2. **Płatności** – dane karty i kod BLIK obsługuje wyłącznie Stripe (strona `buy.stripe.com`). Funkcja `/api/pieczec` sprawdza sesję płatności po stronie serwera kluczem z ograniczeniami (*Checkout Sessions – Read*). Nawet jeśli ten klucz wycieknie, nie da się nim wypłacić pieniędzy, zrobić zwrotu ani zmienić ustawień konta – można jednak odczytać dane sesji płatności (np. e-maile klientów), dlatego przechowuj go wyłącznie jako sekret i w razie wycieku natychmiast go unieważnij w Stripe.
3. **Pieczęć czasu** – podpis ECDSA P-256 (WebCrypto). Klucz prywatny istnieje tylko jako sekret `SEAL_PRIVATE_JWK` w Cloudflare. Jeśli podejrzewasz wyciek: wygeneruj nową parę, podmień sekret i klucz publiczny w `config.js` (stare pieczęcie przestaną się weryfikować na stronie – zachowaj stary klucz publiczny, jeśli chcesz je nadal sprawdzać).
4. **Obejście płatności lokalnie** – możliwe dla programisty modyfikującego JavaScript we własnej przeglądarce (PDF powstaje na urządzeniu). Niemożliwe jest natomiast uzyskanie prawdziwej pieczęci serwera bez płatności.
5. **Łańcuch dostaw** – brak zależności uruchamianych w produkcji poza skopiowanym i przypiętym pdfmake 0.3.11 (SRI sha384). Pakiety npm (Tailwind, pdfmake) służą tylko do budowania. `npm audit` zgłasza umiarkowaną podatność (ReDoS/CPU) w `postcss-selector-parser` używanym przez Tailwind 3 w czasie budowania – dotyczy wyłącznie przetwarzania naszego własnego pliku CSS na komputerze dewelopera i nie trafia na stronę.
6. **Nadużycia API** – limit rozmiaru żądania (1 KB), walidacja formatu przed wywołaniem Stripe, limit 30 żądań/min na IP w instancji, opcjonalny limit dokumentów na płatność (KV). Zalecana dodatkowo reguła *Rate limiting* w Cloudflare WAF dla `/api/pieczec`.

## Obowiązkowa higiena kont właściciela
- Włącz 2FA (aplikacja uwierzytelniająca, nie SMS) w: GitHub, Cloudflare, Stripe, skrzynce e-mail, u rejestratora domeny. Zapisz kody odzyskiwania offline.
- Nigdy nie wklejaj kluczy `sk_…`/`rk_…` ani klucza prywatnego pieczęci do repozytorium, `config.js`, czatów ani e-maili.
- Ustaw repozytorium jako prywatne i włącz *Dependabot alerts* oraz *Secret scanning*.
- W Stripe włącz powiadomienia o sporach (disputes) i wypłatach; nie twórz kluczy z pełnymi uprawnieniami.
