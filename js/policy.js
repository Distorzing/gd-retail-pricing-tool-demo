/* ============================================================
 * 政策常量单源（policy.js）
 *   所有政策相关常量集中此处：峰谷系数表、时段划分、峰谷平衡参考价、
 *   价格上下限、联动比例约束。政策年度调整时只改这一个文件。
 *   引用：retail.js / calc.js / app.js（POLICY 全局或 require）
 * ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
  else { root.POLICY = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    /** 峰谷系数表（用户类型 → {f1 峰, f2 谷}） */
    TOU_TABLE: {
      '非深圳工业': { f1: 1.7, f2: 0.38 },
      '非深圳商业': { f1: 1.0, f2: 1.0 },
      '深圳工业': { f1: 1.53, f2: 0.32 },
      '深圳商业': { f1: 1.53, f2: 0.32 },
      '冰蓄冷': { f1: 1.65, f2: 0.25 }
    },
    /** 时段划分（广东政策现行口径）：峰 10-11、14-18（7h）；谷 0-7（8h）；其余平（9h） */
    TOU_HOURS: {
      peak: [10, 11, 14, 15, 16, 17, 18],
      flat: [8, 9, 12, 13, 19, 20, 21, 22, 23],
      valley: [0, 1, 2, 3, 4, 5, 6, 7]
    },
    /** 峰谷平衡市场参考价（燃煤基准价，元/MWh；暂定，年度核对） */
    PV_REF_PRICE: 463,
    /** 固定价格上下限（元/MWh，0.372~0.554 元/kWh） */
    FIXED_PRICE_MIN: 372, FIXED_PRICE_MAX: 554,
    /** 联动约束（2026 新规）：总联动 10%~30%；现货联动 8%~15% */
    LINK_MIN_RATIO: 0.10, LINK_MAX_RATIO: 0.30,
    LINK_SPOT_MIN_RATIO: 0.08, LINK_SPOT_MAX_RATIO: 0.15,
    /** 浮动费用（仅平价套餐，0~5 元/MWh = 0~0.005 元/kWh） */
    FLOAT_FEE_MIN: 0, FLOAT_FEE_MAX: 5,
    /** 煤电联动浮动单价上限（元/MWh） */
    COAL_FLOAT_MIN: 0, COAL_FLOAT_MAX: 50,
    /** CECI 取整规则（trunc 向零截断） */
    CECI_ROUND_MODE: 'trunc'
  };
});
