/**
 * drift-guard 的 PLAN.md 解析。
 *
 * 两件事：
 *   1. 规则 1 的"已批准清单"：只有标题含 `已批准`/`进行中` 的阶段里列出的路径算已批准；
 *   2. S4 与交接收益比 R 的"进展指北"：整份 PLAN.md 里已打勾（`- [x]`）与未打勾（`- [ ]`）的步骤数。
 * v0.1 的解析逻辑**原样搬移**到本文件，只多了已打勾步骤计数。
 *
 * @module dsh-drift-guard/plan
 */

import fs from 'node:fs';
import path from 'node:path';

import { slashes, normalize } from './paths.js';

/** PLAN.md 固定读工作区根目录下的这个文件名。 */
export const PLAN_FILE = 'PLAN.md';
/** 会话 cwd 里找不到 PLAN.md 时，向上最多查找这么多层。 */
export const PLAN_SEARCH_DEPTH = 8;

/** 阶段标题里表示"当前执行范围"的状态词。 */
const ACTIVE_STATES = ['已批准', '进行中'];

/** 从一行 Markdown 里提取形如工作区相对路径的 token。 */
function pathTokensFrom(line) {
  const found = [];
  // 全角括号在计划里通常用来写理由（如 `tmp/build/（编译产物）`），当分隔符处理。
  // 注意：反斜杠路径（`acceptance\a.py`）不能当分隔符切开，否则会被拆成两个词。
  for (const raw of line.split(/[`\s，,、；;：:（）()【】\[\]]+/)) {
    // 先看原文有没有分隔符，再统一成正斜杠，否则"是不是路径形状"的判断会被改写结果污染。
    const hadSlash = raw.includes('/') || raw.includes('\\');
    let token = slashes(raw).replace(/^[（(【\[「『"'*]+/, '');
    // 剥掉包裹式标点与拖在路径后面的中文标点/句读，例如 `tmp/build/（编译产物）` 或 `src/a.py、`。
    token = token.replace(/^\.\//, '');
    token = token.replace(/[）)】\]」』"'*，,、；;：:。]+$/, '');
    if (token === '') continue;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) continue; // URL
    if (/^[a-zA-Z]:\//.test(token)) continue; // 工作区外盘符路径
    if (token.startsWith('~/')) continue;
    if (token.includes('*') || token.includes('?')) continue;
    if (!hadSlash && !/\.[A-Za-z0-9]{1,8}$/.test(token)) continue; // 只认路径形状
    found.push(token);
  }
  return found;
}

/**
 * 解析 PLAN.md：只把"已批准/进行中"阶段里列出的路径算作已批准。
 *
 * @param {string} text - PLAN.md 内容。
 * @returns {{status: string, isDir: boolean}[] | null} 已批准路径清单；
 *   整个文件解析不到任何"已批准/进行中"阶段、或没解析出任何路径时返回 null（规则 1 不生效）。
 */
export function parsePlan(text) {
  const approved = [];
  const seen = new Set();
  let active = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) {
      const title = line.replace(/^#+/, '').replace(/\u00a0/g, ' ').trim();
      active = ACTIVE_STATES.some((state) => title.includes(state));
      continue;
    }
    if (!active) continue;
    if (!/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) continue;
    for (const token of pathTokensFrom(line)) {
      const key = `${normalize(token)}\0${token.endsWith('/')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      approved.push({ status: normalize(token), isDir: token.endsWith('/') });
    }
  }
  // 一个路径都没解析到时返回 null：让调用方明确报"未找到可解析的计划"，
  // 而不是退化成空清单（空清单会被当成"无需检查"= 什么都批准，属于静默失效）。
  return approved.length === 0 ? null : approved;
}

/**
 * S4 的进展指北：整份 PLAN.md 里已打勾的步骤数。
 *
 * 只认列表条目里的复选框（`- [x]`、`* [X]`、`1. [x]`），`- [ ]` 与普通文字行不算。
 * 数的是**整个文件**：历史阶段打过的勾也算进展，否则收尾阶段会一直被当成"停滞"。
 *
 * @param {string} text - PLAN.md 内容。
 * @returns {number} 已打勾的步骤数。
 */
export function countCheckedSteps(text) {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/.test(line)) count += 1;
  }
  return count;
}

/**
 * 未打勾的步骤数（`- [ ]`）：交接收益比 R 里"剩余工作量 N"的输入。
 *
 * 与 `countCheckedSteps` 数同一批列表条目，只是换一个勾选框状态；同样数**整个文件**，
 * 缩进的子步骤也算。
 *
 * @param {string} text - PLAN.md 内容。
 * @returns {number} 未打勾的步骤数。
 */
export function countUncheckedSteps(text) {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[ \]/.test(line)) count += 1;
  }
  return count;
}

/**
 * 读取并解析某条会话工作区里的 PLAN.md；按文件 mtime 缓存，避免每次工具调用都重解析。
 *
 * 会话 cwd 在子目录时（例如工作区根下的 `tmp/acceptance`），会**向上查找** `PLAN.md`，
 * 最多 `PLAN_SEARCH_DEPTH` 层——因为计划通常是放在工作区根的，找不到就等于规则 1 静默失效。
 *
 * `checkedSteps` 只在 `status === 'ok'` 时有值：没有 PLAN.md、或解析不出"已批准/进行中"
 * 阶段时，S4 与 R 的 `N` 都不生效（调用方据此判断）；`uncheckedSteps` 与它同时有值。
 *
 * @param {{get: (key: string) => any}} ctx - 宿主上下文。
 * @param {object} state - 会话状态（存放 plan 缓存）。
 * @returns {Promise<{status: string, approved: object[]|null, checkedSteps?: number,
 *   uncheckedSteps?: number, file?: string, dir?: string}>}
 */
export async function inspectPlan(ctx, state) {
  const cwd = state?.cwd;
  if (typeof cwd !== 'string' || cwd === '') return { status: 'no-cwd', approved: null };

  let dir = cwd;
  let file;
  let found;
  for (let level = 0; level <= PLAN_SEARCH_DEPTH; level += 1) {
    const candidate = path.join(dir, PLAN_FILE);
    try {
      fs.statSync(candidate);
      file = candidate;
      found = true;
      break;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (found !== true) {
    state.plan = { status: 'absent', approved: null };
    state.planStamp = undefined;
    state.planFile = undefined;
    return state.plan;
  }

  let stamp;
  try {
    stamp = fs.statSync(file).mtimeMs;
  } catch {
    state.plan = { status: 'absent', approved: null };
    state.planStamp = undefined;
    return state.plan;
  }
  if (state.planStamp === stamp && state.planFile === file && state.plan !== null && state.plan !== undefined) {
    return state.plan;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    state.plan = { status: 'absent', approved: null };
    return state.plan;
  }
  const approved = parsePlan(text);
  state.planStamp = stamp;
  state.planFile = file;
  state.plan = approved === null
    ? { status: 'unparsed', approved: null }
    : {
      status: 'ok',
      approved,
      file,
      dir,
      checkedSteps: countCheckedSteps(text),
      uncheckedSteps: countUncheckedSteps(text),
    };
  return state.plan;
}
