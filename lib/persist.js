/**
 * drift-guard 的跨重启状态持久化。
 *
 * 插件状态都存在内存里（`STATE` WeakMap），DSH 重启后 `calls`、`active`、S4/S6 计数、
 * `reminders`、`todo` 快照、`handoff` 都会归零；`C` 每次现读，所以第一次工具调用后 R 能重算，
 * 但 `D = 0`、`calls` 从 0 起、N 的平均调用数被压低，长会话续跑时 R 与提醒节奏会失真。
 *
 * 本模块只做"计数状态"的读写：
 *   - 位置：`<工作区>/.drift/state/<sessionId>.json`（工作区内，按根会话 id 区分）；
 *   - 只存计数与信号簿记，**不存**工具参数/结果/聊天内容；
 *   - 不恢复 S1–S3 的 recent 签名（避免用陈旧参数误判），只恢复 `calls`、`active`（D 的衰减基准）、
 *     S4/S6 的计数与基线、`reminders`、`todo` 计数、`handoff`、`handoffTemplateSent`；
 *   - R 本身不存（C 会变），第一次调用后由 `handoffRatio()` 重算。
 *
 * 任何读写错误都不抛给调用方：状态文件坏了就当没有，保存失败只影响下次重启的恢复。
 *
 * @module dsh-drift-guard/persist
 */

import fs from 'node:fs';
import path from 'node:path';

import { ALERT_DIR } from './alerts.js';

/** 状态文件格式版本；字段不兼容时整份丢弃。 */
export const STATE_VERSION = 1;

/** 状态文件子目录（相对 `.drift`）。 */
const STATE_SUBDIR = 'state';

/** active 里允许持久化的信号名。 */
const ACTIVE_KEYS = ['s1', 's2', 's3', 's4', 's6'];

