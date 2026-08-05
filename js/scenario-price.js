/* ============================================================
 * 日前价格情景：8760 直接价格导入
 *   buildScenarioTemplate(year)：8760 框架模板（日期|时刻|价格，价格列空，竖贴一列）
 *   parseScenarioPrice(arrayBuffer, year)：解析 xlsx/csv 三列（日期|时刻|价格）或单列 8760
 *   校验：8760 点齐全、日期时刻与报价年度 keys 对齐、价格数值有效（允许负价，统计提示）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./vendor/xlsx.full.min.js'), require('./validate.js'));
  } else {
    root.ScenarioPrice = factory(root.XLSX, root.Validator);
  }
})(typeof self !== 'undefined' ? self : this, function (XLSX, Validator) {
  'use strict';

  const HEAD = ['日期(YYYY-MM-DD)', '时刻(0-23)', '日前价格(元/MWh)'];

  /** 生成 8760 框架模板：日期+时刻预置，价格列空，竖贴一列 */
  function buildScenarioTemplate(year) {
    const wb = XLSX.utils.book_new();
    const note = [
      ['日前价格导入模板使用说明'],
      [],
      ['1. 时间轴已预置全年 8760 行（日期 | 时刻），你只需竖着粘贴「日前价格(元/MWh)」一列。'],
      ['2. 价格按报价年度时间顺序对齐（1月1日0时 ~ 12月31日23时），允许负价（日前市场真实存在）。'],
      ['3. 导入后在参数管理确认该情景为「直接价格」模式（8760 值原样进入成本计算，不再按 W 比例标定）。'],
      ['4. 多个情景可分别导入各自的实际/预测曲线，权重合计须为 100%。']
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(note), '导入说明');
    const rows = [HEAD];
    const keys = Validator.expectedHourKeys(year);
    for (const k of keys) rows.push([k.slice(0, 10), String(+k.slice(11, 13)), null]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '日前价格');
    return wb;
  }

  /**
   * 解析 xlsx 三列（日期|时刻|价格）或单列 8760 → { curve, negHours, errors }
   * 兼容：表头可有可无、日期为文本/Excel 序列号、时刻为 0-23/"08:00"。
   */
  function parseScenarioPrice(arrayBuffer, year) {
    const errors = [];
    let wb;
    try { wb = XLSX.read(arrayBuffer, { type: 'array' }); }
    catch (e) { return { curve: null, negHours: 0, errors: ['无法读取该文件：不是有效的 xlsx/xls 工作簿'] }; }
    const keys = Validator.expectedHourKeys(year);
    const keySet = new Map(keys.map((k, i) => [k, i]));

    // 从工作簿收集「日期|时刻 → 价格」映射（自动识别三列/单列）
    const map = new Map();
    let sheetUsed = null;
    for (const sheetName of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
      if (!grid.length) continue;
      let collected = 0;
      for (let i = 0; i < grid.length; i++) {
        const r = grid[i];
        if (!r || r.length < 1) continue;
        // 三列：日期 | 时刻 | 价格
        if (r.length >= 3) {
          const d = parseDate(r[0]);
          const h = parseHour(r[1]);
          const p = Number(r[2]);
          if (d && h != null && isFinite(p)) {
            const key = d + '|' + String(h).padStart(2, '0');
            if (keySet.has(key)) { map.set(key, p); collected++; }
          }
          continue;
        }
        // 单列：顺序 8760 价格
        const v = Number(r[0]);
        if (r.length === 1 && isFinite(v)) {
          const key = keys[i - (isHeader(grid[0]) ? 1 : 0)];
          if (key) { map.set(key, v); collected++; }
        }
      }
      if (collected >= keys.length * 0.99) { sheetUsed = sheetName; break; }
      map.clear();
    }
    if (!sheetUsed) {
      errors.push('未识别到 8760 价格数据：需要三列（日期|时刻|价格）或单列 8760 个价格（按年度时间顺序）');
      return { curve: null, negHours: 0, errors };
    }
    const missing = keys.filter(k => !map.has(k));
    if (missing.length) {
      errors.push('缺 ' + missing.length + ' 个小时的价格（如 ' + missing.slice(0, 3).join('、') + '…）');
      return { curve: null, negHours: 0, errors };
    }
    const curve = keys.map(k => map.get(k));
    const negHours = curve.filter(v => v < 0).length;
    return { curve, negHours, sheetUsed, errors };
  }

  function isHeader(row) {
    return row && row.some(c => /日期|时刻|价格|时间|date|hour|price/i.test(String(c)));
  }
  function parseDate(v) {
    if (typeof v === 'number' && v > 30000 && v < 60000) {
      return new Date(Math.round(v * 86400000) + Date.UTC(1899, 11, 30)).toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{4})[/年.](\d{1,2})[/月.](\d{1,2})/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    const m2 = s.match(/^(\d{1,2})月(\d{1,2})日?$/);
    if (m2) return null;   // 「4月1日」无年份，无法对齐 → 由调用方按顺序处理（本工具要求完整日期）
    return null;
  }
  function parseHour(v) {
    const s = String(v).trim();
    const m = s.match(/^(\d{1,2})(?::00|:00:00|时)?$/);
    if (m) { const h = +m[1]; return h >= 0 && h <= 23 ? h : null; }
    const m2 = s.match(/^(\d{1,2}):\d{2}/);
    if (m2) { const h = +m2[1]; return h >= 0 && h <= 23 ? h : null; }
    return null;
  }

  return { buildScenarioTemplate, parseScenarioPrice, HEADERS: HEAD };
});
