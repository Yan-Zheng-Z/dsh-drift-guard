/**
 * drift-guard v0.2 分级提醒测试：级别、冷却、最高级优先、追加不改原文、只记日志的几种情况。
 * 运行：node test/alerts.mjs（任意目录都可运行；日志写在临时沙箱里）
 */
import {
  apply,
  createSessionSignals,
  chooseReminder,
  observeCall,
  trackCall,
  handoffRatio,
  signalText,
  reminderText,
  forwardReminderText,
  appendReminder,
  appendTarget,
  recordSignalAlert,
  alertLine,
  levelTag,
  ratioReport,
  handoffReport,
  formatDriftReport,
  stateOf,
  SIGNAL_NAME,
  LEVEL_ADVICE,
  HANDOFF_TEMPLATE,
} from '../lib/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-guard-alerts-'));
let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
}

const ok = (text) => ({ isError: false, content: [{ type: 'text', text }] });
const BASE = {
  s1Repeats: 4,
  s2Alternations: 6,
  s3Reads: 3,
  s4IdleCalls: 20,
  failureRepeats: 3,
  cooldownCalls: 10,
};

console.log('--- 分级文案 ---');
check('第 1 级提醒块（三行、带分隔线）', reminderText(1, SIGNAL_NAME.s3, 'read 已连续 3 次读取未修改的 a.py').split('\n'), [
  '---',
  '[drift-guard 第1级] S3 重复读取：read 已连续 3 次读取未修改的 a.py',
  '建议：重新阅读 PLAN.md 和用户原始要求，确认方向后继续。',
]);
check('第 2 级建议是停下来汇报', LEVEL_ADVICE[2], '停下来向用户汇报：已尝试什么、卡在哪、新方案，等待用户决定。');
check('第 3 级建议是先告诉用户、等回复后再写', LEVEL_ADVICE[3], '先在本轮回复里明确告诉用户"建议现在交接"，等用户回复后再按交接流程写 PROGRESS.md。');
check('级别缺失时标签为空串', levelTag(undefined), '');
check('第 3 级提醒块里带信号名与事实', reminderText(3, SIGNAL_NAME.r, '交接收益比 R ≈ 1.20（C ≈ 200000 token、N = 20、D = 0.00）').split('\n')[1], '[drift-guard 第3级] R 交接收益比：交接收益比 R ≈ 1.20（C ≈ 200000 token、N = 20、D = 0.00）');

console.log('\n--- 子智能体的第 3 级转交主会话时的文案 ---');
{
  // 第 3 级的建议（写 PROGRESS.md、让用户开新会话）是针对"自己打转"的主体说的；
  // 转交给主会话时改成第 2 级的说法，并写明是哪个子智能体在打转。
  const alert = { type: 's1', count: 4, tool: 'read', fact: '同一工具 + 相同参数 + 相同结果已连续 4 次（tool=read）' };
  const forward = forwardReminderText(alert, 'sub-42').split('\n');
  check('转交块是第 2 级', forward[1], '[drift-guard 第2级] 子智能体 sub-42 可能在打转：同一工具 + 相同参数 + 相同结果已连续 4 次（tool=read）');
  check('转交块用第 2 级的建议', forward[2], `建议：${LEVEL_ADVICE[2]}`);
  check('转交块里没有"交接/开新会话"的文案', [
    forward.join('\n').includes('PROGRESS.md'),
    forward.join('\n').includes('开新会话'),
  ], [false, false]);
  check('转交块里列出信号事实', forward[1].includes('连续 4 次'), true);
  check('拿不到子智能体 id 时也说得通', forwardReminderText(alert, undefined).split('\n')[1], '[drift-guard 第2级] 某个子智能体（未记录 id）可能在打转：同一工具 + 相同参数 + 相同结果已连续 4 次（tool=read）');
  check('主会话自己的第 3 级仍用原建议', reminderText(3, SIGNAL_NAME.s1, alert.fact).includes(LEVEL_ADVICE[3]), true);
}

console.log('\n--- 追加：只加一块、不动原文 ---');
const original = [{ type: 'text', text: '工具结果原文' }];
{
  const appended = appendReminder(original, '提醒');
  check('追加后长度 +1', appended.length, 2);
  check('原块按同一引用保留', appended[0] === original[0], true);
  check('原数组没被改动', original.length, 1);
  check('追加的是文本块', appended[1], { type: 'text', text: '提醒' });
}
{
  const downstreamContent = [{ type: 'text', text: '下游改过的内容' }];
  const appended = appendTarget({ kind: 'accept', content: downstreamContent }, original, '提醒');
  check('下游替换过 content 时追加到它后面', appended.map((block) => block.text), ['下游改过的内容', '提醒']);
  check('下游的数组也没被改动', downstreamContent.length, 1);
}
check('下游没有给 content 时追加到原结果后面', appendTarget({ kind: 'accept' }, original, '提醒').map((block) => block.text), ['工具结果原文', '提醒']);

console.log('\n--- 这几种情况只记日志、不追加 ---');
check('结果已被 block', appendTarget({ kind: 'block', feedback: [] }, original, '提醒'), null);
check('下游替换了 value（不能再给 content）', appendTarget({ kind: 'accept', value: { a: 1 } }, original, '提醒'), null);
check('原结果的 content 不是数组（undefined）', appendTarget({ kind: 'accept' }, undefined, '提醒'), null);
check('原结果的 content 不是数组（字符串）', appendTarget({ kind: 'accept' }, '文本', '提醒'), null);
check('原结果的 content 不是数组（对象）', appendTarget({ kind: 'accept' }, { type: 'text' }, '提醒'), null);
check('下游给的 content 不是数组', appendTarget({ kind: 'accept', content: '文本' }, original, '提醒'), null);
check('下游没有返回决策', appendTarget(undefined, original, '提醒'), null);
check('content 不是数组时追加助手也返回 null', appendReminder(undefined, '提醒'), null);

