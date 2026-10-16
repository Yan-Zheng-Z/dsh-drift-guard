/**
 * drift-guard：确定性偏离检查。
 *
 * 只做三件事，全部不调用 LLM、不往模型上下文注入内容、不打断主会话：
 *   规则 1（提醒）写入/编辑/删除的文件不在 PLAN.md 当前已批准阶段清单里 → 记录提醒。
 *   规则 2（拦截）目标路径在会话工作区之外 → deny，工具体不执行，并把原因交给模型。
 *   规则 3（提醒）同一工具、相同参数连续失败 3 次 → 记录提醒。
 *
 * PLAN.md 无法解析出任何"已批准/进行中"阶段时规则 1 不生效，并在 /drift 里明确显示原因。
 * 被规则 2 拦截的调用不计入规则 3。
 *
 * 本模块同时导出纯函数供测试直接调用：parsePlan / classifyWrite / failureDecision /
 * alertLine / inspectPlan / formatDriftReport / resolvePath / isOutsideWorkspace / isApproved。
 *
 * @module dsh-drift-guard
 */

import fs from 'node:fs';
import path from 'node:path';

/** PLAN.md 固定读工作区根目录下的这个文件名。 */
export const PLAN_FILE = 'PLAN.md';
/** 提醒日志目录（相对工作区根目录）。 */
export const ALERT_DIR = '.drift';
/** 提醒日志文件名。 */
export const ALERT_LOG = 'alerts.log';
/** 规则 3 的阈值：同一签名连续失败达到这个次数就提醒，之后每再满这个次数再提醒一次。 */
export const REPEAT_THRESHOLD = 3;
/** 会话 cwd 里找不到 PLAN.md 时，向上最多查找这么多层。 */
export const PLAN_SEARCH_DEPTH = 8;

/** 带路径参数、可能改动文件的工具名（小写比较）。 */
export const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'ops_replace']);

/** 工具入参里表示目标路径的字段，按顺序取第一个非空字符串。 */
const PATH_ARG_KEYS = ['file_path', 'path', 'target'];

/** 阶段标题里表示"当前执行范围"的状态词。 */
const ACTIVE_STATES = ['已批准', '进行中'];

/** 按会话对象存放状态；会话消失后由 GC 回收。 */
const STATE = new WeakMap();

/** 把反斜杠统一成正斜杠。 */
function slashes(value) {
  return value.replace(/\\/g, '/');
}

