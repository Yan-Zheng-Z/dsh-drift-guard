/**
 * 阶段 2 测试：M1/M2/M3 三个检测器的口径与边界。
 *
 * 纯函数用例，不需要模型、不需要 DSH 实例、不写仓库、不建临时目录。
 * 运行：node test/detectors.mjs
 */
import { observeToolCall, WRITE_TOOLS } from '../lib/observation.js';
import { createDetectorState, observeDetectors, resetOnUserMessage } from '../lib/detectors.js';
import { DEFAULTS, resolveConfig } from '../lib/config.js';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
}

/** 成功的结果；content 参与结果指纹。 */
const ok = (text) => ({ isError: false, content: [{ type: 'text', text }] });
/** 失败的结果。 */
const bad = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/** 造一个观测对象；`index` 用 1 起。 */
function obs(index, tool, result, extra = {}) {
  return observeToolCall({ index, tool, result, ...extra });
}

const SETTINGS = { windowCalls: 12, s4IdleCalls: 20, s2Alternations: 6 };

/** 同一份观测规格跑 n 次，返回最后一次的三方判定。 */
function run(state, n, spec = {}) {
  const { text = 'same', tool = 'ops_grep', extra = {}, context = {}, settings = SETTINGS } = spec;
  let last;
  for (let i = 1; i <= n; i += 1) {
    last = observeDetectors(state, obs(i, tool, ok(text), extra), context, settings);
  }
  return last;
}

console.log('--- 采集层：观测对象 ---');
check('工具名统一小写', obs(1, 'READ', ok('a')).tool, 'read');
check('resultKey 区分成功与失败', obs(1, 'read', ok('a')).resultKey === obs(1, 'read', bad('a')).resultKey, false);
check('相同内容指纹相同', obs(1, 'read', ok('a')).resultKey === obs(2, 'read', ok('a')).resultKey, true);
check('成功写文件算产物', obs(1, 'write', ok('x')).wrote, true);
check('失败写文件不算产物', obs(1, 'write', bad('x')).wrote, false);
check('写工具集合', [...WRITE_TOOLS].sort(), ['edit', 'ops_replace', 'write']);
check('没有计划时 plan 为 null', obs(1, 'read', ok('a')).plan, null);
check('计划快照三字段', obs(1, 'read', ok('a'), { checkedSteps: 3, uncheckedSteps: 5, planComplete: false }).plan,
  { checked: 3, unchecked: 5, complete: false });
check('todo 快照', obs(1, 'todo_write', ok('a'), { todo: { completed: 2, pending: 1, inProgress: 0 } }).todo,
  { completed: 2, pending: 1, inProgress: 0 });
check('todo 计数非法时 null', obs(1, 'todo_write', ok('a'), { todo: { completed: -1, pending: 1, inProgress: 0 } }).todo, null);
check('计划缺 unchecked 时按 0', obs(1, 'read', ok('a'), { checkedSteps: 3 }).plan, { checked: 3, unchecked: 0, complete: false });
check('非法 checkedSteps 视为没有计划', obs(1, 'read', ok('a'), { checkedSteps: -1 }).plan, null);
check('token 非法时 null', obs(1, 'read', ok('a'), { contextTokens: Number.NaN }).tokens, null);
check('token 正常时保留', obs(1, 'read', ok('a'), { contextTokens: 1200 }).tokens, 1200);
check('非法 index 归零', obs(-3, 'read', ok('a')).index, 0);

console.log('--- 配置：windowCalls ---');
check('默认窗口宽度', DEFAULTS.windowCalls, 12);
check('配置可覆盖窗口', resolveConfig({ windowCalls: 5 }).windowCalls, 5);
check('窗口为 0 被忽略', resolveConfig({ windowCalls: 0 }).windowCalls, 12);

