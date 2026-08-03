/* V1.2/1.3 自测：三部制成本、r/负荷误差联动、VaR/CVaR、门槛与参数完整性
 * 运行：node test/v12-test.js
 */
'use strict';
const path = require('path');
const Calc = require(path.join(__dirname, '..', 'js', 'calc.js'));
const PARAMS = require(path.join(__dirname, '..', 'js', 'data.js'));

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failed++; console.log('  FAIL  ' + n + (x ? ' => ' + x : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);

/* ---------- 1. 手算三部制 mini 算例 ---------- */
console.log('\n[1] 三部制成本手算核对（4小时）');
const mini = {
  meta: { hours: 4 }, baseline: { curve: [0.25, 0.25, 0.25, 0.25] },
  scenarios: [{
    id: 'S1', name: '单一情景', weight: 1, priceFactor: 1,
    rtFactor: 1.1, loadError: 0, allocShare: 2, refundShare: 1,
    sr: 3, o: 2, curve: [100, 200, 300, 400]
  }],
  costModel: {
    procurementMode: 'standard_proxy', reservePerMwh: 3,
    riskThresholds: { varAlpha: 0.95, minGrossMargin: 3, maxLossProbPct: 35, maxCvar: 8 }
  },
  tiers: [
    { key: 'conservative', name: '保守价', q: 0.95, M: 20 },
    { key: 'target', name: '目标价', q: 0.90, M: 10 },
    { key: 'aggressive', name: '冲单价', q: 0.80, M: 5, recommended: true }
  ],
  redLines: {}
};
// q=[1,2,3,4] Q=10 b=[2.5]×4 W=250(k=1) wLt=240 r=0.5 rt=1.1 alloc=2 refund=1 SR=3 O=2 reserve=3
// QLT=1.25×4 QDA=2.5×4
// Clt=0.5×240=120；Cda=1.25×1000/10=125；Crt=[(−1.5×110)+(−0.5×220)+(0.5×330)+(1.5×440)]/10=55
const r1 = Calc.computeQuote({ q: [1, 2, 3, 4], W: 250, wLt: 240, coverageRatio: 0.5, K: 1, params: mini });
const s1 = r1.scenarios[0];
ok('中长期成本 Clt=120', near(s1.Clt, 120));
ok('日前暴露成本 Cda=125', near(s1.Cda, 125));
ok('实时偏差成本 Crt=55', near(s1.Crt, 55));
ok('日前曲线暴露（展示）CVda=50', near(s1.CVda, 50));
ok('实时曲线暴露 CVrt=Crt=55', near(s1.CVrt, 55));
ok('C批发=120+125+55+2−1=301', near(s1.Cwholesale, 301));
ok('C总=301+3+2+3=309', near(s1.Ctotal, 309));
ok('E[C]=309', near(r1.EC, 309));
ok('保守价=(C95+20)/1=329', near(r1.tiers[0].price, 329));
ok('目标价=(C90+10)/1=319', near(r1.tiers[1].price, 319));
ok('冲单价=(C80+5)/1=314', near(r1.tiers[2].price, 314));
ok('冲单预期利润=314−309=5', near(r1.tiers[2].expectedProfit, 5));
ok('三门槛全过（推荐资格）', r1.tiers[2].gates.all === true);

/* ---------- 2. r 联动（V1.3 验收：实时偏差不因 r 消失） ---------- */
console.log('\n[2] r 联动');
const r2 = Calc.computeQuote({ q: [1, 2, 3, 4], W: 250, wLt: 240, coverageRatio: 0.9, K: 1, params: mini });
const s2 = r2.scenarios[0];
ok('r↑：Clt 0.9×240=216', near(s2.Clt, 216));
ok('r↑：Cda 降至 0.25×1000/10=25', near(s2.Cda, 25));
ok('r↑：Crt 不变=55（实时偏差不因 r 消失）', near(s2.Crt, 55));
ok('r↑：C总=216+25+55+2−1+3+2+3=305', near(s2.Ctotal, 305));

/* ---------- 3. 负荷误差联动（中长期成本不被重复修改） ---------- */
console.log('\n[3] 负荷误差 ε 联动');
const mini3 = JSON.parse(JSON.stringify(mini));
mini3.scenarios[0].loadError = 0.1;
const r3 = Calc.computeQuote({ q: [1, 2, 3, 4], W: 250, wLt: 240, coverageRatio: 0.5, K: 1, params: mini3 });
const s3 = r3.scenarios[0];
ok('ε=0.1：Clt 不变=120', near(s3.Clt, 120));
ok('ε=0.1：Cda=(2.75−1.25)×1000/10=150', near(s3.Cda, 150));
ok('ε=0.1：Crt=27.5（实时成本变化）', near(s3.Crt, 27.5), s3.Crt);

/* ---------- 4. K 联动（P平=(Cq+M)/K） ---------- */
console.log('\n[4] K 联动');
const r4 = Calc.computeQuote({ q: [1, 2, 3, 4], W: 250, wLt: 240, coverageRatio: 0.5, K: 1.2, params: mini });
ok('等效价不变=329（K 不影响成本）', near(r4.tiers[0].price, 329));
ok('P平=329/1.2=274.1667', near(r4.tiers[0].Pping, 329 / 1.2, 1e-4));

/* ---------- 5. VaR/CVaR 与门槛（多情景） ---------- */
console.log('\n[5] VaR/CVaR 与冲单门槛');
const mini5 = JSON.parse(JSON.stringify(mini));
mini5.scenarios = [
  { id: 'L', name: '低', weight: 0.5, priceFactor: 0.4, rtFactor: 1, loadError: 0, allocShare: 0, refundShare: 0, sr: 0, o: 0, curve: [100, 200, 300, 400] },
  { id: 'M', name: '中', weight: 0.3, priceFactor: 0.8, rtFactor: 1, loadError: 0, allocShare: 0, refundShare: 0, sr: 0, o: 0, curve: [100, 200, 300, 400] },
  { id: 'H', name: '高', weight: 0.2, priceFactor: 1.2, rtFactor: 1, loadError: 0, allocShare: 0, refundShare: 0, sr: 0, o: 0, curve: [100, 200, 300, 400] }
];
mini5.costModel.reservePerMwh = 0;
// W=250 → W_da = 100/200/300；r=0.5，wLt=240
// C = r×240 + Cda + Crt（rt=1）：
//   L: Cda=(2.5−1.25)×1000/10=125×(100/250)=50；Crt=50×(100/250)=20 → C=120+50+20=190... 用程序值核对相对关系
const r5 = Calc.computeQuote({ q: [1, 2, 3, 4], W: 250, wLt: 240, coverageRatio: 0.5, K: 1, params: mini5 });
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

/* ---------- 6. 门槛拒绝推荐 ---------- */
console.log('\n[6] 门槛拒绝推荐');
const mini6 = JSON.parse(JSON.stringify(mini5));
mini6.tiers[2].M = -50;   // 冲单价低于成本 → 预期毛利为负
const r6 = Calc.computeQuote({ q: [1, 2, 3, 4], W: 250, wLt: 240, coverageRatio: 0.5, K: 1, params: mini6 });
ok('预期毛利为负 → margin 门槛拒绝', r6.tiers[2].gates.margin === false && r6.tiers[2].gates.all === false);

/* ---------- 7. 内置参数完整性 ---------- */
console.log('\n[7] 内置参数 sys-v2026.3');
ok('版本号', PARAMS.meta.versionId === 'sys-v2026.3');
ok('三档含 q+M（无旧 bufferQ/bufferE）', PARAMS.tiers.every(t => t.M != null && t.bufferQ == null));
ok('情景含 rtFactor/loadError/allocShare/refundShare', PARAMS.scenarios.every(s => s.rtFactor != null && s.loadError != null && s.allocShare != null && s.refundShare != null));
ok('costModel 含代理模式/准备金/门槛/审批', PARAMS.costModel && PARAMS.costModel.procurementMode === 'standard_proxy' && PARAMS.costModel.riskThresholds.approval.ok === true);
ok('到户账单层 7 项且默认 pass', PARAMS.billLayer.length === 7 && PARAMS.billLayer.every(b => b.bearer === 'pass'));

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
const r8 = Calc.computeQuote({ q: q8760, W: 372, wLt: 372, coverageRatio: 0.9, K: 1.08, params: PARAMS });
ok('三档产出且为正', r8.tiers.every(t => isFinite(t.Pping) && t.Pping > 0));
ok('三层成本拆分齐全', r8.scenarios.every(s => isFinite(s.Clt) && isFinite(s.Cda) && isFinite(s.Crt)));
ok('含 VaR/CVaR/亏损概率', r8.tiers.every(t => isFinite(t.VaR) && isFinite(t.CVaR) && isFinite(t.lossProb)));
ok('代理配置标识存在', r8.proxy.mode === 'standard_proxy' && /代理/.test(PARAMS.costModel.procurementNote));
console.log('      [参考] K=1.08 时 P平：保守=' + r8.tiers[0].Pping.toFixed(2) + ' 目标=' + r8.tiers[1].Pping.toFixed(2) +
  ' 冲单=' + r8.tiers[2].Pping.toFixed(2) + '；等效价=' + r8.tiers[2].price.toFixed(2) + '；E[C]=' + r8.EC.toFixed(2) +
  '；冲单门槛=' + JSON.stringify(r8.tiers[2].gates));

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
