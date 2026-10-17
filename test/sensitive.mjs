/**
 * drift-guard v0.2 敏感读取测试：名单匹配、忽略项（近失）、放行名单、示例豁免、工作区外只记录。
 * 运行：node test/sensitive.mjs（任意目录都可运行；所有路径都在临时沙箱里造）
 */
import {
  apply,
  isSensitiveRead,
  classifyRead,
  resolveConfig,
  alertLine,
  patternStaticPrefix,
  slashes,
  EXAMPLE_EXEMPT,
} from '../lib/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-guard-sensitive-'));
const CWD = path.join(SANDBOX, 'workspace');
const OUTSIDE = path.join(SANDBOX, 'outside');
const HOME = path.join(SANDBOX, 'home');
for (const dir of [CWD, OUTSIDE, HOME]) fs.mkdirSync(dir, { recursive: true });

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
}

/** 沙箱里的绝对路径；参数用正斜杠写，Windows 下也照常工作。 */
const at = (root, ...parts) => path.join(root, ...parts);

const DEFAULT_SETTINGS = { ...resolveConfig({}), tool: 'read' };
const ALLOW_DOCS = { ...DEFAULT_SETTINGS, sensitiveAllow: [...DEFAULT_SETTINGS.sensitiveAllow, 'docs/'] };
/** 只留用户自己写的名单：显式关掉默认条目，才等价于 v0.1 的"覆盖"语义。 */
const onlyMine = (settings) => ({ tool: 'read', useDefaultSensitive: false, useDefaultSensitiveAllow: false, ...settings });

/** 默认配置下的敏感判定（read 工具）；判定要拿工具名，示例豁免才走得到。 */
const denied = (target) => isSensitiveRead({ file_path: target }, CWD, { ...DEFAULT_SETTINGS, tool: 'read' });
/** 自定义配置下的敏感判定（默认按 read 工具；settings 里给 tool 时以它为准）。 */
const deniedWith = (target, settings) => isSensitiveRead({ file_path: target }, CWD, { tool: 'read', ...settings });

console.log('--- 默认敏感名单：每一条各一个命中用例 ---');
check('.env', denied(at(CWD, '.env')), true);
check('.env.*', denied(at(CWD, '.env.production')), true);
check('.credentials*', denied(at(CWD, '.credentials.yaml')), true);
check('id_rsa', denied(at(HOME, '.ssh', 'id_rsa')), true);
check('id_ed25519', denied(at(HOME, '.ssh', 'id_ed25519')), true);
check('*.pem', denied(at(CWD, 'certs', 'server.pem')), true);
check('*.key', denied(at(CWD, 'private.key')), true);
check('*.pfx', denied(at(CWD, 'client.pfx')), true);
check('*.p12', denied(at(CWD, 'client.p12')), true);
check('.ssh 目录', denied(at(HOME, '.ssh', 'known_hosts')), true);
check('.aws 目录', denied(at(HOME, '.aws', 'config')), true);
check('.gnupg 目录', denied(at(HOME, '.gnupg', 'secring.gpg')), true);
check('.git-credentials', denied(at(HOME, '.git-credentials')), true);
check('.netrc', denied(at(HOME, '.netrc')), true);
check('.pypirc', denied(at(HOME, '.pypirc')), true);
check('.docker/config.json', denied(at(HOME, '.docker', 'config.json')), true);
check('Chrome 的 User Data', denied(at('C:/Users/x/AppData/Local/Google/Chrome/User Data/Default/Login Data')), true);
check('Chrome 的 User Data（目录本身）', denied(at('C:/Users/x/AppData/Local/Google/Chrome/User Data')), true);
check('Edge 的 User Data', denied(at('C:/Users/x/AppData/Local/Microsoft/Edge/User Data/Default/Login Data')), true);
check('Firefox 的 Profiles', denied(at('C:/Users/x/AppData/Roaming/Mozilla/Firefox/Profiles/abc.default/logins.json')), true);

