/**
 * drift-guard 提醒：分级文案、日志行、去重记录、/drift 报告。
 *
 * v0.1 的三条文案与去重规则**原样保留**（没有级别字段时行为不变）；v0.2 增加：
 *   - 信号提醒的级别（第 1/2/3 级）与对应建议；
 *   - "只追加、不改原文"的追加助手 `appendReminder` / `appendTarget`；
 *   - 带级别的日志行、信号提醒记录 `recordSignalAlert`、工作区外读取的记录行 `outside-read`；
 *   - 子智能体的第 3 级转交主会话时的文案 `forwardReminderText`。
 *
 * @module dsh-drift-guard/alerts
 */

import fs from 'node:fs';
import path from 'node:path';

/** 提醒日志目录（相对工作区根目录）。 */
export const ALERT_DIR = '.drift';
/** 提醒日志文件名。 */
export const ALERT_LOG = 'alerts.log';

/** 各信号在提醒与日志里的名字。 */
export const SIGNAL_NAME = {
  s1: 'S1 同参同结果打转',
  s2: 'S2 两组调用交替',
  s3: 'S3 重复读取',
  s4: 'S4 计划停滞',
  r: 'R 交接收益比',
};

/** 每个级别对应的建议动作。 */
export const LEVEL_ADVICE = {
  1: '重新阅读 PLAN.md 和用户原始要求，确认方向后继续。',
  2: '停下来向用户汇报：已尝试什么、卡在哪、新方案，等待用户决定。',
  3: '完成当前步骤后，按交接流程写 PROGRESS.md 并提醒用户开新会话。',
};

/** 级别标签；没有级别时给空串（v0.1 的提醒不带级别）。 */
export function levelTag(level) {
  return typeof level === 'number' ? `第${level}级` : '';
}

/**
 * 追加到工具结果末尾的那段文本。
 *
 * @param {number} level - 1/2/3。
 * @param {string} signalName - 信号名，例如 `S3 重复读取`。
 * @param {string} fact - 一句话事实。
 */
export function reminderText(level, signalName, fact) {
  return [
    '---',
    `[drift-guard ${levelTag(level)}] ${signalName}：${fact}`,
    `建议：${LEVEL_ADVICE[level] ?? LEVEL_ADVICE[1]}`,
  ].join('\n');
}

/**
 * 把提醒块追加到内容块数组的末尾：**新建数组、复用原块**，不改动传进来的数组与对象。
 *
 * @param {unknown} content - 工具结果的 content。
 * @param {string} text - 提醒文本。
 * @returns {object[]|null} 新的内容块数组；`content` 不是数组时返回 null（调用方只记日志）。
 */
export function appendReminder(content, text) {
  if (!Array.isArray(content)) return null;
  return [...content, { type: 'text', text }];
}

/**
 * 决定这次工具结果能不能追加提醒，能就返回新的 content。
 *
 * 以下情况一律返回 null（调用方只记日志、不改结果）：
 *   - 下游把结果判成了 `block`（不是 accept）；
 *   - 下游替换了 `value`（宿主不允许同时再给 content，给了会抛错）；
 *   - 结果的内容块不是数组（结构不符预期）。
 *
 * @param {{kind?: string, content?: unknown, value?: unknown}|undefined} downstream - 下游的决策。
 * @param {unknown} originalContent - 本次工具结果原本的 content。
 * @param {string} text - 提醒文本。
 * @returns {object[]|null}
 */
export function appendTarget(downstream, originalContent, text) {
  if (downstream === undefined || downstream === null || downstream.kind !== 'accept') return null;
  if (Object.hasOwn(downstream, 'value')) return null;
  const base = Object.hasOwn(downstream, 'content') ? downstream.content : originalContent;
  return appendReminder(base, text);
}

/**
 * 子智能体触发的第 3 级要转交给主会话时用的那段文本。
 *
 * 第 3 级的建议是"写 PROGRESS.md、提醒用户开新会话"——那是针对**自己**打转的主体说的；
 * 子智能体的提醒只能追加到主会话的工具结果上，让主会话去"开新会话"没有意义。
 * 所以转交时改成第 2 级的说法，并把主体写明是哪个子智能体：主会话据此决定中止还是重新分派。
 *
 * @param {object} alert - 带 `fact` 的提醒。
 * @param {string} [agentId] - 触发该提醒的子智能体 id。
 */
export function forwardReminderText(alert, agentId) {
  const who = agentId === undefined || agentId === '' ? '某个子智能体（未记录 id）' : `子智能体 ${agentId} `;
  return [
    '---',
    `[drift-guard 第2级] ${who}可能在打转：${alert.fact}`,
    `建议：${LEVEL_ADVICE[2]}`,
  ].join('\n');
}

/** 提醒的去重键。 */
export function alertKey(alert) {
  return `${alert.type}\0${alert.tool ?? ''}\0${alert.target ?? ''}`;
}