console.log('--- M1：信息饱和 ---');
{
  const state = createDetectorState();
  const twelfth = run(state, 12);
  check('12 次同一个结果：未饱和', twelfth.m1.saturated, false);
  check('12 次同一个结果：不报', twelfth.m1.hit, false);
  const last = run(state, 1);
  check('第 13 次：饱和', last.m1.saturated, true);
  check('饱和当次 hit', last.m1.hit, true);
  const again = run(state, 1);
  check('持续饱和只报一次', again.m1.hit, false);
}
{
  const state = createDetectorState();
  run(state, 13);
  const fresh = observeDetectors(state, obs(14, 'ops_grep', ok('brand-new')), {}, SETTINGS);
  check('出现新结果：不饱和', fresh.m1.saturated, false);
  check('出现新结果：计数归零', fresh.m1.sinceNovel, 0);
}
{
  const state = createDetectorState();
  run(state, 13);
  const wrote = observeDetectors(state, obs(14, 'write', ok('done')), {}, SETTINGS);
  check('写文件：不饱和', wrote.m1.saturated, false);
  check('写文件：产物标记', wrote.artifact, true);
}
{
  const state = createDetectorState();
  let last;
  for (let i = 1; i <= 13; i += 1) last = observeDetectors(state, obs(i, 'ops_bash', bad('boom')), {}, SETTINGS);
  check('连续相同失败也进 M1 窗口', last.m1.saturated, true);
}
{
  const state = createDetectorState();
  const last = run(state, 4, { settings: { ...SETTINGS, windowCalls: 3 } });
  check('窗口 3：第 4 次饱和', last.m1.saturated, true);
  check('窗口 3：宽度回报', last.m1.width, 3);
}
{
  const state = createDetectorState();
  run(state, 13);
  resetOnUserMessage(state);
  const after = run(state, 1);
  check('用户消息后 M1 归零', after.m1.sinceNovel, 0);
  check('用户消息后不饱和', after.m1.saturated, false);
}

console.log('--- M2：计划停滞 ---');
{
  const state = createDetectorState();
  const extra = { checkedSteps: 3, uncheckedSteps: 2 };
  const twentieth = run(state, 20, { extra });
  check('第一次见到计划只做初始化', twentieth.m2.count, 19);
  check('20 次还没到阈值', twentieth.m2.active, false);
  const last = run(state, 1, { extra });
  check('第 21 次：计划停滞', last.m2.active, true);
  check('计数与阈值', [last.m2.count, last.m2.threshold], [20, 20]);
  const advanced = run(state, 1, { extra: { checkedSteps: 4, uncheckedSteps: 1 } });
  check('勾选数前进：计数归零', advanced.m2.count, 0);
  check('勾选数前进：不再停滞', advanced.m2.active, false);
}
{
  const state = createDetectorState();
  const done = run(state, 30, { extra: { checkedSteps: 10, uncheckedSteps: 0, planComplete: true } });
  check('计划已完成：不评估', done.m2.count, 0);
  check('计划已完成：不报警', done.m2.active, false);
}
{
  const state = createDetectorState();
  const todo = { completed: 2, pending: 1, inProgress: 0 };
  const last = run(state, 21, { extra: { todo } });
  check('todo 有剩余：按 todo 判定', last.m2.source, 'todo');
  check('todo 不动：第 21 次停滞', last.m2.active, true);
  const advanced = run(state, 1, { extra: { todo: { completed: 3, pending: 0, inProgress: 0 } } });
  check('todo 完成数前进：计数归零', advanced.m2.count, 0);
}
{
  const state = createDetectorState();
  const last = run(state, 25, { extra: { todo: { completed: 1, pending: 0, inProgress: 0 } } });
  check('todo 全完成：不评估', last.m2.active, false);
}
{
  const state = createDetectorState();
  const last = run(state, 25, {
    extra: { todo: { completed: 1, pending: 2, inProgress: 0 } },
    context: { todoUsable: false },
  });
  check('todo 过期且没有计划：不评估', last.m2.source, undefined);
  check('todo 过期且没有计划：不报警', last.m2.active, false);
}

console.log('--- M3：无效循环 ---');
{
  const state = createDetectorState();
  let last;
  for (let i = 1; i <= 12; i += 1) {
    last = observeDetectors(state, obs(i, 'read', ok(`r${i}`)), { signature: i % 2 === 0 ? 'B' : 'A' }, SETTINGS);
  }
  check('A/B 交替 6 轮：无效循环', last.m3.active, true);
  check('交替轮数', last.m3.pairs, 6);
  for (let i = 13; i <= 17; i += 1) {
    last = observeDetectors(state, obs(i, 'read', ok(`r${i}`)), { signature: 'A' }, SETTINGS);
  }
  check('交替被打断：不再成立', last.m3.active, false);
}
{
  const state = createDetectorState();
  let last;
  for (let i = 1; i <= 11; i += 1) {
    last = observeDetectors(state, obs(i, 'read', ok(`r${i}`)), { signature: i % 2 === 0 ? 'B' : 'A' }, SETTINGS);
  }
  last = observeDetectors(state, obs(12, 'write', ok('done')), { signature: 'A' }, SETTINGS);
  check('交替期间出现产物：清空记录', last.m3.pairs, 0);
  check('交替期间出现产物：不成立', last.m3.active, false);
}
{
  const state = createDetectorState();
  let last;
  for (let i = 1; i <= 15; i += 1) {
    last = observeDetectors(state, obs(i, 'read', ok(`r${i}`)), { signature: `S${i % 3}` }, SETTINGS);
  }
  check('三个签名轮转：不算乒乓', last.m3.active, false);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
