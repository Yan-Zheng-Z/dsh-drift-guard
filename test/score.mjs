/**
 * 阶段 2 测试：按机理去重的偏离强度 D。
 *
 * 运行：node test/score.mjs
 */
import { dedupeDeviation, describeParts, signalWeight, MECHANISM } from '../lib/score.js';
import { DEFAULT_HANDOFF_RATIO } from '../lib/config.js';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
}

const W = DEFAULT_HANDOFF_RATIO;

console.log('--- 机理分组 ---');
check('三个机理', Object.keys(MECHANISM), ['m1', 'm2', 'm3']);
check('M1 含去重对象', MECHANISM.m1.signals, ['s1', 's3', 's6']);
check('权重读取', [signalWeight('s6', W), signalWeight('s1', W), signalWeight('nope', W)], [1, 0.5, 0]);
check('非法权重按 0', signalWeight('s6', { ...W, wS6: -1 }), 0);

console.log('--- 去重 ---');
{
  // S1 与 S6 同属 M1：只算一次，取贡献大的（S6 权重 1）。
  const out = dedupeDeviation({ s1: 10, s6: 10 }, 10, W);
  check('S1+S6 只算一份', Math.abs(out.D - 1) < 1e-12, true);
  check('留下的是 S6', out.parts.m1.signal, 's6');
}
{
  // 同机理里 S1 更新：即使权重低，贡献更大时也该留更近的那个。
  const out = dedupeDeviation({ s1: 20, s6: 0 }, 20, W);
  check('S6 已衰减到 20 次、S1 是新的：留 S1', out.parts.m1.signal, 's1');
  check('S1 的贡献', Math.abs(out.D - 0.5) < 1e-12, true);
}
{
  const out = dedupeDeviation({ s6: 20 }, 40, W);
  const expected = 1 * Math.exp(-20 / W.decayCalls);
  check('衰减按 decayCalls', Math.abs(out.D - expected) < 1e-12, true);
}
{
  const out = dedupeDeviation({ s6: 20, s4: 20 }, 40, W);
  check('不同机理分别相加', Math.abs(out.D - 2 * Math.exp(-20 / W.decayCalls)) < 1e-12, true);
  check('三个机理解释', describeParts(out.parts), 'M1=s6 M2=s4');
}
{
  const out = dedupeDeviation({ s1: 30, s4: 30, s2: 30 }, 30, W);
  check('三个机理都算', Object.keys(out.parts).sort(), ['m1', 'm2', 'm3']);
  check('去重后的 D', Math.abs(out.D - 2.5) < 1e-12, true);
}
{
  const out = dedupeDeviation({}, 5, W);
  check('没有活跃信号：D 为 0', out.D, 0);
  check('没有活跃信号：说明为“无”', describeParts(out.parts), '无');
}
{
  const out = dedupeDeviation({ s6: 40 }, 40, { ...W, wS6: 0 });
  check('权重为 0 不算', out.D, 0);
}
{
  // 旧口径对照：S1+S4+S6 逐项相加会得到 0.5+1+1；去重后少一份。
  const old = 1 * Math.exp(0) + 0.5 * Math.exp(0) + 1 * Math.exp(0);
  const out = dedupeDeviation({ s1: 0, s6: 0, s4: 0 }, 0, W);
  check('旧口径 2.5 → 新口径 2', [old, out.D], [2.5, 2]);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
