/* V1.4 批发曲线管理自测：展开/覆盖/停用恢复/超覆盖/默认假设/两部制报价
 * 覆盖设计文档第 8 节验收用例 A1–A8。
 * 运行：node test/v14-test.js
 */
'use strict';
const path = require('path');
const Calc = require(path.join(__dirname, '..', 'js', 'calc.js'));
const Validator = require(path.join(__dirname, '..', 'js', 'validate.js'));
const PARAMS = require(path.join(__dirname, '..', 'js', 'data.js'));

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failed++; console.log('  FAIL  ' + n + (x ? ' => ' + x : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

const keys = Validator.expectedHourKeys(2026);
const N = keys.length;
const gUni = new Array(N).fill(1 / N);        // 均匀统调比例，便于手算
const qUni = new Array(N).fill(1);            // 每小时 1 MWh，Q=8760

function mkCurve(id, createdAt, granularity, entries, extra) {
  return {
    id, name: id, status: 'locked', enabled: true, createdAt, updatedAt: createdAt, year: 2026,
    window: { from: '01-01', to: '12-31' }, granularity,
    quantityMode: 'mwh', priceMode: 'flat', entries, note: '', ...(extra || {})
  };
}
const monthEntries = (mwh, price) => Array.from({ length: 12 }, (_, m) => ({ timeKey: String(m + 1).padStart(2, '0'), quantityMwh: mwh, priceYuanPerMwh: price }));
const dayEntries = (month, days, mwh, price) => Array.from({ length: days }, (_, d) => ({ timeKey: '2026-' + String(month).padStart(2, '0') + '-' + String(d + 1).padStart(2, '0'), quantityMwh: mwh, priceYuanPerMwh: price }));
const hourEntries = (date, mwh, price) => Array.from({ length: 24 }, (_, h) => ({ timeKey: date + '|' + String(h).padStart(2, '0'), quantityMwh: mwh, priceYuanPerMwh: price }));

/* ---------- A1 全年年分月曲线 ---------- */
console.log('\n[A1] 新增全年年分月曲线');
const cA1 = mkCurve('year-base', '2026-01-01T09:00', 'year_month', monthEntries(100, 300));
let proc = Calc.buildProcurement([cA1], qUni, keys, gUni, {});
ok('总采购=1200 MWh', near(proc.totalPurchase, 1200));
ok('逐月总量守恒（1月=100）', near(proc.purchase.reduce((a, v, t) => a + (keys[t].slice(5, 7) === '01' ? v : 0), 0), 100));
ok('加权均价=300', near(proc.weightedPrice, 300));
ok('覆盖率=1200/8760', near(proc.coverage, 1200 / 8760));
ok('无覆盖日志（无冲突）', proc.logs.length === 0);

/* ---------- A2 7月月分日曲线替换7月 ---------- */
console.log('\n[A2] 7月月分日曲线（31天×10MWh@400）');
const cA2 = mkCurve('jul-fix', '2026-06-01T09:00', 'month_day', dayEntries(7, 31, 10, 400), { window: { from: '07-01', to: '07-31' } });
proc = Calc.buildProcurement([cA1, cA2], qUni, keys, gUni, {});
const julPurchase = proc.purchase.reduce((a, v, t) => a + (keys[t].slice(5, 7) === '07' ? v : 0), 0);
ok('7月总量=310（被月分日替换）', near(julPurchase, 310));
ok('1月仍=100（其他月保留年分月）', near(proc.purchase.reduce((a, v, t) => a + (keys[t].slice(5, 7) === '01' ? v : 0), 0), 100));
ok('7月价格=400', near(proc.price[keys.indexOf('2026-07-10|10')], 400));
ok('产生覆盖日志', proc.logs.length === 1 && proc.logs[0].replacedHours === 31 * 24);

/* ---------- A3 7月15日日分时曲线 ---------- */
console.log('\n[A3] 7月15日日分时曲线（24h×1MWh@500）');
const cA3 = mkCurve('jul15-fix', '2026-07-10T09:00', 'day_hour', hourEntries('2026-07-15', 1, 500));
proc = Calc.buildProcurement([cA1, cA2, cA3], qUni, keys, gUni, {});
ok('7月15日总量=24（日分时替换）', near(proc.purchase.reduce((a, v, t) => a + (keys[t].slice(0, 10) === '2026-07-15' ? v : 0), 0), 24));
ok('7月15日价格=500', near(proc.price[keys.indexOf('2026-07-15|08')], 500));
ok('7月14日保留月分日（10 MWh@400）', near(proc.purchase.reduce((a, v, t) => a + (keys[t].slice(0, 10) === '2026-07-14' ? v : 0), 0), 10) && near(proc.price[keys.indexOf('2026-07-14|08')], 400));

/* ---------- A4 同粒度同小时，后录入覆盖 ---------- */
console.log('\n[A4] 同粒度同小时，后录入覆盖');
const cA4 = mkCurve('jul15-fix-v2', '2026-07-12T09:00', 'day_hour', hourEntries('2026-07-15', 2, 600));
proc = Calc.buildProcurement([cA1, cA2, cA3, cA4], qUni, keys, gUni, {});
ok('A4 覆盖 A3：7月15日=24×2MWh@600', near(proc.purchase[keys.indexOf('2026-07-15|08')], 2) && near(proc.price[keys.indexOf('2026-07-15|08')], 600));

/* ---------- A5 粗粒度晚录入不覆盖细粒度 ---------- */
console.log('\n[A5] 晚录入的年分月不覆盖日分时');
const cA5 = mkCurve('year-base-v2', '2026-08-01T09:00', 'year_month', monthEntries(50, 280));
proc = Calc.buildProcurement([cA1, cA2, cA3, cA4, cA5], qUni, keys, gUni, {});
ok('7月15日仍=2@600（日分时保留）', near(proc.price[keys.indexOf('2026-07-15|08')], 600));
ok('1月被新年分月覆盖=50@280', near(proc.purchase.reduce((a, v, t) => a + (keys[t].slice(5, 7) === '01' ? v : 0), 0), 50));

/* ---------- A6 停用恢复 ---------- */
console.log('\n[A6] 停用 A4 → 恢复 A3');
const cA4off = { ...cA4, enabled: false };
proc = Calc.buildProcurement([cA1, cA2, cA3, cA4off], qUni, keys, gUni, {});
ok('7月15日恢复 A3=1@500', near(proc.price[keys.indexOf('2026-07-15|08')], 500));
proc = Calc.buildProcurement([cA1, { ...cA2, enabled: false }, cA3], qUni, keys, gUni, {});
ok('停用月分日后7月14日回到年分月价 300', near(proc.price[keys.indexOf('2026-07-14|08')], 300));

/* ---------- A7 超覆盖警告 ---------- */
console.log('\n[A7] 超覆盖风险提示');
const cOver = mkCurve('over', '2026-01-02T09:00', 'day_hour', hourEntries('2026-01-01', 5, 300));
proc = Calc.buildProcurement([cOver], qUni, keys, gUni, {});
ok('超覆盖量=24×(5−1)=96 MWh', near(proc.overMwh, 96));
ok('缺口按 max(q−purchase,0)=0 截断', near(proc.gapMwh, N - 24));

/* ---------- A8 无曲线 → 默认基准假设 ---------- */
console.log('\n[A8] 无任何曲线 → 默认假设');
proc = Calc.buildProcurement([], qUni, keys, gUni, { ratio: 0.9, price: 372 });
ok('标注默认假设', proc.isDefault === true);
ok('覆盖率=r0=0.9', near(proc.coverage, 0.9));
ok('加权均价=372（W_LT 锚点）', near(proc.weightedPrice, 372));
ok('缺口=876', near(proc.gapMwh, 876));

/* ---------- 覆盖率换算（quantityMode=ratio） ---------- */
console.log('\n[B1] 覆盖率按窗口客户电量换算');
const cRatio = mkCurve('ratio-curve', '2026-01-01T09:00', 'month_day',
  dayEntries(1, 31, 0, 310).map(e => ({ timeKey: e.timeKey, ratioPct: 50, priceYuanPerMwh: 310 })),
  { quantityMode: 'ratio', window: { from: '01-01', to: '01-31' } });
proc = Calc.buildProcurement([cRatio], qUni, keys, gUni, {});
ok('1月每日采购=1×50%=0.5 MWh', near(proc.purchase[keys.indexOf('2026-01-10|10')], 0.5));
ok('1月采购合计=31×24×0.5=372', near(proc.purchase.reduce((a, v, t) => a + (keys[t].slice(5, 7) === '01' ? v : 0), 0), 372));

/* ---------- 两部制报价集成（手算） ---------- */
console.log('\n[C1] 两部制报价集成');
// 平坦价格曲线 + 均匀统调基准 → 标定后 PDA 恒=372、采购逐时均匀，便于手算核对
const flatCurve = new Array(N).fill(100);
const miniP = JSON.parse(JSON.stringify(PARAMS));
miniP.baseline = { curve: new Array(N).fill(1) };   // 归一化后 g=1/8760 均匀
miniP.wholesaleCurves = [];
miniP.scenarios = [{ id: 'S1', name: '单情景', weight: 1, priceFactor: 1, sr: 0, o: 0, allocShare: 0, refundShare: 0, curve: flatCurve }];
miniP.costModel.reservePerMwh = 0;
miniP.billLayer = { mode: 'monthly_allocation', item: { bearer: 'pass', monthly: new Array(12).fill(0) } };   // 到户层客户承担 → 不计入成本（本算例不含分摊）
const rr = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: miniP });
// Clt=0.9×372=334.8；Cda=0.1×372=37.2 → C总=372
ok('Clt=334.8', near(rr.scenarios[0].Clt, 334.8));
ok('Cda=37.2', near(rr.scenarios[0].Cda, 37.2));
ok('C总=372', near(rr.scenarios[0].Ctotal, 372));
ok('冲单价=(C80+5)/K=377', near(rr.tiers[2].price, 377));
ok('procurement 标注默认假设', rr.procurement.isDefault === true && rr.procurement.coverage === 0.9);

// 用全年年分月曲线 1200MWh@300 → Clt=1200×300/8760=41.0959；Cda=7560/8760×372=321.041
const rr2 = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1.2, params: { ...miniP, wholesaleCurves: [cA1] } });
ok('曲线模式 Clt=41.0959', near(rr2.scenarios[0].Clt, 1200 * 300 / 8760, 1e-3));
ok('曲线模式 Cda=321.041', near(rr2.scenarios[0].Cda, 7560 / 8760 * 372, 1e-3));
ok('K=1.2 → P平=(C+5)/1.2', near(rr2.tiers[2].Pping, (rr2.scenarios[0].Ctotal + 5) / 1.2));
ok('覆盖率自动汇总=1200/8760', near(rr2.procurement.coverage, 1200 / 8760));

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
