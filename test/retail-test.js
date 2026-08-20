/* 零售侧收入引擎自测：PPT 算例（公式精确值 55.80 万；PPT 分项舍入和 55.70）+ 边界用例
 * 运行：node test/retail-test.js
 */
'use strict';
const path = require('path');
const R = require(path.join(__dirname, '..', 'js', 'retail.js'));

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failed++; console.log('  FAIL  ' + n + (x ? ' => ' + x : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

console.log('\n[1] PPT 算例（公式精确值）');
const r = R.calcRetail(R.demoInput(), R.demoUsage());
ok('固定电费 = 44.6472 万（200×0.9×520×1.7 + 500×0.9×520 + 300×0.9×520×0.38）', near(r.energy.fixed.total, 446472, 1), r.energy.fixed.total);
ok('联动电费 = 5.1516 万（方式③10%@540）', near(r.energy.linked.total, 51516, 1));
ok('煤电电费 = 2.5758 万（trunc(106/100)=1）', near(r.energy.coal.total, 25758, 1));
ok('浮动费用 = 0（2026 新规禁用）', !r.energy.floatFee, '浮动费应不存在');
ok('峰谷平衡补贴 8.6118 万', near(r.peakValley.valleySubsidy, 86118, 1));
ok('峰谷平衡惩罚 6.482 万', near(r.peakValley.peakPenalty, 64820, 1));
ok('峰谷平衡净额 = +2.1298 万', near(r.peakValley.net, 21298, 1));
ok('绿电合计 = 0.1 万（100×10）', near(r.green.total, 1000, 1));
ok('★ 零售收入 = 54.6044 万（2026 规则：去浮动费）', near(r.grandTotal, 546044, 2), (r.grandTotal / 10000).toFixed(4));
ok('度电单价 = 0.5460 元/kWh', near(r.unitPriceYuanPerKwh, 0.54604, 1e-5));
ok('无校验错误', r.errors.length === 0, JSON.stringify(r.errors));

console.log('\n[2] 盈亏平衡求解');
// 成本 558044 元 → 盈亏平衡固定平段价应 = 520（收入=成本）
const be = R.solveBreakEven(R.demoInput(), R.demoUsage(), 546044 / 1000);
ok('成本=收入时 盈亏平衡平段价=520', near(be.flatPrice, 520, 0.01), be.flatPrice);
ok('代回利润=0', Math.abs(be.checkProfit) < 1, be.checkProfit);
ok('K = (200×1.7+500+300×0.38)/1000 = 0.954', near(be.K, 0.954, 1e-9));

console.log('\n[3] 校验规则');
const bad1 = JSON.parse(JSON.stringify(R.demoInput())); bad1.fixed.flatPrice = 600;
ok('固定价 600 > 554 → 拦截', R.calcRetail(bad1, R.demoUsage()).errors.length > 0);
const bad2 = JSON.parse(JSON.stringify(R.demoInput())); bad2.fixed.ratio = 0.8;
ok('固定 80% + 联动 10% ≠ 100% → 拦截', R.calcRetail(bad2, R.demoUsage()).errors.length > 0);
const bad3 = JSON.parse(JSON.stringify(R.demoInput()));
bad3.fixed.ratio = 0.85;
bad3.link.modes = [{ type: 1, ratio: 0.05, flatPrice: 540 }, { type: 2, ratio: 0.10, flatPrice: 530 }];
ok('方式①与②同时勾选 → 拦截（互斥）', R.calcRetail(bad3, R.demoUsage()).errors.some(e => e.indexOf('互斥') >= 0));
const ok3 = JSON.parse(JSON.stringify(R.demoInput()));
ok3.fixed.ratio = 0.85;
ok3.link.modes = [{ type: 1, ratio: 0.05, flatPrice: 540 }, { type: 3, ratio: 0.10, flatPrice: 500 }];
ok('方式①与③同时勾选 → 合法（新规允许）', R.calcRetail(ok3, R.demoUsage()).errors.length === 0);
const pureFix = JSON.parse(JSON.stringify(R.demoInput()));
pureFix.fixed.ratio = 1; pureFix.link.modes = [];
ok('纯固定价（0% 联动）→ 拦截（新规不允许）', R.calcRetail(pureFix, R.demoUsage()).errors.some(e => e.indexOf('低于下限 10%') >= 0));
const bad4 = JSON.parse(JSON.stringify(R.demoInput()));
bad4.link.modes = [{ type: 3, ratio: 0.3, flatPrice: 540 }]; bad4.fixed.ratio = 0.7;
ok('方式③占比 30% > 20% → 拦截', R.calcRetail(bad4, R.demoUsage()).errors.length > 0);
const bad5 = JSON.parse(JSON.stringify(R.demoInput())); bad5.coal.floatPrice = 80;
ok('煤电浮动 80 > 50 → 拦截', R.calcRetail(bad5, R.demoUsage()).errors.length > 0);

console.log('\n[3b] 2026 新规校验');
// 联动总比例 > 30% → 拦截
const b0 = JSON.parse(JSON.stringify(R.demoInput()));
b0.fixed.ratio = 0.65; b0.link.modes = [{ type: 1, ratio: 0.35, flatPrice: 540 }];
ok('联动总比例 35% > 30% → 拦截', R.calcRetail(b0, R.demoUsage()).errors.some(e => e.indexOf('30%') >= 0));
// 现货联动 < 8% → 拦截
const b0b = JSON.parse(JSON.stringify(R.demoInput()));
b0b.fixed.ratio = 0.92; b0b.link.modes = [{ type: 3, ratio: 0.05, flatPrice: 540 }];
ok('现货联动 5% < 8% → 拦截', R.calcRetail(b0b, R.demoUsage()).errors.some(e => e.indexOf('下限 8%') >= 0));
// 现货联动 > 15% → 拦截
const b0c = JSON.parse(JSON.stringify(R.demoInput()));
b0c.fixed.ratio = 0.80; b0c.link.modes = [{ type: 3, ratio: 0.20, flatPrice: 540 }];
ok('现货联动 20% > 15% → 拦截', R.calcRetail(b0c, R.demoUsage()).errors.some(e => e.indexOf('上限 15%') >= 0));
// 固定+联动 + 浮动费 → 拦截（2026）
const b0d = JSON.parse(JSON.stringify(R.demoInput()));
b0d.floatFee = { enabled: true, price: 3 };
ok('固定+联动+浮动费 → 拦截（2026 新规）', R.calcRetail(b0d, R.demoUsage()).errors.some(e => e.indexOf('不再签订浮动费用') >= 0));
// 平价套餐 + 浮动费 3（0~5 合法）
const b0e = JSON.parse(JSON.stringify(R.demoInput()));
b0e.planMode = 'fair'; b0e.wholesaleAvg = 380; b0e.floatFee = { enabled: true, price: 3 };
ok('平价套餐+浮动费 3 → 合法', R.calcRetail(b0e, R.demoUsage()).errors.length === 0);
// 平价套餐 + 浮动费 6 > 5 → 拦截
const b0f = JSON.parse(JSON.stringify(R.demoInput()));
b0f.planMode = 'fair'; b0f.wholesaleAvg = 380; b0f.floatFee = { enabled: true, price: 6 };
ok('平价套餐+浮动费 6 > 5 → 拦截', R.calcRetail(b0f, R.demoUsage()).errors.some(e => e.indexOf('超出') >= 0));

console.log('\n[4] 边界用例');
// 非深圳商业 f1=f2=1 → 峰谷平衡净额 0
const b1 = JSON.parse(JSON.stringify(R.demoInput())); b1.userType = '非深圳商业';
const rb1 = R.calcRetail(b1, R.demoUsage());
ok('非深圳商业（f1=f2=1）峰谷平衡净额=0', near(rb1.peakValley.net, 0));
// 绿电约定电量 > 实际×1.2 → 截断
const b2 = JSON.parse(JSON.stringify(R.demoInput()));
b2.green.volumeMode = 'fixed'; b2.green.fixedVolume = 200; b2.green.actualGreenUsage = 100;
const rb2 = R.calcRetail(b2, R.demoUsage());
ok('绿电约定 200 > 100×1.2 → 有效电量=120', near(rb2.green.effectiveVolume, 120));
// 批发侧不足 k<1 → 偏差
const b3 = JSON.parse(JSON.stringify(R.demoInput()));
b3.green.wholesaleTotal = 70; b3.green.upperPriorityVolume = 0;
const rb3 = R.calcRetail(b3, R.demoUsage());
ok('批发侧 70 < Q100 → k=0.7、偏差=−30 MWh', near(rb3.green.adjCoef, 0.7) && near(rb3.green.deviationVolume, -30));
ok('偏差电费 = −30×10 = −300 元', near(rb3.green.deviationFee, -300));
// 考核：月度偏差×系数
const b4 = JSON.parse(JSON.stringify(b3)); b4.green.assessMode = 'month'; b4.green.assessCoef = 0.1;
const rb4 = R.calcRetail(b4, R.demoUsage());
ok('考核电费 = 30 MWh×10 元/MWh×0.1 = 30 元', near(rb4.green.assessFee, 30));
// CECI 负价差 trunc：结算 700 − 签约 834 = −134/100 = −1.34 → trunc = −1
const b5 = JSON.parse(JSON.stringify(R.demoInput())); b5.coal.ceciSettle = 700;
const rb5 = R.calcRetail(b5, R.demoUsage());
ok('CECI 负价差 trunc(−1.34) = −1 → 煤电电费为负', near(rb5.energy.coal.total, -25758, 1), rb5.energy.coal.total);
// 峰多谷少 → 峰谷平衡净额为负（惩罚重）
const rb6 = R.calcRetail(R.demoInput(), { peak: 500, flat: 300, valley: 200 });
ok('峰500/谷200 → 净额为负', rb6.peakValley.net < 0, rb6.peakValley.net);

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
