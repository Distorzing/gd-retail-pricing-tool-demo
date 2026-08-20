/* ============================================================
 * 曲线解析与 8760 校验模块（纯函数，浏览器与 Node 均可加载）
 * 规则（需求包 3.1 / 8760 校验）：
 *  - 报价年度每个小时一条，共 8760 点（2026 = 365×24）
 *  - 日期+小时唯一、无缺失、无重复、用电量非负
 *  - 校验失败必须阻止报价，不得悄悄补数
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
  else { root.Validator = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_LIST = 50; // 异常清单最多展示条数

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 解析日期文本 → 'YYYY-MM-DD'；支持 2026-01-01 / 2026/1/1 / 2026.1.1 / 2026年1月1日 / 20260101 */
  function parseDate(s) {
    s = String(s).trim();
    let m = s.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
    if (m) return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return null;
  }

  /** 解析时刻 → 0-23 整数（24 保留用于 1–24 制检测）；无法解析返回 null */
  function parseHour(s) {
    s = String(s).trim();
    let m = s.match(/^(\d{1,2})(?::00(?::00)?)?$/);   // '7' / '07' / '07:00'
    if (m) { const h = +m[1]; return (h >= 0 && h <= 24) ? h : null; }
    m = s.match(/[T\s](\d{1,2}):\d{2}/);              // datetime 中的小时
    if (m) { const h = +m[1]; return (h >= 0 && h <= 23) ? h : null; }
    m = s.match(/\s(\d{1,2})$/);                      // '2026-01-01 7' 末尾小时
    if (m) { const h = +m[1]; return (h >= 0 && h <= 24) ? h : null; }
    return null;
  }

  /** 解析数值（去千分位逗号/空格）；失败返回 null */
  function parseValue(s) {
    if (s == null) return null;
    const t = String(s).trim().replace(/[,\s]/g, '');
    if (t === '') return null;
    const v = Number(t);
    return isFinite(v) ? v : null;
  }

  /**
   * 解析粘贴/上传的曲线文本（TSV/CSV，兼容从 Excel 直接粘贴）。
   * 支持两种列结构：
   *   A) 日期 | 时刻 | 用电量
   *   B) 日期时间（含小时）| 用电量
   * @returns { rows:[{date,hour,value,line}], skipped:[], fatal:String|null }
   */
  function parseCurveText(text) {
    const lines = String(text).split(/\r\n|\r|\n/);
    const rows = [], skipped = [];
    let headerSkipped = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw || !raw.trim()) continue;
      const cells = raw.split(/\t|;|,/).map(c => c.trim()).filter((c, idx, arr) => !(idx === arr.length - 1 && c === ''));
      if (cells.length < 2) { skipped.push({ line: i + 1, reason: '列数不足', raw: raw.slice(0, 60) }); continue; }

      let date = null, hour = null, value = null;
      if (cells.length >= 3) {
        date = parseDate(cells[0]);
        hour = parseHour(cells[1]);
        value = parseValue(cells[2]);
      } else { // 2 列：首列须同时含日期和小时（如 '2026-01-01 7'）
        date = parseDate(cells[0]);
        hour = parseHour(cells[0]);
        value = parseValue(cells[1]);
      }

      // 表头行：第一条非空行的数值列不是数字 → 视为表头跳过
      if (value == null && !headerSkipped && rows.length === 0 && skipped.length === 0) {
        headerSkipped = true;
        continue;
      }
      if (date == null || hour == null || value == null) {
        skipped.push({
          line: i + 1,
          reason: date == null ? '日期无法识别' : (hour == null ? '时刻无法识别' : '用电量不是数值'),
          raw: raw.slice(0, 60)
        });
        continue;
      }
      rows.push({ date, hour, value, line: i + 1 });
    }
    return { rows, skipped, headerSkipped };
  }

  /** 生成报价年度全部小时键 ['YYYY-MM-DD|HH', ...]（按时间顺序） */
  function expectedHourKeys(year) {
    const keys = [];
    const d = new Date(Date.UTC(year, 0, 1));
    while (d.getUTCFullYear() === year) {
      const ds = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
      for (let h = 0; h < 24; h++) keys.push(ds + '|' + pad2(h));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return keys;
  }

  /**
   * 8760 严格校验。
   * @param rows  parseCurveText 的 rows
   * @param year  报价年度（如 2026）
   * @returns { ok, errors, warnings, anomalies:{duplicates,missing,negatives,outOfYear,badHours},
   *            series:{keys, values}|null, stats }
   */
  function validate8760(rows, year) {
    const errors = [], warnings = [];
    const expected = expectedHourKeys(year);
    const need = expected.length;
    const expSet = new Set(expected);

    // 时刻制式检测：若出现 24 且没有 0，按 1–24 制转换为 0–23（留痕警告）
    const hours = rows.map(r => r.hour);
    const has24 = hours.includes(24), has0 = hours.includes(0);
    let converted = rows;
    if (has24 && !has0) {
      converted = rows.map(r => ({ ...r, hour: r.hour - 1 }));
      warnings.push('检测到时刻为 1–24 制，已按 0–23 制转换（1→0，2→1，…，24→23）');
    } else if (has24 && has0) {
      errors.push('时刻同时出现 0 与 24，时刻制式不一致，请统一为 0–23');
    }

    const anomalies = { duplicates: [], missing: [], negatives: [], outOfYear: [], badHours: [] };
    const map = new Map();
    for (const r of converted) {
      if (!(r.hour >= 0 && r.hour <= 23)) {
        if (anomalies.badHours.length < MAX_LIST) anomalies.badHours.push(r);
        continue;
      }
      const key = r.date + '|' + pad2(r.hour);
      if (!expSet.has(key)) {
        if (anomalies.outOfYear.length < MAX_LIST) anomalies.outOfYear.push({ ...r, key });
        continue;
      }
      if (r.value < 0) { if (anomalies.negatives.length < MAX_LIST) anomalies.negatives.push({ ...r, key }); continue; }
      if (map.has(key)) { if (anomalies.duplicates.length < MAX_LIST) anomalies.duplicates.push({ ...r, key }); continue; }
      map.set(key, r.value);
    }

    for (const k of expected) {
      if (!map.has(k) && anomalies.missing.length < MAX_LIST) anomalies.missing.push(k);
    }
    const missingCount = expected.filter(k => !map.has(k)).length;

    if (map.size !== need) {
      errors.push('有效数据点 ' + map.size + ' / 应有 ' + need + '（' + year + '年 8760 点校验未通过）');
    }
    if (missingCount > 0) errors.push('缺失 ' + missingCount + ' 个小时点');
    if (anomalies.duplicates.length > 0) errors.push('存在重复的日期+小时记录');
    if (anomalies.negatives.length > 0) errors.push('存在负值用电量');
    if (anomalies.outOfYear.length > 0) errors.push('存在报价年度（' + year + '）之外的日期');
    if (anomalies.badHours.length > 0) errors.push('存在无法识别的时刻（须为 0–23 或 1–24 整点）');

    // 重复点/负值/越界/时刻错误 → 始终拦截（与是否部分曲线无关）
    const hardErrors = anomalies.duplicates.length > 0 || anomalies.negatives.length > 0 || anomalies.outOfYear.length > 0 || anomalies.badHours.length > 0;
    // 部分连续曲线（年内新增）：缺月补 0，校验通过但警告；完整 8760 不变
    const presentDates = [...map.keys()].map(k => k.slice(0, 10));
    const minD = presentDates.length ? presentDates.reduce((a, b) => a < b ? a : b) : null;
    const maxD = presentDates.length ? presentDates.reduce((a, b) => a > b ? a : b) : null;
    let series = null, stats = null, ok = false;
    if (map.size === need) {
      ok = !hardErrors;
      const values = expected.map(k => map.get(k));
      const Q = values.reduce((a, b) => a + b, 0);
      stats = { count: values.length, Q, min: Math.min.apply(null, values), max: Math.max.apply(null, values), avg: Q / values.length };
      series = { keys: expected, values };
    } else if (missingCount > 0 && minD && maxD && !hardErrors) {
      // 缺失小时全部在 [minD, maxD] 之外（部分连续曲线）→ 补 0，通过
      const missingInRange = expected.filter(k => !map.has(k) && k.slice(0, 10) >= minD && k.slice(0, 10) <= maxD);
      if (missingInRange.length === 0) {
        ok = true;
        const values = expected.map(k => map.has(k) ? map.get(k) : 0);
        // Q/avg 只按有数据时段算（补零不计入统计，避免拉低）
        const present = [...map.values()];
        const Q = present.reduce((a, b) => a + b, 0);
        stats = { count: values.length, Q, min: Math.min.apply(null, present), max: Math.max.apply(null, present), avg: Q / present.length, partial: true };
        series = { keys: expected, values };
        warnings.push('部分连续曲线：' + minD + ' ~ ' + maxD + '（' + (map.size) + ' 点），窗口外 ' + missingCount + ' 个小时已补 0');
      }
    }
    if (!ok) {
      if (map.size !== need) errors.push('有效数据点 ' + map.size + ' / 应有 ' + need + '（' + year + '年 8760 点校验未通过）');
      if (missingCount > 0) errors.push('缺失 ' + missingCount + ' 个小时点');
      stats = { count: map.size, Q: null };
    }
    return { ok, errors, warnings, anomalies, missingCount, series, stats };
  }

  /** 单位幅值猜测：单一客户逐时均值若 >1000，大概率为 kWh（仅供参考，仍需人工确认） */
  function guessUnit(avg) {
    if (avg == null || !isFinite(avg)) return null;
    return avg > 1000 ? 'kWh' : 'MWh';
  }

  return { parseDate, parseHour, parseValue, parseCurveText, expectedHourKeys, validate8760, guessUnit, MAX_LIST };
});
