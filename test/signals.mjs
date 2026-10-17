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

/** 默认阈值；单个用例按需覆盖。 */
const BASE = {
  s1Repeats: 4,
  s2Alternations: 6,
  s3Reads: 3,
  s4IdleCalls: 20,
  failureRepeats: 3,
  cooldownCalls: 10,
};

/** R 的浮点比较：先四舍五入到 6 位，避免尾差。 */
const round = (value, digits = 6) => Number(value.toFixed(digits));
/** 造一份"calls 次调用、checked 项已完成、unchecked 项未完成"的 R 输入（N = 平均 × 未完成数）。 */
const withWork = (calls, checked, unchecked, extra = {}) => ({
  calls, checkedSteps: checked, uncheckedSteps: unchecked, deltas: {}, ...extra,
});

console.log('--- S1：同一工具 + 相同参数 + 相同结果 ---');
{
  const signals = createSignalState();
  const args = { file_path: 'a.py' };
  const result = ok('同样的输出');
  const seq = [];
  for (let i = 0; i < 8; i += 1) seq.push(flags(observeCall(signals, { tool: 'write', args, result }, BASE)));
  check('连续 1–3 次不触发', seq.slice(0, 3), [[], [], []]);
  check('第 4 次触发（默认阈值 4）', seq[3], ['s1:4']);
  check('第 5–7 次不再触发', seq.slice(4, 7), [[], [], []]);
  check('第 8 次再触发一次', seq[7], ['s1:8']);
}
{
  const signals = createSignalState();
  const args = { file_path: 'a.py' };
  const seq = [];
  for (let i = 0; i < 5; i += 1) seq.push(flags(observeCall(signals, { tool: 'write', args, result: ok(`输出 ${i}`) }, BASE)));
  check('结果每次都不同则不触发', seq, [[], [], [], [], []]);
}
{
  const signals = createSignalState();
  const result = ok('同一输出');
  const variants = [{ file_path: 'a.py', offset: 1 }, { offset: 1, file_path: 'a.py' }];
  const seq = [];
  for (let i = 0; i < 4; i += 1) seq.push(flags(observeCall(signals, { tool: 'read', args: variants[i % 2], result }, BASE)));
  check('参数键序不同仍算同一次调用', seq[3], ['s1:4']);
}
{
  const signals = createSignalState();
  const result = ok('同一输出');
  const args = { file_path: 'a.py' };
  const seq = [];
  for (let i = 0; i < 5; i += 1) seq.push(flags(observeCall(signals, { tool: 'write', args, result }, { ...BASE, s1Repeats: 6 })));
  check('阈值 6 时第 5 次不触发', seq[4], []);
  check('阈值 6 时第 6 次触发', flags(observeCall(signals, { tool: 'write', args, result }, { ...BASE, s1Repeats: 6 })), ['s1:6']);
}

console.log('\n--- S2：两组"工具+参数"来回交替 ---');
const callA = { tool: 'write', args: { file_path: 'a.py' }, result: ok('a') };
const callB = { tool: 'edit', args: { file_path: 'b.py' }, result: ok('b') };
{
  const signals = createSignalState();
  const seq = [];
  for (let i = 0; i < 12; i += 1) seq.push(flags(observeCall(signals, i % 2 === 0 ? callA : callB, BASE)));
  check('第 1–11 次不触发', seq.slice(0, 11).every((hit) => hit.length === 0), true);
  check('第 12 次（6 轮）触发', seq[11], ['s2:6']);
}
{
  const signals = createSignalState();
  const seq = [callA, callB, callA, callA].map((call) => flags(observeCall(signals, call, BASE)));
  check('A B A A 不算严格交替', seq, [[], [], [], []]);
}
{
  // 签名完全相同（只有结果不同，避免 S1 顺带命中）→ 不是交替
  const signals = createSignalState();
  const seq = [];
  for (let i = 0; i < 5; i += 1) seq.push(flags(observeCall(signals, { tool: 'write', args: { file_path: 'a.py' }, result: ok(`a${i}`) }, BASE)));
  check('同一签名连续不算交替', seq.every((hit) => hit.length === 0), true);
}
{
  const signals = createSignalState();
  const pattern = [callA, callB, callA, callB, callA, callB, callA, callB, callA, callB, callA, callA];
  const seq = pattern.map((call) => flags(observeCall(signals, call, BASE)));
  check('末尾被同一签名打断后不触发', hasSignal(seq, 's2'), false);
}
{
  const signals = createSignalState();
  const seq = [];
  for (let i = 0; i < 8; i += 1) seq.push(flags(observeCall(signals, i % 2 === 0 ? callA : callB, { ...BASE, s2Alternations: 4 })));
  check('阈值 4 时第 6 次不触发', seq[5], []);
  check('阈值 4 时第 8 次触发', seq[7], ['s2:4']);
}