console.log('\n--- 级别与冷却 ---');
{
  const entry = createSessionSignals();
  entry.signals.calls = 3;
  entry.signals.s3.count = 3;
  const hit = { signal: 's3', count: 3, tool: 'read', path: 'a.py', target: 'a.py' };
  check('首次触发是第 1 级', chooseReminder(entry, [hit], BASE)?.level, 1);
  check('没有命中时什么都不选', chooseReminder(entry, [], BASE), null);
  check('一次只选一条', Array.isArray(chooseReminder(entry, [hit], BASE)), false);
  // 模拟投递后的簿记（index.js 的 noteReminder 做这件事，这里直接构造）
  entry.reminders.s3.alerts = 1;
  entry.reminders.s3.lastCall = 3;
  entry.signals.calls = 8;
  entry.signals.s3.count = 6;
  check('冷却期内的再次触发不提醒', chooseReminder(entry, [{ ...hit, count: 6 }], BASE), null);
  entry.signals.calls = 12;
  check('差一次没走完冷却也不提醒', chooseReminder(entry, [{ ...hit, count: 6 }], BASE), null);
  entry.signals.calls = 13;
  check('冷却走完后是第 2 级', chooseReminder(entry, [{ ...hit, count: 6 }], BASE)?.level, 2);
}
{
  const entry = createSessionSignals();
  entry.signals.calls = 60;
  check('R 恒为第 3 级', chooseReminder(entry, [{ signal: 'r', count: 60, ratio: { R: 1.2 } }], BASE)?.level, 3);
}
{
  const entry = createSessionSignals();
  entry.signals.calls = 20;
  entry.signals.s1.count = 4;
  entry.signals.s3.count = 3;
  check('两个信号同时处于触发状态时升到第 3 级', chooseReminder(entry, [{ signal: 's3', count: 3, tool: 'read', path: 'a.py' }], BASE)?.level, 3);
}
{
  const entry = createSessionSignals();
  entry.signals.calls = 20;
  entry.signals.s1.count = 4;
  entry.signals.s3.count = 3;
  const hits = [
    { signal: 's1', count: 4, tool: 'write' },
    { signal: 's3', count: 3, tool: 'read', path: 'a.py' },
  ];
  check('级别相同时按 r→s1 的顺序取', chooseReminder(entry, hits, BASE)?.hit.signal, 's3');
}
{
  const entry = createSessionSignals();
  entry.signals.calls = 20;
  entry.signals.s3.count = 3;
  const hits = [
    { signal: 's3', count: 3, tool: 'read', path: 'a.py' },
    { signal: 'r', count: 20, ratio: { R: 1.2 } },
  ];
  check('不同级别时取级别最高的', chooseReminder(entry, hits, BASE)?.hit.signal, 'r');
}
{
  const entry = createSessionSignals();
  entry.signals.calls = 20;
  entry.signals.s1.count = 1;
  entry.signals.s3.count = 3;
  const hit = { signal: 's3', count: 3, tool: 'read', path: 'a.py' };
  check('只有一个信号处于触发状态时是第 1 级', chooseReminder(entry, [hit], BASE)?.level, 1);
}

console.log('\n--- 记录与日志行 ---');
{
  const state = { cwd: SANDBOX, seen: new Set(), alerts: [], logBroken: false };
  const alert = {
    type: 's3',
    level: 1,
    count: 3,
    tool: 'read',
    path: 'a.py',
    fact: 'read 已连续 3 次读取未修改的 a.py',
    at: Date.now(),
  };
  check('记下一条提醒', recordSignalAlert(state, alert) === alert, true);
  check('重复的同一条不再记', recordSignalAlert(state, alert), null);
  const line = alertLine(state.alerts[0]);
  check('日志行带级别、信号名与事实', [
    line.includes('第1级'),
    line.includes('S3 重复读取'),
    line.includes('已连续 3 次读取未修改的 a.py'),
  ], [true, true, true]);
  const log = fs.readFileSync(path.join(SANDBOX, '.drift', 'alerts.log'), 'utf8');
  check('日志文件里也是带级别的一行', log.includes('第1级 S3 重复读取'), true);
}
check('第 3 级的日志行', alertLine({ type: 'r', level: 3, count: 60, fact: '交接收益比 R ≈ 1.20（C ≈ 200000 token、N = 20、D = 0.00）', at: 0 }).includes('第3级 R 交接收益比：交接收益比 R ≈ 1.20'), true);
check('S6 的日志行带级别与名称', alertLine({ type: 's6', level: 1, fact: '连续 12 次工具调用没有写入文件', at: 0 }).includes('第1级 S6 漫游调用：连续 12 次工具调用没有写入文件'), true);
check('所有已命名信号都不落“未知提醒类型”', Object.keys(SIGNAL_NAME).filter((key) => alertLine({ type: key, level: 1, fact: 'x', at: 0 }).includes('未知提醒类型')), []);
check('v0.1 的提醒行不带级别标签', alertLine({ type: 'unapproved', at: 0, tool: 'write', target: 'b.py', relative: 'b.py' }).includes('第'), false);

console.log('\n--- 端到端：真实命中 → 选级 → 拼出追加块 ---');
{
  const entry = createSessionSignals();
  const file = path.join(SANDBOX, 'repeat.txt');
  fs.writeFileSync(file, 'x\n');
  let picked = null;
  for (let i = 0; i < 13; i += 1) {
    const hits = observeCall(entry.signals, { tool: 'read', args: { file_path: file }, result: ok('同一份内容'), cwd: SANDBOX }, BASE);
    picked = chooseReminder(entry, hits, BASE) ?? picked;
  }
  check('真实的 M1 饱和命中被选成第 1 级', [picked?.hit.signal, picked?.level], ['s6', 1]);
  const block = reminderText(picked.level, SIGNAL_NAME[picked.hit.signal], signalText(picked.hit));
  const appended = appendTarget({ kind: 'accept' }, [{ type: 'text', text: '原文' }], block);
  check('追加块里带 S6 的名字与事实', [appended[0].text, appended[1].text.includes('S6 漫游调用'), appended[1].text.includes('read')], ['原文', true, true]);
}

console.log('\n--- 会话归属与投递（要求 1、2）---');
const freshState = () => ({
  cwd: SANDBOX,
  seen: new Set(),
  alerts: [],
  logBroken: false,
  bySession: new WeakMap(),
  pendingMain: null,
});
const fakeSession = (id) => ({ id, header: { cwd: SANDBOX } });
const rootSession = fakeSession('root');
const childSession = fakeSession('child');
{
  // 检测按会话分开计数：主会话读 12 次、子智能体读 1 次，谁都没凑够自己的饱和窗口
  const state = freshState();
  const file = path.join(SANDBOX, 'shared.txt');
  fs.writeFileSync(file, 's\n');
  const mainCall = (i) => trackCall(state, { session: rootSession, isMain: true, tool: 'read', args: { file_path: file }, result: ok('同一份内容'), cwd: SANDBOX }, BASE);
  const childCall = () => trackCall(state, { session: childSession, isMain: false, tool: 'read', args: { file_path: file }, result: ok('子'), cwd: SANDBOX }, BASE);
  const early = [];
  for (let i = 1; i <= 12; i += 1) early.push(mainCall(i));
  check('主会话读 12 次不触发', early, Array(12).fill(null));
  check('子智能体读 1 次也不触发（计数按会话分开）', childCall(), null);
  check('主会话再读 1 次才凑够自己的饱和窗口', mainCall(13)?.level, 1);
}
{
  // R 只统计主会话自己的调用：子智能体的上下文规模不进主会话的账
  const state = freshState();
  const settings = { ...BASE, cooldownCalls: 99 };
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    last = trackCall(state, {
      session: childSession, isMain: false, tool: 'write', args: { file_path: `c${i}.py` }, result: ok(`c${i}`), cwd: SANDBOX, contextTokens: 999999,
    }, settings);
  }
  check('子智能体的高上下文不产生 R 提醒', last, null);
  const mainCall = (i) => trackCall(state, {
    session: rootSession, isMain: true, tool: 'write', args: { file_path: `m${i}.py` }, result: ok(`m${i}`), cwd: SANDBOX, contextTokens: 200000,
  }, settings);
  const first = mainCall(0);
  check('主会话上下文到 200000 时（N = 20）触发 R（第 3 级）', [first?.alert.type, first?.level], ['r', 3]);
  check('主会话的 R 构成留给了 /drift', [state.ratio.C, Math.round(state.ratio.N), state.ratio.R > 1], [200000, 20, true]);
  check('子智能体那 3 次的上下文没有混进主会话的账', state.bySession.get(rootSession).signals.calls, 1);
}
{
  // 第 3 级只追加到主会话：子智能体交替 + todo 停滞同时成立（两个机理）→ 第 3 级
  const state = freshState();
  const todo = { completed: 0, pending: 2, inProgress: 0 };
  const childCall = (i) => trackCall(state, {
    session: childSession,
    isMain: false,
    tool: 'read',
    args: { file_path: i % 2 === 0 ? 'a.txt' : 'b.txt' },
    result: ok(`内容 ${i}`),
    todo,
    cwd: SANDBOX,
  }, BASE);
  const childSeq = [];
  for (let i = 1; i <= 21; i += 1) childSeq.push(childCall(i));
  check('子智能体第 12 次拿到第 1 级', childSeq[11]?.level, 1);
  check('子智能体第 21 次的第 3 级不追加给它', childSeq[20], null);
  check('第 3 级挂到主会话待投递', state.pendingMain?.level, 3);
  const mainCall = trackCall(state, { session: rootSession, isMain: true, tool: 'write', args: { file_path: 'x.py' }, result: ok('x'), cwd: SANDBOX }, BASE);
  check('主会话的下一次工具结果拿到挂起的第 3 级', [mainCall?.alert.type, mainCall?.level], ['s4', 3]);
  check('挂起被消费掉', state.pendingMain, null);
}

