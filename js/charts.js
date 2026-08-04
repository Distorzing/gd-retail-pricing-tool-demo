/* 轻量 SVG 图表（无外部依赖，离线可用）：折线图（含指针跟随数据卡）/ 柱状图 */
(function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = ['#3f9bff', '#ff9f0a', '#30d158', '#ff6961', '#a78bfa'];

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function niceNum(v, d) {
    if (v == null || !isFinite(v)) return '';
    if (Math.abs(v) >= 10000) return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
    return Number(v.toFixed(d == null ? 2 : d)).toLocaleString('zh-CN');
  }
  function fmtSigned(v, d) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + niceNum(v, d == null ? 3 : d);
  }

  /**
   * 多序列折线图 + 指针跟随数据卡（显示各序列值与差值）。
   * series: [{name, values:[], color?}]
   * opts: {width,height,xLabels:[{i,text}],xValue:(i)=>String,yLabel,yDigits,diffDigits,unit}
   */
  function lineChart(container, series, opts) {
    opts = opts || {};
    const W = opts.width || 860, H = opts.height || 300;
    const M = { t: 18, r: 16, b: 34, l: 64 };
    container.innerHTML = '';
    container.style.position = 'relative';
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', preserveAspectRatio: 'xMidYMid meet', role: 'img' }, container);

    const all = [];
    series.forEach(s => s.values.forEach(v => { if (isFinite(v)) all.push(v); }));
    if (!all.length) return;
    let min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.06; min -= pad; max += pad;

    const n = Math.max.apply(null, series.map(s => s.values.length));
    const x = i => M.l + (W - M.l - M.r) * (n <= 1 ? 0.5 : i / (n - 1));
    const y = v => M.t + (H - M.t - M.b) * (1 - (v - min) / (max - min));

    // 网格 + Y 轴刻度
    for (let g = 0; g <= 4; g++) {
      const gv = min + (max - min) * g / 4, gy = y(gv);
      el('line', { x1: M.l, x2: W - M.r, y1: gy, y2: gy, stroke: 'rgba(255,255,255,.08)' }, svg);
      const t = el('text', { x: M.l - 8, y: gy + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#98a0b3' }, svg);
      t.textContent = niceNum(gv, opts.yDigits);
    }
    (opts.xLabels || []).forEach(L => {
      const t = el('text', { x: x(L.i), y: H - M.b + 16, 'text-anchor': 'middle', 'font-size': 11, fill: '#98a0b3' }, svg);
      t.textContent = L.text;
    });
    el('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, stroke: 'rgba(255,255,255,.22)' }, svg);
    el('line', { x1: M.l, x2: M.l, y1: M.t, y2: H - M.b, stroke: 'rgba(255,255,255,.22)' }, svg);

    // 序列
    const hidden = series.map(() => false);
    const paths = series.map((s, si) => {
      const color = s.color || COLORS[si % COLORS.length];
      let dAttr = '';
      s.values.forEach((v, i) => { if (isFinite(v)) dAttr += (dAttr ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); });
      return el('path', { d: dAttr, fill: 'none', stroke: color, 'stroke-width': 1.6 }, svg);
    });

    // 图例（toggleable 时可点击切换显隐）
    let lx = M.l + 6;
    series.forEach((s, si) => {
      const color = s.color || COLORS[si % COLORS.length];
      const g = el('g', { style: opts.toggleable ? 'cursor:pointer' : '', 'class': 'legend-item' }, svg);
      el('rect', { x: lx, y: 4, width: 14, height: 4, fill: color, rx: 2 }, g);
      const t = el('text', { x: lx + 18, y: 10, 'font-size': 11, fill: '#c6ccdb' }, g);
      t.textContent = s.name;
      // 点击热区
      el('rect', { x: lx - 4, y: 0, width: 18 + s.name.length * 12 + 18, height: 16, fill: 'transparent' }, g);
      if (opts.toggleable) {
        g.addEventListener('click', () => {
          hidden[si] = !hidden[si];
          paths[si].setAttribute('display', hidden[si] ? 'none' : '');
          g.setAttribute('opacity', hidden[si] ? '.35' : '1');
        });
      }
      lx += 18 + s.name.length * 12 + 26;
    });
    if (opts.yLabel) {
      const t = el('text', { x: 12, y: M.t + 4, 'font-size': 11, fill: '#98a0b3' }, svg);
      t.textContent = opts.yLabel;
    }

    /* ---------- 指针跟随（十字线 + 数据卡） ---------- */
    const cross = el('line', { y1: M.t, y2: H - M.b, stroke: 'rgba(255,255,255,.3)', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' }, svg);
    const dots = series.map((s, si) => el('circle', {
      r: 3.5, fill: s.color || COLORS[si % COLORS.length],
      stroke: '#0b0d12', 'stroke-width': 1.5, visibility: 'hidden'
    }, svg));
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.style.display = 'none';
    container.appendChild(tip);

    const overlay = el('rect', {
      x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b,
      fill: 'transparent', style: 'cursor:crosshair'
    }, svg);

    function showAt(i, px, py) {
      const cx = x(i);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      let html = '<div class="tip-title">' + (opts.xValue ? opts.xValue(i) : ('#' + (i + 1))) + '</div>';
      series.forEach((s, si) => {
        if (hidden[si]) { dots[si].setAttribute('visibility', 'hidden'); return; }
        const v = s.values[i];
        if (isFinite(v)) {
          dots[si].setAttribute('cx', cx); dots[si].setAttribute('cy', y(v));
          dots[si].setAttribute('visibility', 'visible');
        } else dots[si].setAttribute('visibility', 'hidden');
        const color = s.color || COLORS[si % COLORS.length];
        html += '<div class="tip-row"><span><i class="tip-dot" style="background:' + color + '"></i>' +
          s.name.replace(/\s*\(.*\)\s*$/, '') + '</span><b>' + niceNum(v, opts.diffDigits != null ? opts.diffDigits : 3) + '</b></div>';
      });
      if (series.length >= 2 && !hidden[0] && !hidden[1] && isFinite(series[0].values[i]) && isFinite(series[1].values[i])) {
        const diff = series[0].values[i] - series[1].values[i];
        html += '<div class="tip-row tip-diff"><span>差值（客户−基准）</span><b class="' +
          (diff >= 0 ? 'tip-pos' : 'tip-neg') + '">' + fmtSigned(diff, opts.diffDigits != null ? opts.diffDigits : 3) + '</b></div>';
      }
      if (opts.unit) html += '<div class="tip-unit">单位：' + opts.unit + '</div>';
      tip.innerHTML = html;
      tip.style.display = 'block';
      const cw = container.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = px + 14;
      if (left + tw > cw - 8) left = px - tw - 14;
      let top = Math.max(8, Math.min(py - th - 10, container.clientHeight - th - 8));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }
    function hide() {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach(d => d.setAttribute('visibility', 'hidden'));
      tip.style.display = 'none';
    }
    overlay.addEventListener('pointermove', e => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const sx = (e.clientX - rect.left) * (W / rect.width);
      let i = Math.round((sx - M.l) / (W - M.l - M.r) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      const crect = container.getBoundingClientRect();
      showAt(i, e.clientX - crect.left, e.clientY - crect.top);
    });
    overlay.addEventListener('pointerleave', hide);
  }

  /**
   * 柱状图（正负双色 + 悬浮提示）。items: [{label, value}]
   * opts: {width,height,yLabel,yDigits,unit}
   */
  function barChart(container, items, opts) {
    opts = opts || {};
    const W = opts.width || 860, H = opts.height || 260;
    const M = { t: 18, r: 16, b: 34, l: 64 };
    container.innerHTML = '';
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', preserveAspectRatio: 'xMidYMid meet' }, container);
    if (!items.length) return;
    let min = Math.min(0, Math.min.apply(null, items.map(i => i.value)));
    let max = Math.max(0, Math.max.apply(null, items.map(i => i.value)));
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08; min -= pad; max += pad;
    const y = v => M.t + (H - M.t - M.b) * (1 - (v - min) / (max - min));
    const bw = (W - M.l - M.r) / items.length;

    for (let g = 0; g <= 4; g++) {
      const gv = min + (max - min) * g / 4, gy = y(gv);
      el('line', { x1: M.l, x2: W - M.r, y1: gy, y2: gy, stroke: 'rgba(255,255,255,.08)' }, svg);
      const t = el('text', { x: M.l - 8, y: gy + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#98a0b3' }, svg);
      t.textContent = niceNum(gv, opts.yDigits);
    }
    el('line', { x1: M.l, x2: W - M.r, y1: y(0), y2: y(0), stroke: 'rgba(255,255,255,.22)' }, svg);

    items.forEach((it, i) => {
      const bx = M.l + bw * i + bw * 0.15;
      const top = y(Math.max(0, it.value)), hgt = Math.abs(y(it.value) - y(0));
      const bar = el('rect', {
        x: bx, y: top, width: bw * 0.7, height: Math.max(hgt, 0.5),
        fill: it.value >= 0 ? '#ff6961' : '#30d158', rx: 2
      }, svg);
      const title = el('title', {}, bar);
      title.textContent = it.label + '：' + fmtSigned(it.value, opts.yDigits != null ? opts.yDigits : 3) + (opts.unit ? ' ' + opts.unit : '');
      const t = el('text', { x: bx + bw * 0.35, y: H - M.b + 16, 'text-anchor': 'middle', 'font-size': 11, fill: '#98a0b3' }, svg);
      t.textContent = it.label;
      const v = el('text', { x: bx + bw * 0.35, y: it.value >= 0 ? top - 4 : top + hgt + 12, 'text-anchor': 'middle', 'font-size': 10, fill: '#c6ccdb' }, svg);
      v.textContent = niceNum(it.value, opts.yDigits);
    });
    if (opts.yLabel) {
      const t = el('text', { x: 12, y: M.t + 4, 'font-size': 11, fill: '#98a0b3' }, svg);
      t.textContent = opts.yLabel;
    }
  }

  root.Charts = { lineChart, barChart, COLORS };
})(typeof self !== 'undefined' ? self : this);
