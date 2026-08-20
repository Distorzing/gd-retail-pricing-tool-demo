/* ============================================================
 * 售电公司盈亏平衡签约价引擎（依据《售电公司盈亏平衡签约价计算-技术文档》v1.0）
 *
 * 批发成本 = CfD 差价合约模型：
 *   cost_h = P_DA,h × L_h + (P_C − P_DA,h) × Q_h       （超卖 Q>L 自动卖回，只担价差）
 *   C = Σ cost_h / E
 * 等价分解：C = C_spot − G_curve
 *   C_spot  = Σ P_DA×L / E                              全吃现货的负荷加权均价
 *   G_curve = Σ 合约占比 × (DA_曲线交割加权日前价 − P_C)  持仓差价收益
 *
 * 全口径成本：C_total = C + c_alloc + c_ops + c_pv
 *   c_pv = α×P_REF×(f1−1) − γ×P_REF×(1−f2)               峰谷平衡净成本（售电公司净支出）
 * 盈亏平衡：P* = C_total / (α×f1 + β + γ×f2)
 *
 * 持仓参数化展开：统调/可调曲线按统调月度能量分布摊到各月，逐月内按形状归一化到逐时；
 * 周日调 0 后该周日电量按权重摊回周一~周六（技术文档 §4.3）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(require('./retail.js')); }
  else { root.BreakEven = factory(root.RetailCalc); }
})(typeof self !== 'undefined' ? self : this, function (RetailCalc) {
  'use strict';

  const CONFIG = Object.assign({
    P_REF: 463,
    TOU_TABLE: RetailCalc.CONFIG.TOU_TABLE,
    // 广东政策时段（以现行政策为准）：峰 10-11、14-18（7h）；谷 0-7（8h）；其余平（9h）
    TOU_HOURS: { peak: [10, 11, 14, 15, 16, 17, 18], flat: [8, 9, 12, 13, 19, 20, 21, 22, 23], valley: [0, 1, 2, 3, 4, 5, 6, 7] },
    ANNUAL_SPREAD: 'byCurve',   // 年度合约跨月分摊：byCurve（统调月度能量分布）
    ADJ_BASE: 'system'          // 可调基准形状：system（统调形状）| flat（均分）
  }, RetailCalc.CONFIG || {});

  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  /** 由峰平谷占比生成典型日 24h 负荷形状（文档 §4.1，段内均匀） */
  function buildDayShape(alpha, beta, gamma, tou) {
    const p = tou || CONFIG.TOU_HOURS;
    const out = new Array(24).fill(0);
    const nP = p.peak.length, nF = p.flat.length, nV = p.valley.length;
    p.peak.forEach(h => out[h] = alpha / nP);
    p.flat.forEach(h => out[h] = beta / nF);
    p.valley.forEach(h => out[h] = gamma / nV);
    return out;   // 日形状，Σ=1（一天）
  }

  /** 可调乘子 → 逐日逐时形状：周日 m=0、小时乘子、周日量摊回周一~周六（§4.3），归一化 */
  function buildAdjustedShape(baseShape24, mult) {
    // mult: { sundayZero: true, hours: {0:3.5, 3:0.5, 4:0.5, 5:0.5, 18:3.5,...22:3.5} }
    const wd = baseShape24.map((w, h) => w * (mult.hours && mult.hours[h] != null ? mult.hours[h] : 1));
    const wdSum = wd.reduce((a, b) => a + b, 0);
    if (!(wdSum > 0)) return null;   // 乘子全 0 → 归一化除零，调用方拦截
    if (!mult.sundayZero) return wd.map(v => v / wdSum);
    // 周日清零：周日电量按工作日形状权重摊回周一~周六（六天）→ 日形状不变，只是 6/7 天 × 放大系数
    // 实现：周一~周六日形状 = wd/Σwd × 7/6（把周日的量摊回来），周日 = 0
    const scale = 7 / 6;   // 总电量守恒：6 天承担 7 天的量
    return { weekday: wd.map(v => v * scale / wdSum), sunday: new Array(24).fill(0) };
  }

  /**
   * 持仓成本（CfD）
   * @param q        number[8760] 用户负荷 L_h（MWh）
   * @param keys     8760 时间键
   * @param da       number[8760] 日前价 P_DA,h
   * @param holdings [{name, qty（全年总电量 MWh, 或 byMonth[12]）, price, shapePerHour: number[8760]（Σ=1 全年）或 fn(t)→值}]
   *   shapePerHour 归一化权重（Σ=1）；电量 = qty × shape[t]
   * @param window   {from,to}（可选，签约窗口；窗口外 L=0 不参与成本）
   */
  function computeHoldingCost(q, keys, da, holdings, window) {
    const win = window || { from: '01-01', to: '12-31' };
    const inWin = t => { const md = keys[t].slice(5, 10); return md >= win.from && md <= win.to; };
    const N = keys.length;
    let E = 0;                                    // 窗口内用户电量
    const L = new Array(N).fill(0);
    for (let t = 0; t < N; t++) if (inWin(t)) { L[t] = q[t]; E += q[t]; }
    if (!(E > 0)) return { error: '窗口内用户电量为 0' };

    // 持仓逐时电量 Q_h
    const Q = new Array(N).fill(0);
    const qByCurve = holdings.map(h => {
      const arr = new Array(N).fill(0);
      for (let t = 0; t < N; t++) arr[t] = (h.qty || 0) * (h.shapePerHour ? h.shapePerHour[t] : (h.shapeFn ? h.shapeFn(t) : 0));
      return arr;
    });
    for (let t = 0; t < N; t++) for (const arr of qByCurve) Q[t] += arr[t];
    const Qsum = Q.reduce((a, b) => a + b, 0);

    // CfD 成本（窗口外 L=0 但持仓 Q 仍按窗口内部分计入成本；窗口外持仓不服务该客户→不计）
    let costSum = 0, spotSum = 0, oversellHours = 0, oversellMwh = 0;
    for (let t = 0; t < N; t++) {
      if (!inWin(t)) continue;
      const qT = Q[t];   // 窗口内持仓（服务该客户的部分）
      costSum += da[t] * L[t] + (holdings.length ? ((holdingsPriceBlend(holdings, qByCurve, t)) - da[t]) * qT : 0);
      spotSum += da[t] * L[t];
      if (qT > L[t] + 1e-9) { oversellHours++; oversellMwh += qT - L[t]; }
    }
    const C = costSum / E;
    const C_spot = spotSum / E;
    const G_curve = C_spot - C;                     // 持仓差价收益（正=合约低于现货）
    // 逐曲线分解（报表）
    const perCurve = holdings.map((h, i) => {
      const qi = qByCurve[i];
      const qSum = qi.reduce((a, b, t) => a + (inWin(t) ? b : 0), 0);
      if (!(qSum > 0)) return { name: h.name, qty: 0, DA: null, gain: 0 };
      const DA = qi.reduce((a, v, t) => a + (inWin(t) ? v * da[t] : 0), 0) / qSum;
      return { name: h.name, qty: qSum, DA, price: h.price, gain: qSum * (DA - h.price) };
    });
    return {
      E, C, C_spot, G_curve, perCurve,
      coverage: E > 0 ? Qsum / E : 0,
      oversellHours, oversellMwh,
      oversellPct: oversellHours / keys.filter((_, t) => inWin(t)).length
    };
  }
  /** 某小时持仓加权价（多曲线按该小时电量加权） */
  function holdingsPriceBlend(holdings, qByCurve, t) {
    let num = 0, den = 0;
    holdings.forEach((h, i) => { const v = qByCurve[i][t]; num += v * (h.price || 0); den += v; });
    return den > 1e-12 ? num / den : (holdings[0] ? holdings[0].price || 0 : 0);
  }

  /** 全口径成本 + 盈亏平衡 */
  function solve(input) {
    // input: { q, keys, da, holdings, alloc, ops, usage:{peak,flat,valley}, userType, retail?（可选扩展：联动/煤电/浮动）}
    const tou = CONFIG.TOU_TABLE[input.userType] || CONFIG.TOU_TABLE['非深圳工业'];
    const hold = computeHoldingCost(input.q, input.keys, input.da, input.holdings, input.window);
    if (hold.error) return { error: hold.error };
    const u = input.usage;
    const Qtot = (u.peak || 0) + (u.flat || 0) + (u.valley || 0);
    const alpha = (u.peak || 0) / Qtot, beta = (u.flat || 0) / Qtot, gamma = (u.valley || 0) / Qtot;
    const c_pv = alpha * CONFIG.P_REF * (tou.f1 - 1) - gamma * CONFIG.P_REF * (1 - tou.f2);   // §4.5 净成本（正=支出）
    const C_total = hold.C + (input.alloc || 0) + (input.ops || 0) + c_pv;
    const K = alpha * tou.f1 + beta + gamma * tou.f2;
    const Pstar = K > 1e-9 ? C_total / K : null;
    // 成本瀑布
    const waterfall = [
      { name: '现货全口径 C_spot', value: hold.C_spot },
      { name: '持仓差价收益 −G_curve', value: -hold.G_curve },
      { name: '分摊 c_alloc', value: input.alloc || 0 },
      { name: '运营 c_ops', value: input.ops || 0 },
      { name: '峰谷平衡净成本 c_pv', value: c_pv },
      { name: '全口径 C_total', value: C_total }
    ];
    return {
      holding: hold, c_pv, alloc: input.alloc || 0, ops: input.ops || 0,
      C_total, K, Pstar,
      Pfeng: Pstar != null ? Pstar * tou.f1 : null,
      Pgu: Pstar != null ? Pstar * tou.f2 : null,
      alpha, beta, gamma, tou, waterfall
    };
  }

  /** 敏感性矩阵：日前价整体偏移 × 总仓位（§6） */
  function sensitivity(input, daShifts, covLevels) {
    const shifts = daShifts || [-20, -10, 0, 10, 20];
    const covs = covLevels || [0.85, 0.88, 0.90];
    return covs.map(cov => shifts.map(d => {
      const da2 = input.da.map(v => v + d);
      const holdings = input.holdings.map(h => ({ ...h, qty: (h.qty || 0) / (input.baseCoverage || 0.9) * cov }));
      return solve({ ...input, da: da2, holdings }).Pstar;
    }));
  }

  /** 参数化持仓展开：统调/可调曲线 → 8760 归一化形状（§4.2/4.3）
   *  monthlyBase[12] = 统调月度能量分布（Σ=1）
   *  dayShape24    = 统调典型日 24h 形状（Σ=1）
   *  mult          = 可调乘子 {sundayZero, hours:{h:m}}
   *  keys          = 8760 键（识别周几）
   *  → number[8760]（全年 Σ=1；周日电量已摊回周一~六） */
  function expandCurveShape(keys, monthlyBase, dayShape24, mult) {
    const out = new Array(keys.length).fill(0);
    const adj = mult ? buildAdjustedShape(dayShape24, mult) : null;
    const wds = adj && adj.weekday ? adj.weekday : dayShape24;   // 工作日/全日形状（Σ=1/日 或 7/6 摊回后）
    const sun = adj && adj.sunday ? adj.sunday : dayShape24;
    for (let t = 0; t < keys.length; t++) {
      const m = +keys[t].slice(5, 7) - 1;
      const dow = new Date(keys[t].slice(0, 10) + 'T00:00:00Z').getUTCDay();
      const h = +keys[t].slice(11, 13);
      const day = dow === 0 ? sun : wds;
      // 该日电量 = 月能量 × 日内形状；再 ÷ 该月天数（月内每天同形状）
      out[t] = monthlyBase[m] * day[h] / DAYS_IN_MONTH[m];
    }
    // 归一化兜底
    const s = out.reduce((a, b) => a + b, 0);
    return s > 0 ? out.map(v => v / s) : null;
  }

  return { CONFIG, buildDayShape, buildAdjustedShape, computeHoldingCost, solve, sensitivity, expandCurveShape };
});