console.log('\n--- S3：同一文件未修改被重复读取 ---');
const file = path.join(SANDBOX, 'reread.txt');
fs.writeFileSync(file, 'v1\n');
/** 读一次 file（每次结果文本不同，避免 S1 顺带命中；要验 S1 交互的用例另写）。 */
let reads = 0;
const read = (signals, over = {}) => {
  reads += 1;
  return flags(observeCall(signals, {
    tool: over.tool ?? 'read',
    args: over.args ?? { file_path: file },
    result: over.result ?? ok(`第 ${reads} 次读到的内容`),
    cwd: SANDBOX,
  }, BASE));
};
{
  const signals = createSignalState();
  const seq = [];
  for (let i = 0; i < 6; i += 1) seq.push(read(signals));
  check('前 2 次不触发', seq.slice(0, 2), [[], []]);
  check('第 3 次触发（默认阈值 3）', seq[2], ['s3:3']);
  check('第 4、5 次不再触发', seq.slice(3, 5), [[], []]);
  check('第 6 次再触发一次', seq[5], ['s3:6']);
}
{
  const signals = createSignalState();
  read(signals);
  read(signals);
  fs.writeFileSync(file, 'v2 内容更长，大小也变了\n');
  check('文件改过后不接着算', read(signals), []);
  check('改过后第 2 次仍不触发', read(signals), []);
  check('改过后重新数到第 3 次才触发', read(signals), ['s3:3']);
}
{
  const signals = createSignalState();
  let hit;
  for (let i = 0; i < 3; i += 1) {
    reads += 1;
    hit = observeCall(signals, { tool: 'read', args: { file_path: 'reread.txt' }, result: ok(`相对路径第 ${reads} 次`), cwd: SANDBOX }, BASE).at(-1);
  }
  check('相对路径命中同一文件', hit?.path, 'reread.txt');
}
{
  const signals = createSignalState();
  const seq = [1, 2, 3].map(() => read(signals, { tool: 'ops_inspect_local_file', args: { path: file } }));
  check('ops_inspect_local_file 也算读文件', seq[2], ['s3:3']);
}
{
  const signals = createSignalState();
  const seq = [1, 2, 3].map(() => read(signals, { result: bad('读取失败') }));
  check('读取失败不计数', seq, [[], [], []]);
}
{
  const signals = createSignalState();
  const seq = [1, 2, 3].map(() => read(signals, { tool: 'write' }));
  check('写工具不计数', seq, [[], [], []]);
}
{
  const signals = createSignalState();
  const seq = [1, 2, 3].map(() => read(signals, { args: { file_path: path.join(SANDBOX, 'nope.txt') }, result: bad('不存在') }));
  check('文件不存在不计数', seq, [[], [], []]);
}
{
  const signals = createSignalState();
  const seq = [1, 2, 3].map((i) => flags(observeCall(signals, { tool: 'read', args: { file_path: file }, result: ok(`无 cwd 第 ${i} 次`) }, BASE)));
  check('没有会话工作区时不判 S3', seq, [[], [], []]);
}
{
  // 真实交互：同一文件反复读到第 4 次，S3 先命中、S1 随后也命中（相同参数 + 相同结果）
  const signals = createSignalState();
  const seq = [];
  for (let i = 0; i < 4; i += 1) seq.push(flags(observeCall(signals, { tool: 'read', args: { file_path: file }, result: ok('同一份内容'), cwd: SANDBOX }, BASE)));
  check('重复读同一文件：第 3 次是 S3、第 4 次是 S1', [seq[2], seq[3]], [['s3:3'], ['s1:4']]);
}