console.log('\n--- 管线集成：子智能体的第 3 级如何转交到主会话 ---');
{
  /** 只够跑通插件的最小 ctx：把两个监听器与 /drift 命令收下来。 */
  function fakeCtx() {
    const listeners = {};
    return {
      listeners,
      effect(generator) {
        for (const registered of generator()) void registered;
      },
      on(name, handler) {
        listeners[name] = handler;
        return () => {};
      },
      commands: { register: () => () => {} },
    };
  }
  const home = path.join(SANDBOX, 'forward');
  fs.mkdirSync(home, { recursive: true });
  const childFile = path.join(home, 'child-repeat.txt');
  fs.writeFileSync(childFile, 'c\n');
  const mainSession = { id: 'main', header: { cwd: home } };
  // 子智能体在宿主里是主会话的派生会话（有 parent）；这一点决定了它算不算"主会话"
  const childSession = { id: 'child', header: { cwd: home }, parent: mainSession };
  const ctx = fakeCtx();
  apply(ctx, { ...BASE, cooldownCalls: 1 });
  const pre = ctx.listeners['tools/pre-execute'];
  const post = ctx.listeners['tools/post-execute'];
  const accept = async () => ({ kind: 'accept' });
  const result = (text) => ({ isError: false, content: [{ type: 'text', text }] });
  const childRead = { name: 'read', arguments: { file_path: childFile }, agent: { id: 'sub-42', session: childSession } };
  const mainWrite = { name: 'write', arguments: { file_path: path.join(home, 'main.py') }, agent: { id: 'main-agent', session: mainSession } };

  // 子智能体：先写一次 todo（制造"有剩余项"的进度源），再交替读两个文件 21 次。
  const childTodo = { name: 'todo_write', arguments: { todos: [{ status: 'pending' }, { status: 'pending' }] }, agent: { id: 'sub-42', session: childSession } };
  await pre(childTodo, accept);
  await post(childTodo, result('已更新'), accept);
  fs.writeFileSync(path.join(home, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(home, 'b.txt'), 'b\n');
  const childDecisions = [];
  for (let i = 1; i <= 21; i += 1) {
    const childRead = {
      name: 'read',
      arguments: { file_path: path.join(home, i % 2 === 0 ? 'a.txt' : 'b.txt') },
      agent: { id: 'sub-42', session: childSession },
    };
    await pre(childRead, accept);
    childDecisions.push(await post(childRead, result(`内容 ${i}`), accept));
  }
  check('子智能体第 12 次拿到第 1 级提醒', childDecisions[11].content?.length, 2);
  check('第 1 级不带交接模板', childDecisions[11].content[1].text.includes(HANDOFF_TEMPLATE), false);
  check('第 1 级不带用户通知', childDecisions[11].additionalContexts, undefined);
  check('子智能体自家触发的第 3 级不追加给它', childDecisions[20].content, undefined);

  await pre(mainWrite, accept);
  const mainDecision = await post(mainWrite, result('写入完成'), accept);
  check('主会话的下一次工具结果收到转交提醒', mainDecision.content?.length, 2);
  const line = mainDecision.content[1].text.split('\n');
  check('转交文案是第 2 级且写明子智能体 id', line[1], `[drift-guard 第2级] 子智能体 sub-42 可能在打转：${signalText({ signal: 's4', count: 20, source: 'todo', progress: 0 })}`);
  check('转交文案用第 2 级建议', line[2], `建议：${LEVEL_ADVICE[2]}`);
  check('转交文案里没有"开新会话"', line.join('\n').includes('开新会话'), false);
  check('转交的第 2 级文案不带用户通知', mainDecision.additionalContexts, undefined);
  check('主会话的写入结果原文保留', mainDecision.content[0].text, '写入完成');
}

console.log('\n--- 管线集成：注册真实监听器后，提醒如何落到工具结果上 ---');
{
  /** 只够跑通插件的最小 ctx：把两个监听器与 /drift 命令收下来。 */
  function fakeCtx() {
    const listeners = {};
    return {
      listeners,
      effect(generator) {
        // 迭代即执行 generator 里的 yield：注册监听器与命令。
        for (const registered of generator()) void registered;
      },
      on(name, handler) {
        listeners[name] = handler;
        return () => {};
      },
      commands: { register: () => () => {} },
    };
  }
  const home = path.join(SANDBOX, 'pipeline');
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'repeat.txt');
  fs.writeFileSync(file, 'p\n');
  const session = { id: 'pipeline', header: { cwd: home } };
  const ctx = fakeCtx();
  apply(ctx, { ...BASE, cooldownCalls: 1 });
  const pre = ctx.listeners['tools/pre-execute'];
  const post = ctx.listeners['tools/post-execute'];
  const exec = () => ({ name: 'read', arguments: { file_path: file }, agent: { session } });
  const results = [];
  for (let i = 1; i <= 15; i += 1) results.push({ isError: false, content: [{ type: 'text', text: '同一份内容' }] });
  const accept = async () => ({ kind: 'accept' });

  const decisions = [];
  for (let i = 0; i < 15; i += 1) {
    await pre(exec(), accept);
    decisions.push(await post(exec(), results[i], accept));
  }
  check('前 12 次读取的结果原样返回', [decisions[0].content, decisions[11].content], [undefined, undefined]);
  check('第 13 次读取在末尾追加一条提醒', decisions[12].content?.length, 2);
  check('原文按同一引用保留', decisions[12].content[0] === results[12].content[0], true);
  check('追加块的格式与级别', decisions[12].content[1].text.split('\n').slice(0, 2), [
    '---',
    '[drift-guard 第1级] S6 漫游调用：连续 12 次工具调用既没有带来新结果、也没有推进产物（最后一次 tool=read）',
  ]);
  check('第 14、15 次不再追加', [decisions[13].content, decisions[14].content], [undefined, undefined]);

  await pre(exec(), accept);
  const blocked = await post(exec(), results[5], async () => ({ kind: 'block', feedback: [{ type: 'text', text: '被下游拦下' }] }));
  check('结果已被 block 时原决策原样返回', [blocked.kind, blocked.content], ['block', undefined]);

  await pre(exec(), accept);
  const odd = await post(exec(), { isError: false, content: '不是数组' }, accept);
  check('content 不是数组时不追加', [odd.kind, odd.content], ['accept', undefined]);

  const log = fs.readFileSync(path.join(home, '.drift', 'alerts.log'), 'utf8');
  check('日志里记下了这次提醒（带级别）', log.includes('第1级 S6 漫游调用'), true);
}

