/* ============================================================
 * 零售侧收入计算引擎（依据《零售侧收入计算工具-设计文档》v1.0）
 *   零售收入 = 电能量电费（固定+联动+煤电+浮动）
 *            + 峰谷平衡净额（谷段补贴 − 峰段惩罚）
 *            + 绿电环境价值电费（电量+偏差+考核+补充）
 * 纯函数：calcRetail(input, usage) → { energy, peakValley, green, grandTotal, unitPrice, errors, formulas }
 * usage = { peak, flat, valley }（MWh，由调用方从 8760 曲线按时段聚合或直接录入）
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
  else { root.RetailCalc = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 政策常量（CONFIG 一处集中，政策调整只改这里）
  const CONFIG = {
    TOU_TABLE: {                                   // 用户类型 → {f1 峰, f2 谷}
      '非深圳工业': { f1: 1.7, f2: 0.38 },
      '非深圳商业': { f1: 1.0, f2: 1.0 },
      '深圳工业': { f1: 1.53, f2: 0.32 },
      '深圳商业': { f1: 1.53, f2: 0.32 },
      '冰蓄冷': { f1: 1.65, f2: 0.25 }
    },
    TOU_PERIODS: { peak: '10-11、14-18', flat: '8-9、12-13、19-23', valley: '0-7' },
    FIXED_PRICE_MIN: 372, FIXED_PRICE_MAX: 554,    // 元/MWh（0.372~0.554 元/kWh）
    LINK_MIN_RATIO: 0.10, LINK_MAX_RATIO: 0.30,     // 联动总比例 10%~30%（2026 新规）
    LINK_SPOT_MIN_RATIO: 0.08, LINK_SPOT_MAX_RATIO: 0.15,   // 联动现货（日前月度综合价）8%~15%
    COAL_FLOAT_MIN: 0, COAL_FLOAT_MAX: 50,         // 元/MWh
    FLOAT_FEE_MIN: 0, FLOAT_FEE_MAX: 5,             // 浮动费用（仅平价套餐，0~5 元/MWh = 0~0.005 元/kWh，2026 新规）
    PV_REF_PRICE: 463,                             // 峰谷平衡市场参考价 元/MWh（0.463 元/kWh）
    GREEN_FIXED_PRICE_MAX: 50,                     // 元/MWh
    GREEN_VOLUME_CAP: 1.2,                         // ≤ 实际用电量×1.2
    GREEN_ASSESS_COEF_MAX: 0.2,
    CECI_ROUND_MODE: 'trunc'                       // trunc | floor | round（PPT 算例 (940−834)/100=1.06→1）
  };

  /**
   * 市场风控条款（2026 新规§3）：平段结算价 vs 结算月批发均价（逐月判断）
   *  - 高于批发均价 15% 以上 → 该月用户只付 批发均价×115%（超出部分售电公司承担）
   *  - 低于批发均价 20% 以上 → 该月用户付 批发均价×80%（低于部分售电公司享有）
   */
  function riskGuard(Pping, wholesaleAvg) {   // 单值版（向后兼容/单月）
    if (!(wholesaleAvg > 0) || !(Pping > 0)) return { applied: false, Pping, note: '未触发（无批发均价数据）' };
    if (Pping > wholesaleAvg * 1.15) {
      return { applied: true, type: 'cap', Pping: wholesaleAvg * 1.15, saving: Pping - wholesaleAvg * 1.15,
        note: '平段价高于批发均价 15% → 按批发均价×115% 结算（结算价=' + (wholesaleAvg * 1.15).toFixed(1) + '），超出部分售电公司承担' };
    }
    if (Pping < wholesaleAvg * 0.80) {
      return { applied: true, type: 'floor', Pping: wholesaleAvg * 0.80, gain: wholesaleAvg * 0.80 - Pping,
        note: '平段价低于批发均价 20% → 按批发均价×80% 结算（结算价=' + (wholesaleAvg * 0.80).toFixed(1) + '），低于部分售电公司享有' };
    }
    return { applied: false, Pping, note: '未触发（批发均价 ' + wholesaleAvg.toFixed(1) + ' ×80%~115% 区间内）' };
  }

  /**
   * 逐月风控：返回每月实际平段结算价与月度损益
   * @param Pping 合同平段价 @param monthlyFlat 12 月各月平段电量 @param monthlyWholesale 12 月各月批发均价（{ '01': 310, ... } 或 number[12]）
   * @returns { monthly: [{month, cap, floor, actual, clamped, delta}], totalDelta, appliedMonths }
   *   delta>0 = 售电公司多收（按下限）；delta<0 = 售电公司少收（按上限，亏损）
   */
  function riskGuardMonthly(Pping, monthlyFlat, monthlyWholesale) {
    const out = [];
    let totalDelta = 0, applied = 0;
    for (let m = 1; m <= 12; m++) {
      const wa = Array.isArray(monthlyWholesale) ? monthlyWholesale[m - 1] : monthlyWholesale[String(m).padStart(2, '0')];
      const qf = Array.isArray(monthlyFlat) ? monthlyFlat[m - 1] : (monthlyFlat || [])[m - 1];
      if (!(wa > 0) || !(qf > 0)) { out.push({ month: m, wa: wa || 0, qf: qf || 0, actual: Pping, clamped: false, delta: 0 }); continue; }
      const cap = wa * 1.15, floor = wa * 0.80;
      let actual = Pping, clamped = false, type = null;
      if (Pping > cap) { actual = cap; clamped = true; type = 'cap'; }
      else if (Pping < floor) { actual = floor; clamped = true; type = 'floor'; }
      const delta = (actual - Pping) * qf;   // 售电公司多收(+)/少收(−)
      totalDelta += delta;
      if (clamped) applied++;
      out.push({ month: m, wa, qf, cap, floor, actual, clamped, type, delta });
    }
    return { monthly: out, totalDelta, appliedMonths: applied,
      note: applied ? applied + ' 个月触发风控（实际结算价偏离合同价）' : '全年未触发风控' };
  }

  /** 校验 + 计算（一个入口；errors 非空时调用方应阻止使用结果） */
  function calcRetail(input, usage) {
    const errors = [];
    const u = usage || {};
    const Qp = Number(u.peak) || 0, Qf = Number(u.flat) || 0, Qv = Number(u.valley) || 0;
    const Qt = Qp + Qf + Qv;
    if (!(Qt > 0)) errors.push('峰/平/谷电量为 0，无法计算');

    // —— 用户类型与系数 ——
    const tou = CONFIG.TOU_TABLE[input.userType] || CONFIG.TOU_TABLE['非深圳工业'];
    const k = { peak: tou.f1, flat: 1, valley: tou.f2 };

    // ============ 平价套餐（2026 新规§2）：批发均价 + 浮动费用，全电量 ============
    // input.planMode='fair' + wholesaleAvg（元/MWh）+ floatFee{enabled, price 0~5}
    if (input.planMode === 'fair') {
      const wa = Number(input.wholesaleAvg) || 0;
      if (!(wa > 0)) errors.push('平价套餐：需填写月批发均价（元/MWh）');
      const fp = input.floatFee && input.floatFee.enabled ? Number(input.floatFee.price) || 0 : 0;
      if (fp < CONFIG.FLOAT_FEE_MIN || fp > CONFIG.FLOAT_FEE_MAX) errors.push('浮动费用 ' + fp + ' 超出 [0, 5] 元/MWh');
      if (errors.length) return { errors };
      // 平段 = 批发均价 + 浮动费；峰谷按系数
      const Pping = wa + fp;
      const F = [];
      ['peak', 'flat', 'valley'].forEach(seg => {
        F.push({ comp: '平价套餐·' + (seg === 'peak' ? '峰' : seg === 'flat' ? '平' : '谷'), seg,
          formula: segUsage2(seg) + ' MWh × (' + wa + ' + ' + fp + ') × ' + k[seg] + ' = ' + yuan(segUsage2(seg) * Pping * k[seg]) + ' 元' });
      });
      const total = Qt * Pping;   // 峰平谷加权 = Pping × K×Qt… 全电量×(均价+浮动)×1（平价套餐均价口径按平段电量价，峰谷仍按系数）
      const grand = (Qp * Pping * k.peak) + (Qf * Pping) + (Qv * Pping * k.valley);
      const guard = riskGuard(Pping, wa);
      return {
        planMode: 'fair', usage: { peak: Qp, flat: Qf, valley: Qv, total: Qt }, tou, k,
        energy: { fixed: { seg: { peak: 0, flat: 0, valley: 0 }, total: 0 }, linked: { seg: { peak: 0, flat: 0, valley: 0 }, total: 0 }, total: grand },
        peakValley: { valleySubsidy: 0, peakPenalty: 0, net: 0 },
        green: { total: 0 },
        grandTotal: grand, unitPrice: grand / Qt, unitPriceYuanPerKwh: grand / Qt / 1000,
        riskGuard: guard, errors: [], formulas: F,
        note: '平价套餐：批发均价 ' + wa + ' + 浮动费 ' + fp + ' 元/MWh；风控条款：' + guard.note
      };
      function segUsage2(seg) { return seg === 'peak' ? Qp : seg === 'flat' ? Qf : Qv; }
    }

    // —— 校验：电能量 ——
    const fixedRatio = Number(input.fixed && input.fixed.ratio) || 0;
    const fixedPrice = Number(input.fixed && input.fixed.flatPrice) || 0;
    // 平段价是"待求输出"：填了才校验范围（留空 = 只反解盈亏平衡）
    if (fixedPrice > 0 && (fixedPrice < CONFIG.FIXED_PRICE_MIN || fixedPrice > CONFIG.FIXED_PRICE_MAX)) {
      errors.push('固定平段价格 ' + fixedPrice + ' 超出 [' + CONFIG.FIXED_PRICE_MIN + ', ' + CONFIG.FIXED_PRICE_MAX + '] 元/MWh');
    }
    const modes = (input.link && input.link.modes) || [];
    // 2026 新规：纯固定价不允许——「固定+联动」合同必须有 10%~30% 联动
    // ①月度交易综合价 与 ②月度集中竞争价 互斥；两者均可与③现货联动同时勾选
    if (modes.some(m => m.type === 1) && modes.some(m => m.type === 2)) {
      errors.push('联动方式①（月度交易综合价）与②（月度集中竞争价）互斥，只能二选一');
    }
    const linkRatioSum = modes.reduce((a, m) => a + (Number(m.ratio) || 0), 0);
    if (Math.abs(fixedRatio + linkRatioSum - 1) > 1e-9) {
      errors.push('固定占比 ' + pct(fixedRatio) + ' + 联动占比 ' + pct(linkRatioSum) + ' ≠ 100%');
    }
    if (input.planMode !== 'fair') {
      if (linkRatioSum < CONFIG.LINK_MIN_RATIO - 1e-9) {
        errors.push('联动总占比 ' + pct(linkRatioSum) + ' 低于下限 10%（2026 新规：纯固定价合同不允许，至少 10% 电量参与市场联动）');
      }
      if (linkRatioSum > CONFIG.LINK_MAX_RATIO + 1e-9) {
        errors.push('联动总占比 ' + pct(linkRatioSum) + ' 超过上限 30%（2026 新规）');
      }
    }
    const m3 = modes.find(m => m.type === 3);
    if (m3) {
      const r3 = Number(m3.ratio) || 0;
      if (r3 < CONFIG.LINK_SPOT_MIN_RATIO - 1e-9) errors.push('联动现货（方式③）占比 ' + pct(r3) + ' 低于下限 8%（2026 新规）');
      if (r3 > CONFIG.LINK_SPOT_MAX_RATIO + 1e-9) errors.push('联动现货（方式③）占比 ' + pct(r3) + ' 超过上限 15%（2026 新规）');
    }
    modes.forEach(m => { if (!((Number(m.flatPrice) || 0) > 0)) errors.push('联动方式' + m.type + ' 平段联动价未填写'); });

    // —— 校验：煤电 / 浮动 ——
    const coal = input.coal || {};
    if (coal.enabled) {
      const fp = Number(coal.floatPrice) || 0;
      if (fp < CONFIG.COAL_FLOAT_MIN || fp > CONFIG.COAL_FLOAT_MAX) {
        errors.push('煤电浮动单价 ' + fp + ' 超出 [0, 50] 元/MWh');
      }
      if (!(Number(coal.ceciSign) > 0 && Number(coal.ceciSettle) > 0)) errors.push('煤电联动需填写签约/结算月 CECI');
    }
    const ff = input.floatFee || {};
    if (ff.enabled) {
      const p = Number(ff.price) || 0;
      if (p < CONFIG.FLOAT_FEE_MIN || p > CONFIG.FLOAT_FEE_MAX) {
        errors.push('浮动费用 ' + p + ' 超出 [0, 5] 元/MWh（2026 新规：仅平价套餐、上限 0.005 元/kWh）');
      }
      if (input.planMode !== 'fair' && modes.length) {
        errors.push('「固定价格+联动价格」模式 2026 年不再签订浮动费用（新规）；浮动费用仅适用于平价套餐');
      }
    }

    const F = [];   // 算式追溯

    // ============ ① 电能量电费 ============
    // 固定电费_t = 电量_t × 固定占比 × 固定平段价 × k_t
    const fixedFee = { peak: 0, flat: 0, valley: 0 };
    ['peak', 'flat', 'valley'].forEach(seg => {
      fixedFee[seg] = segUsage(seg) * fixedRatio * fixedPrice * k[seg];
      F.push({ comp: '固定价格电费', seg, formula: segUsage(seg) + ' MWh × ' + pct(fixedRatio) + ' × ' + fixedPrice + ' × ' + k[seg] + ' = ' + yuan(fixedFee[seg]) + ' 元' });
    });
    const fixedTotal = fixedFee.peak + fixedFee.flat + fixedFee.valley;

    // 联动电费_t = 电量_t × Σ(占比ᵢ×联动价ᵢ) × k_t
    const linkMix = modes.reduce((a, m) => a + (Number(m.ratio) || 0) * (Number(m.flatPrice) || 0), 0);
    const linkFee = { peak: 0, flat: 0, valley: 0 };
    ['peak', 'flat', 'valley'].forEach(seg => {
      linkFee[seg] = segUsage(seg) * linkMix * k[seg];
      if (modes.length) F.push({ comp: '市场联动电费·方式' + modes.map(m => m.type).join('+'), seg,
        formula: segUsage(seg) + ' MWh × (' + modes.map(m => pct(m.ratio) + '×' + m.flatPrice).join(' + ') + ') × ' + k[seg] + ' = ' + yuan(linkFee[seg]) + ' 元' });
    });
    const linkTotal = linkFee.peak + linkFee.flat + linkFee.valley;

    // 煤电电费_t = 电量_t × 固定占比 × trunc(ΔCECI/100) × 浮动单价 × k_t（可选）
    let coalTotal = 0;
    const coalFee = coal.enabled ? { peak: 0, flat: 0, valley: 0 } : null;
    if (coal.enabled) {
      const diff = (Number(coal.ceciSettle) - Number(coal.ceciSign)) / 100;
      const idx = roundCECI(diff);
      ['peak', 'flat', 'valley'].forEach(seg => {
        coalFee[seg] = segUsage(seg) * fixedRatio * idx * (Number(coal.floatPrice) || 0) * k[seg];
        F.push({ comp: '煤电联动电费', seg,
          formula: segUsage(seg) + ' MWh × ' + pct(fixedRatio) + ' × trunc(' + (Number(coal.ceciSettle) - Number(coal.ceciSign)) + '/100 = ' + idx + ') × ' + coal.floatPrice + ' × ' + k[seg] + ' = ' + yuan(coalFee[seg]) + ' 元' });
      });
      coalTotal = coalFee.peak + coalFee.flat + coalFee.valley;
    }

    // 浮动电费 = 总电量 × 浮动单价（不分段）
    const floatFeeTotal = ff.enabled ? Qt * (Number(ff.price) || 0) : 0;
    if (ff.enabled) F.push({ comp: '浮动电费', seg: '合计', formula: Qt + ' MWh × ' + ff.price + ' = ' + yuan(floatFeeTotal) + ' 元' });

    const energyTotal = fixedTotal + linkTotal + coalTotal + floatFeeTotal;

    // ============ ② 峰谷平衡 ============
    const valleySubsidy = Qv * CONFIG.PV_REF_PRICE * (1 - tou.f2);
    const peakPenalty = Qp * CONFIG.PV_REF_PRICE * (tou.f1 - 1);
    const pvNet = valleySubsidy - peakPenalty;
    F.push({ comp: '峰谷平衡·谷段补贴', seg: '谷', formula: Qv + ' MWh × ' + CONFIG.PV_REF_PRICE + ' × (1 − ' + tou.f2 + ') = ' + yuan(valleySubsidy) + ' 元' });
    F.push({ comp: '峰谷平衡·峰段惩罚', seg: '峰', formula: Qp + ' MWh × ' + CONFIG.PV_REF_PRICE + ' × (' + tou.f1 + ' − 1) = ' + yuan(peakPenalty) + ' 元' });

    // ============ ③ 绿电环境价值 ============
    const g = input.green || {};
    let green = { effectiveVolume: 0, adjCoef: 1, weightedPrice: 0, energyFee: 0, deviationVolume: 0, deviationFee: 0, assessFee: 0, supplementFee: 0, total: 0 };
    if (g.enabled) {
      const actual = Number(g.actualGreenUsage) || 0;
      let Q = g.volumeMode === 'fixed'
        ? Math.min(Number(g.fixedVolume) || 0, actual * CONFIG.GREEN_VOLUME_CAP)
        : actual * (Number(g.ratio) || 0);
      green.effectiveVolume = Q;
      const wt = Number(g.wholesaleTotal), up = Number(g.upperPriorityVolume);
      green.adjCoef = (wt > 0 && up != null && Q > 0) ? Math.min(1, Math.max(0, (wt - up) / Q)) : 1;
      const gfRatio = Number(g.fixedRatio) || 0, glRatio = Number(g.linkRatio) || 0;
      if (Math.abs(gfRatio + glRatio - 1) > 1e-9) errors.push('绿电固定占比 ' + pct(gfRatio) + ' + 联动占比 ' + pct(glRatio) + ' ≠ 100%');
      const gfPrice = Number(g.fixedPrice) || 0;
      if (gfRatio > 0 && (gfPrice < 0 || gfPrice > CONFIG.GREEN_FIXED_PRICE_MAX)) {
        errors.push('绿电固定价格 ' + gfPrice + ' 超出 [0, ' + CONFIG.GREEN_FIXED_PRICE_MAX + '] 元/MWh');
      }
      green.weightedPrice = gfRatio * gfPrice + glRatio * (Number(g.linkEnvPrice) || 0);
      green.energyFee = Q * green.weightedPrice;
      green.deviationVolume = Math.min(0, Q * green.adjCoef - Q);
      green.deviationFee = green.deviationVolume * green.weightedPrice;
      const coef = Number(g.assessCoef) || 0;
      if (coef > CONFIG.GREEN_ASSESS_COEF_MAX + 1e-9) errors.push('绿电考核系数 ' + coef + ' 超过上限 0.2');
      const assessVol = g.assessMode === 'none' ? 0 : Math.abs(green.deviationVolume);   // 月度考核=当月偏差；合同期=累计偏差（调用方累计后传入）
      green.assessFee = g.assessMode === 'none' ? 0 : assessVol * green.weightedPrice * coef;
      green.supplementFee = (Number(g.supplement && g.supplement.volume) || 0) * (Number(g.supplement && g.supplement.price) || 0);
      green.total = green.energyFee + green.deviationFee + green.assessFee + green.supplementFee;
      F.push({ comp: '绿电·电量电费', seg: '—', formula: Q + ' MWh × ' + green.weightedPrice.toFixed(2) + ' 元/MWh = ' + yuan(green.energyFee) + ' 元' });
      if (green.deviationVolume < 0) F.push({ comp: '绿电·偏差电费', seg: '—', formula: green.deviationVolume.toFixed(2) + ' MWh × ' + green.weightedPrice.toFixed(2) + ' = ' + yuan(green.deviationFee) + ' 元' });
      if (green.assessFee) F.push({ comp: '绿电·考核电费', seg: '—', formula: assessVol.toFixed(2) + ' × ' + green.weightedPrice.toFixed(2) + ' × ' + coef + ' = ' + yuan(green.assessFee) + ' 元' });
      if (green.supplementFee) F.push({ comp: '绿电·补充交易', seg: '—', formula: (g.supplement.volume) + ' MWh × ' + g.supplement.price + ' = ' + yuan(green.supplementFee) + ' 元' });
    }

    const grandTotal = energyTotal + pvNet + green.total;
    return {
      usage: { peak: Qp, flat: Qf, valley: Qv, total: Qt },
      tou, k,
      energy: { fixed: { seg: fixedFee, total: fixedTotal }, linked: { seg: linkFee, total: linkTotal },
        coal: coalFee ? { seg: coalFee, total: coalTotal } : null,
        floatFee: ff.enabled ? { total: floatFeeTotal } : null, total: energyTotal },
      peakValley: { valleySubsidy, peakPenalty, net: pvNet },
      green, grandTotal,
      unitPrice: Qt > 0 ? grandTotal / Qt : 0,          // 元/MWh
      unitPriceYuanPerKwh: Qt > 0 ? grandTotal / Qt / 1000 : 0,
      errors, formulas: F
    };

    function segUsage(seg) { return seg === 'peak' ? Qp : seg === 'flat' ? Qf : Qv; }
  }

  /** 盈亏平衡求解：给定成本侧（元/MWh）与收入结构，解固定平段价使利润=0
   *  利润 = 零售收入(固定价 P 的函数) − 成本 → 线性于 P，直接解 */
  function solveBreakEven(input, usage, costPerMwh) {
    // 收入对 P 求导（固定电费部分）：d/dP = Qt × 固定占比 × (峰占比×f1 + 平×1 + 谷×f2)
    const u = usage || {};
    const Qt = (Number(u.peak) || 0) + (Number(u.flat) || 0) + (Number(u.valley) || 0);
    const tou = CONFIG.TOU_TABLE[input.userType] || CONFIG.TOU_TABLE['非深圳工业'];
    const K = ((Number(u.peak) || 0) * tou.f1 + (Number(u.flat) || 0) * 1 + (Number(u.valley) || 0) * tou.f2) / (Qt || 1);
    const fixedRatio = Number(input.fixed && input.fixed.ratio) || 0;
    const slope = Qt * fixedRatio * K;                 // 元 / (元/MWh)
    // 收入（P=0 时）= 联动 + 煤电 + 浮动 + 峰谷平衡 + 绿电
    const r0input = JSON.parse(JSON.stringify(input));
    r0input.fixed.flatPrice = 0;
    const r0 = calcRetail(r0input, usage);
    const intercept = r0.grandTotal;                   // P=0 的收入
    const target = costPerMwh * Qt;                    // 成本总额（元）
    if (!(slope > 1e-9)) return { flatPrice: null, reason: '固定占比为 0，收入与固定价无关，无法求解盈亏平衡' };
    const P = (target - intercept) / slope;
    // 代回验证
    const chk = JSON.parse(JSON.stringify(input)); chk.fixed.flatPrice = P;
    const rr = calcRetail(chk, usage);
    return { flatPrice: P, equivPerMwh: rr.unitPrice, checkProfit: rr.grandTotal - target, K };
  }

  function roundCECI(x) {
    if (CONFIG.CECI_ROUND_MODE === 'floor') return Math.floor(x);
    if (CONFIG.CECI_ROUND_MODE === 'round') return Math.round(x);
    return Math.trunc(x);
  }
  const pct = v => ((Number(v) || 0) * 100).toFixed(2) + '%';
  const yuan = v => (Math.round(v * 100) / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

  /** PPT 算例（自检基准 55.70 万） */
  function demoInput() {
    return {
      userType: '非深圳工业',
      fixed: { ratio: 0.9, flatPrice: 520 },
      link: { modes: [{ type: 3, ratio: 0.1, flatPrice: 540 }] },
      coal: { enabled: true, ceciSign: 834, ceciSettle: 940, floatPrice: 30 },
      floatFee: { enabled: false, price: 0 },   // 2026 新规：固定+联动模式不签浮动费（PPT 原算例的 12 元/MWh 已按新规移除）
      green: { enabled: true, volumeMode: 'ratio', ratio: 1.0, actualGreenUsage: 100,
        fixedRatio: 1.0, fixedPrice: 10, linkRatio: 0, linkEnvPrice: null,
        priority: 'A', assessMode: 'none', assessCoef: 0, supplement: { volume: 0, price: 0 } }
    };
  }
  const demoUsage = () => ({ peak: 200, flat: 500, valley: 300 });

  return { CONFIG, calcRetail, solveBreakEven, riskGuard, riskGuardMonthly, demoInput, demoUsage };
});
