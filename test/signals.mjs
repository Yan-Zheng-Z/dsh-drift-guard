/**
 * drift-guard v0.2 信号测试：S1–S4 与交接收益比 R 的"触发"与"不触发"。
 * 运行：node test/signals.mjs（任意目录都可运行；S3 用临时沙箱里自建的真实文件）
 *
 * 不依赖模型、不依赖 DSH 实例、不写仓库。
 *
 * 注意：为了单独验证某个信号，绝大多数用例让**参数或结果每次都不同**，
 * 免得 S1（相同工具+参数+结果）顺带命中。两者会同时命中的真实情况另有一条断言固定。
 */
import {
  createSignalState,
  observeCall,
  signalText,
  countCheckedSteps,
  failureDecision,
  chainSignature,
  DEFAULTS,
  resolveConfig,
} from '../lib/index.js';
import { handoffRatio, deviationDeltas } from '../lib/signals.js';
import { countUncheckedSteps } from '../lib/plan.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-guard-signals-'));
let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
}

/** 成功的结果；content 参与 S1 的结果哈希。 */
const ok = (text) => ({ isError: false, content: [{ type: 'text', text }] });
/** 失败的结果。 */
const bad = (text) => ({ isError: true, content: [{ type: 'text', text }] });
/** 把命中列表压成 "信号:计数"，便于断言。 */
const flags = (hits) => hits.map((hit) => `${hit.signal}:${hit.count}`);
/** 一串调用里是否出现过某个信号。 */
const hasSignal = (seq, name) => seq.some((hit) => hit.some((flag) => flag.startsWith(`${name}:`)));

/** 默认阈值；单个用例按需覆盖。S6 在大多数用例里关掉（阈值放到 999），免得它顺带命中。 */
const BASE = {
  s1Repeats: 4,
  s2Alternations: 6,
  s3Reads: 3,
  s4IdleCalls: 20,
  s6RoamCalls: 999,
  failureRepeats: 3,
  cooldownCalls: 10,
};

/** R 的浮点比较：先四舍五入到 6 位，避免尾差。 */
const round = (value, digits = 6) => Number(value.toFixed(digits));
/** 造一份"calls 次调用、checked 项已完成、unchecked 项未完成"的 R 输入（N = 平均 × 未完成数）。 */
const withWork = (calls, checked, unchecked, extra = {}) => ({
  calls, checkedSteps: checked, uncheckedSteps: unchecked, deltas: {}, ...extra,
});

const SAT = { ...BASE, s6RoamCalls: 12 };

console.log('--- M1：信息饱和（取代 S1/S3/S6）---');
{
  // 同一结果重复：首次算新信息，之后 12 次没有新信息才饱和（第 13 次命中）
  const signals = createSignalState();
  const call = () => flags(observeCall(signals, { tool: 'ops_grep', args: { pattern: 'same' }, result: ok('同一份内容') }, SAT));
  const seq = [];
  for (let i = 0; i < 13; i += 1) seq.push(call());
  check('前 12 次不报', seq.slice(0, 12).flat(), []);
  check('第 13 次报 s6:12', seq[12], ['s6:12']);
  const more = [];
  for (let i = 0; i < 12; i += 1) more.push(call());
  check('再满 12 次提醒一次（s6:24）', more.filter((item) => item.includes('s6:24')).length, 1);
}
{
  // 只读调研：每次都是新内容 → 永远不饱和（旧 S6 会在这里误报）
  const signals = createSignalState();
  const seq = [];
  for (let i = 0; i < 20; i += 1) {
    seq.push(flags(observeCall(signals, { tool: 'ops_grep', args: { pattern: `p${i}` }, result: ok(`新内容 ${i}`) }, SAT)));
  }
  check('20 次只读新内容：一条提醒都没有', seq.flat(), []);
  check('活跃序号为空', deviationDeltas(signals), {});
}
{
  // 写文件 = 产物，把计数清零
  const signals = createSignalState();
  const read = () => observeCall(signals, { tool: 'read', args: { file_path: 'a.txt' }, result: ok('同一份内容') }, SAT);
  for (let i = 0; i < 12; i += 1) read();
  check('写文件前计数为 11', signals.s6.count, 11);
  observeCall(signals, { tool: 'write', args: { file_path: 'a.txt' }, result: ok('写了') }, SAT);
  check('写文件把计数清零', signals.s6.count, 0);
}
{
  // PLAN 勾选数前进同样是产物
  const signals = createSignalState();
  const call = (i, checked) => observeCall(signals, {
    tool: 'read', args: { file_path: 'a.txt' }, result: ok('同一份内容'), checkedSteps: checked, uncheckedSteps: 3 - checked, cwd: SANDBOX,
  }, SAT);
  for (let i = 0; i < 12; i += 1) call(i, 1);
  check('12 次读同样内容后计数 11', signals.s6.count, 11);
  call(12, 2);
  check('PLAN 打勾推进把产物计数清零', signals.detectors.m1.sinceArtifact, 0);
  check('有产物就不算饱和', signals.detectors.m1.saturated, false);
}

