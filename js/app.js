/* 主应用：页面 wiring、状态管理、渲染 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const U = Calc.unit;
  const deepCopy = o => JSON.parse(JSON.stringify(o));
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v, d) { return U.fmt(v, d == null ? 2 : d); }
  function sgn(v, d) { return U.fmtSigned(v, d == null ? 2 : d); }
  function clsSigned(v) { return v > 0 ? 'pos' : (v < 0 ? 'neg' : ''); }
  function clsProfit(v) { return v >= 0 ? 'profit-pos' : 'profit-neg'; }

  const state = {
    params: null, activeVersionId: null,
    validation: null, qRaw: null,
    result: null, calcTime: null, snapshot: null,
    uc: null, ucMatch: null, ucCandId: null, szTerm: null, pv: null
  };

  /* ================= 初始化 ================= */
  function init() {
    bindTabs();
    refreshVersionSelect(BUILTIN_PARAMS.meta.versionId);
    bindInputSection();
    bindExportSection();
    bindParamsSection();
    renderSnapshots();
    const ms = $('selMonth');
    for (let m = 1; m <= 12; m++) ms.insertAdjacentHTML('beforeend', '<option value="' + m + '">' + m + ' 月</option>');
    ms.addEventListener('change', renderTypicalDay);
    // 单日视图的日期下拉（按参数年度生成）
    const ds = $('selDate');
    const d0 = new Date(Date.UTC(BUILTIN_PARAMS.meta.year, 0, 1));
    while (d0.getUTCFullYear() === BUILTIN_PARAMS.meta.year) {
      const iso = d0.toISOString().slice(0, 10);
      ds.insertAdjacentHTML('beforeend', '<option value="' + iso + '">' + iso + '</option>');
      d0.setUTCDate(d0.getUTCDate() + 1);
    }
    ds.value = BUILTIN_PARAMS.meta.year + '-07-15';
    ds.addEventListener('change', renderTypicalDay);
    document.querySelectorAll('input[name=dayView]').forEach(r => r.addEventListener('change', () => {
      const isDate = (document.querySelector('input[name=dayView]:checked') || {}).value === 'date';
      $('selMonth').classList.toggle('hidden', isDate);
      $('selDate').classList.toggle('hidden', !isDate);
      renderTypicalDay();
    }));
  }

  function bindTabs() {
    $('tabs').addEventListener('click', e => {
      const b = e.target.closest('.tab');
      if (!b || b.disabled) return;
      switchTab(b.dataset.tab);
    });
  }
  const PAGE_META = {
    input: ['报价输入与校验', '导入或粘贴客户 8760 曲线 · 校验通过后方可测算'],
    quote: ['三档报价', '完成测算后展示保守价 / 目标价 / 冲单价（主推）'],
    analysis: ['加权分析', '情景成本、权重、分位数与利润全览'],
    curves: ['曲线解释', '客户曲线与统调基准对比 · 曲线价值来源拆解'],
    export: ['导出与留痕', '报价快照 JSON · 打印版报价说明 · 历史记录'],
    params: ['参数管理', '价格情景、结算口径、风控红线 · 全部版本化留痕']
  };
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    const meta = PAGE_META[name] || ['', ''];
    $('pageTitle').textContent = meta[0];
    $('pageCrumb').textContent = (name === 'quote' && state.quoteCrumb) ? state.quoteCrumb : meta[1];
  }
  function enableResultTabs() {
    ['quote', 'analysis', 'curves', 'export'].forEach(n => {
      const t = document.querySelector('.tab[data-tab="' + n + '"]');
      if (t) t.disabled = false;
    });
  }

  /* ================= 参数版本 ================= */
  function versions() { return Store.listVersions(BUILTIN_PARAMS); }

  function refreshVersionSelect(selectId) {
    const sel = $('selVersion');
    sel.innerHTML = '';
    versions().forEach(v => {
      const tag = v.meta.versionId === BUILTIN_PARAMS.meta.versionId ? '（内置）' : '';
      sel.insertAdjacentHTML('beforeend',
        '<option value="' + esc(v.meta.versionId) + '">' + esc(v.meta.versionName) + tag + '｜' + esc(v.meta.versionId) + '</option>');
    });
    sel.value = selectId || versions()[0].meta.versionId;
    loadVersion(sel.value);
    sel.onchange = () => { loadVersion(sel.value); invalidateResult(); };
  }

  function loadVersion(versionId) {
    const v = versions().find(x => x.meta.versionId === versionId) || versions()[0];
    state.params = deepCopy(v);
    state.activeVersionId = v.meta.versionId;
    $('activeVersionBadge').textContent = '参数版本 ' + v.meta.versionId;
    $('activeVersionBadge').title = v.meta.versionName + '（生效 ' + (v.meta.effectiveDate || '—') + '）';
    const wSumV = v.scenarios.reduce((a, s) => a + Number(s.weight || 0), 0);
    $('sbVersion').innerHTML = '<b>' + esc(v.meta.versionId) + (v.meta.versionId === BUILTIN_PARAMS.meta.versionId ? '（内置）' : '') + '</b><br>' +
      esc(v.meta.versionName) + ' · 生效 ' + esc(v.meta.effectiveDate || '—') + '<br>' +
      v.scenarios.length + ' 情景（权重 ' + (wSumV * 100).toFixed(0) + '%）· 三部制成本 · 峰谷规则';
    $('versionMetaHint').textContent = v.meta.versionId + '｜创建 ' + (v.meta.createdAt || '—');
    // V1.1：旧版本无峰谷配置时按内置默认补齐
    if (!state.params.peakValley && BUILTIN_PARAMS.peakValley) {
      state.params.peakValley = deepCopy(BUILTIN_PARAMS.peakValley);
    }
    // V1.2/1.3 兼容：旧版本补齐三部制成本模型配置与情景字段
    if (!state.params.costModel && BUILTIN_PARAMS.costModel) {
      state.params.costModel = deepCopy(BUILTIN_PARAMS.costModel);
    }
    if (!state.params.billLayer || Array.isArray(state.params.billLayer) ||
        state.params.billLayer.mode !== 'monthly_allocation') {
      state.params.billLayer = deepCopy(BUILTIN_PARAMS.billLayer);   // 旧版 7 项结构 → 预测度电分摊单项
    }
    state.params.scenarios.forEach(s => {
      if (s.allocShare == null) s.allocShare = 0;
      if (s.refundShare == null) s.refundShare = 0;
      delete s.rtFactor; delete s.loadError;   // V1.4 起弃用实时层参数
    });
    state.params.tiers = state.params.tiers.map((t, i) => {
      if (t.M == null) {
        const bt = BUILTIN_PARAMS.tiers[i] || {};
        return { key: t.key, name: t.name, q: t.q, M: t.bufferQ != null ? t.bufferQ : (bt.M != null ? bt.M : 10), recommended: t.recommended, note: bt.note || '' };
      }
      return t;
    });
    // V1.4 兼容：批发曲线数组
    if (!Array.isArray(state.params.wholesaleCurves)) state.params.wholesaleCurves = [];
    renderRDerived();
    renderRDerived();
    renderWcOverview();
    renderUcMatch();
    renderParamEditor();
    renderVersionsTable();
  }

  /* ================= 用户分类与峰谷匹配（V1.1） ================= */
  function readUserClass() {
    return {
      area: $('ucArea').value,
      pvPolicy: $('ucPv').value,
      lowVoltage: $('ucLv').value,
      iceStorage: $('ucIce').value,
      voltage: $('ucVoltage').value,
      metering: $('ucMetering').value,
      category: $('ucCategory').value,
      capacityKva: Number($('ucCapacity').value) || 0,
      contractMode: (document.querySelector('input[name=contractMode]:checked') || { value: 'pv' }).value
    };
  }

  function renderUcMatch() {
    const uc = readUserClass();
    state.uc = uc;
    const pvCfg = state.params.peakValley;
    const box = $('ucMatch');
    if (!pvCfg) { box.innerHTML = ''; return; }
    const m = Calc.matchRetailCoeff(uc, pvCfg.retailCoeffs);
    state.ucMatch = m;
    const srcLine = '<span class="src">规则：' + esc(pvCfg.ruleVersion) + '（' + esc(pvCfg.effectiveDate) + ' 起，暂定可动态调整）</span>';
    let html = '';
    if (m.status === 'ok') {
      html = '<div class="match-card match-ok">匹配零售结算系数：<b>' + esc(m.row.name) + '</b>' +
        '（峰 ' + m.row.f1 + ' / 平 1.00 / 谷 ' + m.row.f2 + '）' +
        '<span class="src">适用：' + esc(m.row.scope) + '</span>' + srcLine + '</div>';
    } else if (m.status === 'na') {
      html = '<div class="match-card match-na">不进入峰谷平衡机制：' + esc(m.reason) + '。报价按单一固定价输出。</div>';
    } else if (m.status === 'pending') {
      html = '<div class="match-card match-pending">⚠ ' + esc(m.reason) + '</div>';
    } else if (m.status === 'conflict') {
      html = '<div class="match-card match-conflict">⚠ ' + esc(m.reason) +
        '<div style="margin-top:4px">请选择本次测算使用的系数（选择前可测算，但阻止正式报价导出）：</div>' +
        m.candidates.map(c => '<label class="cand"><input type="radio" name="ucCand" value="' + c.id + '"' +
          (state.ucCandId === c.id ? ' checked' : '') + '> ' + esc(c.name) + '（峰 ' + c.f1 + ' / 谷 ' + c.f2 + '）</label>').join('') + '</div>';
    }
    if ((uc.area === 'sz' || uc.area === 'sz_inc') && m.status !== 'na') {
      const t = Calc.szTerminalLookup(uc, pvCfg.szTerminal);
      state.szTerm = t;
      html += '<div class="match-card match-na" style="margin-top:8px">深圳第二层 · 输配/终端峰谷比价（仅展示，不替代零售结算层）：' +
        (t.row ? '<b>' + esc(t.row.category) + ' · ' + esc(t.row.col) + '</b>（峰 ' + t.row.f1 + ' / 谷 ' + t.row.f2 + '）' : '<b>无精确匹配</b>') +
        '<br>' + esc(t.note) +
        (t.warns && t.warns.length ? '<br>⚠ ' + t.warns.map(esc).join('；') : '') +
        '<span class="src">' + esc(pvCfg.szTerminal.ruleVersion) + ' · ' + esc(pvCfg.szTerminal.scope) + '</span></div>';
    } else state.szTerm = null;
    box.innerHTML = html;
    box.querySelectorAll('input[name=ucCand]').forEach(r => r.addEventListener('change', () => {
      state.ucCandId = r.value;
      invalidateResult();
      updateComputeEnabled();
    }));
  }

  /* ================= A+B 输入与校验 ================= */
  function bindInputSection() {
    $('btnValidate').addEventListener('click', runValidation);
    $('btnCompute').addEventListener('click', runCompute);
    $('btnTemplate').addEventListener('click', downloadTemplate);
    $('btnDemo').addEventListener('click', fillDemoCurve);
    $('fileCurve').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      if (/\.(xlsx|xls)$/i.test(f.name)) {
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const r = XlsxImport.workbookToTSV(rd.result);
            $('txtCurve').value = r.tsv;
            invalidateValidation();
            $('unitGuess').textContent = '已解析工作表「' + r.sheetName + '」：' + r.rowCount + ' 行（' + r.mapping +
              (r.skipped ? '，跳过 ' + r.skipped + ' 行' : '') + '），请点击「校验曲线」';
          } catch (err) { alert('xlsx 解析失败：' + err.message); }
          e.target.value = '';
        };
        rd.readAsArrayBuffer(f);
        return;
      }
      const rd = new FileReader();
      rd.onload = () => { $('txtCurve').value = rd.result; invalidateValidation(); };
      rd.readAsText(f, 'utf-8');
    });
    $('txtCurve').addEventListener('input', invalidateValidation);
    document.querySelectorAll('input[name=unit]').forEach(r => r.addEventListener('change', updateComputeEnabled));
    $('chkUnitConfirm').addEventListener('change', updateComputeEnabled);
    $('inpW').addEventListener('input', updateComputeEnabled);
    // V1.1 用户分类：任何变化实时重匹配并使旧结果失效
    ['ucArea', 'ucPv', 'ucLv', 'ucIce', 'ucVoltage', 'ucMetering', 'ucCategory', 'ucCapacity'].forEach(id =>
      $(id).addEventListener('change', () => { renderUcMatch(); invalidateResult(); }));
    document.querySelectorAll('input[name=contractMode]').forEach(r =>
      r.addEventListener('change', () => { renderUcMatch(); invalidateResult(); }));
  }

  function readInputs() {
    return {
      customerName: $('inpCustomer').value.trim(),
      W: Number($('inpW').value),
      wLt: Number($('inpWLt').value) || 0,
      unit: (document.querySelector('input[name=unit]:checked') || {}).value || null,
      unitConfirmed: $('chkUnitConfirm').checked
    };
  }

  function runValidation() {
    const text = $('txtCurve').value;
    if (!text.trim()) { alert('请先粘贴或导入客户 8760 曲线'); return; }
    const parsed = Validator.parseCurveText(text);
    const v = Validator.validate8760(parsed.rows, state.params.meta.year);
    state.validation = v;
    state.qRaw = v.ok ? v.series.values : null;
    invalidateResult();

    const statusEl = $('validateStatus'), statsEl = $('validateStats'), anomEl = $('validateAnomalies');
    $('validateEmpty').classList.add('hidden');
    $('validateResult').classList.remove('hidden');

    if (v.ok) {
      statusEl.innerHTML = '<div class="status-ok">✓ 校验通过：' + v.stats.count + ' 点完整、唯一、非负（' +
        state.params.meta.year + ' 年 8760 点）</div>';
      const guess = Validator.guessUnit(v.stats.avg);
      $('unitGuess').textContent = guess ? '（按幅值猜测约为 ' + guess + '，请人工确认）' : '';
      if (guess && !document.querySelector('input[name=unit]:checked')) {
        document.querySelector('input[name=unit][value=' + guess + ']').checked = true;
      }
    } else {
      statusEl.innerHTML = '<div class="status-bad">✗ 校验未通过，已阻止报价（不会悄悄补数）：<br>· ' +
        v.errors.map(esc).join('<br>· ') + '</div>';
      $('unitGuess').textContent = '';
    }
    (v.warnings || []).forEach(w => {
      statusEl.insertAdjacentHTML('beforeend', '<div class="status-warn">⚠ ' + esc(w) + '</div>');
    });
    if (parsed.skipped.length > 0) {
      statusEl.insertAdjacentHTML('beforeend',
        '<div class="status-warn">⚠ ' + parsed.skipped.length + ' 行因格式问题被跳过（前几条：' +
        parsed.skipped.slice(0, 5).map(s => '第' + s.line + '行 ' + esc(s.reason)).join('；') + '）</div>');
    }

    if (v.ok) {
      statsEl.innerHTML = '<div class="stat-grid">' +
        stat('数据点', v.stats.count.toLocaleString()) +
        stat('全年电量 Q', v.stats.Q.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + '（原始单位）') +
        stat('逐时均值', num(v.stats.avg, 2)) +
        stat('逐时最小', num(v.stats.min, 2)) +
        stat('逐时最大', num(v.stats.max, 2)) +
        '</div>';
      anomEl.innerHTML = '';
    } else {
      statsEl.innerHTML = v.stats.count ? '<div class="stat-grid">' + stat('有效数据点', v.stats.count + ' / 8760') + '</div>' : '';
      anomEl.innerHTML = anomalyList('缺失小时（' + v.missingCount + '）', v.anomalies.missing) +
        anomalyList('重复记录', v.anomalies.duplicates.map(r => r.key + '（第' + r.line + '行）')) +
        anomalyList('负值记录', v.anomalies.negatives.map(r => r.key + ' = ' + r.value)) +
        anomalyList('年度外日期', v.anomalies.outOfYear.map(r => r.key)) +
        anomalyList('无法识别时刻', v.anomalies.badHours.map(r => '第' + r.line + '行：' + r.hour));
    }
    updateComputeEnabled();
  }
  const stat = (k, v) => '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  function anomalyList(title, arr) {
    if (!arr || !arr.length) return '';
    return '<details class="anomaly"><summary>' + esc(title) + '（显示前 ' + Math.min(arr.length, Validator.MAX_LIST) + ' 条）</summary><ul>' +
      arr.map(a => '<li>' + esc(a) + '</li>').join('') + '</ul></details>';
  }

  function invalidateValidation() {
    state.validation = null; state.qRaw = null;
    invalidateResult();
    updateComputeEnabled();
  }
  function invalidateResult() {
    state.result = null; state.snapshot = null;
    ['quote', 'analysis', 'curves', 'export'].forEach(n => {
      const t = document.querySelector('.tab[data-tab="' + n + '"]');
      if (t) t.disabled = true;
    });
    $('quoteEmpty').classList.remove('hidden'); $('quoteResult').classList.add('hidden');
    $('analysisEmpty').classList.remove('hidden'); $('analysisResult').classList.add('hidden');
    $('curvesEmpty').classList.remove('hidden'); $('curvesResult').classList.add('hidden');
    $('exportEmpty').classList.remove('hidden'); $('exportActions').classList.add('hidden');
  }
  function updateComputeEnabled() {
    const inp = readInputs();
    const ready = !!(state.validation && state.validation.ok && inp.unit && inp.unitConfirmed && inp.W > 0);
    $('btnCompute').disabled = !ready;
  }

  /* ================= 测算 ================= */
  function runCompute() {
    const inp = readInputs();
    if (!state.qRaw) return;
    if (!(inp.W > 0)) { alert('年度批发均价 W 必须大于 0'); return; }
    const wLt = inp.wLt > 0 ? inp.wLt : inp.W;
    const qMWh = inp.unit === 'kWh' ? state.qRaw.map(v => v / 1000) : state.qRaw.slice();
    state.qMWh = qMWh;   // 供到户账单年度化与曲线解释使用

    // V1.1 先行：匹配峰谷系数与时段聚合，确定 K
    const pvPre = matchPeakValley(inp, qMWh);

    let result;
    try {
      result = Calc.computeQuote({
        q: qMWh, keys: state.validation.series.keys, W: inp.W, wLt,
        K: pvPre.K,
        params: state.params
      });
    } catch (e) { alert('测算被阻止：' + e.message); return; }

    state.result = result;
    state.calcTime = Store.now();
    state.inputsUsed = { ...inp, wLt };
    const pcv = result.procurement;
    state.quoteCrumb = (inp.customerName || '未命名客户') + ' · W=' + num(inp.W) + ' / W_LT=' + num(wLt) + ' 元/MWh · 覆盖率=' +
      (pcv.coverage * 100).toFixed(0) + '%' + (pcv.isDefault ? '（默认假设）' : '') + ' · Q=' +
      result.Q.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' MWh · ' + state.calcTime + ' 测算';

    // V1.1 峰谷风险单列（用系数与时段聚合）
    const pvCfg = state.params.peakValley;
    const risks = pvPre.active
      ? Calc.peakValleyRisks({ W: inp.W, shares: pvPre.shares, f1: pvPre.coeffRow.f1, f2: pvPre.coeffRow.f2, sharpCfg: pvCfg.sharp, riskDefaults: pvCfg.riskDefaults })
      : null;
    // 正式报价闸门（V1.1 重叠/待核验 + V1.2/1.3 审批与规则有效期）
    const cm = state.params.costModel || {};
    const th = cm.riskThresholds || {};
    const expired = !!(cm.validUntil && new Date(cm.validUntil + 'T23:59:59') < new Date());
    const gateReasons = [];
    if (pvPre.exportBlocked) gateReasons.push(pvPre.blockReason || pvPre.reason);
    if (expired) gateReasons.push('规则版本已失效（有效期至 ' + cm.validUntil + '），需管理员更新确认');
    if (cm.reserveApproval && !cm.reserveApproval.ok) gateReasons.push('固定价结构风险准备金未审批');
    if (th.approval && !th.approval.ok) gateReasons.push('VaR/CVaR 风险门槛未审批');

    state.pv = {
      ...pvPre, risks,
      perTier: buildTierPv(result.tiers, pvPre),
      gateReasons, expired,
      exportBlocked: pvPre.exportBlocked,
      formalBlocked: gateReasons.length > 0,
      blockReason: gateReasons.join('；'),
      ruleVersion: pvCfg ? pvCfg.ruleVersion : '', effectiveDate: pvCfg ? pvCfg.effectiveDate : '',
      sources: pvCfg ? pvCfg.sources : []
    };

    const ctx = reportContext();
    state.snapshot = Exporter.buildSnapshot(ctx);
    Store.saveSnapshot(state.snapshot);
    renderSnapshots();

    renderRDerived();
    renderWcOverview();
    enableResultTabs();
    renderQuote(ctx);
    renderAnalysis(ctx);
    renderCurves(ctx);
    $('exportEmpty').classList.add('hidden');
    $('exportActions').classList.remove('hidden');
    $('btnExportReport').disabled = state.pv.formalBlocked;
    $('btnExportReport').title = state.pv.formalBlocked ? '正式报价闸门未通过：' + state.pv.blockReason : '';
    switchTab('quote');
  }

  /** V1.1：系数匹配 + 时段聚合 + K（不含风险单列） */
  function matchPeakValley(inp, qMWh) {
    const pvCfg = state.params.peakValley;
    if (!pvCfg) return { active: false, status: 'na', reason: '参数版本无峰谷配置', K: 1, shares: null };
    const uc = state.uc || readUserClass();
    const m = Calc.matchRetailCoeff(uc, pvCfg.retailCoeffs);
    let row = m.row || null;
    if (m.status === 'conflict' && state.ucCandId) {
      row = (m.candidates || []).find(c => c.id === state.ucCandId) || null;
    }
    const table = (uc.area === 'sz' || uc.area === 'sz_inc') ? pvCfg.hourTable.sz : pvCfg.hourTable.gd;
    const shares = Calc.tofuAggregate(qMWh, state.validation.series.keys, table, pvCfg.sharp);
    const coeffActive = !!row && (m.status === 'ok' || m.status === 'conflict');
    const K = coeffActive ? (row.f1 * shares.ap + shares.af + row.f2 * shares.av) : 1;
    const exportBlocked = (m.status === 'conflict' && !state.ucCandId) || m.status === 'pending';
    return {
      active: coeffActive, status: m.status, reason: m.reason || '',
      coeffRow: row, candidates: m.candidates || null, chosenByUser: m.status === 'conflict' && !!state.ucCandId,
      shares, K, table, uc,
      exportBlocked,
      blockReason: m.status === 'pending' ? m.reason : (m.status === 'conflict' ? '重叠组合未人工确认系数' : '')
    };
  }

  /** 每档峰平谷价（P平已由 computeQuote 按 K 计算） */
  function buildTierPv(tiers, pvPre) {
    const out = {};
    tiers.forEach(t => {
      out[t.key] = pvPre.active
        ? { K: pvPre.K, Pping: t.Pping, Pfeng: pvPre.coeffRow.f1 * t.Pping, Pgu: pvPre.coeffRow.f2 * t.Pping, equiv: t.price }
        : { K: 1, Pping: t.price, Pfeng: null, Pgu: null, equiv: t.price };
    });
    return out;
  }

  function reportContext() {
    const blItem = state.params.billLayer && state.params.billLayer.item;
    const billAnn = blItem ? Calc.annualizeMonthly(blItem.monthly, state.qMWh, state.validation.series.keys) : null;
    return {
      result: state.result,
      inputs: { ...state.inputsUsed, W: state.inputsUsed.W },
      paramMeta: state.params.meta,
      params: state.params,
      redLines: state.params.redLines,
      calcTime: state.calcTime,
      validation: { count: state.validation.stats.count },
      cvExplanation: buildCVExplanation(),
      uc: state.uc, pv: state.pv, szTerm: state.szTerm,
      bill: blItem && billAnn ? { item: blItem, annual: billAnn.annual, Qm: billAnn.Qm } : null
    };
  }

  /* ================= C 三档报价卡 ================= */
  function renderQuote(ctx) {
    $('quoteEmpty').classList.add('hidden');
    $('quoteResult').classList.remove('hidden');
    const r = state.result;

    const allWarn = [];
    r.tiers.forEach(t => t.warnings.forEach(w => allWarn.push(t.name + '：' + w)));
    $('redlineBanner').innerHTML = allWarn.length
      ? '<div class="redline-banner">⚠ 风控红线预警（阈值见参数管理，可配置）：<br>· ' + allWarn.map(esc).join('<br>· ') + '</div>'
      : '';

    const wrap = $('tierCards');
    wrap.innerHTML = '';
    const pv = state.pv;
    r.tiers.forEach(t => {
      const card = document.createElement('div');
      card.className = 'tier-card' + (t.recommended && t.gates.all ? ' recommended' : '');
      const recBadge = t.recommended
        ? (t.gates.all ? '<span class="rec-tag">★ 推荐</span>' : '<span class="rec-tag rec-pending">需审批冲单价</span>')
        : '';
      const kpiHtml =
        '<div class="tier-kpis">' +
        '<span class="pill ' + (t.expectedProfit >= 0 ? 'green' : 'red') + '">预期利润 ' + sgn(t.expectedProfit) + '</span>' +
        '<span class="pill ' + (t.gates.lossProb ? 'gray' : 'red') + '">亏损概率 ' + (t.lossProb * 100).toFixed(1) + '%</span>' +
        '<span class="pill ' + (t.gates.cvar ? 'gray' : 'red') + '">CVaR' + Math.round(t.varAlpha * 100) + ' ' + num(t.CVaR) + '</span>' +
        (t.warnings.length ? '<span class="pill red">⚠ 红线预警</span>' : '') +
        (t.recommended && !t.gates.all ? '<span class="pill red">未过门槛</span>' : '') +
        '</div>';
      let priceHtml;
      if (pv && pv.active) {
        const p = pv.perTier[t.key];
        priceHtml =
          '<div class="tier-price">' + num(p.Pping) + ' <small>元/MWh（平段）</small></div>' +
          '<div class="tier-pvg"><span>峰 <b>' + num(p.Pfeng) + '</b></span><span>平 <b>' + num(p.Pping) + '</b></span><span>谷 <b>' + num(p.Pgu) + '</b></span></div>' +
          '<div class="equiv">等效平均价 ' + num(t.price) + '（' + num(U.toYuanPerKwh(t.price), 4) + ' 元/度 · ' + num(U.toFenPerKwh(t.price), 2) + ' 分/度）</div>' +
          '<div class="tier-k">K=' + num(p.K, 4) + '（f1=' + pv.coeffRow.f1 + ' / f2=' + pv.coeffRow.f2 + '）· α峰 ' + (pv.shares.ap * 100).toFixed(1) + '% / α平 ' + (pv.shares.af * 100).toFixed(1) + '% / α谷 ' + (pv.shares.av * 100).toFixed(1) + '%</div>';
      } else {
        priceHtml =
          '<div class="tier-price">' + num(t.price) + ' <small>元/MWh</small></div>' +
          '<div class="tier-units">' + num(U.toYuanPerKwh(t.price), 4) + ' 元/度 · ' + num(U.toFenPerKwh(t.price), 2) + ' 分/度</div>' +
          (pv && pv.reason ? '<div class="tier-k">' + esc(pv.reason) + '</div>' : '');
      }
      card.innerHTML =
        recBadge +
        '<div class="tier-name">' + esc(t.name) + '</div>' +
        priceHtml + kpiHtml +
        '<div class="tier-note">' + esc(t.note || '') + '</div>';
      card.addEventListener('click', () => toggleTierDetail(card, t));
      wrap.appendChild(card);
    });
    // 采购口径提示（V1.4）
    if (r.procurement) {
      const pc = r.procurement;
      if (pc.isDefault) {
        $('redlineBanner').insertAdjacentHTML('beforeend',
          '<div class="match-card match-pending" style="margin-bottom:14px">⚠ 默认年度基准假设：当前无有效批发曲线，按 r<sub>0</sub>×Q×g<sub>t</sub> 虚拟配置（覆盖率 ' +
          (pc.coverage * 100).toFixed(1) + '%，价格=W_LT）。请在「参数管理 → 批发曲线管理」录入实际采购曲线。</div>');
      } else {
        $('redlineBanner').insertAdjacentHTML('beforeend',
          '<div class="match-card match-na" style="margin-bottom:14px">批发曲线汇总：' + pc.curveCount + ' 条 · 覆盖率 ' +
          (pc.coverage * 100).toFixed(1) + '% · 加权采购均价 ' + num(pc.weightedPrice) + ' 元/MWh · 日前市场缺口 ' +
          pc.gapMwh.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) + ' MWh（仅用于单客户边际报价比较，非真实采购合同匹配）' +
          (pc.overMwh > 0 ? '<br><b style="color:var(--red)">⚠ 超覆盖风险：采购量超过客户预测量 ' + pc.overMwh.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' MWh，请检查曲线</b>' : '') +
          '</div>');
      }
    }
    // 闸门提示
    if (pv && pv.formalBlocked) {
      $('redlineBanner').insertAdjacentHTML('beforeend',
        '<div class="redline-banner">⛔ 正式报价导出已阻止：' + esc(pv.blockReason) + '。当前结果仅供内部测算。</div>');
    }
  }

  function toggleTierDetail(card, t) {
    const wrap = card.parentNode;
    const wasExpanded = card.classList.contains('expanded');
    // 三卡始终并列在上：先清掉旧明细与高亮
    wrap.querySelectorAll('.tier-detail').forEach(d => d.remove());
    wrap.querySelectorAll('.tier-card').forEach(c => c.classList.remove('expanded'));
    if (wasExpanded) return;   // 再次点击已展开的卡：仅收起
    card.classList.add('expanded');
    const r = state.result;
    const det = document.createElement('div');
    det.className = 'tier-detail';
    const pv = state.pv;
    let pvHtml = '';
    if (pv && pv.active) {
      const p = pv.perTier[t.key];
      pvHtml =
        '<div style="margin-top:10px"><b>峰平谷展开（K = f1×α峰 + α平 + f2×α谷）</b>' +
        '<div class="formula">K = ' + pv.coeffRow.f1 + '×' + num(pv.shares.ap, 4) + ' + ' + num(pv.shares.af, 4) + ' + ' + pv.coeffRow.f2 + '×' + num(pv.shares.av, 4) +
        ' = ' + num(p.K, 4) + '　→　P平 = ' + num(t.price) + ' / ' + num(p.K, 4) + ' = <b>' + num(p.Pping) + '</b>；P峰 = ' + num(p.Pfeng) + '；P谷 = ' + num(p.Pgu) + '</div>' +
        '<div>电量：Q峰 ' + num(pv.shares.Qp, 1) + ' / Q平 ' + num(pv.shares.Qf, 1) + ' / Q谷 ' + num(pv.shares.Qv, 1) + ' MWh；' +
        '零售收入 = Q × P平 × K = ' + num(pv.shares.Q * p.Pping * p.K / 10000, 1) + ' 万元 = Q × 等效平均价 ✓</div></div>';
    }
    const gateHtml =
      '<div style="margin-top:10px"><b>风险审批门槛（VaR/CVaR）</b>' +
      '<table class="tbl" style="margin-top:6px"><tr><th>门槛</th><th class="num">结果</th><th class="num">限额</th><th>状态</th></tr>' +
      '<tr><td>预期毛利（元/MWh）</td><td class="num">' + sgn(t.expectedProfit) + '</td><td class="num">≥ ' + (r.thresholds.minGrossMargin != null ? r.thresholds.minGrossMargin : '—') + '</td><td>' + (t.gates.margin ? '✅' : '❌') + '</td></tr>' +
      '<tr><td>亏损概率</td><td class="num">' + (t.lossProb * 100).toFixed(1) + '%</td><td class="num">≤ ' + (r.thresholds.maxLossProbPct != null ? r.thresholds.maxLossProbPct : '—') + '%</td><td>' + (t.gates.lossProb ? '✅' : '❌') + '</td></tr>' +
      '<tr><td>CVaR' + Math.round(t.varAlpha * 100) + '（元/MWh）</td><td class="num">' + num(t.CVaR) + '</td><td class="num">≤ ' + (r.thresholds.maxCvar != null ? r.thresholds.maxCvar : '—') + '</td><td>' + (t.gates.cvar ? '✅' : '❌') + '</td></tr></table>' +
      '<div class="hint">VaR' + Math.round(t.varAlpha * 100) + ' = ' + num(t.VaR) + ' 元/MWh；三门槛全过才可标注「推荐」（冲单价）。</div></div>';
    det.innerHTML =
      '<span class="detail-close" title="收起">×</span>' +
      '<b>' + esc(t.name) + '价格构成（V1.2：P平 = [Quantile(C总,q) + M] / K）</b>' +
      '<div class="formula">等效价 = C' + Math.round(t.q * 100) + ' + M = ' + num(t.Cq) + ' + ' + t.M + ' = <b>' + num(t.price) + '</b> 元/MWh' +
      (pv && pv.active ? '；P平 = ' + num(t.price) + ' / K(' + num(pv.perTier[t.key].K, 4) + ') = <b>' + num(pv.perTier[t.key].Pping) + '</b>' : '') + '</div>' +
      '<div>C' + Math.round(t.q * 100) + '（全成本升序累计情景权重首次达 ' + (t.q * 100) + '%）= ' + num(t.Cq) + ' 元/MWh；' +
      'E[C总]（情景加权预期成本）= ' + num(r.EC) + ' 元/MWh</div>' + pvHtml + gateHtml +
      '<table class="tbl" style="margin-top:8px"><tr><th>情景</th><th>权重</th><th class="num">全成本 C总</th><th class="num">本档利润 Π（收入−C总）</th></tr>' +
      t.perScenarioProfit.map(p =>
        '<tr><td>' + esc(p.name) + '</td><td class="num">' + (p.weight * 100).toFixed(1) + '%</td>' +
        '<td class="num">' + num(r.scenarios.find(s => s.id === p.id).Ctotal) + '</td>' +
        '<td class="num ' + clsProfit(p.profit) + '">' + sgn(p.profit) + '</td></tr>').join('') + '</table>' +
      (t.warnings.length ? '<div class="redline-banner" style="margin-top:8px">⚠ ' + t.warnings.map(esc).join('；') + '</div>' : '');
    det.querySelector('.detail-close').addEventListener('click', e => {
      e.stopPropagation();
      det.remove();
      card.classList.remove('expanded');
    });
    wrap.appendChild(det);   // 明细固定在三张卡片下方
  }

  /* ================= D 加权分析 ================= */
  function renderAnalysis() {
    $('analysisEmpty').classList.add('hidden');
    $('analysisResult').classList.remove('hidden');
    const r = state.result;
    const wAvg = f => r.scenarios.reduce((a, s) => a + s.weight * f(s), 0);

    $('analysisSummary').innerHTML =
      chip('预期全成本 E[C总]', num(r.EC) + ' 元/MWh', 'blue') +
      chip('中长期 / 日前缺口', num(wAvg(s => s.Clt)) + ' / ' + num(wAvg(s => s.Cda)), '') +
      chip('覆盖率（采购均价）', (r.procurement.coverage * 100).toFixed(1) + '%（' + num(r.procurement.weightedPrice) + '）' + (r.procurement.isDefault ? '·默认假设' : ''), '') +
      chip('日前市场缺口', r.procurement.gapMwh.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) + ' MWh', r.procurement.gapMwh > 0 ? 'red' : 'green') +
      chip('结构风险准备金（估算）', num(r.reserve), '') +
      chip('K 因子', state.pv && state.pv.active ? num(state.pv.K, 4) : '1（非峰谷）', '');

    let head = '<tr><th>情景</th><th class="num">权重</th><th class="num">W_da</th><th class="num">标定<br>系数k</th>' +
      '<th class="num">中长期<br>Clt</th><th class="num">日前缺口<br>Cda</th><th class="num">分摊−<br>返还</th>' +
      '<th class="num">SR<br>结算</th><th class="num">O<br>信用服务</th><th class="num">准备金</th><th class="num">C总</th>' +
      r.tiers.map(t => '<th class="num">' + esc(t.name) + '<br>利润</th>').join('') + '</tr>';
    let body = r.scenarios.map(s => {
      const cells = r.tiers.map(t => {
        const p = t.perScenarioProfit.find(x => x.id === s.id);
        return '<td class="num ' + clsProfit(p.profit) + '">' + sgn(p.profit) + '</td>';
      }).join('');
      return '<tr><td>' + esc(s.name) + '</td><td class="num">' + (s.weight * 100).toFixed(2) + '%</td>' +
        '<td class="num">' + num(s.W_da) + '</td><td class="num">' + num(s.calibK, 4) + '</td>' +
        '<td class="num">' + num(s.Clt) + '</td><td class="num">' + num(s.Cda) + '</td>' +
        '<td class="num">' + sgn(s.allocShare - s.refundShare) + '</td>' +
        '<td class="num">' + num(s.Csettle) + '</td><td class="num">' + num(s.Ccredit) + '</td>' +
        '<td class="num">' + num(s.Creserve) + '</td>' +
        '<td class="num"><b>' + num(s.Ctotal) + '</b></td>' + cells + '</tr>';
    }).join('');
    body += '<tr class="ecl"><td><b>加权期望</b></td><td class="num">100%</td><td colspan="2"></td>' +
      '<td class="num"><b>' + num(wAvg(s => s.Clt)) + '</b></td><td class="num"><b>' + num(wAvg(s => s.Cda)) + '</b></td>' +
      '<td class="num"><b>' + sgn(wAvg(s => s.allocShare - s.refundShare)) + '</b></td>' +
      '<td colspan="2"></td><td class="num"><b>' + num(r.reserve) + '</b></td><td class="num"><b>' + num(r.EC) + '</b></td>' +
      r.tiers.map(t => '<td class="num ' + clsProfit(t.expectedProfit) + '"><b>' + sgn(t.expectedProfit) + '</b></td>').join('') + '</tr>';
    $('tblScenarios').innerHTML = head + body;

    $('tblQuantiles').innerHTML =
      '<tr><th>档位</th><th class="num">分位 q</th><th class="num">Cq</th><th class="num">M</th><th class="num">等效价<br>元/MWh</th>' +
      '<th class="num">P平</th><th class="num">P峰</th><th class="num">P谷</th><th class="num">元/度</th><th class="num">分/度</th>' +
      '<th class="num">预期利润</th><th class="num">亏损概率</th><th class="num">CVaR95</th><th>门槛</th></tr>' +
      r.tiers.map(t => {
        const p = state.pv && state.pv.active ? state.pv.perTier[t.key] : null;
        return '<tr><td><b>' + esc(t.name) + '</b>' + (t.recommended ? (t.gates.all ? '（推荐）' : '（需审批）') : '') + '</td>' +
          '<td class="num">' + (t.q * 100).toFixed(0) + '%</td><td class="num">' + num(t.Cq) + '</td><td class="num">' + t.M + '</td>' +
          '<td class="num"><b>' + num(t.price) + '</b></td>' +
          '<td class="num">' + num(p ? p.Pping : t.price) + '</td>' +
          '<td class="num">' + (p && p.Pfeng != null ? num(p.Pfeng) : '—') + '</td>' +
          '<td class="num">' + (p && p.Pgu != null ? num(p.Pgu) : '—') + '</td>' +
          '<td class="num">' + num(U.toYuanPerKwh(t.price), 4) + '</td>' +
          '<td class="num">' + num(U.toFenPerKwh(t.price), 2) + '</td>' +
          '<td class="num ' + clsProfit(t.expectedProfit) + '">' + sgn(t.expectedProfit) + '</td>' +
          '<td class="num">' + (t.lossProb * 100).toFixed(1) + '%</td>' +
          '<td class="num">' + num(t.CVaR) + '</td>' +
          '<td>' + (t.gates.all ? '✅' : '❌ ' + ['margin', 'lossProb', 'cvar'].filter(k => !t.gates[k]).join('/')) + '</td></tr>';
      }).join('');

    renderPvRisk();
    renderBill();
  }

  /** 预计到户账单（预测度电分摊，单列，非电能量收入） */
  function renderBill() {
    const card = $('billCard'), body = $('billBody');
    const bl = state.params.billLayer;
    if (!bl || !bl.item || !state.qMWh) { card.style.display = 'none'; return; }
    card.style.display = '';
    const it = bl.item;
    const { annual, Qm } = Calc.annualizeMonthly(it.monthly, state.qMWh, state.validation.series.keys);
    const bearerTxt = it.bearer === 'pass' ? '客户承担（代收/转嫁）' : '售电公司承担（不入到户价）';
    const billAdd = it.bearer === 'pass' ? annual : 0;
    body.innerHTML =
      '<div class="risk-grid">' +
      '<div class="risk-item"><div class="k">' + esc(it.name) + '（年度化）</div><div class="v">' + num(annual) + ' 元/MWh<small>Σ(月值×该月电量)/全年电量 · ' + bearerTxt + '</small></div></div>' +
      '</div>' +
      '<div class="table-wrap"><table class="tbl"><tr><th>月份</th>' +
      Array.from({ length: 12 }, (_, m) => '<th class="num">' + (m + 1) + '月</th>').join('') + '</tr>' +
      '<tr><td>分摊值（元/MWh）</td>' + it.monthly.map(v => '<td class="num">' + num(v) + '</td>').join('') + '</tr>' +
      '<tr><td>客户该月电量（MWh）</td>' + Array.from(Qm, v => '<td class="num">' + num(v, 0) + '</td>').join('') + '</tr></table></div>' +
      '<div class="risk-note" style="margin-top:10px;border-left-color:var(--blue)">预计到户参考价 = 电能量等效价 + 年度化分摊（' + num(billAdd) + '）：<b>' +
      state.result.tiers.map(t => esc(t.name) + ' ' + num(t.price + billAdd)).join('　｜　') +
      '</b> 元/MWh。<br>到户项目是否由售电公司代收、转嫁或承担，须由合同模板开关决定；不计入电能量收入，也不计入三档价成本。</div>';
  }

  /** V1.1 峰谷平衡风险单列（不计入三档价） */
  function renderPvRisk() {
    const card = $('pvRiskCard'), body = $('pvRiskBody');
    const pv = state.pv;
    if (!pv) { card.style.display = 'none'; return; }
    card.style.display = '';
    if (!pv.active) {
      body.innerHTML = '<div class="match-card match-na">不适用：' + esc(pv.reason || '未进入峰谷平衡机制') + '</div>';
      return;
    }
    const rk = pv.risks;
    const w = v => (v / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 万元';
    const item = (k, v, sub) => '<div class="risk-item"><div class="k">' + k + '</div><div class="v">' + v + '<small>' + sub + '</small></div></div>';
    body.innerHTML =
      '<div class="risk-grid">' +
      item('峰谷平衡原始暴露', w(rk.exposureTotal), sgn(rk.exposurePerMwh) + ' 元/MWh · C=W×[(f1−1)Q峰−(1−f2)Q谷]') +
      item('尖峰电能量加价（估算）', w(rk.sharpEnergy), 'W×f1×0.25×Q尖 · Q尖=' + num(rk.Qsharp, 1) + ' MWh') +
      item('尖峰输配加价（估算）', w(rk.sharpTnd), '峰段输配电价×0.25×Q尖 · 单价后台配置') +
      item('峰谷相关系统运行费', w(rk.sysOpFee), '配置单价 × Q（元/MWh，默认 0）') +
      item('市场化分摊（峰谷相关）', w(rk.marketShare), '配置单价 × Q（元/MWh，默认 0）') +
      '</div>' +
      '<div class="risk-note">原始暴露 <b>不等于</b> 最终客户分摊额：峰谷平衡损益最终按月度、按规则在市场购电用户间分摊或分享。' +
      '以上项目<b>未计入</b>三档价（避免与曲线价值/结算参数重复计价）；如需计入，请通过情景 SR_s 或结算调整参数配置。' +
      '<br>匹配系数：' + esc(pv.coeffRow.name) + '（f1=' + pv.coeffRow.f1 + ' / f2=' + pv.coeffRow.f2 + '）· ' +
      esc(pv.ruleVersion) + '（' + esc(pv.effectiveDate) + ' 起）' +
      (pv.chosenByUser ? ' · 重叠组合，人工选定' : '') + '</div>' +
      (state.szTerm && state.szTerm.row
        ? '<div class="risk-note" style="margin-top:10px;border-left-color:var(--blue)">深圳第二层（输配/终端比价，仅展示）：' +
          esc(state.szTerm.row.category) + ' · ' + esc(state.szTerm.row.col) + '（峰 ' + state.szTerm.row.f1 + ' / 谷 ' + state.szTerm.row.f2 + '）· ' +
          esc(state.szTerm.note) + '</div>'
        : '');
  }
  const chip = (k, v, cls) => '<div class="schip ' + (cls || '') + '">' + k + '<b>' + v + '</b></div>';

  /* ================= E 曲线解释 ================= */
  function curveKeys() { return state.validation.series.keys; }

  function buildCVExplanation() {
    const r = state.result;
    if (!r) return '';
    const wAvg = f => r.scenarios.reduce((a, s) => a + s.weight * f(s), 0);
    const cvd = wAvg(s => s.CVda);
    const pc = r.procurement;
    const dir = cvd > 0
      ? '客户的<b>未锁定电量（日前缺口）</b>更多落在高价日前时段：<b>日前曲线暴露为正（' + sgn(cvd) + ' 元/MWh），推高成本</b>。'
      : (cvd < 0
        ? '客户的<b>未锁定电量</b>更多落在低价日前时段：<b>日前曲线暴露为负（' + sgn(cvd) + ' 元/MWh），构成曲线优势</b>。'
        : '客户未锁定电量时段分布与统调基准基本一致：日前曲线暴露约为 0。');
    return dir + '<br>中长期覆盖率 ' + (pc.coverage * 100).toFixed(1) + '%（' +
      (pc.isDefault ? '默认年度基准假设 r0×Q×g<sub>t</sub>' : pc.curveCount + ' 条批发曲线汇总') +
      '），加权采购均价 ' + num(pc.weightedPrice) + ' 元/MWh；日前市场缺口 ' +
      pc.gapMwh.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) + ' MWh 暴露于日前价格情景。' +
      '曲线暴露仅作解释，不与 C_DA 重复计入成本。';
  }

  function dailySums(values) {
    const map = new Map();
    curveKeys().forEach((k, i) => {
      const d = k.slice(0, 10);
      map.set(d, (map.get(d) || 0) + values[i]);
    });
    return Array.from(map.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1);
  }

  function weightedContribs() {
    const r = state.result;
    const gap = r.procurement.gap;
    const E0 = r.procurement.gapMwh;
    const out = new Array(gap.length).fill(0);
    r.scenarios.forEach(s => {
      const p = state.params.scenarios.find(x => x.id === s.id).curve;
      for (let t = 0; t < gap.length; t++) {
        out[t] += s.weight * (gap[t] - E0 * r.gNorm[t]) * (p[t] * s.calibK) / r.Q;
      }
    });
    return out;
  }

  function renderCurves() {
    $('curvesEmpty').classList.add('hidden');
    $('curvesResult').classList.remove('hidden');
    const r = state.result;
    state.qMWh = state.inputsUsed.unit === 'kWh' ? state.qRaw.map(v => v / 1000) : state.qRaw.slice();

    const expl = $('cvExplanation');
    expl.innerHTML = buildCVExplanation();
    const wAvgCV = r.scenarios.reduce((a, s) => a + s.weight * s.CVda, 0);
    expl.classList.toggle('warn', wAvgCV > 0);

    // 全年逐日对比
    const qd = dailySums(state.qMWh), bd = dailySums(r.baseline);
    const xLabels = [];
    let lastM = '';
    qd.forEach((d, i) => { const m = d[0].slice(5, 7); if (m !== lastM) { xLabels.push({ i, text: +m + '月' }); lastM = m; } });
    const pd = dailySums(r.procurement.purchase);
    Charts.lineChart($('chartDaily'), [
      { name: '客户逐日电量 (MWh)', values: qd.map(x => x[1]), color: '#3f9bff' },
      { name: '统调基准 (MWh)', values: bd.map(x => x[1]), color: '#ff9f0a' },
      { name: '批发采购 (MWh)' + (r.procurement.isDefault ? '·默认假设' : ''), values: pd.map(x => x[1]), color: '#30d158' }
    ], { xLabels, xValue: i => qd[i][0], unit: 'MWh/日', yLabel: 'MWh/日', diffDigits: 2, toggleable: true });

    renderTypicalDay();

    // 月度曲线价值贡献
    const contrib = weightedContribs();
    const monthly = new Array(12).fill(0);
    curveKeys().forEach((k, i) => { monthly[+k.slice(5, 7) - 1] += contrib[i]; });
    Charts.barChart($('chartMonthlyCV'),
      monthly.map((v, i) => ({ label: (i + 1) + '月', value: v })), { yLabel: '元/MWh', yDigits: 3, unit: '元/MWh' });

    // Top10 时段
    const idx = contrib.map((v, i) => [Math.abs(v), i]).sort((a, b) => b[0] - a[0]).slice(0, 10).map(x => x[1]);
    idx.sort((a, b) => contrib[b] - contrib[a]);
    $('tblTopHours').innerHTML =
      '<tr><th>日期</th><th>时刻</th><th class="num">客户电量<br>MWh</th><th class="num">基准电量<br>MWh</th>' +
      '<th class="num">加权标定电价<br>元/MWh</th><th class="num">曲线价值贡献<br>元/MWh</th></tr>' +
      idx.map(i => {
        const k = curveKeys()[i];
        const pw = state.result.scenarios.reduce((a, s) =>
          a + s.weight * state.params.scenarios.find(x => x.id === s.id).curve[i] * s.calibK, 0);
        return '<tr><td>' + k.slice(0, 10) + '</td><td>' + k.slice(11) + ' 时</td>' +
          '<td class="num">' + num(state.qMWh[i], 3) + '</td><td class="num">' + num(r.baseline[i], 3) + '</td>' +
          '<td class="num">' + num(pw, 1) + '</td>' +
          '<td class="num ' + clsSigned(contrib[i]) + '">' + sgn(contrib[i], 5) + '</td></tr>';
      }).join('');
  }

  function renderTypicalDay() {
    if (!state.result) return;
    const r = state.result;
    const pur = r.procurement.purchase;
    const view = (document.querySelector('input[name=dayView]:checked') || {}).value || 'month';
    const xl = [0, 3, 6, 9, 12, 15, 18, 21, 23].map(h => ({ i: h, text: h + '时' }));
    if (view === 'date') {
      const d = $('selDate').value;
      const qc = new Array(24).fill(NaN), bc = new Array(24).fill(NaN), pc2 = new Array(24).fill(NaN);
      curveKeys().forEach((k, i) => {
        if (k.slice(0, 10) !== d) return;
        const h = +k.slice(11, 13);
        qc[h] = state.qMWh[i]; bc[h] = r.baseline[i]; pc2[h] = pur[i];
      });
      Charts.lineChart($('chartTypical'), [
        { name: '客户 (MWh)', values: qc, color: '#3f9bff' },
        { name: '统调基准 (MWh)', values: bc, color: '#ff9f0a' },
        { name: '批发采购 (MWh)' + (r.procurement.isDefault ? '·默认假设' : ''), values: pc2, color: '#30d158' }
      ], { xLabels: xl, xValue: i => d + ' ' + i + ' 时', unit: 'MWh', yLabel: 'MWh', diffDigits: 3, toggleable: true });
      return;
    }
    const m = +$('selMonth').value;
    const qc = new Array(24).fill(0), bc = new Array(24).fill(0), pc2 = new Array(24).fill(0), cnt = new Array(24).fill(0);
    curveKeys().forEach((k, i) => {
      if (+k.slice(5, 7) !== m) return;
      const h = +k.slice(11, 13);
      qc[h] += state.qMWh[i]; bc[h] += r.baseline[i]; pc2[h] += pur[i]; cnt[h]++;
    });
    Charts.lineChart($('chartTypical'), [
      { name: '客户逐时均值 (MWh)', values: qc.map((v, h) => v / (cnt[h] || 1)), color: '#3f9bff' },
      { name: '统调基准逐时均值 (MWh)', values: bc.map((v, h) => v / (cnt[h] || 1)), color: '#ff9f0a' },
      { name: '批发采购逐时均值 (MWh)' + (r.procurement.isDefault ? '·默认假设' : ''), values: pc2.map((v, h) => v / (cnt[h] || 1)), color: '#30d158' }
    ], { xLabels: xl, xValue: i => m + '月 ' + i + ' 时（月均）', unit: 'MWh', yLabel: 'MWh', diffDigits: 3, toggleable: true });
  }

  /* ================= F 导出与留痕 ================= */
  function bindExportSection() {
    $('btnExportJSON').addEventListener('click', () => {
      if (!state.snapshot) return;
      const name = (state.inputsUsed.customerName || '未命名客户');
      Exporter.downloadJSON(state.snapshot,
        '报价快照_' + name + '_' + state.calcTime.replace(/[: ]/g, '-') + '.json');
    });
    $('btnExportReport').addEventListener('click', () => {
      if (!state.result) return;
      Exporter.openPrintableReport(Exporter.buildReportHTML(reportContext()));
    });
  }

  function renderSnapshots() {
    const list = Store.listSnapshots();
    const elTbl = $('tblSnapshots');
    if (!list.length) {
      elTbl.innerHTML = '<tr><td class="hint">暂无快照。每次成功测算会自动留痕（最多保留 50 条，仅存本机）。</td></tr>';
      return;
    }
    elTbl.innerHTML = '<tr><th>测算时间</th><th>客户</th><th class="num">W</th><th class="num">Q(MWh)</th>' +
      '<th class="num">保守价</th><th class="num">目标价</th><th class="num">冲单价</th><th>参数版本</th><th>操作</th></tr>' +
      list.map(s => {
        const t = s.intermediates.tiers;
        return '<tr><td>' + esc(s.calcTime) + '</td><td>' + esc(s.inputs.customerName || '（未命名）') + '</td>' +
          '<td class="num">' + num(s.inputs.W) + '</td><td class="num">' + num(s.inputs.Q_MWh, 1) + '</td>' +
          '<td class="num">' + num(t[0].price) + '</td><td class="num">' + num(t[1].price) + '</td><td class="num"><b>' + num(t[2].price) + '</b></td>' +
          '<td>' + esc(s.paramVersion.versionId) + '</td>' +
          '<td class="inline">' +
          '<button class="btn btn-sm" data-dl="' + s.snapshotId + '">下载</button> ' +
          '<button class="btn btn-sm btn-danger" data-del="' + s.snapshotId + '">删除</button></td></tr>';
      }).join('');
    elTbl.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => {
      const s = Store.listSnapshots().find(x => x.snapshotId === b.dataset.dl);
      if (s) Exporter.downloadJSON(s, '报价快照_' + (s.inputs.customerName || '未命名客户') + '_' + s.snapshotId + '.json');
    }));
    elTbl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      if (confirm('删除该快照？')) { Store.deleteSnapshot(b.dataset.del); renderSnapshots(); }
    }));
  }

  /* ================= 参数管理 ================= */
  function bindParamsSection() {
    $('btnGotoParams').addEventListener('click', () => switchTab('params'));
    $('btnOpenWc').addEventListener('click', openWholesaleDrawer);
    $('btnExportParams').addEventListener('click', () => {
      if (!confirm('导出当前参数为 JSON（含批发曲线等全部配置）？该文件可用于替换内置默认数据。')) return;
      Exporter.downloadJSON(deepCopy(state.params), 'default-params.json');
    });
  }

  /** V1.4：覆盖率自动汇总展示（输入页只读） */
  function renderRDerived() {
    const el = $('rDerived');
    if (!el || !state.params) return;
    const curves = (state.params.wholesaleCurves || []).filter(c => c.enabled !== false);
    const r0 = (state.params.defaults && state.params.defaults.coverageRatio != null ? state.params.defaults.coverageRatio : 0.9);
    if (!curves.length) {
      el.innerHTML = '无有效批发曲线 → <b>默认年度基准假设 r0=' + (r0 * 100).toFixed(0) + '%</b>（Q×g 统调形状分摊）';
    } else if (state.result && state.result.procurement) {
      el.innerHTML = curves.length + ' 条批发曲线 → 覆盖率 <b>' + (state.result.procurement.coverage * 100).toFixed(1) + '%</b>（加权采购均价 ' +
        Calc.unit.fmt(state.result.procurement.weightedPrice) + ' 元/MWh，日前缺口 ' +
        state.result.procurement.gapMwh.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) + ' MWh）';
    } else {
      el.innerHTML = curves.length + ' 条批发曲线（覆盖率将在测算后显示）';
    }
  }

  /** 参数管理页的批发曲线总览卡 */
  function renderWcOverview() {
    const el = $('wcOverview');
    if (!el || !state.params) return;
    const curves = (state.params.wholesaleCurves || []).filter(c => c.enabled !== false);
    if (state.result && state.result.procurement) {
      const p = state.result.procurement;
      el.innerHTML =
        '<div class="schip">已配置 <b>' + curves.length + '</b> 条</div>' +
        '<div class="schip">当前覆盖率 <b>' + (p.coverage * 100).toFixed(1) + '%</b>' + (p.isDefault ? '（默认假设）' : '') + '</div>' +
        '<div class="schip">未覆盖量 <b>' + p.gapMwh.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) + '</b> MWh</div>';
    } else {
      el.innerHTML = '<div class="schip">已配置 <b>' + curves.length + '</b> 条</div><div class="schip hint">测算后显示覆盖率与缺口</div>';
    }
  }

  function openWholesaleDrawer() {
    WholesaleUI.open({
      params: state.params,
      keys: Validator.expectedHourKeys(state.params.meta.year),
      getQ: () => state.qMWh || null,
      getWlt: () => {
        const inp = state.inputsUsed;
        if (inp && inp.wLt > 0) return inp.wLt;
        const w = Number($('inpW').value);
        return w > 0 ? w : 372;
      },
      onChange: () => { invalidateResult(); renderRDerived(); renderWcOverview(); }
    });
  }

  function renderVersionsTable() {
    $('tblVersions').innerHTML =
      '<tr><th>版本ID</th><th>名称</th><th>创建时间</th><th>生效日期</th><th>来源/说明</th><th>操作</th></tr>' +
      versions().map(v => {
        const builtin = v.meta.versionId === BUILTIN_PARAMS.meta.versionId;
        const active = v.meta.versionId === state.activeVersionId;
        return '<tr><td>' + esc(v.meta.versionId) + (active ? ' <b style="color:var(--blue)">[使用中]</b>' : '') + '</td>' +
          '<td>' + esc(v.meta.versionName) + (builtin ? '（内置）' : '') + '</td>' +
          '<td>' + esc(v.meta.createdAt || '—') + '</td><td>' + esc(v.meta.effectiveDate || '—') + '</td>' +
          '<td style="white-space:normal;max-width:340px"><details class="src-fold"><summary>来源与说明</summary><div>' + esc(v.meta.source || v.meta.note || '—') + '</div></details></td>' +
          '<td class="inline">' +
          (active ? '' : '<button class="btn btn-sm" data-use="' + esc(v.meta.versionId) + '">使用</button> ') +
          (builtin ? '' : '<button class="btn btn-sm btn-danger" data-rm="' + esc(v.meta.versionId) + '">删除</button>') +
          '</td></tr>';
      }).join('');
    $('tblVersions').querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => {
      $('selVersion').value = b.dataset.use;
      loadVersion(b.dataset.use);
      invalidateResult();
    }));
    $('tblVersions').querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('删除参数版本 ' + b.dataset.rm + '？历史快照中已引用的版本号保留记录。')) return;
      Store.deleteVersion(b.dataset.rm);
      refreshVersionSelect(state.activeVersionId === b.dataset.rm ? BUILTIN_PARAMS.meta.versionId : state.activeVersionId);
    }));
  }

  function renderParamEditor() {
    const p = state.params;
    const wSum = p.scenarios.reduce((a, s) => a + Number(s.weight || 0), 0);
    const ceModes = p.ceModes || { exposure: 'CE=(1−r)×CV', full: 'CE=CV', none: 'CE=0' };

    let html = '';
    html += '<div class="param-block"><h3>版本信息</h3><div class="param-grid">' +
      fld('版本名称', '<input type="text" id="peVersionName" value="' + esc(p.meta.versionName) + '">') +
      fld('生效日期', '<input type="text" id="peEffDate" value="' + esc(p.meta.effectiveDate || '') + '" placeholder="YYYY-MM-DD">') +
      fld('报价年度', '<input type="text" value="' + p.meta.year + '" disabled>') +
      '</div><details class="src-fold"><summary>来源与说明</summary><div class="hint">' + esc(p.meta.source || '—') + '</div></details></div>';

    html += '<div class="param-block"><h3>默认值与结算口径</h3><div class="param-grid">' +
      fld('中长期覆盖比例默认值 r（%）', '<input type="number" id="peR" min="0" max="100" step="0.1" value="' + ((p.defaults.coverageRatio || 0) * 100) + '">') +
      fld('曲线暴露成本 CE 口径', '<select id="peCeMode">' +
        Object.keys(ceModes).map(k => '<option value="' + k + '"' + (p.defaults.ceMode === k ? ' selected' : '') + '>' + esc(ceModes[k]) + '</option>').join('') + '</select>') +
      '</div></div>';

    const rl = p.redLines || {};
    html += '<div class="param-block"><h3>风控红线（触发仅预警，不拦截报价）</h3><div class="param-grid">' +
      fld('亏损情景权重上限（%）', '<input type="number" id="peRlLoss" step="1" value="' + (rl.maxLossWeightPct != null ? rl.maxLossWeightPct : '') + '">') +
      fld('最差情景利润下限（元/MWh）', '<input type="number" id="peRlWorst" step="0.5" value="' + (rl.minWorstProfit != null ? rl.minWorstProfit : '') + '">') +
      fld('预期利润下限（元/MWh）', '<input type="number" id="peRlExp" step="0.5" value="' + (rl.minExpectedProfit != null ? rl.minExpectedProfit : '') + '">') +
      '</div></div>';

    // ---------- V1.1 峰谷规则 ----------
    if (p.peakValley) {
      const pvc = p.peakValley;
      const hl = a => a.join(',');
      const strip = t => {
        const peak = new Set(t.peak), val = new Set(t.valley);
        const sharpH = new Set(pvc.sharp.hours);
        let s = '<div class="hour-strip">';
        for (let h = 0; h < 24; h++) {
          const cls = sharpH.has(h) ? 'hs' : (val.has(h) ? 'hv' : (peak.has(h) ? 'hp' : 'hf'));
          s += '<span class="' + cls + '" title="' + h + '时">' + h + '</span>';
        }
        return s + '</div>';
      };
      html += '<div class="param-block"><h3>峰谷规则（V1.1 · ' + esc(pvc.ruleVersion) + '，' + esc(pvc.effectiveDate) + ' 起）</h3>' +
        '<details class="src-fold" style="margin-bottom:10px"><summary>规则说明与官方来源链接</summary><div class="hint">' + esc(pvc.ruleNote || '') + '</div>' +
        (pvc.sources || []).map(s2 => '<div class="hint">· <a href="' + esc(s2.url) + '" target="_blank" style="color:var(--blue-text)">' + esc(s2.name) + '</a></div>').join('') + '</details>' +
        '<table class="tbl"><tr><th>零售结算系数</th><th class="num">峰 f1</th><th class="num">谷 f2</th><th>适用范围</th></tr>' +
        pvc.retailCoeffs.map(c => '<tr><td>' + esc(c.name) + '</td>' +
          '<td class="num"><input type="number" style="width:90px" id="peRCf1_' + c.id + '" step="0.0001" value="' + c.f1 + '"></td>' +
          '<td class="num"><input type="number" style="width:90px" id="peRCf2_' + c.id + '" step="0.0001" value="' + c.f2 + '"></td>' +
          '<td style="white-space:normal">' + esc(c.scope) + '</td></tr>').join('') + '</table>' +
        '<div class="param-grid" style="margin-top:12px">' +
        fld('非深圳峰段小时', '<input type="text" id="peHTgdP" value="' + hl(pvc.hourTable.gd.peak) + '">') +
        fld('非深圳谷段小时', '<input type="text" id="peHTgdV" value="' + hl(pvc.hourTable.gd.valley) + '">') +
        fld('深圳峰段小时', '<input type="text" id="peHTszP" value="' + hl(pvc.hourTable.sz.peak) + '">') +
        fld('深圳谷段小时', '<input type="text" id="peHTszV" value="' + hl(pvc.hourTable.sz.valley) + '">') +
        '</div>' + strip(pvc.hourTable.gd) +
        '<div class="hint">时段条预览（非深圳）：红=峰，灰=平，绿=谷，橙=尖峰。小时用逗号/短横区间，如 10,11,14-18</div>' +
        '<div class="param-grid" style="margin-top:12px">' +
        fld('尖峰月份', '<input type="text" id="peShM" value="' + hl(pvc.sharp.months) + '">') +
        fld('尖峰小时', '<input type="text" id="peShH" value="' + hl(pvc.sharp.hours) + '">') +
        fld('尖峰电能量加价率', '<input type="number" id="peShER" step="0.01" value="' + pvc.sharp.energyPremiumRate + '">') +
        fld('尖峰输配加价率', '<input type="number" id="peShTR" step="0.01" value="' + pvc.sharp.tndPremiumRate + '">') +
        fld('峰段输配电价（元/MWh）', '<input type="number" id="peShTP" step="0.1" value="' + (pvc.sharp.tndPeakPricePerMwh || 0) + '">') +
        fld('峰谷系统运行费（元/MWh）', '<input type="number" id="peRkSys" step="0.01" value="' + (pvc.riskDefaults.sysOpFeePerMwh || 0) + '">') +
        fld('市场化分摊（元/MWh）', '<input type="number" id="peRkMkt" step="0.01" value="' + (pvc.riskDefaults.marketSharePerMwh || 0) + '">') +
        '</div>' +
        '<h3 style="margin-top:14px">深圳第二层 · 输配/终端峰谷比价表（仅展示层，不替代零售结算层）</h3>' +
        '<table class="tbl"><tr><th>用电类别</th><th>电压/计量列</th><th class="num">峰</th><th class="num">谷</th></tr>' +
        pvc.szTerminal.rows.map((r2, i) => '<tr><td>' + esc(r2.category) + '</td><td>' + esc(r2.col) + '</td>' +
          '<td class="num"><input type="number" style="width:90px" id="peSZf1_' + i + '" step="0.0001" value="' + r2.f1 + '"></td>' +
          '<td class="num"><input type="number" style="width:90px" id="peSZf2_' + i + '" step="0.0001" value="' + r2.f2 + '"></td></tr>').join('') + '</table>' +
        '<div class="hint">' + esc(pvc.szTerminal.scope) + '</div></div>';
    }

    html += '<div class="param-block"><h3>三档定价公式（P平 = [Quantile(C总,q) + M] / K）</h3><table class="tbl">' +
      '<tr><th>档位</th><th class="num">分位 q（%）</th><th class="num">M 利润垫（元/MWh）</th><th>推荐</th></tr>' +
      p.tiers.map((t, i) =>
        '<tr><td>' + esc(t.name) + '</td>' +
        '<td class="num"><input type="number" style="width:80px" id="peTq' + i + '" min="1" max="100" step="1" value="' + (t.q * 100) + '"></td>' +
        '<td class="num"><input type="number" style="width:80px" id="peTm' + i + '" step="0.5" value="' + t.M + '"></td>' +
        '<td><input type="radio" name="peRec" value="' + i + '"' + (t.recommended ? ' checked' : '') + '></td></tr>').join('') +
      '</table></div>';

    // ---------- V1.2/1.3 成本模型与公司风险参数 ----------
    if (p.costModel) {
      const cm = p.costModel, th = cm.riskThresholds || {};
      const apprTxt = a => a && a.ok ? '<span style="color:var(--green)">已审批（' + esc(a.by || '') + ' ' + esc(a.at || '') + '）</span>' : '<span style="color:var(--red)">未审批</span>';
      html += '<div class="param-block"><h3>成本模型与公司风险参数（V1.2/1.3）</h3>' +
        '<div class="hint" style="margin-bottom:10px">' + esc(cm.procurementNote || '') + '</div>' +
        '<div class="param-grid">' +
        fld('结构风险准备金（元/MWh，估算）', '<input type="number" id="peReserve" step="0.5" value="' + (cm.reservePerMwh || 0) + '">') +
        fld('准备金审批状态', '<div style="padding:8px 0">' + apprTxt(cm.reserveApproval) + ' <button type="button" class="btn btn-sm" id="peApprReserve">审批</button></div>') +
        fld('VaR 置信度 α', '<input type="number" id="peVarAlpha" min="0.5" max="0.99" step="0.01" value="' + (th.varAlpha || 0.95) + '">') +
        fld('最低毛利（元/MWh）', '<input type="number" id="peMinMargin" step="0.5" value="' + (th.minGrossMargin != null ? th.minGrossMargin : 3) + '">') +
        fld('亏损概率上限（%）', '<input type="number" id="peMaxLossProb" step="1" value="' + (th.maxLossProbPct != null ? th.maxLossProbPct : 35) + '">') +
        fld('CVaR 限额（元/MWh）', '<input type="number" id="peMaxCvar" step="0.5" value="' + (th.maxCvar != null ? th.maxCvar : 8) + '">') +
        fld('门槛审批状态', '<div style="padding:8px 0">' + apprTxt(th.approval) + ' <button type="button" class="btn btn-sm" id="peApprTh">审批</button></div>') +
        fld('规则有效期至（可空）', '<input type="text" id="peValidUntil" value="' + (cm.validUntil || '') + '" placeholder="YYYY-MM-DD">') +
        '</div>' +
        '<div class="hint">保存新版本后，准备金与风险门槛的审批状态将重置为「未审批」，须由授权人员在此重新审批，否则正式报价导出被闸门阻止。</div></div>';
    }

    // ---------- 到户账单层：预测度电分摊（1–12 月逐月预测值） ----------
    if (p.billLayer && p.billLayer.item) {
      const it = p.billLayer.item;
      html += '<div class="param-block"><h3>到户账单层：预测度电分摊（单列，不进电能量收入/成本）</h3>' +
        '<div class="hint" style="margin-bottom:10px">' + esc(p.billLayer.note || '') + '</div>' +
        '<div class="param-grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">' +
        it.monthly.map((v, m) => fld((m + 1) + ' 月（元/MWh）', '<input type="number" id="peBillM' + m + '" step="0.01" value="' + (v || 0) + '">')).join('') +
        fld('承担方', '<select id="peBillBearer"><option value="pass"' + (it.bearer === 'pass' ? ' selected' : '') + '>客户承担（代收/转嫁）</option><option value="absorb"' + (it.bearer === 'absorb' ? ' selected' : '') + '>售电公司承担</option></select>') +
        '</div><div class="hint">年度化口径：Σ(月分摊值 × 客户该月电量) / 全年电量。</div></div>';
    }

    html += '<div class="param-block"><h3>日前价格情景（权重合计须为 100%；V1.4 起仅日前口径，无实时情景）　<span id="peWSum" style="font-weight:700">当前合计：' + (wSum * 100).toFixed(2) + '%</span></h3>';
    p.scenarios.forEach((s, i) => {
      const isDirect = s.priceMode === 'direct';
      const modeTag = isDirect
        ? '<span style="background:rgba(63,155,255,.15);color:#3f9bff;padding:1px 6px;border-radius:3px;font-size:11px;margin-left:6px">直接价格（8760 导入，不标定）</span>'
        : '<span style="background:rgba(255,159,10,.15);color:#ff9f0a;padding:1px 6px;border-radius:3px;font-size:11px;margin-left:6px">比例标定（形状 × W × 因子）</span>';
      html += '<div class="scenario-edit"><div class="head"><b>' + esc(s.name) + '</b>' + modeTag +
        '<span class="hint">曲线 8760 点｜原始统调加权均价 ' + num(weightedAvg(p.baseline.curve, s.curve), 1) + ' 元/MWh' + (isDirect ? '（直接价格，原值入算）' : '（报价时按 W_s 标定，仅取形状）') + '</span></div>' +
        '<div class="param-grid">' +
        fld('情景名称', '<input type="text" id="peSname' + i + '" value="' + esc(s.name) + '">') +
        fld('权重（%）', '<input type="number" class="peWeight" data-i="' + i + '" id="peSw' + i + '" min="0" max="100" step="0.01" value="' + (s.weight * 100).toFixed(2) + '">') +
        fld('价格因子（W_da = W × 因子）' + (isDirect ? '（直接价格下不生效）' : ''), '<input type="number" id="peSf' + i + '" step="0.01" value="' + (s.priceFactor != null ? s.priceFactor : 1) + '"' + (isDirect ? ' disabled' : '') + '>') +
        fld('C分摊（元/MWh）', '<input type="number" id="peSalloc' + i + '" step="0.1" value="' + (s.allocShare || 0) + '">') +
        fld('R返还（元/MWh）', '<input type="number" id="peSref' + i + '" step="0.1" value="' + (s.refundShare || 0) + '">') +
        fld('SR_s 结算调整（元/MWh）', '<input type="number" id="peSsr' + i + '" step="0.1" value="' + (s.sr || 0) + '">') +
        fld('O_s 信用服务（元/MWh）', '<input type="number" id="peSo' + i + '" step="0.1" value="' + (s.o || 0) + '">') +
        '</div>' +
        '<div class="inline gap" style="margin-top:8px">' +
        '<button class="btn btn-sm" data-curve="' + i + '">替换曲线（粘贴 8760 行）</button>' +
        '<button class="btn btn-sm" data-dltpl="' + i + '">下载导入模板</button>' +
        '<label class="btn btn-sm" style="cursor:pointer">导入 xlsx<input type="file" data-impscn="' + i + '" accept=".xlsx,.xls" style="display:none"></label>' +
        (isDirect ? '' : '<button class="btn btn-sm" data-todirect="' + i + '" title="把当前曲线转为直接价格模式（8760 值原样入算，不再按 W 标定）">转为直接价格</button>') +
        (p.scenarios.length > 1 ? '<button class="btn btn-sm btn-danger" data-delscn="' + i + '">删除情景</button>' : '') +
        '</div>' +
        '<div id="curveEditor' + i + '" class="hidden" style="margin-top:8px">' +
        '<textarea rows="5" id="curveText' + i + '" placeholder="粘贴三列：日期、时刻、价格；或单列 8760 个价格（按报价年度时间顺序）"></textarea>' +
        '<div class="inline gap"><button class="btn btn-sm btn-primary" data-applycurve="' + i + '">应用曲线（按当前模式）</button></div></div>' +
        '</div>';
    });
    html += '<div class="inline gap"><button class="btn btn-sm" id="peAddScn">+ 新增情景（粘贴曲线）</button>' +
      '<button class="btn btn-sm" id="peReplaceBase">替换统调比例曲线（粘贴 8760 行，自动归一化）</button></div>' +
      '<div id="baseEditor" class="hidden" style="margin-top:8px"><textarea rows="5" id="baseText" placeholder="粘贴三列：日期、时刻、比例；或单列 8760 个比例值（和为 1 或 100 均可，自动归一化）"></textarea>' +
      '<div class="inline gap"><button class="btn btn-sm btn-primary" id="peApplyBase">应用统调曲线</button></div></div>' +
      '<div id="scnAddEditor" class="hidden" style="margin-top:8px"><textarea rows="5" id="scnAddText" placeholder="新情景曲线：粘贴三列（日期、时刻、价格）或单列 8760 个价格"></textarea>' +
      '<div class="inline gap"><button class="btn btn-sm btn-primary" id="peApplyAddScn">添加</button></div></div>' +
      '</div>';

    html += '<div class="actions"><button class="btn btn-primary" id="peSave">保存为新版本并启用</button>' +
      '<span class="hint">保存后生成新版本号，当前版本与历史版本保留，报价快照将记录新版本号。</span></div>';

    $('paramEditor').innerHTML = html;
    bindParamEditor();
  }

  const fld = (label, control) => '<div><label>' + label + '</label>' + control + '</div>';
  function weightedAvg(g, p) {
    const s = g.reduce((a, x) => a + x, 0);
    return g.reduce((a, x, i) => a + x / s * p[i], 0);
  }

  function bindParamEditor() {
    const p = state.params;
    document.querySelectorAll('.peWeight').forEach(inp => inp.addEventListener('input', () => {
      const sum = Array.from(document.querySelectorAll('.peWeight')).reduce((a, x) => a + Number(x.value || 0), 0);
      const elW = $('peWSum');
      elW.textContent = '当前合计：' + sum.toFixed(2) + '%';
      elW.style.color = Math.abs(sum - 100) < 1e-6 ? 'var(--green)' : 'var(--red)';
    }));
    document.querySelectorAll('[data-curve]').forEach(b => b.addEventListener('click', () => $('curveEditor' + b.dataset.curve).classList.toggle('hidden')));
    $('peReplaceBase').addEventListener('click', () => $('baseEditor').classList.toggle('hidden'));
    $('peAddScn').addEventListener('click', () => $('scnAddEditor').classList.toggle('hidden'));

    document.querySelectorAll('[data-applycurve]').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.applycurve;
      const vals = parseCurveFlexible($('curveText' + i).value);
      if (!vals) return;
      p.scenarios[i].curve = vals;
      alert('情景「' + p.scenarios[i].name + '」曲线已替换（' + vals.length + ' 点' + (p.scenarios[i].priceMode === 'direct' ? '，直接价格模式' : '，比例标定模式') + '）。记得保存为新版本。');
      renderParamEditor();
    }));
    // 下载日前价格导入模板（8760 框架）
    document.querySelectorAll('[data-dltpl]').forEach(b => b.addEventListener('click', () => {
      const wb2 = ScenarioPrice.buildScenarioTemplate(p.meta.year);
      const out = XLSX.write(wb2, { type: 'array', bookType: 'xlsx' });
      const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '日前价格导入模板_' + p.meta.year + '.xlsx';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }));
    // 导入 xlsx 8760 直接价格 → 该情景设为直接价格模式
    document.querySelectorAll('[data-impscn]').forEach(inp => inp.addEventListener('change', e => {
      const i = +inp.dataset.impscn;
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const res = ScenarioPrice.parseScenarioPrice(rd.result, p.meta.year);
        e.target.value = '';
        if (!res.curve) { alert('导入失败：' + res.errors.join('；')); return; }
        const neg = res.negHours > 0 ? '\n注意：含 ' + res.negHours + ' 小时负价（日前市场真实存在，按原值导入）。' : '';
        if (!confirm('将情景「' + p.scenarios[i].name + '」曲线替换为导入的 8760 直接价格（' + (res.curve.reduce((a, v) => a + v, 0) / res.curve.length).toFixed(2) + ' 元/MWh 均值），并切换为「直接价格」模式（不再按 W 比例标定）。' + neg + '\n\n确认导入？')) return;
        p.scenarios[i].curve = res.curve;
        p.scenarios[i].priceMode = 'direct';
        alert('情景「' + p.scenarios[i].name + '」已切换为直接价格（8760 点' + (res.negHours > 0 ? '，含 ' + res.negHours + ' 小时负价' : '') + '）。记得保存为新版本。');
        renderParamEditor();
      };
      rd.readAsArrayBuffer(f);
    }));
    // 比例标定 → 直接价格（用当前曲线原值）
    document.querySelectorAll('[data-todirect]').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.todirect;
      if (!confirm('把情景「' + p.scenarios[i].name + '」切换为「直接价格」模式？当前 8760 曲线将原样进入成本计算，不再按 W × 因子标定。')) return;
      p.scenarios[i].priceMode = 'direct';
      renderParamEditor();
    }));
    document.querySelectorAll('[data-delscn]').forEach(b => b.addEventListener('click', () => {
      if (p.scenarios.length <= 1) { alert('至少保留 1 个情景'); return; }
      if (!confirm('删除情景「' + p.scenarios[+b.dataset.delscn].name + '」？（保存为新版本后生效）')) return;
      p.scenarios.splice(+b.dataset.delscn, 1);
      renderParamEditor();
    }));
    $('peApplyBase').addEventListener('click', () => {
      const vals = parseCurveFlexible($('baseText').value);
      if (!vals) return;
      p.baseline.curve = Calc.normalize(vals);
      alert('统调比例曲线已替换并归一化（8760 点）。记得保存为新版本。');
      renderParamEditor();
    });
    $('peApplyAddScn').addEventListener('click', () => {
      const vals = parseCurveFlexible($('scnAddText').value);
      if (!vals) return;
      const n = p.scenarios.length + 1;
      p.scenarios.push({ id: 'S' + n + '-' + Date.now() % 100000, name: '自定义情景' + n, weight: 0, priceFactor: 1, sr: 0, o: 0, curve: vals });
      alert('已新增情景（权重默认 0%，请调整权重使合计=100%）。记得保存为新版本。');
      renderParamEditor();
    });
    $('peSave').addEventListener('click', saveParamVersion);
    // V1.2/1.3 审批按钮
    const apprBtn = (id, apply) => {
      const b = $(id);
      if (!b) return;
      b.addEventListener('click', () => {
        const by = prompt('审批人姓名/工号（写入版本留痕）：', '');
        if (!by) return;
        apply(by);
        renderParamEditor();
      });
    };
    apprBtn('peApprReserve', by => { state.params.costModel.reserveApproval = { ok: true, by, at: Store.now() }; });
    apprBtn('peApprTh', by => { state.params.costModel.riskThresholds.approval = { ok: true, by, at: Store.now() }; });
  }

  /** 解析 8760 曲线：三列（日期/时刻/值）或单列值；返回 number[8760] 或 null */
  function parseCurveFlexible(text) {
    if (!text || !text.trim()) { alert('请先粘贴曲线内容'); return null; }
    const year = state.params.meta.year;
    // 尝试三列/两列解析
    const parsed = Validator.parseCurveText(text);
    if (parsed.rows.length >= year * 24 * 0.99) {
      const map = new Map();
      for (const r of parsed.rows) map.set(r.date + '|' + (r.hour < 10 ? '0' : '') + r.hour, r.value);
      const keys = Validator.expectedHourKeys(year);
      if (keys.every(k => map.has(k))) return keys.map(k => map.get(k));
    }
    // 单列数值
    const vals = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l && !/[^\d.,\-\s]/.test(l))
      .map(l => Number(l.replace(/,/g, ''))).filter(v => isFinite(v));
    if (vals.length === state.params.meta.hours) return vals;
    alert('曲线解析失败：需要 ' + state.params.meta.hours + ' 个点（三列：日期、时刻、值；或单列 ' + state.params.meta.hours + ' 个数值）。当前识别 ' +
      Math.max(parsed.rows.length, vals.length) + ' 个。');
    return null;
  }

  /** 解析小时列表文本：'0-7,10,14-18' → number[]（0-23，去重排序） */
  function parseHourList(text) {
    const out = new Set();
    for (const part of String(text).split(/[,，、\s]+/)) {
      if (!part) continue;
      const m = part.match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
      if (!m) return null;
      const a = +m[1], b = m[2] != null ? +m[2] : a;
      if (a < 0 || b > 23 || a > b) return null;
      for (let h = a; h <= b; h++) out.add(h);
    }
    return Array.from(out).sort((x, y) => x - y);
  }

  function saveParamVersion() {
    const p = state.params;
    // 收集编辑值
    p.meta.versionName = $('peVersionName').value.trim() || p.meta.versionName;
    p.meta.effectiveDate = $('peEffDate').value.trim();
    const rPct = Number($('peR').value);
    if (!(rPct >= 0 && rPct <= 100)) { alert('默认覆盖比例须在 0–100%'); return; }
    p.defaults.coverageRatio = rPct / 100;
    p.defaults.ceMode = $('peCeMode').value;
    p.redLines = {
      maxLossWeightPct: $('peRlLoss').value === '' ? null : Number($('peRlLoss').value),
      minWorstProfit: $('peRlWorst').value === '' ? null : Number($('peRlWorst').value),
      minExpectedProfit: $('peRlExp').value === '' ? null : Number($('peRlExp').value)
    };
    const recIdx = +(document.querySelector('input[name=peRec]:checked') || { value: -1 }).value;
    p.tiers = p.tiers.map((t, i) => ({
      key: t.key, name: t.name,
      q: Number($('peTq' + i).value) / 100,
      M: Number($('peTm' + i).value),
      recommended: i === recIdx,
      note: t.note || ''
    }));
    for (const t of p.tiers) {
      if (!(t.q > 0 && t.q <= 1) || !isFinite(t.M)) {
        alert('档位参数无效：q 须在 0–100% 之间，M 须为数值'); return;
      }
    }
    // V1.2/1.3 成本模型与到户层
    if (p.costModel && $('peReserve')) {
      const cm = p.costModel;
      const newReserve = Number($('peReserve').value) || 0;
      const th = cm.riskThresholds;
      const newTh = {
        varAlpha: Number($('peVarAlpha').value) || 0.95,
        minGrossMargin: Number($('peMinMargin').value),
        maxLossProbPct: Number($('peMaxLossProb').value),
        maxCvar: Number($('peMaxCvar').value),
        note: th.note || ''
      };
      if (!(newTh.varAlpha > 0 && newTh.varAlpha < 1)) { alert('VaR 置信度须在 0–1 之间'); return; }
      // 关键参数变化 → 审批状态重置为未审批
      const reserveChanged = newReserve !== (cm.reservePerMwh || 0);
      const thChanged = ['varAlpha', 'minGrossMargin', 'maxLossProbPct', 'maxCvar'].some(k => newTh[k] !== th[k]);
      cm.reservePerMwh = newReserve;
      cm.riskThresholds = { ...th, ...newTh, approval: thChanged ? { ok: false } : (th.approval || { ok: false }) };
      if (reserveChanged) cm.reserveApproval = { ok: false };
      cm.validUntil = $('peValidUntil').value.trim() || null;
    }
    if (p.billLayer && p.billLayer.item && $('peBillM0')) {
      p.billLayer.item.monthly = p.billLayer.item.monthly.map((_, m) => Number($('peBillM' + m).value) || 0);
      p.billLayer.item.bearer = $('peBillBearer').value;
    }
    const wSum = p.scenarios.reduce((a, s, i) => {
      s.name = $('peSname' + i).value.trim() || s.name;
      s.weight = Number($('peSw' + i).value) / 100;
      s.priceFactor = Number($('peSf' + i).value);
      if ($('peSalloc' + i)) s.allocShare = Number($('peSalloc' + i).value) || 0;
      if ($('peSref' + i)) s.refundShare = Number($('peSref' + i).value) || 0;
      s.sr = Number($('peSsr' + i).value) || 0;
      s.o = Number($('peSo' + i).value) || 0;
      return a + s.weight;
    }, 0);
    if (Math.abs(wSum - 1) > 5e-4) {
      alert('情景权重合计必须为 100%（当前 ' + (wSum * 100).toFixed(2) + '%），不能保存'); return;
    }
    // 显示舍入误差（如 33.33×3=99.99%）内自动归一
    if (Math.abs(wSum - 1) > 1e-12) {
      p.scenarios.forEach(s => { s.weight = s.weight / wSum; });
    }
    if (p.scenarios.some(s => !(s.weight >= 0) || !isFinite(s.priceFactor) || s.priceFactor <= 0)) {
      alert('情景权重不能为负，价格因子必须大于 0'); return;
    }
    if (p.baseline.curve.length !== p.meta.hours || p.scenarios.some(s => s.curve.length !== p.meta.hours)) {
      alert('曲线点数必须为 ' + p.meta.hours); return;
    }

    // ---------- V1.1 峰谷规则收集 ----------
    if (p.peakValley && $('peRCf1_gd_other')) {
      const pvc = p.peakValley;
      for (const c of pvc.retailCoeffs) {
        c.f1 = Number($('peRCf1_' + c.id).value);
        c.f2 = Number($('peRCf2_' + c.id).value);
        if (!(c.f1 > 0) || !(c.f2 > 0)) { alert('峰谷系数必须为正数（' + c.name + '）'); return; }
      }
      const tables = { gd: ['peHTgdP', 'peHTgdV'], sz: ['peHTszP', 'peHTszV'] };
      for (const key of Object.keys(tables)) {
        const peak = parseHourList($(tables[key][0]).value);
        const valley = parseHourList($(tables[key][1]).value);
        if (!peak || !valley || !peak.length || !valley.length) { alert('峰谷时段表格式错误（' + key + '）：应为 0-23 的逗号/区间列表'); return; }
        if (peak.some(h => valley.includes(h))) { alert('峰段与谷段小时重叠（' + key + '）'); return; }
        pvc.hourTable[key].peak = peak;
        pvc.hourTable[key].valley = valley;
      }
      const shM = parseHourList($('peShM').value), shH = parseHourList($('peShH').value);
      if (!shM || !shH || shM.some(m => m < 1 || m > 12)) { alert('尖峰月份（1-12）或小时（0-23）格式错误'); return; }
      pvc.sharp.months = shM; pvc.sharp.hours = shH;
      pvc.sharp.energyPremiumRate = Number($('peShER').value) || 0;
      pvc.sharp.tndPremiumRate = Number($('peShTR').value) || 0;
      pvc.sharp.tndPeakPricePerMwh = Number($('peShTP').value) || 0;
      pvc.riskDefaults.sysOpFeePerMwh = Number($('peRkSys').value) || 0;
      pvc.riskDefaults.marketSharePerMwh = Number($('peRkMkt').value) || 0;
      pvc.szTerminal.rows.forEach((r2, i) => {
        r2.f1 = Number($('peSZf1_' + i).value) || r2.f1;
        r2.f2 = Number($('peSZf2_' + i).value) || r2.f2;
      });
    }

    const saved = Store.saveVersion(p, p.meta.versionName, '由「' + state.activeVersionId + '」编辑生成');
    refreshVersionSelect(saved.meta.versionId);
    invalidateResult();
    alert('已保存并启用新版本：' + saved.meta.versionId);
    switchTab('input');
  }

  /* ================= 模板与演示 ================= */
  function downloadTemplate() {
    const keys = Validator.expectedHourKeys(state.params.meta.year);
    const csv = '\uFEFF日期,时刻,用电量\n' + keys.map(k => k.slice(0, 10) + ',' + (+k.slice(11, 13)) + ',').join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '客户8760曲线模板_' + state.params.meta.year + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
  }

  /** 演示曲线：工业客户，工作日双峰，kWh 单位（年电量约 2000 万 kWh） */
  function fillDemoCurve() {
    let seed = 20260101;
    const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const keys = Validator.expectedHourKeys(state.params.meta.year);
    const lines = ['日期	时刻	用电量(kWh)'];
    keys.forEach(k => {
      const d = k.slice(0, 10), h = +k.slice(11, 13);
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      const month = +k.slice(5, 7);
      const wd = (dow >= 1 && dow <= 5) ? 1 : 0.52;
      const season = 1 + 0.18 * Math.sin((month - 7) / 12 * 2 * Math.PI);
      let shape;
      if (h < 6) shape = 0.35;
      else if (h < 8) shape = 0.9;
      else if (h < 12) shape = 2.1;
      else if (h < 14) shape = 1.1;
      else if (h < 18) shape = 2.3;
      else if (h < 21) shape = 1.6;
      else shape = 0.8;
      const v = Math.max(0, 1150 * wd * season * shape * (0.92 + rnd() * 0.16));
      lines.push(d + '	' + h + '	' + v.toFixed(1));
    });
    $('txtCurve').value = lines.join('\n');
    if (!$('inpCustomer').value) $('inpCustomer').value = '演示客户（工业双峰）';
    invalidateValidation();
    switchTab('input');
    $('txtCurve').focus();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