console.log('\n--- 近失：同名目录不在厂商路径下就不拦 ---');
check('别家 AppData 下的 Profiles 不拦', denied(at('C:/Users/x/AppData/Roaming/SomeApp/Profiles/data.json')), false);
check('裸露的 Profiles 目录不拦', denied(at(CWD, 'Profiles', 'data.json')), false);
check('裸露的 User Data 目录不拦', denied(at(CWD, 'User Data', 'x.txt')), false);
check('.docker 之外的 config.json 不拦', denied(at(CWD, 'config.json')), false);
check('同名的 config.json 在家目录也不拦', denied(at(HOME, 'config.json')), false);
check('keys 目录里的普通文件不拦', denied(at(CWD, 'keys', 'readme.txt')), false);
check('普通源码不拦', denied(at(CWD, 'src', 'main.py')), false);
check('名叫 key 的文件不拦（只按扩展名）', denied(at(CWD, 'key')), false);

console.log('\n--- 示例文件豁免（默认由放行名单承载）---');
check('.env.example 豁免', denied(at(CWD, '.env.example')), false);
check('.env.sample 豁免', denied(at(CWD, '.env.sample')), false);
check('.env.template 豁免', denied(at(CWD, '.env.template')), false);
check('默认放行名单就是这三条', resolveConfig({}).sensitiveAllow, ['.env.example', '.env.sample', '.env.template']);
check('EXAMPLE_EXEMPT 与默认放行名单一致', [...EXAMPLE_EXEMPT], resolveConfig({}).sensitiveAllow);
check('子目录里的示例文件也豁免', denied(at(CWD, 'fixtures', '.env.example')), false);
check('示例豁免优先于敏感名单（仍用默认放行名单）', deniedWith(at(CWD, '.env.example'), resolveConfig({ sensitive: ['.env*'] })), false);

console.log('\n--- 放行名单 ---');
check('放行名单按目录前缀生效', deniedWith(at(CWD, 'docs', '.env'), ALLOW_DOCS), false);
check('放行名单之外仍拦', deniedWith(at(CWD, 'docs2', '.env'), ALLOW_DOCS), true);
check('放行名单里的通配条目', deniedWith(at(CWD, '.env'), onlyMine({ sensitive: ['.env'], sensitiveAllow: ['*.env'] })), false);
check('放行名单里的段条目', deniedWith(at(CWD, 'test', 'secret.key'), onlyMine({ sensitive: ['*.key'], sensitiveAllow: ['test'] })), false);
check('空放行名单不豁免', deniedWith(at(CWD, '.env'), DEFAULT_SETTINGS), true);
check('关掉默认放行名单但用户写了豁免 → 照常放行', deniedWith(at(CWD, '.env.example'), onlyMine({ sensitive: ['.env*'], sensitiveAllow: ['.env.example'] })), false);

console.log('\n--- 判定函数只认路径字段 ---');
const classify = (args) => classifyRead({ args, cwd: CWD, settings: DEFAULT_SETTINGS });
check('read 的 file_path → 命中', classify({ file_path: '.env' })?.kind, 'sensitive-read');
check('ops_inspect_local_file 的 path → 命中', classify({ path: '.env' })?.kind, 'sensitive-read');
check('grep 的 path → 命中', classify({ pattern: 'TOKEN', path: '.env' })?.kind, 'sensitive-read');
check('grep 只给模式时不命中', classify({ pattern: 'password' }), null);
check('glob 的 path → 命中', classify({ pattern: '*', path: '.ssh' })?.kind, 'sensitive-read');
check('没有路径字段时判定为空', classify({ command: 'ls' }), null);
check('没有会话工作区时判定为空', classifyRead({ args: { file_path: '.env' }, cwd: '', settings: DEFAULT_SETTINGS }), null);

