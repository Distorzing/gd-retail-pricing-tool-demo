/* ============================================================
 * 批发曲线管理（V1.4）：右侧抽屉（移动端全屏）
 * 清单（A）+ 编辑抽屉（B）+ 最终采购曲线预览（C）
 * 数据存于参数版本 params.wholesaleCurves；编辑后需在参数管理保存新版本固化。
 * ============================================================ */
(function (root) {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d) => Calc.unit.fmt(v, d == null ? 2 : d);
  const STATUS = { locked: '已锁定', planned: '计划采购', scenario: '情景假设', disabled: '已停用' };

  let ctx = null;      // { params, keys, getQ(), onChange() }
  let editing = null;  // 正在编辑的曲线对象（null=清单视图）

  function open(context) {
    ctx = context;
    editing = null;
    render();
    $('wcOverlay').classList.remove('hidden');
    $('wcDrawer').classList.remove('hidden');
  }
  function close() {
    $('wcOverlay').classList.add('hidden');
    $('wcDrawer').classList.add('hidden');
    ctx && ctx.onChange && ctx.onChange();
  }

  function curves() { return ctx.params.wholesaleCurves || (ctx.params.wholesaleCurves = []); }
  function gNorm() { return Calc.normalize(ctx.params.baseline.curve); }
  function dflt() {
    return {
      ratio: (ctx.params.defaults && ctx.params.defaults.coverageRatio != null) ? ctx.params.defaults.coverageRatio : 0.9,
      price: ctx.getWlt ? ctx.getWlt() : 0
    };
  }
  function proc() {
    const q = ctx.getQ ? ctx.getQ() : null;
    if (!q) return null;
    return Calc.buildProcurement(curves(), q, ctx.keys, gNorm(), dflt());
  }

  /* ================= 主渲染 ================= */
  function render() {
    const list = curves().slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const p = proc();
    const d = $('wcDrawer');
    d.innerHTML =
      '<div class="wc-head"><div><h1 class="wc-title">批发曲线管理</h1><div class="wc-sub">年分月 / 月分日 / 日分时三粒度 · 细粒度覆盖粗粒度 · 同粒度后录入覆盖</div></div>' +
      '<span class="detail-close" id="wcClose">×</span></div>' +
      '<div class="wc-body">' +
      overviewHtml(p) +
      '<div class="card wc-card"><h2><span class="step">A</span>曲线清单</h2>' +
      '<div class="actions" style="margin:0 0 12px">' +
      '<button class="btn btn-primary btn-sm" id="wcAdd">+ 新增批发曲线</button>' +
      '<button class="btn btn-sm" id="wcGenDefault">由默认假设生成年度基准曲线</button>' +
      '<select id="wcTplGran" class="btn btn-sm" style="width:auto;cursor:pointer" title="选择要下载的模板粒度">' +
      '<option value="year_month">年分月模板</option><option value="month_day">月分日模板</option><option value="day_hour">日分时模板</option></select>' +
      '<button class="btn btn-sm" id="wcDlTpl">下载模板</button>' +
      '<label class="btn btn-sm" style="cursor:pointer">导入 xlsx<input type="file" id="wcImpFile" accept=".xlsx,.xls" style="display:none"></label></div>' +
      '<div class="hint" style="margin:-4px 0 10px">三种粒度各自独立的模板文件（年分月/月分日/日分时），下拉选择后下载，导入时各导各的互不干扰；模板时间轴已预置，填顶部曲线名称后竖着粘贴「电量(MWh)」「价格(元/MWh)」两列即可，整行留空自动跳过。导入后需确认并在参数管理保存新版本。</div>' +
      listHtml(list, p) + '</div>' +
      (editing ? editorHtml() : '') +
      previewHtml(p) +
      '<div class="hint" style="margin-top:10px">编辑结果暂存于当前参数版本工作副本；在「参数管理」点击「保存为新版本并启用」后固化并留痕。</div>' +
      '</div>';
    bind();
  }

  function overviewHtml(p) {
    const n = curves().filter(c => c.enabled !== false).length;
    if (!p) {
      return '<div class="summary-chips"><div class="schip">已配置 <b>' + n + '</b> 条</div>' +
        '<div class="schip">覆盖率 <b>—（先在报价页校验客户曲线）</b></div></div>';
    }
    return '<div class="summary-chips">' +
      '<div class="schip">已配置 <b>' + n + '</b> 条</div>' +
      '<div class="schip">当前覆盖率 <b>' + (p.coverage * 100).toFixed(1) + '%</b>' + (p.isDefault ? '（默认假设）' : '') + '</div>' +
      '<div class="schip">未覆盖（日前缺口） <b>' + p.gapMwh.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) + '</b> MWh</div>' +
      '<div class="schip">加权采购均价 <b>' + num(p.weightedPrice) + '</b> 元/MWh</div>' +
      (p.overMwh > 0 ? '<div class="schip red">超覆盖 <b>' + p.overMwh.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '</b> MWh ⚠</div>' : '') +
      '</div>';
  }

  /* ================= A. 曲线清单 ================= */
  function windowText(c) {
    if (c.granularity === 'day_hour') return (c.entries[0] ? c.entries[0].timeKey.slice(0, 10) : '') + ' 全天';
    const w = c.window || { from: '01-01', to: '12-31' };
    return (w.from === '01-01' && w.to === '12-31') ? ctx.params.meta.year + ' 全年' : w.from + ' ~ ' + w.to;
  }
  function listHtml(list, p) {
    if (!list.length) return '<div class="empty" style="margin:10px 0">暂无批发曲线。新增后覆盖率由曲线自动汇总；空清单时测算使用默认年度基准假设。</div>';
    return '<div class="table-wrap"><table class="tbl"><tr><th>曲线名称</th><th>状态</th><th>生效窗口</th><th>粒度</th>' +
      '<th class="num">电量 MWh</th><th class="num">均价</th><th class="num">窗口覆盖率</th><th>录入时间</th><th>操作</th></tr>' +
      list.map(c => {
        const q = ctx.getQ ? ctx.getQ() : null;
        let mwhTxt = '—', covTxt = '—';
        if (q) {
          const exp = Calc.expandCurve(c, ctx.keys, gNorm(), q);
          let mwh = 0, covQ = 0;
          exp.forEach((v, t) => { mwh += v.mwh; });
          if (c.window) { ctx.keys.forEach((k, t) => { const md = k.slice(5, 10); if (md >= c.window.from && md <= c.window.to) covQ += q[t]; }); }
          mwhTxt = mwh.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
          covTxt = covQ > 0 ? (mwh / covQ * 100).toFixed(1) + '%' : '—';
        }
        const wavg = avgPrice(c);
        return '<tr' + (c.enabled === false ? ' style="opacity:.5"' : '') + '>' +
          '<td>' + esc(c.name) + '</td>' +
          '<td>' + (STATUS[c.enabled === false ? 'disabled' : c.status] || c.status) + '</td>' +
          '<td>' + esc(windowText(c)) + '</td>' +
          '<td>' + (Calc.GRAN_NAME[c.granularity] || c.granularity) + '</td>' +
          '<td class="num">' + mwhTxt + (c.quantityMode === 'ratio' ? '<br><small>（覆盖率换算）</small>' : '') + '</td>' +
          '<td class="num">' + (wavg != null ? num(wavg) : '—') + '</td>' +
          '<td class="num">' + covTxt + '</td>' +
          '<td style="font-size:11px">' + esc(String(c.createdAt).replace('T', ' ').slice(0, 16)) + '</td>' +
          '<td class="inline">' +
          '<button class="btn btn-sm" data-edit="' + c.id + '">编辑</button>' +
          '<button class="btn btn-sm" data-copy="' + c.id + '">复制</button>' +
          (c.enabled === false
            ? '<button class="btn btn-sm" data-en="1" data-id="' + c.id + '">启用</button>'
            : '<button class="btn btn-sm btn-danger" data-en="0" data-id="' + c.id + '">停用</button>') +
          '</td></tr>';
      }).join('') + '</table></div>';
  }
  function avgPrice(c) {
    const es = c.entries || [];
    if (!es.length) return null;
    let m = 0, s = 0;
    es.forEach(e => { const w = Number(e.quantityMwh) || 1; m += w; s += w * (Number(e.priceYuanPerMwh) || 0); });
    return m > 0 ? s / m : null;
  }

  /* ================= B. 编辑抽屉 ================= */
  function newCurve() {
    return {
      id: 'wc-' + Date.now().toString(36), name: '', status: 'planned', enabled: true,
      createdAt: Store.now(), updatedAt: Store.now(), year: ctx.params.meta.year,
      window: { from: '01-01', to: '12-31' }, granularity: 'year_month',
      quantityMode: 'mwh', priceMode: 'flat', flatPrice: null,
      entries: [], note: ''
    };
  }

  function entryKeys(c) {
    const w = c.window;
    const year = ctx.params.meta.year;
    if (c.granularity === 'year_month') {
      const m1 = +w.from.slice(0, 2), m2 = +w.to.slice(0, 2);
      return Array.from({ length: m2 - m1 + 1 }, (_, i) => String(m1 + i).padStart(2, '0'));
    }
    if (c.granularity === 'month_day') {
      const dates = [];
      ctx.keys.forEach(k => { const md = k.slice(5, 10); if (md >= w.from && md <= w.to) { const d = k.slice(0, 10); if (!dates.length || dates[dates.length - 1] !== d) dates.push(d); } });
      return dates;
    }
    // day_hour：窗口须为同一天
    return Array.from({ length: 24 }, (_, h) => year + '-' + w.from + '|' + String(h).padStart(2, '0'));
  }

  function editorHtml() {
    const c = editing;
    const keys = entryKeys(c);
    if (c.entries.length !== keys.length || c.entries.some((e, i) => e.timeKey !== keys[i])) {
      // 结构变化时重建明细（保留同 timeKey 旧值）
      const old = new Map((c.entries || []).map(e => [e.timeKey, e]));
      c.entries = keys.map(k => old.get(k) || { timeKey: k, quantityMwh: null, ratioPct: null, priceYuanPerMwh: null });
    }
    const granHint = { year_month: '按月录入，月内按统调比例分时（保持月总量不变）', month_day: '按日录入，日内按统调比例分时（保持日总量不变）', day_hour: '逐小时直接录入' };
    return '<div class="card wc-card wc-editor"><h2><span class="step">B</span>' + (curves().find(x => x.id === c.id) ? '编辑曲线' : '新增曲线') + '</h2>' +
      '<div class="param-grid">' +
      fld('曲线名称', '<input type="text" id="wcName" value="' + esc(c.name) + '" placeholder="如：年度基准 / 7月补充 / 7月15日工作日修正">') +
      fld('采购状态', '<select id="wcStatus">' + ['locked', 'planned', 'scenario'].map(s => '<option value="' + s + '"' + (c.status === s ? ' selected' : '') + '>' + STATUS[s] + '</option>').join('') + '</select>') +
      fld('窗口起（MM-DD）', '<input type="text" id="wcFrom" value="' + esc(c.window.from) + '"' + (c.granularity === 'day_hour' ? ' placeholder="如 07-15"' : '') + '>') +
      fld('窗口止（MM-DD）', '<input type="text" id="wcTo" value="' + esc(c.window.to) + '"' + (c.granularity === 'day_hour' ? ' disabled' : '') + '>') +
      fld('时间粒度', '<select id="wcGran">' +
        '<option value="year_month"' + (c.granularity === 'year_month' ? ' selected' : '') + '>年分月</option>' +
        '<option value="month_day"' + (c.granularity === 'month_day' ? ' selected' : '') + '>月分日</option>' +
        '<option value="day_hour"' + (c.granularity === 'day_hour' ? ' selected' : '') + '>日分时</option></select>') +
      fld('电量输入方式', '<select id="wcQMode"><option value="mwh"' + (c.quantityMode === 'mwh' ? ' selected' : '') + '>MWh</option><option value="ratio"' + (c.quantityMode === 'ratio' ? ' selected' : '') + '>覆盖率（按该时段客户预测电量换算）</option></select>') +
      fld('价格输入方式', '<select id="wcPMode"><option value="flat"' + (c.priceMode === 'flat' ? ' selected' : '') + '>统一均价</option><option value="perEntry"' + (c.priceMode === 'perEntry' ? ' selected' : '') + '>逐条价格</option></select>') +
      (c.priceMode === 'flat' ? fld('统一均价（元/MWh）', '<input type="number" id="wcFlatPrice" step="0.01" value="' + (c.flatPrice != null ? c.flatPrice : '') + '">') : '') +
      '</div>' +
      '<div class="hint" style="margin:6px 0">' + granHint[c.granularity] + '；明细共 ' + keys.length + ' 行</div>' +
      '<div class="table-wrap wc-entries"><table class="tbl"><tr><th>时段</th>' +
      (c.quantityMode === 'ratio' ? '<th class="num">覆盖率 %</th>' : '<th class="num">电量 MWh</th>') +
      (c.priceMode === 'perEntry' ? '<th class="num">价格 元/MWh</th>' : '') + '</tr>' +
      c.entries.map((e, i) => '<tr><td>' + esc(e.timeKey) + '</td>' +
        '<td class="num"><input type="number" step="0.01" data-eq="' + i + '" value="' + (c.quantityMode === 'ratio' ? (e.ratioPct != null ? e.ratioPct : '') : (e.quantityMwh != null ? e.quantityMwh : '')) + '"></td>' +
        (c.priceMode === 'perEntry' ? '<td class="num"><input type="number" step="0.01" data-ep="' + i + '" value="' + (e.priceYuanPerMwh != null ? e.priceYuanPerMwh : '') + '"></td>' : '') +
        '</tr>').join('') +
      '</table></div>' +
      '<div id="wcImpact" class="hint"></div>' +
      '<div class="actions"><button class="btn btn-primary" id="wcSave">保存曲线</button>' +
      '<button class="btn" id="wcCancel">取消</button></div></div>';
  }
  const fld = (label, control) => '<div><label>' + label + '</label>' + control + '</div>';

  /* ================= C. 最终预览 ================= */
  function previewHtml(p) {
    if (!p) return '';
    const monthly = new Array(12).fill(0);
    p.purchase.forEach((v, t) => { monthly[+ctx.keys[t].slice(5, 7) - 1] += v; });
    const logs = p.logs.length
      ? '<div class="hint" style="margin-top:6px">覆盖日志：' + p.logs.map(l => esc(l.name) + ' 替换 ' + l.replacedHours + ' 小时 / ' + l.replacedMwh.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' MWh').join('；') + '</div>'
      : '';
    return '<div class="card wc-card wc-preview"><h2><span class="step">C</span>最终采购曲线预览</h2><div id="wcChart"></div>' +
      '<div class="hint">蓝=客户逐月电量，橙=有效采购量；缺口自动进入日前市场。</div>' + logs + '</div>';
  }

  /* ================= 事件 ================= */
  function bind() {
    $('wcClose').addEventListener('click', close);
    $('wcOverlay').onclick = close;
    $('wcAdd').addEventListener('click', () => { editing = newCurve(); render(); });
    $('wcDlTpl').addEventListener('click', downloadTemplate);
    $('wcImpFile').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const res = WcTemplate.parseImportWorkbook(rd.result);
        e.target.value = '';
        if (!res.curves.length) {
          alert('未解析到有效曲线：' + (res.errors.join('；') || '请检查模板格式'));
          return;
        }
        const names = res.curves.map(c => c.name + '（' + (Calc.GRAN_NAME[c.granularity] || c.granularity) + '，' + c.entries.length + ' 行）').join('、');
        const warn = res.errors.length ? '\n\n以下行被跳过：' + res.errors.slice(0, 5).join('；') : '';
        if (!confirm('将导入 ' + res.curves.length + ' 条曲线：' + names + warn + '\n\n确认导入？（导入后覆盖规则按粒度与录入时间生效）')) return;
        const now = Store.now();
        res.curves.forEach(c => {
          c.id = 'wc-imp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
          c.createdAt = now; c.updatedAt = now;
          curves().push(c);
        });
        render();
      };
      rd.readAsArrayBuffer(f);
    });
    $('wcGenDefault').addEventListener('click', () => {
      const c = newCurve();
      c.name = '默认年度基准曲线';
      c.note = '由系统默认假设生成（r0=' + ((dflt().ratio) * 100).toFixed(0) + '%，价格=W_LT 输入值）';
      c.quantityMode = 'ratio';
      c.entries = Array.from({ length: 12 }, (_, m) => ({ timeKey: String(m + 1).padStart(2, '0'), quantityMwh: null, ratioPct: dflt().ratio * 100, priceYuanPerMwh: dflt().price || null }));
      c.priceMode = 'perEntry';
      editing = c; render();
    });
    document.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      editing = JSON.parse(JSON.stringify(curves().find(x => x.id === b.dataset.edit)));
      render();
    }));
    document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
      const c = JSON.parse(JSON.stringify(curves().find(x => x.id === b.dataset.copy)));
      c.id = 'wc-' + Date.now().toString(36);
      c.name += '（副本）';
      c.createdAt = Store.now(); c.updatedAt = Store.now();
      curves().push(c);
      render();
    }));
    document.querySelectorAll('[data-en]').forEach(b => b.addEventListener('click', () => {
      const c = curves().find(x => x.id === b.dataset.id);
      c.enabled = b.dataset.en === '1';
      c.updatedAt = Store.now();
      render();
    }));
    if (editing) bindEditor();
  }

  function bindEditor() {
    const c = editing;
    const rerenderEntries = () => {
      c.window.from = $('wcFrom').value.trim() || '01-01';
      if (c.granularity !== 'day_hour') c.window.to = $('wcTo').value.trim() || '12-31';
      render();
    };
    $('wcGran').addEventListener('change', () => {
      c.granularity = $('wcGran').value;
      if (c.granularity === 'day_hour') { c.window.to = c.window.from; }
      rerenderEntries();
    });
    $('wcFrom').addEventListener('change', () => { if (c.granularity === 'day_hour') c.window.to = c.window.from; rerenderEntries(); });
    $('wcTo').addEventListener('change', rerenderEntries);
    $('wcQMode').addEventListener('change', () => { c.quantityMode = $('wcQMode').value; render(); });
    $('wcPMode').addEventListener('change', () => { c.priceMode = $('wcPMode').value; render(); });
    $('wcSave').addEventListener('click', saveEditor);
    $('wcCancel').addEventListener('click', () => { editing = null; render(); });
  }

  function saveEditor() {
    const c = editing;
    c.name = $('wcName').value.trim();
    if (!c.name) { alert('请填写曲线名称'); return; }
    c.status = $('wcStatus').value;
    c.window.from = $('wcFrom').value.trim();
    c.window.to = c.granularity === 'day_hour' ? c.window.from : $('wcTo').value.trim();
    if (!/^\d{2}-\d{2}$/.test(c.window.from) || !/^\d{2}-\d{2}$/.test(c.window.to) || c.window.from > c.window.to) {
      alert('窗口格式应为 MM-DD 且起 ≤ 止'); return;
    }
    if (c.granularity === 'month_day') {
      const days = entryKeys(c).length;
      if (days > 62) { alert('月分日明细超过 62 天（当前 ' + days + '），请拆分为多条曲线'); return; }
    }
    c.quantityMode = $('wcQMode').value;
    c.priceMode = $('wcPMode').value;
    c.flatPrice = $('wcFlatPrice') ? Number($('wcFlatPrice').value) : null;
    if (c.priceMode === 'flat' && !(c.flatPrice > 0)) { alert('请填写统一均价（>0）'); return; }
    document.querySelectorAll('[data-eq]').forEach(inp => {
      const e = c.entries[+inp.dataset.eq];
      if (c.quantityMode === 'ratio') e.ratioPct = inp.value === '' ? null : Number(inp.value);
      else e.quantityMwh = inp.value === '' ? null : Number(inp.value);
    });
    document.querySelectorAll('[data-ep]').forEach(inp => {
      c.entries[+inp.dataset.ep].priceYuanPerMwh = inp.value === '' ? null : Number(inp.value);
    });
    // 校验：电量/价格非负；覆盖率 0–100；价格必填
    for (const e of c.entries) {
      const qty = c.quantityMode === 'ratio' ? e.ratioPct : e.quantityMwh;
      if (qty == null) continue;   // 未填写的时段不参与覆盖
      if (!(qty >= 0)) { alert('电量/覆盖率不得为负（' + e.timeKey + '）'); return; }
      if (c.quantityMode === 'ratio' && qty > 100) { alert('覆盖率限 0–100%（' + e.timeKey + '）；如需超覆盖请改用 MWh 录入'); return; }
      const price = c.priceMode === 'flat' ? c.flatPrice : e.priceYuanPerMwh;
      if (!(price >= 0)) { alert('价格不得为空或负值（' + e.timeKey + '）'); return; }
      e.priceYuanPerMwh = price;
    }
    // 覆盖影响提示
    const q = ctx.getQ ? ctx.getQ() : null;
    let impact = '';
    if (q) {
      const others = curves().filter(x => x.id !== c.id);
      const before = Calc.buildProcurement(others, q, ctx.keys, gNorm(), dflt());
      const exp = Calc.expandCurve(c, ctx.keys, gNorm(), q);
      const rank = Calc.GRAN_RANK[c.granularity];
      let addH = 0, repH = 0, repM = 0, keepH = 0;
      exp.forEach((v, t) => {
        if (!before.source[t]) addH++;
        else if (rank >= before.rank[t]) { repH++; repM += before.purchase[t]; }
        else keepH++;
      });
      impact = '将新增覆盖 ' + addH + ' 小时；替换 ' + repH + ' 小时 / ' + repM.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' MWh' +
        (keepH ? '；' + keepH + ' 小时因更细粒度曲线而保留不变' : '') + '。确认保存？';
    } else impact = '尚未校验客户曲线，跳过覆盖影响预估。确认保存？';
    if (!confirm(impact)) return;

    c.updatedAt = Store.now();
    const list = curves();
    const i = list.findIndex(x => x.id === c.id);
    if (i >= 0) list[i] = c; else list.push(c);
    editing = null;
    render();
  }

  function downloadTemplate() {
    const gran = $('wcTplGran') ? $('wcTplGran').value : 'year_month';
    const wb = WcTemplate.buildTemplateWorkbook(ctx.params.meta.year, gran);
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '批发曲线导入模板_' + (Calc.GRAN_NAME[gran] || gran) + '_' + ctx.params.meta.year + '.xlsx';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ================= 预览图 ================= */
  function renderPreviewChart() {
    const p = proc();
    if (!p || !$('wcChart')) return;
    const q = ctx.getQ();
    const qm = new Array(12).fill(0), pm = new Array(12).fill(0);
    ctx.keys.forEach((k, t) => { const m = +k.slice(5, 7) - 1; qm[m] += q[t]; pm[m] += p.purchase[t]; });
    Charts.lineChart($('wcChart'), [
      { name: '客户逐月电量', values: qm, color: '#3f9bff' },
      { name: '有效采购量', values: pm, color: '#ff9f0a' }
    ], {
      width: 460, height: 200,
      xLabels: [0, 2, 4, 6, 8, 10, 11].map(i => ({ i, text: (i + 1) + '月' })),
      xValue: i => (i + 1) + '月', unit: 'MWh', diffDigits: 1
    });
  }

  const origRender = render;
  render = function () { origRender(); renderPreviewChart(); };

  root.WholesaleUI = { open, close };
})(typeof self !== 'undefined' ? self : this);
