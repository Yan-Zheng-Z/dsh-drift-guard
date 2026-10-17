/**
 * drift-guard 纯函数冒烟测试（不需要模型、不需要 DSH 实例）。
 * 运行：node test/smoke.mjs（也可从任意目录运行，路径按脚本位置解析）
 *
 * 本文件不依赖任何本机绝对路径：所有"工作区"都是运行时在临时目录里造出来的。
 */
import {
  parsePlan,
  classifyWrite,
  failureDecision,
  alertLine,
  formatDriftReport,
  inspectPlan,
  isApproved,
  isOutsideWorkspace,
  resolvePath,
  relativePath,
  REPEAT_THRESHOLD,
} from '../lib/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));       // …/test
const FIXTURES = path.join(TEST_DIR, 'fixtures');                    // …/test/fixtures
const PLUGIN_DIR = path.dirname(TEST_DIR);                           // …/drift-guard

// 每次运行都新造一个临时沙箱，用完删掉；不写仓库、不依赖机器的目录结构。
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-guard-smoke-'));
const CWD = path.join(SANDBOX, 'workspace');                         // 假装是"会话工作区根"
const OTHER = path.join(SANDBOX, 'other', 'workspace');              // 同层另一个工作区（用于越界判定）
const OUTSIDE = path.join(SANDBOX, 'other', 'test.txt');             // 工作区外的绝对路径
const DRIVE = path.parse(SANDBOX).root.replace(/[\\/]+$/, '');       // 本机盘符根，如 C: / D: / 空
const OTHER_DRIVE = DRIVE.toLowerCase() === 'd:' ? 'C:' : 'D:';      // 另一个盘符（机器上不一定存在）

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
}

/** 造一个只含 PLAN.md 的目录，返回目录路径。 */
function makePlanDir(name, text) {
  const dir = path.join(SANDBOX, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'PLAN.md'), text, 'utf8');
  return dir;
}

fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(OTHER, { recursive: true });
// 目录条目 tmp/build/ 需要真有这个目录才能验证"目录下的文件也算已批准"。
// 空目录进不了 git，所以这里运行时创建；路径已写进 .gitignore。
fs.mkdirSync(path.join(FIXTURES, 'tmp', 'build'), { recursive: true });

console.log('--- 路径解析与工作区判定 ---');
check('工作区内相对路径', resolvePath('a.py', CWD), `${CWD.replace(/\\/g, '/').toLowerCase()}/a.py`);
check('工作区内子目录', isOutsideWorkspace('src/a.py', CWD), false);
check('工作区外绝对路径', isOutsideWorkspace(OUTSIDE, CWD), true);
check('并列目录里的同名文件算越界', isOutsideWorkspace(path.join(SANDBOX, 'workspace2', 'a.py'), CWD), true);
check('用 .. 逃出工作区', isOutsideWorkspace('..\\..\\..\\test.txt', CWD), true);
check('工作区根自身不算越界', isOutsideWorkspace('.', CWD), false);
check('相对路径展示', relativePath('src\\a.py', CWD), 'src/a.py');

// 回归：清单条目的两种合理读法都必须命中——README/本项目按"会话工作区根"写条目，
// 而计划放在祖先目录时条目可能按"PLAN.md 所在目录"写；只认一种就会漏判成越界。
{
  // 条目写成"相对会话工作区根"：<cwd>/acceptance/a.py
  const rootEntries = parsePlan('## 阶段 1 [已批准]\n- 新建 `acceptance/a.py`：按工作区根写的条目\n');
  check('条目按工作区根解释时命中', isApproved('acceptance/a.py', CWD, rootEntries, CWD), true);
  check('条目按工作区根解释时不算到别处', isApproved('a.py', CWD, rootEntries, CWD), false);
  check('另一盘符的同名路径不命中', isApproved(`${OTHER_DRIVE}\\acceptance\\a.py`, CWD, rootEntries, CWD), false);

  // 同一条目改按"PLAN.md 所在目录"解释：planDir = 上一层时，条目拼出 <cwd>/acceptance/a.py
  const upOne = path.dirname(CWD);
  check('同一条目换基准后仍命中同一目标', isApproved('acceptance/a.py', CWD, rootEntries, upOne), true);
  check('基准上移后不再把 <cwd>/a.py 当命中', isApproved('a.py', CWD, rootEntries, upOne), false);

  const planDirEntries = parsePlan('## 阶段 1 [已批准]\n- 新建 `deep\\a.py`：按计划根写的条目\n');
  const nestedCwd = path.join(CWD, 'deep');
  check('条目按 PLAN.md 所在目录解释时也命中', isApproved('a.py', nestedCwd, planDirEntries, CWD), true);
}