console.log('--- M2：计划停滞 ---');
{
  const signals = createSignalState();
  const call = (i) => observeCall(signals, {
    tool: 'read', args: { file_path: 'a.txt' }, result: ok(`r${i}`), checkedSteps: 2, uncheckedSteps: 5, cwd: SANDBOX,
  }, SAT);
  const seq = [];
  let s4hit;
  for (let i = 1; i <= 21; i += 1) {
    const hits = call(i);
    if (i === 21) s4hit = hits.find((item) => item.signal === 's4');
    seq.push(flags(hits));
  }
  check('前 20 次不报', seq.slice(0, 20).flat(), []);
  check('第 21 次报 s4:20', seq[20], ['s4:20']);
  check('s4 命中带计划步数', [s4hit?.count, s4hit?.checkedSteps], [20, 2]);
}
{
  // 计划打勾前进 → 计数清零；之后再攒 20 次才再报
  const signals = createSignalState();
  const call = (i, checked) => flags(observeCall(signals, {
    tool: 'read', args: { file_path: 'a.txt' }, result: ok(`r${i}`), checkedSteps: checked, uncheckedSteps: 5, cwd: SANDBOX,
  }, SAT));
  for (let i = 1; i <= 21; i += 1) call(i, 2);
  check('先攒到停滞', signals.s4.count, 20);
  call(22, 3);
  check('计划前进后计数归零', signals.s4.count, 0);
  check('计划前进后不报警', signals.s4.count < 20, true);
}
{
  // 计划已完成：没有"应该继续增加"的步骤，不评估
  const signals = createSignalState();
  for (let i = 1; i <= 25; i += 1) {
    observeCall(signals, { tool: 'read', args: { file_path: 'a.txt' }, result: ok(`r${i}`), checkedSteps: 5, uncheckedSteps: 0, planComplete: true }, SAT);
  }
  check('计划完成后不评估停滞', signals.s4.count, 0);
}

console.log('--- M3：无效循环 ---');
{
  const signals = createSignalState();
  const seq = [];
  for (let i = 1; i <= 12; i += 1) {
    seq.push(flags(observeCall(signals, {
      tool: 'read', args: { file_path: i % 2 === 0 ? 'a.txt' : 'b.txt' }, result: ok(`r${i}`),
    }, SAT)));
  }
  check('前 11 次不报', seq.slice(0, 11).flat(), []);
  check('A/B 交替 6 轮报 s2:6', seq[11], ['s2:6']);
}
{
  // 交替期间写文件 → 清空窗口
  const signals = createSignalState();
  for (let i = 1; i <= 11; i += 1) {
    observeCall(signals, { tool: 'read', args: { file_path: i % 2 ? 'a.txt' : 'b.txt' }, result: ok(`r${i}`) }, SAT);
  }
  observeCall(signals, { tool: 'write', args: { file_path: 'c.txt' }, result: ok('w') }, SAT);
  check('写文件清空交替窗口', signals.s2.count, 0);
}
{
  // 三个签名轮转不是乒乓
  const signals = createSignalState();
  const hits = [];
  for (let i = 1; i <= 15; i += 1) {
    hits.push(...flags(observeCall(signals, {
      tool: 'read', args: { file_path: `f${i % 3}.txt` }, result: ok(`r${i}`),
    }, SAT)));
  }
  check('三个签名轮转：不报 s2', hits.some((item) => item.startsWith('s2:')), false);
}

