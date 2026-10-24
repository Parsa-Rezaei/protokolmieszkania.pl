/*
 * Cloudflare Pages Function: POST /api/pieczec
 *
 * 1. Sprawdza po stronie serwera (sekretnym kluczem Stripe), czy sesja płatności Stripe
 *    jest opłacona, pochodzi z NASZEGO linku płatności, ma właściwą kwotę i walutę
 *    oraz nie jest starsza niż 24 h.
 * 2. Jeśli podano skrót dokumentu (SHA-256), zwraca podpisaną kluczem prywatnym ECDSA P-256
 *    "pieczęć czasu" { skrót, czas serwera }. Podrobienie pieczęci bez klucza prywatnego jest niemożliwe.
 *
 * Zmienne środowiskowe (Cloudflare Pages -> Settings -> Variables and Secrets):
 *   STRIPE_SECRET_KEY        (Secret)  klucz z ograniczeniami rk_live_... z uprawnieniem Checkout Sessions: Read
 *   STRIPE_PAYMENT_LINK_ID   (Text)    plink_... – identyfikator linku płatności
 *   SEAL_PRIVATE_JWK         (Secret)  prywatny klucz pieczęci (JSON) – z narzędzia tools/generator-kluczy.html
 *   MIN_AMOUNT_GROSZE        (Text)    minimalna kwota, domyślnie 999 (= 9,99 zł)
 *   ALLOW_TEST_PAYMENTS      (Text)    "true" TYLKO w środowisku testowym (Preview); w produkcji nie ustawiaj
 *   MAX_SEALS_PER_PAYMENT    (Text)    opcjonalnie, domyślnie 5 (działa, gdy podłączono KV jako SEAL_KV)
 *   SEAL_KV                  (KV)      opcjonalne powiązanie KV do limitu liczby pieczęci na jedną płatność
 */

const SESSION_RE = /^cs_(live|test)_[A-Za-z0-9]{10,250}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_BODY = 1024;
const SESSION_MAX_AGE_S = 24 * 60 * 60;
const STRIPE_TIMEOUT_MS = 8000;

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'cross-origin-resource-policy': 'same-origin'
    }
  });
}

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

let cachedKey = null;
let cachedKeySource = null;

async function signingKey(env) {
  if (cachedKey && cachedKeySource === env.SEAL_PRIVATE_JWK) return cachedKey;
  const jwk = JSON.parse(env.SEAL_PRIVATE_JWK);
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') {
    throw new Error('SEAL_PRIVATE_JWK nie jest kluczem prywatnym EC P-256');
  }
  cachedKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: false },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  cachedKeySource = env.SEAL_PRIVATE_JWK;
  return cachedKey;
}

