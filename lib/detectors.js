/**
 * 判定层：每个检测器只回答一个机理问题。
 *
 * 三个机理（与论文里的两类失败对应）：
 *   M1 无新信息：连续多次调用既没有新结果，也没有产物推进（饱和）。
 *   M2 计划停滞：有剩余项的计划连续多次没有前进。
 *   M3 无效循环：两个动作来回交替、且期间没有任何产物。
 *
 * 全是纯函数 + 显式状态：不读宿主、不写文件、不碰 fs，便于单测。
 * 本阶段（v0.4 阶段 2）只做影子对比，不参与投递。
 *
 * @module dsh-drift-guard/detectors
 */

/** M1 窗口默认宽度（工具调用次数）；与 S6 的历史默认值一致，便于影子对比。 */
export const DEFAULT_WINDOW_CALLS = 12;
/** M2 默认容忍的停滞调用数；与 S4 的历史默认值一致。 */
export const DEFAULT_IDLE_CALLS = 20;
/** M3 默认交替轮数；与 S2 的历史默认值一致。 */
export const DEFAULT_ALTERNATIONS = 6;
/** M1 窗口上限：配置写成很大的数也不至于把状态撑爆。 */
export const WINDOW_MAX = 40;
/** M3 只看最近这么多次调用。 */
export const ALTERNATION_MAX = 40;

/** 检测器状态（挂在会话条目上，不落盘）。 */
export function createDetectorState() {
  return {
    /** 计划与 todo 的高水位（产物判定用，不按窗口滑出）。 */
    planHigh: undefined,
    todoHigh: undefined,
    m1: { window: [], sinceNovel: 0, sinceArtifact: 0, saturated: false },
    m2: { planBaseline: undefined, todoBaseline: undefined, count: 0, source: undefined, progress: undefined },
    m3: { recent: [], pairs: 0 },
  };
}

/**
 * 真实用户消息到来时清空"看最近一段调用"的状态。
 *
 * M1、M3 清空；M2 不清——计划停滞在用户发话后仍然成立（与 S4 的口径一致）。
 * 高水位基线保留：刚写过文件不该在下一轮被当成停滞。
 */