console.log('--- 交接收益比 R 仍然参与判定 ---');{
  // 高上下文 + 饱和：同一次调用里同时命中 S6 与 R
  const signals = createSignalState();
  const seq = [];
  for (let i = 1; i <= 13; i += 1) {
    seq.push(flags(observeCall(signals, {
      tool: 'read', args: { file_path: 'a.txt' }, result: ok('同一份'), contextTokens: 200000,
    }, SAT)));
  }
  check('高上下文时每次调用都命中 R', seq[0], ['r:1']);
  check('第 13 次同时命中 S6 与 R', [seq[12].includes('s6:12'), seq[12].includes('r:13')], [true, true]);
  check('R 的构成留给 /drift', [Math.round(signals.ratio.C), Math.round(signals.ratio.N), signals.ratio.R > 1], [200000, 20, true]);
}
{
  // 生产路径的 D 来自 score 的去重汇总；报告用的 Δ 取每个机理保留的那个信号
  const signals = createSignalState();
  for (let i = 1; i <= 13; i += 1) {
    observeCall(signals, { tool: 'read', args: { file_path: 'a.txt' }, result: ok('同一份') }, SAT);
  }
  check('D 等于 M1 的贡献（wS6 = 1、Δ = 0）', round(signals.ratio.D), 1);
  check('报告用的 Δ 来自保留的信号', signals.ratio.deltas, { s6: 0 });
}

console.log('\n--- R：读不到 token 计量时按"调用次数 × 每次估算 token"折算 ---');
{
  // 默认参数下 C = calls × 1500、N = 20（没有计划）、D = 0：
  // R ≥ 1 等价于 C ≥ 170000，即第 114 次调用（113 次时 C = 169500，R ≈ 0.9967）。
  const signals = createSignalState();
  const call = (i) => flags(observeCall(signals, { tool: 'write', args: { file_path: `i${i}.py` }, result: ok(`u${i}`) }, BASE));
  const until113 = [];
  for (let i = 1; i <= 113; i += 1) until113.push(call(i));
  check('到第 113 次调用都不命中（R < 1）', hasSignal(until113, 'r'), false);
  check('第 114 次命中', call(114), ['r:114']);
  check('R ≥ 1 之后每次调用都命中（重复提醒由冷却把关）', call(115), ['r:115']);
  check('命中里带上 R 的构成', [Math.round(signals.ratio.C), signals.ratio.N, signals.ratio.estimated], [172500, 20, true]);
}
{
  // 回退系数与 N 的兜底都能配置：把 tokensPerCall 调到 200000，第一次调用就够
  const settings = { ...BASE, handoffRatio: { ...DEFAULTS.handoffRatio, tokensPerCall: 200000 } };
  const signals = createSignalState();
  check('回退系数可配置（1 次调用即 C = 200000）', flags(observeCall(
    signals,
    { tool: 'write', args: { file_path: 'k.py' }, result: ok('k') },
    settings,
  )), ['r:1']);
}
{
  // 计划里 1 项已完成、30 项未完成，且"已完成项的平均调用数"目前是 1 → N = 30
  const signals = createSignalState();
  const call = (tokens) => flags(observeCall(
    signals,
    {
      tool: 'write',
      args: { file_path: `p${signals.calls}.py` },
      result: ok(`p${signals.calls}`),
      contextTokens: tokens,
      checkedSteps: 1,
      uncheckedSteps: 30,
    },
    BASE,
  ));
  check('N = 未打勾项数 × 已完成项的平均调用数（1 项已完成 → 平均 1）', [call(119999), Math.round(signals.ratio.N)], [[], 30]);
  check('N = 30 时 120000 token 命中（平均调用数涨到 2 → N = 60）', call(120000), ['r:2']);
}
{
  // 测量值不是数字（拿不到 totalTokens）：一律当"拿不到计量"，走回退估算，绝不当作 0、也不报参数非法
  for (const bad of [undefined, null, '5000', Number.NaN, {}]) {
    const signals = createSignalState();
    const call = () => flags(observeCall(
      signals,
      { tool: 'write', args: { file_path: `b${signals.calls}.py` }, result: ok('z'), contextTokens: bad },
      { ...BASE, handoffRatio: { ...DEFAULTS.handoffRatio, tokensPerCall: 200000 } },
    ));
    check(`测量值 ${JSON.stringify(bad)} 时走回退估算`, [call(), call()], [['r:1'], ['r:2']]);
    check(`测量值 ${JSON.stringify(bad)} 不算参数非法`, signals.ratio.invalid, false);
  }
}
{
  // 测量值是 0：算"拿得到计量"（C = 0 → R = 0），不回退估算
  const signals = createSignalState();
  const call = () => flags(observeCall(
    signals,
    { tool: 'write', args: { file_path: `z${signals.calls}.py` }, result: ok('w'), contextTokens: 0 },
    BASE,
  ));
  check('测量值为 0 时不算"拿不到计量"', [call(), call()], [[], []]);
  check('C = 0 时 estimated 为 false', signals.ratio.estimated, false);
}

