/* 签约窗口（年内新增用户）自测：窗口化成本计算
 * 运行：node test/window-test.js
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
const inWin = k => { const md = k.slice(5, 10); return md >= '09-01' && md <= '12-31'; };
const winHours = keys.filter(k => inWin(k)).length;
ok('9-12 月窗口小时数 = 2928', winHours === 122 * 24, winHours);

/* 1. 窗口化基础：均匀曲线 + 平坦日前价 372 + 默认假设 90% 采购
 * 手算：Q=2928；purchase=r0×8760×g（全年），窗口内采购=r0×2928（g 归一）
 * Clt=372×0.9=334.8；缺口=0.1×2928；Cda=0.1×372=37.2；C总=334.8+37.2+absorb */
console.log('\n[1] 窗口化成本（均匀+默认假设）');
const miniP = JSON.parse(JSON.stringify(PARAMS));
miniP.baseline = { curve: new Array(N).fill(1) };
miniP.wholesaleCurves = [];
miniP.costModel.reservePerMwh = 0;
miniP.billLayer = { mode: 'monthly_allocation', item: { bearer: 'pass', monthly: new Array(12).fill(0) } };
miniP.scenarios = [{ id: 'S1', name: '平价', weight: 1, priceFactor: 1, sr: 0, o: 0, allocShare: 0, refundShare: 0,
  curve: new Array(N).fill(100) }];   // 标定到 W → P_da 恒=372
const r1 = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: miniP, window: { from: '09-01', to: '12-31' } });
ok('窗口电量 Q=2928', near(r1.Q, 2928), r1.Q);
ok('isFullYear=false', r1.isFullYear === false);
ok('Clt=372×0.9=334.8（窗口内采购/窗口电量）', near(r1.scenarios[0].Clt, 334.8, 0.02), r1.scenarios[0].Clt);
ok('Cda=0.1×372=37.2', near(r1.scenarios[0].Cda, 37.2, 0.02), r1.scenarios[0].Cda);
ok('缺口=292.8 MWh', near(r1.procurement.gapMwh, 292.8, 1), r1.procurement.gapMwh);

/* 2. 与年度模式对照：同条件全年 → Q=8760，成本相同（比例不变） */
const r2 = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: miniP });
ok('年度模式 Q=8760', near(r2.Q, 8760));
ok('年度 C总 与窗口 C总 一致（均匀+比例采购）', near(r2.scenarios[0].Ctotal, r1.scenarios[0].Ctotal, 0.05),
  r1.scenarios[0].Ctotal + ' vs ' + r2.scenarios[0].Ctotal);

/* 3. 关键差异：全年曲线在窗口外被剔除（增量口径）
 * 造一条 1-3 月 1000MWh@300 的年分月曲线：年度模式 Clt=300×1000/8760=34.25；
 * 窗口模式（9月起）该曲线完全在窗口外 → 不计采购，采购=0 */
console.log('\n[2] 窗口外曲线剔除（增量口径）');
const p3 = JSON.parse(JSON.stringify(miniP));
p3.wholesaleCurves = [{ id: 'c1', name: 'Q1采购', status: 'locked', enabled: true, createdAt: '2026-01-01', year: 2026,
  window: { from: '01-01', to: '03-31' }, granularity: 'year_month', quantityMode: 'mwh', priceMode: 'flat', flatPrice: 300,
  entries: ['01', '02', '03'].map(m => ({ timeKey: m, quantityMwh: 1000 / 3, ratioPct: null, priceYuanPerMwh: 300 })) }];
const r3w = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: p3, window: { from: '09-01', to: '12-31' } });
ok('窗口模式：Q1 曲线被剔除 → 采购 0', r3w.procurement.totalPurchase < 1e-6, r3w.procurement.totalPurchase);
ok('窗口模式 Clt=0（采购在窗口外）', r3w.scenarios[0].Clt < 0.01, r3w.scenarios[0].Clt);
const r3f = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: p3 });
ok('年度模式：Q1 曲线生效 → Clt=1000×300/8760（V4 原价）', near(r3f.scenarios[0].Clt, 1000 * 300 / 8760, 0.1), r3f.scenarios[0].Clt);

/* 4. 窗口内曲线：9 月加一条 200MWh@420 → 窗口模式 Clt=200×420/2928=28.69 */
console.log('\n[3] 窗口内新增曲线（420）');
const p4 = JSON.parse(JSON.stringify(miniP));
p4.wholesaleCurves = [{ id: 'c9', name: '9月增量', status: 'locked', enabled: true, createdAt: '2026-01-01', year: 2026,
  window: { from: '09-01', to: '09-30' }, granularity: 'year_month', quantityMode: 'mwh', priceMode: 'flat', flatPrice: 420,
  entries: [{ timeKey: '09', quantityMwh: 200, ratioPct: null, priceYuanPerMwh: 420 }] }];
const r4w = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: p4, window: { from: '09-01', to: '12-31' } });
ok('窗口模式：9月 420 曲线按原价420 → Clt=200×420/2928（V4）', near(r4w.scenarios[0].Clt, 200 * 420 / 2928, 0.1), r4w.scenarios[0].Clt.toFixed(2));

/* 5. 分摊窗口化：absorb + 9-12 月每月 9.7，1-8 月 100（应不影响窗口年化） */
console.log('\n[4] 分摊窗口年化');
const p5 = JSON.parse(JSON.stringify(miniP));
p5.billLayer = { mode: 'monthly_allocation', item: { bearer: 'absorb',
  monthly: [100, 100, 100, 100, 100, 100, 100, 100, 9.7, 9.7, 9.7, 9.7] } };   // 窗口外 100 不应计入
const r5 = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: p5, window: { from: '09-01', to: '12-31' } });
ok('分摊年化=9.7（只用窗口内月份电量加权）', near(r5.scenarios[0].CbillAbsorb, 9.7, 0.01), r5.scenarios[0].CbillAbsorb);
const r5f = Calc.computeQuote({ q: qUni, keys, W: 372, wLt: 372, K: 1, params: p5 });
ok('年度模式分摊年化≈全年加权（≠9.7）', Math.abs(r5f.scenarios[0].CbillAbsorb - 9.7) > 30, r5f.scenarios[0].CbillAbsorb);

/* 6. 窗口为空 → 报错 */
console.log('\n[5] 异常');
const badP = JSON.parse(JSON.stringify(miniP));
let threw = false;
try { Calc.computeQuote({ q: qUni.map(v => 0), keys, W: 372, wLt: 372, K: 1, params: badP, window: { from: '09-01', to: '12-31' } }); }
catch (e) { threw = /电量为 0/.test(e.message); }
ok('窗口内电量为 0 → 报错', threw);

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
