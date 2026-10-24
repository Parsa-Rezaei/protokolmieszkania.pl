/*
 * Kreator protokołu zdawczo-odbiorczego + kalkulatory.
 * Zasady bezpieczeństwa w tym pliku:
 *  - brak innerHTML / insertAdjacentHTML / eval – tekst użytkownika trafia do DOM wyłącznie przez textContent,
 *  - dane protokołu, zdjęcia i podpisy nigdy nie są wysyłane na serwer (do /api/pieczec trafia tylko skrót SHA-256),
 *  - dane z plików i pamięci przeglądarki przechodzą przez Core.sanitizeProtocol (whitelist pól),
 *  - każda zmiana danych po podpisaniu usuwa podpisy.
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const Core = window.Core;
  const Calc = window.Calc;
  if (!CFG || !Core || !Calc) return;

  // ------------------------------------------------------------------ stałe

  const VENDOR = Object.freeze({
    dir: '/assets/vendor/pdfmake-0.3.11/',
    pdfmake: 'sha384-vsaIaEjAOZA6uoCQ2pryCKIc8YGpQ/0HK5krdezL4PYvnmLzrizBMDJCZulvIomS',
    fonts: 'sha384-pkBUW1wxcm6m7ZjKDxADnNHqnz+Sx9sAL1ndsLNv/GZnWZgodPYsju1yxeyQnn0c'
  });
  const SESSION_RE = /^cs_(live|test)_[A-Za-z0-9]{10,250}$/;
  const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
  const PHONE_RE = /^[+0-9 ()-]{7,20}$/;
  const PAYMENT_HOSTS = Object.freeze(['buy.stripe.com']);
  const DRAFT_KEY = 'draft';
  const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;
  const UNLOCK_KEY = 'pz-unlock';
  const PENDING_KEY = 'pz-pending';
  const AUTOSAVE_KEY = 'pz-autosave';
  const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
  const MAX_JSON_BYTES = 60 * 1024 * 1024;
  const MAX_SOURCE_PIXELS = 60e6;
  const IMG_MAX_W = 800;
  const IMG_MAX_H = 1400;
  const IMG_QUALITY = 0.75;
  const PDF_SIZE_WARN_BYTES = 3 * 1024 * 1024;
  const TZ = 'Europe/Warsaw';

  const SITE_NAME = typeof CFG.siteName === 'string' ? CFG.siteName.slice(0, 60) : 'ProtokolZdawczy.pl';
  const SITE_URL = safeHttpsUrl(CFG.siteUrl) ? CFG.siteUrl.replace(/\/+$/, '') : location.origin;
  const SUPPORT_EMAIL = typeof CFG.supportEmail === 'string' && EMAIL_RE.test(CFG.supportEmail) ? CFG.supportEmail : '';
  const MODE = CFG.payment && CFG.payment.mode === 'stripe' ? 'stripe' : 'free';
  const PRICE_LABEL = CFG.payment && typeof CFG.payment.priceLabel === 'string' ? CFG.payment.priceLabel.slice(0, 20) : '9,99 zł';
  const SEAL_KEY = CFG.seal && Core.isPublicJwk(CFG.seal.publicKeyJwk) ? CFG.seal.publicKeyJwk : null;

  // ------------------------------------------------------------------ narzędzia

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Bezpieczne tworzenie elementów: tekst zawsze jako węzeł tekstowy, brak atrybutów on*. */
  function h(tag, props, children) {
    const el = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const v = props[key];
        if (v === undefined || v === null || v === false) continue;
        if (key === 'class') el.className = v;
        else if (key === 'text') el.textContent = v;
        else if (key === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
        else if (/^on/i.test(key)) throw new Error('Inline handlers are not allowed');
        else if (key === 'value') el.value = v;
        else if (key === 'checked') el.checked = !!v;
        else if (v === true) el.setAttribute(key, '');
        else el.setAttribute(key, String(v));
      }
    }
    if (children !== undefined && children !== null) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
      }
    }
    return el;
  }

  function safeHttpsUrl(value, hosts) {
    if (typeof value !== 'string' || value.length > 500) return null;
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password) return null;
      if (hosts && !hosts.includes(u.hostname)) return null;
      return u;
    } catch (e) {
      return null;
    }
  }

  const LS = {
    get(k) {
      try {
        return window.localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    },
    set(k, v) {
      try {
        window.localStorage.setItem(k, v);
      } catch (e) {
        /* tryb prywatny / brak miejsca */
      }
    },
    del(k) {
      try {
        window.localStorage.removeItem(k);
      } catch (e) {
        /* ignoruj */
      }
    }
  };

  const IDB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        let req;
        try {
          req = window.indexedDB.open('protokol-zdawczy', 1);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => {
          this.db = req.result;
          resolve(this.db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
      });
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', mode);
        const result = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    get(key) {
      return this.run('readonly', (s) => s.get(key));
    },
    set(key, value) {
      return this.run('readwrite', (s) => {
        s.put(value, key);
      });
    },
    del(key) {
      return this.run('readwrite', (s) => {
        s.delete(key);
      });
    }
  };

  let toastTimer = null;
  function toast(message, kind) {
    const box = $('#toast');
    const color = kind === 'error' ? 'bg-red-700' : kind === 'ok' ? 'bg-emerald-700' : 'bg-slate-900';
    box.replaceChildren(h('div', { class: 'pointer-events-auto max-w-md rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg ' + color, text: message }));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.replaceChildren(), kind === 'error' ? 8000 : 5000);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '—';
    const [y, m, d] = iso.split('-');
    return d + '.' + m + '.' + y;
  }

  function fmtDateTime(isoOrDate) {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('pl-PL', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleString('pl-PL', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function dataUrlBytes(dataUrl) {
    const i = dataUrl.indexOf(',');
    return Math.round(((dataUrl.length - i - 1) * 3) / 4);
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name, class: 'hidden' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ------------------------------------------------------------------ stan protokołu

  const DEFAULT_METERS = ['prad', 'woda_zimna', 'woda_ciepla', 'gaz', 'co'];
  const DEFAULT_ROOMS = [
    ['Salon', ['Ściany i podłogi', 'Okna', 'Drzwi', 'Meble']],
    ['Kuchnia / Aneks kuchenny', ['Ściany i podłogi', 'Okna', 'Sprzęt AGD', 'Meble', 'Armatura']],
    ['Sypialnia', ['Ściany i podłogi', 'Okna', 'Drzwi', 'Meble']],
    ['Łazienka', ['Ściany i podłogi', 'Armatura', 'Sprzęt AGD', 'Drzwi']],
    ['Przedpokój', ['Ściany i podłogi', 'Drzwi', 'Meble']],
    ['Balkon / Piwnica', ['Ściany i podłogi']]
  ];

  function newMeter(kind) {
    return {
      kind,
      label: '',
      serial: '',
      tariff: kind === 'prad' ? 'G11' : '',
      reading: '',
      reading2: '',
      unit: Core.METER_KINDS[kind].unit,
      photo: null
    };
  }

  function newItem(name) {
    return { name, condition: '', note: '', photos: [] };
  }

  function defaultState() {
    return {
      type: 'najem',
      direction: 'wydanie',
      date: todayISO(),
      city: 'Łódź',
      address: '',
      contractDate: '',
      giver: { name: '', idNumber: '', phone: '', email: '' },
      receiver: { name: '', idNumber: '', phone: '', email: '' },
      meters: DEFAULT_METERS.map(newMeter),
      keys: { entrance: 0, mailbox: 0, basement: 0, remote: 0, intercom: 0, other: 0 },
      keysNote: '',
      rooms: DEFAULT_ROOMS.map(([name, items]) => ({ name, items: items.map(newItem) })),
      deposit: '',
      notes: ''
    };
  }

  let S = defaultState();
  let SIG = { giver: null, receiver: null };
  let rev = 0;
  let lastGenerated = null;
  let pads = null;

  const BIND_PATHS = new Set([
    'type', 'direction', 'date', 'city', 'address', 'contractDate',
    'giver.name', 'giver.idNumber', 'giver.phone', 'giver.email',
    'receiver.name', 'receiver.idNumber', 'receiver.phone', 'receiver.email',
    'keys.entrance', 'keys.mailbox', 'keys.basement', 'keys.remote', 'keys.intercom', 'keys.other',
    'keysNote', 'deposit', 'notes'
  ]);

  function getPath(path) {
    return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), S);
  }

  function setPath(path, value) {
    if (!BIND_PATHS.has(path)) return;
    const parts = path.split('.');
    let o = S;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = value;
  }

  function isRental() {
    return S.type === 'najem' || S.type === 'najem_okazjonalny';
  }

  function currentRoles() {
    return Core.roles(S.type, isRental() ? S.direction : 'wydanie');
  }

  function sigsForDoc() {
    const pick = (s) => (s && s.rev === rev ? { data: s.data, t: s.t } : null);
    return { giver: pick(SIG.giver), receiver: pick(SIG.receiver) };
  }

  /** Każda zmiana danych: nowa wersja, unieważnienie podpisów i wygenerowanego PDF. */
  function touch() {
    rev++;
    if (pads && (SIG.giver || SIG.receiver || pads.giver.hasInk() || pads.receiver.hasInk())) {
      SIG = { giver: null, receiver: null };
      pads.giver.clear();
      pads.receiver.clear();
      updateSigStatus();
      toast('Zmieniono dane protokołu – podpisy zostały usunięte. Podpiszcie się ponownie na końcu.');
    }
    invalidateResult();
    scheduleSave();
    scheduleSummary();
  }

  // ------------------------------------------------------------------ zdjęcia

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Nie udało się odczytać zdjęcia. Spróbuj formatu JPG lub PNG.'));
      img.src = src;
    });
  }

  /** Zmniejsza zdjęcie (maks. 800 px szerokości), dodaje znacznik daty i zapisuje jako JPEG 0,75. Usuwa EXIF/GPS. */
  async function compressImage(file) {
    if (!file) throw new Error('Brak pliku.');
    if (file.type && !/^image\//.test(file.type)) throw new Error('Wybrany plik nie jest zdjęciem.');
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('Zdjęcie jest za duże (maks. 30 MB).');
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const w0 = img.naturalWidth;
      const h0 = img.naturalHeight;
      if (!w0 || !h0) throw new Error('Nie udało się odczytać zdjęcia.');
      if (w0 * h0 > MAX_SOURCE_PIXELS) throw new Error('Zdjęcie ma zbyt dużą rozdzielczość.');
      const scale = Math.min(1, IMG_MAX_W / w0, IMG_MAX_H / h0);
      const w = Math.max(1, Math.round(w0 * scale));
      const hh = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = hh;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, hh);
      ctx.drawImage(img, 0, 0, w, hh);
      const t = new Date();
      const stamp = fmtDateTime(t);
      const fs = Math.max(11, Math.round(w / 45));
      ctx.font = '600 ' + fs + 'px system-ui, sans-serif';
      const tw = ctx.measureText(stamp).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(w - tw - fs * 1.2, hh - fs * 1.9, tw + fs * 1.2, fs * 1.9);
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(stamp, w - tw - fs * 0.6, hh - fs * 0.95);
      const data = canvas.toDataURL('image/jpeg', IMG_QUALITY);
      if (!/^data:image\/jpeg;base64,/.test(data)) throw new Error('Ta przeglądarka nie potrafi zapisać zdjęcia jako JPEG.');
      return { data, w, h: hh, t: t.toISOString() };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Obszar miniatur + przyciski "Zrób zdjęcie" / "Z galerii". */
  function photoArea(model) {
    const box = h('div', { class: 'flex flex-wrap items-center gap-2' });
    function fileButton(label, capture) {
      const input = h('input', {
        type: 'file',
        accept: 'image/*',
        class: 'sr-only',
        capture: capture ? 'environment' : null,
        multiple: !capture && model.max > 1 ? true : null
      });
      input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        input.value = '';
        for (const f of files) {
          if (model.list().length >= model.max) break;
          if (Core.countPhotos(S) >= Core.LIMITS.photosTotal) {
            toast('Osiągnięto limit ' + Core.LIMITS.photosTotal + ' zdjęć w jednym protokole.', 'error');
            break;
          }
          try {
            const p = await compressImage(f);
            model.add(p);
            touch();
          } catch (e) {
            toast(e.message || 'Nie udało się dodać zdjęcia.', 'error');
          }
        }
        draw();
      });
      return h('label', { class: 'btn-file min-h-[40px] px-3 py-2 text-xs' }, [label, input]);
    }
    function draw() {
      box.replaceChildren();
      model.list().forEach((p, i) => {
        box.append(
          h('div', { class: 'thumb' }, [
            h('img', { src: p.data, alt: model.alt + ' – zdjęcie ' + (i + 1) }),
            h('button', {
              type: 'button',
              class: 'thumb-remove',
              'aria-label': 'Usuń zdjęcie',
              text: '×',
              on: {
                click: () => {
                  model.remove(i);
                  touch();
                  draw();
                }
              }
            })
          ])
        );
      });
      if (model.list().length < model.max) {
        box.append(fileButton('Zrób zdjęcie', true), fileButton('Z galerii', false));
      }
    }
    draw();
    return box;
  }

  // ------------------------------------------------------------------ liczniki

  function sanitizeReadingInput(el) {
    const clean = el.value.replace(/[^\d.,]/g, '');
    if (clean !== el.value) el.value = clean;
    return clean;
  }

  function validReading(v) {
    return v === '' || /^[0-9]+([.,][0-9]+)?$/.test(v);
  }

  function field(labelText, input, extraClass) {
    const id = 'f' + Math.random().toString(36).slice(2, 10);
    input.id = id;
    return h('div', { class: extraClass || '' }, [h('label', { class: 'label', for: id, text: labelText }), input]);
  }

  function renderMeters() {
    const list = $('#meters-list');
    list.replaceChildren();
    if (!S.meters.length) {
      list.append(h('p', { class: 'text-sm text-slate-500', text: 'Brak liczników. Dodaj licznik poniżej.' }));
      return;
    }
    S.meters.forEach((m, idx) => list.append(meterRow(m, idx)));
  }

  function meterRow(m, idx) {
    const kind = Core.METER_KINDS[m.kind] || Core.METER_KINDS.inny;
    const title = h('h3', { class: 'font-semibold text-slate-800', text: kind.label });
    const removeBtn = h('button', {
      type: 'button',
      class: 'btn-ghost min-h-[36px] px-2 py-1 text-xs text-red-700',
      text: 'Usuń',
      'aria-label': 'Usuń licznik: ' + kind.label,
      on: {
        click: () => {
          if ((m.serial || m.reading || m.photo) && !window.confirm('Usunąć licznik „' + kind.label + '” razem z odczytem i zdjęciem?')) return;
          S.meters.splice(idx, 1);
          touch();
          renderMeters();
        }
      }
    });

    const text = (key, max, placeholder, extra) => {
      const input = h('input', Object.assign({ class: 'input-sm', type: 'text', maxlength: max, value: m[key], placeholder }, extra || {}));
      input.addEventListener('input', () => {
        m[key] = input.value;
        touch();
      });
      return input;
    };

    const readingInput = (key) => {
      const input = h('input', { class: 'input-sm tabular-nums', type: 'text', inputmode: 'decimal', maxlength: 20, value: m[key], placeholder: 'np. 12345,6' });
      input.addEventListener('input', () => {
        m[key] = sanitizeReadingInput(input);
        input.classList.toggle('border-red-500', !validReading(m[key]));
        touch();
      });
      return input;
    };

    const unitText = m.kind === 'co' || m.kind === 'inny' ? '' : ' (' + kind.unit + ')';
    const grid = h('div', { class: 'grid grid-cols-2 gap-3 sm:grid-cols-4' });
    grid.append(field('Numer licznika', text('serial', 60, 'nr seryjny'), 'col-span-2 sm:col-span-1'));

    if (m.kind === 'prad') {
      const sel = h('select', { class: 'input-sm' }, [
        h('option', { value: 'G11', text: 'G11 (1-taryfowy)' }),
        h('option', { value: 'G12', text: 'G12 (2-taryfowy)' })
      ]);
      sel.value = m.tariff === 'G12' ? 'G12' : 'G11';
      sel.addEventListener('change', () => {
        m.tariff = sel.value;
        if (m.tariff !== 'G12') m.reading2 = '';
        touch();
        renderMeters();
      });
      grid.append(field('Taryfa', sel));
      grid.append(field(m.tariff === 'G12' ? 'Odczyt strefa I – dzienna (kWh)' : 'Odczyt (kWh)', readingInput('reading')));
      if (m.tariff === 'G12') grid.append(field('Odczyt strefa II – nocna (kWh)', readingInput('reading2')));
    } else {
      grid.append(field('Odczyt' + unitText, readingInput('reading')));
      if (m.kind === 'co') {
        const sel = h('select', { class: 'input-sm' }, Core.CO_UNITS.map((u) => h('option', { value: u, text: u })));
        sel.value = Core.CO_UNITS.includes(m.unit) ? m.unit : 'GJ';
        sel.addEventListener('change', () => {
          m.unit = sel.value;
          touch();
        });
        grid.append(field('Jednostka', sel));
      } else if (m.kind === 'inny') {
        grid.append(field('Jednostka', text('unit', 10, 'np. m³')));
      }
    }
    grid.append(field('Opis / lokalizacja', text('label', 60, 'np. łazienka'), 'col-span-2 sm:col-span-1'));

    const photos = photoArea({
      max: 1,
      alt: kind.label,
      list: () => (m.photo ? [m.photo] : []),
      add: (p) => {
        m.photo = p;
      },
      remove: () => {
        m.photo = null;
      }
    });

    return h('div', { class: 'space-y-3 rounded-xl border border-slate-200 p-3' }, [
      h('div', { class: 'flex items-center justify-between gap-2' }, [title, removeBtn]),
      grid,
      h('div', null, [h('span', { class: 'label', text: 'Zdjęcie licznika' }), photos])
    ]);
  }

  // ------------------------------------------------------------------ pomieszczenia

  function renderRooms() {
    const list = $('#rooms-list');
    list.replaceChildren();
    if (!S.rooms.length) {
      list.append(h('p', { class: 'text-sm text-slate-500', text: 'Brak pomieszczeń. Dodaj pomieszczenie poniżej.' }));
      return;
    }
    S.rooms.forEach((room, ri) => list.append(roomCard(room, ri)));
  }

  function roomCard(room, ri) {
    const nameInput = h('input', { class: 'input-sm font-semibold', type: 'text', maxlength: 60, value: room.name, 'aria-label': 'Nazwa pomieszczenia' });
    nameInput.addEventListener('input', () => {
      room.name = nameInput.value;
      touch();
    });
    const removeRoom = h('button', {
      type: 'button',
      class: 'btn-ghost min-h-[36px] shrink-0 px-2 py-1 text-xs text-red-700',
      text: 'Usuń pomieszczenie',
      on: {
        click: () => {
          if (!window.confirm('Usunąć pomieszczenie „' + (room.name || 'bez nazwy') + '” razem z elementami i zdjęciami?')) return;
          S.rooms.splice(ri, 1);
          touch();
          renderRooms();
        }
      }
    });

    const itemsBox = h('div', { class: 'space-y-3' });
    room.items.forEach((it, ii) => itemsBox.append(itemRow(room, it, ii)));

    const addItem = h('button', {
      type: 'button',
      class: 'btn-secondary min-h-[40px] text-xs',
      text: '+ Dodaj element',
      on: {
        click: () => {
          if (room.items.length >= Core.LIMITS.itemsPerRoom) {
            toast('Maksymalnie ' + Core.LIMITS.itemsPerRoom + ' elementów w pomieszczeniu.', 'error');
            return;
          }
          room.items.push(newItem(''));
          touch();
          renderRooms();
        }
      }
    });

    return h('div', { class: 'space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3' }, [
      h('div', { class: 'flex items-center gap-2' }, [nameInput, removeRoom]),
      itemsBox,
      addItem
    ]);
  }

  function itemRow(room, it, ii) {
    const name = h('input', { class: 'input-sm', type: 'text', maxlength: 80, value: it.name, list: 'item-suggestions', placeholder: 'np. Okna' });
    name.addEventListener('input', () => {
      it.name = name.value;
      touch();
    });
    const cond = h(
      'select',
      { class: 'input-sm' },
      Object.keys(Core.CONDITIONS).map((k) => h('option', { value: k, text: k === '' ? '– wybierz stan –' : Core.CONDITIONS[k] }))
    );
    cond.value = it.condition;
    const note = h('input', { class: 'input-sm', type: 'text', maxlength: 500, value: it.note, placeholder: 'Uwagi (opcjonalnie)' });
    const markDamage = () => {
      const damaged = it.condition === 'uszkodzony';
      note.classList.toggle('border-amber-500', damaged);
      note.placeholder = damaged ? 'Opisz uszkodzenie (wymagane przy usterce)' : 'Uwagi (opcjonalnie)';
    };
    cond.addEventListener('change', () => {
      it.condition = cond.value;
      markDamage();
      touch();
    });
    note.addEventListener('input', () => {
      it.note = note.value;
      touch();
    });
    markDamage();
    const remove = h('button', {
      type: 'button',
      class: 'btn-ghost min-h-[36px] px-2 py-1 text-xs text-red-700',
      text: 'Usuń',
      'aria-label': 'Usuń element',
      on: {
        click: () => {
          room.items.splice(ii, 1);
          touch();
          renderRooms();
        }
      }
    });
    const photos = photoArea({
      max: Core.LIMITS.photosPerItem,
      alt: (room.name || 'Pomieszczenie') + ' – ' + (it.name || 'element'),
      list: () => it.photos,
      add: (p) => it.photos.push(p),
      remove: (i) => it.photos.splice(i, 1)
    });
    return h('div', { class: 'space-y-2 rounded-lg border border-slate-200 bg-white p-3' }, [
      h('div', { class: 'grid grid-cols-1 gap-2 sm:grid-cols-3' }, [
        field('Element', name),
        field('Stan', cond),
        field('Uwagi / opis usterki', note)
      ]),
      h('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [photos, remove])
    ]);
  }

  // ------------------------------------------------------------------ podpisy

  class SignaturePad {
    constructor(canvas, onEnd) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.strokes = [];
      this.cur = null;
      this.bg = null;
      this.onEnd = onEnd;
      const resize = () => this.resize();
      if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
      else window.addEventListener('resize', resize);
      const opt = { passive: false };
      if (window.PointerEvent) {
        canvas.addEventListener('pointerdown', (e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          e.preventDefault();
          try {
            canvas.setPointerCapture(e.pointerId);
          } catch (err) {
            /* ignoruj */
          }
          this.start(this.point(e));
        }, opt);
        canvas.addEventListener('pointermove', (e) => {
          if (!this.cur) return;
          e.preventDefault();
          const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
          for (const ev of list.length ? list : [e]) this.move(this.point(ev));
        }, opt);
        const end = (e) => {
          if (!this.cur) return;
          if (e && e.cancelable) e.preventDefault();
          this.end();
        };
        canvas.addEventListener('pointerup', end, opt);
        canvas.addEventListener('pointercancel', end, opt);
        canvas.addEventListener('lostpointercapture', end);
        // Blokada przewijania strony palcem w trakcie podpisu (starsze iOS Safari).
        canvas.addEventListener('touchstart', (e) => e.preventDefault(), opt);
        canvas.addEventListener('touchmove', (e) => e.preventDefault(), opt);
        canvas.addEventListener('touchend', (e) => e.preventDefault(), opt);
      } else {
        canvas.addEventListener('touchstart', (e) => {
          e.preventDefault();
          this.start(this.point(e.changedTouches[0]));
        }, opt);
        canvas.addEventListener('touchmove', (e) => {
          e.preventDefault();
          if (!this.cur) return;
          for (const t of Array.from(e.changedTouches)) this.move(this.point(t));
        }, opt);
        const tend = (e) => {
          e.preventDefault();
          this.end();
        };
        canvas.addEventListener('touchend', tend, opt);
        canvas.addEventListener('touchcancel', tend, opt);
        canvas.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          this.start(this.point(e));
        });
        window.addEventListener('mousemove', (e) => {
          if (this.cur) this.move(this.point(e));
        });
        window.addEventListener('mouseup', () => this.end());
      }
      this.resize();
    }

    point(e) {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1)))
      };
    }

    start(p) {
      this.cur = [p];
      this.strokes.push(this.cur);
      this.redraw();
    }

    move(p) {
      const last = this.cur[this.cur.length - 1];
      if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 0.002) return;
      if (this.cur.length > 5000) return;
      this.cur.push(p);
      this.redraw();
    }

    end() {
      if (!this.cur) return;
      this.cur = null;
      if (this.onEnd) this.onEnd();
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const w = Math.round(r.width * dpr);
      const hh = Math.round(r.height * dpr);
      if (this.canvas.width === w && this.canvas.height === hh) return;
      this.canvas.width = w;
      this.canvas.height = hh;
      this.redraw();
    }

    paint(ctx, W, H, lw) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      if (this.bg) ctx.drawImage(this.bg, 0, 0, W, H);
      ctx.strokeStyle = '#0f172a';
      ctx.fillStyle = '#0f172a';
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of this.strokes) {
        if (s.length === 1) {
          ctx.beginPath();
          ctx.arc(s[0].x * W, s[0].y * H, lw / 2, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(s[0].x * W, s[0].y * H);
        for (let i = 1; i < s.length - 1; i++) {
          ctx.quadraticCurveTo(s[i].x * W, s[i].y * H, ((s[i].x + s[i + 1].x) / 2) * W, ((s[i].y + s[i + 1].y) / 2) * H);
        }
        const l = s[s.length - 1];
        ctx.lineTo(l.x * W, l.y * H);
        ctx.stroke();
      }
    }

    redraw() {
      const c = this.canvas;
      const cssW = c.getBoundingClientRect().width || c.width;
      this.paint(this.ctx, c.width, c.height, 2.4 * (c.width / cssW));
    }

    inkLength() {
      let len = 0;
      for (const s of this.strokes) for (let i = 1; i < s.length; i++) len += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
      return len;
    }

    hasInk() {
      return !!this.bg || this.strokes.length > 0;
    }

    isValid() {
      return !!this.bg || this.inkLength() >= 0.08;
    }

    toDataURL() {
      const r = this.canvas.getBoundingClientRect();
      const W = 600;
      const H = Math.max(120, Math.min(400, Math.round(W * ((r.height || 1) / (r.width || 3)))));
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      this.paint(c.getContext('2d'), W, H, 3.2);
      return c.toDataURL('image/png');
    }

    clear() {
      this.strokes = [];
      this.cur = null;
      this.bg = null;
      this.redraw();
    }

    setImage(dataUrl) {
      loadImage(dataUrl)
        .then((img) => {
          this.bg = img;
          this.strokes = [];
          this.redraw();
        })
        .catch(() => {});
    }
  }

  function onSignatureEnd(who) {
    const pad = pads[who];
    SIG[who] = pad.isValid() ? { data: pad.toDataURL(), t: new Date().toISOString(), rev } : null;
    invalidateResult();
    updateSigStatus();
    scheduleSave();
    scheduleSummary();
  }

  function updateSigStatus() {
    for (const who of ['giver', 'receiver']) {
      const el = $('#sig-' + who + '-status');
      const s = SIG[who];
      if (s && s.rev === rev) {
        el.textContent = 'Podpisano: ' + fmtDateTime(s.t);
        el.className = 'hint font-semibold text-emerald-700';
      } else {
        el.textContent = pads && pads[who].hasInk() ? 'Podpis za krótki – podpisz się pełnym podpisem' : 'Brak podpisu';
        el.className = 'hint';
      }
    }
  }

  function updateRoles() {
    const r = currentRoles();
    $('#giver-role').textContent = 'Przekazujący (' + r.giver + ')';
    $('#receiver-role').textContent = 'Przejmujący (' + r.receiver + ')';
    $('#sig-giver-label').textContent = 'Podpis Przekazującego (' + r.giver + ')';
    $('#sig-receiver-label').textContent = 'Podpis Przejmującego (' + r.receiver + ')';
    $('#direction-wrap').hidden = !isRental();
  }

  // ------------------------------------------------------------------ formularz – pola stałe

  function populateBound() {
    for (const el of $$('[data-bind]')) {
      const v = getPath(el.dataset.bind);
      if (el.type === 'radio') el.checked = el.value === v;
      else el.value = v === undefined || v === null ? '' : String(v);
    }
    updateRoles();
  }

  function onBoundInput(e) {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.bind) return;
    const path = el.dataset.bind;
    if (el.type === 'radio') {
      if (!el.checked) return;
      setPath(path, el.value);
    } else if (el.dataset.type === 'int') {
      const n = Number.parseInt(el.value, 10);
      setPath(path, Number.isFinite(n) ? Math.max(0, Math.min(99, n)) : 0);
    } else {
      setPath(path, el.value);
    }
    if (path === 'type' || path === 'direction') updateRoles();
    touch();
  }

  // ------------------------------------------------------------------ podsumowanie i walidacja

  function collectIssues(full) {
    const errors = [];
    const warnings = [];
    if (!S.date) errors.push('Uzupełnij datę przekazania (krok 1).');
    if (!S.address.trim()) errors.push('Uzupełnij adres lokalu (krok 1).');
    if (!S.giver.name.trim()) errors.push('Uzupełnij imię i nazwisko przekazującego (krok 2).');
    if (!S.receiver.name.trim()) errors.push('Uzupełnij imię i nazwisko przejmującego (krok 2).');
    for (const m of S.meters) {
      const label = (Core.METER_KINDS[m.kind] || Core.METER_KINDS.inny).label;
      if (!validReading(m.reading) || !validReading(m.reading2)) errors.push('Nieprawidłowy odczyt licznika „' + label + '” – wpisz liczbę, np. 12345,6 (krok 3).');
      else if (!m.reading) warnings.push('Brak odczytu: ' + label + (m.label ? ' (' + m.label + ')' : '') + '.');
    }
    let noCondition = 0;
    let damagedNoNote = 0;
    for (const r of S.rooms) {
      for (const it of r.items) {
        if (!it.condition) noCondition++;
        if (it.condition === 'uszkodzony' && !it.note.trim()) damagedNoNote++;
      }
    }
    if (noCondition) warnings.push('Elementy bez oceny stanu: ' + noCondition + ' (krok 5).');
    if (damagedNoNote) warnings.push('Uszkodzone elementy bez opisu: ' + damagedNoNote + ' (krok 5).');
    const sg = sigsForDoc();
    if (full) {
      if (!sg.giver) errors.push('Brak podpisu przekazującego (krok 7).');
      if (!sg.receiver) errors.push('Brak podpisu przejmującego (krok 7).');
    }
    return { errors, warnings };
  }

  let summaryTimer = null;
  function scheduleSummary() {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(updateSummary, 250);
  }

  function updateSummary() {
    const ul = $('#gen-summary');
    const { errors, warnings } = collectIssues(true);
    let bytes = 0;
    for (const m of S.meters) if (m.photo) bytes += dataUrlBytes(m.photo.data);
    for (const r of S.rooms) for (const it of r.items) for (const p of it.photos) bytes += dataUrlBytes(p.data);
    const n = Core.countPhotos(S);
    const items = [];
    for (const e of errors) items.push(['!', e, 'text-red-700']);
    for (const w of warnings) items.push(['•', w, 'text-amber-700']);
    items.push(['✓', 'Zdjęcia: ' + n + ' z ' + Core.LIMITS.photosTotal + ' (ok. ' + (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB)', 'text-slate-600']);
    if (bytes > PDF_SIZE_WARN_BYTES) items.push(['•', 'PDF przekroczy ok. 3 MB – niektóre skrzynki e-mail mogą go odrzucić. Rozważ usunięcie części zdjęć.', 'text-amber-700']);
    if (!errors.length) items.push(['✓', 'Protokół jest gotowy do pobrania.', 'text-emerald-700 font-semibold']);
    ul.replaceChildren(...items.map(([icon, text, cls]) => h('li', { class: 'flex gap-2 ' + cls }, [h('span', { 'aria-hidden': 'true', class: 'w-3 shrink-0 font-bold', text: icon }), h('span', { text })])));
  }

  // ------------------------------------------------------------------ szkic (IndexedDB)

  let saveTimer = null;
  function autosaveEnabled() {
    return $('#autosave-toggle').checked;
  }

  function scheduleSave() {
    if (!autosaveEnabled()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveDraft(false).catch(() => {});
    }, 800);
  }

  async function saveDraft(force) {
    const enabled = autosaveEnabled();
    if (!enabled && !force) return;
    const sg = sigsForDoc();
    await IDB.set(DRAFT_KEY, { v: 1, savedAt: Date.now(), temp: !enabled, protocol: S, signatures: sg });
  }

  async function restoreDraft() {
    let d;
    try {
      d = await IDB.get(DRAFT_KEY);
    } catch (e) {
      return false;
    }
    if (!d || typeof d !== 'object' || typeof d.savedAt !== 'number') return false;
    if (!(Date.now() - d.savedAt < DRAFT_TTL_MS)) {
      await IDB.del(DRAFT_KEY).catch(() => {});
      return false;
    }
    S = Core.sanitizeProtocol(d.protocol);
    rev++;
    const sg = Core.sanitizeSignatures(d.signatures);
    SIG = {
      giver: sg.giver ? Object.assign({}, sg.giver, { rev }) : null,
      receiver: sg.receiver ? Object.assign({}, sg.receiver, { rev }) : null
    };
    if (d.temp) await IDB.del(DRAFT_KEY).catch(() => {});
    return new Date(d.savedAt);
  }

  function applyStateToUi() {
    populateBound();
    renderMeters();
    renderRooms();
    if (pads) {
      pads.giver.clear();
      pads.receiver.clear();
      if (SIG.giver) pads.giver.setImage(SIG.giver.data);
      if (SIG.receiver) pads.receiver.setImage(SIG.receiver.data);
    }
    updateSigStatus();
    invalidateResult();
    updateSummary();
  }

  // ------------------------------------------------------------------ PDF

  let pdfMakePromise = null;

  function loadScript(src, integrity) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.integrity = integrity;
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Nie udało się wczytać modułu PDF. Sprawdź połączenie z internetem i odśwież stronę.'));
      document.head.append(s);
    });
  }

  function loadPdfMake() {
    if (!pdfMakePromise) {
      pdfMakePromise = (async () => {
        if (!window.pdfMake) {
          await loadScript(VENDOR.dir + 'pdfmake.min.js', VENDOR.pdfmake);
          await loadScript(VENDOR.dir + 'vfs_fonts.js', VENDOR.fonts);
        }
        if (!window.pdfMake || typeof window.pdfMake.createPdf !== 'function') throw new Error('Moduł PDF jest niedostępny.');
        // pdfmake nie może pobierać niczego z internetu – używamy wyłącznie osadzonych danych.
        if (typeof window.pdfMake.setUrlAccessPolicy === 'function') window.pdfMake.setUrlAccessPolicy(() => false);
        return window.pdfMake;
      })().catch((e) => {
        pdfMakePromise = null;
        throw e;
      });
    }
    return pdfMakePromise;
  }

  // Bardzo długie ciągi bez spacji (np. wklejony tekst) łamiemy, aby nie wychodziły poza stronę.
  function pt(s) {
    return String(s === undefined || s === null ? '' : s).replace(/(\S{40})(?=\S)/g, '$1 ');
  }

  function chunk(s, n) {
    const out = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out.join('\n');
  }

  function readingText(m) {
    const kind = Core.METER_KINDS[m.kind] || Core.METER_KINDS.inny;
    const unit = m.kind === 'co' || m.kind === 'inny' ? m.unit : kind.unit;
    if (m.kind === 'prad' && m.tariff === 'G12') {
      if (!m.reading && !m.reading2) return '—';
      return 'I: ' + (m.reading || '—') + '\nII: ' + (m.reading2 || '—') + ' ' + unit;
    }
    return m.reading ? m.reading + (unit ? ' ' + unit : '') : '—';
  }

  const TABLE_LAYOUT = {
    hLineWidth: () => 0.5,
    vLineWidth: () => 0.5,
    hLineColor: () => '#cbd5e1',
    vLineColor: () => '#cbd5e1',
    paddingLeft: () => 4,
    paddingRight: () => 4,
    paddingTop: () => 3,
    paddingBottom: () => 3,
    fillColor: (row) => (row === 0 ? '#eef2f7' : null)
  };

  function th(text) {
    return { text, bold: true, fontSize: 8.5 };
  }

  /**
   * @param {object} p zsanityzowany protokół
   * @param {object} sigs zsanityzowane podpisy
   * @param {{full:boolean, hash:string|null, seal:object|null, generatedAt:Date, watermark:boolean}} o
   */
  function buildDocDefinition(p, sigs, o) {
    const r = Core.roles(p.type, p.direction);
    const images = {};
    const figures = [];
    const addPhoto = (ph, caption) => {
      if (!o.full || !ph) return '';
      const n = figures.length + 1;
      images['fot' + n] = ph.data;
      figures.push({ key: 'fot' + n, caption: 'Fot. ' + n + ' – ' + caption + (ph.t ? ' (dodano ' + fmtDateTime(ph.t) + ')' : '') });
      return 'Fot. ' + n;
    };

    const content = [];
    content.push({ text: 'PROTOKÓŁ ZDAWCZO-ODBIORCZY', style: 'title' });
    content.push({ text: 'lokalu mieszkalnego – ' + Core.TYPES[p.type].toLowerCase() + (p.type.startsWith('najem') ? (p.direction === 'zwrot' ? ' (zwrot lokalu)' : ' (wydanie lokalu)') : ''), style: 'subtitle' });

    content.push({
      table: {
        widths: [130, '*'],
        body: [
          [th('Data przekazania'), pt(fmtDate(p.date))],
          [th('Miejscowość'), pt(p.city || '—')],
          [th('Adres lokalu'), pt(p.address || '—')],
          [th('Do ' + r.contract + ' z dnia'), pt(p.contractDate ? fmtDate(p.contractDate) : '—')]
        ]
      },
      layout: Object.assign({}, TABLE_LAYOUT, { fillColor: () => null }),
      margin: [0, 0, 0, 10]
    });

    const partyStack = (role, party) => ({
      stack: [
        { text: role, bold: true, margin: [0, 0, 0, 3] },
        { text: pt(party.name || '—') },
        party.idNumber ? { text: 'PESEL / nr dokumentu: ' + pt(party.idNumber), fontSize: 8.5 } : null,
        party.phone ? { text: 'Tel.: ' + pt(party.phone), fontSize: 8.5 } : null,
        party.email ? { text: 'E-mail: ' + pt(party.email), fontSize: 8.5 } : null
      ].filter(Boolean)
    });
    content.push({
      table: {
        widths: ['*', '*'],
        body: [[partyStack('Przekazujący – ' + r.giver, p.giver), partyStack('Przejmujący – ' + r.receiver, p.receiver)]]
      },
      layout: Object.assign({}, TABLE_LAYOUT, { fillColor: () => null }),
      margin: [0, 0, 0, 12]
    });

    // 1. Liczniki
    content.push({ text: '1. Stan liczników', style: 'h2' });
    if (p.meters.length) {
      const body = [[th('Lp.'), th('Licznik'), th('Nr licznika'), th('Odczyt'), th('Zdjęcie')]];
      p.meters.forEach((m, i) => {
        const kind = Core.METER_KINDS[m.kind] || Core.METER_KINDS.inny;
        const name = kind.label + (m.kind === 'prad' ? ' – ' + m.tariff : '') + (m.label ? '\n' + m.label : '');
        const ref = m.photo ? (o.full ? addPhoto(m.photo, kind.label + (m.serial ? ', nr ' + m.serial : '') + (m.label ? ', ' + m.label : '')) : 'w wersji pełnej') : '—';
        body.push([String(i + 1), pt(name), pt(m.serial || '—'), pt(readingText(m)), ref]);
      });
      content.push({ table: { headerRows: 1, widths: [18, '*', 95, 95, 52], body }, layout: TABLE_LAYOUT, margin: [0, 0, 0, 12] });
    } else {
      content.push({ text: 'Nie spisano liczników.', italics: true, margin: [0, 0, 0, 12] });
    }

    // 2. Klucze
    content.push({ text: '2. Klucze i urządzenia dostępowe', style: 'h2' });
    const keyBody = [[th('Rodzaj'), th('Liczba')]];
    for (const k of Object.keys(Core.KEY_FIELDS)) keyBody.push([Core.KEY_FIELDS[k], p.keys[k] + ' szt.']);
    content.push({ table: { headerRows: 1, widths: ['*', 70], body: keyBody }, layout: TABLE_LAYOUT, margin: [0, 0, 0, p.keysNote ? 4 : 12] });
    if (p.keysNote) content.push({ text: 'Uwagi: ' + pt(p.keysNote), fontSize: 8.5, margin: [0, 0, 0, 12] });

    // 3. Pomieszczenia
    content.push({ text: '3. Stan techniczny lokalu i wyposażenia', style: 'h2' });
    if (!p.rooms.length) content.push({ text: 'Nie opisano pomieszczeń.', italics: true, margin: [0, 0, 0, 12] });
    p.rooms.forEach((room, ri) => {
      const body = [[th('Element'), th('Stan'), th('Uwagi'), th('Zdjęcia')]];
      room.items.forEach((it) => {
        const refs = it.photos.length
          ? o.full
            ? it.photos.map((ph) => addPhoto(ph, (room.name || 'Pomieszczenie') + ' – ' + (it.name || 'element') + (it.note ? ': ' + it.note.slice(0, 120) : ''))).join(', ')
            : 'w wersji pełnej'
          : '—';
        const condText = Core.CONDITIONS[it.condition] || Core.CONDITIONS[''];
        body.push([
          pt(it.name || '—'),
          it.condition === 'uszkodzony' ? { text: condText, color: '#b91c1c', bold: true } : condText,
          pt(it.note || '—'),
          refs
        ]);
      });
      if (room.items.length === 0) body.push([{ text: 'Brak elementów', italics: true, colSpan: 4 }, '', '', '']);
      content.push({
        stack: [
          { text: '3.' + (ri + 1) + '. ' + pt(room.name || 'Pomieszczenie'), bold: true, margin: [0, 2, 0, 3] },
          { table: { headerRows: 1, widths: [110, 95, '*', 52], body }, layout: TABLE_LAYOUT }
        ],
        margin: [0, 0, 0, 8]
      });
    });

    // 4. Kaucja i uwagi
    content.push({ text: '4. Kaucja i uwagi stron', style: 'h2', margin: [0, 6, 0, 4] });
    content.push({ text: 'Kaucja: ' + (p.deposit ? pt(p.deposit) + ' zł' : 'nie dotyczy / nie wpisano'), margin: [0, 0, 0, 4] });
    content.push({ text: 'Uwagi: ' + (p.notes ? pt(p.notes) : 'brak'), margin: [0, 0, 0, 12] });

    // Oświadczenie
    content.push({
      text:
        'Strony zgodnie oświadczają, że w dniu ' + fmtDate(p.date) + ' Przekazujący (' + r.giver + ') przekazuje, a Przejmujący (' + r.receiver +
        ') przejmuje lokal mieszkalny położony pod adresem: ' + pt(p.address || '—') +
        ', wraz z kluczami i urządzeniami wymienionymi w pkt 2. Stany liczników oraz stan techniczny lokalu i wyposażenia są zgodne z opisem w niniejszym protokole, z zastrzeżeniem uwag w nim wpisanych. ' +
        (o.full
          ? 'Protokół sporządzono w formie elektronicznej i podpisano na ekranie urządzenia; każda ze stron otrzymuje jego egzemplarz.'
          : 'Protokół sporządzono w dwóch jednobrzmiących egzemplarzach, po jednym dla każdej ze stron.'),
      alignment: 'justify',
      margin: [0, 0, 0, 14]
    });

    // Podpisy
    const sigCell = (role, name, s) => {
      const stack = [{ text: role, bold: true, margin: [0, 0, 0, 4] }];
      if (o.full && s) {
        stack.push({ image: s.data, fit: [220, 80], margin: [0, 0, 0, 2] });
        stack.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 220, y2: 0, lineWidth: 0.5, lineColor: '#64748b' }] });
        stack.push({ text: pt(name || ''), margin: [0, 3, 0, 0] });
        stack.push({ text: 'Podpisano na ekranie urządzenia: ' + fmtDateTime(s.t), fontSize: 7.5, color: '#475569' });
      } else {
        stack.push({ text: ' ', margin: [0, 0, 0, 40] });
        stack.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 220, y2: 0, lineWidth: 0.5, lineColor: '#64748b' }] });
        stack.push({ text: pt(name || '') + ' (czytelny podpis)', margin: [0, 3, 0, 0] });
      }
      return { stack };
    };
    content.push({
      columns: [sigCell('Przekazujący – ' + r.giver, p.giver.name, sigs.giver), sigCell('Przejmujący – ' + r.receiver, p.receiver.name, sigs.receiver)],
      columnGap: 30,
      unbreakable: true,
      margin: [0, 0, 0, 14]
    });

    // Integralność
    if (o.full && o.hash) {
      const integrity = [
        { text: 'Integralność dokumentu', bold: true, margin: [0, 0, 0, 4] },
        { text: 'Skrót SHA-256 treści protokołu (dane, zdjęcia i podpisy):', fontSize: 8 },
        { text: o.hash, font: 'Roboto', fontSize: 8, bold: true, margin: [0, 1, 0, 4] },
        { text: 'Wygenerowano: ' + fmtDateTime(o.generatedAt) + ' (czas urządzenia, strefa Europe/Warsaw).', fontSize: 8 },
        {
          text: 'Zmiana choćby jednego znaku, zdjęcia lub podpisu daje inny skrót. Zgodność można sprawdzić, wczytując plik danych (.json) protokołu na stronie ' + SITE_URL + '/#weryfikacja.',
          fontSize: 7.5,
          color: '#475569',
          margin: [0, 2, 0, 0]
        },
        { text: 'Podpisy złożone na ekranie są zwykłymi podpisami elektronicznymi (nie są kwalifikowanymi podpisami elektronicznymi).', fontSize: 7.5, color: '#475569' }
      ];
      if (o.seal) {
        integrity.push({
          columns: [
            {
              width: '*',
              stack: [
                { text: 'Pieczęć czasu serwera ' + SITE_NAME, bold: true, margin: [0, 6, 0, 2] },
                { text: 'Czas opieczętowania: ' + fmtDateTime(o.seal.payload.t) + ' (czas serwera)', fontSize: 8 },
                { text: 'ID pieczęci: ' + o.seal.payload.n + ' · ref. płatności: ' + o.seal.payload.p + (o.seal.payload.l ? '' : ' · TEST'), fontSize: 8 },
                { text: 'Kod weryfikacyjny:', fontSize: 7.5, margin: [0, 3, 0, 0] },
                { text: chunk(o.seal.token, 78), fontSize: 6.5, color: '#334155' }
              ]
            },
            { width: 110, stack: [{ qr: SITE_URL + '/#weryfikuj=' + o.seal.token, fit: 110, eccLevel: 'M' }, { text: 'Zeskanuj, aby sprawdzić', fontSize: 7, alignment: 'center', margin: [0, 2, 0, 0] }] }
          ],
          columnGap: 10
        });
      }
      content.push({ table: { widths: ['*'], body: [[{ stack: integrity }]] }, layout: Object.assign({}, TABLE_LAYOUT, { fillColor: () => '#f8fafc' }), unbreakable: true });
    } else {
      content.push({
        text: 'Wersja bez zdjęć i podpisów elektronicznych. Wydrukuj protokół i podpiszcie go odręcznie.' + (o.watermark ? ' Pełna wersja ze zdjęciami, podpisami z ekranu i pieczęcią czasu: ' + SITE_URL : ''),
        fontSize: 8,
        color: '#475569'
      });
    }

    // Załącznik fotograficzny
    if (figures.length) {
      content.push({ text: 'Załącznik – dokumentacja fotograficzna', style: 'h2', pageBreak: 'before' });
      const fig = (f) => ({
        width: '*',
        stack: [
          { image: f.key, fit: [245, 220], alignment: 'center' },
          { text: pt(f.caption), fontSize: 7.5, color: '#334155', margin: [0, 3, 0, 0] }
        ]
      });
      for (let i = 0; i < figures.length; i += 2) {
        content.push({
          columns: [fig(figures[i]), figures[i + 1] ? fig(figures[i + 1]) : { width: '*', text: '' }],
          columnGap: 14,
          unbreakable: true,
          margin: [0, 0, 0, 12]
        });
      }
    }

    const dd = {
      pageSize: 'A4',
      pageMargins: [40, 40, 40, 50],
      info: {
        title: 'Protokół zdawczo-odbiorczy lokalu mieszkalnego',
        author: SITE_NAME,
        subject: 'Protokół zdawczo-odbiorczy',
        creator: SITE_NAME,
        producer: SITE_NAME
      },
      defaultStyle: { font: 'Roboto', fontSize: 9, lineHeight: 1.2, color: '#0f172a' },
      styles: {
        title: { fontSize: 16, bold: true, alignment: 'center', margin: [0, 0, 0, 2] },
        subtitle: { fontSize: 10, alignment: 'center', color: '#334155', margin: [0, 0, 0, 12] },
        h2: { fontSize: 11, bold: true, color: '#1b459c', margin: [0, 4, 0, 5] }
      },
      images,
      content,
      footer: (currentPage, pageCount) => ({
        margin: [40, 15, 40, 0],
        columns: [
          { text: o.full && o.hash ? 'SHA-256: ' + o.hash.slice(0, 24) + '…' : SITE_NAME, fontSize: 7, color: '#64748b' },
          { text: 'Strona ' + currentPage + ' z ' + pageCount, alignment: 'right', fontSize: 7, color: '#64748b' }
        ]
      })
    };
    if (o.watermark) dd.watermark = { text: 'PODGLĄD', color: '#1f57c3', opacity: 0.08, bold: true };
    return dd;
  }

  let resultUrl = null;
  function invalidateResult() {
    const box = $('#pdf-result');
    if (box) box.hidden = true;
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
  }

  function pdfFileName(full) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(S.date) ? S.date : todayISO();
    return 'protokol-zdawczo-odbiorczy-' + date + (full ? '' : '-do-druku') + '.pdf';
  }

  function showResult(blob, full, hash) {
    invalidateResult();
    resultUrl = URL.createObjectURL(blob);
    const name = pdfFileName(full);
    const a = $('#pdf-download');
    a.href = resultUrl;
    a.download = name;
    $('#pdf-hash').textContent = hash || '— (wersja bez zdjęć i podpisów)';
    const shareBtn = $('#pdf-share');
    let file = null;
    try {
      file = new File([blob], name, { type: 'application/pdf' });
    } catch (e) {
      file = null;
    }
    const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    shareBtn.hidden = !canShare;
    shareBtn.onclick = canShare
      ? () => {
        navigator.share({ files: [file], title: 'Protokół zdawczo-odbiorczy' }).catch(() => {});
      }
      : null;
    $('#pdf-result').hidden = false;
    a.click();
  }

  let busy = false;
  async function generate(full) {
    if (busy) return;
    const { errors } = collectIssues(full);
    if (errors.length) {
      updateSummary();
      toast(errors[0], 'error');
      $('#generate-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (full && MODE === 'stripe' && !getUnlock()) {
      openPayDialog();
      return;
    }
    busy = true;
    $('#pdf-progress').hidden = false;
    $('#btn-pdf-full').disabled = true;
    $('#btn-pdf-basic').disabled = true;
    try {
      const pdfMake = await loadPdfMake();
      const doc = Core.hashableDocument(S, full ? sigsForDoc() : { giver: null, receiver: null });
      let hash = null;
      let seal = null;
      if (full) {
        hash = await Core.sha256Hex(Core.canonicalJson(doc));
        if (MODE === 'stripe') {
          const res = await requestSeal(hash);
          if (res.needPayment) {
            toast(res.message || 'Wymagana płatność.', 'error');
            openPayDialog();
            return;
          }
          if (res.error) {
            toast(res.error, 'error');
            return;
          }
          seal = res.seal;
        }
      }
      const generatedAt = new Date();
      const dd = buildDocDefinition(doc.protocol, doc.signatures, {
        full,
        hash,
        seal,
        generatedAt,
        watermark: !full && MODE === 'stripe'
      });
      const blob = await pdfMake.createPdf(dd).getBlob();
      if (full) lastGenerated = { hash, seal, rev };
      showResult(blob, full, hash);
    } catch (e) {
      toast('Nie udało się wygenerować PDF: ' + (e && e.message ? e.message : 'nieznany błąd'), 'error');
    } finally {
      busy = false;
      $('#pdf-progress').hidden = true;
      $('#btn-pdf-full').disabled = false;
      $('#btn-pdf-basic').disabled = false;
    }
  }

  // ------------------------------------------------------------------ płatności i pieczęć

  function getUnlock() {
    const raw = LS.get(UNLOCK_KEY);
    if (!raw) return null;
    try {
      const u = JSON.parse(raw);
      if (u && typeof u.sid === 'string' && SESSION_RE.test(u.sid) && typeof u.exp === 'number' && u.exp > Date.now()) return u;
    } catch (e) {
      /* uszkodzony wpis */
    }
    LS.del(UNLOCK_KEY);
    return null;
  }

  function setUnlock(sid, exp) {
    LS.set(UNLOCK_KEY, JSON.stringify({ sid, exp }));
  }

  // Płatność, której jeszcze nie potwierdzono (np. BLIK w trakcie) – sprawdzana ponownie po odświeżeniu strony.
  function getPending() {
    const raw = LS.get(PENDING_KEY);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      if (p && typeof p.sid === 'string' && SESSION_RE.test(p.sid) && typeof p.t === 'number' && Date.now() - p.t < 24 * 3600 * 1000) return p.sid;
    } catch (e) {
      /* uszkodzony wpis */
    }
    LS.del(PENDING_KEY);
    return null;
  }

  async function callSealApi(body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch('/api/pieczec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: ctrl.signal
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      return { status: res.status, data: data && typeof data === 'object' ? data : {} };
    } catch (e) {
      return { status: 0, data: {} };
    } finally {
      clearTimeout(timer);
    }
  }

  function serverMessage(data, fallback) {
    return typeof data.message === 'string' ? data.message.slice(0, 200) : fallback;
  }

  async function requestSeal(hash) {
    const u = getUnlock();
    if (!u) return { needPayment: true };
    const { status, data } = await callSealApi({ sid: u.sid, hash });
    if (status === 200 && data.ok === true && typeof data.token === 'string') {
      const parsed = Core.parseSealToken(data.token);
      if (!parsed || parsed.payload.h !== hash) return { error: 'Serwer zwrócił nieprawidłową pieczęć. Spróbuj ponownie.' };
      if (SEAL_KEY) {
        const v = await Core.verifySealToken(data.token, SEAL_KEY);
        if (!v.valid) return { error: 'Pieczęć nie przeszła weryfikacji. Napisz do nas: ' + (SUPPORT_EMAIL || 'kontakt ze stroną') + '.' };
      }
      if (typeof data.expiresAt === 'string' && !Number.isNaN(Date.parse(data.expiresAt))) setUnlock(u.sid, Date.parse(data.expiresAt));
      return { seal: { token: parsed.token, payload: parsed.payload } };
    }
    if (status === 402) {
      LS.del(UNLOCK_KEY);
      renderPaymentStatus();
      return { needPayment: true, message: serverMessage(data, 'Płatność nie została potwierdzona.') };
    }
    if (status === 0) return { error: 'Brak połączenia z internetem. Spróbuj ponownie.' };
    return { error: serverMessage(data, 'Nie udało się uzyskać pieczęci. Spróbuj ponownie za chwilę.') };
  }

  function renderPaymentStatus(message, kind) {
    const box = $('#payment-status');
    if (MODE !== 'stripe') {
      box.hidden = true;
      return;
    }
    const u = getUnlock();
    if (!message && !u) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.className = kind === 'error' ? 'notice-error' : kind === 'warn' ? 'notice-warn' : 'notice-ok';
    box.replaceChildren(h('p', { text: message || 'Pełna wersja jest aktywna na tym urządzeniu do ' + fmtTime(u.exp) + '.' }));
  }

  async function verifyPaymentReturn(sid) {
    renderPaymentStatus('Sprawdzam płatność…', 'warn');
    for (let attempt = 0; attempt < 4; attempt++) {
      const { status, data } = await callSealApi({ sid });
      if (status === 200 && data.ok === true) {
        const parsedExp = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
        const exp = Number.isFinite(parsedExp) ? parsedExp : Date.now() + 24 * 3600 * 1000;
        setUnlock(sid, exp);
        LS.del(PENDING_KEY);
        renderPaymentStatus('Płatność potwierdzona – dziękujemy! Pobierz pełny protokół poniżej. Dostęp jest aktywny na tym urządzeniu do ' + fmtTime(exp) + '.', 'ok');
        return;
      }
      if (status === 409 || status === 0 || status >= 500) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      LS.del(UNLOCK_KEY);
      LS.del(PENDING_KEY);
      renderPaymentStatus(serverMessage(data, 'Nie udało się potwierdzić płatności.') + (SUPPORT_EMAIL ? ' Jeśli pieniądze zostały pobrane, napisz na ' + SUPPORT_EMAIL + '.' : ''), 'error');
      return;
    }
    renderPaymentStatus('Płatność jest jeszcze przetwarzana. Odśwież stronę za minutę.' + (SUPPORT_EMAIL ? ' W razie problemu napisz na ' + SUPPORT_EMAIL + '.' : ''), 'warn');
  }

  function handlePaymentReturn() {
    const params = new URLSearchParams(location.search);
    if (!params.has('platnosc')) return null;
    const sid = params.get('platnosc') || '';
    params.delete('platnosc');
    const qs = params.toString();
    // Usuwamy identyfikator płatności z paska adresu (historia, udostępnianie linku, zrzuty ekranu).
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + '#protokol');
    if (MODE !== 'stripe') return null;
    if (!SESSION_RE.test(sid)) {
      renderPaymentStatus('Nieprawidłowy identyfikator płatności.', 'error');
      return null;
    }
    return sid;
  }

  function paymentUrl() {
    const u = safeHttpsUrl(CFG.payment && CFG.payment.stripePaymentLink, PAYMENT_HOSTS);
    return u ? u.toString() : null;
  }

  function openPayDialog() {
    const d = $('#pay-dialog');
    $('#pay-error').hidden = true;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }

  function closePayDialog() {
    const d = $('#pay-dialog');
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
  }

  async function startPayment() {
    const err = $('#pay-error');
    if (!$('#pay-terms').checked || !$('#pay-withdrawal').checked) {
      err.textContent = 'Zaznacz oba pola, aby przejść do płatności.';
      err.hidden = false;
      return;
    }
    const url = paymentUrl();
    if (!url) {
      err.textContent = 'Płatności są chwilowo niedostępne.' + (SUPPORT_EMAIL ? ' Napisz do nas: ' + SUPPORT_EMAIL : '');
      err.hidden = false;
      return;
    }
    try {
      await saveDraft(true);
    } catch (e) {
      if (!window.confirm('Nie udało się zapisać szkicu na tym urządzeniu. Po płatności dane formularza mogą zniknąć. Kontynuować?')) return;
    }
    location.assign(url);
  }

  // ------------------------------------------------------------------ plik danych (.json)

  async function exportJson() {
    const doc = Core.hashableDocument(S, sigsForDoc());
    const hash = await Core.sha256Hex(Core.canonicalJson(doc));
    const seal = lastGenerated && lastGenerated.hash === hash && lastGenerated.seal ? lastGenerated.seal.token : null;
    const out = {
      schema: Core.SCHEMA,
      app: SITE_URL,
      exportedAt: new Date().toISOString(),
      hash,
      seal,
      protocol: doc.protocol,
      signatures: doc.signatures
    };
    downloadBlob(new Blob([JSON.stringify(out)], { type: 'application/json' }), 'protokol-dane-' + (S.date || todayISO()) + '.json');
  }

  async function readJsonFile(file) {
    if (!file) throw new Error('Nie wybrano pliku.');
    if (file.size > MAX_JSON_BYTES) throw new Error('Plik jest za duży.');
    let obj;
    try {
      obj = JSON.parse(await file.text());
    } catch (e) {
      throw new Error('Plik nie jest prawidłowym plikiem JSON.');
    }
    if (!obj || typeof obj !== 'object' || obj.schema !== Core.SCHEMA) throw new Error('To nie jest plik danych protokołu z tej strony.');
    return obj;
  }

  async function importJson(file) {
    let obj;
    try {
      obj = await readJsonFile(file);
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    if ((S.address || S.giver.name || S.receiver.name) && !window.confirm('Wczytanie pliku zastąpi dane w formularzu. Kontynuować?')) return;
    S = Core.sanitizeProtocol(obj.protocol);
    rev++;
    // Podpisów nie wczytujemy z pliku – muszą zostać złożone ponownie na żywo (ochrona przed podrobieniem).
    SIG = { giver: null, receiver: null };
    applyStateToUi();
    scheduleSave();
    toast('Wczytano dane protokołu. Podpisy trzeba złożyć ponownie.', 'ok');
  }

  // ------------------------------------------------------------------ weryfikacja

  function resultBox(kind, title, lines) {
    return h('div', { class: (kind === 'ok' ? 'notice-ok' : kind === 'warn' ? 'notice-warn' : 'notice-error') + ' space-y-1' }, [
      h('p', { class: 'font-semibold', text: title }),
      ...(lines || []).map((l) => h('p', { class: 'break-all text-xs', text: l }))
    ]);
  }

  async function runVerify() {
    const out = $('#v-result');
    out.replaceChildren();
    let token = $('#v-token').value.trim();
    const file = $('#v-file').files && $('#v-file').files[0];
    let fileHash = null;
    if (file) {
      try {
        const obj = await readJsonFile(file);
        fileHash = await Core.documentHash(obj.protocol, obj.signatures);
        if (!token && typeof obj.seal === 'string') token = obj.seal;
      } catch (e) {
        out.append(resultBox('error', 'Nie można sprawdzić pliku', [e.message]));
        return;
      }
    }
    if (!token && !fileHash) {
      out.append(resultBox('warn', 'Wklej kod weryfikacyjny z protokołu lub wybierz plik danych (.json).'));
      return;
    }
    let seal = null;
    if (token) {
      if (!SEAL_KEY) {
        out.append(resultBox('warn', 'Weryfikacja pieczęci nie jest jeszcze skonfigurowana na tej stronie.'));
      } else {
        const v = await Core.verifySealToken(token, SEAL_KEY);
        if (v.valid) {
          seal = v.payload;
          const lines = [
            'Skrót SHA-256 dokumentu: ' + seal.h,
            'Czas opieczętowania (serwer): ' + fmtDateTime(seal.t),
            'ID pieczęci: ' + seal.n + ' · ref. płatności: ' + seal.p,
            'Porównaj skrót z wydrukowanym w protokole PDF (sekcja „Integralność dokumentu”).'
          ];
          out.append(resultBox(seal.l ? 'ok' : 'warn', seal.l ? 'Pieczęć jest prawidłowa – wydana przez ' + SITE_NAME + '.' : 'Pieczęć TESTOWA (wydana w trybie testowym płatności).', lines));
        } else {
          out.append(resultBox('error', 'Pieczęć jest NIEPRAWIDŁOWA.', ['Kod został zmieniony, jest niekompletny albo nie pochodzi z tej strony.']));
        }
      }
    }
    if (fileHash) {
      if (seal) {
        out.append(
          fileHash === seal.h
            ? resultBox('ok', 'Plik danych jest zgodny z pieczęcią – treść protokołu nie została zmieniona.', ['Skrót pliku: ' + fileHash])
            : resultBox('error', 'Plik danych NIE jest zgodny z pieczęcią – treść różni się od opieczętowanej.', ['Skrót pliku: ' + fileHash, 'Skrót w pieczęci: ' + seal.h])
        );
      } else {
        out.append(resultBox('warn', 'Obliczony skrót SHA-256 pliku danych:', [fileHash, 'Porównaj go ze skrótem wydrukowanym w protokole PDF.']));
      }
    }
  }

  // ------------------------------------------------------------------ kalkulator notarialny

  let lastNotary = null;

  function notaryInputs() {
    const market = ($('input[name="n-market"]:checked') || {}).value === 'pierwotny' ? 'pierwotny' : 'wtorny';
    return {
      value: $('#n-value').value,
      market,
      firstHomeExempt: $('#n-first-home').checked,
      group1: $('#n-group1').checked,
      pages: $('#n-pages').value,
      copies: $('#n-copies').value,
      mortgage: $('#n-mortgage').checked,
      newKw: $('#n-newkw').checked,
      kwApplication: $('#n-kwapp').checked
    };
  }

  function resultRows(target, rows) {
    target.replaceChildren(
      ...rows.map(([label, value, strong]) =>
        h('div', { class: 'result-row' + (strong ? ' border-slate-300 text-base' : '') }, [
          h('dt', { class: strong ? 'font-bold' : 'text-slate-600', text: label }),
          h('dd', { class: strong ? 'font-extrabold text-brand-800' : '', text: value })
        ])
      )
    );
  }

  const BRACKET_TEXT = [
    '100 zł (wartość do 3 000 zł)',
    '100 zł + 3% od nadwyżki ponad 3 000 zł',
    '310 zł + 2% od nadwyżki ponad 10 000 zł',
    '710 zł + 1% od nadwyżki ponad 30 000 zł',
    '1 010 zł + 0,4% od nadwyżki ponad 60 000 zł',
    '4 770 zł + 0,2% od nadwyżki ponad 1 000 000 zł',
    '6 770 zł + 0,25% od nadwyżki ponad 2 000 000 zł (limit 10 000 zł / 7 500 zł)'
  ];

  function renderNotary() {
    const inp = notaryInputs();
    $('#n-first-home-wrap').hidden = inp.market !== 'wtorny';
    $('#n-newkw-wrap').hidden = inp.market !== 'pierwotny';
    const value = Calc.parseAmount(inp.value);
    const out = $('#n-results');
    if (!Number.isFinite(value) || value <= 0) {
      lastNotary = null;
      $('#n-bracket-info').textContent = '';
      out.replaceChildren(h('p', { class: 'text-sm text-red-700', text: 'Wpisz cenę mieszkania, np. 500 000.' }));
      return;
    }
    const r = Calc.notaryCosts(inp);
    lastNotary = r;
    $('#n-bracket-info').textContent = 'Próg ' + r.bracket + ': ' + BRACKET_TEXT[r.bracket - 1] + '.';
    const F = Calc.formatPLN;
    const rows = [
      ['Taksa notarialna netto (maks.)', F(r.feeNet)],
      ['VAT 23% od taksy', F(r.feeVat)],
      ['Wypisy: ' + Math.max(0, Math.trunc(Number(inp.pages)) || 0) + ' str. × ' + Math.max(0, Math.trunc(Number(inp.copies)) || 0) + ' egz. × 6 zł + VAT', F(r.copiesGross)]
    ];
    if (r.kwAppNet) rows.push(['Wniosek wieczystoksięgowy (200 zł + VAT)', F(r.kwAppGross)]);
    rows.push(['Razem dla notariusza (brutto)', F(r.notaryGross)]);
    if (r.market === 'pierwotny') rows.push(['PCC', 'nie dotyczy (VAT w cenie)']);
    else if (r.pccExempt) rows.push(['PCC 2%', 'zwolnienie – 0,00 zł']);
    else rows.push(['PCC 2% (pobiera notariusz)', F(r.pcc)]);
    rows.push(['Opłata sądowa – wpis własności', F(r.courtOwnership)]);
    if (r.courtMortgage) rows.push(['Opłata sądowa – wpis hipoteki', F(r.courtMortgage)]);
    if (r.courtNewKw) rows.push(['Opłata sądowa – założenie księgi wieczystej', F(r.courtNewKw)]);
    rows.push(['Koszty transakcji razem', F(r.total), true]);
    rows.push(['Cena + koszty transakcji', F(r.totalWithPrice), true]);
    resultRows(out, rows);
  }

  // ------------------------------------------------------------------ kalkulator najmu

  function renderRental() {
    const r = Calc.rentalRoi({
      monthlyRent: $('#r-rent').value,
      months: $('#r-months').value,
      otherRevenue: $('#r-other').value,
      annualCosts: $('#r-costs').value,
      investment: $('#r-investment').value,
      married: ($('input[name="r-status"]:checked') || {}).value === 'married'
    });
    const F = Calc.formatPLN;
    const rows = [
      ['Przychód roczny (' + r.months + ' mies.)', F(r.revenue)],
      ['Ryczałt 8,5% (do ' + F(r.threshold) + ')', F(r.taxLow)]
    ];
    if (r.overThreshold) rows.push(['Ryczałt 12,5% (od nadwyżki)', F(r.taxHigh)]);
    rows.push(['Ryczałt rocznie (zaokr. do zł)', F(r.tax), true]);
    rows.push(['Średnio miesięcznie', F(r.monthlyTaxAvg)]);
    rows.push(['Efektywna stawka podatku', Calc.formatPct(r.effectiveRate)]);
    rows.push(['Koszty właściciela', F(r.costs)]);
    rows.push(['Dochód netto po podatku i kosztach', F(r.net), true]);
    rows.push(['Rentowność brutto', Calc.formatPct(r.grossYield)]);
    rows.push(['Rentowność netto (ROI)', Calc.formatPct(r.netYield), true]);
    rows.push(['Zwrot inwestycji', r.paybackYears ? r.paybackYears.toLocaleString('pl-PL', { maximumFractionDigits: 1 }) + ' lat' : '—']);
    resultRows($('#r-results'), rows);
  }

  // ------------------------------------------------------------------ leady

  function renderPartners() {
    const list = Array.isArray(CFG.leads && CFG.leads.partners) ? CFG.leads.partners.slice(0, 12) : [];
    const box = $('#partners-list');
    const cards = [];
    for (const p of list) {
      if (!p || typeof p.name !== 'string' || !p.name.trim()) continue;
      const url = safeHttpsUrl(p.url);
      const phone = typeof p.phone === 'string' && PHONE_RE.test(p.phone) ? p.phone : '';
      const links = [];
      if (phone) links.push(h('a', { class: 'btn-primary min-h-[40px] text-xs', href: 'tel:' + phone.replace(/[^+0-9]/g, ''), text: 'Zadzwoń ' + phone }));
      if (url) links.push(h('a', { class: 'btn-secondary min-h-[40px] text-xs', href: url.toString(), target: '_blank', rel: 'noopener noreferrer sponsored', text: 'Strona www' }));
      cards.push(
        h('div', { class: 'space-y-2 rounded-xl border border-slate-200 p-3' }, [
          typeof p.kind === 'string' ? h('span', { class: 'badge', text: p.kind.slice(0, 40) }) : null,
          h('p', { class: 'font-semibold', text: p.name.slice(0, 80) }),
          typeof p.area === 'string' ? h('p', { class: 'text-sm text-slate-600', text: p.area.slice(0, 80) }) : null,
          h('div', { class: 'flex flex-wrap gap-2' }, links)
        ])
      );
    }
    box.replaceChildren(...cards);
    box.hidden = cards.length === 0;
  }

  function submitLead(e) {
    e.preventDefault();
    const err = $('#lead-error');
    const fallback = $('#lead-fallback');
    err.hidden = true;
    fallback.hidden = true;
    const to = CFG.leads && typeof CFG.leads.email === 'string' && EMAIL_RE.test(CFG.leads.email) ? CFG.leads.email : SUPPORT_EMAIL;
    const name = $('#lead-name').value.trim().replace(/[\r\n]+/g, ' ');
    const phone = $('#lead-phone').value.trim();
    const email = $('#lead-email').value.trim();
    const msg = $('#lead-msg').value.trim();
    const needs = $$('input[name="lead-need"]:checked').map((x) => x.value);
    const fail = (t) => {
      err.textContent = t;
      err.hidden = false;
    };
    if (!to) return fail('Formularz jest chwilowo niedostępny.');
    if (name.length < 2) return fail('Podaj imię.');
    if (!PHONE_RE.test(phone)) return fail('Podaj prawidłowy numer telefonu.');
    if (email && !EMAIL_RE.test(email)) return fail('Podaj prawidłowy adres e-mail albo zostaw pole puste.');
    if (!$('#lead-consent').checked) return fail('Zaznacz zgodę na przekazanie danych, abyśmy mogli przekazać zapytanie.');
    const city = CFG.leads && typeof CFG.leads.city === 'string' ? CFG.leads.city.slice(0, 40) : '';
    const subject = 'Zapytanie: ' + (needs.join(', ') || 'notariusz / kredyt') + (city ? ' – ' + city : '');
    const notaryLine = lastNotary ? 'Wartość nieruchomości z kalkulatora: ' + Calc.formatPLN(lastNotary.valueGr) : '';
    const body = [
      'Imię: ' + name,
      'Telefon: ' + phone,
      email ? 'E-mail: ' + email : '',
      'Potrzeby: ' + (needs.join(', ') || '—'),
      notaryLine,
      msg ? 'Wiadomość: ' + msg : '',
      '',
      'Zgoda: wyrażam zgodę na przekazanie moich danych kontaktowych współpracującej kancelarii notarialnej lub doradcy kredytowemu w celu kontaktu w sprawie zapytania.',
      'Data zgody: ' + fmtDateTime(new Date()),
      'Źródło: ' + SITE_URL
    ].filter((l) => l !== '').join('\n');
    const href = 'mailto:' + to + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    window.location.href = href;
    fallback.replaceChildren('Jeśli program pocztowy się nie otworzył, wyślij wiadomość na adres ', h('strong', { text: to }), '.');
    fallback.hidden = false;
  }

  // ------------------------------------------------------------------ nawigacja

  const VIEWS = ['protokol', 'notariusz', 'najem', 'weryfikacja'];
  let currentView = 'protokol';

  function route() {
    let hash = location.hash.slice(1);
    let autoVerify = false;
    if (hash.startsWith('weryfikuj=')) {
      let token = '';
      try {
        token = decodeURIComponent(hash.slice('weryfikuj='.length));
      } catch (e) {
        token = '';
      }
      $('#v-token').value = token.slice(0, 2000);
      history.replaceState(null, '', location.pathname + location.search + '#weryfikacja');
      hash = 'weryfikacja';
      autoVerify = true;
    }
    const isView = VIEWS.includes(hash);
    if (isView) currentView = hash;
    else if (hash !== 'faq') currentView = 'protokol';
    for (const el of $$('[data-view]')) el.hidden = el.dataset.view !== currentView;
    for (const el of $$('[data-views]')) el.hidden = !el.dataset.views.split(' ').includes(currentView);
    for (const a of $$('[data-tab]')) {
      if (a.dataset.tab === (hash === 'faq' ? 'faq' : currentView)) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    if (hash === 'faq') $('#faq').scrollIntoView({ block: 'start' });
    else if (isView && currentView !== 'protokol') window.scrollTo(0, 0);
    if (autoVerify) runVerify();
  }

  // ------------------------------------------------------------------ start

  async function init() {
    $('#year').textContent = String(new Date().getFullYear());
    for (const el of $$('[data-mode]')) el.hidden = el.dataset.mode !== MODE;
    for (const el of $$('[data-price]')) el.textContent = PRICE_LABEL;
    for (const el of $$('[data-lead-city]')) if (CFG.leads && typeof CFG.leads.city === 'string') el.textContent = CFG.leads.city.slice(0, 40);
    const contact = $('#footer-contact');
    if (SUPPORT_EMAIL) contact.href = 'mailto:' + SUPPORT_EMAIL;
    else contact.hidden = true;
    const donate = safeHttpsUrl(CFG.payment && CFG.payment.donateUrl);
    if (donate) {
      $('#footer-donate').href = donate.toString();
      $('#footer-donate').hidden = false;
    }

    const autosavePref = LS.get(AUTOSAVE_KEY);
    $('#autosave-toggle').checked = autosavePref !== '0';
    $('#autosave-toggle').addEventListener('change', (e) => {
      LS.set(AUTOSAVE_KEY, e.target.checked ? '1' : '0');
      if (e.target.checked) saveDraft(false).catch(() => {});
      else IDB.del(DRAFT_KEY).catch(() => {});
    });

    pads = {
      giver: new SignaturePad($('#sig-giver'), () => onSignatureEnd('giver')),
      receiver: new SignaturePad($('#sig-receiver'), () => onSignatureEnd('receiver'))
    };
    for (const btn of $$('[data-clear-sig]')) {
      btn.addEventListener('click', () => {
        const who = btn.dataset.clearSig === 'receiver' ? 'receiver' : 'giver';
        pads[who].clear();
        SIG[who] = null;
        invalidateResult();
        updateSigStatus();
        scheduleSave();
        scheduleSummary();
      });
    }

    const form = $('#protocol-form');
    form.addEventListener('input', onBoundInput);
    form.addEventListener('change', (e) => {
      if (e.target && e.target.type === 'radio') onBoundInput(e);
    });
    form.addEventListener('submit', (e) => e.preventDefault());

    $('#add-meter-btn').addEventListener('click', () => {
      if (S.meters.length >= Core.LIMITS.meters) {
        toast('Maksymalnie ' + Core.LIMITS.meters + ' liczników.', 'error');
        return;
      }
      const kind = $('#add-meter-kind').value;
      S.meters.push(newMeter(Object.prototype.hasOwnProperty.call(Core.METER_KINDS, kind) ? kind : 'inny'));
      touch();
      renderMeters();
    });
    $('#add-room-btn').addEventListener('click', () => {
      if (S.rooms.length >= Core.LIMITS.rooms) {
        toast('Maksymalnie ' + Core.LIMITS.rooms + ' pomieszczeń.', 'error');
        return;
      }
      const input = $('#add-room-name');
      S.rooms.push({ name: input.value.trim().slice(0, 60) || 'Pomieszczenie', items: [newItem('Ściany i podłogi')] });
      input.value = '';
      touch();
      renderRooms();
    });

    $('#btn-pdf-full').addEventListener('click', () => generate(true));
    $('#btn-pdf-basic').addEventListener('click', () => generate(false));
    $('#btn-export-json').addEventListener('click', () => exportJson().catch((e) => toast(e.message, 'error')));
    $('#import-json').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) importJson(f);
    });
    $('#btn-clear-all').addEventListener('click', async () => {
      if (!window.confirm('Usunąć wszystkie dane protokołu, zdjęcia i podpisy z tego urządzenia? Tej operacji nie można cofnąć.')) return;
      await IDB.del(DRAFT_KEY).catch(() => {});
      S = defaultState();
      SIG = { giver: null, receiver: null };
      rev++;
      lastGenerated = null;
      applyStateToUi();
      toast('Dane zostały usunięte z tego urządzenia.', 'ok');
    });

    $('#pay-go').addEventListener('click', () => startPayment());
    $('#pay-cancel').addEventListener('click', () => closePayDialog());

    $('#notary-form').addEventListener('input', renderNotary);
    $('#notary-form').addEventListener('change', renderNotary);
    $('#notary-form').addEventListener('submit', (e) => e.preventDefault());
    $('#rental-form').addEventListener('input', renderRental);
    $('#rental-form').addEventListener('change', renderRental);
    $('#rental-form').addEventListener('submit', (e) => e.preventDefault());
    $('#r-use-notary').addEventListener('click', () => {
      if (!lastNotary) {
        toast('Najpierw wpisz cenę w kalkulatorze taksy notarialnej.', 'error');
        return;
      }
      $('#r-investment').value = (lastNotary.totalWithPrice / 100).toLocaleString('pl-PL', { maximumFractionDigits: 2 });
      renderRental();
      toast('Wstawiono cenę wraz z kosztami transakcji.', 'ok');
    });
    $('#lead-form').addEventListener('submit', submitLead);
    $('#verify-form').addEventListener('submit', (e) => {
      e.preventDefault();
      runVerify();
    });

    window.addEventListener('hashchange', route);

    // Wstępne wczytanie modułu PDF, gdy użytkownik dochodzi do podpisów.
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting)) {
          io.disconnect();
          loadPdfMake().catch(() => {});
        }
      });
      io.observe($('#signatures-card'));
    }

    const returnedSid = handlePaymentReturn();
    const paidSid = MODE === 'stripe' ? returnedSid || (getUnlock() ? null : getPending()) : null;
    let restored = false;
    try {
      restored = await restoreDraft();
    } catch (e) {
      restored = false;
    }
    applyStateToUi();
    renderNotary();
    renderRental();
    renderPartners();
    route();
    if (restored) toast('Przywrócono szkic zapisany ' + fmtDateTime(restored) + '.', 'ok');
    if (paidSid) {
      LS.set(PENDING_KEY, JSON.stringify({ sid: paidSid, t: Date.now() }));
      $('#generate-card').scrollIntoView({ block: 'start' });
      verifyPaymentReturn(paidSid);
    } else {
      renderPaymentStatus();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