console.log('\n--- R：偏离强度 D 参与判定 ---');
{
  // 同样的上下文规模与调用次数：饱和（M1）的那一组通过 D 项把 R 抬高
  const settings = { ...BASE, s6RoamCalls: 12, cooldownCalls: 99 };
  const spiral = createSignalState();
  const clean = createSignalState();
  for (let i = 1; i <= 13; i += 1) {
    observeCall(spiral, { tool: 'read', args: { file_path: 'a.txt' }, result: ok('同一份'), contextTokens: 100000 }, settings);
    observeCall(clean, { tool: 'read', args: { file_path: `f${i}.txt` }, result: ok(`r${i}`), contextTokens: 100000 }, settings);
  }
  check('饱和时 D = S6 的权重（Δ = 0）', round(spiral.ratio.D), 1);
  check('没有饱和时 D = 0', clean.ratio.D, 0);
  check('D 项把 R 抬高', spiral.ratio.R > clean.ratio.R, true);
  check('R 的构成里带着各分量的 Δ', spiral.ratio.deltas, { s6: 0 });
}
{
  // 硬上限：计划全部打勾（N = 0）且没有打转（D = 0）时 R = 0，全靠上限兜底
  const settings = { ...BASE, handoffRatio: { ...DEFAULTS.handoffRatio, capTokens: 200000 } };
  const signals = createSignalState();
  const call = (tokens) => flags(observeCall(
    signals,
    { tool: 'write', args: { file_path: `c${signals.calls}.py` }, result: ok(`c${signals.calls}`), contextTokens: tokens, checkedSteps: 5, uncheckedSteps: 0 },
    settings,
  ));
  check('N = 0 且 D = 0 时 R = 0、没到上限就不命中', [call(199999), Math.round(signals.ratio.R)], [[], 0]);
  check('到硬上限时命中（R 仍是 0）', call(200000), ['r:2']);
  check('命中里标了 capped', signals.ratio.capped, true);
}

console.log('\n--- R：事实句 ---');
{
  const ratio = { R: 1.2345, C: 180000, N: 30.4, D: 1.5, capTokens: 600000, estimated: false, capped: false };
  check('R 的事实句给出 R 与各分量', signalText({ signal: 'r', ratio }), '交接收益比 R ≈ 1.23（C ≈ 180000 token、N = 30、D = 1.50）');
  check('估算的 C 会注明', signalText({ signal: 'r', ratio: { ...ratio, C: 172500, estimated: true } }), '交接收益比 R ≈ 1.23（C ≈ 172500 token（估算）、N = 30、D = 1.50）');
  check('撞硬上限时的事实句只讲上下文规模', signalText({ signal: 'r', ratio: { ...ratio, C: 600000, R: 0, capped: true } }), '主会话上下文规模已达硬上限（C ≈ 600000 token，上限 600000 token）');
  check('缺构成时不写 NaN', signalText({ signal: 'r' }), '交接收益比 R ≈ 0.00（C ≈ 0 token、N = 0、D = 0.00）');
}

