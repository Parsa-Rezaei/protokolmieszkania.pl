import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUmd } from './helpers.mjs';

const Calc = loadUmd('public/assets/calc.js');
const zl = (n) => Math.round(n * 100);

test('parseAmount: polskie formaty liczb', () => {
  assert.equal(Calc.parseAmount('500 000'), 500000);
  assert.equal(Calc.parseAmount('500 000,50'), 500000.5);
  assert.equal(Calc.parseAmount('1.234.567,89'), 1234567.89);
  assert.equal(Calc.parseAmount('450.000'), 450000);
  assert.equal(Calc.parseAmount('1234.5'), 1234.5);
  assert.equal(Calc.parseAmount('1234,5'), 1234.5);
  assert.equal(Calc.parseAmount('3000 zł'), 3000);
  assert.ok(Number.isNaN(Calc.parseAmount('-5')));
  assert.ok(Number.isNaN(Calc.parseAmount('abc')));
  assert.ok(Number.isNaN(Calc.parseAmount('')));
});

test('taksa notarialna: wszystkie progi § 3 i ich granice', () => {
  const fee = (v, g1) => Calc.notaryFeeGr(zl(v), g1) / 100;
  assert.equal(fee(0), 100);
  assert.equal(fee(3000), 100);
  assert.equal(fee(3001), 100.03);
  assert.equal(fee(10000), 310);
  assert.equal(fee(10001), 310.02);
  assert.equal(fee(30000), 710);
  assert.equal(fee(60000), 1010);
  assert.equal(fee(500000), 2770);
  assert.equal(fee(1000000), 4770);
  assert.equal(fee(1500000), 5770);
  assert.equal(fee(2000000), 6770);
  assert.equal(fee(2200000), 7270);
  // limit 7 500 zł dla I grupy osiągany przy 2 292 000 zł
  assert.equal(fee(2292000, true), 7500);
  assert.equal(fee(2500000, true), 7500);
  assert.equal(fee(2500000, false), 8020);
  // limit 10 000 zł osiągany przy 3 292 000 zł
  assert.equal(fee(3292000), 10000);
  assert.equal(fee(9000000), 10000);
});

test('ciągłość skali – brak skoków na granicach progów', () => {
  for (const b of [3000, 10000, 30000, 60000, 1000000, 2000000]) {
    const a = Calc.notaryFeeGr(zl(b));
    const c = Calc.notaryFeeGr(zl(b) + 100);
    assert.ok(c >= a && c - a <= 3, `granica ${b}: ${a} -> ${c}`);
  }
});

test('koszty transakcji – rynek wtórny, kredyt, 500 000 zł', () => {
  const r = Calc.notaryCosts({ value: '500 000', market: 'wtorny', pages: 10, copies: 4, mortgage: true, kwApplication: true });
  assert.equal(r.feeNet, zl(2770));
  assert.equal(r.feeVat, zl(637.1));
  assert.equal(r.copiesNet, zl(240));
  assert.equal(r.copiesVat, zl(55.2));
  assert.equal(r.kwAppGross, zl(246));
  assert.equal(r.pcc, zl(10000));
  assert.equal(r.courtTotal, zl(400));
  assert.equal(r.total, zl(2770 + 637.1 + 240 + 55.2 + 246 + 10000 + 400));
  assert.equal(r.totalWithPrice, r.total + zl(500000));
});

test('PCC: zwolnienie pierwszego mieszkania i rynek pierwotny', () => {
  const ex = Calc.notaryCosts({ value: 400000, market: 'wtorny', firstHomeExempt: true, pages: 0, copies: 0 });
  assert.equal(ex.pcc, 0);
  assert.equal(ex.pccExempt, true);
  const prim = Calc.notaryCosts({ value: 400000, market: 'pierwotny', firstHomeExempt: true, newKw: true, pages: 0, copies: 0 });
  assert.equal(prim.pcc, 0);
  assert.equal(prim.pccExempt, false);
  assert.equal(prim.courtNewKw, zl(100));
  const wt = Calc.notaryCosts({ value: 400000, market: 'wtorny', newKw: true, pages: 0, copies: 0 });
  assert.equal(wt.courtNewKw, 0, 'założenie KW tylko na rynku pierwotnym');
});

test('PCC: zaokrąglenie do pełnych złotych (art. 63 Ordynacji)', () => {
  assert.equal(Calc.notaryCosts({ value: '123 456,78', market: 'wtorny' }).pcc, zl(2469));
  assert.equal(Calc.notaryCosts({ value: '100 024,49', market: 'wtorny' }).pcc, zl(2000)); // podstawa 100 024 zł -> 2 000,48 zł -> 2 000 zł
  assert.equal(Calc.notaryCosts({ value: '100 024,99', market: 'wtorny' }).pcc, zl(2001)); // podstawa 100 025 zł -> 2 000,50 zł -> 2 001 zł
  assert.equal(Calc.notaryCosts({ value: '100 025', market: 'wtorny' }).pcc, zl(2001));
});

test('ryczałt od najmu: 8,5% / 12,5% i próg małżonków', () => {
  assert.equal(Calc.rentalTaxGr(zl(36000), false).tax, zl(3060));
  assert.equal(Calc.rentalTaxGr(zl(100000), false).tax, zl(8500));
  assert.equal(Calc.rentalTaxGr(zl(150000), false).tax, zl(8500 + 6250));
  assert.equal(Calc.rentalTaxGr(zl(150000), true).tax, zl(12750));
  assert.equal(Calc.rentalTaxGr(zl(250000), true).tax, zl(17000 + 6250));
});

test('rentowność najmu', () => {
  const r = Calc.rentalRoi({ monthlyRent: '3 000', months: 11, otherRevenue: 0, annualCosts: '4 800', investment: '520 000', married: false });
  assert.equal(r.revenue, zl(33000));
  assert.equal(r.tax, zl(2805));
  assert.equal(r.net, zl(33000 - 2805 - 4800));
  assert.ok(Math.abs(r.grossYield - (33000 / 520000) * 100) < 1e-9);
  assert.ok(Math.abs(r.netYield - ((33000 - 2805 - 4800) / 520000) * 100) < 1e-9);
  const zero = Calc.rentalRoi({ monthlyRent: '', months: 99, investment: 0 });
  assert.equal(zero.months, 12);
  assert.equal(zero.grossYield, null);
});
