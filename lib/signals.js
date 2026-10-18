/**
 * drift-guard 的检测信号：M1/M2/M3（对外仍用 s6/s4/s2 的键名）、交接收益比 R 与原规则 3。
 *
 * 判定本身在 `lib/detectors.js`；本模块只负责把结论写回旧字段、按阈值产出命中、
 * 以及 R 的喂料与事实句。全部是代码判断，不调用 LLM；上下文 token 由调用方
 * （`lib/index.js` 的 tokenMeter）传进来。
 *
 * 触发公式与 v0.1 规则 3 一致：计数达到阈值、且距上次提醒又满一个阈值才再提醒一次
 * （`count >= threshold && count - alerted >= threshold`），所以长时间打转不会每一轮都刷。
 *
 * 交接收益比 R 的计算在 `handoffRatio()`（纯函数，不碰状态），它用的"当前偏离强度"来自
 * `observeCall` 维护的活跃序号簿记（见 `deviationDeltas`）。
 *
 * @module dsh-drift-guard/signals
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { observeToolCall } from './observation.js';
import { createDetectorState, observeDetectors } from './detectors.js';
import { dedupeDeviation } from './score.js';

import { pathFromArgs, resolvePath, relativePath } from './paths.js';
import { appendLog } from './alerts.js';
import { DEFAULTS, DEFAULT_HANDOFF_RATIO } from './config.js';

/** 规则 3 的默认阈值；运行时以配置里的 `failureRepeats` 为准。 */
export const REPEAT_THRESHOLD = 3;

/** 读文件内容类工具：S3 只统计这些工具（grep/glob 是搜索，不是"重复读同一个文件"）。 */
export const READ_FILE_TOOLS = new Set(['read', 'ops_inspect_local_file']);

/**
 * 规则 3 的判定：同一签名连续失败达到阈值时给出提醒，之后每再满阈值再提醒一次。
 * 成功一次即清零；其他工具的调用不影响计数。
 *
 * @param {Map<string, {count: number, alerted: number}>} repeats
 * @param {string} signature - 工具名 + 参数 JSON。
 * @param {boolean} failed - 本次是否失败。
 * @param {number} [threshold] - 阈值，默认规则 3 的历史默认值 3（配置可覆盖）。
 * @returns {number|null} 需要提醒时的累计失败次数，否则 null。
 */
export function failureDecision(repeats, signature, failed, threshold = REPEAT_THRESHOLD) {
  if (!failed) {
    repeats.delete(signature);
    return null;
  }
  const record = repeats.get(signature) ?? { count: 0, alerted: 0 };
  record.count += 1;
  let alerted = null;
  if (record.count >= threshold && record.count - record.alerted >= threshold) {
    record.alerted = record.count;
    alerted = record.count;
  }
  repeats.set(signature, record);
  return alerted;
}

/** 深键排序：只有键序不同的两份参数视为同一次调用（S1/S2 用）。 */
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key]);
    return sorted;
  }
  return value;
}

/** S1/S2 用的调用签名：工具名 + 键序无关的参数 JSON。 */
export function chainSignature(tool, args) {
  return `${tool} ${JSON.stringify(sortJsonValue(args ?? null))}`;
}

