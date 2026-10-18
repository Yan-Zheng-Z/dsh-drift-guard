/**
 * 汇总层：把各信号的"最近一次仍成立"折叠成偏离强度 D。
 *
 * 旧口径（v0.3.1）是逐信号相加：`D = Σ wᵢ·e^(−Δᵢ/decay)`，同一机理的多个信号会重复计权
 * （例如 S1 与 S6 都在描述"没有新东西"）。新口径按机理去重：
 *   每个机理只取**贡献最强**的一个信号（`w·e^(−Δ/decay)` 最大者），三个机理再相加。
 * 默认权重与衰减都不改，所以数值差异只在"同机理多信号同时成立"时出现。
 *
 * @module dsh-drift-guard/score
 */

/** 机理 → 归属的信号。 */
export const MECHANISM = {
  m1: { label: '无新信息', signals: ['s1', 's3', 's6'] },
  m2: { label: '计划停滞', signals: ['s4'] },
  m3: { label: '无效循环', signals: ['s2'] },
};

/** 信号名 → handoffRatio 里的权重键。 */
const WEIGHT_KEY = { s1: 'wS1', s2: 'wS2', s3: 'wS3', s4: 'wS4', s6: 'wS6' };

/** 取一个信号的权重；非法值按 0（等于不计权）。 */
export function signalWeight(signal, ratioConfig) {
  const key = WEIGHT_KEY[signal];
  if (key === undefined) return 0;
  const value = ratioConfig?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * 按机理去重后的偏离强度。
 *
 * @param {object} active - `signals.active`（信号 → 最近一次仍成立的调用序号）。
 * @param {number} calls - 当前调用序号（Δ = calls − active[信号]）。
 * @param {object} ratioConfig - `handoffRatio()` 用到的参数组（权重与 `decayCalls`）。
 * @returns {{D: number, parts: object}} `parts` 里每个机理只留贡献最强的那个信号。
 */
export function dedupeDeviation(active, calls, ratioConfig) {
  const total = typeof calls === 'number' && Number.isFinite(calls) ? calls : 0;
  const decay = typeof ratioConfig?.decayCalls === 'number' && ratioConfig.decayCalls > 0
    ? ratioConfig.decayCalls
    : 20;
  const parts = {};
  let D = 0;
  for (const [key, definition] of Object.entries(MECHANISM)) {
    let best;
    for (const signal of definition.signals) {
      const at = active?.[signal];
      if (typeof at !== 'number' || !Number.isFinite(at)) continue;
      const weight = signalWeight(signal, ratioConfig);
      if (weight <= 0) continue;
      const delta = Math.max(0, total - at);
      const contribution = weight * Math.exp(-delta / decay);
      if (best === undefined || contribution > best.contribution) {
        best = { signal, weight, delta, contribution };
      }
    }
    if (best === undefined) continue;
    parts[key] = { ...best, label: definition.label };
    D += best.contribution;
  }
  return { D, parts };
}

/** 一行摘要：`M1=s6(1×e^0) M2=s4(×1)`，给影子日志与 /drift 用。 */
export function describeParts(parts) {
  const items = [];
  for (const [key, part] of Object.entries(parts ?? {})) {
    items.push(`${key.toUpperCase()}=${part.signal}`);
  }
  return items.length === 0 ? '无' : items.join(' ');
}