/** 合法的工具入参对象，否则 undefined。 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** 工具入参里的目标路径。 */
export function pathFromArgs(args) {
  const record = asRecord(args);
  if (record === undefined) return undefined;
  for (const key of PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** 统一分隔符、去掉多余尾斜杠；Windows 下不分大小写。 */
function normalize(p) {
  let out = slashes(p).replace(/\/{2,}/g, '/');
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/** 向上消除 `.` 与 `..` 段。 */
function collapse(raw) {
  const segments = slashes(raw).split('/');
  const absolute = segments[0] === '';
  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** 把目标路径解析成绝对路径；相对路径按 cwd 解析。 */
export function resolvePath(target, cwd) {
  const p = slashes(target).trim();
  const raw = /^[a-zA-Z]:\//.test(p) || p.startsWith('/')
    ? p
    : `${slashes(cwd).replace(/\/+$/, '')}/${p}`;
  const parts = collapse(raw);
  if (parts.length === 0) return normalize(raw);
  // 盘符根（c:）要还原成带斜杠的形式；UNC 根保留前导双斜杠。
  const head = /^[a-zA-Z]:$/.test(parts[0]) ? `${parts[0]}/` : parts[0];
  return normalize([head, ...parts.slice(1)].join('/'));
}

/** 目标是否在工作区之外。 */
export function isOutsideWorkspace(target, cwd) {
  const workspace = normalize(slashes(cwd).replace(/\/+$/, ''));
  const resolved = resolvePath(target, cwd);
  return !(resolved === workspace || resolved.startsWith(`${workspace}/`));
}

/**
 * 相对某个根的路径，用于展示与匹配。
 *
 * 相对目标必须**先按会话 cwd 解析成绝对路径**，再相对 `root` 求差——
 * 直接 `resolvePath(target, root)` 会用进程 cwd 兜底，算出错误的路径。
 *
 * @param {string} target - 工具入参里的原始路径（可能是相对路径）。
 * @param {string} root - 要求相对路径的那个根。
 * @param {string} [cwd] - 会话工作区；省略时按 `root` 解析（调用方明确目标就是相对 root 的）。
 */
export function relativePath(target, root, cwd) {
  const base = cwd === undefined ? root : cwd;
  const absolute = resolvePath(target, base);
  const rootNormalized = normalize(slashes(root).replace(/\/+$/, ''));
  if (absolute === rootNormalized) return '.';
  return absolute.startsWith(`${rootNormalized}/`) ? absolute.slice(rootNormalized.length + 1) : absolute;
}

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

/** 去掉盘符，只留路径本体，便于跨盘符比较。 */
function barePath(value) {
  return normalize(value).replace(/^[a-z]:/, '');
}

/** 目标与某个条目的段列表是否指向同一个东西（末段为文件、或末段为目录前缀）。 */
function segmentsMatch(targetSegments, entrySegments, isDir) {
  if (isDir) {
    if (targetSegments.length < entrySegments.length) return false;
    // 目录条目要求它是目标的前缀：条目相对 PLAN.md 所在目录，目标是绝对路径，
    // 从末尾对齐会把目标的末段当成根，反而永远比不上。
    for (let i = 0; i < entrySegments.length; i += 1) {
      if (targetSegments[i] !== entrySegments[i]) return false;
    }
    return true;
  }
  if (targetSegments.length !== entrySegments.length) return false;
  for (let i = 0; i < entrySegments.length; i += 1) {
    if (targetSegments[targetSegments.length - entrySegments.length + i] !== entrySegments[i]) return false;
  }
  return true;
}

/**
 * 把一个清单条目按 `base` 解释成相对比较用的段列表；没有可用的 `base` 时返回 null。
 * 盘符绝对路径按字面处理（已带根，不再拼 base）。
 */
function entrySegmentsOf(entry, base) {
  const status = slashes(entry.status);
  if (/^[a-zA-Z]:\//.test(status)) return barePath(status).split('/');
  if (typeof base !== 'string' || base === '') return null;
  return barePath(`${slashes(base).replace(/\/+$/, '')}/${status}`).split('/');
}

/** 绝对路径的盘符（小写，无冒号）；没有盘符时返回 null（POSIX 路径）。 */
function driveOf(value) {
  const match = /^([a-zA-Z]):/.exec(slashes(value));
  return match === null ? null : match[1].toLowerCase();
}

/** 某个条目按某个基准解释后是否命中目标；解释不出段列表时不算命中。 */
function entryMatchesBase(targetSegments, entry, base, targetDrive) {
  // 不同盘的绝对路径不可能是同一个文件，先挡住，免得 barePath 去掉盘符后误命中。
  if (driveOf(entry.status) !== null && driveOf(entry.status) !== targetDrive) return false;
  const entrySegments = entrySegmentsOf(entry, base);
  if (entrySegments === null || (entrySegments.length === 1 && entrySegments[0] === '')) return false;
  return segmentsMatch(targetSegments, entrySegments, entry.isDir);
}

/**
 * 判断一次写入是否在已批准清单内。
 *
 * **目标**按会话 cwd 解析（文件工具就是这么解析的）；**清单条目**有两种合理读法，
 * 任一命中即算已批准：
 *   1. 相对会话工作区根（`cwd`）——README 里"`PLAN.md` 读工作区根"的表述，也是本项目的实际写法；
 *   2. 相对 `PLAN.md` 所在目录（`planDir`）——计划放在祖先目录、条目按计划根写时的读法。
 * 只认其中一种都会在另一种场景下误报，而规则 1 是"提醒"而非"拦截"，宽一点比误报更划算。
 * 两者解析后按段比较：文件要求段完全相同，目录条目要求它是目标的前缀。
 *
 * @param {string} target - 工具入参里的目标路径。
 * @param {string} cwd - 会话工作区。
 * @param {{status: string, isDir: boolean}[]|null} approved - 已批准清单。
 * @param {string} [planDir] - `PLAN.md` 所在目录。
 */
export function isApproved(target, cwd, approved, planDir) {
  if (approved === null || approved === undefined) return true;
  if (typeof cwd !== 'string' || cwd === '') return true;
  const resolved = resolvePath(target, cwd);
  const targetSegments = barePath(resolved).split('/');
  const targetDrive = driveOf(resolved);
  const bases = typeof planDir === 'string' && planDir !== '' && normalize(planDir) !== normalize(cwd)
    ? [cwd, planDir]
    : [cwd];
  for (const entry of approved) {
    for (const base of bases) {
      if (entryMatchesBase(targetSegments, entry, base, targetDrive)) return true;
    }
  }
  return false;
}

/**
 * 规则 2 与规则 1 的判定；纯函数，无副作用。
 *
 * @param {{name: string, args: unknown, cwd: string, approved: object[]|null, planDir?: string}} input
 * @returns {{kind: 'outside', target: string}
 *   | {kind: 'unapproved', target: string, relative: string}
 *   | null}
 */
export function classifyWrite(input) {
  const { args, cwd, approved, planDir } = input;
  const target = pathFromArgs(args);
  if (target === undefined || typeof cwd !== 'string' || cwd === '') return null;
  if (isOutsideWorkspace(target, cwd)) return { kind: 'outside', target };
  if (approved !== null && !isApproved(target, cwd, approved, planDir)) {
    return { kind: 'unapproved', target, relative: relativePath(target, cwd) };
  }
  return null;
}

/**
 * 规则 3 的判定：同一签名连续失败达到阈值时给出提醒，之后每再满阈值再提醒一次。
 * 成功一次即清零；其他工具的调用不影响计数。
 *
 * @param {Map<string, {count: number, alerted: number}>} repeats
 * @param {string} signature - 工具名 + 参数 JSON。
 * @param {boolean} failed - 本次是否失败。
 * @returns {number|null} 需要提醒时的累计失败次数，否则 null。
 */
export function failureDecision(repeats, signature, failed) {
  if (!failed) {
    repeats.delete(signature);
    return null;
  }
  const record = repeats.get(signature) ?? { count: 0, alerted: 0 };
  record.count += 1;
  let alerted = null;
  if (record.count >= REPEAT_THRESHOLD && record.count - record.alerted >= REPEAT_THRESHOLD) {
    record.alerted = record.count;
    alerted = record.count;
  }
  repeats.set(signature, record);
  return alerted;
}

/** 提醒的去重键。 */
function alertKey(alert) {
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
    case 'repeat':
      return `[drift-guard] ${time} 打转提醒：tool=${alert.tool} 签名=${alert.signature} 连续失败=${alert.count} 次`;
    default:
      return `[drift-guard] ${time} 未知提醒类型：${String(alert.type)}`;
  }
}

/** 状态词对应的报告文字。 */
const PLAN_STATUS_TEXT = {
  ok: '计划：已解析 PLAN.md，规则 1 生效。',
  unparsed: '计划：未找到可解析的计划（PLAN.md 里没有"已批准/进行中"阶段）；规则 1 不生效，只做规则 2、3。',
  absent: '计划：工作区内没有 PLAN.md；规则 1 不生效，只做规则 2、3。',
  'no-fs': '计划：宿主没有挂载文件系统服务，无法读取 PLAN.md；规则 1 不生效。',
  'no-cwd': '计划：会话没有记录工作目录，无法判断工作区；规则 2、3 仍生效。',
};

/**
 * 读取并解析某条会话工作区里的 PLAN.md；按文件 mtime 缓存，避免每次工具调用都重解析。
 *
 * 会话 cwd 在子目录时（例如工作区根下的 `tmp/acceptance`），会**向上查找** `PLAN.md`，
 * 最多 `PLAN_SEARCH_DEPTH` 层——因为计划通常是放在工作区根的，找不到就等于规则 1 静默失效。
 *
 * @param {{get: (key: string) => any}} ctx - 宿主上下文。
 * @param {object} state - 会话状态（存放 plan 缓存）。
 * @returns {Promise<{status: string, approved: object[]|null}>}
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
    : { status: 'ok', approved, file, dir };
  return state.plan;
}

/**
 * 取一次工具执行所属的会话与工作区。
 * 会话身份用最上层的根会话（状态按它共享）；工作区优先用当前会话自己记录的 cwd，
 * 没有时回溯到父会话——子智能体可能不记 cwd，但它和父会话在同一工作区。
 */
function sessionOf(exec) {
  let session = exec?.agent?.session;
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

/** 取（或初始化）一条会话的检查状态。 */
/**
 * 取（或初始化）一条会话的检查状态。
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
      alerts: [],
      seen: new Set(),
      lastSeen: 0,
      logBroken: false,
    };
    STATE.set(session, state);
  } else if (state.cwd === undefined && cwd !== undefined) {
    state.cwd = cwd;
  }
  return state;
}

/** 追加一行到工作区内的提醒日志；写不进去只记一次原因，绝不影响主会话。 */
function appendLog(state, line) {
  try {
    const dir = path.join(state.cwd, ALERT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, ALERT_LOG), `${line}\n`, 'utf8');
  } catch {
    state.logBroken = true;
  }
}

/** 记录一条提醒：按"类型 + 工具 + 目标"去重，写日志，并留在内存里等 /drift 读取。 */
function record(state, alert) {
  const key = alertKey(alert);
  if (state.seen.has(key)) return null;
  state.seen.add(key);
  state.alerts.push(alert);
  appendLog(state, alertLine(alert));
  return alert;
}

/** /drift 的完整报告文本。 */
export function formatDriftReport(state) {
  const lines = ['[drift-guard] 提醒列表'];
  lines.push(PLAN_STATUS_TEXT[state.plan?.status] ?? PLAN_STATUS_TEXT.absent);
  if (state.plan?.status === 'ok') {
    lines.push(`已批准清单（${state.plan.approved.length} 条）：${state.plan.approved.map((entry) => entry.status).join('、')}`);
  }
  if (state.logBroken) lines.push(`注意：无法写入提醒日志（${ALERT_DIR}/${ALERT_LOG}）。`);

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

/** 规则 2 拦截时返回给模型的话。 */
function blockReason(target, cwd) {
  return `[drift-guard] 已拦截：目标路径 ${target} 在会话工作区（${cwd}）之外，未执行写入。`
    + '这是 drift-guard 插件的规则检查，不是用户的批准或拒绝。'
    + '请只在工作区内操作；确实需要访问该路径时，先向用户明确申请并获得单独同意。';
}

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'drift-guard';
/** 依赖的宿主服务；fs 只用于读 PLAN.md，挂载了才注入。 */
export const inject = ['commands', 'fs', 'tools'];

/** 插件入口：注册两个工具管线监听器与 /drift 命令，随 fiber 一起释放。 */
export function apply(ctx) {
  ctx.effect(function* driftGuard() {
    yield ctx.on('tools/pre-execute', async (exec, next) => {
      const { session, cwd } = sessionOf(exec);
      if (session === undefined) return next();
      const state = stateOf(session, cwd);
      const plan = await inspectPlan(ctx, state);

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
      const { session } = sessionOf(exec);
      if (session === undefined) return next();
      const state = STATE.get(session);
      // 这条会话还没被 pre-execute 建过状态，说明没发生过任何工具调用前的检查；直接放行。
      if (state === undefined) return next();
      const signature = `${exec.name} ${JSON.stringify(exec.arguments ?? null)}`;
      const count = failureDecision(state.repeats, signature, result.isError === true);
      if (count !== null) {
        record(state, {
          type: 'repeat',
          at: Date.now(),
          tool: exec.name,
          signature,
          count,
        });
      }
      return next();
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
          return { kind: 'success', text: formatDriftReport(state) };
        } catch (error) {
          return { kind: 'error', text: `drift-guard：读取提醒列表失败：${error instanceof Error ? error.message : String(error)}` };
        }
      },
    });
  }, 'drift-guard');
}
