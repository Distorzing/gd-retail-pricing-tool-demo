/* V1.2/1.3 自测（V1.4 两部制口径）：中长期+日前成本、VaR/CVaR、门槛与参数完整性
 * 运行：node test/v12-test.js
 */
'use strict';
const path = require('path');
const Calc = require(path.join(__dirname, '..', 'js', 'calc.js'));
const PARAMS = require(path.join(__dirname, '..', 'js', 'data.js'));

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failed++; console.log('  FAIL  ' + n + (x ? ' => ' + x : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);

/* ---------- 1. 手算两部制 mini 算例（无曲线→默认假设） ---------- */
console.log('\n[1] 两部制成本手算核对（4小时）');
const mini = {
  meta: { hours: 4 }, baseline: { curve: [0.25, 0.25, 0.25, 0.25] },
  defaults: { coverageRatio: 0.5 },
  wholesaleCurves: [],
  scenarios: [{
    id: 'S1', name: '单一情景', weight: 1, priceFactor: 1,
    allocShare: 2, refundShare: 1, sr: 3, o: 2, curve: [100, 200, 300, 400]
  }],
  costModel: {
    procurementMode: 'standard_proxy', reservePerMwh: 0,   // V2 起删准备金
    riskThresholds: { varAlpha: 0.95, minGrossMargin: 3, maxLossProbPct: 35, maxCvar: 8 }
  },
  tiers: [
    { key: 'conservative', name: '保守价', q: 0.95, M: 20 },
    { key: 'target', name: '目标价', q: 0.90, M: 10 },
    { key: 'aggressive', name: '冲单价', q: 0.80, M: 5, recommended: true }
  ],
  redLines: {}
};
const K4 = ['2026-01-01|00', '2026-01-01|01', '2026-01-01|02', '2026-01-01|03'];
// q=[1,2,3,4] Q=10，无曲线→默认假设 purchase=r0×Q×g=1.25×4（r0=0.5），价格=wLt=240
// Clt=0.5×240=120；gap=max(q−1.25,0)=[0,0.75,1.75,2.75]
// Cda=(0×100+0.75×200+1.75×300+2.75×400)/10=177.5；C总=120+177.5+2−1+3+2+3=303.5
const r1 = Calc.computeQuote({ q: [1, 2, 3, 4], keys: K4, W: 250, wLt: 240, K: 1, params: mini });
const s1 = r1.scenarios[0];
ok('中长期成本 Clt=r0×wLt=120', near(s1.Clt, 120));
ok('日前缺口成本 Cda=177.5', near(s1.Cda, 177.5));
ok('C批发=120+177.5+2−1=298.5', near(s1.Cwholesale, 298.5));
ok('C总=298.5+3+2=303.5（V2 删准备金）', near(s1.Ctotal, 303.5));
ok('E[C]=303.5', near(r1.EC, 303.5));
ok('保守价=(C95+20)/1=323.5', near(r1.tiers[0].price, 323.5));
ok('目标价=(C90+10)/1=313.5', near(r1.tiers[1].price, 313.5));
ok('冲单价=(C80+5)/1=308.5', near(r1.tiers[2].price, 308.5));
ok('冲单预期利润=308.5−303.5=5', near(r1.tiers[2].expectedProfit, 5));
ok('三门槛全过（推荐资格）', r1.tiers[2].gates.all === true);
ok('默认假设标注且覆盖率=r0=0.5', r1.procurement.isDefault === true && near(r1.procurement.coverage, 0.5));

/* ---------- 2. 实时层已退出成本模型（V1.4 边界） ---------- */
console.log('\n[2] 实时参数不再影响成本');
const mini2 = JSON.parse(JSON.stringify(mini));
mini2.scenarios[0].rtFactor = 9.9;
mini2.scenarios[0].loadError = 0.5;
const r2 = Calc.computeQuote({ q: [1, 2, 3, 4], keys: K4, W: 250, wLt: 240, K: 1, params: mini2 });
ok('rtFactor/loadError 不影响 C总', near(r2.scenarios[0].Ctotal, r1.scenarios[0].Ctotal));

/* ---------- 3. K 联动（P平=(Cq+M)/K） ---------- */
console.log('\n[3] K 联动');
const r4 = Calc.computeQuote({ q: [1, 2, 3, 4], keys: K4, W: 250, wLt: 240, K: 1.2, params: mini });
ok('等效价不变=323.5（K 不影响成本）', near(r4.tiers[0].price, 323.5));
ok('P平=323.5/1.2=269.5833', near(r4.tiers[0].Pping, 323.5 / 1.2, 1e-4));

/* ---------- 4. VaR/CVaR 与冲单门槛（多情景） ---------- */
console.log('\n[4] VaR/CVaR 与冲单门槛');
const mini5 = JSON.parse(JSON.stringify(mini));
mini5.scenarios = [
  { id: 'L', name: '低', weight: 0.5, priceFactor: 0.4, allocShare: 0, refundShare: 0, sr: 0, o: 0, curve: [100, 200, 300, 400] },
  { id: 'M', name: '中', weight: 0.3, priceFactor: 0.8, allocShare: 0, refundShare: 0, sr: 0, o: 0, curve: [100, 200, 300, 400] },
  { id: 'H', name: '高', weight: 0.2, priceFactor: 1.2, allocShare: 0, refundShare: 0, sr: 0, o: 0, curve: [100, 200, 300, 400] }
];
mini5.costModel.reservePerMwh = 0;
const r5 = Calc.computeQuote({ q: [1, 2, 3, 4], keys: K4, W: 250, wLt: 240, K: 1, params: mini5 });
const agg = r5.tiers[2];
const costs = r5.scenarios.map(s => s.Ctotal).sort((a, b) => a - b);
ok('成本严格递增（价格因子驱动）', costs[0] < costs[1] && costs[1] < costs[2]);
ok('C80 = 中位成本（累计权重 .5→.8）', near(agg.Cq, costs[1]));
ok('冲单价 = C80+5', near(agg.price, costs[1] + 5));
ok('亏损概率 = 高情景权重 0.2', near(agg.lossProb, 0.2, 1e-9));
const vc = Calc.weightedVaRCVaR([{ loss: 10, weight: 0.5 }, { loss: 50, weight: 0.3 }, { loss: 100, weight: 0.2 }], 0.95);
ok('VaR95=100', near(vc.varA, 100));
ok('CVaR95=100（尾部仅最高情景）', near(vc.cvar, 100));
ok('冲单门槛包含三件套', agg.gates && ['margin', 'lossProb', 'cvar', 'all'].every(k => k in agg.gates));

/* ---------- 5. 门槛拒绝推荐 ---------- */
console.log('\n[5] 门槛拒绝推荐');
const mini6 = JSON.parse(JSON.stringify(mini5));
mini6.tiers[2].M = -500;   // 冲单价远低于成本 → 预期毛利为负
const r6 = Calc.computeQuote({ q: [1, 2, 3, 4], keys: K4, W: 250, wLt: 240, K: 1, params: mini6 });
ok('预期毛利为负 → margin 门槛拒绝', r6.tiers[2].gates.margin === false && r6.tiers[2].gates.all === false);

/* ---------- 6. 内置参数完整性 ---------- */
console.log('\n[6] 内置参数 sys-v2026.8');
ok('版本号', PARAMS.meta.versionId === 'sys-v2026.8');
ok('三档含 q+M（无旧 bufferQ/bufferE）', PARAMS.tiers.every(t => t.M != null && t.bufferQ == null));
ok('含批发曲线数组（默认空）', Array.isArray(PARAMS.wholesaleCurves));
ok('到户层为预测度电分摊单项（12 月值）', PARAMS.billLayer.mode === 'monthly_allocation' && PARAMS.billLayer.item.monthly.length === 12);
ok('costModel 含代理模式/准备金/门槛/审批', PARAMS.costModel && PARAMS.costModel.procurementMode === 'standard_proxy' && PARAMS.costModel.riskThresholds.approval.ok === true);

/* ---------- 7. 预测度电分摊年度化 ---------- */
console.log('\n[7] 预测度电分摊年度化（逐月电量加权）');
const keys7 = ['2026-01-15|10', '2026-01-16|10', '2026-07-15|10', '2026-07-16|10'];
const q7 = [30, 30, 10, 10];
const ann = Calc.annualizeMonthly([100, 0, 0, 0, 0, 0, 200, 0, 0, 0, 0, 0], q7, keys7);
ok('年度化=(100×60+200×20)/80=125', near(ann.annual, 125));
ok('逐月电量聚合正确', near(ann.Qm[0], 60) && near(ann.Qm[6], 20));

/* ---------- 8. 内置参数全量算例（8760） ---------- */
console.log('\n[8] 内置参数 8760 全量算例');
const Validator = require(path.join(__dirname, '..', 'js', 'validate.js'));
const keys = Validator.expectedHourKeys(2026);
const q8760 = keys.map(k => {
  const h = +k.slice(11); const day = new Date(k.slice(0, 10) + 'T00:00:00Z').getUTCDay();
  const wd = (day >= 1 && day <= 5) ? 1 : 0.55;
  const shape = (h >= 8 && h <= 11) || (h >= 14 && h <= 17) ? 2.2 : (h >= 19 && h <= 21 ? 1.5 : (h < 6 ? 0.4 : 1.0));
  return 2 * wd * shape;
});
const p8 = JSON.parse(JSON.stringify(PARAMS)); p8.wholesaleCurves = [];
const r8 = Calc.computeQuote({ q: q8760, keys, W: 372, wLt: 372, K: 1.08, params: p8 });
ok('三档产出且为正', r8.tiers.every(t => isFinite(t.Pping) && t.Pping > 0));
ok('两部制成本拆分齐全（Clt/Cda）', r8.scenarios.every(s => isFinite(s.Clt) && isFinite(s.Cda)));
ok('含 VaR/CVaR/亏损概率', r8.tiers.every(t => isFinite(t.VaR) && isFinite(t.CVaR) && isFinite(t.lossProb)));
ok('默认假设路径（内置无批发曲线）', r8.procurement.isDefault === true && near(r8.procurement.coverage, 0.9));
console.log('      [参考] K=1.08 时 P平：保守=' + r8.tiers[0].Pping.toFixed(2) + ' 目标=' + r8.tiers[1].Pping.toFixed(2) +
  ' 冲单=' + r8.tiers[2].Pping.toFixed(2) + '；等效价=' + r8.tiers[2].price.toFixed(2) + '；E[C]=' + r8.EC.toFixed(2));

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