console.log('\n--- PLAN.md 解析 ---');
const plan = [
  '# 计划',
  '',
  '## 阶段 1：导出功能 [已完成]',
  '- 新建 src/old.py：历史阶段',
  '',
  '## 阶段 2：接口对齐 [已批准]',
  '- 修改 src/a.py：对齐签名',
  '- 新建 docs/note.md：补充说明',
  '- 自动生成：tmp/build/（编译产物）',
  '',
  '## 阶段 3：收尾 [待批准]',
  '- 新建 src/c.py：还没批',
  '',
  '## 阶段 4：联调 [进行中]',
  '- 修改 src/d.py：正在进行',
].join('\n');
const approved = parsePlan(plan);
check('已批准清单', approved?.map((e) => e.status), ['src/a.py', 'docs/note.md', 'tmp/build', 'src/d.py']);
check('已完成阶段不算', approved?.some((e) => e.status === 'src/old.py'), false);
check('待批准阶段不算', approved?.some((e) => e.status === 'src/c.py'), false);

check('没有状态词的 PLAN 解析为空', parsePlan('# 计划\n- 新建 src/a.py：x'), null);
check('空文本解析为空', parsePlan(''), null);
// 已知行为：清单里出现"像路径的词"就会被算作条目，哪怕只是顺口提到一个文件名；
// 条目一律按小写归一，所以匹配是大小写不敏感的。
check('清单里顺口提到的裸文件名也算条目', parsePlan('## 阶段 1 [已批准]\n- 修改 README.md：说明\n')?.map((e) => e.status), ['readme.md']);
check('条目统一转小写', parsePlan('## 阶段 1 [已批准]\n- 修改 SRC/A.PY：说明\n')?.map((e) => e.status), ['src/a.py']);
check('条目大小写不敏感', isApproved('ReadMe.md', CWD, parsePlan('## 阶段 1 [已批准]\n- 修改 readme.md：说明\n'), CWD), true);
check('大小写不同的目标按同一文件放行', classifyWrite({ name: 'write', cwd: CWD, approved: parsePlan('## 阶段 1 [已批准]\n- 修改 SRC/A.PY：说明\n'), args: { file_path: 'src/a.py' } }), null);
check('说明文字里的裸文件名会撑宽清单，越界因此少报一次', classifyWrite({ name: 'write', cwd: CWD, approved: parsePlan('## 阶段 1 [已批准]\n- 修改 zzz.py：真正的目标\n- 顺口提到 README.md 这个说明用文件名\n'), args: { file_path: 'README.md' } }), null);

console.log('\n--- 规则 1 / 规则 2 判定 ---');
const base = { name: 'write', cwd: CWD, approved };
check('已批准文件放行', classifyWrite({ ...base, args: { file_path: 'src/a.py' } }), null);
check('目录条目下的文件放行', classifyWrite({ ...base, args: { file_path: 'tmp/build/out.o' } }), null);
check('越界写入报 unapproved', classifyWrite({ ...base, args: { file_path: 'b.py' } })?.kind, 'unapproved');
check('越界写入的相对路径', classifyWrite({ ...base, args: { file_path: 'b.py' } })?.relative, 'b.py');
check('工作区外报 outside', classifyWrite({ ...base, args: { file_path: OUTSIDE } })?.kind, 'outside');
check('无计划时规则 1 不生效', classifyWrite({ ...base, approved: null, args: { file_path: 'b.py' } }), null);
check('无计划时仍拦工作区外', classifyWrite({ ...base, approved: null, args: { file_path: OUTSIDE } })?.kind, 'outside');
check('把 cwd 本身当目标不报越界', classifyWrite({ ...base, approved: null, args: { file_path: '.' } }), null);
check('edit 工具走同一套判定', classifyWrite({ ...base, name: 'edit', args: { file_path: 'b.py' } })?.kind, 'unapproved');
check('ops_replace 只认 path 字段', classifyWrite({ ...base, name: 'ops_replace', args: { path: 'b.py' } })?.kind, 'unapproved');

