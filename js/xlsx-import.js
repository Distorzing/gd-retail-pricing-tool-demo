/* ============================================================
 * xlsx 曲线导入模块（浏览器 + Node 均可加载）
 * 依赖本地 vendor 的 SheetJS（js/vendor/xlsx.full.min.js，Apache-2.0）。
 * 职责：把 xlsx/xls 工作簿转成「日期 \t 时刻 \t 用电量」TSV 文本，
 *       倒入输入框后仍走统一的 8760 校验（单一事实源，留痕一致）。
 * 支持列结构：
 *   A) 日期 | 时刻 | 用电量（3列及以上，自动识别列）
 *   B) 日期时间（含小时）| 用电量（2列）
 * 日期兼容：文本日期（2026-01-01 / 2026/1/1 等）与 Excel 日期序列号。
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./vendor/xlsx.full.min.js'), require('./validate.js'));
  } else {
    root.XlsxImport = factory(root.XLSX, root.Validator);
  }
})(typeof self !== 'undefined' ? self : this, function (XLSX, Validator) {
  'use strict';

  /** Excel 日期序列号 → {date:'YYYY-MM-DD', hour:0-23}（1900 日期系统，1899-12-30 起算） */
  function isSerialDate(v) { return typeof v === 'number' && isFinite(v) && v > 20000 && v < 80000; }
  function serialToDateHour(v) {
    const days = Math.floor(v), frac = v - days;
    const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
    const p = n => (n < 10 ? '0' : '') + n;
    return {
      date: d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()),
      hour: Math.round(frac * 24) % 24
    };
  }

  /** 从单元格解析日期（文本或序列号）→ 'YYYY-MM-DD' | null */
  function cellDate(cell) {
    if (isSerialDate(cell)) return serialToDateHour(cell).date;
    return Validator.parseDate(cell);
  }
  /** 从单元格解析时刻（序列号小数部分 / 文本）→ 0-23 | null */
  function cellHour(cell) {
    if (isSerialDate(cell)) return serialToDateHour(cell).hour;
    return Validator.parseHour(cell);
  }

  /** 探测数据列映射 */
  function detectColumns(grid) {
    const scan = grid.slice(0, Math.min(grid.length, 2000));
    const cols = Math.max.apply(null, scan.map(r => r.length));
    // 列头行：首行多数单元格是文本（含中文列头如"小时序号/月份/日期/时刻/电量"）
    const firstRow = grid[0] || [];
    const textCells = firstRow.filter(c => c != null && String(c).trim() !== '' && isNaN(Number(c))).length;
    const headerRow = textCells >= Math.ceil(firstRow.filter(c => c != null && String(c).trim() !== '').length / 2) ? firstRow : null;
    const score = { date: [], hour: [], value: [] };
    for (let c = 0; c < cols; c++) { score.date[c] = 0; score.hour[c] = 0; score.value[c] = 0; }
    for (const r of scan) {
      for (let c = 0; c < cols; c++) {
        const cell = r[c];
        if (cell == null || cell === '') continue;
        if (isSerialDate(cell) || Validator.parseDate(cell)) { score.date[c]++; continue; }
        const s = String(cell).trim();
        if (Validator.parseHour(s) != null && /^-?\d{1,2}(:00(:00)?)?$/.test(s)) { score.hour[c]++; continue; }
        if (Validator.parseValue(s) != null) score.value[c]++;
      }
    }
    const best = sc => { let b = -1, bv = 0; sc.forEach((v, i) => { if (v > bv) { bv = v; b = i; } }); return { col: b, votes: bv }; };
    const d = best(score.date), h = best(score.hour), v = best(score.value);

    // 拆分日期结构：月份列（1-12）+ 日期列（1-31）+ 时刻列 + 电量列（列头含"月"/"日"/"时"/"电量"）
    // 例：小时序号|月份|日期|时刻|电量(kWh)（常见导出格式）
    if (headerRow) {
      const monthCol = headerRow.findIndex(c => /月份|^月$/.test(String(c).trim()));
      const dayCol = headerRow.findIndex(c => /日期|^日$/.test(String(c).trim()));
      if (monthCol >= 0 && dayCol >= 0 && monthCol !== dayCol) {
        // 时刻列：列头含"时刻"（优先，排除"序号"）；否则"小时"但非"序号"；否则数据投票
        let hc = headerRow.findIndex(c => /时刻|时间/.test(String(c).trim()) && !/序号/.test(String(c).trim()));
        if (hc < 0) hc = headerRow.findIndex(c => /^小时$|^时$/.test(String(c).trim()) && !/序号/.test(String(c).trim()));
        if (hc < 0) hc = h.col >= 0 ? h.col : -1;
        // 电量列：列头含"电量/用电量/负荷"，否则 value 票最高且非上述列
        let vc = headerRow.findIndex(c => /电量|用电|负荷|kwh/i.test(String(c).trim()));
        if (vc < 0 && v.col >= 0 && v.col !== monthCol && v.col !== dayCol && v.col !== hc) vc = v.col;
        if (hc >= 0 && vc >= 0) return { mode: 4, monthCol, dayCol, hourCol: hc, valueCol: vc };
      }
    }

    if (d.col >= 0 && h.col >= 0 && h.col !== d.col && v.col >= 0 && v.col !== d.col && v.col !== h.col) {
      return { mode: 3, dateCol: d.col, hourCol: h.col, valueCol: v.col };
    }
    if (d.col >= 0 && v.col >= 0 && v.col !== d.col) {
      return { mode: 2, dateCol: d.col, hourCol: d.col, valueCol: v.col };
    }
    if (cols >= 3) return { mode: 3, dateCol: 0, hourCol: 1, valueCol: 2, fallback: true };
    if (cols === 2) return { mode: 2, dateCol: 0, hourCol: 0, valueCol: 1, fallback: true };
    return null;
  }

  /**
   * 解析 xlsx/xls 的 ArrayBuffer。
   * @returns { tsv, sheetName, rowCount, mapping, skipped } 或抛出带中文说明的 Error
   */
  let YEAR_OVERRIDE = null;
  function workbookToTSV(arrayBuffer, year) {
    YEAR_OVERRIDE = year || null;
    let wb;
    try { wb = XLSX.read(arrayBuffer, { type: 'array' }); }
    catch (e) { throw new Error('无法读取该文件：不是有效的 xlsx/xls 工作簿'); }

    // 选工作表：数据行数最多的（8760 曲线通常在行数最多的表）
    let sheetName = wb.SheetNames[0], maxRows = -1;
    const grids = {};
    for (const name of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
      grids[name] = grid;
      if (grid.length > maxRows) { maxRows = grid.length; sheetName = name; }
    }
    const grid = grids[sheetName];
    if (!grid || grid.length < 2) throw new Error('工作表「' + sheetName + '」为空');

    const map = detectColumns(grid);
    if (!map) throw new Error('无法识别列结构：需要「日期、时刻、用电量」三列或「日期时间、用电量」两列');

    const lines = [];
    let skipped = 0;
    for (const r of grid) {
      const dRaw = r[map.dateCol];
      let date = null, hour = null, value = null;
      if (map.mode === 4) {
        // 拆分日期：月份(1-12) + 日期(1-31) 合成 YYYY-MM-DD（年份用报价年度）
        if (r[map.monthCol] == null || r[map.dayCol] == null || String(r[map.monthCol]).trim() === '') continue;
        const mm = Number(r[map.monthCol]), dd = Number(r[map.dayCol]);
        const yr = YEAR_OVERRIDE || 2026;
        date = (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) ? yr + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0') : null;
        hour = cellHour(r[map.hourCol]);
        value = Validator.parseValue(r[map.valueCol]);
      } else {
        if (dRaw == null || String(dRaw).trim() === '') continue;
        date = cellDate(dRaw);
        hour = map.mode === 2 ? cellHour(dRaw) : cellHour(r[map.hourCol]);
        value = Validator.parseValue(r[map.valueCol]);
      }
      if (date == null || hour == null || value == null) {
        // 表头/说明行：含中文时静默跳过，其余计入 skipped
        if (!/[\u4e00-\u9fa5]/.test(String(dRaw) + String(r[map.valueCol]))) skipped++;
        continue;
      }
      lines.push(date + '\t' + hour + '\t' + value);
    }
    if (lines.length < 100) throw new Error('仅识别出 ' + lines.length + ' 行有效数据，请检查列结构（需要 8760 行逐时数据）');

    return {
      tsv: lines.join('\n'),
      sheetName,
      rowCount: lines.length,
      mapping: map.mode === 4
        ? '月份列#' + (map.monthCol + 1) + '｜日期列#' + (map.dayCol + 1) + '｜时刻列#' + (map.hourCol + 1) + '｜电量列#' + (map.valueCol + 1)
        : map.mode === 3
        ? '日期列#' + (map.dateCol + 1) + '｜时刻列#' + (map.hourCol + 1) + '｜电量列#' + (map.valueCol + 1)
        : '日期时间列#' + (map.dateCol + 1) + '｜电量列#' + (map.valueCol + 1),
      skipped
    };
  }

  return { workbookToTSV, detectColumns };
});