/** 结果哈希：只把"是否失败 + 模型可见的内容块"纳入比较。 */
export function hashResult(result) {
  const shape = { isError: result?.isError === true, content: result?.content ?? null };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/** 文件指纹：修改时间 + 大小；拿不到（不存在、没权限）时返回 undefined。 */
export function fileStamp(resolved) {
  try {
    const info = fs.statSync(resolved);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return undefined;
  }
}

/** 逐个信号的计数状态（挂在会话状态上）。 */
export function createSignalState() {
  return {
    /** 本会话观察到的工具调用累计次数（R 的上下文估算基准，也是所有信号的调用序号）。 */
    calls: 0,
    /**
     * 每个信号**最近一次仍满足触发条件**的调用序号；条件是"计数已达阈值且没被重置"。
     * 交接收益比 R 用 `calls − active[名]` 当作 Δcallsᵢ：条件成立期间恒为 0，
     * 条件消失（计数被重置或不再评估）后才开始随时间衰减。
     */
    active: { s1: undefined, s2: undefined, s3: undefined, s4: undefined, s6: undefined },
    /** 最近一次算出的交接收益比 R（含全部构成），供 /drift 展示；还没算过时为 null。 */
    ratio: null,
    s1: { key: undefined, count: 0, alerted: 0 },
    s2: { recent: [], count: 0, alerted: 0 },
    s3: { path: undefined, stamp: undefined, count: 0, alerted: 0 },
    s4: { source: undefined, baseline: undefined, count: 0, alerted: 0 },
    /** S6 的连续"漫游"计数；`plan`/`todo` 是高水位基线，进度一涨就清零。 */
    s6: { count: 0, alerted: 0 },
    /** 判定层的状态（M1/M2/M3）；S1/S3 的判定已下线，字段保留给兼容期。 */
    detectors: createDetectorState(),
  };
}

/** 是否到达一次新的提醒：达到阈值、且距上次提醒又满一个阈值。 */
function reached(record, threshold) {
  return record.count >= threshold && record.count - record.alerted >= threshold;
}

/**
 * 观察一次工具调用，返回本次命中的信号。
 *
 * 就地更新 `signals` 里的计数；不做去重、不写日志，这样冷却与分级可以在上层单独演进。
 * 交接收益比 R 每次都算一遍并存在 `signals.ratio` 上（供 /drift 展示），只有 `trigger` 为真时
 * 才作为一条 `r` 命中返回。
 *
 * @param {object} signals - `createSignalState()` 的产物。
 * @param {{tool: string, args: unknown, result: any, cwd?: string, checkedSteps?: number,
 *   uncheckedSteps?: number, planComplete?: boolean, todo?: object, contextTokens?: number,
 *   state?: object}} call
 *   - `contextTokens`：主会话当前上下文 token（估算值），取不到时留 undefined，R 走回退估算；
 *   - `checkedSteps` / `uncheckedSteps`：PLAN.md 的步数（R 里 N 的输入），解析不到计划时留 undefined；
 *   - `planComplete`：计划已全部完成时为真；只有在没有可用 todo 时才把 N 压到 0；
 *   - `todo`：最近一次 `todo_write` 的计数 `{completed, pending, inProgress}`；有剩余项时 M2 与 N 优先用它；
 *   - `todoUsable`：todo 快照是否仍然可用（例如超过 `todoStaleCalls` 且 PLAN 可用时为 false）；
 *     省略时等同 true；
 *   - `wrote`：兼容参数（判定改由 detectors 从工具名与结果推出，这里不再使用）；
 *   - `state`：会话状态，只在 R 参数非法时用来写一条日志（可选）。
 * @param {object} [settings] - 阈值配置（默认取 `DEFAULTS`）。
 * @returns {{signal: string, count: number, [key: string]: any}[]} 命中的信号，按 s6→s4→s2、r 的顺序。
 */
export function observeCall(signals, call, settings) {
  const config = { ...DEFAULTS, ...(settings ?? {}) };
  const hits = [];
  const tool = String(call.tool ?? '');
  // 本次调用的序号：R 的上下文估算与活跃序号簿记都用它。
  signals.calls += 1;
  // 判定层：M1/M2/M3 由 detectors 产出，这里只把结论写回旧字段并按阈值产出 hits。
  // 旧 S1/S3 的判定已下线（重复读与重复调用由 M1 的"无新信息"覆盖）。
  const observation = observeToolCall({
    index: signals.calls,
    tool,
    result: call.result,
    checkedSteps: call.checkedSteps,
    uncheckedSteps: call.uncheckedSteps,
    planComplete: call.planComplete,
    todo: call.todo,
    contextTokens: call.contextTokens,
  });
  const found = observeDetectors(signals.detectors, observation, {
    todoUsable: call.todoUsable,
    signature: chainSignature(tool, call.args),
  }, config);

  // 视图字段：提醒簿记、/drift 与兼容期测试仍读这些计数。
  signals.s6.count = found.m1.sinceNovel;
  signals.s4.count = found.m2.count;
  signals.s4.source = found.m2.source;
  signals.s4.progress = found.m2.progress;
  signals.s2.count = found.m3.pairs;

  // active 只保留"最近一次仍成立"的调用序号：条件消失后序号留在原处，D 按 decayCalls 衰减
  // （删掉键会让 D 瞬间归零，与旧口径不一致）。条件消失时复位 alerted，下次要重新凑满阈值。
  if (found.m1.saturated) signals.active.s6 = signals.calls;
  else signals.s6.alerted = 0;
  if (found.m2.active) signals.active.s4 = signals.calls;
  else signals.s4.alerted = 0;
  if (found.m3.active) signals.active.s2 = signals.calls;
  else signals.s2.alerted = 0;

  if (found.m1.saturated && reached(signals.s6, config.s6RoamCalls)) {
    signals.s6.alerted = signals.s6.count;
    hits.push({ signal: 's6', count: signals.s6.count, tool });
  }
  if (found.m2.active && reached(signals.s4, config.s4IdleCalls)) {
    signals.s4.alerted = signals.s4.count;
    const hit = { signal: 's4', count: signals.s4.count, source: found.m2.source, progress: found.m2.progress };
    if (found.m2.source === 'plan') hit.checkedSteps = found.m2.progress;
    hits.push(hit);
  }
  if (found.m3.active && reached(signals.s2, config.s2Alternations)) {
    signals.s2.alerted = signals.s2.count;
    const recent = signals.detectors.m3.recent;
    hits.push({
      signal: 's2',
      count: signals.s2.count,
      tool,
      pair: [recent[recent.length - 2], recent[recent.length - 1]],
    });
  }

  // R：交接收益比 = 上下文规模 × 剩余工作量 + 偏离强度带来的浪费，对比一次交接的成本。
  // 计算与"是否触发"全在 handoffRatio() 里；这里只负责喂料、存下构成、在触发时命中。
  {
    const deviation = dedupeDeviation(signals.active, signals.calls, config.handoffRatio);
    const ratio = handoffRatio({
      tokens: call.contextTokens,
      calls: signals.calls,
      deviation,
      checkedSteps: call.checkedSteps,
      uncheckedSteps: call.uncheckedSteps,
      planComplete: call.planComplete,
      todo: call.todo,
      todoUsable: call.todoUsable,
      settings: config,
      state: call.state,
    });
    signals.ratio = ratio;
    if (ratio.trigger) hits.push({ signal: 'r', count: signals.calls, ratio });
  }

  return hits;
}

/**
 * 各信号距"最近一次仍满足触发条件"的调用数（Δcallsᵢ）。
 *
 * 条件是"计数已达阈值且没被重置"，由 `observeCall` 在**当次真的评估过该信号**时刷新
 * `signals.active`，所以条件消失（不再评估、计数被重置）后 Δ 才会开始变大、权重随之衰减。
 * 从未成立过的信号不出现在结果里。
 *
 * @param {object} signals - `createSignalState()` 的产物。
 * @returns {{s1?: number, s2?: number, s3?: number, s4?: number}}
 */
export function deviationDeltas(signals) {
  const out = {};
  for (const [key, at] of Object.entries(signals?.active ?? {})) {
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    out[key] = Math.max(0, (signals.calls ?? 0) - at);
  }
  return out;
}

/**
 * 挑出进入 R 计算的非法参数：返回第一个问题的说明；全部合法时返回 undefined。
 *
 * 测量值 `tokens` **不在此列**——它不是配置参数，拿不到（undefined / 非数字 / NaN）按
 * "读不到计量"走回退估算，这是既定语义。`calls`、计划步数与偏离分量属于调用方给的输入，
 * 给了就必须是非负有限数。
 *
 * @param {object} input - `handoffRatio()` 的入参。
 * @param {object} config - 合并默认值之后的 R 参数。
 * @returns {string|undefined}
 */
function ratioProblem(input, config) {
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `参数 ${key} 不是有限数（${String(value)}）`;
    }
  }
  const numbers = { calls: input?.calls, checkedSteps: input?.checkedSteps, uncheckedSteps: input?.uncheckedSteps };
  for (const [key, value] of Object.entries(numbers)) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return `参数 ${key} 不是非负有限数（${String(value)}）`;
    }
  }
  for (const [key, value] of Object.entries(input?.deltas ?? {})) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return `偏离强度分量 ${key} 不是非负有限数（${String(value)}）`;
    }
  }
  return undefined;
}