console.log('\n--- 管线集成：R 用主会话的 tokenMeter，拿不到时按调用次数估算 ---');
{
  /** 最小 ctx：两个监听器 + 一个可替换的 tokenMeter（用来模拟拿得到/拿不到计量）。 */
  function fakeCtx(meter) {
    const listeners = {};
    const ctx = {
      listeners,
      effect(generator) {
        for (const registered of generator()) void registered;
      },
      on(name, handler) {
        listeners[name] = handler;
        return () => {};
      },
      commands: { register: () => () => {} },
    };
    if (meter !== undefined) ctx.tokenMeter = meter;
    return ctx;
  }
  const home = path.join(SANDBOX, 'tokens');
  fs.mkdirSync(home, { recursive: true });
  const accept = async () => ({ kind: 'accept' });
  const okResult = (text) => ({ isError: false, content: [{ type: 'text', text }] });
  /** 每个场景用**自己的会话与 ctx**：信号计数按会话累计，共用会把计数算歪。 */
  function scene(id, config, meter) {
    const session = { id, header: { cwd: home } };
    const ctx = fakeCtx(meter);
    apply(ctx, config);
    return {
      session,
      write: { name: 'write', arguments: { file_path: path.join(home, `${id}.txt`) }, agent: { id: 'a', session } },
      pre: ctx.listeners['tools/pre-execute'],
      post: ctx.listeners['tools/post-execute'],
    };
  }

  // 拿得到计量：C = 200000、N = 20（工作区里没有 PLAN.md）→ R = 1.2，第一次调用就够。
  // cooldownCalls 设大，避免后续重复提醒干扰断言。
  const measured = [];
  const measuredScene = scene('token-main', { cooldownCalls: 99 }, {
    measure: async (session) => {
      measured.push(session === measuredScene.session);
      return { totalTokens: 200000 };
    },
  });
  await measuredScene.pre(measuredScene.write, accept);
  const decision = await measuredScene.post(measuredScene.write, okResult('写入完成'), accept);
  check('R ≥ 1 时追加第 3 级提醒', decision.content?.length, 2);
  check('提醒块写的是 R 的构成', decision.content[1].text.includes('交接收益比 R ≈ 1.20（C ≈ 200000 token、N = 20、D = 0.00）'), true);
  check('提醒块用第 3 级建议', decision.content[1].text.includes(LEVEL_ADVICE[3]), true);
  check('tokenMeter 收到的是根会话', measured, [true]);

  // 拿不到计量（服务缺失）：同一次调用只估到 C = 1500，远不到 R = 1。
  const noMeter = scene('token-nometer', { cooldownCalls: 99 }, undefined);
  await noMeter.pre(noMeter.write, accept);
  const fallback = await noMeter.post(noMeter.write, okResult('写入完成'), accept);
  check('拿不到 token 计量时第一次调用不触发（C = 1500 < C₀）', [fallback.kind, fallback.content], ['accept', undefined]);

  // 回退估算：把 tokensPerCall 调大，同样的"拿不到计量"就应当触发，并注明 C 是估算值。
  const estimated = scene('token-estimate', { handoffRatio: { tokensPerCall: 200000 }, cooldownCalls: 99 }, undefined);
  await estimated.pre(estimated.write, accept);
  const byEstimate = await estimated.post(estimated.write, okResult('写入完成'), accept);
  check('按调用次数估算到 R ≥ 1 时触发', byEstimate.content?.length, 2);
  check('估算出来的 C 会注明', byEstimate.content[1].text.includes('C ≈ 200000 token（估算）'), true);

  // tokenMeter 抛异常：只记一条日志，工具结果照常返回（不追加、不断链）。
  const brokenScene = scene('token-broken', { cooldownCalls: 99 }, {
    measure: async () => { throw new Error('计量服务挂了'); },
  });
  await brokenScene.pre(brokenScene.write, accept);
  const broken = await brokenScene.post(brokenScene.write, okResult('写入完成'), accept);
  check('tokenMeter 抛异常时结果照常返回', [broken.kind, broken.content], ['accept', undefined]);
  check('异常只记一条日志、不改结果', (() => {
    const text = fs.readFileSync(path.join(home, '.drift', 'alerts.log'), 'utf8');
    return text.includes('内部错误（tokenMeter）：计量服务挂了');
  })(), true);

  // 子智能体不算 R：计量不读它的、也不给它投递（即便它自己的估算早就够了）。
  const parent = { id: 'token-parent', header: { cwd: home } };
  const child = { id: 'token-child', header: { cwd: home }, parent };
  const childMeasured = [];
  const ctxChild = fakeCtx({
    measure: async (session) => {
      childMeasured.push(session === child);
      return { totalTokens: 999999 };
    },
  });
  apply(ctxChild, { handoffRatio: { tokensPerCall: 200000 }, cooldownCalls: 99 });
  const preChild = ctxChild.listeners['tools/pre-execute'];
  const postChild = ctxChild.listeners['tools/post-execute'];
  const childWrite = {
    name: 'write',
    arguments: { file_path: path.join(home, 'child.txt') },
    agent: { id: 'sub-1', session: child },
  };
  await preChild(childWrite, accept);
  const childDecision = await postChild(childWrite, okResult('写入完成'), accept);
  check('子智能体的 R 命中不投递给它', [childDecision.kind, childDecision.content], ['accept', undefined]);
  check('也没有拿子智能体的 token 去凑 R（tokenMeter 里没有它）', childMeasured, []);
}