console.log('\n--- S4：PLAN.md 已打勾步骤数停滞 ---');
{
  const signals = createSignalState();
  let seq = 0;
  const call = (steps) => {
    seq += 1;
    return flags(observeCall(signals, {
      tool: 'write',
      args: { file_path: `f${seq}.py` },
      result: ok(`r${seq}`),
      checkedSteps: steps,
    }, BASE));
  };
  check('基线那次不算停滞', call(10), []);
  check('连续 19 次未增加不触发', Array.from({ length: 19 }, () => call(10)).every((hit) => hit.length === 0), true);
  check('第 20 次未增加触发', call(10), ['s4:20']);
}
{
  const signals = createSignalState();
  let seq = 0;
  const call = (steps) => {
    seq += 1;
    return flags(observeCall(signals, {
      tool: 'write',
      args: { file_path: `g${seq}.py` },
      result: ok(`s${seq}`),
      checkedSteps: steps,
    }, BASE));
  };
  check('基线', call(5), []);
  check('5 次未增加不触发', Array.from({ length: 5 }, () => call(5)).every((hit) => hit.length === 0), true);
  check('打勾数增加后不算停滞', call(6), []);
  check('增加后要重新数满 20 次', Array.from({ length: 19 }, () => call(6)).every((hit) => hit.length === 0), true);
  check('重新数满后触发', call(6), ['s4:20']);
}
{
  const signals = createSignalState();
  const seq = [];
  for (let i = 0; i < 30; i += 1) {
    seq.push(flags(observeCall(signals, { tool: 'write', args: { file_path: `h${i}.py` }, result: ok(`t${i}`) }, BASE)));
  }
  check('没有 PLAN.md（checkedSteps 缺省）时 S4 不触发', hasSignal(seq, 's4'), false);
}
check('countCheckedSteps 只数已打勾的列表条目', countCheckedSteps([
  '- [x] 已完成的步骤',
  '- [ ] 未完成的步骤',
  '* [X] 大小写都算',
  '1. [x] 有序列表里的勾',
  '  - [x] 缩进的子步骤',
  '- [x]紧挨着没有空格',
  '[x] 不是列表条目，不算',
].join('\n')), 5);
check('空文本 0 步', countCheckedSteps(''), 0);

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
  // 同样的上下文规模与调用次数：S1 打转的那一次通过 D 项把 R 抬高
  const settings = { ...BASE, s1Repeats: 2, cooldownCalls: 99 };
  const spiral = createSignalState();
  observeCall(spiral, { tool: 'write', args: { file_path: 'same.py' }, result: ok('same'), contextTokens: 100000 }, settings);
  observeCall(spiral, { tool: 'write', args: { file_path: 'same.py' }, result: ok('same'), contextTokens: 100000 }, settings);
  const clean = createSignalState();
  observeCall(clean, { tool: 'write', args: { file_path: 'a.py' }, result: ok('A'), contextTokens: 100000 }, settings);
  observeCall(clean, { tool: 'write', args: { file_path: 'b.py' }, result: ok('B'), contextTokens: 100000 }, settings);
  check('S1 打转时 D = S1 的权重（Δ = 0）', round(spiral.ratio.D), 0.5);
  check('没有打转时 D = 0', clean.ratio.D, 0);
  check('D 项把 R 抬高', spiral.ratio.R > clean.ratio.R, true);
  check('R 的构成里带着各分量的 Δ', spiral.ratio.deltas, { s1: 0 });
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