/**
 * 校验一份 todo 计数：completed / pending / inProgress 都必须是
 * 非负有限数；不合法时返回 undefined，让 N 回退到 PLAN.md 或默认值。
 *
 * @param {unknown} value
 * @returns {{completed: number, pending: number, inProgress: number}|undefined}
 */
function todoCounts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { completed, pending, inProgress } = value;
  for (const number of [completed, pending, inProgress]) {
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return undefined;
  }
  return { completed, pending, inProgress };
}

/** 参数非法时的结果：R 不参与判定（R 记 0，不把 NaN 漏出去），但**硬上限照常独立比较**。 */
function invalidRatio(reason, cap) {
  const config = DEFAULT_HANDOFF_RATIO;
  return {
    R: 0,
    C: cap.C,
    C0: config.c0,
    H: config.h,
    L: config.l,
    N: 0,
    D: 0,
    r: config.r,
    capTokens: cap.capTokens,
    growthTokens: 0,
    weights: {},
    deltas: {},
    calls: cap.calls,
    tokensPerCall: cap.tokensPerCall,
    nSource: 'invalid',
    capped: cap.capped,
    estimated: !cap.measured,
    trigger: cap.capped,
    invalid: true,
    reason,
  };
}

/** 参数非法时记一条日志：同一会话里同一个原因只记一条，避免每次工具调用都刷日志。 */
function noteInvalidRatio(state, reason) {
  if (state === null || typeof state !== 'object') return;
  if (!(state.ratioNoted instanceof Set)) state.ratioNoted = new Set();
  if (state.ratioNoted.has(reason)) return;
  state.ratioNoted.add(reason);
  appendLog(state, `[drift-guard] 内部错误（交接收益比 R）：${reason}，本次按"不触发"处理`);
}

