/* 导出与留痕：JSON 快照下载 + 报价说明（打印版） */
(function (root) {
  'use strict';

  const U = () => root.Calc.unit;

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
      let priceCells;
      if (pv && pv.active) {
        const p = pv.perTier[t.key];
        priceCells =
          '<td class="num">' + f2(p.Pfeng) + '</td>' +
          '<td class="num"><b>' + f2(p.Pping) + '</b></td>' +
          '<td class="num">' + f2(p.Pgu) + '</td>' +
          '<td class="num">' + f2(t.price) + '</td>' +
          '<td class="num">' + f2(U().toYuanPerKwh(t.price), 4) + '</td>' +
          '<td class="num">' + fen(t.price) + '</td>';
      } else {
        priceCells =
          '<td class="num" colspan="3">—（单一固定价）</td>' +
          '<td class="num">' + f2(t.price) + '</td>' +
          '<td class="num">' + yuan(t.price) + '</td>' +
          '<td class="num">' + fen(t.price) + '</td>';
      }
      return '<tr>' +
        '<td><b>' + t.name + '</b>' + (t.recommended ? '（推荐）' : '') + '</td>' +
        priceCells +
        '<td class="num">' + signed(t.expectedProfit) + '</td>' +
        '<td class="num">' + (t.lossWeight * 100).toFixed(1) + '%</td>' +
        '<td class="num">' + signed(t.worstProfit) + '</td>' +
        '<td>' + warn + '</td></tr>';
    }).join('');
  }

  const UC_LABEL = {
    area: { gd: '广东（非深圳）', sz: '深圳供电局区域', sz_inc: '深圳增量配电网' },
    pvPolicy: { yes: '原执行峰谷分时电价', no: '原不执行峰谷价格政策', unknown: '待核验' },
    yn: { yes: '是', no: '否', unknown: '待核验' },
    contractMode: { pv: '峰平谷系数结算', flat: '全时段同价' }
  };
  function ucRows(uc) {
    if (!uc) return '';
    return '<tr><td>合同价口径</td><td>' + UC_LABEL.contractMode[uc.contractMode] + '</td></tr>' +
      '<tr><td>供电营业区</td><td>' + UC_LABEL.area[uc.area] + '</td></tr>' +
      '<tr><td>原峰谷政策状态</td><td>' + UC_LABEL.pvPolicy[uc.pvPolicy] + '</td></tr>' +
      '<tr><td>低压标识 / 蓄冷认定</td><td>' + UC_LABEL.yn[uc.lowVoltage] + ' / ' + UC_LABEL.yn[uc.iceStorage] + '</td></tr>' +
      '<tr><td>电压等级 / 计量方式</td><td>' + escH(uc.voltage) + ' / ' + escH(uc.metering) + '</td></tr>' +
      '<tr><td>用电类别 / 容量</td><td>' + escH(uc.category) + (uc.capacityKva ? ' / ' + uc.capacityKva + ' kVA' : ' / 未填') + '</td></tr>';
  }

  function pvSection(ctx) {
    const pv = ctx.pv;
    if (!pv) return '';
    if (!pv.active) {
      return '<h2>峰谷规则匹配</h2><div class="meta">未进入峰谷平衡机制：' + escH(pv.reason || '—') + '，报价按单一固定价输出。</div>';
    }
    const rk = pv.risks;
    const w = v => (v / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    const srcLinks = (pv.sources || []).map(s => '<a href="' + escH(s.url) + '">' + escH(s.name) + '</a>').join('<br>');
    return '<h2>峰谷规则匹配（V1.1）</h2><table>' +
      '<tr><th>项目</th><th>内容</th></tr>' +
      '<tr><td>匹配系数行</td><td>' + escH(pv.coeffRow.name) + '（f1=' + pv.coeffRow.f1 + ' / 平=1.00 / f2=' + pv.coeffRow.f2 + '）' + (pv.chosenByUser ? '（重叠组合，人工选定）' : '') + '</td></tr>' +
      '<tr><td>规则版本 / 生效日期</td><td>' + escH(pv.ruleVersion) + ' / ' + escH(pv.effectiveDate) + ' 起</td></tr>' +
      '<tr><td>电量结构</td><td>Q峰 ' + f2(pv.shares.Qp) + ' / Q平 ' + f2(pv.shares.Qf) + ' / Q谷 ' + f2(pv.shares.Qv) + ' MWh；Q尖 ' + f2(pv.shares.Qsharp) + ' MWh</td></tr>' +
      '<tr><td>官方来源</td><td>' + srcLinks + '</td></tr></table>' +
      '<h2>峰谷平衡风险（单列，未计入报价）</h2><table>' +
      '<tr><th>项目</th><th>金额（万元）</th><th>说明</th></tr>' +
      '<tr><td>峰谷平衡原始暴露</td><td class="num">' + w(rk.exposureTotal) + '</td><td>C=W×[(f1−1)Q峰−(1−f2)Q谷]=' + signed(rk.exposurePerMwh) + ' 元/MWh；原始暴露≠最终分摊</td></tr>' +
      '<tr><td>尖峰电能量加价（估算）</td><td class="num">' + w(rk.sharpEnergy) + '</td><td>W×f1×0.25×Q尖</td></tr>' +
      '<tr><td>尖峰输配加价（估算）</td><td class="num">' + w(rk.sharpTnd) + '</td><td>峰段输配电价×0.25×Q尖</td></tr>' +
      '<tr><td>峰谷相关系统运行费</td><td class="num">' + w(rk.sysOpFee) + '</td><td>配置单价×Q</td></tr>' +
      '<tr><td>市场化分摊（峰谷相关）</td><td class="num">' + w(rk.marketShare) + '</td><td>配置单价×Q</td></tr></table>';
  }

  /** 生成打印版报价说明 HTML */
  function buildReportHTML(ctx) {
    const { result, inputs, paramMeta, calcTime, validation, pv } = ctx;
    const r = result;
    const pvActive = pv && pv.active;
    const cm = (ctx.params && ctx.params.costModel) || {};
    const bill = ctx.bill || null;
    const billAdd = bill && bill.item.bearer === 'pass' ? bill.annual : 0;
    const priceHead = pvActive
      ? '<th>峰价<br>元/MWh</th><th>平价<br>元/MWh</th><th>谷价<br>元/MWh</th><th>等效平均价<br>元/MWh</th><th>元/度</th><th>分/度</th>'
      : '<th colspan="3">峰/平/谷</th><th>元/MWh</th><th>元/度</th><th>分/度</th>';
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
      ucRows(ctx.uc) + '</table>' +

      '<h2>二、三档峰平谷固定价' + (pvActive ? '' : '（单一固定价）') + '</h2><table>' +
      '<tr><th>档位</th>' + priceHead + '<th>预期利润<br>(元/MWh)</th><th>亏损概率</th><th>CVaR95<br>(元/MWh)</th><th>门槛</th></tr>' +
      tierRows(r, pv) + '</table>' +
      '<div class="meta">定价公式（V1.2）：P平,k = [Quantile(C总,qk) + Mk] / K；P峰=f1×P平，P谷=f2×P平，等效平均签约价=P平×K。' +
      'C总 = C批发 + C结算 + C信用服务 + 结构风险准备金（估算）；C批发按中长期/日前/实时三部制分解。</div>' +

      '<h2>三、两部制成本拆分（中长期+日前，单位：元/MWh）</h2><table>' +
      '<tr><th>情景</th><th>权重</th><th>W_da</th><th>标定<br>系数k</th><th>中长期<br>Clt</th><th>日前缺口<br>Cda</th>' +
      '<th>分摊−<br>返还</th><th>结算<br>SR</th><th>信用<br>服务</th><th>准备金</th><th>C总</th>' + tierHeads + '</tr>' +
      scenarioRows(r) +
      '<tr><td><b>加权期望 E[C总]</b></td><td class="num">100%</td><td colspan="9"></td><td class="num"><b>' + f2(r.EC) + '</b></td>' +
      r.tiers.map(t => '<td class="num"><b>' + signed(t.expectedProfit) + '</b></td>').join('') + '</tr></table>' +
      '<div class="meta">Πs = 零售收入单价 − C总,s；亏损概率、VaR/CVaR 按情景权重计算，不假设正态分布。C_LT=Σ(有效采购电量×采购价) 由批发曲线汇总；日前缺口 E_t=max(Q_t−Q_LT,t,0)，C_DA,s=Σ(E_t×P_DA,s,t)。本口径不含实时价格与日前—实时偏差电费。</div>' +

      pvSection(ctx) +
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
      userClass: ctx.uc || null,
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
          peakValley: (ctx.pv && ctx.pv.active && ctx.pv.perTier[t.key]) || null
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
        K: ctx.pv.K, shares: ctx.pv.shares || null, risks: ctx.pv.risks || null,
        ruleVersion: ctx.pv.ruleVersion, effectiveDate: ctx.pv.effectiveDate,
        sources: ctx.pv.sources,
        szTerminal: ctx.szTerm ? { row: ctx.szTerm.row, note: ctx.szTerm.note, warns: ctx.szTerm.warns } : null
      } : null,
      billLayer: ctx.bill ? { item: ctx.bill.item, annual: ctx.bill.annual } : null,
      cvExplanation
    };
  }

  root.Exporter = { downloadJSON, buildReportHTML, openPrintableReport, buildSnapshot };
})(typeof self !== 'undefined' ? self : this);
