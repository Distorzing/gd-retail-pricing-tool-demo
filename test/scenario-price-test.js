/* 日前价格 8760 直接导入自测：模板生成/解析/direct 模式 computeQuote
 * 运行：node test/scenario-price-test.js
 */
'use strict';
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'js', 'vendor', 'xlsx.full.min.js'));
const ScenarioPrice = require(path.join(__dirname, '..', 'js', 'scenario-price.js'));
const Calc = require(path.join(__dirname, '..', 'js', 'calc.js'));
const Validator = require(path.join(__dirname, '..', 'js', 'validate.js'));
const PARAMS = require(path.join(__dirname, '..', 'js', 'data.js'));

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failed++; console.log('  FAIL  ' + n + (x ? ' => ' + x : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

const keys = Validator.expectedHourKeys(2026);
const N = keys.length;

/* 1. 模板生成：8760 框架 + 价格列空 */
console.log('\n[1] 模板生成');
const wb = ScenarioPrice.buildScenarioTemplate(2026);
ok('包含「导入说明」「日前价格」', wb.SheetNames.join(',') === '导入说明,日前价格');
const grid = XLSX.utils.sheet_to_json(wb.Sheets['日前价格'], { header: 1, raw: true, defval: '' });
ok('8760 行数据 + 表头', grid.length === N + 1, grid.length);
ok('首行=2026-01-01|0，末行=2026-12-31|23', grid[1][0] === '2026-01-01' && String(grid[1][1]) === '0' && grid[N][0] === '2026-12-31' && String(grid[N][1]) === '23');
ok('价格列全空', grid.slice(1).every(r => r[2] == null || r[2] === ''));
const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
ok('可写出 xlsx', (buf.byteLength || buf.length) > 1000);

/* 2. 模板 round-trip：竖贴价格一列 → 解析 */
console.log('\n[2] 模板 round-trip');
const md = XLSX.read(buf, { type: 'array' });
const g2 = XLSX.utils.sheet_to_json(md.Sheets['日前价格'], { header: 1, raw: true, defval: '' });
g2.forEach((r, i) => { if (i >= 1) r[2] = 300 + (i % 24) * 5; });   // 竖贴：按小时变化
md.Sheets['日前价格'] = XLSX.utils.aoa_to_sheet(g2);
const res = ScenarioPrice.parseScenarioPrice(XLSX.write(md, { type: 'array', bookType: 'xlsx' }), 2026);
ok('解析成功 8760 点', res.curve && res.curve.length === N, res.errors.join());
ok('无错误', res.errors.length === 0, JSON.stringify(res.errors));
// 竖贴：行 i（1 起）→ keys[i-1]，值 = 300 + (i%24)*5 → curve[t] = 300 + ((t+1)%24)*5
ok('首值=305（i=1→0时），08时=345', res.curve[0] === 305 && res.curve[8] === 345, res.curve[0] + ',' + res.curve[8]);
ok('年末值对齐（8760%24=0→300）', res.curve[N - 1] === 300);

/* 3. 三列带日期时刻（用户文件格式）解析 */
console.log('\n[3] 三列带日期时刻解析');
const rows = [['日期', '时点', '日前价格']];
keys.forEach(k => rows.push([k.slice(0, 10), k.slice(11, 13) + ':00', 250]));
const wb3 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb3, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
const res3 = ScenarioPrice.parseScenarioPrice(XLSX.write(wb3, { type: 'array', bookType: 'xlsx' }), 2026);
ok('三列格式解析成功', res3.curve && res3.curve.length === N && res3.errors.length === 0);
ok('全部=250', res3.curve.every(v => v === 250));

/* 4. 真实用户文件 round-trip（若存在） */
console.log('\n[4] 真实用户文件');
const fs = require('fs');
const userFile = '/Users/wai/Downloads/图表数据_20260804164943.xlsx';
if (fs.existsSync(userFile)) {
  const bytes = fs.readFileSync(userFile);
  const res4 = ScenarioPrice.parseScenarioPrice(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 2026);
  ok('用户文件解析成功 8760 点', res4.curve && res4.curve.length === N, res4.errors.join());
  ok('均值 ≈ 347.37', near(res4.curve.reduce((a, b) => a + b, 0) / N, 347.37, 0.5));
  ok('负价小时=76', res4.negHours === 76, res4.negHours);
} else { ok('用户文件存在（跳过）', true); }

/* 5. 错误处理 */
console.log('\n[5] 错误处理');
const wb5 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb5, XLSX.utils.aoa_to_sheet([['日期', '时刻', '价格'], ['2026-01-01', '0', 100], ['2026-01-01', '1', 100]]), 'S');
const res5 = ScenarioPrice.parseScenarioPrice(XLSX.write(wb5, { type: 'array', bookType: 'xlsx' }), 2026);
ok('不足 8760 → 报错', res5.curve == null && res5.errors.length > 0);

/* 6. direct 模式 computeQuote：P_DA 原值，不按 W 标定 */
console.log('\n[6] direct 模式 computeQuote');
const qUni = new Array(N).fill(1);
const gNorm = Calc.normalize(PARAMS.baseline.curve);
const priceCurve = keys.map((k, t) => 400 + Math.sin(t / 100) * 50);
const mkParams = mode => ({
  ...PARAMS,
  wholesaleCurves: [],
  scenarios: [{ id: 'T', name: '测试情景', weight: 1, priceMode: mode, priceFactor: 1, allocShare: 0, refundShare: 0, sr: 0, o: 0, curve: priceCurve }]
});
// direct：Cda = Σ gap×curve/Q（缺口加权，曲线 g 均价 ~400）；标定：Cda = Σ gap×cal/Q（cal g 均价 = W=500）
const rD = Calc.computeQuote({ q: qUni, keys, W: 500, wLt: 380, K: 1, params: mkParams('direct') });
const cdaD = rD.scenarios[0].Cda;
ok('direct 模式 calibK=1（V4 不缩放）', rD.scenarios[0].calibK === 1);
ok('direct 模式 W_da=曲线加权均价（≠W）', Math.abs(rD.scenarios[0].W_da - 500) > 1);
const rC = Calc.computeQuote({ q: qUni, keys, W: 500, wLt: 380, K: 1, params: mkParams(undefined) });
// 缺口相同 → Cda 比例 = 两曲线 g 加权均价之比 ≈ 400/500
const ratio = cdaD / rC.scenarios[0].Cda;
ok('direct/标定 Cda 比例 ≈ 直接均价/W 均价（≈0.8，V4 原值）', ratio > 0.75 && ratio < 0.85, ratio.toFixed(4));
ok('direct Cda < 标定 Cda（V4 原值）', cdaD < rC.scenarios[0].Cda);

/* 7. 内置参数已为单情景 direct */
console.log('\n[7] 内置参数');
ok('内置情景=1 条 direct', PARAMS.scenarios.length === 1 && PARAMS.scenarios[0].priceMode === 'direct');
ok('内置情景 weight=1（合计 100%）', Math.abs(PARAMS.scenarios[0].weight - 1) < 1e-9);
ok('内置情景 curve=8760', PARAMS.scenarios[0].curve.length === N);

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