/**
 * 交接收益比 R：`R = r·[(C − C₀)·N + D·L·C] / H`，`R ≥ 1` 时认为"交接比继续更划算"。
 *
 * 纯函数（唯一例外是参数非法时按 `input.state` 写一条日志）：不读也不写别的状态。
 * 任一参数不是有限数、或算出来的 R 不是有限数时，**R 的判定一律按"不触发"处理**并记一条日志，
 * 返回值里 `invalid` 为 true、`reason` 写明原因（R 记 0，不会漏出 NaN）。
 * **硬上限独立于参数校验**：`capTokens` 自身非法时退回默认 600000、`tokensPerCall` 自身非法时
 * 退回默认 1500、`calls` 不是有限数时按 0 计，所以 C 与上限总能算出来，参数坏掉时兜底提醒仍然有效；
 * 这种情况下 `trigger` 只看硬上限。各符号含义见 `lib/config.js` 的 `DEFAULT_HANDOFF_RATIO`。
 *
 * @param {{tokens?: number, calls?: number, deltas?: object, checkedSteps?: number,
 *   uncheckedSteps?: number, planComplete?: boolean, todo?: object, todoUsable?: boolean,
 *   settings?: object, state?: object}} input
 *   - `tokens`：主会话上下文 token（估算值）；不是有限数时按 `calls × tokensPerCall` 估算；
 *   - `calls`：主会话累计工具调用次数（也是 Δcallsᵢ 的基准）；
 *   - `deltas`：`deviationDeltas()` 的产物，缺项按"该信号没在打转"处理（权重不计）；
 *   - `checkedSteps` / `uncheckedSteps`：PLAN.md 的已打勾 / 未打勾项数；未给出时 N 取默认值；
 *   - `planComplete`：计划已全部完成时为真；只有在没有可用 todo 时才把 N 压到 0；
 *   - `todo`：最近一次 `todo_write` 的计数 `{completed, pending, inProgress}`；
 *     有剩余项时优先用它算 N（`completed < 2` 取默认值），全完成时 N = 0；
 *   - `todoUsable`：todo 快照是否仍然可用；false 时当作没有 todo（回退 PLAN）；省略等同 true；
 *   - `settings`：解析后的完整配置（只读它的 `handoffRatio`，应当是 `resolveConfig()` 的产物）；
 *   - `state`：会话状态，只在参数非法时用来写日志（可选）。
 * @returns {{R: number, C: number, C0: number, H: number, L: number, N: number, D: number,
 *   r: number, capTokens: number, growthTokens: number, weights: object, deltas: object,
 *   calls: number, tokensPerCall: number, nSource: string, todo?: object, capped: boolean,
 *   estimated: boolean, trigger: boolean, invalid: boolean, reason?: string}}
 *   `nSource` 说明 N 的来源：`todo`（按 todo 清单外推）、`todo-low`（todo 完成不足 2 条，取默认值）、
 *   `plan`（按计划外推，或计划已全部完成取 0）、`default`（取默认值）、`invalid`（参数非法）。
 */
