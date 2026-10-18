/**
 * 投递层：把命中折成"要不要提醒、哪一级、追加什么"，以及会话级的状态簿记。
 *
 * 这里不判断"有没有偏离"（那是 `lib/detectors.js` + `lib/signals.js` 的事），
 * 只处理：冷却、R 的倍增门槛、级别选择、层级转交、追加文本与交接模板。
 *
 * @module dsh-drift-guard/delivery
 */

import {
  SIGNAL_NAME,
  HANDOFF_TEMPLATE,
  noticeMessage,
  reminderText,
  forwardReminderText,
  appendTarget,
  recordSignalAlert,
} from './alerts.js';
import { createSignalState, observeCall, signalText, fileStamp } from './signals.js';
import { resolvePath, pathFromArgs } from './paths.js';

/** 信号名 → 配置里的阈值键。 */
const SIGNAL_THRESHOLD = {
  s1: 's1Repeats',
  s2: 's2Alternations',
  s3: 's3Reads',
  s4: 's4IdleCalls',
  s6: 's6RoamCalls',
};

/** 级别相同时的取舍顺序。S6 最轻，排最后。 */
export const SIGNAL_PRIORITY = ['r', 's4', 's3', 's2', 's1', 's6'];

/** R 的倍增门槛层级上限：2^53 以内都是精确整数，再高就没有意义了。 */
export const RATIO_TIER_MAX = 53;

/** 每条信号的提醒簿记：已提醒次数与"上次提醒时的会话调用序号"。 */
function createReminderBook() {
  const book = {};
  for (const name of SIGNAL_PRIORITY) book[name] = { alerts: 0, lastCall: 0 };
  // R 额外两笔账：硬上限是否已经单独提醒过、以及"固定倍增门槛"走到第几层。
  book.r.capAlerted = false;
  book.r.rTier = 0;
  return book;
}

/** 一份会话级的信号计数 + 提醒簿记；供测试直接构造。 */
export function createSessionSignals() {
  return { signals: createSignalState(), reminders: createReminderBook(), todo: undefined, todoIdle: 0 };
}

/** 当前"触发状态仍然成立"的信号数（条件没被重置且已到阈值；R 单独按第 3 级处理）。 */
function triggeredCount(signals, settings) {
  let count = 0;
  for (const name of SIGNAL_PRIORITY) {
    // R 走自己的第 3 级；S6 高频低严重度，计数进去会把"只是漫游"升级成"建议交接"。
    if (name === 'r' || name === 's6') continue;
    // S6 漫游期间 S4 的提醒会被压住；它也不该再去抬高别的信号的级别。
    if (name === 's4' && roaming(signals, settings)) continue;
    const record = signals[name];
    if (record !== undefined && record.count >= settings[SIGNAL_THRESHOLD[name]]) count += 1;
  }
  return count;
}

/** S6 是否处于触发状态（用于压住 S4 的提醒）。 */
function roaming(signals, settings) {
  return typeof signals?.s6?.count === 'number' && signals.s6.count >= settings.s6RoamCalls;
}

/**
 * R 的提醒门槛（冷却之外的另一道闸）：固定倍增门槛 **1 → 2 → 4 → 8…**
 *
 *   - 硬上限**首次**触达（`capped` 且还没为它提醒过）→ 放行，让兜底提醒一定送得出去；
 *   - 否则要求 R 越过"下一个还没提醒过的门槛"：`R ≥ 2^rTier`；
 *   - 参数非法（`invalid`）时 R 不参与判定，只可能由硬上限放行。
 *
 * @param {object} book - `reminders.r`。
 * @param {object|undefined} ratio - `handoffRatio()` 的产物。
 * @returns {boolean}
 */
function ratioReminderAllowed(book, ratio) {
  if (ratio === undefined || ratio === null) return false;
  if (ratio.capped === true && book.capAlerted !== true) return true;
  if (ratio.invalid === true) return false;
  return ratio.R >= ratioTier(book);
}

/** 下一个门槛：`2^rTier`（层级缺失时按第 0 层算，即 R ≥ 1）。 */
function ratioTier(book) {
  const tier = typeof book.rTier === 'number' && Number.isFinite(book.rTier) && book.rTier > 0 ? book.rTier : 0;
  return 2 ** Math.min(tier, RATIO_TIER_MAX);
}