console.log('\n--- R：参数非法时 R 不参与判定、但硬上限独立兜底 ---');
{
  const state = { cwd: SANDBOX, alerts: [], seen: new Set(), logBroken: false };
  const logFile = path.join(SANDBOX, '.drift', 'alerts.log');
  const logLines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []);
  const badSettings = { handoffRatio: { ...DEFAULTS.handoffRatio, r: Number.NaN } };
  const bad = handoffRatio({ tokens: 100000, calls: 1, deltas: {}, state, settings: badSettings });
  check('参数非有限数时 R 不触发（也没到硬上限）', [bad.invalid, bad.trigger, bad.capped, bad.R], [true, false, false, 0]);
  check('写明原因', bad.reason.includes('参数 r 不是有限数'), true);
  check('记下一条日志', [logLines().length, logLines()[0].includes('内部错误（交接收益比 R）'), logLines()[0].includes('按"不触发"处理')], [1, true, true]);
  handoffRatio({ tokens: 100000, calls: 1, deltas: {}, state, settings: badSettings });
  check('同一原因只记一条（不刷日志）', logLines().length, 1);
  check('同一会话里另一个原因会另记一条', (() => {
    handoffRatio({ calls: 1, deltas: { s1: Number.NaN }, state });
    return logLines().length;
  })(), 2);
  const noState = handoffRatio({ calls: 1, deltas: {}, settings: { handoffRatio: { h: 'x' } } });
  check('没给 state 时也能兜底（只是不写日志）', [noState.invalid, noState.trigger], [true, false]);
  const divZero = handoffRatio({ tokens: 170000, calls: 1, deltas: {}, settings: { handoffRatio: { h: 0 } } });
  check('结果不是有限数时同样不触发', [divZero.invalid, divZero.trigger], [true, false]);
  const infCalls = handoffRatio({ calls: Number.POSITIVE_INFINITY, deltas: {} });
  check('calls 不是有限数时不触发', [infCalls.invalid, infCalls.trigger], [true, false]);
}
{
  // 硬上限与参数校验解耦：参数坏掉时照样比较 C 与 capTokens
  const at = (tokens, extra = {}) => handoffRatio({
    tokens, calls: 1, deltas: {}, settings: { handoffRatio: { ...DEFAULTS.handoffRatio, r: Number.NaN, ...extra } },
  });
  check('参数非法但 C 到硬上限时仍然触发（只看上限）', [at(600000).invalid, at(600000).capped, at(600000).trigger, at(600000).R], [true, true, true, 0]);
  check('参数非法、差一点没到上限时不触发', [at(599999).capped, at(599999).trigger], [false, false]);
  check('capTokens 自身非法时用默认 600000', [at(600000, { capTokens: Number.NaN }).capTokens, at(600000, { capTokens: Number.NaN }).trigger], [600000, true]);
  check('capTokens 为 0（非正数）时也用默认值', [at(600000, { capTokens: 0 }).capTokens, at(600000, { capTokens: 0 }).trigger], [600000, true]);
  check('tokensPerCall 非法时按默认 1500 估 C，兜底上限仍然可用', (() => {
    const r = handoffRatio({ calls: 400, deltas: {}, settings: { handoffRatio: { ...DEFAULTS.handoffRatio, r: Number.NaN, tokensPerCall: Number.NaN } } });
    return [r.invalid, r.tokensPerCall, r.C, r.capped, r.trigger];
  })(), [true, 1500, 600000, true, true]);
  check('calls 非法时 C 视作 0，不误撞上限', (() => {
    const r = handoffRatio({ calls: Number.POSITIVE_INFINITY, deltas: {}, settings: { handoffRatio: { ...DEFAULTS.handoffRatio, r: Number.NaN } } });
    return [r.invalid, r.C, r.capped, r.trigger];
  })(), [true, 0, false, false]);
  check('参数全合法时硬上限仍按配置走', handoffRatio({ tokens: 300000, calls: 1, deltas: {}, settings: { handoffRatio: { capTokens: 250000 } } }).capped, true);
}

console.log('\n--- 规则 3 阈值可配置（默认行为由 smoke.mjs 固定）---');
{
  const repeats = new Map();
  const sig = 'bash {"command":"exit 1"}';
  check('阈值 5 时第 5 次才提醒', [1, 2, 3, 4, 5].map(() => failureDecision(repeats, sig, true, 5)), [null, null, null, null, 5]);
  check('签名与参数键序无关', chainSignature('read', { b: 1, a: 2 }) === chainSignature('read', { a: 2, b: 1 }), true);
}

/** 两类复选框混在同一份文本里：验证未打勾计数与已打勾计数数的是同一批列表条目。 */
const MIXED_STEPS = [
  '- [x] 已完成的步骤',
  '- [ ] 未完成的步骤',
  '* [X] 大小写都算',
  '* [ ] 星号条目',
  '1. [x] 有序列表里的勾',
  '1. [ ] 有序列表里的空',
  '  - [x] 缩进的子步骤',
  '  - [ ] 缩进的子步骤',
  '- [x]复选框后面紧挨着没空格',
  '- [ ]复选框后面紧挨着没空格',
  '[x] 不是列表条目，不算',
  '[ ] 也不是列表条目，不算',
  '普通文字行不算',
].join('\n');
check('countUncheckedSteps 只数未打勾的列表条目', countUncheckedSteps(MIXED_STEPS), 5);
check('未打勾计数与已打勾计数数的是同一批列表条目', countCheckedSteps(MIXED_STEPS) + countUncheckedSteps(MIXED_STEPS), 10);
check('未打勾项：空文本 0 项', countUncheckedSteps(''), 0);