export function handoffRatio(input) {
  const raw = input?.settings?.handoffRatio;
  const config = {
    ...DEFAULT_HANDOFF_RATIO,
    ...(raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
  };

  // C 与硬上限**先算**，且不依赖参数校验的结果：这样参数坏掉时兜底提醒仍然有效。
  // `tokensPerCall` 与 `capTokens` 自身非法（非有限数、非正数）时退回默认值，
  // 否则"按调用次数估算 C"和"硬上限比较"都会失效。
  const calls = typeof input?.calls === 'number' && Number.isFinite(input.calls) && input.calls > 0
    ? input.calls
    : 0;
  const tokensPerCall = typeof config.tokensPerCall === 'number' && Number.isFinite(config.tokensPerCall) && config.tokensPerCall > 0
    ? config.tokensPerCall
    : DEFAULT_HANDOFF_RATIO.tokensPerCall;
  const measured = typeof input?.tokens === 'number' && Number.isFinite(input.tokens) && input.tokens >= 0;
  const C = measured ? input.tokens : calls * tokensPerCall;
  // capTokens 自身非法时退回默认值，否则硬上限形同不存在。
  const capTokens = typeof config.capTokens === 'number' && Number.isFinite(config.capTokens) && config.capTokens > 0
    ? config.capTokens
    : DEFAULT_HANDOFF_RATIO.capTokens;
  // 兜底后 C 总是有限数（calls 与 tokensPerCall 都已兜底）；这里再挡一次，
  // 是为了以后改动不至于让硬上限静默失效。
  const capped = Number.isFinite(C) && C >= capTokens;
  const cap = { C, capTokens, capped, calls, tokensPerCall, measured };

  const problem = ratioProblem(input, config);
  if (problem !== undefined) {
    noteInvalidRatio(input?.state, problem);
    return invalidRatio(problem, cap);
  }

  // 低于基线的部分不计入：取不小于 0，避免 R 出现无意义的负值。
  const growthTokens = Math.max(0, C - config.c0);

  const weights = { s1: config.wS1, s2: config.wS2, s3: config.wS3, s4: config.wS4, s6: config.wS6 };
  const deltas = {};
  let D = 0;
  // 汇总层（`lib/score.js`）给了按机理去重的 D 时以它为准；报告用的 Δ 取各机理保留的那个信号。
  // 没给时回退到旧的逐信号相加（保留给直接调用这个纯函数的测试与外部脚本）。
  const deviation = input?.deviation;
  const deduped = deviation !== null && typeof deviation === 'object'
    && typeof deviation.D === 'number' && Number.isFinite(deviation.D) && deviation.D >= 0;
  if (deduped) {
    D = deviation.D;
    for (const part of Object.values(deviation.parts ?? {})) {
      if (part === null || typeof part !== 'object') continue;
      if (typeof part.signal !== 'string') continue;
      if (typeof part.delta !== 'number' || !Number.isFinite(part.delta)) continue;
      deltas[part.signal] = part.delta;
    }
  } else {
    for (const [key, weight] of Object.entries(weights)) {
      const delta = input?.deltas?.[key];
      if (typeof delta !== 'number' || !Number.isFinite(delta) || delta < 0) continue;
      deltas[key] = delta;
      D += weight * Math.exp(-delta / config.decayCalls);
    }
  }

  // N：剩余工作量（调用次数）。先用 todo（只有“可用”的快照才算）：
  //   还有未完成项 → (pending+in_progress) × calls/completed；completed<2 用 defaultN；
  //   todo 已全完成（至少一条）→ 0。
  // 没有可用 todo 时用 PLAN.md：已全部完成 → 0；还有未勾项且已勾项>0 → 外推；
  // 其余（缺计划、算不出平均）→ defaultN。
  const todo = todoCounts(input?.todo);
  const hasTodo = todo !== undefined && input?.todoUsable !== false;
  const complete = input?.planComplete === true;
  const hasPlan = typeof input?.uncheckedSteps === 'number' && Number.isFinite(input.uncheckedSteps)
    && input.uncheckedSteps >= 0;
  const planChecked = typeof input?.checkedSteps === 'number' && Number.isFinite(input.checkedSteps)
    && input.checkedSteps > 0 ? input.checkedSteps : 0;
  const planRemaining = hasPlan ? input.uncheckedSteps : 0;
  const todoTotal = hasTodo ? todo.completed + todo.pending + todo.inProgress : 0;
  const todoRemaining = hasTodo ? todo.pending + todo.inProgress : 0;
  let N;
  let nSource;
  if (hasTodo && todoRemaining > 0) {
    if (todo.completed >= 2) {
      N = todoRemaining * (calls / todo.completed);
      nSource = 'todo';
    } else {
      N = config.defaultN;
      nSource = 'todo-low';
    }
  } else if (!complete && planRemaining > 0) {
    if (planChecked > 0) {
      N = planRemaining * (calls / planChecked);
      nSource = 'plan';
    } else {
      N = config.defaultN;
      nSource = 'default';
    }
  } else if (hasPlan && planRemaining === 0 && planChecked > 0) {
    // 计划里已经没有未打勾项（即使调用方没显式给 planComplete）。
    N = 0;
    nSource = 'plan';
  } else if (hasTodo && todoTotal > 0) {
    N = 0;
    nSource = 'todo';
  } else if (complete) {
    N = 0;
    nSource = 'plan';
  } else {
    N = config.defaultN;
    nSource = 'default';
  }

  const R = (config.r * ((growthTokens * N) + (D * config.l * C))) / config.h;
  if (!Number.isFinite(R)) {
    const reason = `R 不是有限数（${String(R)}）`;
    noteInvalidRatio(input?.state, reason);
    return invalidRatio(reason, cap);
  }
  return {
    R,
    C,
    C0: config.c0,
    H: config.h,
    L: config.l,
    N,
    D,
    r: config.r,
    capTokens,
    growthTokens,
    weights,
    deltas,
    calls,
    tokensPerCall,
    nSource,
    todo: hasTodo ? { ...todo } : undefined,
    capped,
    estimated: !measured,
    trigger: capped || R >= 1,
    invalid: false,
  };
}

/** 展示用截断：日志行不该被一整段参数撑爆。 */
function trim(text, limit = 80) {
  const value = String(text);
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** 数字展示：非有限数一律写 0，避免文案里出现 NaN。 */
function num(value, digits = 0) {
  return (typeof value === 'number' && Number.isFinite(value) ? value : 0).toFixed(digits);
}

/** 信号名对应的一句话事实。 */
export function signalText(alert) {
  switch (alert.signal) {
    case 's1':
      return `同一工具 + 相同参数 + 相同结果已连续 ${alert.count} 次（tool=${alert.tool}）`;
    case 's2':
      return `两组调用来回交替已达 ${alert.count} 轮（${trim(alert.pair?.[0])} / ${trim(alert.pair?.[1])}）`;
    case 's3':
      return `${alert.tool} 已连续 ${alert.count} 次读取未修改的 ${alert.path}`;
    case 's4':
      return alert.source === 'todo'
        ? `todo 清单完成数（${alert.progress} 条）连续 ${alert.count} 次工具调用没有增加`
        : `PLAN.md 已打勾步骤（${alert.checkedSteps} 步）连续 ${alert.count} 次工具调用没有增加`;
    case 's6':
      return `连续 ${alert.count} 次工具调用既没有带来新结果、也没有推进产物（最后一次 tool=${alert.tool}）`;
    case 'r': {
      const ratio = alert.ratio ?? {};
      const context = `C ≈ ${num(ratio.C)} token${ratio.estimated ? '（估算）' : ''}`;
      if (ratio.capped) {
        return `主会话上下文规模已达硬上限（${context}，上限 ${num(ratio.capTokens)} token）`;
      }
      return `交接收益比 R ≈ ${num(ratio.R, 2)}（${context}、N = ${num(ratio.N)}、D = ${num(ratio.D, 2)}）`;
    }
    default:
      return `未知信号：${String(alert.signal)}`;
  }
}