/**
 * 从本次命中的信号里挑出**唯一**要提醒的那条。
 *
 * 规则（见 README）：先过冷却（同一信号提醒过后至少隔 `cooldownCalls` 次该会话的工具调用）；
 * R 再过 `ratioReminderAllowed` 的门槛；再比级别——R 恒为第 3 级，
 * "同时有 ≥2 个信号处于触发状态"时也是第 3 级；其余情况首次触发是第 1 级、
 * 之后再触发是第 2 级；级别相同时按 r → s1 的顺序取。
 *
 * @param {{signals: object, reminders: object}} entry - `createSessionSignals()` 的产物。
 * @param {object[]} hits - `observeCall` 的产物。
 * @param {object} settings - 解析后的配置。
 * @returns {{hit: object, level: number}|null}
 */
export function chooseReminder(entry, hits, settings) {
  const { signals, reminders } = entry;
  const candidates = [];
  for (const hit of hits) {
    const book = reminders[hit.signal];
    if (book === undefined) continue;
    if (book.alerts > 0 && signals.calls - book.lastCall < settings.cooldownCalls) continue;
    if (hit.signal === 'r' && !ratioReminderAllowed(book, hit.ratio)) continue;
    // S6 触发期间压住 S4：两条判据嵌套（都没推进），S4 只会把同一件事再说一遍。
    if (hit.signal === 's4' && roaming(signals, settings)) continue;
    const level = hit.signal === 'r' || triggeredCount(signals, settings) >= 2
      ? 3
      : (book.alerts === 0 ? 1 : 2);
    candidates.push({ hit, level });
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.level - left.level
    || SIGNAL_PRIORITY.indexOf(left.hit.signal) - SIGNAL_PRIORITY.indexOf(right.hit.signal));
  return candidates[0];
}

/** 记下一条信号提醒（写日志 + 簿记），返回可直接投递的记录。 */
function noteReminder(state, entry, chosen) {
  const book = entry.reminders[chosen.hit.signal];
  const alert = {
    ...chosen.hit,
    type: chosen.hit.signal,
    level: chosen.level,
    fact: signalText(chosen.hit),
    at: Date.now(),
  };
  book.alerts += 1;
  book.lastCall = entry.signals.calls;
  if (chosen.hit.signal === 'r') noteRatioBook(book, chosen.hit.ratio);
  recordSignalAlert(state, alert);
  return { alert, level: chosen.level };
}

/**
 * R 的簿记：硬上限只提醒一次；门槛层级按"这次提醒时的 R 越过了几层"推进。
 *
 * R 一次跳很多时（例如从 1 直接到 8），中间那几层一并算作已经提醒过，
 * 免得同一段上下文里连续追着提醒；而**纯硬上限提醒**（R < 1）不推进层级。
 *
 * @param {object} book - `reminders.r`。
 * @param {object|undefined} ratio - 本次提醒携带的 R 构成。
 */
function noteRatioBook(book, ratio) {
  if (ratio === undefined || ratio === null) return;
  if (ratio.capped === true) book.capAlerted = true;
  let tier = typeof book.rTier === 'number' && Number.isFinite(book.rTier) && book.rTier > 0 ? book.rTier : 0;
  while (tier < RATIO_TIER_MAX && ratio.R >= 2 ** tier) tier += 1;
  book.rTier = tier;
}

/** 取（或初始化）某个会话自己的信号状态；子智能体与主会话互不干扰。 */
function sessionSignalOf(state, session) {
  let entry = state.bySession.get(session);
  if (entry === undefined) {
    entry = createSessionSignals();
    state.bySession.set(session, entry);
  }
  return entry;
}

/**
 * 从一次成功的 `todo_write` 里取出计数；只数状态，不保存条目正文。
 *
 * 优先用工具结果里的 `value.todos`（工具执行后的规范清单），拿不到时退回入参
 * `arguments.todos`。两者都不是数组、或状态不认识时返回 undefined（保持上一次快照）。
 *
 * @param {unknown} args - 工具入参。
 * @param {unknown} result - 工具结果。
 * @returns {{completed: number, pending: number, inProgress: number}|undefined}
 */
export function readTodoSnapshot(args, result) {
  const list = result?.value?.todos ?? args?.todos;
  if (!Array.isArray(list)) return undefined;
  let completed = 0;
  let pending = 0;
  let inProgress = 0;
  for (const item of list) {
    const status = item?.status;
    if (status === 'completed') completed += 1;
    else if (status === 'in_progress') inProgress += 1;
    else if (status === 'pending') pending += 1;
  }
  return { completed, pending, inProgress };
}