console.log('\n--- 规则 3 判定 ---');
const repeats = new Map();
const sig = 'bash {"command":"exit 1"}';
const seq = [1, 2, 3, 4, 5, 6].map((n) => failureDecision(repeats, sig, true));
check('连续失败第 1、2 次不报', seq.slice(0, 2), [null, null]);
check(`第 ${REPEAT_THRESHOLD} 次报`, seq[2], 3);
check('第 4、5 次不报', seq.slice(3, 5), [null, null]);
check('第 6 次再报', seq[5], 6);
check('成功后清零', failureDecision(repeats, sig, false), null);
check('清零后重新计数', [failureDecision(repeats, sig, true), failureDecision(repeats, sig, true), failureDecision(repeats, sig, true)], [null, null, 3]);
const other = new Map();
check('其他工具不影响计数', [failureDecision(other, sig, true), failureDecision(other, 'read {"file_path":"x"}', true), failureDecision(other, sig, true), failureDecision(other, sig, true)], [null, null, null, 3]);

console.log('\n--- 提醒文案 ---');
check(
  '拦截文案包含关键信息',
  alertLine({ type: 'outside', at: 0, tool: 'write', target: OUTSIDE, workspace: CWD })
    .includes('拦截工作区外写入') && alertLine({ type: 'outside', at: 0, tool: 'write', target: OUTSIDE, workspace: CWD }).includes(path.basename(OUTSIDE)),
  true,
);
check(
  '越界文案包含"不在 PLAN.md 已批准阶段的清单里"',
  alertLine({ type: 'unapproved', at: 0, tool: 'write', target: 'b.py', relative: 'b.py' }).includes('不在 PLAN.md 已批准阶段的清单里'),
  true,
);

console.log('\n--- 回归：反斜杠路径与子目录会话 ---');
check('反斜杠路径被当成一个 token', parsePlan('## 阶段 1 [已批准]\n- 新建 `deep\\a.py`：对齐\n')?.[0]?.status, 'deep/a.py');

// 造一个嵌套工作区：会话 cwd 在下层目录，PLAN.md 里的路径按工作区根写。
const nestedRoot = path.join(SANDBOX, 'nested');
const nestedDeep = path.join(nestedRoot, 'deep');
fs.mkdirSync(nestedDeep, { recursive: true });
fs.writeFileSync(
  path.join(nestedRoot, 'PLAN.md'),
  '# 计划\n\n## 阶段 1：当前 [已批准]\n\n- 新建 `deep\\a.py`：唯一被批准的对象\n- 自动生成：`deep/tmp/build/`（产物）\n\n## 阶段 2：收尾 [已完成]\n- 新建 `deep\\old.py`：历史阶段\n\n## 阶段 3 [待批准]\n- 新建 `deep/c.py`：没批\n',
  'utf8',
);
const nestedPlan = parsePlan(fs.readFileSync(path.join(nestedRoot, 'PLAN.md'), 'utf8'));
const nestedPlanDir = nestedRoot;   // PLAN.md 所在目录 = 条目路径的解释根
check('嵌套计划的清单（反斜杠已归一）', nestedPlan.map((e) => e.status), ['deep/a.py', 'deep/tmp/build']);
check('反斜杠条目命中同一文件', isApproved('a.py', nestedDeep, nestedPlan, nestedPlanDir), true);
check('已完成阶段的反斜杠条目仍不算', isApproved('old.py', nestedDeep, nestedPlan, nestedPlanDir), false);
check('待批准阶段不算', isApproved('c.py', nestedDeep, nestedPlan, nestedPlanDir), false);
check('目录条目下的文件命中', isApproved('tmp/build/out.o', nestedDeep, nestedPlan, nestedPlanDir), true);
check('同名的别目录文件不算命中', isApproved('other/x.py', nestedDeep, nestedPlan, nestedPlanDir), false);

// inspectPlan 走真实文件读取 + 缓存
const planState = await inspectPlan({ get: () => undefined }, { cwd: nestedDeep, plan: null, planStamp: undefined });
check('inspectPlan 读到计划', planState.status, 'ok');
check('inspectPlan 从上层目录找到 PLAN.md', planState.file, path.join(nestedRoot, 'PLAN.md'));
check('inspectPlan 带出条目解释根', planState.dir, nestedPlanDir);
if (planState.status === 'ok') {
  check('inspectPlan 的清单与解析一致', planState.approved.map((e) => e.status), nestedPlan.map((e) => e.status));
  check('越界 c.py 仍被报出', classifyWrite({ name: 'write', cwd: nestedDeep, approved: planState.approved, planDir: planState.dir, args: { file_path: 'c.py' } })?.kind, 'unapproved');
  check('已批准的 a.py 从 inspectPlan 结果也放行', classifyWrite({ name: 'write', cwd: nestedDeep, approved: planState.approved, planDir: planState.dir, args: { file_path: 'a.py' } }), null);
}

