/*
 * Kalkulatory: taksa notarialna, PCC, opłaty sądowe KW, ryczałt od najmu prywatnego, rentowność.
 * Wszystkie kwoty liczone w groszach (liczby całkowite), aby uniknąć błędów zaokrągleń.
 * Plik działa w przeglądarce (window.Calc) i w Node (testy).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // § 3 rozporządzenia MS z 28.06.2004 r. w sprawie maksymalnych stawek taksy notarialnej.
  // bp = punkty bazowe (1% = 100 bp) od nadwyżki ponad "floor".
  const NOTARY_BRACKETS = Object.freeze([
    { upTo: 3000, base: 100, floor: 0, bp: 0 },
    { upTo: 10000, base: 100, floor: 3000, bp: 300 },
    { upTo: 30000, base: 310, floor: 10000, bp: 200 },
    { upTo: 60000, base: 710, floor: 30000, bp: 100 },
    { upTo: 1000000, base: 1010, floor: 60000, bp: 40 },
    { upTo: 2000000, base: 4770, floor: 1000000, bp: 20 },
    { upTo: Infinity, base: 6770, floor: 2000000, bp: 25 }
  ]);

  const VAT_PERCENT = 23;
  const NOTARY_CAP_GR = 1000000; // 10 000 zł
  const NOTARY_CAP_GROUP1_GR = 750000; // 7 500 zł (I grupa podatkowa)
  const COPY_PAGE_NET_GR = 600; // 6 zł netto za każdą rozpoczętą stronę wypisu
  const PCC_BP = 200; // 2% (art. 7 ust. 1 pkt 1 lit. a ustawy o PCC)
  const COURT_OWNERSHIP_GR = 20000; // 200 zł – wpis własności (art. 42 u.k.s.c.)
  const COURT_MORTGAGE_GR = 20000; // 200 zł – wpis hipoteki
  const COURT_NEW_KW_GR = 10000; // 100 zł – założenie księgi wieczystej
  const KW_APPLICATION_NET_GR = 20000; // 200 zł netto – wniosek wieczystoksięgowy (§ 16 rozporządzenia, stawka maksymalna)

  const MAX_VALUE_GR = 100000000000; // 1 mld zł – ochrona przed absurdalnymi danymi

  function toGrosze(value) {
    const n = typeof value === 'number' ? value : parseAmount(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.round(n * 100), MAX_VALUE_GR);
  }

  // Akceptuje polski zapis: "1 234 567,89", "1.234.567,89", "450.000", "1234,5", "1234.5".
  function parseAmount(input) {
    if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
    if (typeof input !== 'string') return NaN;
    let s = input.trim().replace(/[\s  ]/g, '').replace(/(zł|zl|pln)$/i, '');
    if (!/^\d[\d.,]*$/.test(s)) return NaN;
    const hasComma = s.includes(',');
    const hasDot = s.includes('.');
    if (hasComma && hasDot) {
      const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
      s = s.split(dec === ',' ? '.' : ',').join('');
      if (s.split(dec).length > 2) return NaN;
      s = s.replace(dec, '.');
    } else if (hasComma) {
      const parts = s.split(',');
      s = parts.length === 2 ? parts[0] + '.' + parts[1] : parts.join('');
    } else if (hasDot) {
      const parts = s.split('.');
      // "450.000" lub "1.234.567" = separator tysięcy; "1234.5" = ułamek
      if (parts.length > 2 || parts[1].length === 3) s = parts.join('');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function pctOf(gr, bp) {
    return Math.round((gr * bp) / 10000);
  }

  function vatOf(netGr) {
    return Math.round((netGr * VAT_PERCENT) / 100);
  }

  // Zaokrąglenie do pełnych złotych (art. 63 § 1 Ordynacji podatkowej): < 50 gr w dół, >= 50 gr w górę.
  function roundToZloty(gr) {
    return Math.round(gr / 100) * 100;
  }

  /**
   * Maksymalna taksa notarialna netto (w groszach) wg § 3.
   * @param {number} valueGr wartość przedmiotu czynności w groszach
   * @param {boolean} group1 czynność między osobami z I grupy podatkowej
   */
  function notaryFeeGr(valueGr, group1) {
    const v = Math.max(0, Math.min(Math.round(valueGr) || 0, MAX_VALUE_GR));
    const b = NOTARY_BRACKETS.find((br) => v <= br.upTo * 100);
    let fee = b.base * 100 + pctOf(v - b.floor * 100, b.bp);
    if (b.upTo === Infinity) {
      fee = Math.min(fee, group1 ? NOTARY_CAP_GROUP1_GR : NOTARY_CAP_GR);
    }
    return fee;
  }

  function bracketIndex(valueGr) {
    const v = Math.max(0, Math.round(valueGr) || 0);
    return NOTARY_BRACKETS.findIndex((br) => v <= br.upTo * 100);
  }

  function clampInt(n, min, max) {
    const x = Math.trunc(Number(n));
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
  }

  /**
   * Pełne koszty transakcji u notariusza.
   * @param {object} p
   * @param {number|string} p.value wartość rynkowa (zł)
   * @param {'wtorny'|'pierwotny'} p.market
   * @param {boolean} p.firstHomeExempt zwolnienie z PCC – art. 9 pkt 17 ustawy o PCC
   * @param {boolean} p.group1 I grupa podatkowa (limit taksy 7 500 zł)
   * @param {number} p.pages liczba stron aktu
   * @param {number} p.copies liczba wypisów
   * @param {boolean} p.mortgage kredyt hipoteczny (wpis hipoteki)
   * @param {boolean} p.newKw założenie nowej księgi wieczystej (rynek pierwotny)
   * @param {boolean} p.kwApplication notariusz sporządza wniosek wieczystoksięgowy
   */
  function notaryCosts(p) {
    const valueGr = toGrosze(p.value);
    const market = p.market === 'pierwotny' ? 'pierwotny' : 'wtorny';
    const pages = clampInt(p.pages, 0, 500);
    const copies = clampInt(p.copies, 0, 50);

    const feeNet = notaryFeeGr(valueGr, !!p.group1);
    const feeVat = vatOf(feeNet);

    const copiesNet = pages * copies * COPY_PAGE_NET_GR;
    const copiesVat = vatOf(copiesNet);

    const kwAppNet = p.kwApplication === false ? 0 : KW_APPLICATION_NET_GR;
    const kwAppVat = vatOf(kwAppNet);

    let pcc = 0;
    let pccExempt = false;
    if (market === 'wtorny') {
      if (p.firstHomeExempt) {
        pccExempt = true;
      } else {
        pcc = roundToZloty(pctOf(roundToZloty(valueGr), PCC_BP));
      }
    }

    const courtOwnership = COURT_OWNERSHIP_GR;
    const courtMortgage = p.mortgage ? COURT_MORTGAGE_GR : 0;
    const courtNewKw = market === 'pierwotny' && p.newKw ? COURT_NEW_KW_GR : 0;
    const courtTotal = courtOwnership + courtMortgage + courtNewKw;

    const notaryGross = feeNet + feeVat + copiesNet + copiesVat + kwAppNet + kwAppVat;
    const total = notaryGross + pcc + courtTotal;

    return {
      valueGr,
      market,
      bracket: bracketIndex(valueGr) + 1,
      feeNet,
      feeVat,
      feeGross: feeNet + feeVat,
      copiesNet,
      copiesVat,
      copiesGross: copiesNet + copiesVat,
      kwAppNet,
      kwAppVat,
      kwAppGross: kwAppNet + kwAppVat,
      pcc,
      pccExempt,
      courtOwnership,
      courtMortgage,
      courtNewKw,
      courtTotal,
      notaryGross,
      total,
      totalWithPrice: total + valueGr
    };
  }

  const RENT_RATE_LOW_BP = 850; // 8,5%
  const RENT_RATE_HIGH_BP = 1250; // 12,5%
  const RENT_THRESHOLD_SINGLE_GR = 10000000; // 100 000 zł
  const RENT_THRESHOLD_MARRIED_GR = 20000000; // 200 000 zł (małżonkowie – łącznie)

  function rentalTaxGr(annualRevenueGr, married) {
    const rev = Math.max(0, Math.round(annualRevenueGr) || 0);
    const thr = married ? RENT_THRESHOLD_MARRIED_GR : RENT_THRESHOLD_SINGLE_GR;
    const low = Math.min(rev, thr);
    const high = Math.max(0, rev - thr);
    return {
      threshold: thr,
      low,
      high,
      taxLow: pctOf(low, RENT_RATE_LOW_BP),
      taxHigh: pctOf(high, RENT_RATE_HIGH_BP),
      tax: roundToZloty(pctOf(low, RENT_RATE_LOW_BP) + pctOf(high, RENT_RATE_HIGH_BP))
    };
  }

  /**
   * Rentowność najmu.
   * @param {object} p
   * @param {number|string} p.monthlyRent miesięczny czynsz najmu (zł)
   * @param {number} p.months liczba miesięcy wynajmu w roku (0–12)
   * @param {number|string} p.otherRevenue inne roczne przychody z najmu (zł), np. miejsce postojowe
   * @param {number|string} p.annualCosts roczne koszty właściciela (zł): czynsz do wspólnoty, ubezpieczenie, podatek od nieruchomości, naprawy
   * @param {number|string} p.investment całkowity koszt zakupu (cena + koszty transakcyjne + remont) (zł)
   * @param {boolean} p.married małżonkowie – łączny próg 200 000 zł
   */
  function rentalRoi(p) {
    const months = clampInt(p.months, 0, 12);
    const monthlyGr = toGrosze(p.monthlyRent);
    const revenue = Math.min(monthlyGr * months + toGrosze(p.otherRevenue), MAX_VALUE_GR);
    const tax = rentalTaxGr(revenue, !!p.married);
    const costs = toGrosze(p.annualCosts);
    const investment = toGrosze(p.investment);
    const net = revenue - tax.tax - costs;
    const grossYield = investment > 0 ? (revenue / investment) * 100 : null;
    const netYield = investment > 0 ? (net / investment) * 100 : null;
    const paybackYears = net > 0 && investment > 0 ? investment / net : null;
    return {
      months,
      revenue,
      tax: tax.tax,
      taxLow: tax.taxLow,
      taxHigh: tax.taxHigh,
      threshold: tax.threshold,
      overThreshold: tax.high > 0,
      effectiveRate: revenue > 0 ? (tax.tax / revenue) * 100 : 0,
      monthlyTaxAvg: months > 0 ? Math.round(tax.tax / months) : 0,
      costs,
      net,
      investment,
      grossYield,
      netYield,
      paybackYears
    };
  }

  function formatPLN(gr) {
    const n = (Math.round(gr) || 0) / 100;
    return n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' zł';
  }

  function formatPct(x, digits) {
    if (x === null || !Number.isFinite(x)) return '—';
    return x.toLocaleString('pl-PL', { minimumFractionDigits: digits ?? 2, maximumFractionDigits: digits ?? 2 }) + '%';
  }

  return Object.freeze({
    NOTARY_BRACKETS,
    parseAmount,
    toGrosze,
    notaryFeeGr,
    notaryCosts,
    rentalTaxGr,
    rentalRoi,
    formatPLN,
    formatPct,
    roundToZloty
  });
});