/**
 * 处理一次工具调用的信号观察与投递决策。
 *
 * 会话归属的两条规则都在这里：
 *   1. 每个会话有自己的信号计数（M1–M3 互不干扰），**R 只统计主会话自己的调用**——
 *      子智能体的 R 命中在这里就被丢掉，既不记账也不投递；
 *   2. 第 3 级只追加到主会话：子智能体触发的第 3 级先挂到 `state.pendingMain`，
 *      等主会话的下一次工具结果再投递（挂起的第一条不被后来的覆盖），投递时改用
 *      `forwardReminderText` 的第 2 级文案并写明是哪个子智能体在打转。
 *
 * @param {object} state - 会话树的检查状态。
 * @param {{session: object, isMain: boolean, tool: string, args: unknown, result: unknown,
 *   cwd?: string, checkedSteps?: number, uncheckedSteps?: number, planComplete?: boolean,
 *   todo?: object, wrote?: boolean, contextTokens?: number, agentId?: string}} call
 * @param {object} settings - 解析后的配置。
 * @returns {{alert: object, level: number, agentId?: string}|null} 要追加到这次工具结果的提醒。
 */
export function trackCall(state, call, settings) {
  const entry = sessionSignalOf(state, call.session);
  const todo = call.todo !== undefined ? call.todo : entry.todo;
  if (call.todo !== undefined) {
    entry.todo = call.todo;
    entry.todoIdle = 0;
  } else if (entry.todo !== undefined) {
    entry.todoIdle = (entry.todoIdle ?? 0) + 1;
  }
  // 有 PLAN.md 可用时，太久没更新的 todo 快照不再采信（回退 PLAN）；
  // 没有 PLAN.md 时 todo 是唯一进度源，不因“旧”丢掉。
  const staleAfter = typeof settings?.todoStaleCalls === 'number' ? settings.todoStaleCalls : 30;
  const planAvailable = call.checkedSteps !== undefined || call.planComplete === true;
  const todoUsable = entry.todo !== undefined
    && !(planAvailable && (entry.todoIdle ?? 0) > staleAfter);
  const hits = observeCall(entry.signals, {
    tool: call.tool,
    args: call.args,
    result: call.result,
    cwd: call.cwd,
    checkedSteps: call.checkedSteps,
    uncheckedSteps: call.uncheckedSteps,
    planComplete: call.planComplete,
    todo,
    todoUsable,
    wrote: call.wrote,
    contextTokens: call.contextTokens,
    state,
  }, settings).filter((hit) => call.isMain || hit.signal !== 'r');
  // R 是"主会话该不该交接"的判据：只把主会话自己那份构成交给 /drift 展示。
  if (call.isMain) state.ratio = entry.signals.ratio;

  const chosen = chooseReminder(entry, hits, settings);
  let picked = chosen === null ? null : noteReminder(state, entry, chosen);

  if (picked !== null && !call.isMain && picked.level >= 3) {
    // 转交时带上触发者 id：投递的文案要说清是哪个子智能体在打转。
    if ((state.pendingMain ?? null) === null) state.pendingMain = { ...picked, agentId: call.agentId };
    picked = null;
  }
  const pending = call.isMain ? state.pendingMain ?? null : null;
  if (pending !== null) {
    // 主会话的这一次机会：挂起的第 3 级比本次低级别的高；同为第 3 级时以刚发生的为准。
    if (picked === null || pending.level > picked.level) picked = pending;
    state.pendingMain = null;
  }
  return picked;
}

/**
 * 交接完成的后续记账：判定依据（写入 PROGRESS.md 或指纹变化）+ 把 R 的再提醒门槛推到下一层。
 *
 * @param {object} state - 会话状态。
 * @param {'write'|'fingerprint'} via - 判定依据。
 */
function markHandoffDone(state, via) {
  const already = state.handoff?.completed === true;
  state.handoff = { ...(state.handoff ?? {}), completed: true, completedAt: Date.now(), via };
  if (already) return;
  const book = state.bySession.get(state.root)?.reminders?.r;
  if (book === undefined) return;
  const ratio = typeof state.ratio?.R === 'number' && Number.isFinite(state.ratio.R) ? state.ratio.R : 1;
  const tier = Math.max(2, Math.floor(Math.log2(Math.max(ratio, 1))) + 1);
  const current = typeof book.rTier === 'number' && Number.isFinite(book.rTier) ? book.rTier : 0;
  book.rTier = Math.min(RATIO_TIER_MAX, Math.max(current, tier));
}

