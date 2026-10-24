/*
 * KONFIGURACJA STRONY – jedyny plik, który musisz edytować po wdrożeniu.
 * Nie wpisuj tu żadnych sekretów (kluczy Stripe sk_/rk_, klucza prywatnego pieczęci) –
 * ten plik jest publiczny. Sekrety wpisuje się wyłącznie w panelu Cloudflare Pages.
 */
window.APP_CONFIG = Object.freeze({
  siteName: 'ProtokolZdawczy.pl',
  siteUrl: 'https://protokolzdawczy.pl',

  // Adres e-mail do reklamacji i kontaktu (widoczny na stronie).
  supportEmail: 'kontakt@protokolzdawczy.pl',

  payment: Object.freeze({
    // 'free'   – pełny PDF ze zdjęciami i podpisami za darmo (start, testy, budowanie ruchu)
    // 'stripe' – pełny PDF po płatności BLIK / kartą przez Stripe, weryfikowanej na serwerze
    mode: 'free',

    // Cena wyświetlana w oknie płatności (musi zgadzać się z ceną w linku Stripe).
    priceLabel: '9,99 zł',

    // Link płatności Stripe (Payment Link), np. 'https://buy.stripe.com/abc123'.
    // W Stripe ustaw przekierowanie po płatności na:
    //   https://protokolzdawczy.pl/?platnosc={CHECKOUT_SESSION_ID}
    stripePaymentLink: '',

    // Opcjonalny link "Postaw kawę" (np. https://buycoffee.to/twoj-profil) – dobrowolne wsparcie, nie zakup.
    donateUrl: ''
  }),

  seal: Object.freeze({
    // Klucz PUBLICZNY pieczęci (JSON z narzędzia tools/generator-kluczy.html) – służy do weryfikacji protokołów.
    // Przykład: { kty: 'EC', crv: 'P-256', x: '...', y: '...' }
    publicKeyJwk: null
  }),

  leads: Object.freeze({
    // Adres, na który trafiają zapytania z boksu "Kancelarie notarialne i eksperci kredytowi".
    email: 'kontakt@protokolzdawczy.pl',
    city: 'Łodzi',
    // Partnerzy wyświetlani w boksie (po podpisaniu umowy partnerskiej). Tylko adresy https://.
    // Przykład: { name: 'Kancelaria Notarialna X', kind: 'Notariusz', area: 'Łódź, Śródmieście', phone: '+48 600 000 000', url: 'https://example.pl' }
    partners: Object.freeze([])
  })
});
