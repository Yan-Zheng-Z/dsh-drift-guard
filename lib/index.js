/**
 * drift-guard：确定性偏离检查（插件入口）。
 *
 * 做这些事，全部不调用 LLM、不解析 shell 路径、不打断主会话：
 *   规则 1（提醒）写入/编辑/删除的文件不在 PLAN.md 当前已批准阶段清单里 → 记录提醒。
 *   规则 2（拦截）目标路径在会话工作区之外 → deny，工具体不执行，并把原因交给模型。
 *   规则 3（提醒）同一工具、相同参数连续失败达到阈值 → 记录提醒（阈值可配置）。
 *   规则 4（拦截）读取类工具命中敏感名单（凭据/密钥类）→ deny，不读内容（工作区内、外一视同仁）。
 *   规则 5（提醒）读取工作区外的不敏感文件 → 只记一条 outside-read，不拦截、不注入模型。
 *   S1–S4（打转与停滞信号）与交接收益比 R → 记录到 .drift/alerts.log 与 /drift，并按级别把提醒
 *   **追加到工具结果末尾**告诉模型（只追加、不改原文；见 `appendTarget`）。
 *
 * PLAN.md 无法解析出任何"已批准/进行中"阶段时规则 1 不生效，并在 /drift 里明确显示原因。
 * 被规则 2 拦截的调用不计入规则 3。
 *
 * 模块划分：路径判定 lib/paths.js，PLAN.md 解析 lib/plan.js，提醒文案与日志 lib/alerts.js，
 * 配置 lib/config.js，检测信号 lib/signals.js，敏感读取判定 lib/sensitive.js；
 * v0.1 导出的纯函数继续从这里 re-export。
 *
 * @module dsh-drift-guard
 */

import {
  PATH_ARG_KEYS,
  pathFromArgs,
  asRecord,
  slashes,
  resolvePath,
  isOutsideWorkspace,
  relativePath,
  isApproved,
  classifyWrite,
} from './paths.js';
import {
  ALERT_DIR,
  ALERT_LOG,
  SIGNAL_NAME,
  LEVEL_ADVICE,
  levelTag,
  reminderText,
  forwardReminderText,
  appendReminder,
  appendTarget,
  alertLine,
  formatDriftReport,
  ratioReport,
  record,
  recordSignalAlert,
  appendLog,
} from './alerts.js';
import {
  DEFAULTS,
  DEFAULT_SENSITIVE,
  DEFAULT_SENSITIVE_ALLOW,
  Config,
  resolveConfig,
} from './config.js';
import {
  PLAN_FILE,
  PLAN_SEARCH_DEPTH,
  parsePlan,
  countCheckedSteps,
  countUncheckedSteps,
  inspectPlan,
} from './plan.js';
import {
  REPEAT_THRESHOLD,
  READ_FILE_TOOLS,
  createSignalState,
  failureDecision,
  observeCall,
  handoffRatio,
  deviationDeltas,
  signalText,
  chainSignature,
  hashResult,
  fileStamp,
} from './signals.js';
import {
  SENSITIVE_READ_TOOLS,
  PATTERN_TOOLS,
  EXAMPLE_EXEMPT,
  patternStaticPrefix,
  isSensitiveRead,
  classifyRead,
  displayTarget,
} from './sensitive.js';

/** 带路径参数、可能改动文件的工具名（小写比较）。 */
export const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'ops_replace']);

/** 信号名 → 配置里的阈值键（R 没有阈值键，靠 `handoffRatio` 参数组判定）。 */
const SIGNAL_THRESHOLD = {
  s1: 's1Repeats',
  s2: 's2Alternations',
  s3: 's3Reads',
  s4: 's4IdleCalls',
};

/** 级别相同时的取舍顺序。 */
const SIGNAL_PRIORITY = ['r', 's4', 's3', 's2', 's1'];

/** 按会话对象存放状态；会话消失后由 GC 回收。 */
const STATE = new WeakMap();

