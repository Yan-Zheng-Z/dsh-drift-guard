/**
 * 采集层：把一次工具调用压成一个与宿主无关的观测对象。
 *
 * 只做纯计算（字段挑选、规范化、哈希），不读文件、不写状态、不抛异常。
 * 判定层（`lib/detectors.js`）只依赖这里的产物，不直接碰 `exec` / `result`——
 * 以后换宿主接口时只需要改这一处。
 *
 * @module dsh-drift-guard/observation
 */

import { createHash } from 'node:crypto';

/** 写文件的工具名（小写比较）；成功执行一次算一次"产物"。 */
export const WRITE_TOOLS = new Set(['write', 'edit', 'ops_replace']);

/** 结果指纹：只把"是否失败 + 模型可见的内容块"纳入比较（与 S1 的口径一致）。 */
function fingerprint(failed, content) {
  const shape = { isError: failed, content: content ?? null };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/** PLAN.md 快照；拿不到已勾选步数时返回 null（表示"没有可用的计划"）。 */
function planSnapshot(input) {
  const checked = input?.checkedSteps;
  if (typeof checked !== 'number' || !Number.isFinite(checked) || checked < 0) return null;
  const unchecked = input?.uncheckedSteps;
  const rest = typeof unchecked === 'number' && Number.isFinite(unchecked) && unchecked >= 0 ? unchecked : 0;
  return { checked, unchecked: rest, complete: input?.planComplete === true };
}

/** todo 快照；三个计数不合法时返回 null。 */
function todoSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { completed, pending, inProgress } = value;
  for (const number of [completed, pending, inProgress]) {
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return null;
  }
  return { completed, pending, inProgress };
}

/**
 * 造一个观测对象。
 *
 * @param {{index?: number, tool?: unknown, result?: unknown, checkedSteps?: number,
 *   uncheckedSteps?: number, planComplete?: boolean, todo?: unknown,
 *   contextTokens?: number}} input - 一次工具调用的原始输入。
 * @returns {{index: number, tool: string, resultKey: string, failed: boolean,
 *   wrote: boolean, plan: object|null, todo: object|null, tokens: number|null}}
 */
export function observeToolCall(input) {
  const tool = String(input?.tool ?? '').toLowerCase();
  const failed = input?.result?.isError === true;
  const index = Number.isInteger(input?.index) && input.index >= 0 ? input.index : 0;
  const tokens = input?.contextTokens;
  return {
    index,
    tool,
    resultKey: fingerprint(failed, input?.result?.content),
    failed,
    wrote: !failed && WRITE_TOOLS.has(tool),
    plan: planSnapshot(input),
    todo: todoSnapshot(input?.todo),
    tokens: typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null,
  };
}