// 有"已批准"阶段但一个路径都没解析出来 -> 必须是 unparsed，不能退化成空清单
const emptyDir = makePlanDir('empty-plan', '# 计划\n\n## 阶段 1 [已批准]\n\n- 稍后补充细节\n');
check('解析不到路径时是 unparsed（不静默放行）', (await inspectPlan({ get: () => undefined }, { cwd: emptyDir, plan: null, planStamp: undefined })).status, 'unparsed');

const missingDir = makePlanDir('no-plan', '');
fs.rmSync(path.join(missingDir, 'PLAN.md'));
check('没有 PLAN.md 时状态是 absent', (await inspectPlan({ get: () => undefined }, { cwd: missingDir, plan: null, planStamp: undefined })).status, 'absent');

// 没有 PLAN.md 的目录必须明确报"没有 PLAN.md"，而不是静默放行。
// 场景在临时沙箱里自建，不看仓库根有没有 PLAN.md，所以这项断言确定执行（v0.2 起）；
// 改成这样之前的写法带 `if (仓库根没有 PLAN.md)` 条件，工作区里一有 PLAN.md 就被跳过。
const bareDir = path.join(SANDBOX, 'bare-no-plan');
fs.mkdirSync(bareDir, { recursive: true });
check('工作区没有 PLAN.md 时状态是 absent', (await inspectPlan({ get: () => undefined }, { cwd: bareDir, plan: null, planStamp: undefined })).status, 'absent');

console.log('\n--- 夹具 PLAN.md ---');
// 夹具是给人看的样例，测试直接读它，保证格式与解析器长期一致。
const fixturePath = path.join(FIXTURES, 'PLAN.md');
const fixturePlan = parsePlan(fs.readFileSync(fixturePath, 'utf8'));
check('夹具里的清单（已完成/待批准阶段不算）', fixturePlan?.map((e) => e.status), ['a.py', 'tmp/build']);
check('夹具的目录条目覆盖子路径', isApproved('tmp/build/out.o', FIXTURES, fixturePlan, FIXTURES), true);
check('夹具里已批准的文件放行', isApproved('a.py', FIXTURES, fixturePlan, FIXTURES), true);
check('夹具里已完成阶段的文件不算', isApproved('old.py', FIXTURES, fixturePlan, FIXTURES), false);
check('夹具里待批准阶段的文件不算', isApproved('c.py', FIXTURES, fixturePlan, FIXTURES), false);
const fixtureState = await inspectPlan({ get: () => undefined }, { cwd: FIXTURES, plan: null, planStamp: undefined });
check('夹具目录里 inspectPlan 读到计划', fixtureState.status, 'ok');
check('夹具目录里越界文件被报出', classifyWrite({ name: 'write', cwd: FIXTURES, approved: fixtureState.approved, planDir: fixtureState.dir, args: { file_path: 'zzz.py' } })?.kind, 'unapproved');

console.log('\n--- /drift 报告文案 ---');
function reportFor(plan) {
  return formatDriftReport({
    cwd: CWD,
    plan,
    repeats: new Map(),
    alerts: [],
    seen: new Set(),
    lastSeen: 0,
    logBroken: false,
  });
}
check('规则 1 生效时说明已解析', reportFor({ status: 'ok', approved }).includes('规则 1 生效'), true);
check('规则 1 生效时列出清单', reportFor({ status: 'ok', approved }).includes('src/a.py'), true);
check('解析不到计划时明确说明', reportFor({ status: 'unparsed', approved: null }).includes('未找到可解析的计划'), true);
check('没有 PLAN.md 时明确说明', reportFor({ status: 'absent', approved: null }).includes('没有 PLAN.md'), true);
check('无提醒时显示"暂无提醒"', reportFor({ status: 'absent', approved: null }).includes('暂无提醒'), true);
check('没有会话工作区时不静默', reportFor({ status: 'no-cwd', approved: null }).includes('没有记录工作目录'), true);

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
