/**
 * 规则层：五条"合规"检查（与检测信号无关，只回答"这个动作允不允许"）。
 *
 *   规则 1（提醒）写入/编辑/删除不在 PLAN.md 已批准清单里的文件 → 记录。
 *   规则 2（拦截）写类工具的目标在工作区之外 → deny。
 *   规则 3（提醒）同一工具、相同参数连续失败达到阈值 → 记录。
 *   规则 4（拦截）读取类工具命中敏感名单 → deny。
 *   规则 5（提醒）读取工作区外的不敏感文件 → 只记一条。
 *
 * 本模块只做判定与记录，不碰会话状态的生命周期；所有函数都不抛异常给调用方。
 *
 * @module dsh-drift-guard/rules
 */

import {
  asRecord,
  pathFromArgs,
  isOutsideWorkspace,
  classifyWrite,
} from './paths.js';
import {
  SENSITIVE_READ_TOOLS,
  PATTERN_TOOLS,
  patternStaticPrefix,
  classifyRead,
  displayTarget,
} from './sensitive.js';
import { failureDecision } from './signals.js';
import { WRITE_TOOLS } from './observation.js';
import { record } from './alerts.js';

/** 带路径参数、可能改动文件的工具名（小写比较）。 */
export const FILE_WRITE_TOOLS = WRITE_TOOLS;

/** 规则 4 拦截时返回给模型的话。 */
export function blockReadReason(target, cwd) {
  return `[drift-guard] 已拦截：目标路径 ${target} 命中敏感名单（凭据/密钥类文件），未读取内容。`
    + `当前会话工作区：${cwd}。`
    + '这是 drift-guard 插件的规则检查，不是用户的批准或拒绝。'
    + '请不要猜测或绕过：确实需要读取该文件时，先向用户说明用途并取得单独同意，'
    + '由用户本人提供所需信息，或把该路径加入插件配置的放行名单（sensitiveAllow）。';
}

/** 规则 2 拦截时返回给模型的话。 */
export function blockReason(target, cwd) {
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
export function readTarget(args, tool, cwd) {
  const record_ = asRecord(args);
  if (record_ === undefined) return undefined;
  // `glob`/`ops_glob` 的 `pattern` 是模式、不是路径：`pathFromArgs` 的兜底会把 pattern
  // 当路径取出来，所以这里先单独处理，只看显式的路径字段与模式里的字面前缀。
  if (PATTERN_TOOLS.has(String(tool).toLowerCase())) {
    for (const key of ['file_path', 'path']) {
      const value = record_[key];
      if (typeof value === 'string' && value.trim() !== '') return { target: value.trim(), display: value.trim() };
    }
    const pattern = record_.pattern;
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
 * 规则 4：敏感读取 → 返回 deny 负载；不命中时返回 null（调用方继续走规则 2）。
 *
 * @param {{name: string, arguments: unknown}} exec - 工具调用。
 * @param {{cwd?: string}} state - 会话状态（记录用）。
 * @param {object} settings - 解析后的配置。
 * @returns {object|null} `{kind:'deny', reason, info}` 或 null。
 */
export function checkSensitiveRead(exec, state, settings) {
  if (!SENSITIVE_READ_TOOLS.has(String(exec.name).toLowerCase())) return null;
  const read = classifyRead({ args: exec.arguments, cwd: state.cwd, settings: { ...settings, tool: exec.name } });
  if (read === null) return null;
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

/**
 * 规则 2（拦截）+ 规则 1（只记录）。
 *
 * @param {{name: string, arguments: unknown}} exec - 工具调用。
 * @param {{cwd?: string}} state - 会话状态。
 * @param {object} plan - `inspectPlan()` 的产物（`status === 'ok'` 时才有已批准清单）。
 * @returns {object|null} 越界时返回 deny 负载；未批准只记录并返回 null。
 */
export function checkWriteTarget(exec, state, plan) {
  if (!FILE_WRITE_TOOLS.has(String(exec.name).toLowerCase())) return null;
  const verdict = classifyWrite({
    name: exec.name,
    args: exec.arguments,
    cwd: state.cwd,
    approved: plan.status === 'ok' ? plan.approved : null,
    planDir: plan.status === 'ok' ? plan.dir : undefined,
  });
  if (verdict === null) return null;

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
  return null;
}

/**
 * 规则 3：同一工具、相同参数连续失败达到阈值 → 记录一条。
 *
 * @param {object} state - 会话状态（`repeats` 在这里累计）。
 * @param {{name: string, arguments: unknown}} exec - 工具调用。
 * @param {{isError?: boolean}} result - 工具结果。
 * @param {object} settings - 解析后的配置。
 * @returns {object|null} 记录下来的提醒，未达阈值时 null。
 */
export function noteFailure(state, exec, result, settings) {
  const signature = `${exec.name} ${JSON.stringify(exec.arguments ?? null)}`;
  const count = failureDecision(state.repeats, signature, result.isError === true, settings.failureRepeats);
  if (count === null) return null;
  const alert = { type: 'repeat', at: Date.now(), tool: exec.name, signature, count };
  record(state, alert);
  return alert;
}

/**
 * 规则 5：读取工作区外的不敏感文件 → 只记一条，不拦、不注入。
 *
 * @param {object} state - 会话状态。
 * @param {{name: string, arguments: unknown}} exec - 工具调用。
 * @param {{isError?: boolean}} result - 工具结果（失败的不记）。
 * @returns {object|null} 记录下来的提醒，不满足条件时 null。
 */
export function noteOutsideRead(state, exec, result) {
  if (result?.isError === true) return null;
  if (!SENSITIVE_READ_TOOLS.has(String(exec.name).toLowerCase())) return null;
  const target = readTarget(exec.arguments, exec.name, state.cwd);
  if (target === undefined || !isOutsideWorkspace(target.target, state.cwd)) return null;
  const alert = {
    type: 'outside-read',
    at: Date.now(),
    tool: exec.name,
    target: displayTarget(target.display, state.cwd),
  };
  record(state, alert);
  return alert;
}
