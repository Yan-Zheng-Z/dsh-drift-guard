/**
 * drift-guard 路径与清单判定（规则 1、规则 2 的判定内核）。
 *
 * v0.1 的这两条规则逻辑**原样搬移**到本文件，行为不变；本文件不含任何监听器与副作用。
 * 纯函数，供测试直接调用。
 *
 * @module dsh-drift-guard/paths
 */

/** 工具入参里表示目标路径的字段，按顺序取第一个非空字符串。 */
export const PATH_ARG_KEYS = ['file_path', 'path', 'target'];

/** 把反斜杠统一成正斜杠。 */
export function slashes(value) {
  return value.replace(/\\/g, '/');
}

/** 合法的工具入参对象，否则 undefined。 */
export function asRecord(value) {
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
export function normalize(p) {
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