console.log('\n--- R 的再提醒门槛：固定倍增 1 → 2 → 4 → 8… ---');
{
  // 没有计划 → N = 20；R = (C − 20000) / 150000，所以 C = 20000 + 150000 × R。
  // 硬上限调到极大，先只看倍增门槛。
  const state = freshState();
  const settings = { ...BASE, cooldownCalls: 1, handoffRatio: { capTokens: 100000000 } };
  const call = (tokens) => trackCall(state, {
    session: rootSession,
    isMain: true,
    tool: 'write',
    args: { file_path: `ratio-${tokens}.py` },
    result: ok(`r${tokens}`),
    cwd: SANDBOX,
    contextTokens: tokens,
  }, settings);
  const first = call(170000);
  check('越过第 1 层（R = 1）时提醒', [first?.alert.type, first?.level], ['r', 3]);
  check('不到第 2 层（R = 1.53）不提醒', call(250000), null);
  check('差一点到第 2 层也不提醒', call(319999), null);
  check('越过第 2 层（R = 2）时提醒', call(320000)?.alert.type, 'r');
  check('不到第 3 层（R = 3.2）不提醒', call(500000), null);
  check('越过第 3 层（R = 4）时提醒', call(620000)?.alert.type, 'r');
  check('不到第 4 层（R = 6.53）不提醒', call(1000000), null);
  check('越过第 4 层（R = 8）时提醒', call(1220000)?.alert.type, 'r');
}
{
  // 门槛是"下一次要越过的固定层级"，不是"上次实际 R 的 2 倍"：
  // 上一次在 R = 3.2 时提醒，下一次门槛就是 4（而不是 6.4）
  const state = freshState();
  const settings = { ...BASE, cooldownCalls: 1, handoffRatio: { capTokens: 100000000 } };
  const call = (tokens) => trackCall(state, {
    session: rootSession,
    isMain: true,
    tool: 'write',
    args: { file_path: `ladder-${tokens}.py` },
    result: ok(`l${tokens}`),
    cwd: SANDBOX,
    contextTokens: tokens,
  }, settings);
  call(170000); // R = 1 → 提醒，层级走到 1
  check('R = 3.2 时提醒（越过第 2 层）', call(500000)?.alert.type, 'r');
  check('层级记到 2（下次门槛是 4，不是 6.4）', state.bySession.get(rootSession).reminders.r.rTier, 2);
  check('R = 4 就够（不是要 6.4）', call(620000)?.alert.type, 'r');
  check('层级记到 3（下次门槛 8）', state.bySession.get(rootSession).reminders.r.rTier, 3);
}
{
  // 硬上限只提醒一次，且纯上限提醒（R < 1）不推进倍增层级
  const state = freshState();
  const settings = { ...BASE, cooldownCalls: 1 };
  const call = (tokens, steps) => trackCall(state, {
    session: rootSession,
    isMain: true,
    tool: 'write',
    args: { file_path: `cap-${tokens}.py` },
    result: ok(`c${tokens}`),
    cwd: SANDBOX,
    contextTokens: tokens,
    ...steps,
  }, settings);
  const noWork = { checkedSteps: 3, uncheckedSteps: 0 }; // N = 0 → R = 0，只剩硬上限
  const first = call(600000, noWork);
  check('硬上限首次触达单独提醒一次', [first?.alert.type, first?.alert.ratio.capped, first?.alert.ratio.R], ['r', true, 0]);
  check('硬上限不再重复提醒', call(700000, noWork), null);
  check('纯上限提醒不推进层级', state.bySession.get(rootSession).reminders.r.rTier, 0);
  const byRatio = call(170000, undefined); // N = 20 → R = 1，属于越过第 1 层
  check('纯硬上限提醒之后，R 越过第 1 层仍会提醒', byRatio?.alert.type, 'r');
}
{
  // planComplete 一路从 trackCall 传到 R：计划已全部完成时 N=0，C 再涨也不触发交接提醒。
  const state = freshState();
  const settings = { ...BASE, cooldownCalls: 1, handoffRatio: { capTokens: 100000000 } };
  const call = (tokens) => trackCall(state, {
    session: rootSession,
    isMain: true,
    tool: 'write',
    args: { file_path: `complete-${tokens}.py` },
    result: ok(`p${tokens}`),
    cwd: SANDBOX,
    contextTokens: tokens,
    planComplete: true,
  }, settings);
  check('planComplete 传到 R：N = 0', [call(168755), state.ratio.N], [null, 0]);
  check('planComplete 且无偏离时 R = 0，C 再涨也不提醒', [call(182158), state.ratio.R], [null, 0]);
}
{
  // 硬上限与 R 同时到线：只投递一条，层级按这次的 R 推进
  const state = freshState();
  const settings = { ...BASE, cooldownCalls: 1 };
  const call = (tokens) => trackCall(state, {
    session: rootSession,
    isMain: true,
    tool: 'write',
    args: { file_path: `both-${tokens}.py` },
    result: ok(`b${tokens}`),
    cwd: SANDBOX,
    contextTokens: tokens,
  }, settings);
  const both = call(600000); // R = 3.867，同时撞上默认硬上限 600000
  check('两条判据同时到线时只投递一条', [both?.alert.type, both?.alert.ratio.capped], ['r', true]);
  const book = state.bySession.get(rootSession).reminders.r;
  check('簿记里记下层级与"硬上限已提醒"', [book.rTier, book.capAlerted, book.alerts], [2, true, 1]);
  check('下一次门槛是 4（R = 4.53 越过就提醒）', call(700000)?.alert.type, 'r');
  check('再到下一层要 8（R = 6.53 不够）', call(1000000), null);
  check('越过第 4 层后再提醒', call(1220000)?.alert.type, 'r');
}
{
  // 单独验"硬上限只提醒一次"这道闸：造一条"R 远没到下一层、但 capped 为真"的命中
  const entry = createSessionSignals();
  entry.signals.calls = 100;
  const hit = { signal: 'r', count: 100, ratio: { R: 5, capped: true, invalid: false } };
  entry.reminders.r.rTier = 3; // 下一层是 8，R = 5 越不过去
  check('硬上限还没提醒过时，R 没到下一层也放行', chooseReminder(entry, [hit], BASE)?.level, 3);
  entry.reminders.r.capAlerted = true;
  check('硬上限提醒过后，同一条命中被倍增门槛挡住', chooseReminder(entry, [hit], BASE), null);
}
{
  // 冷却与硬上限的先后：冷却期内的上限提醒会被推迟，但不会丢掉（capAlerted 仍是 false）
  const entry = createSessionSignals();
  const hit = { signal: 'r', count: 12, ratio: { R: 0, capped: true, invalid: false } };
  entry.signals.calls = 12;
  entry.reminders.r.alerts = 1;
  entry.reminders.r.lastCall = 12;
  check('冷却期内的硬上限提醒先压住', chooseReminder(entry, [hit], BASE), null);
  entry.signals.calls = 22;
  check('冷却走完后这条上限提醒补上', chooseReminder(entry, [hit], BASE)?.level, 3);
}

{
  // todo 快照从 trackCall 一路传到 R；没有新快照时沿用该会话上一次的计数。
  const state = freshState();
  const entry = createSessionSignals();
  entry.signals.calls = 39; // 下一次 trackCall 会 +1 到 40，好对齐 N 的手算值
  state.bySession.set(rootSession, entry);
  const settings = { ...BASE, cooldownCalls: 99 };
  const call = (todo, index) => trackCall(state, {
    session: rootSession,
    isMain: true,
    tool: 'write',
    args: { file_path: `todo-wire-${index}.py` },
    result: ok(`w${index}`),
    cwd: SANDBOX,
    todo,
  }, settings);
  call({ completed: 4, pending: 2, inProgress: 1 }, 1);
  check('trackCall 把 todo 交给 R', [state.ratio.N, state.ratio.nSource], [30, 'todo']);
  call(undefined, 2);
  check('没有新快照时沿用上一次 todo', state.ratio.nSource, 'todo');
  check('沿用快照时 N 按新的 calls 重算', state.ratio.N, 30.75);
}

