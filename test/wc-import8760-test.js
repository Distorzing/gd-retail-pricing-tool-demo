/* 批发曲线 8760 逐时直导自测：三列/四列解析、缺小时、去重、覆盖计算
 * 运行：node test/wc-import8760-test.js
 */
'use strict';
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'js', 'vendor', 'xlsx.full.min.js'));
const WcImport8760 = require(path.join(__dirname, '..', 'js', 'wc-import8760.js'));
const Calc = require(path.join(__dirname, '..', 'js', 'calc.js'));
const Validator = require(path.join(__dirname, '..', 'js', 'validate.js'));

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failed++; console.log('  FAIL  ' + n + (x ? ' => ' + x : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

const keys = Validator.expectedHourKeys(2026);
const N = keys.length;
const qUni = new Array(N).fill(1);
const gUni = new Array(N).fill(1 / N);

function wb(rows) {
  const w = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(rows), 'S');
  return XLSX.write(w, { type: 'array', bookType: 'xlsx' });
}

/* 1. 四列（日期|时刻|电量|价格） */
console.log('\n[1] 四列解析');
const rows4 = [['日期', '时刻', '电量(MWh)', '价格(元/MWh)']];
keys.slice(0, 48).forEach(k => rows4.push([k.slice(0, 10), +k.slice(11, 13), 10, 372]));
const r1 = WcImport8760.parseWholesale8760(wb(rows4), 2026, null);
ok('解析 48 小时', r1.entries && r1.entries.length === 48, r1.errors.join());
ok('priceMode=perEntry', r1.priceMode === 'perEntry');
ok('首键=2026-01-01|00，末键=2026-01-02|23', r1.stats.firstKey === '2026-01-01|00' && r1.stats.lastKey === '2026-01-02|23');
ok('加权均价=372', near(r1.stats.weightedPrice, 372));
ok('总电量=480', near(r1.stats.totalMwh, 480));

/* 2. 三列（日期|时刻|电量）+ 统一价 */
console.log('\n[2] 三列 + 统一价');
const rows3 = [['日期', '时刻', '电量(MWh)']];
keys.slice(100, 124).forEach(k => rows3.push([k.slice(0, 10), k.slice(11, 13) + ':00', 8]));
const r2 = WcImport8760.parseWholesale8760(wb(rows3), 2026, 372);
ok('解析 24 小时', r2.entries && r2.entries.length === 24, r2.errors.join());
ok('priceMode=flat，flatPrice=372', r2.priceMode === 'flat' && r2.flatPrice === 372);
ok('价格全部回填 372', r2.entries.every(e => e.priceYuanPerMwh === 372));

/* 3. 三列缺统一价 → 报错 */
console.log('\n[3] 三列缺统一价');
const r3 = WcImport8760.parseWholesale8760(wb(rows3), 2026, null);
ok('无统一价 → 报错', r3.entries == null && r3.errors.length > 0, JSON.stringify(r3.errors));

/* 4. 缺小时（只给部分）→ 允许，覆盖逻辑进日前 */
console.log('\n[4] 缺小时 + 覆盖');
const rows4b = [['日期', '时刻', '电量(MWh)', '价格(元/MWh)']];
['2026-03-01|08', '2026-03-01|10', '2026-06-15|18'].forEach(k => rows4b.push([k.slice(0, 10), +k.slice(11, 13), 5, 400]));
const r4 = WcImport8760.parseWholesale8760(wb(rows4b), 2026, null);
ok('3 小时部分覆盖', r4.entries.length === 3 && r4.stats.hours === 3);
const curves = [{ id: 'x', name: 't', status: 'locked', enabled: true, createdAt: '2026-01-01', year: 2026,
  window: { from: '01-01', to: '12-31' }, granularity: 'day_hour', quantityMode: 'mwh', priceMode: 'perEntry', flatPrice: null, entries: r4.entries }];
const proc = Calc.buildProcurement(curves, qUni, keys, gUni, {});
ok('03-01 08时覆盖（400）', near(proc.price[keys.indexOf('2026-03-01|08')], 400));
ok('03-01 09时无覆盖（进日前）', proc.price[keys.indexOf('2026-03-01|09')] == null);
ok('06-15 18时覆盖（400）', near(proc.price[keys.indexOf('2026-06-15|18')], 400));

/* 5. 重复行去重（后出现覆盖） */
console.log('\n[5] 去重');
const rows5 = [['日期', '时刻', '电量', '价格'],
  ['2026-01-01', 0, 10, 300], ['2026-01-01', 0, 20, 350]];
const r5 = WcImport8760.parseWholesale8760(wb(rows5), 2026, null);
ok('重复小时去重（后值 20/350）', r5.entries.length === 1 && r5.entries[0].quantityMwh === 20 && r5.entries[0].priceYuanPerMwh === 350);

/* 6. 错误处理：负电量/无有效行/日期超出年度 */
console.log('\n[6] 错误处理');
const rows6 = [['日期', '时刻', '电量', '价格'], ['2026-01-01', 0, -5, 300]];
const r6 = WcImport8760.parseWholesale8760(wb(rows6), 2026, null);
ok('负电量 → 报错不产出', r6.entries == null && r6.errors.length > 0);
const rows6b = [['日期', '时刻', '电量'], ['2025-06-01', 0, 10]];
const r6b = WcImport8760.parseWholesale8760(wb(rows6b), 2026, 372);
ok('日期超出年度（2025）→ 无有效行报错', r6b.entries == null && r6b.errors.length > 0);

/* 7. Excel 序列号日期 + 时刻文本 */
console.log('\n[7] Excel 序列号日期');
const serial = (Date.UTC(2026, 6, 15) - Date.UTC(1899, 11, 30)) / 86400000;
const rows7 = [['日期', '时刻', '电量', '价格'], [serial, '08:00', 12, 410]];
const r7 = WcImport8760.parseWholesale8760(wb(rows7), 2026, null);
ok('序列号日期+文本时刻识别', r7.entries.length === 1 && r7.entries[0].timeKey === '2026-07-15|08', JSON.stringify(r7.entries));

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
