/* 主口径交叉校验：calc.js（两部制，唯一成本口径）vs CfD 恒等式
 * 验证同一输入下成本引擎与独立推导一致
 * 运行：node test/cross-check-test.js
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
const qUni = new Array(N).fill(1);

/* 1. CfD 恒等式：P_DA ≡ 合约价 → 批发成本 = 合约价（与持仓/曲线无关） */
console.log('\n[1] CfD 恒等式（P_DA=合约价372）');
const p1 = JSON.parse(JSON.stringify(PARAMS));
p1.baseline = { curve: new Array(N).fill(1) };
p1.wholesaleCurves = [{ id: 'c', name: 't', status: 'locked', enabled: true, createdAt: '2026-01-01', year: 2026,
  window: { from: '01-01', to: '12-31' }, granularity: 'year_month', quantityMode: 'mwh', priceMode: 'flat', flatPrice: 372,
  entries: Array.from({ length: 12 }, (_, m) => ({ timeKey: String(m + 1).padStart(2, '0'), quantityMwh: 60, ratioPct: null, priceYuanPerMwh: 372 })) }];
p1.scenarios = [{ id: 'S', name: '平价', weight: 1, priceMode: 'direct', curve: new Array(N).fill(372), allocShare: 0, refundShare: 0, sr: 0, o: 0 }];
p1.costModel.reservePerMwh = 0; p1.costModel.opsPerMwh = 0;
p1.billLayer = { mode: 'monthly_allocation', item: { bearer: 'pass', monthly: new Array(12).fill(0) } };
const r1 = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: p1 });
ok('批发成本 Clt+Cda = 372（恒等式）', near(r1.scenarios[0].Clt + r1.scenarios[0].Cda, 372, 0.5),
   (r1.scenarios[0].Clt + r1.scenarios[0].Cda).toFixed(3));

/* 2. 无持仓（全部日前）：成本 = 现货加权均价 */
console.log('\n[2] 全日前（无持仓）');
const p2 = JSON.parse(JSON.stringify(PARAMS));
p2.wholesaleCurves = [];
p2.defaults.coverageRatio = 0;
p2.costModel.reservePerMwh = 0; p2.costModel.opsPerMwh = 0;
p2.billLayer = { mode: 'monthly_allocation', item: { bearer: 'pass', monthly: new Array(12).fill(0) } };
const r2 = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: p2 });
const daWavg = PARAMS.scenarios[0].curve.reduce((a, v, t) => a + v, 0) / N;
ok('Cda ≈ 日前均价（全缺口）', near(r2.scenarios[0].Cda, daWavg, 1), r2.scenarios[0].Cda.toFixed(2) + ' vs ' + daWavg.toFixed(2));

/* 3. 缺口为 0（持仓=负荷）：Cda=0，成本=持仓价 */
console.log('\n[3] 持仓=负荷（无缺口无超覆盖）');
const p3 = JSON.parse(JSON.stringify(PARAMS));
p3.wholesaleCurves = [{ id: 'c', name: 't', status: 'locked', enabled: true, createdAt: '2026-01-01', year: 2026,
  window: { from: '01-01', to: '12-31' }, granularity: 'day_hour', quantityMode: 'mwh', priceMode: 'perEntry', flatPrice: null,
  entries: keys.map((k, t) => ({ timeKey: k, quantityMwh: 1, ratioPct: null, priceYuanPerMwh: 372 })) }];
p3.costModel.reservePerMwh = 0; p3.costModel.opsPerMwh = 0;
p3.billLayer = { mode: 'monthly_allocation', item: { bearer: 'pass', monthly: new Array(12).fill(0) } };
const r3 = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: p3 });
ok('Cda=0（无缺口）', Math.abs(r3.scenarios[0].Cda) < 1e-6, r3.scenarios[0].Cda);
ok('Clt=372（持仓全覆盖）', near(r3.scenarios[0].Clt, 372, 0.01), r3.scenarios[0].Clt);

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