/**
 * 取一次工具执行所属的会话与工作区。
 * 会话身份用最上层的根会话（状态按它共享）；工作区优先用当前会话自己记录的 cwd，
 * 没有时回溯到父会话——子智能体可能不记 cwd，但它和父会话在同一工作区。
 *
 * 两种调用形态都支持：宿主给"带 session 的执行体"（`{agent: {session}}`），
 * 或直接给会话本身（`{agent: session}`，`/drift` 命令的 invocation 就是这一类——
 * 会话对象上有 `header`，没有 `session`）。
 */
function sessionOf(exec) {
  const agent = exec?.agent;
  if (agent === undefined) return { session: undefined, cwd: undefined };
  const direct = agent.session;
  const isSession = typeof direct !== 'object' && typeof agent.header === 'object' && agent.header !== null;
  let session = typeof direct === 'object' && direct !== null ? direct : (isSession ? agent : undefined);
  if (session === undefined) return { session: undefined, cwd: undefined };
  let cwd = typeof session.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : undefined;
  while (session.parent !== undefined) {
    session = session.parent;
    if (cwd === undefined && typeof session.header?.cwd === 'string' && session.header.cwd !== '') {
      cwd = session.header.cwd;
    }
  }
  if (cwd === undefined && typeof session.header?.cwd === 'string' && session.header.cwd !== '') {
    cwd = session.header.cwd;
  }
  return { session, cwd };
}

/** R 的倍增门槛层级上限：2^53 以内都是精确整数，再高就没有意义了。 */
const RATIO_TIER_MAX = 53;

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
  return { signals: createSignalState(), reminders: createReminderBook() };
}