console.log('\n--- glob / ops_glob 的 pattern：当模式看，不当文件路径读 ---');
const globSensitive = (pattern, tool = 'ops_glob') => classifyRead({
  args: { pattern }, cwd: CWD, settings: { ...DEFAULT_SETTINGS, tool },
});
// 模式里的"字面前缀"就是它要搜进去的目录；那里是敏感位置时照常拦（工作区内、外一视同仁）。
check('绝对 pattern 指进敏感目录（.env 段）→ 拦', globSensitive(`${OUTSIDE}/.env`)?.kind, 'sensitive-read');
check('内置 glob 的绝对 pattern 同样拦', globSensitive(`${OUTSIDE}/.env`, 'glob')?.kind, 'sensitive-read');
check('绝对 pattern 指进 .ssh 目录 → 拦', globSensitive(`${OUTSIDE}/.ssh/*.pem`)?.kind, 'sensitive-read');
check('相对 pattern 一律不拦（在工作区里搜）', globSensitive('**/*.env'), null);
check('不带通配的相对模式不拦', globSensitive('.env'), null);
check('工作区内的绝对 pattern 指进敏感目录 → 也拦', globSensitive(`${slashes(CWD)}/.env/*.txt`)?.kind, 'sensitive-read');
check('绝对 pattern 指向不敏感目录 → 不拦（由 index.js 记一条工作区外读取）', globSensitive(`${OUTSIDE}/notes/**/*.md`), null);
check('pattern 不是字符串时不拦', globSensitive(undefined), null);
check('read 的 file_path 仍照常拦', classifyRead({
  args: { file_path: '.env' }, cwd: CWD, settings: { ...DEFAULT_SETTINGS, tool: 'read' },
})?.kind, 'sensitive-read');

console.log('\n--- 工作区外判定用的字面前缀 ---');
check('绝对 pattern 取通配符之前的部分', patternStaticPrefix('C:/Users/x/.ssh/*.pem'), 'C:/Users/x/.ssh');
check('反斜杠写法同样处理', patternStaticPrefix('C:\\Users\\x\\.ssh\\*.pem'), 'C:/Users/x/.ssh');
check('没有通配符时整串都是字面路径', patternStaticPrefix('C:/Users/x/.env'), 'C:/Users/x/.env');
check('末尾多余分隔符去掉', patternStaticPrefix('C:/Users/x/.ssh/'), 'C:/Users/x/.ssh');
check('相对 pattern 没有字面前缀', patternStaticPrefix('src/**/*.js'), undefined);
check('通配符开头的 pattern 没有字面前缀', patternStaticPrefix('**/*.env'), undefined);
check('非字符串没有字面前缀', patternStaticPrefix(42), undefined);

console.log('\n--- 工作区外的敏感文件同样拦 ---');
check('工作区外的 .env 也命中', isSensitiveRead({ file_path: at(OUTSIDE, '.env') }, CWD, DEFAULT_SETTINGS), true);
check('工作区外不敏感的 README 不命中', isSensitiveRead({ file_path: at(OUTSIDE, 'README.md') }, CWD, DEFAULT_SETTINGS), false);
check('工作区外的 .env 也给出 sensitive-read 判定', classifyRead({
  args: { file_path: at(OUTSIDE, '.env') }, cwd: CWD, settings: DEFAULT_SETTINGS,
})?.kind, 'sensitive-read');

console.log('\n--- 日志行 ---');
check('敏感拦截的日志行', alertLine({ type: 'sensitive-read', at: 0, tool: 'read', target: '.env' }).includes('拦截敏感文件读取：tool=read 目标=.env'), true);
check('工作区外读取的日志行', alertLine({ type: 'outside-read', at: 0, tool: 'read', target: 'D:/notes.md' }).includes('工作区外读取记录：tool=read 目标=D:/notes.md'), true);
check('"只记录"写在行里', alertLine({ type: 'outside-read', at: 0, tool: 'read', target: 'x' }).includes('（只记录，未拦截）'), true);
check('敏感拦截的行不是"未知提醒类型"', alertLine({ type: 'sensitive-read', at: 0, tool: 'read', target: '.env' }).includes('未知提醒类型'), false);

