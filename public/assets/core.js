/*
 * Rdzeń bezpieczeństwa: kanoniczny JSON, SHA-256, weryfikacja pieczęci ECDSA P-256,
 * oraz ścisła walidacja (whitelist) danych protokołu wczytywanych z pliku lub szkicu.
 * Działa w przeglądarce (window.Core) i w Node >= 20 (testy).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 'protokol-zdawczo-odbiorczy/1';

  const LIMITS = Object.freeze({
    meters: 20,
    rooms: 20,
    itemsPerRoom: 30,
    photosPerItem: 3,
    photosTotal: 30,
    photoChars: 2600000,
    signatureChars: 600000
  });

  const TYPES = Object.freeze({
    najem: 'Najem zwykły',
    najem_okazjonalny: 'Najem okazjonalny',
    sprzedaz_wtorny: 'Sprzedaż mieszkania – rynek wtórny',
    sprzedaz_pierwotny: 'Sprzedaż mieszkania – rynek pierwotny'
  });

  const DIRECTIONS = Object.freeze({
    wydanie: 'Wydanie lokalu (początek najmu / przekazanie kupującemu)',
    zwrot: 'Zwrot lokalu (koniec najmu)'
  });

  const METER_KINDS = Object.freeze({
    prad: { label: 'Energia elektryczna', unit: 'kWh' },
    woda_zimna: { label: 'Woda zimna', unit: 'm³' },
    woda_ciepla: { label: 'Woda ciepła', unit: 'm³' },
    gaz: { label: 'Gaz', unit: 'm³' },
    co: { label: 'Centralne ogrzewanie (C.O. / podzielnik)', unit: 'GJ' },
    inny: { label: 'Inny licznik', unit: '' }
  });

  const CO_UNITS = Object.freeze(['GJ', 'jedn.', 'kWh', 'MWh']);
  const TARIFFS = Object.freeze(['G11', 'G12']);

  const CONDITIONS = Object.freeze({
    '': 'nie określono',
    nowy: 'Nowy',
    bardzo_dobry: 'Bardzo dobry',
    dobry: 'Dobry – normalne ślady zużycia',
    uszkodzony: 'Uszkodzony – patrz uwagi'
  });

  const KEY_FIELDS = Object.freeze({
    entrance: 'Klucze do drzwi wejściowych',
    mailbox: 'Klucze do skrzynki pocztowej',
    basement: 'Klucze do piwnicy / komórki lokatorskiej',
    remote: 'Piloty do bramy / garażu',
    intercom: 'Chipy / pastylki do domofonu',
    other: 'Inne (np. klucz do pomieszczenia na rowery)'
  });

  // ---------------------------------------------------------------- kodowanie

  function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function base64UrlEncode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlDecode(str) {
    if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('Nieprawidłowe kodowanie.');
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Deterministyczny JSON: klucze sortowane, brak wartości undefined. Ten sam obiekt => ten sam skrót.
  function canonicalJson(value) {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
    }
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }

  async function sha256Hex(text) {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
      throw new Error('Ta przeglądarka nie obsługuje Web Crypto (wymagane HTTPS).');
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return bytesToHex(new Uint8Array(digest));
  }

  // ---------------------------------------------------------------- pieczęć

  const TOKEN_RE = /^v1\.([A-Za-z0-9_-]{20,800})\.([A-Za-z0-9_-]{86})$/;

  function parseSealToken(token) {
    if (typeof token !== 'string') return null;
    const clean = token.replace(/\s+/g, '');
    const m = TOKEN_RE.exec(clean);
    if (!m) return null;
    let payload;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlDecode(m[1])));
    } catch (e) {
      return null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (payload.v !== 1) return null;
    if (typeof payload.h !== 'string' || !/^[0-9a-f]{64}$/.test(payload.h)) return null;
    if (typeof payload.t !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(payload.t)) return null;
    if (typeof payload.n !== 'string' || !/^[0-9a-f]{16,64}$/.test(payload.n)) return null;
    if (typeof payload.p !== 'string' || !/^[0-9a-f]{8,64}$/.test(payload.p)) return null;
    if (typeof payload.l !== 'boolean') return null;
    return {
      token: clean,
      signedPart: 'v1.' + m[1],
      signature: m[2],
      payload: { v: 1, h: payload.h, t: payload.t, n: payload.n, p: payload.p, l: payload.l }
    };
  }

  function isPublicJwk(jwk) {
    return !!jwk && typeof jwk === 'object' && jwk.kty === 'EC' && jwk.crv === 'P-256' &&
      typeof jwk.x === 'string' && typeof jwk.y === 'string' && !('d' in jwk);
  }

  /** Zwraca { valid, payload } – weryfikacja podpisu ECDSA P-256 / SHA-256 kluczem publicznym. */
  async function verifySealToken(token, publicJwk) {
    const parsed = parseSealToken(token);
    if (!parsed) return { valid: false, reason: 'format' };
    if (!isPublicJwk(publicJwk)) return { valid: false, reason: 'nokey' };
    const key = await globalThis.crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    let sig;
    try {
      sig = base64UrlDecode(parsed.signature);
    } catch (e) {
      return { valid: false, reason: 'format' };
    }
    if (sig.length !== 64) return { valid: false, reason: 'format' };
    const ok = await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sig,
      new TextEncoder().encode(parsed.signedPart)
    );
    return ok ? { valid: true, payload: parsed.payload, token: parsed.token } : { valid: false, reason: 'signature' };
  }

  // ---------------------------------------------------------------- walidacja

  function str(v, max) {
    if (typeof v !== 'string') return '';
    // usuwa znaki sterujące (poza \n i \t), normalizuje Unicode
    // eslint-disable-next-line no-control-regex
    return v.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max);
  }

  function oneLine(v, max) {
    return str(v, max).replace(/[\r\n\t]+/g, ' ');
  }

  function int(v, min, max) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,6}$/.test(v.trim()) ? Number(v) : NaN;
    // Zawsze wynik z przedziału [min, max] – dzięki temu walidacja jest idempotentna (stały skrót SHA-256).
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }

  function date(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
  }

  function isoTime(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) ? v : '';
  }

  const JPEG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
  const PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

  function photo(p) {
    if (!p || typeof p !== 'object') return null;
    if (typeof p.data !== 'string' || p.data.length > LIMITS.photoChars || !JPEG_RE.test(p.data)) return null;
    return { data: p.data, w: int(p.w, 1, 4000), h: int(p.h, 1, 4000), t: isoTime(p.t) };
  }

  function signature(s) {
    if (!s || typeof s !== 'object') return null;
    if (typeof s.data !== 'string' || s.data.length > LIMITS.signatureChars || !PNG_RE.test(s.data)) return null;
    return { data: s.data, t: isoTime(s.t) };
  }

  function party(p) {
    const o = p && typeof p === 'object' ? p : {};
    return {
      name: oneLine(o.name, 120),
      idNumber: oneLine(o.idNumber, 40),
      phone: oneLine(o.phone, 30),
      email: oneLine(o.email, 120)
    };
  }

  function reading(v) {
    const s = oneLine(v, 20).trim();
    return /^[0-9]+([.,][0-9]+)?$/.test(s) ? s : '';
  }

  function meter(m, budget) {
    const o = m && typeof m === 'object' ? m : {};
    const kind = Object.prototype.hasOwnProperty.call(METER_KINDS, o.kind) ? o.kind : 'inny';
    let unit = METER_KINDS[kind].unit;
    if (kind === 'co') unit = CO_UNITS.includes(o.unit) ? o.unit : 'GJ';
    if (kind === 'inny') unit = oneLine(o.unit, 10);
    const ph = budget.left > 0 ? photo(o.photo) : null;
    if (ph) budget.left--;
    return {
      kind,
      label: oneLine(o.label, 60),
      serial: oneLine(o.serial, 60),
      tariff: kind === 'prad' && TARIFFS.includes(o.tariff) ? o.tariff : kind === 'prad' ? 'G11' : '',
      reading: reading(o.reading),
      reading2: kind === 'prad' && o.tariff === 'G12' ? reading(o.reading2) : '',
      unit,
      photo: ph
    };
  }

  function item(it, budget) {
    const o = it && typeof it === 'object' ? it : {};
    const photos = [];
    if (Array.isArray(o.photos)) {
      for (const p of o.photos.slice(0, LIMITS.photosPerItem)) {
        if (budget.left <= 0) break;
        const ph = photo(p);
        if (ph) {
          photos.push(ph);
          budget.left--;
        }
      }
    }
    return {
      name: oneLine(o.name, 80),
      condition: Object.prototype.hasOwnProperty.call(CONDITIONS, o.condition) ? o.condition : '',
      note: str(o.note, 500),
      photos
    };
  }

  function room(r, budget) {
    const o = r && typeof r === 'object' ? r : {};
    return {
      name: oneLine(o.name, 60),
      items: Array.isArray(o.items) ? o.items.slice(0, LIMITS.itemsPerRoom).map((x) => item(x, budget)) : []
    };
  }

  /**
   * Przyjmuje dowolny (niezaufany) obiekt i zwraca nowy obiekt zawierający wyłącznie
   * dozwolone pola o dozwolonych typach i długościach. Nic więcej nie jest kopiowane,
   * więc zanieczyszczenie prototypu (__proto__ itp.) jest niemożliwe.
   */
  function sanitizeProtocol(input) {
    const o = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const budget = { left: LIMITS.photosTotal };
    const keysIn = o.keys && typeof o.keys === 'object' ? o.keys : {};
    const keys = {};
    for (const k of Object.keys(KEY_FIELDS)) keys[k] = int(keysIn[k], 0, 99);
    const type = Object.prototype.hasOwnProperty.call(TYPES, o.type) ? o.type : 'najem';
    const isRental = type === 'najem' || type === 'najem_okazjonalny';
    return {
      type,
      direction: isRental && o.direction === 'zwrot' ? 'zwrot' : 'wydanie',
      date: date(o.date),
      city: oneLine(o.city, 80),
      address: oneLine(o.address, 200),
      contractDate: date(o.contractDate),
      giver: party(o.giver),
      receiver: party(o.receiver),
      meters: Array.isArray(o.meters) ? o.meters.slice(0, LIMITS.meters).map((m) => meter(m, budget)) : [],
      keys,
      keysNote: str(o.keysNote, 300),
      rooms: Array.isArray(o.rooms) ? o.rooms.slice(0, LIMITS.rooms).map((r) => room(r, budget)) : [],
      deposit: oneLine(o.deposit, 30),
      notes: str(o.notes, 4000)
    };
  }

  function sanitizeSignatures(input) {
    const o = input && typeof input === 'object' ? input : {};
    return { giver: signature(o.giver), receiver: signature(o.receiver) };
  }

  /** Role stron zależnie od rodzaju transakcji i kierunku przekazania. */
  function roles(type, direction) {
    if (type === 'sprzedaz_wtorny' || type === 'sprzedaz_pierwotny') {
      return { giver: 'Sprzedający', receiver: 'Kupujący', contract: 'umowy sprzedaży' };
    }
    if (direction === 'zwrot') return { giver: 'Najemca', receiver: 'Wynajmujący', contract: 'umowy najmu' };
    return { giver: 'Wynajmujący', receiver: 'Najemca', contract: 'umowy najmu' };
  }

  /** Obiekt, z którego liczony jest skrót SHA-256 dokumentu (dane + zdjęcia + podpisy). */
  function hashableDocument(protocol, signatures) {
    return { schema: SCHEMA, protocol: sanitizeProtocol(protocol), signatures: sanitizeSignatures(signatures) };
  }

  async function documentHash(protocol, signatures) {
    return sha256Hex(canonicalJson(hashableDocument(protocol, signatures)));
  }

  function countPhotos(protocol) {
    let n = 0;
    for (const m of protocol.meters || []) if (m.photo) n++;
    for (const r of protocol.rooms || []) for (const it of r.items || []) n += (it.photos || []).length;
    return n;
  }

  return Object.freeze({
    SCHEMA,
    LIMITS,
    TYPES,
    DIRECTIONS,
    METER_KINDS,
    CO_UNITS,
    CONDITIONS,
    KEY_FIELDS,
    bytesToHex,
    base64UrlEncode,
    base64UrlDecode,
    canonicalJson,
    sha256Hex,
    parseSealToken,
    verifySealToken,
    isPublicJwk,
    sanitizeProtocol,
    sanitizeSignatures,
    roles,
    hashableDocument,
    documentHash,
    countPhotos
  });
});
