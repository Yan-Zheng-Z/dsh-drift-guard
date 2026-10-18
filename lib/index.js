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
  HANDOFF_TEMPLATE,
  noticeMessage,
  levelTag,
  reminderText,
  forwardReminderText,
  appendReminder,
  appendTarget,
  alertLine,
  formatDriftReport,
  handoffReport,
  ratioReport,
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
  parsePlan,
  countCheckedSteps,
  countUncheckedSteps,
  inspectPlan,
} from './plan.js';
import { applyEntry, loadState, saveState } from './persist.js';
import { checkSensitiveRead, checkWriteTarget, noteFailure, noteOutsideRead, FILE_WRITE_TOOLS } from './rules.js';
import { createSessionSignals, chooseReminder, readTodoSnapshot, trackCall, deliverReminder, noteHandoff } from './delivery.js';
import { resetOnUserMessage } from './detectors.js';
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
} from './sensitive.js';

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

/**
 * 取（或初始化）一条会话树的检查状态；首次创建时从 `.drift/state/` 恢复计数。
 *
 * @param {object} session - 根会话，作为状态键。
 * @param {string|undefined} cwd - 本次执行解析出的工作区。
 */
export function stateOf(session, cwd) {
  let state = STATE.get(session);
  if (state === undefined) {
    state = {
      cwd,
      root: session,
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
      handoff: null,
      handoffTemplateSent: false,
      restoredAt: 0,
    };
    STATE.set(session, state);
    // 跨重启恢复：按根会话 id 读回 calls/active/S4/todo/reminders/handoff。
    const restored = loadState(cwd, session);
    if (restored !== undefined) {
      const entry = createSessionSignals();
      applyEntry(entry, restored);
      state.bySession.set(session, entry);
      state.handoff = restored.handoff ?? null;
      state.handoffTemplateSent = restored.handoffTemplateSent === true;
      state.restoredAt = Date.now();
    }
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
      // 规则 4：敏感读取 → 拦截。
      const denied = checkSensitiveRead(exec, state, settings);
      if (denied !== null) return denied;
      // 规则 2：越界写入 → 拦截；规则 1：未批准的写入 → 只记录（不拦）。
      const blocked = checkWriteTarget(exec, state, plan);
      if (blocked !== null) return blocked;
      return next();
    });

    yield ctx.on('tools/post-execute', async (exec, result, next) => {
      const downstream = await next();
      let state;
      let reminder = null;
      let appendTemplate = false;
      try {
        const caller = exec?.agent?.session;
        const { session: root } = sessionOf(exec);
        if (root !== undefined) state = STATE.get(root);
        // 这条会话还没被 pre-execute 建过状态，说明没发生过任何工具调用前的检查；直接放行。
        if (state !== undefined && caller !== undefined) {
          // 规则 3：同一工具、相同参数连续失败达到阈值 → 记录。
          noteFailure(state, exec, result, settings);

          const plan = await inspectPlan(ctx, state);
          // R 的主输入是主会话的上下文 token（估算值）；拿不到时按调用次数估算。
          const contextTokens = caller === root ? await measureContextTokens(ctx, root, state) : undefined;
          const todo = String(exec.name).toLowerCase() === 'todo_write' && result?.isError !== true
            ? readTodoSnapshot(exec.arguments, result)
            : undefined;
          const wrote = result?.isError !== true && FILE_WRITE_TOOLS.has(String(exec.name).toLowerCase());
          reminder = trackCall(state, {
            session: caller,
            isMain: caller === root,
            tool: exec.name,
            args: exec.arguments,
            result,
            cwd: state.cwd,
            checkedSteps: plan.status === 'ok' ? plan.checkedSteps : undefined,
            uncheckedSteps: plan.status === 'ok' ? plan.uncheckedSteps : undefined,
            planComplete: plan.planComplete === true,
            todo,
            wrote,
            contextTokens,
            agentId: exec?.agent?.id,
          }, settings);
          // 交接完成判定与第 3 级的记账交给投递层。
          const stamp = noteHandoff(state, exec, result, wrote);
          // 每次第 3 级重新记一笔：提醒时间 + 当时的 PROGRESS.md 指纹。
          if (reminder !== null && reminder.level === 3 && reminder.agentId === undefined) {
            state.handoff = { at: Date.now(), progressStamp: stamp };
          }

          // 跨重启持久化：只存主会话的计数状态；子智能体的临时状态不落盘。
          if (caller === root) {
            const mainEntry = state.bySession.get(root);
            if (mainEntry !== undefined) saveState(state, root, mainEntry);
          }

          // 交接模板只随主会话自己的第 3 级发一次；子智能体转交上来的是"第 2 级文案"，不带模板。
          if (reminder !== null && reminder.level === 3 && reminder.agentId === undefined
            && caller === root && state.handoffTemplateSent !== true) {
            appendTemplate = true;
          }

          // 规则 5：读取工作区外的不敏感文件——只记一条，不拦、不注入。
          noteOutsideRead(state, exec, result);
        }
      } catch (error) {
        if (state !== undefined) noteInternal(state, 'post-execute', error);
        return downstream;
      }
      if (reminder === null) return downstream;
      const delivered = deliverReminder(reminder, downstream, result, { appendTemplate });
      // 模板随这条通知发过就算发了：即便这次工具结果因为 block/替换而没法追加内容，也不该再发一遍。
      if (appendTemplate) {
        state.handoffTemplateSent = true;
        if (state.root !== undefined) {
          const mainEntry = state.bySession.get(state.root);
          if (mainEntry !== undefined) saveState(state, state.root, mainEntry);
        }
      }
      return delivered.downstream;
    });

    // S6 的"收到真实用户消息"清零条件：只有真正的用户输入才清零。
    // 我们自己的第 3 级通知同样是 `role:'user'`，靠 `form:'notice'` 与真实输入区分
    // （真实输入带 `rpcId`/`clientTimeZone`，没有 `form`）。
    yield ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'user/message') return;
        const source = event.data?.source;
        if (source?.kind !== 'user' || source?.form !== undefined) return;
        const { session: root } = sessionOf({ agent: session });
        const state = root === undefined ? undefined : STATE.get(root);
        const entry = state?.bySession.get(session);
        if (entry === undefined) return;
        // 真实用户消息：清掉"看最近一段调用"的窗口（M1/M3），并复位 S6 视图计数。
        if (entry.signals?.detectors !== undefined) resetOnUserMessage(entry.signals.detectors);
        if (entry.signals?.s6 === undefined) return;
        entry.signals.s6.count = 0;
        entry.signals.s6.alerted = 0;
      } catch {
        // 内部错误不能影响会话事件流。
      }
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
          return { kind: 'success', text: formatDriftReport(state, book, settings) };
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
  REPEAT_THRESHOLD,
  READ_FILE_TOOLS,
  FILE_WRITE_TOOLS,
  createSessionSignals,
  chooseReminder,
  trackCall,
  SIGNAL_NAME,
  LEVEL_ADVICE,
  HANDOFF_TEMPLATE,
  noticeMessage,
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
  handoffReport,
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