console.log('\n--- 配置：名单是"追加"语义，空数组不丢默认 ---');
const defaults = resolveConfig({});
check('默认敏感名单里含厂商路径条目', defaults.sensitive.includes('Google/Chrome/User Data'), true);
check('默认放行名单就是示例文件那三条', defaults.sensitiveAllow, ['.env.example', '.env.sample', '.env.template']);
check('用户条目追加在默认条目之后', resolveConfig({ sensitive: ['only-me.txt'] }).sensitive.at(-1), 'only-me.txt');
check('追加后默认条目一条不少', resolveConfig({ sensitive: ['only-me.txt'] }).sensitive.length, defaults.sensitive.length + 1);
check('追加不重复（逐字相同的条目被去掉）', resolveConfig({ sensitive: ['.env'] }).sensitive, defaults.sensitive);
check('放行名单同样追加', resolveConfig({ sensitiveAllow: ['docs/'] }).sensitiveAllow, [...defaults.sensitiveAllow, 'docs/']);
check('名单里混进非字符串只丢那一项', resolveConfig({ sensitiveAllow: ['docs/', 42, '  '] }).sensitiveAllow, [...defaults.sensitiveAllow, 'docs/']);
check('空数组与未填写等价（敏感名单）', resolveConfig({ sensitive: [] }).sensitive, defaults.sensitive);
check('空数组与未填写等价（放行名单）', resolveConfig({ sensitiveAllow: [] }).sensitiveAllow, defaults.sensitiveAllow);
check('useDefaultSensitive: false 才丢掉默认敏感名单', resolveConfig({ useDefaultSensitive: false, sensitive: ['only-me.txt'] }).sensitive, ['only-me.txt']);
check('关掉默认后没有用户条目就是空名单', resolveConfig({ useDefaultSensitive: false }).sensitive, []);
check('useDefaultSensitiveAllow: false 才丢掉示例豁免', resolveConfig({ useDefaultSensitiveAllow: false }).sensitiveAllow, []);
check('关掉默认后示例文件不再豁免', deniedWith(at(CWD, '.env.example'), resolveConfig({ useDefaultSensitiveAllow: false })), true);
check('名单给的不是数组时退回默认', resolveConfig({ sensitive: 'x' }).sensitive, defaults.sensitive);
check('开关给的不是布尔时退回默认', resolveConfig({ useDefaultSensitive: 'no' }).useDefaultSensitive, true);

