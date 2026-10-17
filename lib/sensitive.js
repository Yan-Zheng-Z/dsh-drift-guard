/**
 * drift-guard 敏感读取判定（规则 4）。
 *
 * 读取类工具的目标路径命中**敏感名单**时拦截：工具体不执行，原因交给模型；工作区内、外一视同仁。
 * 豁免只有一条通道：**放行名单**（默认是示例文件那三条，见 `lib/config.js` 的
 * `DEFAULT_SENSITIVE_ALLOW`；用户可以追加，也可以把默认条目关掉）。
 * 名单匹配只看路径本身，不读文件内容，也不解析 shell 命令。
 *
 * 条目写法（敏感名单与放行名单相同）：
 *   - 不含 `/`、不含通配符：匹配**任一目录段或基名**（大小写不敏感）；
 *   - 含 `*`/`?`：只与基名做通配匹配；
 *   - 含 `/`：整串段序列，要求它在路径里**连续出现**（例如 `Microsoft/Edge/User Data`）；
 *   - 以 `/` 结尾：按**目录前缀**匹配（该目录及其整个子树）。
 *
 * 搜索类工具（`glob`/`ops_glob`）的 `pattern` **是模式、不是文件路径**。**实测 DSH 的 glob 不按绝对
 * pattern 搜索**（`ops_glob` 与内置 `glob` 传绝对 pattern 均返回 0 条，且不报错；内置 glob 的 SDK
 * 类型注释写着 "Absolute patterns are only permitted when the runner is configured to allow them"），
 * 所以不做"拦下这次搜索"的处理，只由 `index.js` 记一条工作区外读取。这里提供
 * `patternStaticPrefix` 供那个记录使用。
 *
 * 但模式里的**字面前缀**（第一个通配符之前的部分）就是要搜进去的目录，所以它照样参与敏感判定：
 * `C:/x/.ssh/*.pem`、`C:/x/.env` 这类"要搜进敏感位置"的调用会被拦下；通配符开头的相对模式
 * （例如匹配全部文件的模式）一律视为在工作区里搜索，不参与判定。
 *
 * @module dsh-drift-guard/sensitive
 */

import { asRecord, pathFromArgs, resolvePath, slashes, normalize } from './paths.js';

/** 参与敏感检查的读取类工具名（小写比较）。 */
export const SENSITIVE_READ_TOOLS = new Set([
  'read',
  'ops_inspect_local_file',
  'grep',
  'ops_grep',
  'glob',
  'ops_glob',
]);

/** 本条 DSH 上实测不接受绝对路径 pattern 的工具（模式型搜索工具，不是读文件）。 */
export const PATTERN_TOOLS = new Set(['glob', 'ops_glob']);

/**
 * 示例文件的默认放行条目；放行名单的默认值现在由 `lib/config.js` 的
 * `DEFAULT_SENSITIVE_ALLOW` 承载，这里保留同名导出是为了兼容原有引用。
 */
export const EXAMPLE_EXEMPT = new Set(['.env.example', '.env.sample', '.env.template']);

/** 基名里是否含通配符。 */
function hasGlob(value) {
  return value.includes('*') || value.includes('?');
}

/** 只含 `*`/`?` 通配的整串匹配（大小写不敏感）。 */
function globMatch(pattern, text) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(text);
}

/** 路径的段列表（已归一、已小写）。 */
function segmentsOf(value) {
  return normalize(value).split('/').filter((segment) => segment !== '');
}

