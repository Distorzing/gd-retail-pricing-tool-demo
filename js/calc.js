/* ============================================================
 * 核心计算模块（纯函数，无 DOM 依赖；浏览器与 Node 均可加载）
 * 业务规则见《ZCode 开发指令 V1.0》与需求包：
 *  - b_t  = Q × g_t                等电量比较基准（仅分析用）
 *  - CV_s = Σ[(q_t − b_t) × p_s,t] / Q
 *  - C_s  = W_s + CE_s + SR_s + O_s
 *  - E[C] = Σ(w_s × C_s)
 *  - Cq   : 成本从低到高累计情景权重，首次达到 q 的成本
 *  - 三档价 = max(Cq + bufferQ, E[C] + bufferE)
 * 主单位：元/MWh。展示换算：元/度 = /1000；分/度 = /10。
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
  else { root.Calc = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-12;

  /** 归一化曲线，使合计为 1（允许原始合计为 1 或 100 或任意正数） */
  function normalize(curve) {
    const s = curve.reduce((a, b) => a + b, 0);
    if (!(s > 0)) throw new Error('曲线合计必须为正数，无法归一化');
    return curve.map(v => v / s);
  }

  /** 全年总电量 Q = Σq_t（单位与输入一致，工具内部统一用 MWh） */
  function totalEnergy(q) { return q.reduce((a, b) => a + b, 0); }

  /** 等电量比较基准 b_t = Q × g_t（g_t 须已归一化） */
  function baselineCurve(Q, gNorm) { return gNorm.map(g => Q * g); }

  /**
   * 价格情景曲线按 W_s 标定：保留时段形状，缩放使统调基准加权均价 = W_s。
   * k = W_s / Σ(g_t × p_t)；返回 { curve, k, rawWeightedAvg }
   */
  function calibratePriceCurve(gNorm, priceCurve, targetWs) {
    const rawAvg = gNorm.reduce((a, g, t) => a + g * priceCurve[t], 0);
    if (!(rawAvg > 0)) throw new Error('情景曲线统调加权均价非正，无法标定');
    const k = targetWs / rawAvg;
    return { curve: priceCurve.map(p => p * k), k, rawWeightedAvg: rawAvg };
  }

  /** 曲线价值 CV_s = Σ[(q_t − b_t) × p_s,t] / Q（元/MWh） */
  function curveValue(q, b, p, Q) {
    let s = 0;
    for (let t = 0; t < q.length; t++) s += (q[t] - b[t]) * p[t];
    return s / Q;
  }

  /** 逐时曲线价值贡献（元/MWh 口径分摊前的分子项）：contrib_t = (q_t − b_t) × p_t / Q */
  function curveValueContribs(q, b, p, Q) {
    const out = new Array(q.length);
    for (let t = 0; t < q.length; t++) out[t] = (q[t] - b[t]) * p[t] / Q;
    return out;
  }

  /** CE_s：曲线暴露成本，按结算规则版本可替换。mode: exposure|full|none */
  function exposureCost(cv, coverageRatio, mode) {
    if (mode === 'full') return cv;
    if (mode === 'none') return 0;
    return (1 - coverageRatio) * cv; // exposure（V1 默认）
  }

  /**
   * 加权分位数 Cq：按成本从低到高累计情景权重，首次达到 q 的成本。
   * items: [{ cost, weight }]
   */
  function weightedQuantile(items, q) {
    const sorted = items.slice().sort((a, b) => a.cost - b.cost);
    let cum = 0;
    for (const it of sorted) {
      cum += it.weight;
      if (cum + EPS >= q) return it.cost;
    }
    return sorted.length ? sorted[sorted.length - 1].cost : NaN;
  }

  /**
   * 加权 CVaRα：超过 VaRα 的平均损失（离散情景）。
   * items: [{loss, weight}]; alpha 置信度。
   */
  function weightedVaRCVaR(items, alpha) {
    const sorted = items.slice().sort((a, b) => a.loss - b.loss);
    let cum = 0, varA = sorted.length ? sorted[sorted.length - 1].loss : NaN;
    for (const it of sorted) {
      cum += it.weight;
      if (cum + EPS >= alpha) { varA = it.loss; break; }
    }
    let tailW = 0, tailL = 0;
    for (const it of sorted) {
      if (it.loss >= varA - EPS) { tailW += it.weight; tailL += it.weight * it.loss; }
    }
    const cvar = tailW > 0 ? tailL / tailW : varA;
    return { varA, cvar };
  }

  /* ================= V1.4 批发曲线管理（中长期+日前两部制） ================= */

  const GRAN_RANK = { year_month: 1, month_day: 2, day_hour: 3 };
  const GRAN_NAME = { year_month: '年分月', month_day: '月分日', day_hour: '日分时' };

  /**
   * 展开一条批发曲线到小时级（Map: 小时下标 → {mwh, price}）。
   * 年分月/月分日按统调比例 g 在该条目作用域内分配到小时，保持条目总电量不变。
   * @param curve {window:{from,to}('MM-DD'), granularity, quantityMode, entries:[{timeKey,quantityMwh,ratioPct,priceYuanPerMwh}]}
   * @param keys 全年 8760 键（'YYYY-MM-DD|HH'）
   * @param gNorm 归一化统调比例
   * @param q 客户逐时预测电量（覆盖率换算用）
   */
  function expandCurve(curve, keys, gNorm, q) {
    const out = new Map();
    const gIdx = new Map(keys.map((k, i) => [k, i]));
    const win = curve.window || { from: '01-01', to: '12-31' };
    const inWin = t => { const md = keys[t].slice(5, 10); return md >= win.from && md <= win.to; };

    for (const e of curve.entries || []) {
      let hours = [];
      if (curve.granularity === 'year_month') {
        const mm = String(e.timeKey).slice(-2);
        for (let t = 0; t < keys.length; t++) if (keys[t].slice(5, 7) === mm && inWin(t)) hours.push(t);
      } else if (curve.granularity === 'month_day') {
        for (let h = 0; h < 24; h++) {
          const i = gIdx.get(e.timeKey + '|' + (h < 10 ? '0' : '') + h);
          if (i != null && inWin(i)) hours.push(i);
        }
      } else { // day_hour
        const i = gIdx.get(e.timeKey);
        if (i != null && inWin(i)) hours.push(i);
      }
      if (!hours.length) continue;

      // 电量：MWh 直接录入；覆盖率按该条目作用域内客户预测电量换算
      let mwh = Number(e.quantityMwh);
      if (curve.quantityMode === 'ratio') {
        const scopeQ = hours.reduce((a, t) => a + q[t], 0);
        mwh = scopeQ * (Number(e.ratioPct) || 0) / 100;
      }
      if (!(mwh >= 0)) continue;
      const price = Number(e.priceYuanPerMwh) || 0;

      if (curve.granularity === 'day_hour') {
        out.set(hours[0], { mwh, price });
      } else {
        const gsum = hours.reduce((a, t) => a + gNorm[t], 0);
        if (!(gsum > 0)) continue;
        hours.forEach(t => out.set(t, { mwh: mwh * gNorm[t] / gsum, price }));
      }
    }
    return out;
  }

  /**
   * 覆盖汇总：按录入时间升序，细粒度覆盖粗粒度、同粒度后录入覆盖；
   * 只作用于新曲线实际填写的时段。旧曲线不物理删除（由上层管理 enabled）。
   * @returns {purchase[], price[], source[], gap[], over[], totalPurchase, totalCost,
   *           weightedPrice, coverage, gapMwh, overMwh, isDefault, logs}
   */
  function buildProcurement(curves, q, keys, gNorm, dflt) {
    const n = keys.length;
    const finalArr = new Array(n).fill(null);
    const logs = [];
    const active = (curves || []).filter(c => c.enabled !== false)
      .slice().sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : 1);

    if (!active.length) {
      // 默认假设：r0 × Q × g_t，价格=中长期均价锚点
      const r0 = dflt && dflt.ratio != null ? dflt.ratio : 0.9;
      const price = dflt && dflt.price != null ? dflt.price : 0;
      const Q = q.reduce((a, b) => a + b, 0);
      const purchase = gNorm.map(g => r0 * Q * g);
      return {
        purchase, price: new Array(n).fill(price), source: new Array(n).fill('默认年度基准假设'),
        gap: q.map((v, t) => Math.max(v - purchase[t], 0)),
        over: new Array(n).fill(0), rank: new Array(n).fill(1),
        totalPurchase: r0 * Q, totalCost: r0 * Q * price, weightedPrice: price,
        coverage: r0, gapMwh: Q * (1 - r0), overMwh: 0, isDefault: true, logs: []
      };
    }

    for (const c of active) {
      const exp = expandCurve(c, keys, gNorm, q);
      let wrote = 0, replaced = 0, replacedMwh = 0;
      exp.forEach((v, t) => {
        const cur = finalArr[t];
        if (!cur) { finalArr[t] = { ...v, rank: GRAN_RANK[c.granularity], src: c }; wrote++; }
        else if (GRAN_RANK[c.granularity] >= cur.rank) {
          replaced++; replacedMwh += cur.mwh;
          finalArr[t] = { ...v, rank: GRAN_RANK[c.granularity], src: c };
        }
      });
      if (replaced > 0) logs.push({ curveId: c.id, name: c.name, granularity: c.granularity, replacedHours: replaced, replacedMwh });
    }

    const purchase = new Array(n).fill(0), price = new Array(n).fill(null), source = new Array(n).fill(null);
    const rank = new Array(n).fill(0);
    const gap = new Array(n).fill(0), over = new Array(n).fill(0);
    let totalPurchase = 0, totalCost = 0, gapMwh = 0, overMwh = 0;
    for (let t = 0; t < n; t++) {
      const f = finalArr[t];
      if (f) {
        purchase[t] = f.mwh; price[t] = f.price; rank[t] = f.rank;
        source[t] = f.src.name + '（' + (GRAN_NAME[f.src.granularity] || f.src.granularity) + '）';
        totalPurchase += f.mwh; totalCost += f.mwh * f.price;
      }
      gap[t] = Math.max(q[t] - purchase[t], 0); gapMwh += gap[t];
      over[t] = Math.max(purchase[t] - q[t], 0); overMwh += over[t];
    }
    const Q = q.reduce((a, b) => a + b, 0);
    return {
      purchase, price, source, rank, gap, over,
      totalPurchase, totalCost,
      weightedPrice: totalPurchase > 0 ? totalCost / totalPurchase : 0,
      coverage: Q > 0 ? totalPurchase / Q : 0,
      gapMwh, overMwh, isDefault: false, logs
    };
  }

  /**
   * 报价主计算（V1.4「中长期 + 日前」两部制）。
   *  C_LT = Σ(逐时有效采购电量 × 逐时有效采购价格)        ← 批发曲线管理汇总
   *  E_t = max(Q_t − Q_LT,t, 0)                           ← 日前市场缺口
   *  C_DA,s = Σ(E_t × P_DA,s,t)                           ← 仅日前价格情景
   *  C总,s = C_LT/Q + C_DA,s/Q + (分摊−返还) + SR + O + 结构风险准备金
   *  P平,k = [Quantile(C总,qk) + Mk] / K；Πs,k = P平,k×K − C总,s（元/MWh）
   *  不含实时价格、负荷预测偏差与日前—实时偏差电费（V1.4 边界）。
   */
  function computeQuote(args) {
    const { q, W, wLt, params } = args;
    const K = args.K != null ? args.K : 1;
    const keys = args.keys;
    if (!Array.isArray(q) || !Array.isArray(keys) || q.length !== params.meta.hours || keys.length !== params.meta.hours) {
      throw new Error('客户曲线点数与参数年度小时数不一致');
    }
    if (!(W > 0)) throw new Error('年度批发均价 W 必须大于 0');
    if (!(wLt > 0)) throw new Error('中长期年度均价必须大于 0');
    if (!(K > 0)) throw new Error('K 因子必须为正');

    const cm = params.costModel || {};
    const th = cm.riskThresholds || {};
    const reserve = Number(cm.reservePerMwh || 0);
    const gNorm = normalize(params.baseline.curve);
    const Q = totalEnergy(q);
    if (!(Q > 0)) throw new Error('客户全年电量必须大于 0');
    const b = baselineCurve(Q, gNorm);

    // 批发曲线汇总（无曲线 → 系统默认基准假设，明确标注）
    const proc = buildProcurement(params.wholesaleCurves || [], q, keys, gNorm, {
      ratio: (params.defaults && params.defaults.coverageRatio != null) ? params.defaults.coverageRatio : 0.9,
      price: wLt
    });

    const wSum = params.scenarios.reduce((a, s) => a + Number(s.weight || 0), 0);
    if (Math.abs(wSum - 1) > 1e-6) {
      throw new Error('情景权重合计必须为 100%（当前 ' + (wSum * 100).toFixed(4) + '%），请在参数管理中修正');
    }

    const Clt = proc.totalCost / Q;                       // 中长期成本（各情景相同）
    const Ebase = b.map((_, t) => proc.gapMwh * gNorm[t]); // 基准日前暴露曲线 E_base,t = E×g_t

    // 到户层「预测度电分摊」：售电公司承担（absorb）→ 计入全成本；客户承担（pass）→ 转嫁不计入
    let billAbsorb = 0;
    const bl = params.billLayer;
    if (bl && bl.item && bl.item.bearer !== 'pass' && Array.isArray(bl.item.monthly)) {
      billAbsorb = annualizeMonthly(bl.item.monthly, q, keys).annual;
    }

    const scenarios = params.scenarios.map(s => {
      const alloc = Number(s.allocShare || 0), refund = Number(s.refundShare || 0);
      // priceMode='direct'：8760 价格值原样使用（实际/预测日前价格，不标定）；
      // 否则按「形状 × W_da」标定（比例估算，旧 v1/v2/v3 口径）
      const direct = s.priceMode === 'direct';
      const cal = direct
        ? { curve: s.curve, k: 1 }
        : calibratePriceCurve(gNorm, s.curve, W * Number(s.priceFactor == null ? 1 : s.priceFactor));
      const Wda = direct
        ? s.curve.reduce((a, v, t) => a + gNorm[t] * v, 0)   // 展示：直接曲线的统调加权均价
        : W * Number(s.priceFactor == null ? 1 : s.priceFactor);
      let Cda = 0, CVda = 0;
      for (let t = 0; t < q.length; t++) {
        Cda += proc.gap[t] * cal.curve[t];
        CVda += (proc.gap[t] - Ebase[t]) * cal.curve[t];      // 展示指标：日前曲线暴露
      }
      Cda /= Q; CVda /= Q;
      const Cwholesale = Clt + Cda + alloc - refund;
      const Csettle = Number(s.sr || 0), Ccredit = Number(s.o || 0);
      const Ctotal = Cwholesale + Csettle + Ccredit + reserve + billAbsorb;
      return {
        id: s.id, name: s.name, weight: Number(s.weight),
        priceFactor: Number(s.priceFactor == null ? 1 : s.priceFactor),
        allocShare: alloc, refundShare: refund,
        W_da: Wda, calibK: cal.k,
        Clt, Cda, CVda,
        Cwholesale, Csettle, Ccredit, Creserve: reserve, CbillAbsorb: billAbsorb, Ctotal
      };
    });

    const EC = scenarios.reduce((a, s) => a + s.weight * s.Ctotal, 0);

    // 三档价：P平,k = [Quantile(C总,qk)+Mk]/K
    const tiers = params.tiers.map(t => {
      const Cq = weightedQuantile(scenarios.map(s => ({ cost: s.Ctotal, weight: s.weight })), t.q);
      const equiv = Cq + t.M;                       // 等效平均签约价（= P平×K）
      const Pping = equiv / K;
      const perScenario = scenarios.map(s => {
        const pi = equiv - s.Ctotal;                // Πs,k（元/MWh）= 收入单价 − 全成本
        return { id: s.id, name: s.name, weight: s.weight, profit: pi };
      });
      const expectedProfit = equiv - EC;
      const lossProb = perScenario.filter(p => p.profit < 0).reduce((a, p) => a + p.weight, 0);
      const worstProfit = Math.min.apply(null, perScenario.map(p => p.profit));
      const { varA, cvar } = weightedVaRCVaR(perScenario.map(p => ({ loss: -p.profit, weight: p.weight })), th.varAlpha || 0.95);
      // 审批门槛（最低毛利 / 亏损概率 / CVaR）
      const gates = {
        margin: th.minGrossMargin != null ? expectedProfit >= th.minGrossMargin - EPS : true,
        lossProb: th.maxLossProbPct != null ? lossProb * 100 <= th.maxLossProbPct + EPS : true,
        cvar: th.maxCvar != null ? cvar <= th.maxCvar + EPS : true
      };
      gates.all = gates.margin && gates.lossProb && gates.cvar;
      // 风控红线（V1.0 保留，展示用）
      const rl = params.redLines || {};
      const warnings = [];
      if (rl.maxLossWeightPct != null && lossProb * 100 > rl.maxLossWeightPct + EPS) {
        warnings.push('亏损情景权重 ' + (lossProb * 100).toFixed(1) + '% 超过红线 ' + rl.maxLossWeightPct + '%');
      }
      if (rl.minWorstProfit != null && worstProfit < rl.minWorstProfit - EPS) {
        warnings.push('最差情景利润 ' + worstProfit.toFixed(2) + ' 元/MWh 低于红线 ' + rl.minWorstProfit + ' 元/MWh');
      }
      if (rl.minExpectedProfit != null && expectedProfit < rl.minExpectedProfit - EPS) {
        warnings.push('预期单位利润 ' + expectedProfit.toFixed(2) + ' 元/MWh 低于红线 ' + rl.minExpectedProfit + ' 元/MWh');
      }
      return {
        key: t.key, name: t.name, q: t.q, M: t.M, recommended: !!t.recommended, note: t.note || '',
        Cq, price: equiv, equiv, Pping,
        perScenarioProfit: perScenario, expectedProfit, lossWeight: lossProb, lossProb,
        worstProfit, bestProfit: Math.max.apply(null, perScenario.map(p => p.profit)),
        varAlpha: th.varAlpha || 0.95, VaR: varA, CVaR: cvar, gates, warnings
      };
    });

    return {
      Q, W, wLt, K, gNorm, baseline: b,
      procurement: {
        isDefault: proc.isDefault,
        coverage: proc.coverage,                 // 实际覆盖率（由批发曲线自动汇总）
        weightedPrice: proc.weightedPrice,       // 加权采购均价
        totalPurchase: proc.totalPurchase,
        gapMwh: proc.gapMwh,                     // 日前市场缺口
        overMwh: proc.overMwh,                   // 超覆盖量（>0 须警告）
        curveCount: (params.wholesaleCurves || []).filter(c => c.enabled !== false).length,
        logs: proc.logs,                         // 覆盖日志
        purchase: proc.purchase,                 // 逐时采购量（曲线解释页用）
        price: proc.price,                       // 逐时采购价
        source: proc.source,                     // 逐时来源
        gap: proc.gap,                           // 逐时日前缺口
        note: proc.isDefault
          ? '无有效批发曲线：使用系统默认年度基准假设（r0×Q×g_t，价格=W_LT），标注为默认假设'
          : '由 ' + ((params.wholesaleCurves || []).filter(c => c.enabled !== false).length) + ' 条有效批发曲线汇总；不把客户映射为公司真实采购合同'
      },
      scenarios, EC, tiers,
      reserve, thresholds: th
    };
  }

  /** 单位换算（主单位 元/MWh） */
  const unit = {
    toYuanPerKwh: v => v / 1000,   // 元/度
    toFenPerKwh: v => v / 10,      // 分/度
    fmt: (v, d) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d == null ? 2 : d),
    fmtSigned: (v, d) => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(d == null ? 2 : d)
  };

  /* ================= V1.1 峰平谷固定价 ================= */

  /**
   * 按峰谷时段表聚合客户电量。
   * @param q number[8760]（MWh） @param keys ['YYYY-MM-DD|HH', ...]
   * @param table {peak:number[], valley:number[]} 平段为补集
   * @param sharp {months:number[], hours:number[]} 尖峰（原峰谷用户适用）
   */
  function tofuAggregate(q, keys, table, sharp) {
    const peak = new Set(table.peak), valley = new Set(table.valley);
    const sM = new Set((sharp && sharp.months) || []), sH = new Set((sharp && sharp.hours) || []);
    let Qp = 0, Qf = 0, Qv = 0, Qsharp = 0;
    for (let t = 0; t < q.length; t++) {
      const h = +keys[t].slice(11, 13);
      if (valley.has(h)) Qv += q[t];
      else if (peak.has(h)) Qp += q[t];
      else Qf += q[t];
      if (sM.has(+keys[t].slice(5, 7)) && sH.has(h)) Qsharp += q[t];
    }
    const Q = Qp + Qf + Qv;
    return { Qp, Qf, Qv, Q, ap: Qp / Q, af: Qf / Q, av: Qv / Q, Qsharp };
  }

  /**
   * 零售结算层系数匹配（不得按曲线推断；重叠组合必须人工确认）。
   * @param uc 用户分类 {area:'gd'|'sz'|'sz_inc', pvPolicy:'yes'|'no'|'unknown',
   *                     lowVoltage:'yes'|'no', iceStorage:'yes'|'no'|'unknown', contractMode:'pv'|'flat'}
   * @param coeffRows 参数版本中的零售系数表
   * @returns {status:'ok'|'na'|'pending'|'conflict', row?, candidates?, reason}
   */
  function matchRetailCoeff(uc, coeffRows) {
    if (uc.contractMode === 'flat') {
      return { status: 'na', reason: '合同口径为「全时段同价」，不应用峰谷系数' };
    }
    if (uc.pvPolicy === 'no') {
      return { status: 'na', reason: '非原执行峰谷分时电价政策用户，不应用用户侧峰谷平衡机制' };
    }
    if (uc.pvPolicy === 'unknown') {
      return { status: 'pending', reason: '原峰谷政策状态「待核验」：报价仅供参考，正式导出被阻止' };
    }
    if (uc.iceStorage === 'unknown') {
      return { status: 'pending', reason: '蓄冷认定「待核验」：报价仅供参考，正式导出被阻止' };
    }
    const find = id => coeffRows.find(r => r.id === id);
    const isSz = uc.area === 'sz' || uc.area === 'sz_inc';
    if (uc.iceStorage === 'yes' && isSz && uc.lowVoltage === 'yes') {
      return {
        status: 'conflict',
        candidates: [find('ice'), find('sz_lv')].filter(Boolean),
        reason: '「深圳低压 + 蓄冷」重叠组合：已核验条款未给出优先级，须按用户档案/当期规则人工选择，不得自动套用'
      };
    }
    if (uc.iceStorage === 'yes') return { status: 'ok', row: find('ice') };
    if (isSz && uc.lowVoltage === 'yes') return { status: 'ok', row: find('sz_lv') };
    if (isSz) return { status: 'ok', row: find('sz') };
    return { status: 'ok', row: find('gd_other') };
  }

  /**
   * 深圳第二层（输配/终端峰谷比价）查询——仅展示，不得替代零售结算层。
   * @param uc {category, voltage, metering, area, capacityKva}
   * @param szCfg 参数版本 peakValley.szTerminal
   */
  function szTerminalLookup(uc, szCfg) {
    if (!(uc.area === 'sz')) {
      if (uc.area === 'sz_inc') return { row: null, note: '增量配电网：深圳比价表明确不含前海蛇口自贸区增量配电网区域，需人工确认' };
      return { row: null, note: '非深圳供电局区域，不涉及终端比价表' };
    }
    const colMap = { '10kV|高供高计': '10kV高供高计', '10kV|高供低计': '10kV高供低计' };
    const col = colMap[uc.voltage + '|' + uc.metering] ||
      (['20kV', '110kV', '220kV及以上'].includes(uc.voltage) ? uc.voltage : null);
    if (!col) return { row: null, note: '电压/计量组合「' + uc.voltage + '·' + uc.metering + '」不在比价表列内，需人工确认' };
    const row = szCfg.rows.find(r => r.category === uc.category && r.col === col);
    if (!row) return { row: null, note: '用电类别「' + uc.category + '」在「' + col + '」列无对应系数，需人工确认' };
    const warns = [];
    if (uc.capacityKva > 0) {
      if (uc.category.indexOf('≥3001') >= 0 && uc.capacityKva < 3001) warns.push('容量 ' + uc.capacityKva + ' kVA 与「高需求（≥3001kVA）」类别矛盾');
      if (uc.category.indexOf('101–3000') >= 0 && (uc.capacityKva < 101 || uc.capacityKva > 3000)) warns.push('容量 ' + uc.capacityKva + ' kVA 与「大量（101–3000kVA）」类别矛盾');
    }
    return { row, note: '输配/终端费用层，仅展示；不替代零售结算层系数', warns };
  }

  /** 峰平谷价格组：P平 = P等效 / K；P峰 = f1×P平；P谷 = f2×P平；收入 = Q×P平×K = Q×P等效 */
  function peakValleyPrices(pEquiv, shares, f1, f2) {
    const K = f1 * shares.ap + shares.af + f2 * shares.av;
    if (!(K > 0)) throw new Error('系数加权因子 K 非正');
    const Pping = pEquiv / K;
    return { K, Pping, Pfeng: f1 * Pping, Pgu: f2 * Pping, revenue: shares.Q * Pping * K, pEquiv };
  }

  /**
   * 峰谷风险单列项（不计入三档价；原始暴露 ≠ 最终分摊额）。
   * C峰谷原始 = P年度交易均价 × [(f1−1)×Q峰 − (1−f2)×Q谷]
   * 尖峰电能量加价 = 单价基准 × f1 × 0.25 × Q尖；尖峰输配加价 = 峰段输配电价 × 0.25 × Q尖
   */
  function peakValleyRisks(args) {
    const { W, shares, f1, f2, sharpCfg, riskDefaults } = args;
    const rate = (sharpCfg && sharpCfg.energyPremiumRate != null) ? sharpCfg.energyPremiumRate : 0.25;
    const tndRate = (sharpCfg && sharpCfg.tndPremiumRate != null) ? sharpCfg.tndPremiumRate : 0.25;
    const tndPrice = (sharpCfg && sharpCfg.tndPeakPricePerMwh) || 0;
    const exposureTotal = W * ((f1 - 1) * shares.Qp - (1 - f2) * shares.Qv);
    return {
      exposureTotal, exposurePerMwh: exposureTotal / shares.Q,
      sharpEnergy: W * f1 * rate * shares.Qsharp,
      sharpTnd: tndPrice * tndRate * shares.Qsharp,
      sysOpFee: ((riskDefaults && riskDefaults.sysOpFeePerMwh) || 0) * shares.Q,
      marketShare: ((riskDefaults && riskDefaults.marketSharePerMwh) || 0) * shares.Q,
      Qsharp: shares.Qsharp
    };
  }

  /**
   * 到户层「预测度电分摊」年度化：逐月值按客户逐月电量加权。
   * @param monthly number[12]（元/MWh） @param q number[8760] @param keys 8760 时间键
   * @returns { annual, Qm } annual=Σ(m_m×Q_m)/Q；Qm 为逐月电量
   */
  function annualizeMonthly(monthly, q, keys) {
    const Qm = new Array(12).fill(0);
    for (let t = 0; t < q.length; t++) Qm[+keys[t].slice(5, 7) - 1] += q[t];
    const Q = Qm.reduce((a, b) => a + b, 0);
    if (!(Q > 0)) return { annual: 0, Qm };
    let s = 0;
    for (let m = 0; m < 12; m++) s += (Number((monthly || [])[m]) || 0) * Qm[m];
    return { annual: s / Q, Qm };
  }

  return {
    EPS, normalize, totalEnergy, baselineCurve, calibratePriceCurve,
    curveValue, curveValueContribs, exposureCost, weightedQuantile, weightedVaRCVaR,
    computeQuote, unit, annualizeMonthly,
    tofuAggregate, matchRetailCoeff, szTerminalLookup, peakValleyPrices, peakValleyRisks,
    GRAN_RANK, GRAN_NAME, expandCurve, buildProcurement
  };
});