console.log('\n--- R：交接收益比的分量与临界点（H = 300000）---');
{
  const at = (tokens) => handoffRatio(withWork(30, 1, 1, { tokens }));
  check('N = 未打勾项数 × 已完成项的平均调用数', at(0).N, 30);
  check('N = 30 时临界点 120000 token：119999 不触发、120000 触发', [at(119999).trigger, at(120000).trigger], [false, true]);
  check('N = 30 的临界点数值', [round(at(119999).R), round(at(120000).R)], [0.99999, 1]);
}
{
  const at = (tokens) => handoffRatio(withWork(20, 1, 1, { tokens }));
  check('N = 20 时临界点 170000 token：169999 不触发、170000 触发', [at(169999).trigger, at(170000).trigger], [false, true]);
  check('N = 20 的临界点数值', [round(at(169999).R), round(at(170000).R)], [0.999993, 1]);
}
{
  const at = (tokens) => handoffRatio(withWork(3, 1, 1, { tokens }));
  check('N = 3 时 R 到 599999 token 仍小于 1、且没撞硬上限', [round(at(599999).R), at(599999).trigger], [0.579999, false]);
  check('N = 3 时 600000 token 由硬上限兜底（R 仍只有 0.58）', [round(at(600000).R), at(600000).capped, at(600000).trigger], [0.58, true, true]);
}
check('硬上限可配置', handoffRatio({ tokens: 600000, calls: 400, deltas: {}, settings: { handoffRatio: { capTokens: 700000 } } }).capped, false);

console.log('\n--- R：偏离强度 D 的权重与衰减 ---');
{
  check('D 的权重合计 = S1 0.5 + S2 1 + S3 0.5 + S4 1 = 3', round(handoffRatio({ calls: 1, deltas: { s1: 0, s2: 0, s3: 0, s4: 0 } }).D), 3);
  check('Δ = 0 时 S1 权重 0.5', round(handoffRatio({ calls: 1, deltas: { s1: 0 } }).D), 0.5);
  check('Δ = 0 时 S2 权重 1', round(handoffRatio({ calls: 1, deltas: { s2: 0 } }).D), 1);
  check('Δ = 0 时 S3 权重 0.5', round(handoffRatio({ calls: 1, deltas: { s3: 0 } }).D), 0.5);
  check('Δ = 0 时 S4 权重 1', round(handoffRatio({ calls: 1, deltas: { s4: 0 } }).D), 1);
  check('衰减尺度 20 时 Δ = 20 衰减到 e⁻¹', round(handoffRatio({ calls: 1, deltas: { s2: 20 } }).D), round(Math.exp(-1)));
  check('衰减尺度可配置（40 时 Δ = 20 只衰减到 e⁻⁰·⁵）', round(handoffRatio({ calls: 1, deltas: { s2: 20 }, settings: { handoffRatio: { decayCalls: 40 } } }).D), round(Math.exp(-0.5)));
  check('没在打转的信号不给 D 加权重', handoffRatio({ calls: 1, deltas: { s2: 5 } }).D > 0, true);
  check('非有限数的 Δ 被当成参数非法', [handoffRatio({ calls: 1, deltas: { s1: Number.NaN, s2: 0 } }).invalid, handoffRatio({ calls: 1, deltas: { s1: Number.NaN, s2: 0 } }).D], [true, 0]);
}