/** PROGRESS.md 的指纹（mtime+size）；文件不存在时返回 undefined。 */
function progressStamp(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined;
  const stamp = fileStamp(resolvePath('PROGRESS.md', cwd));
  return stamp === undefined ? undefined : `${stamp.mtimeMs}:${stamp.size}`;
}

/** 这次调用的写入目标是不是 `<工作区>/PROGRESS.md`（Windows 路径大小写不敏感）。 */
function wroteProgress(args, cwd) {
  const target = pathFromArgs(args);
  if (target === undefined || typeof cwd !== 'string' || cwd === '') return false;
  return resolvePath(target, cwd).toLowerCase() === resolvePath('PROGRESS.md', cwd).toLowerCase();
}

/**
 * 交接完成判定：主判据是"成功写了 PROGRESS.md"，补充判据是它的指纹变了
 * （覆盖经 ops_bash/pwsh 写入与用户手改；代价是每轮一次 stat，误判方向是"多算完成"）。
 *
 * @param {object} state - 会话状态。
 * @param {{name: string, arguments: unknown}} exec - 工具调用。
 * @param {object} result - 工具结果。
 * @param {boolean} wrote - 本次是否成功写了文件。
 * @returns {string|undefined} 本次的 PROGRESS.md 指纹（给第 3 级记账用）。
 */
export function noteHandoff(state, exec, result, wrote) {
  const stamp = progressStamp(state.cwd);
  if (state.handoff !== null && typeof state.handoff?.at === 'number'
    && state.handoff.completed !== true) {
    if (wrote && wroteProgress(exec.arguments, state.cwd)) markHandoffDone(state, 'write');
    else if (stamp !== state.handoff.progressStamp) markHandoffDone(state, 'fingerprint');
  }
  return stamp;
}

/**
 * 把一次提醒落成"追加到工具结果末尾 + 第 3 级的用户可见通知"。
 *
 * @param {{alert: object, level: number, agentId?: string}} reminder - `trackCall()` 的产物。
 * @param {object|undefined} downstream - 下游返回的结果对象（可能为 undefined）。
 * @param {{content?: unknown}} result - 工具原始结果（追加时不改它的原文）。
 * @param {{appendTemplate?: boolean}} [options] - 是否随通知带上交接模板。
 * @returns {{downstream: object|undefined, appended: boolean}}
 */
export function deliverReminder(reminder, downstream, result, options = {}) {
  const text = reminder.agentId === undefined
    ? reminderText(reminder.level, SIGNAL_NAME[reminder.alert.type], reminder.alert.fact)
    : forwardReminderText(reminder.alert, reminder.agentId);
  // A：第 3 级额外发一条模型可见的合成消息。
  // 交接模板挂在这条消息上，而不是工具结果里——它是指令，贴着文件内容会被当成提示注入。
  // 界面不渲染这类消息（0.2.0-rc.2 实测），见 README 已知限制。
  const noticeText = `[drift-guard] 建议交接：${reminder.alert.fact}\n`
    + '请在本轮回复里明确告诉用户"建议现在交接"；等用户回复后，再按下面的模板更新 PROGRESS.md。';
  const notice = reminder.level === 3 && reminder.agentId === undefined
    ? noticeMessage(options.appendTemplate === true ? `${noticeText}\n\n${HANDOFF_TEMPLATE}` : noticeText, '交接提醒')
    : null;
  const contexts = notice === null
    ? undefined
    : [notice, ...(Array.isArray(downstream?.additionalContexts) ? downstream.additionalContexts : [])];
  const content = appendTarget(downstream, result?.content, text);
  // 结果已被 block、下游替换了 value、或 content 不是数组：只记日志，但通知仍要发。
  if (content === null) {
    return { downstream: contexts === undefined ? downstream : { ...downstream, additionalContexts: contexts }, appended: false };
  }
  return {
    downstream: { ...downstream, content, ...(contexts === undefined ? {} : { additionalContexts: contexts }) },
    appended: true,
  };
}
