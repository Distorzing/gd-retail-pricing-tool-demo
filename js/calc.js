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

  /**
   * 报价主计算（V1.2/1.3 三部制成本模型）。
   *  C批发,s = Σt[QLT×PLT + (QDA−QLT)×PDA + (Q实−QDA)×PRT] + C分摊,s − R返还,s
   *  QLT,t = r×Q×g_t（标准代理配置）；QDA,t = Q×g_t×(1+ε_s)；Q实,t = q_t
   *  C总,s = C批发,s + C结算,s(SR) + C信用服务,s(O) + 结构风险准备金
   *  P平,k = [Quantile(C总,qk) + Mk] / K；Πs,k = P平,k×K − C总,s（元/MWh）
   * @param {object} args
   *  q: number[8760] 客户逐时电量（MWh）
   *  W: number 日前价格锚点（元/MWh）
   *  wLt: number 中长期年度均价（元/MWh，平坦分时）
   *  coverageRatio: 0~1
   *  K: number 峰谷系数加权因子（非峰谷用户=1）
   *  params: 系统参数版本
   */
  function computeQuote(args) {
    const { q, W, wLt, coverageRatio, params } = args;
    const K = args.K != null ? args.K : 1;
    if (!Array.isArray(q) || q.length !== params.meta.hours) {
      throw new Error('客户曲线点数与参数年度小时数不一致');
    }
    if (!(W > 0)) throw new Error('年度批发均价 W 必须大于 0');
    if (!(wLt > 0)) throw new Error('中长期年度均价必须大于 0');
    if (!(coverageRatio >= 0 && coverageRatio <= 1)) throw new Error('中长期覆盖比例须在 0%–100% 之间');
    if (!(K > 0)) throw new Error('K 因子必须为正');

    const cm = params.costModel || {};
    const th = cm.riskThresholds || {};
    const reserve = Number(cm.reservePerMwh || 0);
    const gNorm = normalize(params.baseline.curve);
    const Q = totalEnergy(q);
    if (!(Q > 0)) throw new Error('客户全年电量必须大于 0');
    const b = baselineCurve(Q, gNorm);
    const r = coverageRatio;

    const wSum = params.scenarios.reduce((a, s) => a + Number(s.weight || 0), 0);
    if (Math.abs(wSum - 1) > 1e-6) {
      throw new Error('情景权重合计必须为 100%（当前 ' + (wSum * 100).toFixed(4) + '%），请在参数管理中修正');
    }

    // 逐情景三部制成本
    const scenarios = params.scenarios.map(s => {
      const rtF = Number(s.rtFactor != null ? s.rtFactor : 1.05);
      const eps = Number(s.loadError || 0);
      const alloc = Number(s.allocShare || 0), refund = Number(s.refundShare || 0);
      const Wda = W * Number(s.priceFactor == null ? 1 : s.priceFactor);
      const cal = calibratePriceCurve(gNorm, s.curve, Wda);   // PDA,s,t（标定到日前锚点）
      let Clt = 0, Cda = 0, Crt = 0, CVda = 0;
      for (let t = 0; t < q.length; t++) {
        const qlt = r * b[t];                  // QLT,t = r×Q×g_t
        const qda = b[t] * (1 + eps);          // QDA,t = Q×g_t×(1+ε)
        const pda = cal.curve[t];
        const prt = pda * rtF;
        Clt += qlt * wLt;
        Cda += (qda - qlt) * pda;
        Crt += (q[t] - qda) * prt;
        CVda += (q[t] - b[t]) * pda;           // 展示指标：日前曲线暴露
      }
      Clt /= Q; Cda /= Q; Crt /= Q; CVda /= Q;
      const Cwholesale = Clt + Cda + Crt + alloc - refund;
      const Csettle = Number(s.sr || 0), Ccredit = Number(s.o || 0);
      const Ctotal = Cwholesale + Csettle + Ccredit + reserve;
      return {
        id: s.id, name: s.name, weight: Number(s.weight),
        priceFactor: Number(s.priceFactor == null ? 1 : s.priceFactor),
        rtFactor: rtF, loadError: eps, allocShare: alloc, refundShare: refund,
        W_da: Wda, calibK: cal.k,
        Clt, Cda, Crt, CVda, CVrt: Crt,
        Cwholesale, Csettle, Ccredit, Creserve: reserve, Ctotal
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
      Q, W, wLt, coverageRatio, K, gNorm, baseline: b,
      proxy: {
        mode: (cm.procurementMode || 'standard_proxy'),
        note: cm.procurementNote || '',
        QLTsum: r * Q, QDAsum: Q, Qsum: Q
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

  return {
    EPS, normalize, totalEnergy, baselineCurve, calibratePriceCurve,
    curveValue, curveValueContribs, exposureCost, weightedQuantile, weightedVaRCVaR,
    computeQuote, unit,
    tofuAggregate, matchRetailCoeff, szTerminalLookup, peakValleyPrices, peakValleyRisks
  };
});