/** 当前"触发状态仍然成立"的信号数（条件没被重置且已到阈值；R 单独按第 3 级处理）。 */
function triggeredCount(signals, settings) {
  let count = 0;
  for (const name of SIGNAL_PRIORITY) {
    if (name === 'r') continue;
    const record_ = signals[name];
    if (record_ !== undefined && record_.count >= settings[SIGNAL_THRESHOLD[name]]) count += 1;
  }
  return count;
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
 * 处理一次工具调用的信号观察与投递决策。
 *
 * 会话归属的两条规则都在这里：
 *   1. 每个会话有自己的信号计数（S1–S4 互不干扰），**R 只统计主会话自己的调用**——
 *      子智能体的 R 命中在这里就被丢掉，既不记账也不投递；
 *   2. 第 3 级只追加到主会话：子智能体触发的第 3 级先挂到 `state.pendingMain`，
 *      等主会话的下一次工具结果再投递（挂起的第一条不被后来的覆盖），投递时改用
 *      `forwardReminderText` 的第 2 级文案并写明是哪个子智能体在打转。
 *
 * @param {object} state - 会话树的检查状态。
 * @param {{session: object, isMain: boolean, tool: string, args: unknown, result: unknown,
 *   cwd?: string, checkedSteps?: number, uncheckedSteps?: number, contextTokens?: number,
 *   agentId?: string}} call
 *   - 本次调用（宿主相关的东西都由调用方传进来）；`contextTokens` 是主会话的上下文 token
 *   （估算值），取不到时留 undefined，R 走回退估算；`checkedSteps`/`uncheckedSteps` 是
 *   PLAN.md 的步数，来自 `inspectPlan`。
 * @param {object} settings - 解析后的配置。
 * @returns {{alert: object, level: number, agentId?: string}|null} 要追加到这次工具结果的提醒。
 */
export function trackCall(state, call, settings) {
  const entry = sessionSignalOf(state, call.session);
  const hits = observeCall(entry.signals, {
    tool: call.tool,
    args: call.args,
    result: call.result,
    cwd: call.cwd,
    checkedSteps: call.checkedSteps,
    uncheckedSteps: call.uncheckedSteps,
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
 * 取（或初始化）一条会话树的检查状态。
 * @param {object} session - 根会话，作为状态键。
 * @param {string|undefined} cwd - 本次执行解析出的工作区。
 */
function stateOf(session, cwd) {
  let state = STATE.get(session);
  if (state === undefined) {
    state = {
      cwd,
      plan: null,
      planStamp: undefined,
      planFile: undefined,
      repeats: new Map(),
      bySession: new WeakMap(),
      pendingMain: null,
      ratio: null,
      alerts: [],
      seen: new Set(),
      lastSeen: 0,
      logBroken: false,
      internalNoted: false,
    };
    STATE.set(session, state);
  } else if (state.cwd === undefined && cwd !== undefined) {
    state.cwd = cwd;
  }
  return state;
}

/**
 * 插件内部异常：只记一条日志，然后放行。
 *
 * 工具管线里的监听器抛异常会把成功的结果变成 isError（宿主的行为），
 * 所以插件内部任何一步出错都必须在这里被吞掉，绝不能影响工具执行。
 */
function noteInternal(state, where, error) {
  if (state.internalNoted === true) return;
  state.internalNoted = true;
  appendLog(state, `[drift-guard] 内部错误（${where}）：${error instanceof Error ? error.message : String(error)}`);
}

/** 规则 2 拦截时返回给模型的话。 */
function blockReason(target, cwd) {
  return `[drift-guard] 已拦截：目标路径 ${target} 在会话工作区（${cwd}）之外，未执行写入。`
    + '这是 drift-guard 插件的规则检查，不是用户的批准或拒绝。'
    + '请只在工作区内操作；确实需要访问该路径时，先向用户明确申请并获得单独同意。';
}

/**
 * 规则 5 用的目标路径：读取类工具**实际会碰到的那个路径**。
 *
 * 读文件工具（`read`、`ops_inspect_local_file`）取 `file_path`/`path`；搜索工具（`grep`、`ops_grep`）
 * 的目标目录在 `path` 字段，没写时返回会话工作区（等价于在工作区里搜索，不算工作区外）。
 * `grep` 的 `pattern` 是正则、`glob` 的相对 `pattern` 是搜索模式，都不当路径用；
 * 只有 `glob`/`ops_glob` 的**绝对 pattern** 会被当作一条"工作区外读取"记下来。
 *
 * @param {unknown} args - 工具入参。
 * @param {string} tool - 工具名。
 * @param {string|undefined} cwd - 会话工作区。
 * @returns {{target: string, display: string}|undefined} 没有可判定的路径时返回 undefined。
 */
function readTarget(args, tool, cwd) {
  const record = asRecord(args);
  if (record === undefined) return undefined;
  // `glob`/`ops_glob` 的 `pattern` 是模式、不是路径：`pathFromArgs` 的兜底会把 pattern
  // 当路径取出来，所以这里先单独处理，只看显式的路径字段与模式里的字面前缀。
  if (PATTERN_TOOLS.has(String(tool).toLowerCase())) {
    for (const key of ['file_path', 'path']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return { target: value.trim(), display: value.trim() };
    }
    const pattern = record.pattern;
    const prefix = patternStaticPrefix(pattern);
    if (prefix === undefined || typeof cwd !== 'string' || cwd === '') return undefined;
    return { target: prefix, display: String(pattern).trim() };
  }
  const path = pathFromArgs(args);
  if (path !== undefined) return { target: path, display: path };
  // 搜索工具允许不带 path（= 在工作区里搜索），这时不算工作区外。
  return typeof cwd === 'string' && cwd !== '' ? { target: '.', display: '.' } : undefined;
}

/**
 * 读一次主会话的上下文 token 数（估算值）。
 *
 * `ctx.tokenMeter` 是宿主服务，插件用 `inject` 声明了它，正常挂载时一定有；
 * 拿不到或抛异常时返回 undefined，交接收益比 R 会自动按"调用次数 × 每次估算 token"折算。
 * 这里出错只写一条日志（状态要由调用方给），绝不影响工具结果。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} session - 根会话。
 * @param {object} state - 会话状态（写日志用）。
 */
async function measureContextTokens(ctx, session, state) {
  try {
    const measurement = await ctx.tokenMeter.measure(session);
    const total = measurement?.totalTokens;
    return typeof total === 'number' && Number.isFinite(total) ? total : undefined;
  } catch (error) {
    appendLog(state, `[drift-guard] 内部错误（tokenMeter）：${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

/** 规则 4 拦截时返回给模型的话。 */
function blockReadReason(target, cwd) {
  return `[drift-guard] 已拦截：目标路径 ${target} 命中敏感名单（凭据/密钥类文件），未读取内容。`
    + `当前会话工作区：${cwd}。`
    + '这是 drift-guard 插件的规则检查，不是用户的批准或拒绝。'
    + '请不要猜测或绕过：确实需要读取该文件时，先向用户说明用途并取得单独同意，'
    + '由用户本人提供所需信息，或把该路径加入插件配置的放行名单（sensitiveAllow）。';
}

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'drift-guard';
/** 依赖的宿主服务；fs 只用于读 PLAN.md，tokenMeter 只用于算 R 的上下文规模，挂载了才注入。 */
export const inject = ['commands', 'fs', 'tools', 'tokenMeter'];

/** 插件入口：注册两个工具管线监听器与 /drift 命令，随 fiber 一起释放。 */
export function apply(ctx, config) {
  const settings = resolveConfig(config);
  ctx.effect(function* driftGuard() {
    yield ctx.on('tools/pre-execute', async (exec, next) => {
      const { session, cwd } = sessionOf(exec);
      if (session === undefined) return next();
      const state = stateOf(session, cwd);
      const plan = await inspectPlan(ctx, state);

      // 规则 4：读取类工具命中敏感名单 → 拦截（工作区内、外一视同仁）。
      if (SENSITIVE_READ_TOOLS.has(String(exec.name).toLowerCase())) {
        const read = classifyRead({ args: exec.arguments, cwd: state.cwd, settings: { ...settings, tool: exec.name } });
        if (read === null) return next();
        record(state, {
          type: 'sensitive-read',
          at: Date.now(),
          tool: exec.name,
          target: read.target,
          workspace: state.cwd,
        });
        return {
          kind: 'deny',
          reason: blockReadReason(read.target, state.cwd),
          info: { name: 'DriftGuardBlockedError', code: 'DRIFT_GUARD_SENSITIVE_READ' },
        };
      }

      if (!FILE_WRITE_TOOLS.has(String(exec.name).toLowerCase())) return next();
      const verdict = classifyWrite({
        name: exec.name,
        args: exec.arguments,
        cwd: state.cwd,
        approved: plan.status === 'ok' ? plan.approved : null,
        planDir: plan.status === 'ok' ? plan.dir : undefined,
      });
      if (verdict === null) return next();

      if (verdict.kind === 'outside') {
        record(state, {
          type: 'outside',
          at: Date.now(),
          tool: exec.name,
          target: verdict.target,
          workspace: state.cwd,
        });
        return {
          kind: 'deny',
          reason: blockReason(verdict.target, state.cwd),
          info: { name: 'DriftGuardBlockedError', code: 'DRIFT_GUARD_OUTSIDE_WORKSPACE' },
        };
      }

      record(state, {
        type: 'unapproved',
        at: Date.now(),
        tool: exec.name,
        target: verdict.target,
        relative: verdict.relative,
      });
      return next();
    });

    yield ctx.on('tools/post-execute', async (exec, result, next) => {
      const downstream = await next();
      let state;
      let reminder = null;
      try {
        const caller = exec?.agent?.session;
        const { session: root } = sessionOf(exec);
        if (root !== undefined) state = STATE.get(root);
        // 这条会话还没被 pre-execute 建过状态，说明没发生过任何工具调用前的检查；直接放行。
        if (state !== undefined && caller !== undefined) {
          // 规则 3：沿用 v0.1 的共享计数与文案，行为不变。
          const signature = `${exec.name} ${JSON.stringify(exec.arguments ?? null)}`;
          const count = failureDecision(state.repeats, signature, result.isError === true, settings.failureRepeats);
          if (count !== null) {
            record(state, {
              type: 'repeat',
              at: Date.now(),
              tool: exec.name,
              signature,
              count,
            });
          }

          const plan = await inspectPlan(ctx, state);
          // R 的主输入是主会话的上下文 token（估算值）；拿不到时按调用次数估算。
          const contextTokens = caller === root ? await measureContextTokens(ctx, root, state) : undefined;
          reminder = trackCall(state, {
            session: caller,
            isMain: caller === root,
            tool: exec.name,
            args: exec.arguments,
            result,
            cwd: state.cwd,
            checkedSteps: plan.status === 'ok' ? plan.checkedSteps : undefined,
            uncheckedSteps: plan.status === 'ok' ? plan.uncheckedSteps : undefined,
            contextTokens,
            agentId: exec?.agent?.id,
          }, settings);

          // 规则 5：读取工作区外的不敏感文件——只记一条，不拦、不注入。
          if (!result.isError && SENSITIVE_READ_TOOLS.has(String(exec.name).toLowerCase())) {
            const target = readTarget(exec.arguments, exec.name, state.cwd);
            if (target !== undefined && isOutsideWorkspace(target.target, state.cwd)) {
              record(state, {
                type: 'outside-read',
                at: Date.now(),
                tool: exec.name,
                target: displayTarget(target.display, state.cwd),
              });
            }
          }
        }
      } catch (error) {
        if (state !== undefined) noteInternal(state, 'post-execute', error);
        return downstream;
      }
      if (reminder === null) return downstream;
      const text = reminder.agentId === undefined
        ? reminderText(reminder.level, SIGNAL_NAME[reminder.alert.type], reminder.alert.fact)
        : forwardReminderText(reminder.alert, reminder.agentId);
      const content = appendTarget(downstream, result?.content, text);
      // 结果已被 block、下游替换了 value、或 content 不是数组：只记日志，结果原样返回。
      if (content === null) return downstream;
      return { ...downstream, content };
    });

    yield ctx.commands.register({
      name: 'drift',
      description: '查看 drift-guard 的偏离提醒列表',
      handler: async (invocation) => {
        try {
          const { session, cwd } = sessionOf({ agent: invocation.agent });
          if (session === undefined) return { kind: 'error', text: 'drift-guard：找不到当前会话。' };
          const state = stateOf(session, cwd);
          state.plan = await inspectPlan(ctx, state);
          // R 的"再提醒门槛"要看提醒簿记：取主会话自己那份（子智能体不参与 R 的投递）。
          const book = state.bySession.get(session)?.reminders?.r;
          return { kind: 'success', text: formatDriftReport(state, book) };
        } catch (error) {
          return { kind: 'error', text: `drift-guard：读取提醒列表失败：${error instanceof Error ? error.message : String(error)}` };
        }
      },
    });
  }, 'drift-guard');
}

// v0.1 的公开面继续从入口导出，测试与外部调用不用改 import 路径。
export {
  ALERT_DIR,
  ALERT_LOG,
  DEFAULTS,
  DEFAULT_SENSITIVE,
  DEFAULT_SENSITIVE_ALLOW,
  Config,
  resolveConfig,
  PLAN_FILE,
  PLAN_SEARCH_DEPTH,
  REPEAT_THRESHOLD,
  READ_FILE_TOOLS,
  SIGNAL_NAME,
  LEVEL_ADVICE,
  levelTag,
  reminderText,
  forwardReminderText,
  appendReminder,
  appendTarget,
  recordSignalAlert,
  SENSITIVE_READ_TOOLS,
  PATTERN_TOOLS,
  EXAMPLE_EXEMPT,
  patternStaticPrefix,
  isSensitiveRead,
  classifyRead,
  pathFromArgs,
  asRecord,
  slashes,
  resolvePath,
  isOutsideWorkspace,
  relativePath,
  isApproved,
  classifyWrite,
  alertLine,
  formatDriftReport,
  ratioReport,
  parsePlan,
  countCheckedSteps,
  countUncheckedSteps,
  inspectPlan,
  failureDecision,
  createSignalState,
  observeCall,
  handoffRatio,
  deviationDeltas,
  signalText,
  chainSignature,
  hashResult,
  fileStamp,
};