export function resetOnUserMessage(state) {
  state.m1.window = [];
  state.m1.sinceNovel = 0;
  state.m1.sinceArtifact = 0;
  state.m1.saturated = false;
  state.m3.recent = [];
  state.m3.pairs = 0;
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 窗口宽度：非法配置退回默认值，并夹在 1–`WINDOW_MAX`。 */
function windowSize(settings) {
  return Math.min(positiveInt(settings?.windowCalls, DEFAULT_WINDOW_CALLS), WINDOW_MAX);
}

/**
 * 这次调用有没有推进产物：写文件成功，或 PLAN 勾选数 / todo 完成数创了新高。
 * 同一次观测只该调用一次（高水位会被更新）。
 */
export function currentArtifact(state, observation) {
  if (observation.wrote === true) return true;
  let artifact = false;
  const planChecked = observation.plan?.checked;
  if (typeof planChecked === 'number') {
    if (state.planHigh !== undefined && planChecked > state.planHigh) artifact = true;
    state.planHigh = state.planHigh === undefined ? planChecked : Math.max(state.planHigh, planChecked);
  }
  const todoDone = observation.todo?.completed;
  if (typeof todoDone === 'number') {
    if (state.todoHigh !== undefined && todoDone > state.todoHigh) artifact = true;
    state.todoHigh = state.todoHigh === undefined ? todoDone : Math.max(state.todoHigh, todoDone);
  }
  return artifact;
}

/**
 * M1：信息饱和。饱和 = 连续 `windowCalls` 次既没出现窗口里没见过的结果，也没有产物。
 * `hit` 只在"从没饱和变成饱和"的那一次为真。
 */
export function observeM1(m1, observation, settings, artifact) {
  const width = windowSize(settings);
  const novel = !m1.window.some((entry) => entry.resultKey === observation.resultKey);
  m1.window.push({ resultKey: observation.resultKey });
  while (m1.window.length > width) m1.window.shift();
  m1.sinceNovel = novel ? 0 : m1.sinceNovel + 1;
  m1.sinceArtifact = artifact === true ? 0 : m1.sinceArtifact + 1;
  const saturated = m1.sinceNovel >= width && m1.sinceArtifact >= width;
  const hit = saturated && m1.saturated !== true;
  m1.saturated = saturated;
  return {
    hit,
    saturated,
    width,
    sinceNovel: m1.sinceNovel,
    sinceArtifact: m1.sinceArtifact,
    novel,
    artifact: artifact === true,
  };
}

/**
 * M2：计划停滞。有剩余项的计划（todo 优先、其次 PLAN.md）连续 `s4IdleCalls` 次没有前进。
 * 口径与 S4 一致：任一源有进展都算推进；没有剩余项时不评估。
 *
 * @param {object} m2 - `state.m2`。
 * @param {object} observation - 观测对象。
 * @param {{todoUsable?: boolean}} context - todo 快照是否仍然新鲜（由入口按 `todoStaleCalls` 判定）。
 * @param {object} settings - 解析后的配置。
 */
export function observeM2(m2, observation, context, settings) {
  const idle = positiveInt(settings?.s4IdleCalls, DEFAULT_IDLE_CALLS);
  const todo = observation.todo;
  const todoUsable = todo !== null && context?.todoUsable !== false;
  const plan = observation.plan;
  const planRemaining = plan !== null && !plan.complete ? Math.max(1, plan.unchecked) : 0;
  const todoRemaining = todoUsable ? todo.pending + todo.inProgress : 0;

  let source;
  let progress;
  let remaining;
  if (todoUsable && todoRemaining > 0) {
    source = 'todo';
    progress = todo.completed;
    remaining = todoRemaining;
  } else if (plan !== null && !plan.complete) {
    source = 'plan';
    progress = plan.checked;
    remaining = planRemaining;
  } else if (todoUsable) {
    source = 'todo';
    progress = todo.completed;
    remaining = todoRemaining;
  } else if (plan !== null) {
    source = 'plan';
    progress = plan.checked;
    remaining = 0;
  }

  let advanced = false;
  let initialized = false;
  if (plan !== null) {
    if (m2.planBaseline === undefined) {
      m2.planBaseline = plan.checked;
      initialized = true;
    } else if (plan.checked > m2.planBaseline) {
      m2.planBaseline = plan.checked;
      advanced = true;
    }
  }
  if (todoUsable) {
    if (m2.todoBaseline === undefined) {
      m2.todoBaseline = todo.completed;
      initialized = true;
    } else if (todo.completed > m2.todoBaseline) {
      m2.todoBaseline = todo.completed;
      advanced = true;
    }
  }

  m2.source = source;
  m2.progress = progress;
  if (source === undefined || remaining === 0 || advanced || initialized) m2.count = 0;
  else m2.count += 1;
  return { active: m2.count >= idle, count: m2.count, threshold: idle, source, progress };
}

/** 末尾连续交替的轮数：A B A B… 里完整的 A→B 循环个数（与 S2 同一算法，便于影子对比）。 */
function alternationPairs(recent) {
  const size = recent.length;
  if (size < 2) return 0;
  const last = recent[size - 1];
  const previous = recent[size - 2];
  if (last === previous) return 0;
  let run = 2;
  while (run < size) {
    const expected = run % 2 === 0 ? last : previous;
    if (recent[size - 1 - run] !== expected) break;
    run += 1;
  }
  return Math.floor(run / 2);
}

/**
 * M3：无效循环。两个签名来回交替达到 `s2Alternations` 轮，且这段时间没有任何产物。
 * 与 S2 的差别：产物一出现就清空交替记录（TDD 那种 test→edit 不会被报）。
 *
 * @param {object} m3 - `state.m3`。
 * @param {object} observation - 观测对象（这里只用不到字段，保留签名一致性）。
 * @param {object} settings - 解析后的配置。
 * @param {boolean} artifact - 本次调用是否推进了产物。
 * @param {string} signature - 本次调用的"工具 + 参数"签名。
 */
export function observeM3(m3, observation, settings, artifact, signature) {
  const threshold = positiveInt(settings?.s2Alternations, DEFAULT_ALTERNATIONS);
  if (artifact === true) m3.recent.length = 0;
  m3.recent.push(signature);
  while (m3.recent.length > ALTERNATION_MAX) m3.recent.shift();
  m3.pairs = alternationPairs(m3.recent);
  return { active: m3.pairs >= threshold, pairs: m3.pairs, threshold };
}

/**
 * 一次观测喂给三个检测器。产物只算一次（高水位会被更新，重复调用会失真）。
 *
 * @param {object} state - `createDetectorState()` 的产物。
 * @param {object} observation - `observeToolCall()` 的产物。
 * @param {{todoUsable?: boolean, signature?: string}} context - 入口补充的上下文。
 * @param {object} settings - 解析后的配置。
 */
export function observeDetectors(state, observation, context, settings) {
  const artifact = currentArtifact(state, observation);
  return {
    artifact,
    m1: observeM1(state.m1, observation, settings, artifact),
    m2: observeM2(state.m2, observation, context, settings),
    m3: observeM3(state.m3, observation, settings, artifact, context?.signature ?? ''),
  };
}
