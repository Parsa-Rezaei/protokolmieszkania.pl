import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/pieczec.js';
import { loadUmd } from './helpers.mjs';

const Core = loadUmd('public/assets/core.js');

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
const PUBLIC = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y };

const SID = 'cs_live_a1B2c3D4e5F6g7H8i9J0';
const HASH = 'a'.repeat(64);
const nowS = () => Math.floor(Date.now() / 1000);

function goodSession(over) {
  return Object.assign({
    object: 'checkout.session',
    id: SID,
    livemode: true,
    payment_link: 'plink_TEST123',
    status: 'complete',
    payment_status: 'paid',
    currency: 'pln',
    amount_total: 999,
    created: nowS() - 60
  }, over || {});
}

function env(over) {
  return Object.assign({
    STRIPE_SECRET_KEY: 'rk_live_dummy',
    STRIPE_PAYMENT_LINK_ID: 'plink_TEST123',
    SEAL_PRIVATE_JWK: JSON.stringify({ kty: 'EC', crv: 'P-256', x: priv.x, y: priv.y, d: priv.d }),
    MIN_AMOUNT_GROSZE: '999'
  }, over || {});
}

function mockStripe(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body || {}), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

function req(body, opts) {
  const o = opts || {};
  return new Request('https://protokolzdawczy.pl/api/pieczec', {
    method: o.method || 'POST',
    headers: { 'content-type': o.ctype || 'application/json' },
    body: o.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
}

async function call(body, e, opts) {
  const res = await onRequest({ request: req(body, opts), env: e || env() });
  return { status: res.status, data: await res.json(), headers: res.headers };
}

test('brak konfiguracji -> 503', async () => {
  const r = await call({ sid: SID }, {});
  assert.equal(r.status, 503);
});

test('tylko POST z JSON, limit rozmiaru', async () => {
  assert.equal((await call(null, env(), { method: 'GET' })).status, 405);
  assert.equal((await call('x', env(), { ctype: 'text/plain' })).status, 415);
  assert.equal((await call('{bad json', env())).status, 400);
  assert.equal((await call({ sid: SID, pad: 'x'.repeat(2000) })).status, 413);
});

test('walidacja identyfikatora sesji i skrótu – Stripe nie jest wywoływany', async () => {
  const calls = mockStripe(() => ({ body: goodSession() }));
  assert.equal((await call({ sid: 'cs_live_../../v1/charges' })).status, 400);
  assert.equal((await call({ sid: SID, hash: 'xyz' })).status, 400);
  assert.equal((await call({ sid: 'cs_test_a1B2c3D4e5F6g7H8i9J0' })).status, 402, 'sesja testowa odrzucona w produkcji');
  assert.equal(calls.length, 0);
});

test('odrzuca nieopłacone, cudze, testowe, stare i za tanie płatności', async () => {
  const cases = [
    [{ livemode: false }, 402],
    [{ payment_link: 'plink_OTHER' }, 402],
    [{ payment_status: 'unpaid' }, 409],
    [{ status: 'open', payment_status: 'unpaid' }, 409],
    [{ status: 'expired', payment_status: 'unpaid' }, 402],
    [{ payment_status: 'no_payment_required', amount_total: 0 }, 402],
    [{ currency: 'eur' }, 402],
    [{ amount_total: 1 }, 402],
    [{ created: nowS() - 25 * 3600 }, 402],
    [{ id: 'cs_live_other00000000000' }, 402],
    [{ object: 'payment_intent' }, 402]
  ];
  for (const [over, status] of cases) {
    mockStripe(() => ({ body: goodSession(over) }));
    const r = await call({ sid: SID, hash: HASH });
    assert.equal(r.status, status, JSON.stringify(over));
    assert.equal(r.data.token, undefined);
  }
});

test('błędy Stripe nie ujawniają szczegółów', async () => {
  mockStripe(() => ({ status: 401, body: { error: { message: 'Invalid API Key provided: rk_live_dummy' } } }));
  const r = await call({ sid: SID });
  assert.equal(r.status, 502);
  assert.equal(JSON.stringify(r.data).includes('rk_live'), false);
  mockStripe(() => ({ status: 404, body: {} }));
  assert.equal((await call({ sid: SID })).status, 402);
});

test('opłacona sesja: weryfikacja bez skrótu i z pieczęcią', async () => {
  const calls = mockStripe(() => ({ body: goodSession() }));
  const a = await call({ sid: SID });
  assert.equal(a.status, 200);
  assert.equal(a.data.paid, true);
  assert.equal(a.data.token, undefined);
  assert.equal(a.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions/' + SID);
  assert.equal(calls[0].init.headers.authorization, 'Bearer rk_live_dummy');

  const b = await call({ sid: SID, hash: HASH });
  assert.equal(b.status, 200);
  const v = await Core.verifySealToken(b.data.token, PUBLIC);
  assert.equal(v.valid, true);
  assert.equal(v.payload.h, HASH);
  assert.equal(v.payload.l, true);
  assert.ok(Math.abs(Date.parse(v.payload.t) - Date.now()) < 5000);

  // podmiana skrótu w pieczęci unieważnia podpis
  const [ver, payload, sig] = b.data.token.split('.');
  const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  forged.h = 'b'.repeat(64);
  const forgedToken = [ver, Buffer.from(JSON.stringify(forged)).toString('base64url'), sig].join('.');
  assert.equal((await Core.verifySealToken(forgedToken, PUBLIC)).valid, false);

  // inny klucz publiczny – pieczęć nieważna
  const other = await crypto.subtle.exportKey('jwk', (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).publicKey);
  assert.equal((await Core.verifySealToken(b.data.token, { kty: 'EC', crv: 'P-256', x: other.x, y: other.y })).valid, false);
});

test('tryb testowy tylko z ALLOW_TEST_PAYMENTS=true', async () => {
  const sid = 'cs_test_a1B2c3D4e5F6g7H8i9J0';
  mockStripe(() => ({ body: goodSession({ id: sid, livemode: false }) }));
  const r = await call({ sid, hash: HASH }, env({ ALLOW_TEST_PAYMENTS: 'true' }));
  assert.equal(r.status, 200);
  assert.equal((await Core.verifySealToken(r.data.token, PUBLIC)).payload.l, false);
});

test('limit pieczęci na jedną płatność (KV)', async () => {
  mockStripe(() => ({ body: goodSession() }));
  const store = new Map();
  const kv = { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) };
  const e = env({ SEAL_KV: kv, MAX_SEALS_PER_PAYMENT: '2' });
  assert.equal((await call({ sid: SID, hash: '1'.repeat(64) }, e)).status, 200);
  assert.equal((await call({ sid: SID, hash: '2'.repeat(64) }, e)).status, 200);
  assert.equal((await call({ sid: SID, hash: '1'.repeat(64) }, e)).status, 200, 'ten sam dokument ponownie – bez limitu');
  assert.equal((await call({ sid: SID, hash: '3'.repeat(64) }, e)).status, 429);
});

test('zły klucz prywatny -> 503 bez wycieku', async () => {
  mockStripe(() => ({ body: goodSession() }));
  const r = await call({ sid: SID, hash: HASH }, env({ SEAL_PRIVATE_JWK: '{"kty":"EC","crv":"P-256"}' }));
  assert.equal(r.status, 503);
});

test('limit żądań na adres IP', async () => {
  const calls = mockStripe(() => ({ body: goodSession() }));
  const make = () => new Request('https://protokolzdawczy.pl/api/pieczec', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
    body: JSON.stringify({ sid: 'cs_live_bad' })
  });
  const statuses = [];
  for (let i = 0; i < 32; i++) statuses.push((await onRequest({ request: make(), env: env() })).status);
  assert.equal(statuses[0], 400);
  assert.equal(statuses[31], 429);
  assert.equal(calls.length, 0);
});
