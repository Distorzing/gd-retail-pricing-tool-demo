/* Node 自测：按需求包验收标准逐项验证（V1.4「中长期+日前」两部制口径）。
 * 运行：node test/selftest.js
 */
'use strict';
const path = require('path');
const Calc = require(path.join(__dirname, '..', 'js', 'calc.js'));
const Validator = require(path.join(__dirname, '..', 'js', 'validate.js'));
const PARAMS = require(path.join(__dirname, '..', 'js', 'data.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  => ' + extra : '')); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }

/* ---------- 1. 手算可核对的小型算例（4 小时，两部制） ---------- */
console.log('\n[1] 核心公式手算核对（4小时算例）');
const K4 = ['2026-01-01|00', '2026-01-01|01', '2026-01-01|02', '2026-01-01|03'];
const mini = {
  meta: { hours: 4 }, baseline: { curve: [0.25, 0.25, 0.25, 0.25] },
  defaults: { coverageRatio: 0.5 },
  wholesaleCurves: [],
  scenarios: [{
    id: 'S1', name: '单一情景', weight: 1, priceFactor: 1,
    allocShare: 2, refundShare: 1, sr: 3, o: 2, curve: [100, 200, 300, 400]
  }],
  costModel: { procurementMode: 'standard_proxy', reservePerMwh: 0, riskThresholds: { varAlpha: 0.95, minGrossMargin: 3, maxLossProbPct: 35, maxCvar: 8 } },  // V2 起删准备金
  tiers: [
    { key: 'conservative', name: '保守价', q: 0.95, M: 20 },
    { key: 'target', name: '目标价', q: 0.90, M: 10 },
    { key: 'target', name: '微利价', q: 0.90, M: 5, recommended: true }
  ],
  redLines: {}
};
// Q=10，默认假设 purchase=1.25×4（r0=0.5，价格240）；Clt=120；gap=[0,0.75,1.75,2.75]
// Cda=177.5；C总=303.5
const r1 = Calc.computeQuote({ q: [1, 2, 3, 4], keys: K4, W: 250, wLt: 240, K: 1, params: mini });
ok('Q=10', near(r1.Q, 10));
ok('标定系数 k=1（W 恰为统调加权均价）', near(r1.scenarios[0].calibK, 1));
ok('Clt=120（默认假设 r0×W_LT）', near(r1.scenarios[0].Clt, 120));
ok('Cda=177.5（日前缺口层）', near(r1.scenarios[0].Cda, 177.5));
ok('C总=C批发+SR+O=303.5（V2 删准备金）', near(r1.scenarios[0].Ctotal, 303.5));
ok('保守价=(C95+20)/K=323.5', near(r1.tiers[0].price, 323.5));
ok('目标价=(C90+10)/K=313.5', near(r1.tiers[1].price, 313.5));
ok('微利价=(C90+5)/K=308.5', near(r1.tiers[2].price, 308.5));
ok('冲单预期利润=5', near(r1.tiers[2].expectedProfit, 5));
ok('元/度=元/MWh ÷1000', near(Calc.unit.toYuanPerKwh(308.5), 0.3085));
ok('分/度=元/MWh ÷10', near(Calc.unit.toFenPerKwh(308.5), 30.85));

/* ---------- 2. 加权分位数 ---------- */
console.log('\n[2] 加权分位数 Cq（成本升序累计权重首次达 q）');
const items = [{ cost: 300, weight: 0.2 }, { cost: 100, weight: 0.3 }, { cost: 200, weight: 0.5 }];
ok('C30=100', near(Calc.weightedQuantile(items, 0.30), 100));
ok('C50=200（累计0.8首次≥0.5）', near(Calc.weightedQuantile(items, 0.50), 200));
ok('C80=200', near(Calc.weightedQuantile(items, 0.80), 200));
ok('C90=300', near(Calc.weightedQuantile(items, 0.90), 300));
ok('C95=300', near(Calc.weightedQuantile(items, 0.95), 300));

/* ---------- 3. 输入校验 ---------- */
console.log('\n[3] 输入校验');
const badW = JSON.parse(JSON.stringify(mini)); badW.scenarios[0].weight = 0.5;
let threw = false;
try { Calc.computeQuote({ q: [1, 2, 3, 4], keys: K4, W: 250, wLt: 240, K: 1, params: badW }); } catch (e) { threw = /权重/.test(e.message); }
ok('情景权重合计≠100% 时抛错阻止', threw);
threw = false;
try { Calc.computeQuote({ q: [1, 2, 3, 4], keys: K4, W: 0, wLt: 240, K: 1, params: mini }); } catch (e) { threw = true; }
ok('W≤0 阻止', threw);
threw = false;
try { Calc.computeQuote({ q: [1, 2, 3, 4], keys: K4, W: 250, wLt: 0, K: 1, params: mini }); } catch (e) { threw = true; }
ok('中长期均价≤0 阻止', threw);
threw = false;
try { Calc.computeQuote({ q: [1, 2, 3, 4], keys: K4, W: 250, wLt: 240, K: 0, params: mini }); } catch (e) { threw = true; }
ok('K≤0 阻止', threw);

/* ---------- 4. 归一化 ---------- */
console.log('\n[4] 统调曲线归一化');
ok('和为100自动归一', near(Calc.normalize([25, 25, 25, 25]).reduce((a, b) => a + b, 0), 1));
ok('和为1保持不变', near(Calc.normalize([0.25, 0.25, 0.25, 0.25])[0], 0.25));

