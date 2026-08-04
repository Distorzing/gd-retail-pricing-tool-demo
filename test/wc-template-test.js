/* 批发曲线 Excel 模板 v3·单粒度文件 自测：三个独立模板（年分月/月分日/日分时）生成→导入→覆盖
 * 运行：node test/wc-template-test.js
 */
'use strict';
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'js', 'vendor', 'xlsx.full.min.js'));
const WcTemplate = require(path.join(__dirname, '..', 'js', 'wc-template.js'));
const Calc = require(path.join(__dirname, '..', 'js', 'calc.js'));
const Validator = require(path.join(__dirname, '..', 'js', 'validate.js'));

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failed++; console.log('  FAIL  ' + n + (x ? ' => ' + x : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

const keys = Validator.expectedHourKeys(2026);
const N = keys.length;
const qUni = new Array(N).fill(1);
const gUni = new Array(N).fill(1 / N);
const fmtD = v => new Date(Math.round(v * 86400000) + Date.UTC(1899, 11, 30)).toISOString();

/* 1. 三个独立模板生成（各自只有 导入说明 + 本粒度子表） */
console.log('\n[1] 单粒度模板生成');
const wbYm = WcTemplate.buildTemplateWorkbook(2026, 'year_month');
ok('年分月模板：仅「导入说明」「年分月」', wbYm.SheetNames.join(',') === '导入说明,年分月', wbYm.SheetNames.join(','));
const ymGrid = XLSX.utils.sheet_to_json(wbYm.Sheets['年分月'], { header: 1, raw: true, defval: '', blankrows: true });
ok('年分月：12 行月份框架', ymGrid.filter(r => /^(0[1-9]|1[0-2])$/.test(String(r[0]))).length === 12);

const wbMd = WcTemplate.buildTemplateWorkbook(2026, 'month_day');
ok('月分日模板：仅「导入说明」「月分日」', wbMd.SheetNames.join(',') === '导入说明,月分日', wbMd.SheetNames.join(','));
const mdGrid = XLSX.utils.sheet_to_json(wbMd.Sheets['月分日'], { header: 1, raw: true, defval: '', blankrows: true });
ok('月分日：B2=03,06，6段×31行=190行', String(mdGrid[1][1]) === '03,06' && mdGrid.length === 4 + 186, mdGrid.length);
ok('月分日日期列=公式+缓存值', Object.keys(wbMd.Sheets['月分日']).some(k => {
  const c = wbMd.Sheets['月分日'][k];
  return c && c.f && c.f.indexOf('IFERROR(TEXT(DATE(2026,VALUE(TRIM(MID') >= 0 && c.z === 'mm-dd' && typeof c.v === 'number';
}));
const A5 = wbMd.Sheets['月分日']['A5'], A36 = wbMd.Sheets['月分日']['A36'];
ok('缓存值：段1首=03-01，段2首=06-01', fmtD(A5.v).slice(5, 10) === '03-01' && fmtD(A36.v).slice(5, 10) === '06-01');

const wbDh = WcTemplate.buildTemplateWorkbook(2026, 'day_hour');
ok('日分时模板：仅「导入说明」「日分时」', wbDh.SheetNames.join(',') === '导入说明,日分时', wbDh.SheetNames.join(','));
const dhGrid = XLSX.utils.sheet_to_json(wbDh.Sheets['日分时'], { header: 1, raw: true, defval: '', blankrows: true });
ok('日分时：B2 两日期，4段×24行=100行', dhGrid.length === 4 + 96 && String(dhGrid[1][1]).split(',').length === 2);
const dhA5 = wbDh.Sheets['日分时']['A5'], dhA29 = wbDh.Sheets['日分时']['A29'];
ok('日分时缓存值：段1首=07-15 00时，段2首=07-20 00时', fmtD(dhA5.v).slice(5, 13) === '07-15T00' && fmtD(dhA29.v).slice(5, 13) === '07-20T00');

// 旧调用兼容：buildTemplateWorkbook(2026) 仍生成全部子表
const wbAll = WcTemplate.buildTemplateWorkbook(2026);
ok('兼容：无粒度参数 → 全部子表', wbAll.SheetNames.join(',') === '导入说明,年分月,月分日,日分时');
ok('模板无覆盖率列', !WcTemplate.HEADERS.includes('覆盖率(%)'));

/* 2. 月分日单文件：3 月表贴段 1、6 月表贴段 2（竖贴两列）→ 导入只产该粒度曲线 */
console.log('\n[2] 月分日单文件导入');
const bufMd = XLSX.write(wbMd, { type: 'array', bookType: 'xlsx' });
const md = XLSX.read(bufMd, { type: 'array' });
let g = XLSX.utils.sheet_to_json(md.Sheets['月分日'], { header: 1, raw: true, defval: '', blankrows: true });
g[0][1] = 'Q1+Q2补采';
g.forEach((r, i) => {
  if (i >= 4 && i <= 6) { r[1] = 100; r[2] = 385; }        // 段1：3月 01~03 日
  if (i >= 35 && i <= 36) { r[1] = 90; r[2] = 390; }       // 段2：6月 01~02 日
});
md.Sheets['月分日'] = XLSX.utils.aoa_to_sheet(g);
const res = WcTemplate.parseImportWorkbook(XLSX.write(md, { type: 'array', bookType: 'xlsx' }));
ok('解析出 1 条月分日曲线（无其他粒度污染）', res.curves.length === 1 && res.curves[0].granularity === 'month_day', res.curves.length);
ok('无错误', res.errors.length === 0, JSON.stringify(res.errors));
const mdC = res.curves[0];
ok('5 行（3月3天+6月2天），键 2026-03-01..2026-06-02', mdC.entries.length === 5 && mdC.entries[0].timeKey === '2026-03-01' && mdC.entries[4].timeKey === '2026-06-02');
ok('窗口=03-01~06-02', mdC.window.from === '03-01' && mdC.window.to === '06-02');

/* 3. 日分时单文件导入 + 覆盖计算 */
console.log('\n[3] 日分时单文件 + 覆盖');
const bufDh = XLSX.write(wbDh, { type: 'array', bookType: 'xlsx' });
const dh = XLSX.read(bufDh, { type: 'array' });
let dg = XLSX.utils.sheet_to_json(dh.Sheets['日分时'], { header: 1, raw: true, defval: '', blankrows: true });
dg[0][1] = '尖峰修正';
dg.forEach((r, i) => {
  if (i === 4) { r[1] = 5; r[2] = 520; }
  if (i === 4 + 24 + 23) { r[1] = 6; r[2] = 540; }
});
dh.Sheets['日分时'] = XLSX.utils.aoa_to_sheet(dg);
const resD = WcTemplate.parseImportWorkbook(XLSX.write(dh, { type: 'array', bookType: 'xlsx' }));
ok('日分时 2 行跨日（07-15|00、07-20|23）', resD.curves.length === 1 && resD.curves[0].entries.length === 2
  && resD.curves[0].entries[0].timeKey === '2026-07-15|00' && resD.curves[0].entries[1].timeKey === '2026-07-20|23');
ok('窗口=07-15~07-20', resD.curves[0].window.from === '07-15' && resD.curves[0].window.to === '07-20');

const curves = [...res.curves.map((c, i) => ({ ...c, id: 'm' + i, createdAt: '2026-01-01T09:00' })),
  ...resD.curves.map((c, i) => ({ ...c, id: 'd' + i, createdAt: '2026-01-02T09:00' }))];
const proc = Calc.buildProcurement(curves, qUni, keys, gUni, {});
ok('3月2日被月分日覆盖（385）', near(proc.price[keys.indexOf('2026-03-02|10')], 385));
ok('6月2日被月分日覆盖（390）', near(proc.price[keys.indexOf('2026-06-02|10')], 390));
ok('6月3日无覆盖', proc.price[keys.indexOf('2026-06-03|10')] == null);
ok('7月15日00时被日分时覆盖（520）', near(proc.price[keys.indexOf('2026-07-15|00')], 520));
ok('7月20日23时被日分时覆盖（540）', near(proc.price[keys.indexOf('2026-07-20|23')], 540));
ok('7月20日22时无覆盖', proc.price[keys.indexOf('2026-07-20|22')] == null);

/* 4. 错误处理 */
console.log('\n[4] 错误处理');
const wb4 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb4, XLSX.utils.aoa_to_sheet([['曲线名称', ''], [], ['月份(MM)', '电量(MWh)', '价格(元/MWh)', '备注'], ['01', 100, 380, '']]), '年分月');
const res4 = WcTemplate.parseImportWorkbook(XLSX.write(wb4, { type: 'array', bookType: 'xlsx' }));
ok('未命名的子表跳过', res4.curves.length === 0 && res4.errors.length === 0);
const wb5 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb5, XLSX.utils.aoa_to_sheet([
  ['曲线名称', '坏月份'], ['月份(MM，逗号分隔，如 03,06)', '03,'], [], ['日期(MM-DD)', '电量(MWh)', '价格(元/MWh)', '备注'], ['03-01', 50, 400, '']
]), '月分日');
const res5 = WcTemplate.parseImportWorkbook(XLSX.write(wb5, { type: 'array', bookType: 'xlsx' }));
ok('月份列表格式错误 → 报错', res5.curves.length === 0 && res5.errors.length > 0);
const wb6 = XLSX.utils.book_new();
const badRows = [['曲线名称', '缺段'], ['月份(MM，逗号分隔，如 03,06)', '03'], [], ['日期(MM-DD)', '电量(MWh)', '价格(元/MWh)', '备注'], ['01', 50, 400, '']];
for (let i = 0; i < 30; i++) badRows.push(['', '', '', '']);
badRows.push(['02', 50, 400, '']);
XLSX.utils.book_append_sheet(wb6, XLSX.utils.aoa_to_sheet(badRows), '月分日');
const res6 = WcTemplate.parseImportWorkbook(XLSX.write(wb6, { type: 'array', bookType: 'xlsx' }));
ok('第 2 段缺月份 → 段 1 保留 + 报错提示', res6.curves.length === 1 && res6.errors.length > 0, JSON.stringify(res6.errors));
const wb7 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb7, XLSX.utils.aoa_to_sheet([['曲线名称', '缺价'], [], ['月份(MM)', '电量(MWh)', '价格(元/MWh)', '备注'], ['01', 100, null, '']]), '年分月');
const res7 = WcTemplate.parseImportWorkbook(XLSX.write(wb7, { type: 'array', bookType: 'xlsx' }));
ok('缺价格 → 报错不产出', res7.curves.length === 0 && res7.errors.length > 0);
const wb8 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb8, XLSX.utils.aoa_to_sheet([
  ['曲线名称', '2月'], ['月份(MM，逗号分隔，如 03,06)', '02'], [], ['日期(MM-DD)', '电量(MWh)', '价格(元/MWh)', '备注'],
  ['02-30', 50, 400, '']
]), '月分日');
const res8 = WcTemplate.parseImportWorkbook(XLSX.write(wb8, { type: 'array', bookType: 'xlsx' }));
ok('2月30日不存在 → 报错不产出', res8.curves.length === 0 && res8.errors.length > 0);

/* 5. 手填 MM-DD 跨月混合（日期列用户自己填，可脱离区块） */
console.log('\n[5] 手填 MM-DD 混合');
const md9 = XLSX.read(bufMd, { type: 'array' });
g = XLSX.utils.sheet_to_json(md9.Sheets['月分日'], { header: 1, raw: true, defval: '', blankrows: true });
g[0][1] = '手工混合';
g.forEach((r, i) => { if (i >= 4 && i <= 8) { r[0] = ['03-01', '03-02', '06-05', '06-06', '06-30'][i - 4]; r[1] = 100; r[2] = 390; } });
md9.Sheets['月分日'] = XLSX.utils.aoa_to_sheet(g);
const res9 = WcTemplate.parseImportWorkbook(XLSX.write(md9, { type: 'array', bookType: 'xlsx' }));
ok('手填 MM-DD 5 行跨月', res9.curves.length === 1 && res9.curves[0].entries.length === 5 && res9.curves[0].window.from === '03-01' && res9.curves[0].window.to === '06-30', JSON.stringify(res9.errors));

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
process.exit(failed ? 1 : 0);