console.log('\n--- /drift 报告里的 R 构成 ---');
{
  const book = { capAlerted: true, rTier: 3 }; // 已跨过 1、2、4 → 下次门槛 8
  const ratio = handoffRatio({ tokens: 200000, calls: 40, deltas: { s2: 0 }, checkedSteps: 2, uncheckedSteps: 6 });
  const lines = ratioReport(ratio, book);
  check('第一行给出 R 与是否到线', lines[0], '交接收益比 R ≈ 7.53（R ≥ 1，已到交接条件）');
  check('第二行给出 C 的来源与基线', lines[1], '  上下文 C = 200000 token（tokenMeter 原始值）／基线 C₀ = 20000');
  check('第三行给出 N 与它的来源', lines[2], '  剩余工作量 N = 120（按 PLAN.md 未打勾项数外推）');
  check('第四行给出 D 与各分量', lines[3], '  偏离强度 D = 1.00（S2 Δ=0 × 1.00）');
  check('第五行给出参数与硬上限状态', lines[4], '  参数 r = 0.02、L = 5、H = 60000；硬上限 600000 token（未触达）');
  check('第六行给出再提醒门槛', lines[5], '  再提醒门槛：硬上限已单独提醒过；下次要 R ≥ 8（固定倍增门槛：1 → 2 → 4 → 8…）');
  const todoRatio = handoffRatio({ tokens: 200000, calls: 40, deltas: {}, todo: { completed: 4, pending: 2, inProgress: 1 } });
  check('N 行写 todo 来源与计数', ratioReport(todoRatio, null)[2], '  剩余工作量 N = 30（按 todo_write 清单外推：completed 4、in_progress 1、pending 2）');
  const lowRatio = handoffRatio({ tokens: 200000, calls: 40, deltas: {}, todo: { completed: 1, pending: 2, inProgress: 1 } });
  check('todo 完成不足 2 条时 N 行说明原因', ratioReport(lowRatio, null)[2], '  剩余工作量 N = 20（todo 完成条目不足 2 条，取默认值）');
  check('估算的 C 会写明估算依据', ratioReport(handoffRatio({ calls: 40, deltas: {} }))[1].includes('按 40 次调用 × 1500 估算'), true);
  check('没有数据时说明原因', ratioReport(null)[0], '交接收益比 R：本会话还没有工具调用，暂无数据。');
  check('参数非法时写明原因', ratioReport({ invalid: true, reason: '参数 r 不是有限数（NaN）' })[0], '交接收益比 R：参数非法（参数 r 不是有限数（NaN）），R 的判定按"不触发"处理。');
  check('撞硬上限时报告会标注已触达', ratioReport(handoffRatio({ tokens: 700000, calls: 1, deltas: {}, checkedSteps: 1, uncheckedSteps: 0 }))[4].includes('（已触达）'), true);
}
{
  const state = freshState();
  state.plan = { status: 'ok', approved: [{ status: 'a.py', isDir: false }] };
  state.ratio = handoffRatio({ tokens: 200000, calls: 40, deltas: { s2: 0 }, checkedSteps: 2, uncheckedSteps: 6 });
  const text = formatDriftReport(state, { capAlerted: false, rTier: 0 });
  check('报告里插入 R 构成段', [text.includes('交接收益比 R ≈ 7.53'), text.includes('剩余工作量 N = 120'), text.includes('再提醒门槛：R 的判定还没提醒过，R ≥ 1 就提醒')], [true, true, true]);
  check('报告里原来的部分还在', [text.includes('已批准清单'), text.includes('暂无提醒。')], [true, true]);
  const empty = formatDriftReport(freshState());
  check('没有额度数据时报告不崩、只说明暂无数据', empty.includes('交接收益比 R：本会话还没有工具调用，暂无数据。'), true);
}

{
  // 管线级持久化：一次工具调用后写状态文件；同 id 的新会话对象能读回。
  const home = path.join(SANDBOX, 'persist-pipeline');
  fs.mkdirSync(home, { recursive: true });
  const session = { id: 'persist-pipeline', header: { id: 'persist-pipeline', cwd: home } };
  const listeners = {};
  const ctx = {
    listeners,
    effect(generator) { for (const registered of generator()) void registered; },
    on(name, handler) { listeners[name] = handler; return () => {}; },
    commands: { register: () => () => {} },
  };
  apply(ctx, { cooldownCalls: 99 });
  const accept = async () => ({ kind: 'accept' });
  const exec = { name: 'write', arguments: { file_path: path.join(home, 'x.txt') }, agent: { id: 'a', session } };
  await listeners['tools/pre-execute'](exec, accept);
  await listeners['tools/post-execute'](exec, { isError: false, content: [{ type: 'text', text: 'ok' }] }, accept);
  const file = path.join(home, '.drift', 'state', 'persist-pipeline.json');
  check('post-execute 后写出状态文件', fs.existsSync(file), true);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('状态文件里的 calls = 1', raw.calls, 1);
  const againSession = { id: 'persist-pipeline', header: { id: 'persist-pipeline', cwd: home } };
  const againState = stateOf(againSession, home);
  check('同 id 的新会话恢复 calls', againState.bySession.get(againSession)?.signals.calls, 1);
}

{
  // 第 3 级交接模板：同一会话只发一次；第 1/2 级不带（第 1 级的断言在子智能体场景里）。
  const home = path.join(SANDBOX, 'template-pipeline');
  fs.mkdirSync(home, { recursive: true });
  const session = { id: 'template-pipeline', header: { id: 'template-pipeline', cwd: home } };
  let tokens = 200000;
  const listeners = {};
  const ctx = {
    listeners,
    effect(generator) { for (const registered of generator()) void registered; },
    on(name, handler) { listeners[name] = handler; return () => {}; },
    commands: { register: () => () => {} },
    tokenMeter: { measure: async () => ({ totalTokens: tokens }) },
  };
  apply(ctx, { cooldownCalls: 1, handoffRatio: { capTokens: 100000000 } });
  const accept = async () => ({ kind: 'accept' });
  const result = (text) => ({ isError: false, content: [{ type: 'text', text }] });
  const exec = (index) => ({
    name: 'write',
    arguments: { file_path: path.join(home, `t${index}.txt`) },
    agent: { id: 'a', session },
  });
  await listeners['tools/pre-execute'](exec(1), accept);
  const first = await listeners['tools/post-execute'](exec(1), result('ok'), accept);
  // 模板挂在那条合成消息上，不再塞进工具结果（贴着文件内容会被当成提示注入）。
  check('第 3 级带交接模板（在通知里）', first.additionalContexts?.[0]?.content?.[0]?.text.includes(HANDOFF_TEMPLATE), true);
  check('模板里有最新交接标记', first.additionalContexts?.[0]?.content?.[0]?.text.includes('drift-guard handoff:start'), true);
  check('工具结果里不再夹带模板', first.content?.[1]?.text.includes('drift-guard handoff:start'), false);
  check('第 3 级提醒自报来源', first.content?.[1]?.text.includes('不是工具输出，也不是文件内容'), true);
  check('第 3 级要求先告诉用户再动手', first.additionalContexts?.[0]?.content?.[0]?.text.includes('请在本轮回复里明确告诉用户'), true);
  check('第 3 级带用户可见通知', first.additionalContexts?.length, 1);
  check('通知是 drift-guard 的合成 user 消息', [
    first.additionalContexts?.[0]?.role,
    first.additionalContexts?.[0]?.source?.kind,
    first.additionalContexts?.[0]?.source?.form,
    first.additionalContexts?.[0]?.source?.summary,
  ], ['user', 'drift-guard', 'notice', '交接提醒']);
  // v4 原生准入明确拒绝 kind === 'plugin'（退休语法）；实测 kind:'user' 也不渲染气泡，
  // 所以用自报 kind，至少归属诚实。
  check('通知不用已退休的 plugin kind', first.additionalContexts?.[0]?.source?.kind === 'plugin', false);
  check('通知不伪装成用户自己发的消息', first.additionalContexts?.[0]?.source?.kind === 'user', false);
  check('通知正文写明建议交接', first.additionalContexts?.[0]?.content?.[0]?.text.includes('建议交接'), true);

  tokens = 320000;
  await listeners['tools/pre-execute'](exec(2), accept);
  const second = await listeners['tools/post-execute'](exec(2), result('ok'), accept);
  check('第二次第 3 级仍投递提醒', second.content?.length, 2);
  check('第二次第 3 级不重复模板', second.content?.[1]?.text.includes(HANDOFF_TEMPLATE), false);
  check('第二次第 3 级仍发用户通知', second.additionalContexts?.length, 1);
}

