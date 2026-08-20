/* 盈亏平衡 CfD 引擎自测（依据技术文档 §8）
 * 运行：node test/breakeven-test.js
 */
'use strict';
const path = require('path');
const B = require(path.join(__dirname, '..', 'js', 'breakeven.js'));
const Calc = require(path.join(__dirname, '..', 'js', 'calc.js'));
const Validator = require(path.join(__dirname, '..', 'js', 'validate.js'));
const PARAMS = require(path.join(__dirname, '..', 'js', 'data.js'));

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failed++; console.log('  FAIL  ' + n + (x ? ' => ' + x : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

const keys = Validator.expectedHourKeys(2026);
const N = keys.length;
const g = Calc.normalize(PARAMS.baseline.curve);
// 统调月度能量分布
const monthlyBase = new Array(12).fill(0);
keys.forEach((k, t) => { monthlyBase[+k.slice(5, 7) - 1] += g[t]; });

// 客户负荷：4:4:2 均匀段内分布（文档 §4.1）
const dayShape = B.buildDayShape(0.4, 0.4, 0.2, B.CONFIG.TOU_HOURS);
const touSum = dayShape.reduce((a, b) => a + b, 0);
ok('典型日形状 Σ=1', near(touSum, 1), touSum);
const nPeak = B.CONFIG.TOU_HOURS.peak.length, nValley = B.CONFIG.TOU_HOURS.valley.length;
ok('时段表：峰 7h 谷 8h 平 9h（广东政策含 18 点）', nPeak === 7 && nValley === 8 && B.CONFIG.TOU_HOURS.flat.length === 9,
  nPeak + '/' + nValley + '/' + B.CONFIG.TOU_HOURS.flat.length);

const E_day = 100000 / 365;
const q = keys.map(k => {
  const m = +k.slice(5, 7) - 1, h = +k.slice(11, 13);
  return E_day * dayShape[h];
});
const Qtot = q.reduce((a, b) => a + b, 0);
const usage = { peak: 0.4 * Qtot, flat: 0.4 * Qtot, valley: 0.2 * Qtot };

// 持仓：85% 统调 + 90% 总仓位（年度可调①/月度可调②乘子）
const P_C = 372;
const mult1 = { sundayZero: true, hours: { 18: 3.5, 19: 3.5, 20: 3.5, 21: 3.5, 22: 3.5 } };
const mult2 = { sundayZero: false, hours: { 0: 3.5, 18: 3.5, 19: 3.5, 20: 3.5, 21: 3.5, 22: 3.5, 3: 0.5, 4: 0.5, 5: 0.5 } };
const sysShape = B.expandCurveShape(keys, monthlyBase, g.map((v, t) => {   // 统调日形状：用 g 的月内平均日形状
  return g[t]; }), null);
const dayShapeSys = (() => {   // 统调典型日形状 = 全年逐时平均
  const acc = new Array(24).fill(0);
  keys.forEach((k, t) => acc[+k.slice(11, 13)] += g[t]);
  const s = acc.reduce((a, b) => a + b, 0);
  return acc.map(v => v / s);
})();
const sysAdj1 = B.expandCurveShape(keys, monthlyBase, dayShapeSys, mult1);
const sysAdj2 = B.expandCurveShape(keys, monthlyBase, dayShapeSys, mult2);
ok('统调形状 Σ=1', near(sysShape.reduce((a, b) => a + b, 0), 1));
ok('可调①展开 Σ=1（周日电量已摊回）', near(sysAdj1.reduce((a, b) => a + b, 0), 1));
ok('可调①周日=0', sysAdj1.every((v, t) => new Date(keys[t].slice(0, 10) + 'T00:00:00Z').getUTCDay() !== 0 ? true : v === 0));
ok('可调②周日>0（无清零）', sysAdj2.some((v, t) => new Date(keys[t].slice(0, 10) + 'T00:00:00Z').getUTCDay() === 0 && v > 0));

const holdings = [
  { name: '统调50%', qty: 0.425 * Qtot, price: P_C, shapePerHour: sysShape },
  { name: '可调①50%', qty: 0.425 * Qtot, price: P_C, shapePerHour: sysAdj1 },
  { name: '可调②5%', qty: 0.05 * Qtot, price: P_C, shapePerHour: sysAdj2 }
];
const sumQ = holdings.reduce((a, h) => a + h.qty, 0);
ok('持仓总量 = 90% 仓位', near(sumQ / Qtot, 0.9), sumQ / Qtot);

console.log('\n[1] 引擎自检恒等式（§8.1：P_DA ≡ 372 → C=372，P*=(372+9.7+6+72.2)/1.156≈397.9）');
const daFlat = new Array(N).fill(372);
const r1 = B.solve({ q, keys, da: daFlat, holdings, alloc: 9.7, ops: 6, usage, userType: '非深圳工业' });
ok('C=372（价差为 0，与曲线无关）', near(r1.holding.C, 372, 1e-6), r1.holding.C);
ok('G_curve=0', Math.abs(r1.holding.G_curve) < 1e-6, r1.holding.G_curve);
ok('C_spot=372', near(r1.holding.C_spot, 372, 1e-6));
ok('c_pv = 0.4×463×0.7 − 0.2×463×0.62 = 72.24', near(r1.c_pv, 72.23, 0.05), r1.c_pv);
ok('C_total = 372+9.7+6+72.24 = 459.94', near(r1.C_total, 459.94, 0.1), r1.C_total);
ok('P* = 459.94 / 1.156 = 397.87', near(r1.Pstar, 397.87, 0.1), r1.Pstar);

console.log('\n[2] 方向性（§8.2：18-22 点 500、其余 350 → 可调① DA 更高、成本更低）');
const daDir = keys.map(k => { const h = +k.slice(11, 13); return (h >= 18 && h <= 22) ? 500 : 350; });
const r2 = B.solve({ q, keys, da: daDir, holdings, alloc: 9.7, ops: 6, usage, userType: '非深圳工业' });
const pc = r1.holding; // 参考结构
const perC = r2.holding.perCurve;
const daSys = perC.find(c => c.name === '统调50%').DA;
const daAdj1 = perC.find(c => c.name === '可调①50%').DA;
ok('DA_可调① > DA_统调（可调堆到高价时段）', daAdj1 > daSys, daAdj1 + ' vs ' + daSys);
const r2sysOnly = B.solve({ q, keys, da: daDir, holdings: [holdings[0], holdings[0]].map(h => ({ ...h, qty: h.qty / 0.425 * 0.45 })), alloc: 9.7, ops: 6, usage, userType: '非深圳工业' });
ok('全统调持仓成本 > 含可调持仓成本', r2sysOnly.holding.C > r2.holding.C, r2sysOnly.holding.C + ' vs ' + r2.holding.C);

console.log('\n[3] 超卖（§8.3：病态乘子 → 谷段集中 → Q>L 小时成本上升、报表统计>0）');
const sickMult = { sundayZero: false, hours: { 0: 8, 1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 8, 7: 8 } };
const sickShape = B.expandCurveShape(keys, monthlyBase, dayShapeSys, sickMult);
const sickHold = [{ name: '病态集中谷段', qty: 0.9 * Qtot, price: P_C, shapePerHour: sickShape }];
const r3 = B.solve({ q, keys, da: daDir, holdings: sickHold, alloc: 9.7, ops: 6, usage, userType: '非深圳工业' });
ok('超卖小时数 > 0', r3.holding.oversellHours > 0, r3.holding.oversellHours);
ok('超卖电量 > 0', r3.holding.oversellMwh > 0, r3.holding.oversellMwh);

console.log('\n[4] 与现工具年度案例对照（CfD 成本 vs 之前两部制）');
const daReal = PARAMS.scenarios[0].curve;
const r4 = B.solve({ q, keys, da: daReal, holdings, alloc: 9.7, ops: 6, usage, userType: '非深圳工业' });
console.log('  CfD 全口径 C_total = ' + r4.C_total.toFixed(2) + '（对比原两部制 433.57+峰谷净成本修正）');
console.log('  C_spot = ' + r4.holding.C_spot.toFixed(2) + '｜ G_curve = ' + r4.holding.G_curve.toFixed(2) + '｜ c_pv = ' + r4.c_pv.toFixed(2));
console.log('  P* = ' + r4.Pstar.toFixed(2) + '（K=' + r4.K.toFixed(4) + '）');
ok('P* 有限且为正', r4.Pstar > 0 && isFinite(r4.Pstar));
ok('覆盖率=0.9', near(r4.holding.coverage, 0.9, 1e-9));

console.log('\n[5] 敏感性矩阵（5×3）');
const sens = B.sensitivity({ q, keys, da: daReal, holdings, alloc: 9.7, ops: 6, usage, userType: '非深圳工业' }, [-20, 0, 20], [0.85, 0.90]);
ok('敏感性矩阵 2×3', sens.length === 2 && sens[0].length === 3);
ok('日前价↑ → P*↑（正相关）', sens[1][2] > sens[1][0], sens[1].join(' → '));

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