console.log('\n--- R：C 的取值与 N 的兜底 ---');
{
  const fallback = handoffRatio({ calls: 40, deltas: {} });
  check('读不到 token 时 C = 调用数 × 1500，并标记为估算', [fallback.C, fallback.estimated], [60000, true]);
  check('回退系数可配置', handoffRatio({ calls: 10, deltas: {}, settings: { handoffRatio: { tokensPerCall: 100 } } }).C, 1000);
  check('拿到 token 时 C 用测量值', [handoffRatio({ tokens: 12345, calls: 40, deltas: {} }).C, handoffRatio({ tokens: 12345, calls: 40, deltas: {} }).estimated], [12345, false]);
  check('测量值为 0 算"拿得到"（C = 0，不估算）', handoffRatio({ tokens: 0, calls: 40, deltas: {} }).estimated, false);

  check('没有计划时 N = 20', handoffRatio({ calls: 5, deltas: {} }).N, 20);
  check('有计划但一项都没打勾（算不出平均）时 N 用默认值', handoffRatio({ calls: 5, deltas: {}, checkedSteps: 0, uncheckedSteps: 8 }).N, 20);
  check('planComplete 为 false 时仍取默认值', handoffRatio({ calls: 5, deltas: {}, planComplete: false }).N, 20);
  const complete = handoffRatio({ calls: 100, tokens: 168755, deltas: {}, planComplete: true });
  check('planComplete 时 N = 0（不再被默认值顶替）', complete.N, 0);
  check('planComplete 时 nSource 记 plan', complete.nSource, 'plan');
  check('planComplete 且无偏离时 R = 0', round(complete.R), 0);
  check('同样的 C 下 N=20 会到 R≈0.99（对照）', round(handoffRatio({ calls: 100, tokens: 168755, deltas: {} }).R), 0.9917);
  check('planComplete 时偏离项仍在 R 里', round(handoffRatio({ calls: 100, tokens: 168755, deltas: { s2: 0 }, planComplete: true }).R) > 0, true);
  check('defaultN 可配置', handoffRatio({ calls: 5, deltas: {}, settings: { handoffRatio: { defaultN: 7 } } }).N, 7);

  // todo 源：N = (pending + in_progress) × calls / completed；completed < 2 时取默认值。
  const todo = { completed: 4, pending: 2, inProgress: 1 };
  const fromTodo = handoffRatio({ calls: 40, deltas: {}, todo });
  check('todo 源：剩余 3 × 平均 10 = 30', [fromTodo.N, fromTodo.nSource], [30, 'todo']);
  check('todo 源：报告里带出计数', fromTodo.todo, todo);
  check('todo 源：completed = 2 时可用', handoffRatio({ calls: 40, deltas: {}, todo: { completed: 2, pending: 3, inProgress: 0 } }).N, 60);
  check('todo 完成不足 2 条时取默认值', [handoffRatio({ calls: 40, deltas: {}, todo: { completed: 1, pending: 2, inProgress: 1 } }).N, handoffRatio({ calls: 40, deltas: {}, todo: { completed: 1, pending: 2, inProgress: 1 } }).nSource], [20, 'todo-low']);
  check('todo 完成 0 条时取默认值', handoffRatio({ calls: 40, deltas: {}, todo: { completed: 0, pending: 2, inProgress: 1 } }).N, 20);
  check('todo 全部完成时 N = 0', [handoffRatio({ calls: 40, deltas: {}, todo: { completed: 4, pending: 0, inProgress: 0 } }).N, handoffRatio({ calls: 40, deltas: {}, todo: { completed: 4, pending: 0, inProgress: 0 } }).nSource], [0, 'todo']);
  check('todo 优先于 PLAN.md 的步数与 planComplete', handoffRatio({ calls: 40, deltas: {}, todo, checkedSteps: 10, uncheckedSteps: 99, planComplete: true }).N, 30);
  check('todo 字段非法时回退 PLAN.md', [handoffRatio({ calls: 40, deltas: {}, todo: { completed: 'x', pending: 1, inProgress: 0 }, checkedSteps: 2, uncheckedSteps: 6 }).N, handoffRatio({ calls: 40, deltas: {}, todo: { completed: 'x', pending: 1, inProgress: 0 }, checkedSteps: 2, uncheckedSteps: 6 }).nSource], [120, 'plan']);
  check('todo 只剩完成项、没有剩余时 N = 0（不是 defaultN）', [handoffRatio({ calls: 40, deltas: {}, todo: { completed: 1, pending: 0, inProgress: 0 } }).N, handoffRatio({ calls: 40, deltas: {}, todo: { completed: 1, pending: 0, inProgress: 0 } }).nSource], [0, 'todo']);
  check('todo 不可用（陈旧）时回退 PLAN', [handoffRatio({ calls: 40, deltas: {}, todo: { completed: 1, pending: 2, inProgress: 1 }, todoUsable: false, checkedSteps: 2, uncheckedSteps: 4 }).N, handoffRatio({ calls: 40, deltas: {}, todo: { completed: 1, pending: 2, inProgress: 1 }, todoUsable: false, checkedSteps: 2, uncheckedSteps: 4 }).nSource], [80, 'plan']);
  check('没有 PLAN 时旧 todo 仍然可用', [handoffRatio({ calls: 40, deltas: {}, todo: { completed: 2, pending: 2, inProgress: 0 } }).N, handoffRatio({ calls: 40, deltas: {}, todo: { completed: 2, pending: 2, inProgress: 0 } }).nSource], [40, 'todo']);
}