async function fetchSession(env, sessionId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STRIPE_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), {
      method: 'GET',
      headers: {
        authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
        'stripe-version': '2024-06-20'
      },
      signal: ctrl.signal
    });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) {
      // 401/403 = zły lub zbyt ograniczony klucz; widoczne w logach Cloudflare (bez treści klucza)
      console.error('Stripe API status', res.status);
      return { error: true, status: res.status };
    }
    return { session: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

// Prosty limit żądań na adres IP w obrębie jednej instancji (dodatkowo zalecana reguła Rate Limiting w Cloudflare).
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const hits = new Map();

function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const h = hits.get(ip);
  if (!h || now > h.reset) {
    hits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  h.count++;
  return h.count > RATE_LIMIT;
}

async function handlePost(context) {
  const { request, env } = context;

  if (rateLimited(request.headers.get('cf-connecting-ip'))) {
    return reply(429, { ok: false, code: 'rate', message: 'Zbyt wiele prób. Spróbuj ponownie za minutę.' });
  }

  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PAYMENT_LINK_ID || !env.SEAL_PRIVATE_JWK) {
    return reply(503, { ok: false, code: 'not_configured', message: 'Płatności nie są jeszcze skonfigurowane.' });
  }

  const ctype = request.headers.get('content-type') || '';
  if (!ctype.toLowerCase().startsWith('application/json')) {
    return reply(415, { ok: false, code: 'bad_request', message: 'Nieprawidłowe żądanie.' });
  }
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > MAX_BODY) return reply(413, { ok: false, code: 'bad_request', message: 'Nieprawidłowe żądanie.' });

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return reply(413, { ok: false, code: 'bad_request', message: 'Nieprawidłowe żądanie.' });
    body = JSON.parse(text);
  } catch (e) {
    return reply(400, { ok: false, code: 'bad_request', message: 'Nieprawidłowe żądanie.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply(400, { ok: false, code: 'bad_request', message: 'Nieprawidłowe żądanie.' });
  }

  const sessionId = typeof body.sid === 'string' ? body.sid : '';
  const docHash = body.hash === undefined || body.hash === null ? null : body.hash;
  if (!SESSION_RE.test(sessionId)) {
    return reply(400, { ok: false, code: 'bad_session', message: 'Nieprawidłowy identyfikator płatności.' });
  }
  if (docHash !== null && (typeof docHash !== 'string' || !HASH_RE.test(docHash))) {
    return reply(400, { ok: false, code: 'bad_request', message: 'Nieprawidłowy skrót dokumentu.' });
  }

  const allowTest = env.ALLOW_TEST_PAYMENTS === 'true';
  if (sessionId.startsWith('cs_test_') && !allowTest) {
    return reply(402, { ok: false, code: 'not_paid', message: 'Płatność testowa nie jest akceptowana.' });
  }

  let result;
  try {
    result = await fetchSession(env, sessionId);
  } catch (e) {
    return reply(502, { ok: false, code: 'upstream', message: 'Nie udało się połączyć z operatorem płatności. Spróbuj ponownie za chwilę.' });
  }
  if (result.notFound) return reply(402, { ok: false, code: 'not_paid', message: 'Nie znaleziono płatności.' });
  if (result.error) {
    return reply(502, { ok: false, code: 'upstream', message: 'Operator płatności chwilowo nie odpowiada. Spróbuj ponownie za chwilę.' });
  }

  const s = result.session || {};
  const minAmount = Number.parseInt(env.MIN_AMOUNT_GROSZE || '999', 10);
  const nowS = Math.floor(Date.now() / 1000);

  if (s.object !== 'checkout.session' || s.id !== sessionId) {
    return reply(402, { ok: false, code: 'not_paid', message: 'Nie znaleziono płatności.' });
  }
  if (s.livemode !== true && !allowTest) {
    return reply(402, { ok: false, code: 'not_paid', message: 'Płatność testowa nie jest akceptowana.' });
  }
  if (s.payment_link !== env.STRIPE_PAYMENT_LINK_ID) {
    return reply(402, { ok: false, code: 'not_paid', message: 'Ta płatność nie dotyczy tej usługi.' });
  }
  if (s.status === 'open' || (s.status === 'complete' && s.payment_status === 'unpaid')) {
    return reply(409, { ok: false, code: 'pending', message: 'Płatność jest jeszcze przetwarzana. Spróbuj ponownie za chwilę.' });
  }
  if (s.status !== 'complete' || s.payment_status !== 'paid') {
    return reply(402, { ok: false, code: 'not_paid', message: 'Płatność nie została zakończona.' });
  }
  if (typeof s.currency !== 'string' || s.currency.toLowerCase() !== 'pln' || !(Number(s.amount_total) >= minAmount)) {
    return reply(402, { ok: false, code: 'not_paid', message: 'Nieprawidłowa kwota płatności.' });
  }
  const created = Number(s.created);
  if (!Number.isFinite(created) || nowS - created > SESSION_MAX_AGE_S) {
    return reply(402, { ok: false, code: 'expired', message: 'Dostęp z tej płatności wygasł (ważny 24 godziny).' });
  }

  const expiresAt = new Date((created + SESSION_MAX_AGE_S) * 1000).toISOString();
  const paymentRef = (await sha256Hex('stripe:' + sessionId)).slice(0, 16);

  if (docHash === null) {
    return reply(200, { ok: true, paid: true, expiresAt, ref: paymentRef });
  }

  // Opcjonalny limit liczby różnych dokumentów opieczętowanych jedną płatnością.
  if (env.SEAL_KV && typeof env.SEAL_KV.get === 'function') {
    const max = Math.max(1, Number.parseInt(env.MAX_SEALS_PER_PAYMENT || '5', 10) || 5);
    const kvKey = 'p:' + paymentRef;
    let used = [];
    try {
      const raw = await env.SEAL_KV.get(kvKey);
      const parsed = raw ? JSON.parse(raw) : [];
      used = Array.isArray(parsed) ? parsed.filter((h) => typeof h === 'string' && HASH_RE.test(h)) : [];
    } catch (e) {
      used = [];
    }
    if (!used.includes(docHash)) {
      if (used.length >= max) {
        return reply(429, { ok: false, code: 'limit', message: `Wykorzystano limit ${max} dokumentów dla jednej płatności.` });
      }
      used.push(docHash);
      try {
        await env.SEAL_KV.put(kvKey, JSON.stringify(used), { expirationTtl: SESSION_MAX_AGE_S * 2 });
      } catch (e) {
        // np. przekroczony dzienny limit zapisów KV – nie blokujemy klienta, który zapłacił
        console.error('SEAL_KV put failed');
      }
    }
  }

  let key;
  try {
    key = await signingKey(env);
  } catch (e) {
    return reply(503, { ok: false, code: 'not_configured', message: 'Pieczęć nie jest poprawnie skonfigurowana.' });
  }

  const nonce = hex(crypto.getRandomValues(new Uint8Array(8)));
  const payload = { v: 1, h: docHash, t: new Date().toISOString(), n: nonce, p: paymentRef, l: s.livemode === true };
  const signedPart = 'v1.' + b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signedPart))
  );

  return reply(200, { ok: true, paid: true, expiresAt, ref: paymentRef, token: signedPart + '.' + b64url(sig), seal: payload });
}

// Jedyny eksport: wszystkie metody trafiają tutaj, przyjmujemy tylko POST.
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return reply(405, { ok: false, code: 'method', message: 'Metoda niedozwolona.' });
  }
  try {
    return await handlePost(context);
  } catch (e) {
    console.error('pieczec: unexpected error');
    return reply(500, { ok: false, code: 'server', message: 'Błąd serwera. Spróbuj ponownie.' });
  }
}
