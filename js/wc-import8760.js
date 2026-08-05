/* ============================================================
 * 批发曲线 8760 逐时直导
 *   parseWholesale8760(arrayBuffer, year, flatPrice) → { entries, hours, stats, errors }
 *   支持布局：
 *     四列：日期 | 时刻 | 电量(MWh) | 价格(元/MWh)
 *     三列：日期 | 时刻 | 电量(MWh)（价格用 flatPrice 统一价）
 *   缺小时允许（该时段不采购，进日前缺口）；电量/价格须非负。
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./vendor/xlsx.full.min.js'), require('./validate.js'));
  } else {
    root.WcImport8760 = factory(root.XLSX, root.Validator);
  }
})(typeof self !== 'undefined' ? self : this, function (XLSX, Validator) {
  'use strict';

  function parseDate(v) {
    if (typeof v === 'number' && v > 30000 && v < 60000) {
      return new Date(Math.round(v * 86400000) + Date.UTC(1899, 11, 30)).toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{4})[/年.](\d{1,2})[/月.](\d{1,2})/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
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

  /**
   * 解析 8760 批发曲线（三列/四列）→ { entries, hours, stats, errors }
   * @param flatPrice 三列格式时的统一价格（元/MWh）；四列格式忽略
   */
  function parseWholesale8760(arrayBuffer, year, flatPrice) {
    const errors = [];
    let wb;
    try { wb = XLSX.read(arrayBuffer, { type: 'array' }); }
    catch (e) { return { entries: null, hours: 0, stats: null, errors: ['无法读取该文件：不是有效的 xlsx/xls 工作簿'] }; }
    const keys = Validator.expectedHourKeys(year);
    const keySet = new Set(keys);

    const rows = [];   // {timeKey, qty, price|null}
    for (const sheetName of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
      for (const r of grid) {
        if (!r || r.length < 3) continue;
        const d = parseDate(r[0]);
        const h = parseHour(r[1]);
        const qty = Number(r[2]);
        if (!d || h == null || !isFinite(qty)) continue;
        const timeKey = d + '|' + String(h).padStart(2, '0');
        if (!keySet.has(timeKey)) continue;
        const price = r.length >= 4 && r[3] !== '' && r[3] != null ? Number(r[3]) : null;
        rows.push({ timeKey, qty, price: price != null && isFinite(price) ? price : null });
      }
    }
    // 去重（后出现的覆盖先出现的，同 Excel 粘贴习惯）
    const map = new Map();
    rows.forEach(r => map.set(r.timeKey, r));
    const dedup = [...map.values()];

    if (!dedup.length) {
      return { entries: null, hours: 0, stats: null, errors: ['未识别到有效行：需要三列（日期|时刻|电量）或四列（日期|时刻|电量|价格）'] };
    }
    const hasPerRowPrice = dedup.some(r => r.price != null);
    const priceMode = hasPerRowPrice ? 'perEntry' : 'flat';
    const fp = priceMode === 'flat' ? Number(flatPrice) : null;
    if (priceMode === 'flat' && !(fp > 0)) {
      return { entries: null, hours: 0, stats: null, errors: ['三列格式（无价格列）需要填「统一价格（元/MWh）」'] };
    }

    const bad = [];
    const entries = [];
    let totalMwh = 0, costSum = 0;
    for (const r of dedup) {
      if (r.qty < 0) { bad.push(r.timeKey + ' 电量为负'); continue; }
      const p = priceMode === 'perEntry' ? r.price : fp;
      if (p == null || !isFinite(p) || p < 0) { bad.push(r.timeKey + ' 价格无效'); continue; }
      entries.push({ timeKey: r.timeKey, quantityMwh: r.qty, ratioPct: null, priceYuanPerMwh: p });
      totalMwh += r.qty; costSum += r.qty * p;
    }
    if (bad.length) errors.push(bad.length + ' 行被跳过（' + bad.slice(0, 3).join('；') + (bad.length > 3 ? '…' : '') + '）');
    if (!entries.length) return { entries: null, hours: 0, stats: null, errors: errors.length ? errors : ['无有效数据行'] };

    entries.sort((a, b) => (a.timeKey < b.timeKey ? -1 : 1));
    return {
      entries, hours: entries.length, priceMode, flatPrice: fp,
      stats: {
        hours: entries.length, totalMwh, weightedPrice: totalMwh > 0 ? costSum / totalMwh : 0,
        firstKey: entries[0].timeKey, lastKey: entries[entries.length - 1].timeKey
      },
      errors
    };
  }

  return { parseWholesale8760 };
});