console.log('\n--- R：边界处理 ---');
{
  const low = handoffRatio({ tokens: 5000, calls: 1, deltas: {} });
  check('C < C₀ 时 (C − C₀) 取 0、R 也是 0', [low.growthTokens, round(low.R)], [0, 0]);
  check('调用次数为 0 时 R = 0', round(handoffRatio({ calls: 0, deltas: {} }).R), 0);
  const done = handoffRatio(withWork(50, 5, 0, { tokens: 500000 }));
  check('N = 0（计划全部打勾）且没有偏离时 R = 0', [done.N, done.R], [0, 0]);
  check('N = 0 但有偏离时 R 由 D 项决定', round(handoffRatio(withWork(50, 5, 0, { tokens: 500000, deltas: { s2: 0 } })).R), round((DEFAULTS.handoffRatio.r * (1 * DEFAULTS.handoffRatio.l * 500000)) / DEFAULTS.handoffRatio.h));
}

console.log('\n--- R：参数默认值与非法值回退 ---');
check('默认参数与定下的口径一致', DEFAULTS.handoffRatio, {
  r: 0.02,
  c0: 20000,
  h: 60000,
  l: 5,
  decayCalls: 20,
  wS1: 0.5,
  wS2: 1,
  wS3: 0.5,
  wS4: 1,
  wS6: 1,
  defaultN: 20,
  tokensPerCall: 1500,
  capTokens: 600000,
});
check('逐键覆盖只改给了的键', resolveConfig({ handoffRatio: { r: 0.2 } }).handoffRatio, { ...DEFAULTS.handoffRatio, r: 0.2 });
check('权重可以设为 0（等于关掉该项）', resolveConfig({ handoffRatio: { wS1: 0 } }).handoffRatio.wS1, 0);
check('分母类键小于下界时退回默认值', resolveConfig({ handoffRatio: { h: 0, decayCalls: -1, tokensPerCall: 0, capTokens: 0 } }).handoffRatio, DEFAULTS.handoffRatio);
check('非数字的键退回默认值', resolveConfig({ handoffRatio: { r: '0.2', l: null, defaultN: Number.NaN } }).handoffRatio, DEFAULTS.handoffRatio);
check('handoffRatio 不是对象时整体退回默认值', resolveConfig({ handoffRatio: [1, 2] }).handoffRatio, DEFAULTS.handoffRatio);

console.log('\n--- active 簿记（Δcallsᵢ）：新判定下的衰减基准 ---');
{
  const signals = createSignalState();
  const call = () => observeCall(signals, { tool: 'read', args: { file_path: 'a.txt' }, result: ok('同一份') }, SAT);
  for (let i = 0; i < 3; i += 1) call();
  check('未饱和时不记录活跃序号', deviationDeltas(signals), {});
  for (let i = 0; i < 10; i += 1) call();
  check('饱和后 Δ = 0', deviationDeltas(signals), { s6: 0 });
  call();
  check('条件持续成立期间 Δ 一直是 0', deviationDeltas(signals), { s6: 0 });
}
{
  const signals = createSignalState();
  const read = () => observeCall(signals, { tool: 'read', args: { file_path: 'a.txt' }, result: ok('同一份') }, SAT);
  for (let i = 0; i < 13; i += 1) read();
  observeCall(signals, { tool: 'read', args: { file_path: 'b.txt' }, result: ok('新内容') }, SAT);
  check('新结果把饱和打断，Δ 从 1 开始', deviationDeltas(signals), { s6: 1 });
  observeCall(signals, { tool: 'read', args: { file_path: 'c.txt' }, result: ok('更新的内容') }, SAT);
  check('条件继续不成立时 Δ 继续变大', deviationDeltas(signals), { s6: 2 });
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
