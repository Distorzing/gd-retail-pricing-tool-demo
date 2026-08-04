/* ============================================================
 * 批发曲线 Excel 模板 v3（最简）：按粒度拆三个工作表，时间轴预置，
 * 用户只竖着粘贴「电量(MWh)」「价格(元/MWh)」两列。
 *   年分月 sheet：曲线名称 + 12 行月份框架（01..12）
 *   月分日 sheet：曲线名称 + 月份(MM，改值即换月) + 31 行日期框架
 *   日分时 sheet：曲线名称 + 日期(YYYY-MM-DD) + 24 行时刻框架
 * 无状态/价格方式/窗口/覆盖率等任何配置项；价格=逐条（贴什么用什么）；
 * 整行留空自动跳过（只覆盖已填时段）；窗口/状态由数据自动推断。
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./vendor/xlsx.full.min.js'));
  } else {
    root.WcTemplate = factory(root.XLSX);
  }
})(typeof self !== 'undefined' ? self : this, function (XLSX) {
  'use strict';

  const HEAD = ['电量(MWh)', '价格(元/MWh)', '备注'];
  // 各粒度表头（时间键列名自解释）与信息区标签
  const GRAN_INFO = { year_month: '年分月', month_day: '月分日', day_hour: '日分时' };
  const KEY_HEAD = { year_month: '月份(MM)', month_day: '日期(MM-DD)', day_hour: '日期时间(MM-DD HH)' };
  const MONTH_ROW = '月份(MM，逗号分隔，如 03,06)';
  const DATE_ROW = '日期(YYYY-MM-DD，逗号分隔，如 2026-07-15,2026-07-20)';
  // 区块规模：月分日每段 31 行、最多 6 段；日分时每段 24 行、最多 4 段
  const MD_BLOCK = 31, MD_SEGS = 6, DH_BLOCK = 24, DH_SEGS = 4;

  /** Excel 日期序列号（1900 系统，基准 1899-12-30） */
  function excelSerial(y, m, d, h) { return (Date.UTC(y, m - 1, d, h || 0) - Date.UTC(1899, 11, 30)) / 86400000; }

  /**
   * 生成 v3 模板工作簿（方案 A：多值区块；按粒度独立成文件）。
   * @param year 报价年度
   * @param granularity 'year_month' | 'month_day' | 'day_hour'；缺省 'all'（全部子表，兼容旧用法）
   *   月分日：B2 输入月份列表（如 03,06）→ 日期列自动分块显示 03-01..03-31 / 06-01..06-30；
   *   日分时：B2 输入日期列表（逗号分隔）→ 每日期一块 24 行；
   * 每单元格 = 公式 + 缓存值（Excel 打开即显示，改 B2 自动重算；解析器读缓存值）。
   */
  function buildTemplateWorkbook(year, granularity) {
    granularity = granularity || 'all';
    const wb = XLSX.utils.book_new();
    const want = g => granularity === 'all' || granularity === g;

    // —— 导入说明 ——
    const note = [['批发曲线导入模板（' + (granularity === 'all' ? '全部' : GRAN_INFO[granularity]) + '）使用说明'], []];
    if (want('year_month')) note.push(
      ['【年分月】'],
      ['· B 列填曲线名称（不填则整个子表不导入）；时间轴已预置 01~12 月。'],
      ['· 竖着粘贴「电量(MWh)」「价格(元/MWh)」两列；整行留空 = 该月不采购，自动跳过。']
    );
    if (want('month_day')) note.push(
      ['【月分日】'],
      ['· B 列填曲线名称；B 列输入月份，多个用逗号分隔（如 03,06），日期列自动分块：'],
      ['   03-01..03-31 / 06-01..06-30，把你的月度表逐块竖着粘贴「电量(MWh)」「价格(元/MWh)」两列。'],
      ['· 最多 6 段；2 月只有 28 天，只贴 1~28 行；改 B 列月份列表整列自动重算。']
    );
    if (want('day_hour')) note.push(
      ['【日分时】'],
      ['· B 列填曲线名称；B 列输入日期，多个用逗号分隔（如 2026-07-15,2026-07-20），每个日期一块 24 行。'],
      ['· 最多 4 段；竖着粘贴「电量(MWh)」「价格(元/MWh)」两列。']
    );
    note.push(
      [],
      ['覆盖规则：日分时 > 月分日 > 年分月，同粒度以录入时间新者为准；'],
      ['导入后在工具内确认覆盖影响，并在参数管理「保存为新版本并启用」固化。']
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(note), '导入说明');

    // —— 年分月：12 行月份框架（01..12） ——
    if (want('year_month')) {
      const ym = [['曲线名称', ''], [], [KEY_HEAD.year_month].concat(HEAD)];
      for (let m = 1; m <= 12; m++) ym.push([String(m).padStart(2, '0'), null, null, '']);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ym), '年分月');
    }

    // —— 月分日：B2 月份列表 → 每段 31 行日期（公式+缓存值） ——
    if (want('month_day')) {
      const md = [['曲线名称', ''], [MONTH_ROW, '03,06'], [], [KEY_HEAD.month_day].concat(HEAD)];
      const mdSheet = XLSX.utils.aoa_to_sheet(md);
      const mdF = '=IFERROR(TEXT(DATE(' + year + ',VALUE(TRIM(MID(SUBSTITUTE($B$2,",",REPT(" ",20)),INT((ROW()-5)/' + MD_BLOCK + ')*20+1,20))),MOD(ROW()-5,' + MD_BLOCK + ')+1),"mm-dd"),"")';
      const mdMonths = ['03', '06'];
      for (let i = 0; i < MD_SEGS * MD_BLOCK; i++) {
        const seg = Math.floor(i / MD_BLOCK), d = (i % MD_BLOCK) + 1;
        const ref = XLSX.utils.encode_cell({ r: 4 + i, c: 0 });
        const cell = { t: 'n', f: mdF, z: 'mm-dd' };
        if (mdMonths[seg]) cell.v = excelSerial(year, +mdMonths[seg], d);   // 缓存值（Excel 打开即显示；改 B2 后重算）
        mdSheet[ref] = cell;
      }
      mdSheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 4 + MD_SEGS * MD_BLOCK - 1, c: 3 } });
      XLSX.utils.book_append_sheet(wb, mdSheet, '月分日');
    }

    // —— 日分时：B2 日期列表 → 每段 24 行（公式+缓存值） ——
    if (want('day_hour')) {
      const dh = [['曲线名称', ''], [DATE_ROW, year + '-07-15,' + year + '-07-20'], [], [KEY_HEAD.day_hour].concat(HEAD)];
      const dhSheet = XLSX.utils.aoa_to_sheet(dh);
      const S = 'TRIM(MID(SUBSTITUTE($B$2,",",REPT(" ",20)),INT((ROW()-5)/' + DH_BLOCK + ')*20+1,20))';
      const dhF = '=IFERROR(TEXT(DATE(VALUE(LEFT(' + S + ',4)),VALUE(MID(' + S + ',6,2)),VALUE(MID(' + S + ',9,2)))+MOD(ROW()-5,' + DH_BLOCK + ')/24,"mm-dd hh"),"")';
      const dhDates = [year + '-07-15', year + '-07-20'];
      for (let i = 0; i < DH_SEGS * DH_BLOCK; i++) {
        const seg = Math.floor(i / DH_BLOCK), h = i % DH_BLOCK;
        const ref = XLSX.utils.encode_cell({ r: 4 + i, c: 0 });
        const cell = { t: 'n', f: dhF, z: 'mm-dd hh' };
        if (dhDates[seg]) {
          const p = dhDates[seg].split('-');
          cell.v = excelSerial(+p[0], +p[1], +p[2], h);
        }
        dhSheet[ref] = cell;
      }
      dhSheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 4 + DH_SEGS * DH_BLOCK - 1, c: 3 } });
      XLSX.utils.book_append_sheet(wb, dhSheet, '日分时');
    }

    return wb;
  }

  /** 解析 v3 模板工作簿 → { curves, skipped, errors } */
  function parseImportWorkbook(arrayBuffer) {
    let wb;
    try { wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true }); }
    catch (e) { return { curves: [], skipped: 0, errors: ['无法读取该文件：不是有效的 xlsx/xls 工作簿'] }; }

    const curves = [];
    const errors = [];
    let skipped = 0;
    const bySheet = { '年分月': 'year_month', '月分日': 'month_day', '日分时': 'day_hour' };

    for (const sheetName of wb.SheetNames) {
      const granularity = bySheet[sheetName];
      if (!granularity) continue;
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '', blankrows: true });
      if (!grid || grid.length < 4) continue;

      // 顶部 B 列取值（名称/月份列表/日期列表）
      const bval = label => {
        const r = grid.find(row => String(row[0]).trim() === label);
        return r && r[1] != null ? String(r[1]).trim() : null;
      };
      const name = bval('曲线名称');
      if (!name) continue;   // 未命名子表 → 整表跳过

      // 多值区块参数：月份列表 / 日期列表（逗号分隔），纯键行按行号落入段
      let yearNow, segMonths, segDates;
      yearNow = new Date().getFullYear();
      if (granularity === 'month_day') {
        const mmList = bval(MONTH_ROW);
        if (!/^(\d{2})(,\d{2})*$/.test(mmList || '')) { errors.push('子表「' + sheetName + '」月份格式错误（应为 03 或 03,06）：' + mmList); continue; }
        segMonths = mmList.split(',');
      } else if (granularity === 'day_hour') {
        const dateList = bval(DATE_ROW);
        if (!/^\d{4}-\d{2}-\d{2}(,\d{4}-\d{2}-\d{2})*$/.test(dateList || '')) { errors.push('子表「' + sheetName + '」日期格式错误（应为 2026-07-15 或逗号分隔多个）：' + dateList); continue; }
        segDates = dateList.split(',');
        for (const d of segDates) {
          const t = new Date(d + 'T00:00:00Z');
          if (t.getUTCFullYear() !== +d.slice(0, 4) || t.getUTCMonth() !== +d.slice(5, 7) - 1 || t.getUTCDate() !== +d.slice(8, 10)) {
            errors.push('子表「' + sheetName + '」日期不存在：' + d); continue;
          }
        }
      }

      // 表头定位（时间键列名自解释：月份(MM)/日期(MM-DD)/日期时间(MM-DD HH)）
      const keyHead = KEY_HEAD[granularity];
      const hi = grid.findIndex(r => String(r[0]).trim() === keyHead);
      if (hi < 0) { errors.push('子表「' + sheetName + '」缺少表头（' + keyHead + '）'); continue; }
      const ci = { time: 0, qty: 1, price: 2 };

      const entries = [];
      for (let i = hi + 1; i < grid.length; i++) {
        const r = grid[i];
        const qty = r[ci.qty] === '' || r[ci.qty] == null ? null : Number(r[ci.qty]);
        const price = r[ci.price] === '' || r[ci.price] == null ? null : Number(r[ci.price]);
        if (qty == null && price == null) continue;   // 整行留空 → 跳过
        const seg = Math.floor((i - hi - 1) / (granularity === 'month_day' ? MD_BLOCK : DH_BLOCK));   // 行号所在段
        // 时间键：优先取单元格值（Date 对象 / Excel 日期序列号 / 用户文本），兜底段+行号推导
        let rawKey;
        if (typeof r[ci.time] === 'number' && isFinite(r[ci.time]) && r[ci.time] >= 40000) {
          // Excel 日期序列号（丢格式场景）→ 还原日期（含小数=小时）
          const dt = new Date(Math.round(r[ci.time] * 86400000) + Date.UTC(1899, 11, 30));
          rawKey = granularity === 'day_hour'
            ? dt.toISOString().slice(0, 10) + '|' + String(dt.getUTCHours()).padStart(2, '0')
            : dt.toISOString().slice(5, 10);
        } else if (r[ci.time] instanceof Date && !isNaN(r[ci.time])) {
          rawKey = granularity === 'day_hour'
            ? r[ci.time].toISOString().slice(0, 10) + '|' + String(r[ci.time].getUTCHours()).padStart(2, '0')
            : r[ci.time].toISOString().slice(5, 10);
        } else rawKey = String(r[ci.time] == null ? '' : r[ci.time]).trim();
        let timeKey = rawKey;
        if (granularity === 'year_month' && !/^(0[1-9]|1[0-2])$/.test(timeKey)) { errors.push('子表「' + sheetName + '」月份格式错误：' + rawKey); skipped++; continue; }
        if (granularity === 'month_day') {
          // 日期键四分支：完整日期 / 纯日(段月份) / 手填 MM-DD(可跨月) / 公式未计算 → 段月份+行号
          let dateStr;
          if (/^\d{4}-\d{2}-\d{2}$/.test(timeKey)) dateStr = timeKey;
          else if (/^(0[1-9]|[12]\d|3[01])$/.test(timeKey)) {
            if (!segMonths[seg]) { errors.push('子表「' + sheetName + '」第 ' + (seg + 1) + ' 段缺月份（B 列月份列表只有 ' + segMonths.length + ' 个）'); skipped++; continue; }
            dateStr = yearNow + '-' + segMonths[seg] + '-' + timeKey;
          } else if (/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(timeKey)) dateStr = yearNow + '-' + timeKey;
          else {
            if (!segMonths[seg]) { errors.push('子表「' + sheetName + '」第 ' + (seg + 1) + ' 段缺月份（B 列月份列表只有 ' + segMonths.length + ' 个）'); skipped++; continue; }
            dateStr = yearNow + '-' + segMonths[seg] + '-' + String(((i - hi - 1) % MD_BLOCK) + 1).padStart(2, '0');   // 段内日序号
          }
          const dt = new Date(dateStr + 'T00:00:00Z');
          if (dt.getUTCFullYear() !== +dateStr.slice(0, 4) || dt.getUTCMonth() !== +dateStr.slice(5, 7) - 1 || dt.getUTCDate() !== +dateStr.slice(8, 10)) {
            errors.push('子表「' + sheetName + '」日期不存在：' + dateStr); skipped++; continue;
          }
          timeKey = dateStr;
        }
        if (granularity === 'day_hour') {
          // 小时键两分支：完整 YYYY-MM-DD|HH(可跨日) / 纯时(段日期)
          let full;
          if (/^\d{4}-\d{2}-\d{2}\|\d{2}$/.test(timeKey)) full = timeKey;
          else if (/^([01]\d|2[0-3])$/.test(timeKey)) {
            if (!segDates[seg]) { errors.push('子表「' + sheetName + '」第 ' + (seg + 1) + ' 段缺日期（B 列日期列表只有 ' + segDates.length + ' 个）'); skipped++; continue; }
            full = segDates[seg] + '|' + timeKey;
          } else { errors.push('子表「' + sheetName + '」小时格式错误：' + rawKey + '（应为 HH 或 YYYY-MM-DD|HH）'); skipped++; continue; }
          const d = full.slice(0, 10);
          const dt = new Date(d + 'T00:00:00Z');
          if (dt.getUTCFullYear() !== +d.slice(0, 4) || dt.getUTCMonth() !== +d.slice(5, 7) - 1 || dt.getUTCDate() !== +d.slice(8, 10)) {
            errors.push('子表「' + sheetName + '」日期不存在：' + d); skipped++; continue;
          }
          timeKey = full;
        }
        if (qty == null || !isFinite(qty) || qty < 0) { errors.push('子表「' + sheetName + '」时段 ' + timeKey + ' 电量无效（填了价格没填电量？）'); skipped++; continue; }
        if (price == null || !isFinite(price) || price < 0) { errors.push('子表「' + sheetName + '」时段 ' + timeKey + ' 价格无效（两列都要填）'); skipped++; continue; }
        entries.push({ timeKey, quantityMwh: qty, ratioPct: null, priceYuanPerMwh: price });
      }
      if (!entries.length) { errors.push('子表「' + sheetName + '」无有效数据行（整行留空的时段自动跳过）'); continue; }

      // 窗口：年分月全年；月分日/日分时 = 实际条目范围（多值区块自动收拢）
      let window;
      if (granularity === 'year_month') window = { from: '01-01', to: '12-31' };
      else {
        const mdSet = entries.map(e => e.timeKey.slice(5, 10));
        window = { from: mdSet.reduce((a, b) => (a < b ? a : b)), to: mdSet.reduce((a, b) => (a > b ? a : b)) };
      }

      curves.push({
        id: 'wc-imp-' + Date.now().toString(36) + '-' + curves.length,
        name, status: 'planned', enabled: true, createdAt: null, updatedAt: null, year: new Date().getFullYear(),
        window, granularity, quantityMode: 'mwh', priceMode: 'perEntry', flatPrice: null,
        entries, note: 'Excel 导入'
      });
    }
    return { curves, skipped, errors };
  }

  return { buildTemplateWorkbook, parseImportWorkbook, HEADERS: HEAD };
});
