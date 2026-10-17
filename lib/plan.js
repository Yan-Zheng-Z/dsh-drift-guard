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
 * 一次扫描同时算出：已批准清单、缺哪种标记、勾选框计数。
 *
 * `missing` 只在没有已批准路径时有意义，三种原因按解析器的判定顺序给出：
 * `active-phase`（没有"已批准/进行中"标题）→ `list-item`（该阶段下没有列表项）→
 * `path`（列表项里没有路径）。这样 /drift 能说清缺的是什么，而不是一律报"未找到"。
 *
 * @param {string} text - PLAN.md 内容。
 * @returns {{approved: object[]|null, missing: string[], checkedSteps: number,
 *   uncheckedSteps: number}}
 */
function analyzePlan(text) {
  const approved = [];
  const seen = new Set();
  let active = false;
  let activeHeadings = 0;
  let activeListItems = 0;
  let checkedSteps = 0;
  let uncheckedSteps = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) {
      const title = line.replace(/^#+/, '').replace(/\u00a0/g, ' ').trim();
      active = ACTIVE_STATES.some((state) => title.includes(state));
      if (active) activeHeadings += 1;
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/.test(line)) checkedSteps += 1;
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[ \]/.test(line)) uncheckedSteps += 1;
    if (!active) continue;
    if (!/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) continue;
    activeListItems += 1;
    for (const token of pathTokensFrom(line)) {
      const key = `${normalize(token)}\0${token.endsWith('/')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      approved.push({ status: normalize(token), isDir: token.endsWith('/') });
    }
  }
  const missing = approved.length > 0
    ? []
    : activeHeadings === 0
      ? ['active-phase']
      : activeListItems === 0
        ? ['list-item']
        : ['path'];
  return {
    approved: approved.length === 0 ? null : approved,
    missing,
    checkedSteps,
    uncheckedSteps,
  };
}

/**
 * 解析 PLAN.md：只把"已批准/进行中"阶段里列出的路径算作已批准。
 *
 * @param {string} text - PLAN.md 内容。
 * @returns {{status: string, isDir: boolean}[] | null} 已批准路径清单；
 *   整个文件解析不到任何"已批准/进行中"阶段、或没解析出任何路径时返回 null（规则 1 不生效）。
 */
export function parsePlan(text) {
  // 一个路径都没解析到时返回 null：让调用方明确报"未找到可解析的计划"，
  // 而不是退化成空清单（空清单会被当成"无需检查"= 什么都批准，属于静默失效）。
  return analyzePlan(text).approved;
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
 * 读取并解析会话工作区根目录下的 PLAN.md；按文件 mtime 缓存，避免每次工具调用都重解析。
 *
 * v0.2.2 起**只在会话工作区根目录读**，不再向上查找：工作区常常是更大目录的子目录
 * （甚至就在用户主目录下），上查会命中与本任务无关的上级计划，规则 1 的判定跟着失真。
 * 迁移提示见 README 的「`PLAN.md` 怎么解析」一节。
 *
 * `checkedSteps`/`uncheckedSteps` 在 `status === 'ok'` 与 `'unparsed'` 时都有值：
 * `'ok'` 时供 S4；`'unparsed'` 时供 R 判断"计划已全部完成"。`planComplete` 只在文件确实
 * 用了复选框（至少一项已打勾）且没有未打勾项时为 true。调用方仍只在 `status === 'ok'` 时
 * 把 `checkedSteps` 交给 S4，所以"没有进行中阶段"不会触发 S4。
 *
 * @param {{get: (key: string) => any}} ctx - 宿主上下文。
 * @param {object} state - 会话状态（存放 plan 缓存）。
 * @returns {Promise<{status: string, approved: object[]|null, missing?: string[],
 *   checkedSteps?: number, uncheckedSteps?: number, planComplete?: boolean, file?: string,
 *   dir?: string}>}
 */
export async function inspectPlan(ctx, state) {
  const cwd = state?.cwd;
  if (typeof cwd !== 'string' || cwd === '') return { status: 'no-cwd', approved: null };

  const dir = cwd;
  const file = path.join(dir, PLAN_FILE);
  let stamp;
  try {
    stamp = fs.statSync(file).mtimeMs;
  } catch {
    state.plan = { status: 'absent', approved: null };
    state.planStamp = undefined;
    state.planFile = undefined;
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
  const analyzed = analyzePlan(text);
  // 计划"已全部完成"：确实在用复选框（至少一项已打勾），且没有未打勾项。
  // 只靠"没有未打勾项"不够——一份用散文写的计划也会是 0 个未打勾，不能当成已完成。
  const planComplete = analyzed.checkedSteps > 0 && analyzed.uncheckedSteps === 0;
  state.planStamp = stamp;
  state.planFile = file;
  state.plan = analyzed.approved === null
    ? {
      status: 'unparsed',
      approved: null,
      missing: analyzed.missing,
      checkedSteps: analyzed.checkedSteps,
      uncheckedSteps: analyzed.uncheckedSteps,
      planComplete,
    }
    : {
      status: 'ok',
      approved: analyzed.approved,
      file,
      dir,
      missing: [],
      checkedSteps: analyzed.checkedSteps,
      uncheckedSteps: analyzed.uncheckedSteps,
      planComplete,
    };
  return state.plan;
}