/** 非负有限数才算有效计数。 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 从会话对象上取根会话 id；取不到时不持久化。 */
function sessionIdOf(session) {
  const id = session?.header?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** 文件名安全化：session id 来自宿主，仍不让它带路径分隔符。 */
function safeName(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * 状态文件的绝对路径；没有工作区或 session id 时返回 undefined。
 *
 * @param {string|undefined} cwd
 * @param {object|undefined} session
 * @returns {string|undefined}
 */
export function stateFile(cwd, session) {
  const id = sessionIdOf(session);
  if (typeof cwd !== 'string' || cwd === '' || id === undefined) return undefined;
  return path.join(cwd, ALERT_DIR, STATE_SUBDIR, `${safeName(id)}.json`);
}

/** 序列化 `active`，只留允许的信号名。 */
function encodeActive(active) {
  const out = {};
  for (const key of ACTIVE_KEYS) {
    if (finite(active?.[key])) out[key] = active[key];
  }
  return out;
}

/** 序列化 S4 的进度源与基线。 */
function encodeS4(s4) {
  const out = {
    count: finite(s4?.count) ? s4.count : 0,
    alerted: finite(s4?.alerted) ? s4.alerted : 0,
  };
  if (s4?.source === 'todo' || s4?.source === 'plan') out.source = s4.source;
  if (finite(s4?.baseline)) out.baseline = s4.baseline;
  return out;
}

/** 序列化 S6 的计数（v0.3 阶段 3 才会在信号状态里出现）。 */
function encodeS6(s6) {
  if (s6 === null || typeof s6 !== 'object') return undefined;
  return {
    count: finite(s6.count) ? s6.count : 0,
    alerted: finite(s6.alerted) ? s6.alerted : 0,
  };
}

/** 序列化提醒簿记；只留数字与 R 的两个布尔/层级字段。 */
function encodeReminders(reminders) {
  const out = {};
  for (const [key, book] of Object.entries(reminders ?? {})) {
    if (book === null || typeof book !== 'object') continue;
    const item = {};
    if (finite(book.alerts)) item.alerts = book.alerts;
    if (finite(book.lastCall)) item.lastCall = book.lastCall;
    if (key === 'r') {
      if (book.capAlerted === true) item.capAlerted = true;
      if (finite(book.rTier)) item.rTier = book.rTier;
    }
    out[key] = item;
  }
  return out;
}

/** 序列化 todo 计数；不存条目正文。 */
function encodeTodo(todo) {
  if (todo === null || typeof todo !== 'object') return undefined;
  if (!finite(todo.completed) || !finite(todo.pending) || !finite(todo.inProgress)) return undefined;
  return { completed: todo.completed, pending: todo.pending, inProgress: todo.inProgress };
}

/** 序列化交接状态（阶段 5 才会写）。 */
function encodeHandoff(handoff) {
  if (handoff === null || typeof handoff !== 'object') return null;
  const out = {};
  if (finite(handoff.at)) out.at = handoff.at;
  if (typeof handoff.progressStamp === 'string') out.progressStamp = handoff.progressStamp;
  if (handoff.completed === true) out.completed = true;
  if (finite(handoff.completedAt)) out.completedAt = handoff.completedAt;
  if (typeof handoff.via === 'string') out.via = handoff.via;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 把一份会话状态编码成可落盘的 JSON 对象。
 *
 * @param {{cwd?: string, handoff?: object|null, handoffTemplateSent?: boolean}} state
 * @param {object} session
 * @param {{signals?: object, reminders?: object, todo?: object}} entry
 * @returns {object|undefined}
 */
export function encodeState(state, session, entry) {
  const id = sessionIdOf(session);
  if (id === undefined) return undefined;
  const signals = entry?.signals ?? {};
  const s6 = encodeS6(signals.s6);
  return {
    version: STATE_VERSION,
    sessionId: id,
    cwd: typeof state?.cwd === 'string' ? state.cwd : undefined,
    savedAt: new Date().toISOString(),
    calls: finite(signals.calls) ? signals.calls : 0,
    active: encodeActive(signals.active),
    s4: encodeS4(signals.s4),
    ...(s6 === undefined ? {} : { s6 }),
    todo: encodeTodo(entry?.todo),
    reminders: encodeReminders(entry?.reminders),
    handoff: encodeHandoff(state?.handoff),
    handoffTemplateSent: state?.handoffTemplateSent === true,
  };
}

/** 解码时只收非负有限数。 */
function decodeNumber(value) {
  return finite(value) ? value : undefined;
}

/**
 * 校验并解码一份状态文件；版本不符、session 不符、结构不对时返回 undefined。
 *
 * @param {unknown} raw - `JSON.parse` 的结果。
 * @param {object} session
 * @returns {object|undefined}
 */
export function decodeState(raw, session) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (raw.version !== STATE_VERSION) return undefined;
  const id = sessionIdOf(session);
  if (id === undefined || raw.sessionId !== id) return undefined;

  const active = {};
  for (const key of ACTIVE_KEYS) {
    const value = decodeNumber(raw.active?.[key]);
    if (value !== undefined) active[key] = value;
  }
  const s4 = {
    count: decodeNumber(raw.s4?.count) ?? 0,
    alerted: decodeNumber(raw.s4?.alerted) ?? 0,
  };
  if (raw.s4?.source === 'todo' || raw.s4?.source === 'plan') s4.source = raw.s4.source;
  const s4Baseline = decodeNumber(raw.s4?.baseline);
  if (s4Baseline !== undefined) s4.baseline = s4Baseline;

  const reminders = {};
  for (const [key, book] of Object.entries(raw.reminders ?? {})) {
    if (book === null || typeof book !== 'object') continue;
    const item = {};
    const alerts = decodeNumber(book.alerts);
    const lastCall = decodeNumber(book.lastCall);
    if (alerts !== undefined) item.alerts = alerts;
    if (lastCall !== undefined) item.lastCall = lastCall;
    if (key === 'r') {
      if (book.capAlerted === true) item.capAlerted = true;
      const tier = decodeNumber(book.rTier);
      if (tier !== undefined) item.rTier = tier;
    }
    reminders[key] = item;
  }

  const todo = raw.todo === null || typeof raw.todo !== 'object'
    ? undefined
    : (finite(raw.todo.completed) && finite(raw.todo.pending) && finite(raw.todo.inProgress)
      ? { completed: raw.todo.completed, pending: raw.todo.pending, inProgress: raw.todo.inProgress }
      : undefined);

  const handoff = raw.handoff === null || typeof raw.handoff !== 'object'
    ? null
    : encodeHandoff(raw.handoff);

  const s6 = raw.s6 === null || typeof raw.s6 !== 'object'
    ? undefined
    : { count: decodeNumber(raw.s6.count) ?? 0, alerted: decodeNumber(raw.s6.alerted) ?? 0 };

  return {
    calls: decodeNumber(raw.calls) ?? 0,
    active,
    s4,
    ...(s6 === undefined ? {} : { s6 }),
    todo,
    reminders,
    handoff,
    handoffTemplateSent: raw.handoffTemplateSent === true,
  };
}

/**
 * 把解码后的状态合并进一份 `createSessionSignals()` 的产物。
 *
 * 只改计数、`active`、S4/S6、`todo`、`reminders`；R、S1–S3 的 recent 签名不动。
 *
 * @param {object} entry - `{signals, reminders, todo}`
 * @param {object|undefined} restored - `decodeState()` 的产物。
 * @returns {boolean} 是否合并了内容。
 */
export function applyEntry(entry, restored) {
  if (restored === undefined || restored === null || entry === null || typeof entry !== 'object') return false;
  if (entry.signals === null || typeof entry.signals !== 'object') return false;
  entry.signals.calls = restored.calls;
  entry.signals.active = { ...(entry.signals.active ?? {}), ...restored.active };
  entry.signals.s4 = { ...(entry.signals.s4 ?? {}), ...restored.s4 };
  if (restored.s6 !== undefined) {
    entry.signals.s6 = { count: 0, alerted: 0, ...(entry.signals.s6 ?? {}), ...restored.s6 };
  }
  if (restored.todo !== undefined) entry.todo = restored.todo;
  for (const [key, book] of Object.entries(restored.reminders ?? {})) {
    if (entry.reminders?.[key] !== undefined) Object.assign(entry.reminders[key], book);
  }
  return true;
}

/**
 * 读取并解码状态文件；文件不存在、损坏或版本不符时返回 undefined。
 *
 * @param {string|undefined} cwd
 * @param {object|undefined} session
 * @returns {object|undefined}
 */
export function loadState(cwd, session) {
  const file = stateFile(cwd, session);
  if (file === undefined) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 同一份状态文件被复制到别的工作区时不要恢复：cwd 对不上就当没有。
    if (typeof raw?.cwd === 'string' && raw.cwd !== ''
      && path.resolve(raw.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) {
      return undefined;
    }
    return decodeState(raw, session);
  } catch {
    return undefined;
  }
}

/**
 * 把状态写回 `<工作区>/.drift/state/<sessionId>.json`。
 *
 * 先写临时文件再替换；任何失败都吞掉（只影响下次重启的恢复，不影响当前工具调用）。
 *
 * @param {{cwd?: string, handoff?: object|null, handoffTemplateSent?: boolean}} state
 * @param {object|undefined} session
 * @param {object|undefined} entry
 * @returns {boolean} 是否写入成功。
 */
export function saveState(state, session, entry) {
  const file = stateFile(state?.cwd, session);
  if (file === undefined || entry === undefined || entry === null) return false;
  const data = encodeState(state, session, entry);
  if (data === undefined) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = `${JSON.stringify(data)}\n`;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows 上目标存在时 rename 可能失败：退回复制覆盖。
      fs.copyFileSync(tmp, file);
      fs.rmSync(tmp, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}