/** 基名：最后一段。 */
function baseNameOf(segments) {
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

/** 归一后的条目。 */
function entryOf(raw) {
  const text = normalize(String(raw).trim());
  return { text, pattern: text.endsWith('/') ? text.slice(0, -1) : text, isDir: text.endsWith('/') };
}

/** 段序列是否在某处连续出现。 */
function containsRun(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let same = true;
    for (let i = 0; i < needle.length; i += 1) {
      if (haystack[start + i] !== needle[i]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

/**
 * 一个条目是否命中某条已解析的绝对路径。
 *
 * @param {{text: string, pattern: string, isDir: boolean}} entry
 * @param {string[]} segments - 目标路径的段列表（已小写）。
 * @returns {boolean}
 */
function entryHits(entry, segments) {
  if (entry.isDir) return containsRun(segments, segmentsOf(entry.pattern));
  if (entry.pattern.includes('/')) return containsRun(segments, segmentsOf(entry.pattern));
  if (hasGlob(entry.pattern)) return globMatch(entry.pattern, baseNameOf(segments));
  return segments.includes(entry.pattern);
}

/** 一组条目里是否有命中的。 */
function anyHit(entries, resolved) {
  const segments = segmentsOf(resolved);
  for (const raw of entries ?? []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (entryHits(entryOf(raw), segments)) return true;
  }
  return false;
}

/**
 * 把绝对通配模式里**第一个通配符之前**的部分当作字面路径返回。
 *
 * 例：`C:/Users/x/.ssh/*.pem` → `C:/Users/x/.ssh`；相对模式（`src/*.js`）返回 undefined
 * ——相对模式一律在工作区里搜，不参与工作区外判定。
 *
 * @param {unknown} pattern - 工具入参里的 `pattern`。
 * @returns {string|undefined}
 */
export function patternStaticPrefix(pattern) {
  if (typeof pattern !== 'string') return undefined;
  const text = slashes(pattern.trim());
  const wildcard = text.search(/[*?]/);
  const head = wildcard === -1 ? text : text.slice(0, wildcard);
  const trimmed = head.replace(/[\\/]+$/, '');
  if (/^[a-zA-Z]:\//.test(trimmed) || trimmed.startsWith('/')) return trimmed;
  return undefined;
}

/**
 * 一种读取类调用要在哪个路径上做判定。
 *
 * `glob`/`ops_glob` 先单独处理：它们的 `pattern` **是模式不是路径**，即使看起来像
 * `C:/x/.env` 也不能当路径（`pathFromArgs` 的兜底会把 `pattern` 当路径取出来）。
 * 路径字段优先，没有路径字段时用模式里的字面前缀。
 *
 * 其余读取类工具（`read`、`ops_inspect_local_file`）取 `file_path`/`path`；
 * 搜索工具（`grep`、`ops_grep`）的目标目录在 `path` 字段，没写时算在工作区里搜索。
 *
 * @param {unknown} args - 工具入参。
 * @param {string} tool - 工具名（大小写不敏感）。
 * @param {string|undefined} cwd - 会话工作区。
 * @returns {{target: string, display: string}|null} 判定用的路径；没有可判定的路径时返回 null。
 */
function targetOf(args, tool, cwd) {
  if (PATTERN_TOOLS.has(String(tool).toLowerCase())) {
    const record = asRecord(args);
    const path = record?.['file_path'] ?? record?.path;
    if (typeof path === 'string' && path.trim() !== '') return { target: path.trim(), display: path.trim() };
    const pattern = record?.pattern;
    const prefix = patternStaticPrefix(pattern);
    if (prefix === undefined || typeof cwd !== 'string' || cwd === '') return null;
    // 日志里显示完整模式，比只显示前缀更接近事实。
    return { target: prefix, display: String(pattern).trim() };
  }
  const path = pathFromArgs(args);
  return path === undefined ? null : { target: path, display: path };
}

/**
 * 一次读取是否该被拦下。
 *
 * @param {unknown} args - 工具入参。
 * @param {string} cwd - 会话工作区（相对路径的解析基准）。
 * @param {{sensitive?: string[], sensitiveAllow?: string[]}} [settings] - 解析后的配置。
 * @returns {boolean} true 表示命中敏感名单且不在任何豁免里。
 */
export function isSensitiveRead(args, cwd, settings) {
  const found = targetOf(args, settings?.tool, cwd);
  if (found === null || typeof cwd !== 'string' || cwd === '') return false;
  const resolved = resolvePath(found.target, cwd);
  if (anyHit(settings?.sensitiveAllow ?? [], resolved)) return false;
  return anyHit(settings?.sensitive ?? [], resolved);
}

/**
 * 一次读取类调用的判定；纯函数，无副作用。
 *
 * @param {{args: unknown, cwd: string, settings?: object}} input
 * @returns {{kind: 'sensitive-read', target: string}|null} 命中敏感名单时给出目标；其余返回 null。
 */
export function classifyRead(input) {
  const { args, cwd, settings } = input;
  const found = targetOf(args, settings?.tool, cwd);
  if (found === null || typeof cwd !== 'string' || cwd === '') return null;
  if (!isSensitiveRead(args, cwd, settings)) return null;
  return { kind: 'sensitive-read', target: found.target };
}

/** 展示用：把绝对路径尽量写成相对工作区的形式；在工作区外时原样返回。 */
export function displayTarget(target, cwd) {
  const resolved = resolvePath(target, cwd);
  const workspace = normalize(slashes(cwd).replace(/\/+$/, ''));
  if (resolved === workspace) return '.';
  return resolved.startsWith(`${workspace}/`) ? resolved.slice(workspace.length + 1) : resolved;
}
