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
    pv: null, retail: null
  };

  /* ================= 初始化 ================= */
  function init() {
    bindTabs();
    refreshVersionSelect(BUILTIN_PARAMS.meta.versionId);
    bindInputSection();
    bindExportSection();
    bindParamsSection();
    renderSnapshots();
    loadCurveHistory();   // 刷新自动回填上次曲线
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
      state.params.billLayer = deepCopy(BUILTIN_PARAMS.billLayer);   // 旧版 7 项结构 → 度电分摊单项
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
    renderWcOverview();
    renderParamEditor();
    renderVersionsTable();
    bindRetailInputs();
  }

  /* ================= A+B 输入与校验 ================= */
  function bindInputSection() {
    $('btnValidate').addEventListener('click', runValidation);
    $('btnCompute').addEventListener('click', runCompute);
    $('btnTemplate').addEventListener('click', downloadTemplate);
    $('btnDemo').addEventListener('click', fillDemoCurve);
    bindRetailInputs();
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
            saveCurveHistory();
            statusEl.insertAdjacentHTML('beforeend', '<div class="status-ok" style="margin-top:6px">已解析工作表「' + r.sheetName + '」：' + r.rowCount + ' 行（' + r.mapping +
              (r.skipped ? '，跳过 ' + r.skipped + ' 行' : '') + '），请点击「校验曲线」（单位按 MWh）</div>');
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
    $('txtCurve').addEventListener('input', () => { invalidateValidation(); saveCurveHistory(); });
    document.querySelectorAll('input[name=inputMode]').forEach(r => r.addEventListener('change', () => {
      const simple = (document.querySelector('input[name=inputMode]:checked') || {}).value === 'simple';
      $('simpleArea').classList.toggle('hidden', !simple);
      $('curveArea').classList.toggle('hidden', simple);
      if (simple) {
        state.validation = { ok: true, series: { keys: Validator.expectedHourKeys(state.params.meta.year) }, stats: { count: 8760 } };
        $('btnValidate').disabled = true;
        $('btnValidate').title = '快速模式：无需校验';
      } else {
        $('btnValidate').disabled = false;
        $('btnValidate').title = '';
        state.validation = { ok: false };
      }
      updateComputeEnabled(); invalidateResult();
    }));
    document.querySelectorAll('input[name=signMode]').forEach(r => r.addEventListener('change', () => {
      const mid = r.value === 'midyear' ? r.checked : (document.querySelector('input[name=signMode]:checked') || {}).value === 'midyear';
      $('signStartMonth').disabled = !mid;
      const wInp = $('inpW');
      if (wInp) { wInp.disabled = mid; wInp.placeholder = mid ? '年内新增不需要（用后续中长期均价）' : '手工输入，必须大于 0，如 372'; }
      const wp = $('midYearPriceWrap'); if (wp) wp.classList.toggle('hidden', !mid);
      if (mid) { const mp = $('midYearPrice'); if (mp && !mp.value) mp.value = 420; }
      const mm = $('signStartMonth').value;
      $('signModeHint').textContent = mid
        ? '年内新增：仅按 ' + (+mm) + ' 月 1 日 ~ 12 月 31 日窗口测算；窗口外电量与已订中长期不计入（增量成本口径），缺口走日前或窗口内新增曲线'
        : '年度用户：全年 01-01~12-31 窗口测算（现状）';
      invalidateResult();
      updateComputeEnabled();
    }));
    $('signStartMonth').addEventListener('change', () => {
      const mid = (document.querySelector('input[name=signMode]:checked') || {}).value === 'midyear';
      $('signModeHint').textContent = mid
        ? '年内新增：仅按 ' + $('signStartMonth').value + ' 月 1 日 ~ 12 月 31 日窗口测算；窗口外电量与已订中长期不计入（增量成本口径），缺口走日前或窗口内新增曲线'
        : '年度用户：全年 01-01~12-31 窗口测算（现状）';
      invalidateResult();
    });
    $('inpW').addEventListener('input', updateComputeEnabled);
  }

  /** 零售侧输入联动：方式互斥/行渲染/开关启停/占比合计/峰平谷聚合提示 */
  function bindRetailInputs() {
    const renderLinkRows = () => {
      const box = $('rtLinkRows');
      const modes = [['rtLink1', 1, '①月度交易综合价'], ['rtLink2', 2, '②月度集中竞争综合价'], ['rtLink3', 3, '③日前市场月度综合价']];
      box.innerHTML = modes.map(([id, type, name]) => {
        const on = $(id).checked;
        if (!on) return '';
        return '<div class="inline" style="gap:10px;margin:4px 0;flex-wrap:wrap"><span class="hint" style="margin:0">' + name +
          '</span><label style="margin:0">占比 <input type="number" id="rtLink' + type + 'Ratio" min="0" max="100" step="0.1" value="10" style="width:80px"> %</label>' +
          '<label style="margin:0">平段联动价 <input type="number" id="rtLink' + type + 'Price" min="0" step="0.01" value="540" style="width:100px"> 元/MWh</label></div>';
      }).join('') || '<div class="hint" style="margin:4px 0">未勾选联动方式（纯固定价合同）</div>';
      modes.forEach(([id]) => $(id).addEventListener('change', () => { renderLinkRows(); rtSumHint(); invalidateResult(); }));
      box.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { rtSumHint(); invalidateResult(); }));
      rtSumHint();
    };
    const rtSumHint = () => {
      let linkSum = 0;
      [1, 2, 3].forEach(t => { const el = $('rtLink' + t + 'Ratio'); if (el) linkSum += Number(el.value) || 0; });
      const fixed = Number($('rtFixedRatio').value) || 0;
      const sum = fixed + linkSum;
      $('rtRatioSum').textContent = '+联动 ' + linkSum.toFixed(1) + '% = ' + sum.toFixed(1) + '%';
      $('rtRatioSum').style.color = Math.abs(sum - 100) < 1e-6 ? 'var(--green)' : 'var(--red)';
    };
    // 方式③与①②互斥
    const mutex = () => {
      if ($('rtLink3').checked) { $('rtLink1').checked = false; $('rtLink2').checked = false; }
      else if ($('rtLink1').checked || $('rtLink2').checked) $('rtLink3').checked = false;
    };
    ['rtLink1', 'rtLink2', 'rtLink3'].forEach(id => $(id).addEventListener('change', () => { mutex(); renderLinkRows(); invalidateResult(); }));
    $('rtFixedRatio').addEventListener('input', () => { rtSumHint(); invalidateResult(); });
    // 开关联动
    const toggle = (chk, fields) => $(chk).addEventListener('change', () => {
      fields.forEach(f => $(f).disabled = !$(chk).checked);
      invalidateResult();
    });
    toggle('rtCoalOn', ['rtCeciSign', 'rtCeciSettle', 'rtCoalPrice']);
    toggle('rtFloatOn', ['rtFloatPrice']);
    toggle('rtGreenOn', ['rtGreenVolMode', 'rtGreenRatio', 'rtGreenUsage', 'rtGreenFRatio', 'rtGreenFPrice', 'rtGreenLRatio', 'rtGreenLPrice', 'rtGreenAssessMode', 'rtGreenAssessCoef', 'rtGreenSupVol', 'rtGreenSupPrice']);
    $('rtGreenVolMode').addEventListener('change', () => {
      $('rtGreenRatio').disabled = $('rtGreenVolMode').value !== 'ratio' || !$('rtGreenOn').checked;
      $('rtGreenVolume').disabled = $('rtGreenVolMode').value !== 'fixed' || !$('rtGreenOn').checked;
      invalidateResult();
    });
    $('rtGreenOn').addEventListener('change', () => {
      $('rtGreenArea').classList.toggle('hidden', !$('rtGreenOn').checked);
    });
    renderLinkRows();
  }

  function readInputs() {
    return {
      customerName: $('inpCustomer').value.trim(),
      W: Number($('inpW').value),
      wLt: 0,   // W_LT 输入已删：留空口径=取 W
      unit: 'MWh', unitConfirmed: true,
      inputMode: (document.querySelector('input[name=inputMode]:checked') || {}).value || 'curve',
      signMode: (document.querySelector('input[name=signMode]:checked') || {}).value || 'full',
      signStartMonth: $('signStartMonth') ? $('signStartMonth').value : '09',
      midYearPrice: Number($('midYearPrice') ? $('midYearPrice').value : 420) || 420,
    };
  }

  /** 签约窗口：年度=全年；年内新增=起始月 1 日 ~ 12-31 */
  function signWindow(inp) {
    const isFull = !inp || inp.signMode !== 'midyear';
    if (isFull) return { from: '01-01', to: '12-31', isFull: true };
    const mm = String(inp.signStartMonth || '09').padStart(2, '0');
    return { from: mm + '-01', to: '12-31', isFull: false };
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

      // 峰平谷电量聚合预览（零售侧收入输入提示）
      try {
        const qPrev = Validator.parseCurveText($('txtCurve').value).rows;
        const map = new Map(qPrev.map(r => [r.date + '|' + String(r.hour).padStart(2, '0'), r.value]));
        const keys = Validator.expectedHourKeys(state.params.meta.year);
        const qArr = keys.map(k => map.get(k) || 0);   // 单位固定 MWh
        const agg = rtUsage(qArr);
        const sh = agg.shares;
        $('rtUsageAgg').innerHTML = '峰/平/谷电量（自动聚合）：峰 <b>' + num(sh.Qp, 1) + '</b> / 平 <b>' + num(sh.Qf, 1) + '</b> / 谷 <b>' + num(sh.Qv, 1) +
          '</b> MWh · 占比 ' + (sh.ap * 100).toFixed(1) + '% / ' + (sh.af * 100).toFixed(1) + '% / ' + (sh.av * 100).toFixed(1) +
          '%（时段：峰 10-11、14-18；谷 0-7）';
      } catch (e) { /* 聚合预览失败不阻塞校验 */ }
    } else {
      statusEl.innerHTML = '<div class="status-bad">✗ 校验未通过，已阻止报价（不会悄悄补数）：<br>· ' +
        v.errors.map(esc).join('<br>· ') + '</div>';
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
    const simple = inp.inputMode === 'simple';
    const needW = inp.signMode !== 'midyear';   // 年度用户必填 W；年内新增用后续中长期均价
    const ready = !!((needW ? inp.W > 0 : inp.midYearPrice > 0) && (simple ? true : (state.validation && state.validation.ok)));
    $('btnCompute').disabled = !ready;
  }

  /* ================= 测算 ================= */
  function runCompute() {
    const inp = readInputs();
    if (inp.inputMode === 'simple') {
      // 快速模式：按占比生成典型日 8760（段内均匀，全年同形）
      const total = Number($('simpleTotal').value) || 0;
      const ap = (Number($('simplePeak').value) || 0) / 100, af = (Number($('simpleFlat').value) || 0) / 100, av = (Number($('simpleValley').value) || 0) / 100;
      if (!(total > 0) || Math.abs(ap + af + av - 1) > 1e-6) { alert('快速模式：全年用电量须 >0，峰+平+谷占比须 = 100%（当前 ' + ((ap + af + av) * 100).toFixed(1) + '%）'); return; }
      const tou = (typeof BreakEven !== 'undefined' && BreakEven.CONFIG.TOU_HOURS) || { peak: [10,11,14,15,16,17,18], flat: [8,9,12,13,19,20,21,22,23], valley: [0,1,2,3,4,5,6,7] };
      const day = new Array(24).fill(0);
      tou.peak.forEach(h => day[h] = ap / tou.peak.length);
      tou.flat.forEach(h => day[h] = af / tou.flat.length);
      tou.valley.forEach(h => day[h] = av / tou.valley.length);
      const keys = Validator.expectedHourKeys(state.params.meta.year);
      state.qRaw = keys.map(k => total * day[+k.slice(11, 13)] / 365);
      state.validation = { ok: true, series: { keys }, stats: { count: 8760 } };
    }
    if (!state.qRaw) return;
    const needW = inp.signMode !== 'midyear';
    if (needW && !(inp.W > 0)) { alert('年度批发均价 W 必须大于 0'); return; }
    if (!needW && !(inp.midYearPrice > 0)) { alert('年内新增：请填后续中长期均价'); return; }
    const wLt = inp.wLt > 0 ? inp.wLt : (needW ? inp.W : inp.midYearPrice);   // 年内新增：中长期价=后续均价
    let qMWh = state.qRaw.slice();   // 单位固定 MWh
    // 签约窗口：年内新增 → 窗口外电量置 0（增量成本口径），峰谷聚合与分摊年化随之窗口化
    const signWin = signWindow(inp);
    if (!signWin.isFull) {
      const keys = state.validation.series.keys;
      qMWh = qMWh.map((v, t) => { const md = keys[t].slice(5, 10); return (md >= signWin.from && md <= signWin.to) ? v : 0; });
    }
    state.qMWh = qMWh;   // 供到户账单年度化与曲线解释使用

    // V1.1 先行：峰谷系数（用户类型）与时段聚合，确定 K（窗口化电量）
    const pvPre = matchPeakValley(inp, qMWh);

    // 零售侧收入（三模块：电能量 + 峰谷平衡 + 绿电）
    const rtInput = rtRead();
    const retail = RetailCalc.calcRetail(rtInput, pvPre.usage);
    if (retail.errors.length) { alert('零售侧输入校验未通过：\n· ' + retail.errors.join('\n· ')); return; }

    let result;
    try {
      result = Calc.computeQuote({
        q: qMWh, keys: state.validation.series.keys,
        W: needW ? inp.W : inp.midYearPrice,   // 年内新增：W=后续中长期均价
        wLt,
        K: pvPre.K,
        params: (() => {
          const p = JSON.parse(JSON.stringify(state.params));
          if (signWin.isFull) delete p.costModel.midYearPrice;   // 年度用户不适用
          else p.costModel.midYearPrice = inp.midYearPrice;      // 年内新增：窗口内已有仓位按此价结算
          return p;
        })(),
        window: signWin
      });
    } catch (e) { alert('测算被阻止：' + e.message); return; }

    // 盈亏平衡三档：成本分位+M（成本侧）→ solveBreakEven 解固定平段价（收入侧）
    result.tiers.forEach(t => {
      // 技术文档 CfD 口径已并入 calc.js 默认计算（超覆盖卖回只担价差）；成本口径 = t.equiv（全成本分位 + M）
      const tierCost = t.equiv;   // 元/MWh
      const be = RetailCalc.solveBreakEven(rtInput, pvPre.usage, tierCost);
      t.breakEven = be;
      // 用盈亏平衡平段价代入收入引擎，得到该档的收入侧数字
      const chkInput = JSON.parse(JSON.stringify(rtInput));
      if (be.flatPrice != null && be.flatPrice > 0) { chkInput.fixed.flatPrice = be.flatPrice; }
      else { chkInput.fixed.flatPrice = rtInput.fixed.flatPrice; t.breakEvenMiss = be.reason || null; }
      t.retail = RetailCalc.calcRetail(chkInput, pvPre.usage);
      // 三档价 = 盈亏平衡平段价（收入=成本+利润垫 M 反解）；该档零售利润应 = M（元/MWh）
      t.profitPerMwh = t.M;
      t.trialPrice = null;
      t.equiv = tierCost;   // 覆盖档位成本口径（CfD 时为 C_total+M；wholesale 时为原值）
    });

    state.result = result;
    state.retail = { input: rtInput, result: retail, usage: pvPre.usage };
    state.calcTime = Store.now();
    state.inputsUsed = { ...inp, wLt };
    const pcv = result.procurement;
    state.quoteCrumb = (inp.customerName || '未命名客户') + ' · W=' + num(inp.W) + ' / W_LT=' + num(wLt) + ' 元/MWh · 覆盖率=' +
      (pcv.coverage * 100).toFixed(0) + '%' + (pcv.isDefault ? '（默认假设）' : '') + ' · Q=' +
      result.Q.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' MWh · ' +
      (signWin.isFull ? '' : '窗口 ' + signWin.from + '~' + signWin.to + ' · ') + state.calcTime + ' 测算';

    // 正式报价闸门（V1.2/1.3 审批与规则有效期）
    const cm = state.params.costModel || {};
    const th = cm.riskThresholds || {};
    const expired = !!(cm.validUntil && new Date(cm.validUntil + 'T23:59:59') < new Date());
    const gateReasons = [];
    if (expired) gateReasons.push('规则版本已失效（有效期至 ' + cm.validUntil + '），需管理员更新确认');
    if (th.approval && !th.approval.ok) gateReasons.push('VaR/CVaR 风险门槛未审批');

    state.pv = {
      ...pvPre,
      gateReasons, expired,
      exportBlocked: false,
      formalBlocked: gateReasons.length > 0,
      blockReason: gateReasons.join('；')
    };

    const ctx = reportContext();
    state.snapshot = Exporter.buildSnapshot(ctx);
    Store.saveSnapshot(state.snapshot);
    renderSnapshots();

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
  /** 读取零售侧收入结构输入（依据零售侧收入设计文档） */
  function rtRead() {
    const linkModes = [];
    [['rtLink1', 1], ['rtLink2', 2], ['rtLink3', 3]].forEach(([id, type]) => {
      if ($(id).checked) {
        linkModes.push({
          type,
          ratio: (Number($('rtLink' + type + 'Ratio').value) || 0) / 100,
          flatPrice: Number($('rtLink' + type + 'Price').value) || 0
        });
      }
    });
    const greenOn = $('rtGreenOn').checked;
    return {
      userType: $('rtUserType').value,
      fixed: { ratio: (Number($('rtFixedRatio').value) || 0) / 100, flatPrice: 0 },   // 平段价=待求输出，不输入
      link: { modes: linkModes },
      coal: { enabled: $('rtCoalOn').checked, ceciSign: Number($('rtCeciSign').value) || 0, ceciSettle: Number($('rtCeciSettle').value) || 0, floatPrice: Number($('rtCoalPrice').value) || 0 },
      floatFee: { enabled: $('rtFloatOn').checked, price: Number($('rtFloatPrice').value) || 0 },
      green: { enabled: greenOn,
        volumeMode: $('rtGreenVolMode').value,
        ratio: (Number($('rtGreenRatio').value) || 0) / 100,
        fixedVolume: Number($('rtGreenVolume').value) || 0,
        actualGreenUsage: Number($('rtGreenUsage').value) || 0,
        fixedRatio: (Number($('rtGreenFRatio').value) || 0) / 100,
        fixedPrice: Number($('rtGreenFPrice').value) || 0,
        linkRatio: (Number($('rtGreenLRatio').value) || 0) / 100,
        linkEnvPrice: Number($('rtGreenLPrice').value) || 0,
        priority: 'A',
        assessMode: $('rtGreenAssessMode').value, assessCoef: Number($('rtGreenAssessCoef').value) || 0,
        supplement: { volume: Number($('rtGreenSupVol').value) || 0, price: Number($('rtGreenSupPrice').value) || 0 } }
    };
  }

  /** 峰平谷电量聚合（时段表来自参数；峰/谷时段决定 8760 → 三段） */
  function rtUsage(qMWh) {
    const table = (state.params.peakValley && state.params.peakValley.hourTable && state.params.peakValley.hourTable.gd) || { peak: [10, 11, 14, 15, 16, 17, 18], valley: [0, 1, 2, 3, 4, 5, 6, 7] };
    const shares = Calc.tofuAggregate(qMWh, state.validation.series.keys, table, null);
    return { shares, usage: { peak: shares.Qp, flat: shares.Qf, valley: shares.Qv } };
  }

  /** 峰谷系数（用户类型 → f1/f2，直接取零售 CONFIG；不再做 9 项分类匹配） */
  function matchPeakValley(inp, qMWh) {
    const userType = (inp && inp.userType) || ($('rtUserType') ? $('rtUserType').value : '非深圳工业');
    const tou = RetailCalc.CONFIG.TOU_TABLE[userType] || RetailCalc.CONFIG.TOU_TABLE['非深圳工业'];
    const { shares, usage } = rtUsage(qMWh);
    const K = tou.f1 * shares.ap + shares.af + tou.f2 * shares.av;
    return { active: true, status: 'ok', coeffRow: tou, shares, usage, K, userType, exportBlocked: false, blockReason: '' };
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
      pv: state.pv, retail: state.retail ? { input: state.retail.input, result: state.retail.result, usage: state.retail.usage } : null,
      bill: blItem && billAnn ? { item: blItem, annual: billAnn.annual, Qm: billAnn.Qm } : null
    };
  }

  /* ================= C 三档报价卡 ================= */
  function renderQuote(ctx) {
    $('quoteEmpty').classList.add('hidden');
    $('quoteResult').classList.remove('hidden');
    const r = state.result;

    // 签约窗口标注（年内新增用户）
    const wb = $('windowBanner');
    if (r.isFullYear) { wb.innerHTML = ''; }
    else {
      wb.innerHTML = '<div class="risk-note" style="border-left-color:var(--blue);margin-bottom:12px">📅 <b>年内新增用户测算</b>：签约窗口 ' + esc(r.window.from) + ' ~ ' + esc(r.window.to) +
        '（窗口电量 ' + r.Q.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' MWh）。窗口外电量与已订中长期不计入；成本 = 窗口内有效采购 + 窗口内缺口×日前价 + 分摊/运营（窗口内年化）。请到「批发曲线管理」为该客户摆窗口内采购曲线（口径：停用旧曲线=全增量；保留=已锁仓位可用）。</div>';
    }

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
        '<span class="pill ' + (t.profitPerMwh >= 0 ? 'green' : 'red') + '">零售利润 ' + sgn(t.profitPerMwh) + ' 元/MWh</span>' +
        '<span class="pill ' + (t.gates.lossProb ? 'gray' : 'red') + '">亏损概率 ' + (t.lossProb * 100).toFixed(1) + '%</span>' +
        '<span class="pill ' + (t.gates.cvar ? 'gray' : 'red') + '">CVaR' + Math.round(t.varAlpha * 100) + ' ' + num(t.CVaR) + '</span>' +
        (t.warnings.length ? '<span class="pill red">⚠ 红线预警</span>' : '') +
        (t.recommended && !t.gates.all ? '<span class="pill red">未过门槛</span>' : '') +
        '</div>';
      // 盈亏平衡固定平段价（零售收入结构求解）+ 峰谷价（f1/f2 系数）
      const be = t.breakEven || {};
      const tou = (state.retail && state.retail.result.tou) || { f1: 1, f2: 1 };
      const rtU = state.retail && state.retail.result.usage;
      const alphaTxt = rtU && rtU.total > 0
        ? ' · α峰 ' + (rtU.peak / rtU.total * 100).toFixed(1) + '% / α平 ' + (rtU.flat / rtU.total * 100).toFixed(1) + '% / α谷 ' + (rtU.valley / rtU.total * 100).toFixed(1) + '%'
        : '';
      const pPing = be.flatPrice != null ? be.flatPrice : t.price;
      const equiv = t.retail ? t.retail.unitPrice : t.price;
      // 服务费/分摊分解（成本构成里这两项单列，用户要看到它们进了价格）
      const firstScn = r.scenarios[0] || {};
      const opsVal = firstScn.Ccredit || 0;
      const allocVal = (firstScn.CbillAbsorb || 0) + (firstScn.allocShare || 0) - (firstScn.refundShare || 0);
      const feeLine = '<div class="tier-k" style="color:var(--blue)">含：服务费 ' + num(opsVal) + ' + 分摊 ' + num(allocVal) + ' 元/MWh（已计入价格）</div>';
      const priceHtml =
        '<div class="tier-price">' + num(pPing) + ' <small>元/MWh（固定平段价）</small></div>' +
        '<div class="tier-pvg"><span>峰 <b>' + num(tou.f1 * pPing) + '</b></span><span>平 <b>' + num(pPing) + '</b></span><span>谷 <b>' + num(tou.f2 * pPing) + '</b></span></div>' +
        '<div class="equiv">零售等效均价 ' + num(equiv) + '（' + num(equiv / 1000, 4) + ' 元/度）· 全成本 ' + num(t.equiv) + '</div>' +
        feeLine +
        '<div class="tier-k">' + (be.K != null ? 'K=' + num(be.K, 4) + ' · ' : '') + 'f1=' + tou.f1 + ' / f2=' + tou.f2 + alphaTxt +
        (be.flatPrice == null && be.reason ? ' · ⚠ ' + esc(be.reason) : '') + '</div>';
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
    const rt = state.retail;
    const be = t.breakEven || {};
    let pvHtml = '';
    if (rt && be.K != null) {
      pvHtml =
        '<div style="margin-top:10px"><b>盈亏平衡展开（零售收入 = 成本 → 解固定平段价）</b>' +
        '<div class="formula">K = f1×α峰 + α平 + f2×α谷 = ' + rt.result.tou.f1 + '×' + num(rt.result.usage.peak / rt.result.usage.total, 4) + ' + ' + num(rt.result.usage.flat / rt.result.usage.total, 4) + ' + ' + rt.result.tou.f2 + '×' + num(rt.result.usage.valley / rt.result.usage.total, 4) + ' = ' + num(be.K, 4) +
        '　→　P平 = (成本口径 ' + num(t.equiv) + ' − 峰谷平衡净额 ' + num(rt.result.peakValley.net / rt.result.usage.total) + '/MWh ÷ K 等) = <b>' + num(be.flatPrice) + '</b>；P峰 = ' + num(rt.result.tou.f1 * be.flatPrice) + '；P谷 = ' + num(rt.result.tou.f2 * be.flatPrice) + '</div>' +
        '<div>零售等效均价 = ' + num(t.retail ? t.retail.unitPrice : 0) + ' 元/MWh（含峰谷平衡净额与绿电）· 代回利润 = ' + sgn(t.profitPerMwh) + ' 元/MWh ✓</div></div>';
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
      '<b>' + esc(t.name) + '价格构成（成本分位 + M → 盈亏平衡解固定平段价）</b>' +
      '<div class="formula">成本口径 = C' + Math.round(t.q * 100) + ' + M = ' + num(t.Cq) + ' + ' + t.M + ' = <b>' + num(t.equiv) + '</b> 元/MWh' +
      (be.flatPrice != null ? '；盈亏平衡 P平 = <b>' + num(be.flatPrice) + '</b>（零售收入结构反解）' : '') + '</div>' +
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
      chip('K 因子', state.pv && state.pv.K != null ? num(state.pv.K, 4) : '—', '');

    let head = '<tr><th>情景</th><th class="num">权重</th><th class="num">W_da</th><th class="num">标定<br>系数k</th>' +
      '<th class="num">中长期<br>Clt</th><th class="num">日前缺口<br>Cda</th>' +
      '<th class="num">服务费</th><th class="num">度电<br>分摊</th><th class="num">C总</th>' +
      r.tiers.map(t => '<th class="num">' + esc(t.name) + '<br>利润</th>').join('') + '</tr>';
    let body = r.scenarios.map(s => {
      const cells = r.tiers.map(t => {
        const p = t.perScenarioProfit.find(x => x.id === s.id);
        return '<td class="num ' + clsProfit(p.profit) + '">' + sgn(p.profit) + '</td>';
      }).join('');
      return '<tr><td>' + esc(s.name) + '</td><td class="num">' + (s.weight * 100).toFixed(2) + '%</td>' +
        '<td class="num">' + num(s.W_da) + '</td><td class="num">' + num(s.calibK, 4) + '</td>' +
        '<td class="num">' + num(s.Clt) + '</td><td class="num">' + num(s.Cda) + '</td>' +
        '<td class="num">' + num(s.Ccredit) + '</td>' +
        '<td class="num">' + num(s.CbillAbsorb) + '</td>' +
        '<td class="num"><b>' + num(s.Ctotal) + '</b></td>' + cells + '</tr>';
    }).join('');
    body += '<tr class="ecl"><td><b>加权期望</b></td><td class="num">100%</td><td colspan="2"></td>' +
      '<td class="num"><b>' + num(wAvg(s => s.Clt)) + '</b></td><td class="num"><b>' + num(wAvg(s => s.Cda)) + '</b></td>' +
      '<td class="num"><b>' + num(wAvg(s => s.Ccredit)) + '</b></td><td class="num"><b>' + num(wAvg(s => s.CbillAbsorb)) + '</b></td><td class="num"><b>' + num(r.EC) + '</b></td>' +
      r.tiers.map(t => '<td class="num ' + clsProfit(t.expectedProfit) + '"><b>' + sgn(t.expectedProfit) + '</b></td>').join('') + '</tr>';
    $('tblScenarios').innerHTML = head + body;

    $('tblQuantiles').innerHTML =
      '<tr><th>档位</th><th class="num">分位 q</th><th class="num">Cq</th><th class="num">M</th><th class="num">成本口径<br>元/MWh</th>' +
      '<th class="num">盈亏平衡 P平</th><th class="num">P峰</th><th class="num">P谷</th><th class="num">零售等效<br>元/MWh</th><th class="num">元/度</th>' +
      '<th class="num">零售利润</th><th class="num">亏损概率</th><th class="num">CVaR95</th><th>门槛</th></tr>' +
      r.tiers.map(t => {
        const be = t.breakEven || {};
        const tou = (state.retail && state.retail.result.tou) || { f1: 1, f2: 1 };
        const pP = be.flatPrice != null ? be.flatPrice : null;
        const eq = t.retail ? t.retail.unitPrice : null;
        return '<tr><td><b>' + esc(t.name) + '</b>' + (t.recommended ? (t.gates.all ? '（推荐）' : '（需审批）') : '') + '</td>' +
          '<td class="num">' + (t.q * 100).toFixed(0) + '%</td><td class="num">' + num(t.Cq) + '</td><td class="num">' + t.M + '</td>' +
          '<td class="num"><b>' + num(t.equiv) + '</b></td>' +
          '<td class="num">' + (pP != null ? '<b>' + num(pP) + '</b>' : '—') + '</td>' +
          '<td class="num">' + (pP != null ? num(tou.f1 * pP) : '—') + '</td>' +
          '<td class="num">' + (pP != null ? num(tou.f2 * pP) : '—') + '</td>' +
          '<td class="num">' + (eq != null ? num(eq) : '—') + '</td>' +
          '<td class="num">' + (eq != null ? num(eq / 1000, 4) : '—') + '</td>' +
          '<td class="num ' + clsProfit(t.profitPerMwh) + '">' + sgn(t.profitPerMwh) + '</td>' +
          '<td class="num">' + (t.lossProb * 100).toFixed(1) + '%</td>' +
          '<td class="num">' + num(t.CVaR) + '</td>' +
          '<td>' + (t.gates.all ? '✅' : '❌ ' + ['margin', 'lossProb', 'cvar'].filter(k => !t.gates[k]).join('/')) + '</td></tr>';
      }).join('');

    renderRetail();
    renderBill();
  }

  /** 零售侧收入明细（三模块 + 算式追溯，依据零售侧收入设计文档） */
  function renderRetail() {
    const card = $('pvRiskCard'), body = $('pvRiskBody');
    if (!state.retail) { card.style.display = 'none'; return; }
    card.style.display = '';
    // 平段价留空（待求）→ 展示按推荐档（冲单）盈亏平衡价的收入构成；填了 → 当前试算价收入
    const hasPrice = (state.retail.input.fixed.flatPrice || 0) > 0;
    const recTier = state.result.tiers.find(t => t.recommended) || state.result.tiers[state.result.tiers.length - 1];
    const r = hasPrice ? state.retail.result : (recTier && recTier.retail ? recTier.retail : state.retail.result);
    const priceUsed = hasPrice ? state.retail.input.fixed.flatPrice : (recTier && recTier.breakEven ? recTier.breakEven.flatPrice : null);
    const header = hasPrice
      ? ''
      : '<div class="risk-note" style="border-left-color:var(--blue);margin-bottom:8px">未填试算价：以下收入构成按<b>「' + esc(recTier.name) + '」盈亏平衡平段价 ' + num(priceUsed) + ' 元/MWh</b> 计算（利润=0）。填写试算价可查看按实际报价的收入与利润。</div>';
    const wan = v => (v / 10000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const u = r.usage;
    const rows = [
      ['固定价格电费', r.energy.fixed.total, r.energy.fixed.seg],
      ['市场联动电费', r.energy.linked.total, r.energy.linked.seg],
      ['煤电联动电费', r.energy.coal ? r.energy.coal.total : null, r.energy.coal ? r.energy.coal.seg : null],
      ['浮动电费', r.energy.floatFee ? r.energy.floatFee.total : null, null],
      ['峰谷平衡 · 谷段补贴', r.peakValley.valleySubsidy, null],
      ['峰谷平衡 · 峰段惩罚', -r.peakValley.peakPenalty, null],
      ['绿电环境价值', state.retail.input.green.enabled ? r.green.total : null, null]
    ].filter(x => x[1] != null && Math.abs(x[1]) > 1e-9);
    const pctOf = v => (v / r.grandTotal * 100).toFixed(1) + '%';
    body.innerHTML = header +
      '<div class="risk-grid">' +
      '<div class="risk-item"><div class="k">峰/平/谷电量（MWh）</div><div class="v">' + num(u.peak, 0) + ' / ' + num(u.flat, 0) + ' / ' + num(u.valley, 0) +
      '<small>占比 ' + (u.peak / u.total * 100).toFixed(1) + '% / ' + (u.flat / u.total * 100).toFixed(1) + '% / ' + (u.valley / u.total * 100).toFixed(1) + '%</small></div></div>' +
      '<div class="risk-item"><div class="k">系数 f1 / f2（' + esc(state.retail.input.userType) + '）</div><div class="v">' + r.tou.f1 + ' / ' + r.tou.f2 + '</div></div>' +
      '<div class="risk-item"><div class="k">零售收入合计</div><div class="v">' + wan(r.grandTotal) + ' 万元<small>折合 ' + r.unitPriceYuanPerKwh.toFixed(4) + ' 元/kWh（' + num(r.unitPrice, 2) + ' 元/MWh）</small></div></div>' +
      '</div>' +
      '<div class="table-wrap"><table class="tbl"><tr><th>收入组件</th><th class="num">金额（万元）</th><th class="num">占比</th></tr>' +
      rows.map(x => '<tr><td>' + x[0] + '</td><td class="num">' + wan(x[1]) + '</td><td class="num">' + pctOf(x[1]) + '</td></tr>').join('') +
      '<tr><td><b>零售侧收入合计</b></td><td class="num"><b>' + wan(r.grandTotal) + '</b></td><td class="num">100%</td></tr></table></div>' +
      '<details style="margin-top:10px"><summary class="hint" style="cursor:pointer">▸ 展开算式追溯（与结算单逐项对账）</summary>' +
      '<div class="hint" style="margin-top:6px;white-space:pre-line">' + r.formulas.map(f => esc(f.comp) + ' · ' + esc(f.seg) + '：' + esc(f.formula)).join('\n') + '</div></details>';
  }

  /** 预计到户账单（度电分摊，单列，非电能量收入） */
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
      '</b> 元/MWh。<br>' + (it.bearer === 'pass'
        ? '承担方=客户承担（代收/转嫁）：分摊<b>不计入</b>三档价成本，仅在到户参考价中单列；不计入电能量收入。'
        : '承担方=售电公司承担：分摊<b>已计入</b>三档价全成本（CbillAbsorb=' + num(annual) + ' 元/MWh），到户参考价不再重复计列。') + '</div>';
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
    state.qMWh = state.qRaw.slice();

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
      onChange: () => { invalidateResult(); renderWcOverview(); }
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
        fld('服务费（元/MWh，全局）', '<input type="number" id="peOps" step="0.1" value="' + (cm.opsPerMwh != null ? cm.opsPerMwh : 6) + '">') +
        fld('超覆盖电量', '<select id="peOversell"><option value="sell"' + (cm.oversellAsLoss ? '' : ' selected') + '>卖回现货（只担价差，推荐）</option><option value="loss"' + (cm.oversellAsLoss ? ' selected' : '') + '>白买（亏全部采购价）</option></select>') +
        fld('VaR 置信度 α', '<input type="number" id="peVarAlpha" min="0.5" max="0.99" step="0.01" value="' + (th.varAlpha || 0.95) + '">') +
        fld('最低毛利（元/MWh）', '<input type="number" id="peMinMargin" step="0.5" value="' + (th.minGrossMargin != null ? th.minGrossMargin : 3) + '">') +
        fld('亏损概率上限（%）', '<input type="number" id="peMaxLossProb" step="1" value="' + (th.maxLossProbPct != null ? th.maxLossProbPct : 35) + '">') +
        fld('CVaR 限额（元/MWh）', '<input type="number" id="peMaxCvar" step="0.5" value="' + (th.maxCvar != null ? th.maxCvar : 8) + '">') +
        fld('门槛审批状态', '<div style="padding:8px 0">' + apprTxt(th.approval) + ' <button type="button" class="btn btn-sm" id="peApprTh">审批</button></div>') +
        fld('规则有效期至（可空）', '<input type="text" id="peValidUntil" value="' + (cm.validUntil || '') + '" placeholder="YYYY-MM-DD">') +
        '</div>' +
        '<div class="hint">保存新版本后，风险门槛审批状态将重置为「未审批」，须重新审批，否则正式报价导出被闸门阻止。</div></div>';
    }

    // ---------- 到户账单层：度电分摊（1–12 月逐月值） ----------
    if (p.billLayer && p.billLayer.item) {
      const it = p.billLayer.item;
      html += '<div class="param-block"><h3>到户账单层：度电分摊（1–12 月逐月值）</h3>' +
        '<div class="hint" style="margin-bottom:10px">承担方=售电公司承担 → <b>计入三档价全成本</b>；客户承担（代收/转嫁）→ 不计入成本，仅在到户参考价单列。</div>' +
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
        fld('权重（%）', '<input type="number" id="peSw' + i + '" value="' + (s.weight * 100).toFixed(2) + '" readonly style="background:var(--bg2);color:var(--muted)">') +
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

    html += '<div class="actions"><button class="btn btn-primary" id="peSave">保存为新版本并启用</button><span id="liveHint" class="hint" style="margin-left:10px"></span></div><div class="actions" style="margin-top:-8px">' +
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
    apprBtn('peApprTh', by => { state.params.costModel.riskThresholds.approval = { ok: true, by, at: Store.now() }; });

    // ============ 即改即用：关键参数输入即时生效当前版本（无需保存新版本） ============
    const cm = p.costModel || {};
    const live = (id, apply) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => { apply(el); invalidateResult(); liveHint(); });
      el.addEventListener('input', () => { apply(el); invalidateResult(); });
    };
    const liveHint = () => {
      const el = $('liveHint');
      if (el) { el.textContent = '✓ 已即时生效（未保存版本）；刷新前如需保留请「保存为新版本」'; el.style.color = 'var(--green)'; setTimeout(() => { el.textContent = ''; }, 3000); }
    };
    live('peOps', el => { cm.opsPerMwh = Number(el.value) || 0; });
    live('peOversell', el => { cm.oversellAsLoss = el.value === 'loss'; });
    if (p.billLayer && p.billLayer.item) {
      for (let m = 0; m < 12; m++) live('peBillM' + m, el => { p.billLayer.item.monthly[m] = Number(el.value) || 0; });
      live('peBillBearer', el => { p.billLayer.item.bearer = el.value; });
    }
    live('peR', el => { p.defaults.coverageRatio = (Number(el.value) || 0) / 100; });
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
    if (p.costModel && $('peVarAlpha')) {
      const cm = p.costModel;
      cm.reservePerMwh = 0;   // V2 起删除结构风险准备金（技术文档口径）
      const th = cm.riskThresholds;
      const newTh = {
        varAlpha: Number($('peVarAlpha').value) || 0.95,
        minGrossMargin: Number($('peMinMargin').value),
        maxLossProbPct: Number($('peMaxLossProb').value),
        maxCvar: Number($('peMaxCvar').value),
        note: th.note || ''
      };
      if (!(newTh.varAlpha > 0 && newTh.varAlpha < 1)) { alert('VaR 置信度须在 0–1 之间'); return; }
      cm.opsPerMwh = Number($('peOps').value) || 0;   // 运营成本（全局，元/MWh）
      cm.oversellAsLoss = $('peOversell') && $('peOversell').value === 'loss';   // 超覆盖口径：卖回现货（默认）/ 白买
      // 关键参数变化 → 审批状态重置为未审批
      const thChanged = ['varAlpha', 'minGrossMargin', 'maxLossProbPct', 'maxCvar'].some(k => newTh[k] !== th[k]);
      cm.riskThresholds = { ...th, ...newTh, approval: thChanged ? { ok: false } : (th.approval || { ok: false }) };
      cm.validUntil = $('peValidUntil').value.trim() || null;
    }
    if (p.billLayer && p.billLayer.item && $('peBillM0')) {
      p.billLayer.item.monthly = p.billLayer.item.monthly.map((_, m) => Number($('peBillM' + m).value) || 0);
      p.billLayer.item.bearer = $('peBillBearer').value;
    }
    const wSum = p.scenarios.reduce((a, s, i) => {
      s.name = $('peSname' + i).value.trim() || s.name;
      s.weight = Number($('peSw' + i).value) / 100;
      // 情景内不再编辑：价格因子/分摊/返还/SR/O（V2 起情景=仅 8760 价格曲线；分摊/运营移至成本区）
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
    const csv = '\uFEFF日期,时刻,用电量(MWh)\n' + keys.map(k => k.slice(0, 10) + ',' + (+k.slice(11, 13)) + ',').join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '客户8760曲线模板_' + state.params.meta.year + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
  }

  /** 演示曲线：工业客户，工作日双峰，MWh 单位（年电量约 2 万 MWh） */
  function fillDemoCurve() {
    let seed = 20260101;
    const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const keys = Validator.expectedHourKeys(state.params.meta.year);
    const lines = ['日期	时刻	用电量(MWh)'];
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
      const v = Math.max(0, 1.15 * wd * season * shape * (0.92 + rnd() * 0.16));   // MWh（原 kWh/1000）
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