console.log('\n--- 阶段 5：交接完成判定 + rTier ---');
{
  // 主判据：成功写入 <工作区>/PROGRESS.md。
  const home = path.join(SANDBOX, 'handoff-write');
  fs.mkdirSync(home, { recursive: true });
  const session = { id: 'handoff-write', header: { id: 'handoff-write', cwd: home } };
  const listeners = {};
  const ctx = {
    listeners,
    effect(generator) { for (const registered of generator()) void registered; },
    on(name, handler) { listeners[name] = handler; return () => {}; },
    commands: { register: () => () => {} },
    tokenMeter: { measure: async () => ({ totalTokens: 200000 }) },
  };
  apply(ctx, { cooldownCalls: 1, handoffRatio: { capTokens: 100000000 } });
  const accept = async () => ({ kind: 'accept' });
  const result = (text) => ({ isError: false, content: [{ type: 'text', text }] });
  const call = (name, file) => ({ name, arguments: { file_path: path.join(home, file) }, agent: { id: 'a', session } });
  const state = stateOf(session, home);

  await listeners['tools/pre-execute'](call('write', 'a.txt'), accept);
  await listeners['tools/post-execute'](call('write', 'a.txt'), result('ok'), accept);
  check('第 3 级后记下交接起点', typeof state.handoff?.at, 'number');
  check('开始时未完成', state.handoff.completed, undefined);
  const book = state.bySession.get(session).reminders.r;
  const tierBefore = book.rTier;

  await listeners['tools/pre-execute'](call('write', 'other.txt'), accept);
  await listeners['tools/post-execute'](call('write', 'other.txt'), result('ok'), accept);
  check('写别的文件不算交接完成', state.handoff.completed, undefined);

  await listeners['tools/pre-execute'](call('edit', 'PROGRESS.md'), accept);
  await listeners['tools/post-execute'](call('edit', 'PROGRESS.md'), result('ok'), accept);
  check('写 PROGRESS.md 判为交接完成', state.handoff.completed, true);
  check('判定依据是写入', state.handoff.via, 'write');
  check('完成后 rTier 至少 2', book.rTier >= 2, true);
  check('完成后 rTier 不回退', book.rTier >= tierBefore, true);
  check('完成后 R 不会立刻再提醒（门槛已推高）', (await (async () => {
    await listeners['tools/pre-execute'](call('read', 'a.txt'), accept);
    const decision = await listeners['tools/post-execute'](call('read', 'a.txt'), result('ok'), accept);
    return decision.content?.some((block) => String(block.text).includes('第3级')) === true;
  })()), false);
}
{
  // 补充判据：PROGRESS.md 的 mtime+size 变化（覆盖 ops_bash/pwsh 与手改）。
  const home = path.join(SANDBOX, 'handoff-stamp');
  fs.mkdirSync(home, { recursive: true });
  const session = { id: 'handoff-stamp', header: { id: 'handoff-stamp', cwd: home } };
  const listeners = {};
  const ctx = {
    listeners,
    effect(generator) { for (const registered of generator()) void registered; },
    on(name, handler) { listeners[name] = handler; return () => {}; },
    commands: { register: () => () => {} },
    tokenMeter: { measure: async () => ({ totalTokens: 200000 }) },
  };
  apply(ctx, { cooldownCalls: 1, handoffRatio: { capTokens: 100000000 } });
  const accept = async () => ({ kind: 'accept' });
  const result = (text) => ({ isError: false, content: [{ type: 'text', text }] });
  const read = (index) => ({ name: 'read', arguments: { file_path: path.join(home, `r${index}.txt`) }, agent: { id: 'a', session } });
  const state = stateOf(session, home);

  await listeners['tools/pre-execute'](read(1), accept);
  await listeners['tools/post-execute'](read(1), result('ok'), accept);
  check('文件不存在时指纹为空', state.handoff.progressStamp, undefined);
  await listeners['tools/pre-execute'](read(2), accept);
  await listeners['tools/post-execute'](read(2), result('ok'), accept);
  check('文件一直不存在就不算完成', state.handoff.completed, undefined);

  fs.writeFileSync(path.join(home, 'PROGRESS.md'), '手写或脚本写的进度\n');
  await listeners['tools/pre-execute'](read(3), accept);
  await listeners['tools/post-execute'](read(3), result('ok'), accept);
  check('PROGRESS.md 出现后判为交接完成', state.handoff.completed, true);
  check('判定依据是指纹', state.handoff.via, 'fingerprint');
}
{
  // /drift 把交接状态说清楚。
  const state = {
    handoff: { at: Date.now() - 60000, progressStamp: '1:2', completed: true, completedAt: Date.now(), via: 'write' },
    ratio: { R: 1.2, calls: 40, nSource: 'plan', N: 5, D: 0, C0: 20000, C: 200000, r: 0.02, L: 5, H: 60000, capTokens: 600000, capped: false, estimated: false, deltas: {} },
    plan: null,
    alerts: [],
    seen: new Set(),
    lastSeen: 0,
  };
  const lines = handoffReport(state, { alerts: 1, lastCall: 35, rTier: 2 }, { cooldownCalls: 10 });
  check('报告写明上次第 3 级时间', lines.some((line) => line.includes('上次第 3 级提醒：')), true);
  check('报告写明已完成与依据', lines.some((line) => line.includes('交接完成：是') && line.includes('成功写入 PROGRESS.md')), true);
  check('报告写明 R 冷却剩余', lines.some((line) => line.includes('还要 5 次工具调用')), true);
  const notYet = handoffReport({ handoff: null, ratio: null }, undefined, undefined);
  check('没发过第 3 级时如实说', notYet.join('\n').includes('还没发过第 3 级提醒'), true);
  const done = formatDriftReport(state, { alerts: 1, lastCall: 35, rTier: 2 }, { cooldownCalls: 10 });
  check('/drift 里带交接状态段', done.includes('交接状态：'), true);
  check('/drift 里带 tokenMeter 原始值', done.includes('tokenMeter 原始值'), true);
}