console.log('\n--- 管线集成：注册真实监听器后，拦截与记录如何发生 ---');
{
  /** 只够跑通插件的最小 ctx：把两个监听器与 /drift 命令收下来。 */
  function fakeCtx() {
    const listeners = {};
    let command = null;
    return {
      listeners,
      get command() {
        return command;
      },
      effect(generator) {
        for (const registered of generator()) void registered;
      },
      on(name, handler) {
        listeners[name] = handler;
        return () => {};
      },
      commands: { register: (definition) => { command = definition; return () => {}; } },
    };
  }
  const workspace = path.join(HOME, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.env'), 'FAKE=1\n', 'utf8');
  const session = { id: 'sensitive-pipeline', header: { cwd: workspace } };
  const ctx = fakeCtx();
  apply(ctx, {});
  const pre = ctx.listeners['tools/pre-execute'];
  const post = ctx.listeners['tools/post-execute'];
  const accept = async () => undefined;
  const execOf = (name, args) => ({ name, arguments: args, agent: { session } });
  const resultOf = (text) => ({ isError: false, content: [{ type: 'text', text }] });

  // 规则 4：命中敏感名单 → deny，工具体不执行
  const deniedPre = await pre(execOf('read', { file_path: '.env' }), accept);
  check('敏感读取在 pre-execute 被 deny', deniedPre.kind, 'deny');
  check('拦截原因写明命中敏感名单', deniedPre.reason.includes('命中敏感名单'), true);
  check('拦截原因给出工作区与补救办法', [
    deniedPre.reason.includes(workspace),
    deniedPre.reason.includes('sensitiveAllow'),
    deniedPre.reason.includes('不是用户的批准或拒绝'),
  ], [true, true, true]);
  check('拦截带自己的错误码', deniedPre.info, { name: 'DriftGuardBlockedError', code: 'DRIFT_GUARD_SENSITIVE_READ' });
  check('子路径里的敏感文件同样被拦', (await pre(execOf('grep', { pattern: 'TOKEN', path: '.ssh' }), accept)).kind, 'deny');

  // 放行：示例文件、普通文件、工作区内的搜索
  check('示例文件照常放行', await pre(execOf('read', { file_path: '.env.example' }), accept), undefined);
  check('普通文件照常放行', await pre(execOf('read', { file_path: 'src/main.py' }), accept), undefined);
  check('工作区内搜索照常放行', await pre(execOf('grep', { pattern: 'TOKEN' }), accept), undefined);

  // 规则 5：工作区外的不敏感读取 → 放行 + 只记一条
  const outsideFile = path.join(SANDBOX, 'notes.md');
  fs.writeFileSync(outsideFile, '# 外部笔记\n', 'utf8');
  await pre(execOf('read', { file_path: outsideFile }), accept);
  const outside = await post(execOf('read', { file_path: outsideFile }), resultOf('外部笔记内容'), accept);
  check('工作区外的不敏感读取照常返回结果', [outside?.kind, outside?.content], [undefined, undefined]);

  await pre(execOf('read', { file_path: 'src/main.py' }), accept);
  const inside = await post(execOf('read', { file_path: 'src/main.py' }), resultOf('普通内容'), accept);
  check('工作区内普通读取不记录、不追加', [inside?.kind, inside?.content], [undefined, undefined]);

  await pre(execOf('grep', { pattern: 'TOKEN' }), accept);
  await post(execOf('grep', { pattern: 'TOKEN' }), resultOf('没有命中'), accept);

  // glob 的绝对 pattern：DSH 不按绝对 pattern 搜索，所以不拦，只记一条工作区外读取
  const absolutePattern = `${slashes(SANDBOX)}/notes/**/*.md`;
  const globExec = () => execOf('ops_glob', { pattern: absolutePattern });
  check('绝对 pattern 的 glob 调用不被拦', await pre(globExec(), accept), undefined);
  await post(globExec(), resultOf('没有匹配的文件'), accept);
  const absoluteSearch = await post(execOf('ops_glob', { pattern: `**/*.md` }), resultOf('没有匹配的文件'), accept);
  check('相对 pattern 的 glob 调用不记录、不追加', [absoluteSearch?.kind, absoluteSearch?.content], [undefined, undefined]);

  const log = fs.readFileSync(path.join(workspace, '.drift', 'alerts.log'), 'utf8');
  check('工作区外读取记两条（read 的 notes.md + glob 的绝对 pattern）', log.split('工作区外读取记录').length - 1, 2);
  check('日志行里带上目标文件', log.includes('notes.md'), true);
  check('不带 path 的搜索没有被记成工作区外', log.includes('工作区外读取记录：tool=grep'), false);
  check('没有 path 的搜索按工作区解释、只记一条', log.split('tool=grep 目标=.').length - 1, 1);
  check('绝对 pattern 的 glob 被记成工作区外读取', log.includes('工作区外读取记录：tool=ops_glob'), true);
  check('记录里保留完整 pattern', log.includes('notes/**/*.md'), true);
  check('敏感拦截也进了日志', log.includes('拦截敏感文件读取：tool=read 目标=.env'), true);

  const report = await ctx.command.handler({ agent: session });
  check('/drift 报告里能看到敏感拦截', report.text.includes('拦截敏感文件读取'), true);
  check('/drift 报告里能看到工作区外读取', report.text.includes('工作区外读取记录'), true);

  // 会话形态：宿主给"带 session 的执行体"或直接给会话本身，都必须认出来
  const wrapped = await ctx.command.handler({ agent: { session, id: 'agent-1' } });
  check('执行体形态也能认出会话', wrapped.kind, 'success');
  check('两种形态读到同一份提醒', wrapped.text.includes('拦截敏感文件读取'), true);
  check('认不出会话时明确报错（不静默）', (await ctx.command.handler({})).kind, 'error');
  check('认不出会话时的文案', (await ctx.command.handler({})).text, 'drift-guard：找不到当前会话。');
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
