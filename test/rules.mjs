/**
 * 规则层测试：五条合规检查的判定与记录（不依赖模型、不依赖 DSH 实例）。
 * 运行：node test/rules.mjs
 */
import {
  checkSensitiveRead,
  checkWriteTarget,
  noteFailure,
  noteOutsideRead,
  readTarget,
} from '../lib/rules.js';
import { resolveConfig } from '../lib/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-guard-rules-'));
const CWD = path.join(SANDBOX, 'workspace');
fs.mkdirSync(CWD, { recursive: true });

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
}

const settings = resolveConfig({});
const freshState = () => ({
  cwd: CWD,
  alerts: [],
  seen: new Set(),
  logBroken: false,
  repeats: new Map(),
});
const ok = (text) => ({ isError: false, content: [{ type: 'text', text }] });
const exec = (name, args) => ({ name, arguments: args });
const approvedPlan = (entry) => ({
  status: 'ok',
  dir: CWD,
  approved: [{ status: entry, isDir: false }],
  checkedSteps: 1,
  uncheckedSteps: 1,
});

console.log('--- 规则 4：敏感读取 ---');
{
  const state = freshState();
  const denied = checkSensitiveRead(exec('read', { file_path: '.env' }), state, settings);
  check('命中敏感名单时返回 deny', denied?.kind, 'deny');
  check('deny 带自己的错误码', denied?.info, { name: 'DriftGuardBlockedError', code: 'DRIFT_GUARD_SENSITIVE_READ' });
  check('deny 原因写明命中敏感名单', denied?.reason.includes('命中敏感名单'), true);
  check('记录了一条 sensitive-read', state.alerts[0]?.type, 'sensitive-read');

  const allow = freshState();
  check('普通文件放行', checkSensitiveRead(exec('read', { file_path: 'src/main.py' }), allow, settings), null);
  check('非读取工具不在这里判', checkSensitiveRead(exec('write', { file_path: '.env' }), allow, settings), null);
  check('放行时不记日志', allow.alerts.length, 0);
}

console.log('--- 规则 2：越界写入 ---');
{
  const state = freshState();
  const denied = checkWriteTarget(exec('write', { file_path: path.join(SANDBOX, 'outside.txt') }), state, approvedPlan('x.txt'));
  check('工作区外写入返回 deny', denied?.kind, 'deny');
  check('deny 带越界错误码', denied?.info.code, 'DRIFT_GUARD_OUTSIDE_WORKSPACE');
  check('记录了一条 outside', state.alerts[0]?.type, 'outside');
}
{
  const state = freshState();
  check('非写工具直接放行', checkWriteTarget(exec('read', { file_path: 'a.txt' }), state, approvedPlan('a.txt')), null);
  check('未批准写入只记录、不拦', checkWriteTarget(exec('write', { file_path: 'src/a.py' }), state, approvedPlan('b.py')), null);
  check('记录了一条 unapproved', state.alerts[0]?.type, 'unapproved');
}
{
  const state = freshState();
  check('已批准写入放行且不记录', checkWriteTarget(exec('edit', { file_path: 'src/a.py' }), state, approvedPlan('src/a.py')), null);
  check('没有记录', state.alerts.length, 0);
}

console.log('--- 规则 3：失败重试 ---');
{
  const state = freshState();
  const call = exec('ops_bash', { command: 'exit 1' });
  const bad = { isError: true, content: [] };
  const seq = [1, 2, 3].map(() => noteFailure(state, call, bad, settings)?.count ?? null);
  check('连续失败 3 次才提醒', seq, [null, null, 3]);
  check('提醒写进了记录', state.alerts[0]?.type, 'repeat');
  const good = { isError: false, content: [] };
  noteFailure(state, call, good, settings);
  check('成功一次后计数清零', [1, 2].map(() => noteFailure(state, call, bad, settings)?.count ?? null), [null, null]);
}

console.log('--- 规则 5：工作区外读取 ---');
{
  const state = freshState();
  const outside = path.join(SANDBOX, 'notes.md');
  fs.writeFileSync(outside, 'x', 'utf8');
  const alert = noteOutsideRead(state, exec('read', { file_path: outside }), ok('内容'));
  check('工作区外读取记一条', alert?.type, 'outside-read');
  check('记录里保留完整路径', alert?.target.includes('notes.md'), true);
  check('没有记录第二条', state.alerts.length, 1);
}
{
  const state = freshState();
  check('工作区内读取不记', noteOutsideRead(state, exec('read', { file_path: path.join(CWD, 'a.txt') }), ok('内容')), null);
  check('失败的调用不记', noteOutsideRead(state, exec('read', { file_path: path.join(SANDBOX, 'x.md') }), { isError: true }), null);
  check('搜索工具不带 path 不算越界', noteOutsideRead(state, exec('grep', { pattern: 'x' }), ok('no match')), null);
}

console.log('--- 目标路径提取 ---');
{
  check('read 取 file_path', readTarget({ file_path: 'a.txt' }, 'read', CWD)?.target, 'a.txt');
  check('grep 不带 path 视为工作区', readTarget({ pattern: 'x' }, 'grep', CWD)?.target, '.');
  check('glob 的绝对 pattern 取字面前缀', readTarget({ pattern: `${SANDBOX}/notes/**/*.md` }, 'ops_glob', CWD)?.target !== undefined, true);
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
