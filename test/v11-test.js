/* V1.1 峰谷功能自测：时段聚合、K 与峰平谷价、系数匹配、深圳终端表、风险单列
 * 运行：node test/v11-test.js
 */
'use strict';
const path = require('path');
const Calc = require(path.join(__dirname, '..', 'js', 'calc.js'));
const PARAMS = require(path.join(__dirname, '..', 'js', 'data.js'));

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failed++; console.log('  FAIL  ' + n + (x ? ' => ' + x : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);

const PV = PARAMS.peakValley;

/* ---------- 1. 时段聚合 ---------- */
console.log('\n[1] 峰谷时段聚合');
const keys = ['2026-01-01|03', '2026-01-01|08', '2026-07-10|11', '2026-07-10|15', '2026-01-02|18', '2026-01-02|20'];
const q = [10, 20, 30, 40, 50, 60];
const sh = Calc.tofuAggregate(q, keys, PV.hourTable.gd, PV.sharp);
ok('Q谷=10（03时）', near(sh.Qv, 10));
ok('Q平=80（08时+20时）', near(sh.Qf, 80));
ok('Q峰=120（11/15/18时）', near(sh.Qp, 120));
ok('α合计=1', near(sh.ap + sh.af + sh.av, 1));
ok('尖峰电量=70（7月11时+15时）', near(sh.Qsharp, 70), sh.Qsharp);

/* ---------- 2. K 与峰平谷价格组 ---------- */
console.log('\n[2] K、P平/P峰/P谷与收入恒等');
// α=(0.3,0.4,0.3)，f1=1.7，f2=0.38，P等效=377.36，Q=11198.6
const shares2 = { ap: 0.3, af: 0.4, av: 0.3, Q: 11198.6 };
const pv2 = Calc.peakValleyPrices(377.36, shares2, 1.7, 0.38);
ok('K=1.7×0.3+0.4+0.38×0.3=1.024', near(pv2.K, 1.024));
ok('P平=P等效/K', near(pv2.Pping, 377.36 / 1.024));
ok('P峰=f1×P平', near(pv2.Pfeng, 1.7 * 377.36 / 1.024));
ok('P谷=f2×P平', near(pv2.Pgu, 0.38 * 377.36 / 1.024));
ok('收入=Q×P平×K=Q×P等效', near(pv2.revenue, 11198.6 * 377.36, 1e-6));

/* ---------- 3. 零售结算层系数匹配 ---------- */
console.log('\n[3] 系数匹配（含禁止推断与重叠冲突）');
const base = { area: 'gd', pvPolicy: 'yes', lowVoltage: 'no', iceStorage: 'no', contractMode: 'pv' };
ok('非深圳原峰谷 → 1.70/0.38', Calc.matchRetailCoeff(base, PV.retailCoeffs).row.id === 'gd_other');
ok('深圳 → 1.53/0.32', Calc.matchRetailCoeff({ ...base, area: 'sz' }, PV.retailCoeffs).row.id === 'sz');
ok('深圳增量配网 → 同深圳口径', Calc.matchRetailCoeff({ ...base, area: 'sz_inc' }, PV.retailCoeffs).row.id === 'sz');
ok('深圳低压 → 1.3553/0.2894', Calc.matchRetailCoeff({ ...base, area: 'sz', lowVoltage: 'yes' }, PV.retailCoeffs).row.id === 'sz_lv');
ok('蓄冷 → 1.65/0.25', Calc.matchRetailCoeff({ ...base, iceStorage: 'yes' }, PV.retailCoeffs).row.id === 'ice');
const cf = Calc.matchRetailCoeff({ ...base, area: 'sz', lowVoltage: 'yes', iceStorage: 'yes' }, PV.retailCoeffs);
ok('深圳低压+蓄冷 → conflict 且给两组候选', cf.status === 'conflict' && cf.candidates.length === 2);
ok('非原峰谷 → na 不进入机制', Calc.matchRetailCoeff({ ...base, pvPolicy: 'no' }, PV.retailCoeffs).status === 'na');
ok('峰谷状态待核验 → pending', Calc.matchRetailCoeff({ ...base, pvPolicy: 'unknown' }, PV.retailCoeffs).status === 'pending');
ok('蓄冷待核验 → pending', Calc.matchRetailCoeff({ ...base, iceStorage: 'unknown' }, PV.retailCoeffs).status === 'pending');
ok('全时段同价合同 → na', Calc.matchRetailCoeff({ ...base, contractMode: 'flat' }, PV.retailCoeffs).status === 'na');

/* ---------- 4. 深圳第二层终端比价表 ---------- */
console.log('\n[4] 深圳终端比价表查询');
const uc4 = { area: 'sz', category: '普通工商业及其他', voltage: '10kV', metering: '高供低计', capacityKva: 0 };
ok('普通工商业+10kV高供低计 → 1.3553/0.2894', Calc.szTerminalLookup(uc4, PV.szTerminal).row.f1 === 1.3553);
ok('普通工商业+10kV高供高计 → 无匹配', Calc.szTerminalLookup({ ...uc4, metering: '高供高计' }, PV.szTerminal).row === null);
const big = Calc.szTerminalLookup({ area: 'sz', category: '大量工商业及其他（101–3000kVA）', voltage: '220kV及以上', metering: '高供高计', capacityKva: 2000 }, PV.szTerminal);
ok('大量+220kV及以上 → 1.5901/0.2568', big.row && big.row.f1 === 1.5901 && big.row.f2 === 0.2568);
const mis = Calc.szTerminalLookup({ area: 'sz', category: '高需求工商业及其他（≥3001kVA）', voltage: '10kV', metering: '高供高计', capacityKva: 2000 }, PV.szTerminal);
ok('容量与类别矛盾 → 预警', mis.warns && mis.warns.length === 1);
ok('增量配网 → 不含提示', /增量配电网/.test(Calc.szTerminalLookup({ area: 'sz_inc' }, PV.szTerminal).note));

/* ---------- 5. 峰谷风险单列 ---------- */
console.log('\n[5] 峰谷原始暴露与尖峰加价手算');
// W=372, Q峰=100, Q谷=50, f1=1.7, f2=0.38, Q尖=30, Q=1000
const shares5 = { Qp: 100, Qv: 50, Q: 1000, Qsharp: 30 };
const rk = Calc.peakValleyRisks({ W: 372, shares: shares5, f1: 1.7, f2: 0.38, sharpCfg: PV.sharp, riskDefaults: PV.riskDefaults });
ok('C峰谷原始=372×[0.7×100−0.62×50]=14508', near(rk.exposureTotal, 372 * (0.7 * 100 - 0.62 * 50)), rk.exposureTotal);
ok('折算度电=14.508 元/MWh', near(rk.exposurePerMwh, 14.508));
ok('尖峰电能量=372×1.7×0.25×30=4743', near(rk.sharpEnergy, 372 * 1.7 * 0.25 * 30), rk.sharpEnergy);
ok('尖峰输配（默认单价0）=0', near(rk.sharpTnd, 0));
ok('系统运行费/市场分摊默认=0', near(rk.sysOpFee, 0) && near(rk.marketShare, 0));

/* ---------- 6. 内置参数完整性 ---------- */
console.log('\n[6] 内置参数 sys-v2026.2 完整性');
ok('版本号 sys-v2026.3', PARAMS.meta.versionId === 'sys-v2026.3');
ok('4 组零售系数', PV.retailCoeffs.length === 4);
ok('深圳终端表 11 行', PV.szTerminal.rows.length === 11);
ok('时段表峰谷不重叠且 ≤24 小时', (() => {
  const p = new Set(PV.hourTable.gd.peak), v = new Set(PV.hourTable.gd.valley);
  const all = new Set([...p, ...v]);
  return p.size + v.size === all.size && all.size <= 24;
})());
ok('含 3 条官方来源链接', PV.sources.length === 3 && PV.sources.every(s => /^https?:/.test(s.url)));
ok('规则版本与生效日期存在', !!PV.ruleVersion && !!PV.effectiveDate);

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