console.log('\n--- S6：不进 ≥2 计数、压住 S4、真实用户消息清零 ---');
{
  // 两个真信号同时成立才是第 3 级；把其中一个换成 S6 仍应是第 2 级。
  const settings = { ...BASE, s1Repeats: 4, s2Alternations: 2, s4IdleCalls: 20, s6RoamCalls: 12, cooldownCalls: 10 };
  const two = createSessionSignals();
  two.signals.calls = 30;
  two.signals.s1.count = 4;
  two.signals.s2.count = 2;
  two.reminders.s1.alerts = 1;
  check('两个真信号同时成立 → 第 3 级', chooseReminder(two, [{ signal: 's1', count: 4 }], settings).level, 3);
  const withS6 = createSessionSignals();
  withS6.signals.calls = 30;
  withS6.signals.s1.count = 4;
  withS6.signals.s6.count = 12;
  withS6.reminders.s1.alerts = 1;
  check('S1 + S6 只算一个真信号 → 第 2 级', chooseReminder(withS6, [{ signal: 's1', count: 4 }], settings).level, 2);
}
{
  // S6 漫游期间 S4 被压住不投递，也不应再抬高别的信号到第 3 级。
  const settings = { ...BASE, s1Repeats: 4, s3Reads: 3, s4IdleCalls: 20, s6RoamCalls: 12, cooldownCalls: 10 };
  const roaming = createSessionSignals();
  roaming.signals.calls = 40;
  roaming.signals.s3.count = 3;
  roaming.signals.s4.count = 20;
  roaming.signals.s6.count = 12;
  check('S6 漫游时 S3 + 被压住的 S4 仍是第 1 级', chooseReminder(roaming, [{ signal: 's3', count: 3, tool: 'read', path: 'a' }], settings)?.level, 1);
  const noRoam = createSessionSignals();
  noRoam.signals.calls = 40;
  noRoam.signals.s3.count = 3;
  noRoam.signals.s4.count = 20;
  check('S6 未触发时 S3 + S4 是第 3 级', chooseReminder(noRoam, [{ signal: 's3', count: 3, tool: 'read', path: 'a' }], settings)?.level, 3);
}
{
  // S6 触发期间 S4 的提醒被压住（两条判据嵌套，只说一次）。
  const settings = { ...BASE, s4IdleCalls: 20, s6RoamCalls: 12, cooldownCalls: 0 };
  const roaming = createSessionSignals();
  roaming.signals.calls = 40;
  roaming.signals.s4.count = 20;
  roaming.signals.s6.count = 12;
  const chosen = chooseReminder(roaming, [
    { signal: 's4', count: 20, source: 'plan', progress: 5 },
    { signal: 's6', count: 12, tool: 'read' },
  ], settings);
  check('S6 触发时 S4 被压住，只提醒 S6', chosen.hit.signal, 's6');
  const idleOnly = createSessionSignals();
  idleOnly.signals.calls = 40;
  idleOnly.signals.s4.count = 20;
  idleOnly.signals.s6.count = 11;
  check('S6 未触发时 S4 照常提醒', chooseReminder(idleOnly, [
    { signal: 's4', count: 20, source: 'plan', progress: 5 },
  ], settings).hit.signal, 's4');
}
{
  // todo 快照的新鲜度：有 PLAN 可用时，太久没更新的 todo 回退 PLAN；没有 PLAN 时不丢。
  const state = freshState();
  const settings = { ...BASE, todoStaleCalls: 3, s4IdleCalls: 999, s6RoamCalls: 999, cooldownCalls: 10 };
  let seq = 0;
  const call = (extra) => {
    seq += 1;
    return trackCall(state, {
      session: rootSession,
      isMain: true,
      tool: 'write',
      args: { file_path: `fresh-${seq}.py` },
      result: ok(`f${seq}`),
      cwd: SANDBOX,
      ...extra,
    }, settings);
  };
  call({ todo: { completed: 1, pending: 2, inProgress: 1 } });
  for (let i = 2; i <= 6; i += 1) call({ checkedSteps: i, uncheckedSteps: 5 });
  const entry = state.bySession.get(rootSession);
  check('todo 超过 todoStaleCalls 后不再采信', entry.todoIdle > 3, true);
  check('陈旧 todo 时 N 回退 PLAN', entry.signals.ratio.nSource, 'plan');

  const state2 = freshState();
  const settings2 = { ...BASE, todoStaleCalls: 3, s4IdleCalls: 999, s6RoamCalls: 999, cooldownCalls: 10 };
  let seq2 = 0;
  const call2 = (extra) => {
    seq2 += 1;
    return trackCall(state2, {
      session: rootSession,
      isMain: true,
      tool: 'write',
      args: { file_path: `old-${seq2}.py` },
      result: ok(`o${seq2}`),
      cwd: SANDBOX,
      ...extra,
    }, settings2);
  };
  call2({ todo: { completed: 2, pending: 2, inProgress: 0 } });
  for (let i = 2; i <= 6; i += 1) call2({});
  const entry2 = state2.bySession.get(rootSession);
  check('没有 PLAN 时旧 todo 仍然可用', entry2.signals.ratio.nSource, 'todo');
}
{
  // 真实用户消息（无 form）清零；插件自己的通知（form:'notice'）不清零。
  const listeners = {};
  const ctx = {
    listeners,
    effect(generator) { for (const registered of generator()) void registered; },
    on(name, handler) { listeners[name] = handler; return () => {}; },
    commands: { register: () => () => {} },
  };
  apply(ctx, { ...BASE, s6RoamCalls: 3, cooldownCalls: 1 });
  const session = { id: 'roam-reset', header: { cwd: SANDBOX } };
  const exec = () => ({ name: 'read', arguments: { file_path: path.join(SANDBOX, 'roam.txt') }, agent: { id: 'a', session } });
  const accept = async () => ({ kind: 'accept' });
  for (let i = 1; i <= 3; i += 1) {
    await listeners['tools/pre-execute'](exec(), accept);
    await listeners['tools/post-execute'](exec(), ok('r'), accept);
  }
  const state = stateOf(session, SANDBOX);
  check('三次重复读取后计数为 2', state.bySession.get(session).signals.s6.count, 2);
  listeners['session/event'](session, { type: 'user/message', data: { source: { kind: 'user', form: 'notice', summary: '交接提醒' } } });
  check('插件自己的通知不清零 S6', state.bySession.get(session).signals.s6.count, 2);
  listeners['session/event'](session, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-1' } } });
  check('真实用户消息清零 S6', state.bySession.get(session).signals.s6.count, 0);
  listeners['session/event'](session, { type: 'assistant/message', data: {} });
  check('其他会话事件不动 S6', state.bySession.get(session).signals.s6.count, 0);
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
