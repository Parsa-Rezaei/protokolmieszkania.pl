import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUmd } from './helpers.mjs';

const Core = loadUmd('public/assets/core.js');
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('canonicalJson: kolejność kluczy nie wpływa na wynik', () => {
  assert.equal(Core.canonicalJson({ b: 1, a: [1, { d: 2, c: 'x' }] }), Core.canonicalJson({ a: [1, { c: 'x', d: 2 }], b: 1 }));
  assert.equal(Core.canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test('sanitizeProtocol: whitelist pól, brak zanieczyszczenia prototypu', () => {
  const evil = JSON.parse('{"__proto__":{"polluted":1},"type":"<script>","constructor":{"prototype":{"x":1}},"giver":{"name":"Jan\\u0000 Kowalski\\u202e","extra":"x"},"meters":[{"kind":"__proto__","reading":"12 kWh","photo":{"data":"javascript:alert(1)"}}],"rooms":[{"name":"Salon","items":[{"name":"Okna","condition":"zly","photos":[{"data":"data:image/svg+xml;base64,PHN2Zz4="}]}]}]}');
  const s = Core.sanitizeProtocol(evil);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(s.type, 'najem');
  assert.equal(s.giver.name, 'Jan Kowalski');
  assert.equal(s.giver.extra, undefined);
  assert.equal(s.meters[0].kind, 'inny');
  assert.equal(s.meters[0].reading, '');
  assert.equal(s.meters[0].photo, null);
  assert.equal(s.rooms[0].items[0].condition, '');
  assert.deepEqual(s.rooms[0].items[0].photos, []);
  assert.equal(Object.keys(s).includes('constructor'), false);
});

test('sanitizeProtocol: idempotentny (ten sam skrót po ponownej walidacji)', async () => {
  const input = {
    type: 'sprzedaz_wtorny',
    direction: 'zwrot',
    date: '2026-10-24',
    city: 'Łódź',
    address: 'ul. Piotrkowska 1\nm. 2',
    giver: { name: 'Zażółć Gęślą', idNumber: '90010112345' },
    receiver: { name: 'Jaźń' },
    meters: [{ kind: 'prad', tariff: 'G12', reading: '123,4', reading2: '55', photo: { data: JPEG, w: 1, h: 1, t: '2026-10-24T10:00:00.000Z' } }, { kind: 'co', unit: 'jedn.', reading: '7' }],
    keys: { entrance: '2', mailbox: 150, basement: -1 },
    rooms: [{ name: 'Kuchnia', items: [{ name: 'AGD', condition: 'uszkodzony', note: 'rysa', photos: [{ data: JPEG }] }] }],
    deposit: '3 000',
    notes: 'Uwagi'
  };
  const once = Core.sanitizeProtocol(input);
  const twice = Core.sanitizeProtocol(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  assert.equal(once.direction, 'wydanie', 'sprzedaż zawsze jako wydanie');
  assert.equal(once.address, 'ul. Piotrkowska 1 m. 2');
  assert.equal(once.keys.entrance, 2);
  assert.equal(once.keys.mailbox, 99);
  assert.equal(once.keys.basement, 0);
  assert.equal(once.meters[0].reading2, '55');
  assert.equal(once.meters[1].unit, 'jedn.');
  const h1 = await Core.documentHash(input, { giver: { data: PNG, t: '' }, receiver: null });
  const h2 = await Core.documentHash(twice, { giver: { data: PNG, t: '' }, receiver: null });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('documentHash: każda zmiana treści zmienia skrót', async () => {
  const base = { address: 'A', giver: { name: 'X' }, receiver: { name: 'Y' }, meters: [{ kind: 'gaz', reading: '1' }] };
  const h0 = await Core.documentHash(base, {});
  const h1 = await Core.documentHash({ ...base, meters: [{ kind: 'gaz', reading: '2' }] }, {});
  const h2 = await Core.documentHash(base, { receiver: { data: PNG } });
  assert.notEqual(h0, h1);
  assert.notEqual(h0, h2);
});

test('limit zdjęć w protokole', () => {
  const photos = Array.from({ length: 3 }, () => ({ data: JPEG }));
  const rooms = Array.from({ length: 15 }, () => ({ name: 'P', items: [{ name: 'E', photos }] }));
  const s = Core.sanitizeProtocol({ rooms });
  assert.equal(Core.countPhotos(s), Core.LIMITS.photosTotal);
});

test('roles: wydanie / zwrot / sprzedaż', () => {
  assert.equal(Core.roles('najem', 'wydanie').giver, 'Wynajmujący');
  assert.equal(Core.roles('najem', 'zwrot').giver, 'Najemca');
  assert.equal(Core.roles('najem_okazjonalny', 'zwrot').receiver, 'Wynajmujący');
  assert.equal(Core.roles('sprzedaz_pierwotny', 'zwrot').giver, 'Sprzedający');
});

test('parseSealToken odrzuca śmieci', () => {
  assert.equal(Core.parseSealToken('abc'), null);
  assert.equal(Core.parseSealToken('v1.' + 'A'.repeat(30) + '.' + 'B'.repeat(86)), null);
  assert.equal(Core.isPublicJwk({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'secret' }), false);
});

test('skróty SRI w app.js zgadzają się z plikami pdfmake w public/assets/vendor', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { join } = await import('node:path');
  const { root } = await import('./helpers.mjs');
  const app = readFileSync(join(root, 'public/assets/app.js'), 'utf8');
  const dir = /dir: '\/assets\/vendor\/(pdfmake-[0-9.]+)\/'/.exec(app)[1];
  assert.deepEqual(readdirSync(join(root, 'public/assets/vendor')), [dir], 'tylko jedna wersja pdfmake w vendor');
  const sri = (f) => 'sha384-' + createHash('sha384').update(readFileSync(join(root, 'public/assets/vendor', dir, f))).digest('base64');
  assert.ok(app.includes("pdfmake: '" + sri('pdfmake.min.js') + "'"));
  assert.ok(app.includes("fonts: '" + sri('vfs_fonts.js') + "'"));
});

test('brak sekretów w publicznych plikach', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { root } = await import('./helpers.mjs');
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(join(root, 'public'))) {
    if (f.includes('vendor') || f.endsWith('.png')) continue;
    const t = readFileSync(f, 'utf8');
    assert.ok(!/\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/.test(t), 'klucz Stripe w ' + f);
    assert.ok(!/"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/.test(t), 'klucz prywatny JWK w ' + f);
  }
});
