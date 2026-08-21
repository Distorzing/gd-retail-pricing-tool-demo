/* 导出与留痕：JSON 快照下载 + 报价说明（打印版） */
(function (root) {
  'use strict';

  const U = () => (typeof root !== 'undefined' && root.Calc && root.Calc.unit) ? root.Calc.unit : (typeof require !== 'undefined' ? require('./calc.js').unit : null);

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function f2(v) { return U().fmt(v, 2); }
  function signed(v) { return U().fmtSigned(v, 2); }
  function fen(v) { return U().fmt(U().toFenPerKwh(v), 2); }
  function yuan(v) { return U().fmt(U().toYuanPerKwh(v), 4); }
  function escH(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function tierRows(result, pv) {
    return result.tiers.map(t => {
      const warn = t.warnings.length ? '⚠ ' + t.warnings.join('；') : '—';
      const be = t.breakEven || {};
      const tou = (t.retail ? { f1: (t.retail.tou || {}).f1, f2: (t.retail.tou || {}).f2 } : null) || { f1: 1, f2: 1 };
      const pP = be.flatPrice != null ? be.flatPrice : null;
      const eq = t.retail ? t.retail.unitPrice : t.price;
      const priceCells =
        '<td class="num">' + (pP != null ? f2(tou.f1 * pP) : '—') + '</td>' +
        '<td class="num"><b>' + (pP != null ? f2(pP) : '—') + '</b></td>' +
        '<td class="num">' + (pP != null ? f2(tou.f2 * pP) : '—') + '</td>' +
        '<td class="num">' + f2(t.equiv) + '</td>' +
        '<td class="num">' + f2(eq) + '</td>' +
        '<td class="num">' + fen(eq) + '</td>';
      return '<tr>' +
        '<td><b>' + t.name + '</b>' + (t.recommended ? '（推荐）' : '') + '</td>' +
        priceCells +
        '<td class="num">' + signed(t.profitPerMwh != null ? t.profitPerMwh : t.expectedProfit) + '</td>' +
        '<td class="num">' + (t.lossWeight * 100).toFixed(1) + '%</td>' +
        '<td class="num">' + signed(t.worstProfit) + '</td>' +
        '<td>' + warn + '</td></tr>';
    }).join('');
  }

  function ucRows(uc, retail) {
    if (retail && retail.input) {
      return '<tr><td>用户类型（零售收入）</td><td>' + escH(retail.input.userType) + '（f1=' + retail.result.tou.f1 + ' / f2=' + retail.result.tou.f2 + '）</td></tr>' +
        '<tr><td>固定价格结构</td><td>固定占比 ' + (retail.input.fixed.ratio * 100).toFixed(1) + '% @平段价 ' + retail.input.fixed.flatPrice + ' 元/MWh' +
        (retail.input.link.modes.length ? '；联动 ' + retail.input.link.modes.map(m => '方式' + m.type + ' ' + (m.ratio * 100).toFixed(1) + '%@' + m.flatPrice).join('、') : '') + '</td></tr>' +
        (retail.input.coal.enabled ? '<tr><td>煤电联动</td><td>CECI ' + retail.input.coal.ceciSign + '→' + retail.input.coal.ceciSettle + ' @浮动 ' + retail.input.coal.floatPrice + ' 元/MWh</td></tr>' : '') +
        (retail.input.floatFee.enabled ? '<tr><td>浮动电费</td><td>' + retail.input.floatFee.price + ' 元/MWh</td></tr>' : '');
    }
    return '';
  }

  function pvSection(pv, retail) {
    if (!retail || !retail.result) return '';
    const r = retail.result;
    const w = v => (v / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    const rows = [
      ['固定价格电费', r.energy.fixed.total],
      ['市场联动电费', r.energy.linked.total],
      ['煤电联动电费', r.energy.coal ? r.energy.coal.total : null],
      ['浮动电费', r.energy.floatFee ? r.energy.floatFee.total : null],
      ['峰谷平衡·谷段补贴', r.peakValley.valleySubsidy],
      ['峰谷平衡·峰段惩罚', -r.peakValley.peakPenalty],
    ].filter(x => x[1] != null && Math.abs(x[1]) > 1e-9);
    return '<h2>零售侧收入明细（电能量+峰谷平衡）</h2><table>' +
      '<tr><th>收入组件</th><th>金额（万元）</th><th>占比</th></tr>' +
      rows.map(x => '<tr><td>' + escH(x[0]) + '</td><td class="num">' + w(x[1]) + '</td><td class="num">' + (x[1] / r.grandTotal * 100).toFixed(1) + '%</td></tr>').join('') +
      '<tr><td><b>零售收入合计</b></td><td class="num"><b>' + w(r.grandTotal) + '</b></td><td class="num">100%</td></tr>' +
      '<tr><td>折合度电单价</td><td colspan="2">' + r.unitPriceYuanPerKwh.toFixed(4) + ' 元/kWh（' + f2(r.unitPrice) + ' 元/MWh）</td></tr></table>' +
      '<div class="meta">用户类型：' + escH(retail.input.userType) + '（f1=' + r.tou.f1 + ' / f2=' + r.tou.f2 + '）· 峰/平/谷 ' +
      f2(r.usage.peak) + ' / ' + f2(r.usage.flat) + ' / ' + f2(r.usage.valley) + ' MWh</div>';
  }

  /** 生成打印版报价说明 HTML */
  function buildReportHTML(ctx) {
    const { result, inputs, paramMeta, calcTime, validation, pv } = ctx;
    const r = result;
    const pvActive = true;   // 零售口径下恒为峰平谷结构
    const cm = (ctx.params && ctx.params.costModel) || {};
    const bill = ctx.bill || null;
    const billAdd = bill && bill.item.bearer === 'pass' ? bill.annual : 0;
    const priceHead = '<th>P峰<br>元/MWh</th><th>盈亏平衡 P平<br>元/MWh</th><th>P谷<br>元/MWh</th><th>成本口径<br>元/MWh</th><th>零售等效<br>元/MWh</th><th>分/度</th>';
    const gateTxt = (pv && pv.formalBlocked)
      ? '<div class="warn" style="font-weight:700">⛔ 本结果为内部测算：' + escH(pv.blockReason) + '，不得作为正式对客报价。</div>'
      : '';
    const tierHeads = r.tiers.map(t => '<th>' + t.name + '利润<br>(元/MWh)</th>').join('');
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>报价说明</title><style>' +
      'body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#111;max-width:900px;margin:24px auto;padding:0 16px;font-size:13px}' +
      'h1{font-size:20px}h2{font-size:15px;margin:20px 0 8px;border-left:4px solid #2563eb;padding-left:8px}' +
      'table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #cbd5e1;padding:5px 8px;text-align:left}' +
      'th{background:#f1f5f9}.num{text-align:right;font-variant-numeric:tabular-nums}' +
      '.meta{color:#555;font-size:12px}.warn{color:#b91c1c}.disc{margin-top:24px;padding:10px;border:1px dashed #94a3b8;color:#555;font-size:12px}' +
      '@media print{body{margin:0}}' +
      '</style></head><body>' +
      '<h1>单客户峰平谷固定价报价说明</h1>' + gateTxt +
      '<div class="meta">客户：' + escH(inputs.customerName || '（未命名）') +
      '　|　测算时间：' + calcTime +
      '　|　参数版本：' + paramMeta.versionName + '（' + paramMeta.versionId + '，生效 ' + paramMeta.effectiveDate + '）' +
      '　|　单客户边际报价模拟（标准代理配置，非真实采购合同匹配）</div>' +

      '<h2>一、输入快照</h2><table>' +
      '<tr><th>项目</th><th>取值</th></tr>' +
      '<tr><td>报价年度 / 曲线点数</td><td>' + paramMeta.year + ' 年 / ' + validation.count + ' 点（8760 校验通过）</td></tr>' +
      '<tr><td>客户全年电量 Q</td><td>' + r.Q.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) + ' MWh</td></tr>' +
      '<tr><td>日前价格锚点 W / 中长期均价 W_LT</td><td>' + f2(inputs.W) + ' / ' + f2(r.wLt) + ' 元/MWh</td></tr>' +
      '<tr><td>中长期覆盖率（批发曲线自动汇总）</td><td>' + (r.procurement.coverage * 100).toFixed(1) + '%' +
      (r.procurement.isDefault ? '（默认年度基准假设）' : '（' + r.procurement.curveCount + ' 条批发曲线）') +
      '；加权采购均价 ' + f2(r.procurement.weightedPrice) + ' 元/MWh；日前市场缺口 ' + r.procurement.gapMwh.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) + ' MWh</td></tr>' +
      '<tr><td>结构风险准备金（估算）</td><td>' + f2(r.reserve) + ' 元/MWh · ' + ((cm.reserveApproval && cm.reserveApproval.ok) ? '已审批（' + escH(cm.reserveApproval.by) + '）' : '未审批') + '</td></tr>' +
      ucRows(ctx.uc, ctx.retail) + '</table>' +

      '<h2>二、三档峰平谷固定价' + (pvActive ? '' : '（单一固定价）') + '</h2><table>' +
      '<tr><th>档位</th>' + priceHead + '<th>预期利润<br>(元/MWh)</th><th>亏损概率</th><th>CVaR95<br>(元/MWh)</th><th>门槛</th></tr>' +
      tierRows(r, pv) + '</table>' +
      '<div class="meta">定价公式（V1.2）：P平,k = [Quantile(C总,qk) + Mk] / K；P峰=f1×P平，P谷=f2×P平，等效平均签约价=P平×K。' +
      'C总 = C批发 + C结算 + C信用服务 + 结构风险准备金（估算）；C批发按中长期/日前/实时三部制分解。</div>' +

      '<h2>三、两部制成本拆分（中长期+日前，单位：元/MWh）</h2><table>' +
      '<tr><th>情景</th><th>权重</th><th>W_da</th><th>标定<br>系数k</th><th>中长期<br>Clt</th><th>日前缺口<br>Cda</th>' +
      '<th>曲线价值<br>G_curve*</th><th>分摊−<br>返还</th><th>结算<br>SR</th><th>信用<br>服务</th><th>准备金</th><th>C总</th>' + tierHeads + '</tr>' +
      scenarioRows(r) +
      '<tr><td><b>加权期望 E[C总]</b></td><td class="num">100%</td><td colspan="8"></td><td class="num"><b>' + signed(r.scenarios.reduce((a, s) => a + s.weight * s.Gcurve, 0)) + '</b></td><td class="num"><b>' + f2(r.EC) + '</b></td>' +
      r.tiers.map(t => '<td class="num"><b>' + signed(t.expectedProfit) + '</b></td>').join('') + '</tr></table>' +
      '<div class="meta">Πs = 零售收入单价 − C总,s；亏损概率、VaR/CVaR 按情景权重计算，不假设正态分布。C_LT=Σ(有效采购电量×采购价) 由批发曲线汇总；日前缺口 E_t=max(Q_t−Q_LT,t,0)，C_DA,s=Σ(E_t×P_DA,s,t)。曲线价值 G_curve=Σ持仓电量×(日前价−持仓价)/Q（持仓曲线相对现货的差价收益），仅展示、已含于批发成本，不重复计入。本口径不含实时价格与日前—实时偏差电费。</div>' +

      pvSection(ctx.pv, ctx.retail) +
      billSection(bill, billAdd, r) +

      '<h2>四、曲线暴露解读</h2><div>' + ctx.cvExplanation + '</div>' +

      '<div class="disc"><b>重要提示：</b>本结果为模型测算价，不替代正式结算单。' +
      '价格情景、权重、结算调整、信用服务、峰谷系数与时段、风险门槛、准备金等均为系统维护的可配置参数（非市场真值）。' +
      '参数来源：' + escH(paramMeta.source || '—') + '。统调曲线仅作比较基准与标准代理配置曲线，不代表公司实际采购分配。</div>' +
      '</body></html>';
  }

  function billSection(bill, billAdd, r) {
    if (!bill || !bill.item) return '';
    const it = bill.item;
    const bearerTxt = it.bearer === 'pass' ? '客户承担（代收/转嫁）' : '售电公司承担（不入到户价）';
    return '<h2>五、预计到户账单：预测度电分摊（单列，非电能量收入）</h2><table>' +
      '<tr><th>月份</th>' + Array.from({ length: 12 }, (_, m) => '<th class="num">' + (m + 1) + '月</th>').join('') + '</tr>' +
      '<tr><td>分摊值（元/MWh）</td>' + it.monthly.map(v => '<td class="num">' + f2(v) + '</td>').join('') + '</tr>' +
      '<tr><td>该月电量（MWh）</td>' + Array.from(bill.Qm, v => '<td class="num">' + f2(v) + '</td>').join('') + '</tr></table>' +
      '<div class="meta">年度化分摊 = Σ(月值×该月电量)/全年电量 = <b>' + f2(bill.annual) + ' 元/MWh</b>（' + bearerTxt + '）。' +
      '预计到户参考价 = 电能量等效价 + ' + f2(billAdd) + '：' +
      r.tiers.map(t => t.name + ' ' + f2(t.price + billAdd)).join(' ｜ ') + ' 元/MWh。到户项目承担方由合同模板开关决定。</div>';
  }

  function scenarioRows(result) {
    return result.scenarios.map(s => {
      const profits = result.tiers.map(t => {
        const p = t.perScenarioProfit.find(x => x.id === s.id);
        return '<td class="num">' + signed(p ? p.profit : NaN) + '</td>';
      }).join('');
      return '<tr><td>' + s.name + '</td>' +
        '<td class="num">' + (s.weight * 100).toFixed(2) + '%</td>' +
        '<td class="num">' + f2(s.W_da) + '</td>' +
        '<td class="num">' + f2(s.calibK, 4) + '</td>' +
        '<td class="num">' + f2(s.Clt) + '</td>' +
        '<td class="num">' + f2(s.Cda) + '</td>' +
        '<td class="num">' + signed(s.Gcurve) + '</td>' +
        '<td class="num">' + signed(s.allocShare - s.refundShare) + '</td>' +
        '<td class="num">' + f2(s.Csettle) + '</td>' +
        '<td class="num">' + f2(s.Ccredit) + '</td>' +
        '<td class="num">' + f2(s.Creserve) + '</td>' +
        '<td class="num"><b>' + f2(s.Ctotal) + '</b></td>' + profits + '</tr>';
    }).join('');
  }

  function openPrintableReport(html) {
    const w = window.open('', '_blank');
    if (!w) { alert('浏览器拦截了新窗口，请允许弹出窗口后重试'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
  }

  /** 组装留痕快照对象（输入 + 参数版本 + 计算时间 + 全部中间结果 + 风险提示） */
  function buildSnapshot(ctx) {
    const { result, inputs, paramMeta, calcTime, validation, cvExplanation } = ctx;
    return {
      type: '单客户峰平谷固定价报价快照（V1.3 三部制）',
      savedNote: '模型测算价，不替代正式结算单',
      gate: {
        formal: !(ctx.pv && ctx.pv.formalBlocked),
        note: (ctx.pv && ctx.pv.formalBlocked) ? ('内部测算：' + ctx.pv.blockReason) : '通过正式报价闸门',
        reasons: (ctx.pv && ctx.pv.gateReasons) || []
      },
      calcTime,
      inputs: {
        customerName: inputs.customerName || '',
        W: inputs.W, wLt: result.wLt,
        coverageAuto: result.procurement.coverage, coverageIsDefault: result.procurement.isDefault,
        unit: inputs.unit,
        curvePoints: validation.count,
        Q_MWh: result.Q
      },
      retail: ctx.retail ? { userType: ctx.retail.input.userType, fixed: ctx.retail.input.fixed, link: ctx.retail.input.link } : null,
      paramVersion: {
        versionId: paramMeta.versionId, versionName: paramMeta.versionName,
        effectiveDate: paramMeta.effectiveDate, createdAt: paramMeta.createdAt,
        source: paramMeta.source,
        redLines: ctx.redLines,
        costModel: (ctx.params && ctx.params.costModel) || null
      },
      assumptions: {
        procurement: result.proxy,
        priceAnchor: 'W 为日前价格锚点（仅锚点，价格形状由情景维护）；W_LT 为中长期均价锚点（平坦分时）',
        proxyVolumes: 'QLT=r×Q×g_t；QDA=Q×g_t×(1+ε_s)；Q实=客户8760曲线',
        noDoubleCount: '曲线差异仅计入实时偏差层；CV日前/CV实时仅作分列展示'
      },
      intermediates: {
        scenarios: result.scenarios.map(s => ({
          id: s.id, name: s.name, weight: s.weight, priceFactor: s.priceFactor,
          allocShare: s.allocShare, refundShare: s.refundShare,
          W_da: s.W_da, calibK: s.calibK,
          Clt: s.Clt, Cda: s.Cda, Crt: s.Crt,
          CVda: s.CVda, CVrt: s.CVrt,
          Cwholesale: s.Cwholesale, Csettle: s.Csettle, Ccredit: s.Ccredit,
          Creserve: s.Creserve, Ctotal: s.Ctotal
        })),
        EC: result.EC,
        tiers: result.tiers.map(t => ({
          key: t.key, name: t.name, q: t.q, M: t.M,
          Cq: t.Cq, price: t.price, Pping: t.Pping,
          expectedProfit: t.expectedProfit, lossProb: t.lossProb,
          worstProfit: t.worstProfit, VaR: t.VaR, CVaR: t.CVaR, varAlpha: t.varAlpha,
          gates: t.gates, perScenarioProfit: t.perScenarioProfit,
          warnings: t.warnings,
          breakEven: t.breakEven ? { flatPrice: t.breakEven.flatPrice, K: t.breakEven.K } : null,
          retailUnitPrice: t.retail ? t.retail.unitPrice : null,
          profitPerMwh: t.profitPerMwh != null ? t.profitPerMwh : null
        }))
      },
      procurementSummary: {
        isDefault: result.procurement.isDefault,
        coverage: result.procurement.coverage,
        weightedPrice: result.procurement.weightedPrice,
        gapMwh: result.procurement.gapMwh, overMwh: result.procurement.overMwh,
        curveCount: result.procurement.curveCount, logs: result.procurement.logs,
        curves: (ctx.params.wholesaleCurves || []).map(c => ({
          id: c.id, name: c.name, status: c.status, enabled: c.enabled,
          window: c.window, granularity: c.granularity, quantityMode: c.quantityMode,
          entryCount: (c.entries || []).length, createdAt: c.createdAt, updatedAt: c.updatedAt
        }))
      },
      peakValley: ctx.pv ? {
        active: ctx.pv.active, status: ctx.pv.status, reason: ctx.pv.reason,
        coeffRow: ctx.pv.coeffRow || null, chosenByUser: !!ctx.pv.chosenByUser,
        K: ctx.pv.K, shares: ctx.pv.shares || null,
        ruleVersion: ctx.pv.ruleVersion, effectiveDate: ctx.pv.effectiveDate,
        sources: ctx.pv.sources,
      } : null,
      billLayer: ctx.bill ? { item: ctx.bill.item, annual: ctx.bill.annual } : null,
      cvExplanation
    };
  }

  root.Exporter = { downloadJSON, buildReportHTML, openPrintableReport, buildSnapshot };
  if (typeof module !== 'undefined' && module.exports) { module.exports = { Exporter: root.Exporter }; }
})(typeof self !== 'undefined' ? self : this);
