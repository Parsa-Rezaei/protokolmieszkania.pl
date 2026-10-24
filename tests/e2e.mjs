// Test end-to-end w prawdziwej przeglądarce (Chromium + Playwright):
//  - tryb "free": formularz, zdjęcia, podpisy (mysz + dotyk), PDF, plik danych, weryfikacja, kalkulatory,
//  - tryb "stripe": okno płatności, powrót z Stripe (atrapa API), pieczęć serwera, weryfikacja pieczęci,
//  - brak błędów konsoli i naruszeń Content-Security-Policy.
// Uruchom: npm run test:e2e   (wymaga: npm i -D playwright && npx playwright install chromium, oraz pdftotext)
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../scripts/serve.mjs';
import { root } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = await mkdtemp(join(tmpdir(), 'pz-e2e-'));
const pdfText = (file) => execFileSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
const norm = (s) => s.replace(/[\s  ]+/g, ' ');
const log = (...a) => console.log('  ✓', ...a);

// ---------------------------------------------------------------- atrapa Stripe po stronie serwera
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.stripe.com/v1/checkout/sessions/')) {
    const id = decodeURIComponent(u.split('/').pop());
    const paid = id !== 'cs_live_unpaidSESSION0000';
    return new Response(JSON.stringify({
      object: 'checkout.session', id, livemode: true, payment_link: 'plink_E2E', status: 'complete',
      payment_status: paid ? 'paid' : 'unpaid', currency: 'pln', amount_total: 999, created: Math.floor(Date.now() / 1000) - 30
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

const baseConfig = await readFile(join(root, 'public/assets/config.js'), 'utf8');
const stripeConfig = baseConfig
  .replace("mode: 'free'", "mode: 'stripe'")
  .replace("stripePaymentLink: ''", "stripePaymentLink: 'https://buy.stripe.com/test_e2e'")
  .replace('publicKeyJwk: null', 'publicKeyJwk: ' + JSON.stringify({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y }));
assert.notEqual(stripeConfig, baseConfig);

const serverEnv = {
  STRIPE_SECRET_KEY: 'rk_live_e2e',
  STRIPE_PAYMENT_LINK_ID: 'plink_E2E',
  SEAL_PRIVATE_JWK: JSON.stringify({ kty: 'EC', crv: 'P-256', x: priv.x, y: priv.y, d: priv.d })
};
const freeServer = await startServer({ port: 0, env: serverEnv });
const stripeServer = await startServer({ port: 0, env: serverEnv, configJs: stripeConfig });
const FREE = 'http://localhost:' + freeServer.address().port;
const STRIPE = 'http://localhost:' + stripeServer.address().port;

const browser = await chromium.launch();

async function newPage() {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw'
  });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  return { ctx, page, problems };
}

async function makeJpeg(page, name, label) {
  const b64 = await page.evaluate((text) => {
    const c = document.createElement('canvas');
    c.width = 3000;
    c.height = 2000;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 3000, 2000);
    g.addColorStop(0, '#1f57c3');
    g.addColorStop(1, '#f59e0b');
    x.fillStyle = g;
    x.fillRect(0, 0, 3000, 2000);
    x.fillStyle = '#fff';
    x.font = 'bold 220px sans-serif';
    x.fillText(text, 200, 1100);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, label);
  const file = join(tmp, name);
  await writeFile(file, Buffer.from(b64, 'base64'));
  return file;
}

async function drawMouse(page, sel) {
  await page.locator(sel).scrollIntoViewIfNeeded();
  const b = await page.locator(sel).boundingBox();
  await page.mouse.move(b.x + 20, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 35; i++) await page.mouse.move(b.x + 20 + i * 8, b.y + b.height / 2 + Math.sin(i / 3) * 35);
  await page.mouse.up();
}

async function drawTouch(page, ctx, sel) {
  await page.locator(sel).scrollIntoViewIfNeeded();
  const b = await page.locator(sel).boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const y0 = b.y + b.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 20, y: y0 }] });
  for (let i = 1; i < 35; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: b.x + 20 + i * 8, y: y0 + Math.cos(i / 3) * 30 + i * 2 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function fillProtocol(page) {
  await page.fill('#f-address', 'ul. Piotrkowska 100 m. 12, 90-001 Łódź');
  await page.fill('#f-contract-date', '2026-10-01');
  await page.fill('#g-name', 'Zażółć Gęślą');
  await page.fill('#g-id', 'ABC123456');
  await page.fill('#r-name', 'Jaźń Źdźbło');
  await page.fill('#r-email', 'najemca@example.com');
  await page.fill('#k-entrance', '2');
  await page.fill('#k-intercom', '1');
  const first = page.locator('#meters-list > div').first();
  await first.getByLabel('Numer licznika').fill('ZE-998877');
  await first.getByLabel('Taryfa').selectOption('G12');
  await page.locator('#meters-list > div').first().getByLabel('Odczyt strefa I – dzienna (kWh)').fill('12345,6');
  await page.locator('#meters-list > div').first().getByLabel('Odczyt strefa II – nocna (kWh)').fill('5432.1');
  await page.locator('#meters-list > div').nth(1).getByLabel('Odczyt (m³)').fill('321,456');
  await page.fill('#f-deposit', '3 000');
  await page.fill('#f-notes', 'Zażółć gęślą jaźń – ąćęłńóśźż ĄĆĘŁŃÓŚŹŻ. Rysa na blacie istniała przed przekazaniem.');
}

// ================================================================= TRYB FREE
{
  const { ctx, page, problems } = await newPage();
  await page.goto(FREE + '/');
  assert.match(await page.title(), /Protokół zdawczo-odbiorczy mieszkania/);
  const h = await (await page.request.get(FREE + '/')).headers();
  assert.match(h['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(h['x-frame-options'], 'DENY');
  log('strona i nagłówki bezpieczeństwa');

  await fillProtocol(page);

  const meterJpg = await makeJpeg(page, 'meter.jpg', 'LICZNIK 12345');
  await page.locator('#meters-list > div').first().locator('input[type=file][capture]').setInputFiles(meterJpg);
  await page.locator('#meters-list > div').first().locator('.thumb img').waitFor();
  const dims = await page.locator('#meters-list > div').first().locator('.thumb img').evaluate((img) => [img.naturalWidth, img.naturalHeight, img.src.slice(0, 23)]);
  assert.deepEqual(dims, [800, 533, 'data:image/jpeg;base64,']);
  log('kompresja zdjęcia 3000x2000 -> 800x533 JPEG');

  const item = page.locator('#rooms-list > div').nth(1).locator('.space-y-2.rounded-lg').first();
  await item.getByLabel('Stan').selectOption('uszkodzony');
  await item.getByLabel('Uwagi / opis usterki').fill('Zarysowanie ściany przy oknie');
  const defectJpg = await makeJpeg(page, 'defect.jpg', 'RYSA');
  await item.locator('input[type=file]:not([capture])').setInputFiles(defectJpg);
  await item.locator('.thumb img').waitFor();

  // Niebezpieczny tekst musi pozostać tekstem
  await page.fill('#add-room-name', '<img src=x onerror=alert(1)>');
  await page.click('#add-room-btn');
  assert.equal(await page.locator('#rooms-list img[src="x"]').count(), 0);
  assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll('#rooms-list input')).filter((i) => i.value === '<img src=x onerror=alert(1)>').length), 1);
  log('brak XSS przy tekście z HTML');

  const scrollBefore = await page.evaluate(() => { document.querySelector('#signatures-card').scrollIntoView(); return window.scrollY; });
  await drawMouse(page, '#sig-giver');
  await drawTouch(page, ctx, '#sig-receiver');
  const scrollAfter = await page.evaluate(() => window.scrollY);
  assert.ok(Math.abs(scrollAfter - scrollBefore) < 400, 'podpis palcem nie przewija strony znacząco');
  await page.locator('#sig-giver-status', { hasText: 'Podpisano' }).waitFor();
  await page.locator('#sig-receiver-status', { hasText: 'Podpisano' }).waitFor();
  log('podpisy: mysz + dotyk');

  // Zmiana danych po podpisaniu usuwa podpisy
  await page.fill('#f-deposit', '3 500');
  await page.locator('#sig-giver-status', { hasText: 'Brak podpisu' }).waitFor();
  assert.match(await page.locator('#sig-receiver-status').textContent(), /Brak podpisu/);
  log('zmiana danych po podpisie usuwa oba podpisy');
  await drawMouse(page, '#sig-giver');
  await drawTouch(page, ctx, '#sig-receiver');
  await page.locator('#sig-receiver-status', { hasText: 'Podpisano' }).waitFor();

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-pdf-full')]);
  const fullPdf = join(tmp, 'full.pdf');
  await dl.saveAs(fullPdf);
  const text = norm(pdfText(fullPdf));
  for (const s of ['PROTOKÓŁ ZDAWCZO-ODBIORCZY', 'Zażółć Gęślą', 'Jaźń Źdźbło', 'ąćęłńóśźż ĄĆĘŁŃÓŚŹŻ', 'ZE-998877', 'I: 12345,6', 'II: 5432.1 kWh', '321,456 m³',
    'Klucze do drzwi wejściowych 2 szt.', 'Uszkodzony – patrz uwagi', 'Fot. 1', 'Fot. 2', 'dokumentacja fotograficzna', 'Integralność dokumentu', 'Kaucja: 3 500 zł', 'Przekazujący – Wynajmujący']) {
    assert.ok(text.includes(s), 'PDF zawiera: ' + s);
  }
  const hash = (await page.textContent('#pdf-hash')).trim();
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(text.includes(hash), 'PDF zawiera pełny skrót SHA-256');
  const size = (await readFile(fullPdf)).length;
  assert.ok(size < 3 * 1024 * 1024, 'PDF < 3 MB: ' + size);
  const images = execFileSync('pdfimages', ['-list', fullPdf], { encoding: 'utf8' }).trim().split('\n').length - 2;
  assert.ok(images >= 4, 'PDF zawiera zdjęcia i podpisy (obrazów: ' + images + ')');
  log('pełny PDF: polskie znaki, liczniki G12, zdjęcia, podpisy, SHA-256, ' + Math.round(size / 1024) + ' KB');

  const [dlBasic] = await Promise.all([page.waitForEvent('download'), page.click('#btn-pdf-basic')]);
  const basicPdf = join(tmp, 'basic.pdf');
  await dlBasic.saveAs(basicPdf);
  const basicText = norm(pdfText(basicPdf));
  assert.ok(basicText.includes('(czytelny podpis)'));
  assert.ok(!basicText.includes('PODGLĄD'), 'w trybie free bez znaku wodnego');
  log('wersja do druku bez zdjęć');

  await page.click('summary:has-text("Plik danych")');
  const [dlJson] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-json')]);
  const jsonPath = join(tmp, 'dane.json');
  await dlJson.saveAs(jsonPath);
  const exported = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(exported.hash, hash, 'skrót w pliku danych = skrót w PDF');

  // Zmieniony plik danych daje inny skrót
  const tampered = structuredClone(exported);
  tampered.protocol.meters[0].reading = '1';
  const tamperedPath = join(tmp, 'dane-zmienione.json');
  await writeFile(tamperedPath, JSON.stringify(tampered));

  await page.goto(FREE + '/#weryfikacja');
  await page.setInputFiles('#v-file', jsonPath);
  await page.click('#verify-form button[type=submit]');
  await page.locator('#v-result', { hasText: hash }).waitFor();
  await page.setInputFiles('#v-file', tamperedPath);
  await page.click('#verify-form button[type=submit]');
  await page.locator('#v-result', { hasText: 'Obliczony skrót' }).waitFor();
  assert.ok(!(await page.textContent('#v-result')).includes(hash));
  log('weryfikacja pliku danych (oryginał / zmieniony)');

  // Szkic przetrwał przeładowanie (IndexedDB)
  await page.goto(FREE + '/#protokol');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#f-address').value.includes('Piotrkowska'));
  log('szkic przywrócony po przeładowaniu');

  // Import pliku danych NIE przywraca podpisów
  page.on('dialog', (d) => d.accept());
  await page.click('summary:has-text("Plik danych")');
  await page.setInputFiles('#import-json', jsonPath);
  await page.locator('#sig-giver-status', { hasText: 'Brak podpisu' }).waitFor();
  assert.equal(await page.inputValue('#r-name'), 'Jaźń Źdźbło');
  log('import danych bez podpisów');

  await page.goto(FREE + '/#notariusz');
  await page.locator('#n-results').waitFor();
  const n = norm(await page.textContent('#n-results'));
  assert.ok(n.includes('2770,00 zł') && n.includes('637,10 zł') && n.includes('10 000,00 zł') && n.includes('14 348,30 zł'), n);
  await page.fill('#n-value', '2 500 000');
  await page.check('#n-group1');
  assert.ok(norm(await page.textContent('#n-results')).includes('7500,00 zł'));
  await page.uncheck('#n-group1');
  await page.check('#n-first-home');
  assert.ok(norm(await page.textContent('#n-results')).includes('zwolnienie'));
  log('kalkulator notarialny');

  await page.goto(FREE + '/#najem');
  const r = norm(await page.textContent('#r-results'));
  assert.ok(r.includes('33 000,00 zł') && r.includes('2805,00 zł'), r);
  log('kalkulator najmu');

  await page.screenshot({ path: join(tmp, 'mobile-najem.png'), fullPage: false });
  const csp = await page.evaluate(() => window.__csp);
  assert.deepEqual(csp, [], 'brak naruszeń CSP');
  assert.deepEqual(problems, [], 'brak błędów konsoli');
  log('brak błędów konsoli i naruszeń CSP (tryb free)');
  await ctx.close();
}

