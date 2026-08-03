/* xlsx 导入模块自测：多种工作簿结构 → TSV → 8760 校验
 * 运行：node test/xlsx-import-test.js
 */
'use strict';
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'js', 'vendor', 'xlsx.full.min.js'));
const Validator = require(path.join(__dirname, '..', 'js', 'validate.js'));
const XlsxImport = require(path.join(__dirname, '..', 'js', 'xlsx-import.js'));

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? ' => ' + extra : '')); }
};

const keys = Validator.expectedHourKeys(2026);
function bufOf(wb) { return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }); }
function buildWb(aoa, sheetName, extraSheets) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName || 'Sheet1');
  (extraSheets || []).forEach(([n, a]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(a), n));
  return wb;
}
function check8760(tsv) { return Validator.validate8760(Validator.parseCurveText(tsv).rows, 2026); }

/* 1. 标准 3 列 + 表头（文本日期） */
console.log('\n[1] 标准 3 列（文本日期 + 表头）');
let aoa = [['日期', '时刻', '用电量(kWh)']];
keys.forEach(k => aoa.push([k.slice(0, 10), +k.slice(11), 1234.5]));
let r = XlsxImport.workbookToTSV(bufOf(buildWb(aoa, '8760曲线')));
ok('识别 8760 行', r.rowCount === 8760, 'rows=' + r.rowCount);
ok('选中正确工作表', r.sheetName === '8760曲线');
ok('TSV 通过 8760 校验', check8760(r.tsv).ok);

/* 2. Excel 真日期（序列号）+ 数值时刻 */
console.log('\n[2] Excel 日期序列号');
aoa = [['日期', '时刻', '用电量']];
keys.forEach(k => aoa.push([new Date(k.slice(0, 10) + 'T00:00:00Z'), +k.slice(11), 100]));
r = XlsxImport.workbookToTSV(bufOf(buildWb(aoa)));
ok('日期序列正确解析', r.rowCount === 8760 && check8760(r.tsv).ok, 'rows=' + r.rowCount);

/* 3. 两列：日期时间合一 + 用电量 */
console.log('\n[3] 两列（日期时间 | 用电量）');
aoa = [['时间', 'kWh']];
keys.forEach(k => aoa.push([k.slice(0, 10) + ' ' + (+k.slice(11)) + ':00', 88.8]));
r = XlsxImport.workbookToTSV(bufOf(buildWb(aoa)));
ok('两列模式识别', r.rowCount === 8760 && check8760(r.tsv).ok, 'rows=' + r.rowCount);

/* 4. 多工作表：数据在第二张表 */
console.log('\n[4] 多工作表（数据在第二张）');
const small = [['说明'], ['本表只有几行']];
aoa = [['日期', '时刻', '用电量']];
keys.forEach(k => aoa.push([k.slice(0, 10), +k.slice(11), 50]));
r = XlsxImport.workbookToTSV(bufOf(buildWb(aoa, '曲线数据', [['封面', small]])));
ok('自动选择行数最多的表', r.sheetName === '曲线数据' && r.rowCount === 8760);
ok('通过 8760 校验', check8760(r.tsv).ok);

/* 5. 1–24 时刻制（经 validate 转换） */
console.log('\n[5] 1–24 时刻制');
aoa = [['日期', '时刻', '用电量']];
keys.forEach(k => aoa.push([k.slice(0, 10), +k.slice(11) + 1, 60]));
r = XlsxImport.workbookToTSV(bufOf(buildWb(aoa)));
const v5 = check8760(r.tsv);
ok('1–24 制转换后通过', v5.ok && v5.warnings.length === 1);

/* 6. 无效文件报错（中文说明） */
console.log('\n[6] 错误处理');
let threw = false, msg = '';
try { XlsxImport.workbookToTSV(new TextEncoder().encode('not an xlsx').buffer); } catch (e) { threw = true; msg = e.message; }
ok('非工作簿内容给出中文错误', threw && /[一-龥]/.test(msg), msg);

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