/** 记录到日志、并在 /drift 里显示的一行。 */
export function alertLine(alert) {
  const time = new Date(alert.at).toISOString();
  switch (alert.type) {
    case 'outside':
      return `[drift-guard] ${time} 拦截工作区外写入：tool=${alert.tool} 目标=${alert.target} 工作区=${alert.workspace}`;
    case 'unapproved':
      return `[drift-guard] ${time} 越界写入提醒：tool=${alert.tool} 文件=${alert.relative}（不在 PLAN.md 已批准阶段的清单里）`;
    case 'outside-read':
      return `[drift-guard] ${time} 工作区外读取记录：tool=${alert.tool} 目标=${alert.target}（只记录，未拦截）`;
    case 'sensitive-read':
      return `[drift-guard] ${time} 拦截敏感文件读取：tool=${alert.tool} 目标=${alert.target}`;
    case 'repeat':
      return `[drift-guard] ${time} 打转提醒：tool=${alert.tool} 签名=${alert.signature} 连续失败=${alert.count} 次`;
    case 's1':
    case 's2':
    case 's3':
    case 's4':
    case 'r':
      return `[drift-guard] ${time} ${levelTag(alert.level)} ${SIGNAL_NAME[alert.type]}：${alert.fact}`;
    default:
      return `[drift-guard] ${time} 未知提醒类型：${String(alert.type)}`;
  }
}

/** 状态词对应的报告文字。 */
export const PLAN_STATUS_TEXT = {
  ok: '计划：已解析 PLAN.md，规则 1 生效。',
  unparsed: '计划：有 PLAN.md，但格式不符；规则 1 不生效，规则 2–5 仍生效。',
  absent: '计划：工作区内没有 PLAN.md；规则 1 不生效，规则 2–5 仍生效。',
  'no-fs': '计划：宿主没有挂载文件系统服务，无法读取 PLAN.md；规则 1 不生效。',
  'no-cwd': '计划：会话没有记录工作目录，无法判断工作区；规则 2–5 仍生效。',
};

/** `missing` 里每个标记对应的说明。 */
const MISSING_TEXT = {
  'active-phase': '标题含「已批准」或「进行中」的阶段',
  'list-item': '该阶段下至少一条列表项',
  path: '列表项里至少一个工作区相对路径',
};

/**
 * 计划状态那一行的文案：把"没有 PLAN.md""有但缺标记""有且已全部完成"分开说。
 *
 * 全部完成不归到"格式不符"：文件本身合法，只是没有当前执行范围；否则收尾后的项目
 * 会被报成格式错误，读起来像是计划写坏了。
 *
 * @param {object|undefined} plan - `inspectPlan()` 的产物。
 * @returns {string}
 */
function planStatusText(plan) {
  if (plan?.status === 'unparsed') {
    // "全部完成"只适用于确实没有活动阶段的文件；如果活动阶段还在、只是缺路径，
    // 说"没有已批准/进行中阶段"就是假话，仍按缺标记报。
    if (plan.planComplete === true && plan.missing?.[0] === 'active-phase') {
      return '计划：有 PLAN.md，计划已全部完成（没有「已批准/进行中」阶段）；当前无执行范围，规则 1 不生效，规则 2–5 仍生效。';
    }
    const missing = Array.isArray(plan.missing) && plan.missing.length > 0
      ? plan.missing.map((key) => MISSING_TEXT[key] ?? key).join('、')
      : '可用于判定的标记';
    return `计划：有 PLAN.md，但格式不符（缺少：${missing}）；规则 1 不生效，规则 2–5 仍生效。`;
  }
  return PLAN_STATUS_TEXT[plan?.status] ?? PLAN_STATUS_TEXT.absent;
}

/** 数字展示：非有限数一律写 0，避免报告里出现 NaN。 */
function num(value, digits = 0) {
  return (typeof value === 'number' && Number.isFinite(value) ? value : 0).toFixed(digits);
}

/** N 的来源说明。 */
const N_SOURCE_TEXT = {
  plan: '按 PLAN.md 未打勾项数外推',
  default: '没有可用计划，取默认值',
  invalid: '参数非法，未计算',
};

/** D 的构成说明：逐个列出仍在打转的信号分量。 */
function dDetail(ratio) {
  const parts = [];
  for (const [key, delta] of Object.entries(ratio.deltas ?? {})) {
    const weight = ratio.weights?.[key] ?? 0;
    parts.push(`${key.toUpperCase()} Δ=${num(delta)} × ${num(weight, 2)}`);
  }
  return parts.length === 0 ? '没有信号在打转' : parts.join('、');
}

/**
 * `/drift` 里的交接收益比段：给出每一项取值，而不是只报一个数。
 *
 * @param {object|null|undefined} ratio - 最近一次算出的 R 构成。
 * @param {object} [book] - `reminders.r`，用来算"再提醒门槛"。
 * @returns {string[]} 报告行。
 */