// ================================================================= TRYB STRIPE
{
  const { ctx, page, problems } = await newPage();
  await page.route('https://buy.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Stripe</body></html>' }));
  await page.goto(STRIPE + '/');
  await fillProtocol(page);
  const meterJpg = await makeJpeg(page, 'meter2.jpg', 'GAZ 777');
  await page.locator('#meters-list > div').nth(3).locator('input[type=file][capture]').setInputFiles(meterJpg);
  await page.locator('#meters-list > div').nth(3).locator('.thumb img').waitFor();
  await drawMouse(page, '#sig-giver');
  await drawTouch(page, ctx, '#sig-receiver');
  await page.locator('#sig-receiver-status', { hasText: 'Podpisano' }).waitFor();

  // Bezpłatny podgląd ma znak wodny
  const [dlPrev] = await Promise.all([page.waitForEvent('download'), page.click('#btn-pdf-basic')]);
  const prevPdf = join(tmp, 'preview.pdf');
  await dlPrev.saveAs(prevPdf);
  // Znak wodny "PODGLĄD" jest obrócony, więc pdftotext dzieli go na fragmenty – sprawdzamy dopisek wersji podglądowej.
  const prevText = norm(pdfText(prevPdf));
  assert.ok(prevText.includes('Pełna wersja ze zdjęciami, podpisami z ekranu i pieczęcią czasu'), 'dopisek podglądu');
  assert.ok(!prevText.includes('Integralność dokumentu'), 'podgląd bez sekcji integralności');
  log('podgląd ze znakiem wodnym');

  // Bez płatności – okno płatności, bez PDF
  await page.click('#btn-pdf-full');
  await page.locator('#pay-dialog[open]').waitFor();
  await page.click('#pay-go');
  await page.locator('#pay-error', { hasText: 'Zaznacz oba pola' }).waitFor();
  await page.check('#pay-terms');
  await page.check('#pay-withdrawal');
  await Promise.all([page.waitForURL('https://buy.stripe.com/test_e2e'), page.click('#pay-go')]);
  log('przekierowanie do Stripe po zgodach');

  // Sfałszowany "powrót" z nieopłaconą sesją
  await page.goto(STRIPE + '/?platnosc=cs_live_unpaidSESSION0000');
  await page.locator('#payment-status', { hasText: 'Płatność jest jeszcze przetwarzana' }).waitFor({ timeout: 60000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('pz-unlock')), null, 'nieopłacona sesja nie odblokowuje');
  log('nieopłacona sesja odrzucona');

  // Powrót z opłaconą sesją
  await page.goto(STRIPE + '/?platnosc=cs_live_e2ePAIDsession123');
  await page.locator('#payment-status', { hasText: 'Płatność potwierdzona' }).waitFor();
  assert.ok(!page.url().includes('platnosc'), 'identyfikator płatności usunięty z adresu');
  await page.locator('#sig-giver-status', { hasText: 'Podpisano' }).waitFor();
  assert.equal(await page.inputValue('#g-name'), 'Zażółć Gęślą');
  log('powrót z płatności: szkic i podpisy przywrócone');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-pdf-full')]);
  const sealedPdf = join(tmp, 'sealed.pdf');
  await dl.saveAs(sealedPdf);
  const st = norm(pdfText(sealedPdf));
  assert.ok(st.includes('Pieczęć czasu serwera') && st.includes('Kod weryfikacyjny'), 'PDF z pieczęcią');
  log('pełny PDF z pieczęcią czasu serwera i QR');

  await page.click('summary:has-text("Plik danych")');
  const [dlJson] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-json')]);
  const jsonPath = join(tmp, 'sealed.json');
  await dlJson.saveAs(jsonPath);
  const exported = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.match(exported.seal, /^v1\./);

  // Link z kodu QR otwiera weryfikację automatycznie
  await page.goto(STRIPE + '/#weryfikuj=' + encodeURIComponent(exported.seal));
  await page.locator('#v-result', { hasText: 'Pieczęć jest prawidłowa' }).waitFor();
  await page.setInputFiles('#v-file', jsonPath);
  await page.click('#verify-form button[type=submit]');
  await page.locator('#v-result', { hasText: 'zgodny z pieczęcią' }).waitFor();
  // Podrobiony kod
  const parts = exported.seal.split('.');
  const forgedPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  forgedPayload.t = '2020-01-01T00:00:00.000Z';
  await page.fill('#v-token', [parts[0], Buffer.from(JSON.stringify(forgedPayload)).toString('base64url'), parts[2]].join('.'));
  await page.setInputFiles('#v-file', []);
  await page.click('#verify-form button[type=submit]');
  await page.locator('#v-result', { hasText: 'NIEPRAWIDŁOWA' }).waitFor();
  log('weryfikacja pieczęci: prawidłowa, zgodna z plikiem, podróbka wykryta');

  await page.goto(STRIPE + '/#protokol');
  await page.screenshot({ path: join(tmp, 'mobile-top.png') });
  const csp = await page.evaluate(() => window.__csp);
  assert.deepEqual(csp, [], 'brak naruszeń CSP');
  // 409 = celowo testowana nieopłacona sesja (przeglądarka loguje odpowiedź HTTP 409 jako błąd zasobu)
  assert.deepEqual(problems.filter((p) => !p.includes('status of 409')), [], 'brak błędów konsoli');
  log('brak błędów konsoli i naruszeń CSP (tryb stripe)');
  await ctx.close();
}

await browser.close();
freeServer.close();
stripeServer.close();
console.log('\nE2E OK. Pliki testowe: ' + tmp);