/* ---------- 5. 8760 校验 ---------- */
console.log('\n[5] 8760 曲线校验');
function makeGoodRows() {
  const rows = [];
  for (const key of Validator.expectedHourKeys(2026)) {
    const [d, h] = key.split('|');
    rows.push({ date: d, hour: +h, value: 100, line: 0 });
  }
  return rows;
}
const good = Validator.validate8760(makeGoodRows(), 2026);
ok('完整 8760 通过', good.ok && good.series.values.length === 8760);
ok('全年电量合计正确', near(good.stats.Q, 876000));
let rows = makeGoodRows(); rows.splice(100, 1);
let v = Validator.validate8760(rows, 2026);
ok('缺失1点 → 阻止', !v.ok && v.missingCount === 1);
rows = makeGoodRows(); rows.push({ date: '2026-01-01', hour: 0, value: 5, line: 0 });
v = Validator.validate8760(rows, 2026);
ok('重复点 → 阻止', !v.ok && v.anomalies.duplicates.length === 1);
rows = makeGoodRows(); rows[50].value = -3;
v = Validator.validate8760(rows, 2026);
ok('负值 → 阻止', !v.ok && v.anomalies.negatives.length === 1);
rows = makeGoodRows(); rows[0].date = '2027-01-01';
v = Validator.validate8760(rows, 2026);
ok('年度外日期 → 阻止', !v.ok && v.anomalies.outOfYear.length === 1 && v.missingCount === 1);

/* ---------- 6. 文本解析 ---------- */
console.log('\n[6] 曲线文本解析');
const sample = '日期\t时刻\t用电量\n2026-01-01\t0\t123.4\n2026-01-01\t1\t56\n2026/1/2\t2\t78';
const pr = Validator.parseCurveText(sample);
ok('跳过表头并解析3行', pr.headerSkipped && pr.rows.length === 3 && pr.rows[0].value === 123.4 && pr.rows[2].date === '2026-01-02');
const bad = Validator.parseCurveText('2026-01-01\tabc\t10');
ok('时刻无法识别 → 记入异常', bad.rows.length === 0 && bad.skipped.length === 1);
const h24 = Validator.validate8760(makeGoodRows().map(r => ({ ...r, hour: r.hour + 1 })), 2026);
ok('1–24 时刻制自动转换并留痕', h24.ok && h24.warnings.length === 1);

/* ---------- 7. 内置参数全量算例（8760，默认假设路径） ---------- */
console.log('\n[7] 内置参数 8760 全量算例');
ok('统调曲线 8760 点', PARAMS.baseline.curve.length === 8760);
ok('统调曲线归一化合计=1', near(PARAMS.baseline.curve.reduce((a, b) => a + b, 0), 1, 1e-9));
ok('三个情景各 8760 点', PARAMS.scenarios.every(s => s.curve.length === 8760));
ok('情景权重合计=100%', near(PARAMS.scenarios.reduce((a, s) => a + s.weight, 0), 1, 1e-9));

const keys = Validator.expectedHourKeys(2026);
const q8760 = keys.map(k => {
  const h = +k.slice(11); const day = new Date(k.slice(0, 10) + 'T00:00:00Z').getUTCDay();
  const wd = (day >= 1 && day <= 5) ? 1 : 0.55;
  const shape = (h >= 8 && h <= 11) || (h >= 14 && h <= 17) ? 2.2 : (h >= 19 && h <= 21 ? 1.5 : (h < 6 ? 0.4 : 1.0));
  return 2 * wd * shape;
});
const p7 = JSON.parse(JSON.stringify(PARAMS)); p7.wholesaleCurves = [];   // 默认假设路径需清空内置采购曲线
const r7 = Calc.computeQuote({ q: q8760, keys, W: 372, wLt: 372, K: 1, params: p7 });
ok('全量计算产出三档价', r7.tiers.length === 3 && r7.tiers.every(t => isFinite(t.price) && t.price > 0));
ok('每档含 Cq/M/P平 与 VaR/CVaR', r7.tiers.every(t => isFinite(t.Cq) && isFinite(t.M) && isFinite(t.Pping) && isFinite(t.VaR) && isFinite(t.CVaR)));
ok('目标价=Cq+10', near(r7.tiers[2].price, r7.tiers[2].Cq + 10));
ok('各情景利润=等效价−全成本', r7.tiers[2].perScenarioProfit.every(p => near(p.profit, r7.tiers[2].price - r7.scenarios.find(s => s.id === p.id).Ctotal)));
ok('亏损概率与最差利润已计算', isFinite(r7.tiers[2].lossProb) && isFinite(r7.tiers[2].worstProfit));
ok('默认假设路径（r0=0.9）', r7.procurement.isDefault === true && near(r7.procurement.coverage, 0.9));
console.log('      [参考] 三档等效价 元/MWh：保守=' + r7.tiers[0].price.toFixed(2) +
  ' 目标=' + r7.tiers[1].price.toFixed(2) + ' 冲单=' + r7.tiers[2].price.toFixed(2) +
  '；E[C]=' + r7.EC.toFixed(2) + '；覆盖率=' + (r7.procurement.coverage * 100).toFixed(0) + '%（默认假设）');
const r7c = Calc.computeQuote({ q: q8760, keys, W: 400, wLt: 390, K: 1, params: p7 });
ok('修改 W/W_LT 结果同步变化', !near(r7c.tiers[2].price, r7.tiers[2].price));

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