export function ratioReport(ratio, book) {
  if (ratio === null || ratio === undefined) {
    return ['交接收益比 R：本会话还没有工具调用，暂无数据。'];
  }
  const lines = [];
  if (ratio.invalid === true) {
    lines.push(`交接收益比 R：参数非法（${ratio.reason}），R 的判定按"不触发"处理。`);
  } else {
    lines.push(`交接收益比 R ≈ ${num(ratio.R, 2)}${ratio.R >= 1 ? '（R ≥ 1，已到交接条件）' : '（R < 1，未到交接条件）'}`);
  }
  lines.push(`  上下文 C ≈ ${num(ratio.C)} token${ratio.estimated ? `（读不到 tokenMeter，按 ${num(ratio.calls)} 次调用 × ${num(ratio.tokensPerCall)} 估算）` : '（来自 tokenMeter）'}／基线 C₀ = ${num(ratio.C0)}`);
  lines.push(`  剩余工作量 N = ${num(ratio.N)}（${N_SOURCE_TEXT[ratio.nSource] ?? '来源未知'}）`);
  lines.push(`  偏离强度 D = ${num(ratio.D, 2)}（${dDetail(ratio)}）`);
  lines.push(`  参数 r = ${num(ratio.r, 2)}、L = ${num(ratio.L)}、H = ${num(ratio.H)}；硬上限 ${num(ratio.capTokens)} token（${ratio.capped ? '已触达' : '未触达'}）`);
  if (book !== undefined && book !== null) {
    const pending = [];
    if (book.capAlerted === true) pending.push('硬上限已单独提醒过');
    else if (ratio.capped === true) pending.push('硬上限还没提醒过，下一次调用就会补上这条');
    const need = 2 ** (typeof book.rTier === 'number' && book.rTier > 0 ? Math.min(book.rTier, 53) : 0);
    pending.push(need <= 1
      ? 'R 的判定还没提醒过，R ≥ 1 就提醒'
      : `下次要 R ≥ ${num(need)}（固定倍增门槛：1 → 2 → 4 → 8…）`);
    lines.push(`  再提醒门槛：${pending.join('；')}`);
  }
  return lines;
}

/**
 * /drift 的完整报告文本。
 *
 * @param {object} state - 会话状态。
 * @param {object} [ratioBook] - 主会话的 `reminders.r`，有就顺带报出"再提醒门槛"。
 */
export function formatDriftReport(state, ratioBook) {
  const lines = ['[drift-guard] 提醒列表'];
  lines.push(planStatusText(state.plan));
  if (state.plan?.status === 'ok') {
    lines.push(`已批准清单（${state.plan.approved.length} 条）：${state.plan.approved.map((entry) => entry.status).join('、')}`);
  }
  if (state.logBroken) lines.push(`注意：无法写入提醒日志（${ALERT_DIR}/${ALERT_LOG}）。`);
  lines.push('');
  lines.push(...ratioReport(state.ratio, ratioBook));

  const fresh = state.alerts.filter((alert) => alert.at > state.lastSeen).length;
  state.lastSeen = Date.now();

  if (state.alerts.length === 0) {
    lines.push('暂无提醒。');
    return lines.join('\n');
  }
  lines.push(`共 ${state.alerts.length} 条提醒，其中 ${fresh} 条是上次 /drift 之后新增的：`);
  lines.push('');
  for (const alert of state.alerts) lines.push(`· ${alertLine(alert)}`);
  lines.push('');
  lines.push('被拦截的调用没有执行，也没有计入"打转"计数。');
  return lines.join('\n');
}

/** 追加一行到工作区内的提醒日志；写不进去只记一次原因，绝不影响主会话。 */
export function appendLog(state, line) {
  try {
    const dir = path.join(state.cwd, ALERT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, ALERT_LOG), `${line}\n`, 'utf8');
  } catch {
    state.logBroken = true;
  }
}

/** 记录一条提醒：按"类型 + 工具 + 目标"去重，写日志，并留在内存里等 /drift 读取。 */
export function record(state, alert) {
  const key = alertKey(alert);
  if (state.seen.has(key)) return null;
  state.seen.add(key);
  state.alerts.push(alert);
  appendLog(state, alertLine(alert));
  return alert;
}

/** 信号提醒的去重键：同一信号、同一计数、同一对象只记一条。 */
function signalAlertKey(alert) {
  return `signal\0${alert.type}\0${alert.count}\0${alert.tool ?? ''}\0${alert.path ?? ''}`;
}

/**
 * 记录一条信号提醒（带级别）：写日志并留在内存里等 /drift 读取。
 *
 * @param {object} state - 会话状态。
 * @param {object} alert - 带 `type`/`level`/`fact` 的提醒。
 * @returns {object|null} 真正记下的提醒；重复的返回 null。
 */
export function recordSignalAlert(state, alert) {
  const key = signalAlertKey(alert);
  if (state.seen.has(key)) return null;
  state.seen.add(key);
  state.alerts.push(alert);
  appendLog(state, alertLine(alert));
  return alert;
}