console.log('\n--- 一次调用命中多个信号 ---');
{
  const signals = createSignalState();
  const multi = path.join(SANDBOX, 'multi.txt');
  fs.writeFileSync(multi, 'm\n');
  const settings = { ...BASE, cooldownCalls: 99 };
  const readMulti = (i) => flags(observeCall(signals, { tool: 'read', args: { file_path: multi }, result: ok(`m${i}`), cwd: SANDBOX, contextTokens: 200000 }, settings));
  readMulti(1);
  readMulti(2);
  check('第 3 次读取同时命中 S3 与 R', readMulti(3), ['s3:3', 'r:3']);
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
  defaultN: 20,
  tokensPerCall: 1500,
  capTokens: 600000,
});
check('逐键覆盖只改给了的键', resolveConfig({ handoffRatio: { r: 0.2 } }).handoffRatio, { ...DEFAULTS.handoffRatio, r: 0.2 });
check('权重可以设为 0（等于关掉该项）', resolveConfig({ handoffRatio: { wS1: 0 } }).handoffRatio.wS1, 0);
check('分母类键小于下界时退回默认值', resolveConfig({ handoffRatio: { h: 0, decayCalls: -1, tokensPerCall: 0, capTokens: 0 } }).handoffRatio, DEFAULTS.handoffRatio);
check('非数字的键退回默认值', resolveConfig({ handoffRatio: { r: '0.2', l: null, defaultN: Number.NaN } }).handoffRatio, DEFAULTS.handoffRatio);
check('handoffRatio 不是对象时整体退回默认值', resolveConfig({ handoffRatio: [1, 2] }).handoffRatio, DEFAULTS.handoffRatio);

console.log('\n--- R 的活跃序号簿记（Δcallsᵢ）---');
{
  const signals = createSignalState();
  const call = () => observeCall(signals, { tool: 'write', args: { file_path: 'x.py' }, result: ok('同一个结果') }, BASE);
  call(); call(); call();
  check('条件未成立时不记录活跃序号', deviationDeltas(signals), {});
  call();
  check('第 4 次命中 S1（阈值 4）后 Δ = 0', deviationDeltas(signals), { s1: 0 });
  call();
  check('条件持续成立期间 Δ 一直是 0', deviationDeltas(signals), { s1: 0 });
}
{
  const signals = createSignalState();
  const settings = { ...BASE, s1Repeats: 2 };
  const same = () => observeCall(signals, { tool: 'write', args: { file_path: 'y.py' }, result: ok('r') }, settings);
  same(); same();
  check('S1 条件成立时 Δ = 0', deviationDeltas(signals), { s1: 0 });
  observeCall(signals, { tool: 'write', args: { file_path: 'other.py' }, result: ok('r2') }, settings);
  check('S1 计数被重置后 Δ 从 1 开始变大', deviationDeltas(signals), { s1: 1 });
  observeCall(signals, { tool: 'write', args: { file_path: 'third.py' }, result: ok('r3') }, settings);
  check('条件继续不成立时 Δ 继续变大', deviationDeltas(signals), { s1: 2 });
}
{
  const signals = createSignalState();
  const file = path.join(SANDBOX, 'active.txt');
  fs.writeFileSync(file, 'a\n');
  const readFile = () => observeCall(signals, { tool: 'read', args: { file_path: file }, result: ok('a'), cwd: SANDBOX }, BASE);
  readFile(); readFile(); readFile();
  check('S3 到阈值后 Δ = 0', deviationDeltas(signals), { s3: 0 });
  observeCall(signals, { tool: 'write', args: { file_path: 'w.py' }, result: ok('w') }, BASE);
  check('别的工具调用不给 S3 续命，Δ = 1', deviationDeltas(signals), { s3: 1 });
  readFile();
  check('再读同一个未修改的文件时 Δ 回到 0', deviationDeltas(signals), { s3: 0 });
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
