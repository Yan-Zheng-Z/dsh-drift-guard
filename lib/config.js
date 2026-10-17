/**
 * drift-guard 配置：默认值、合并校验、插件 Config schema。
 *
 * 阈值全部可在插件配置里覆盖（下表为默认值）。交接提醒的判据是**交接收益比 R**
 * （见 `DEFAULT_HANDOFF_RATIO`）：读不到上下文 token 计量时，按"主会话调用次数 × 每次估算 token"
 * 折算上下文规模。
 *
 * **两份名单都是"追加"语义**（`sensitive`、`sensitiveAllow`）：
 *   - 用户写的条目**追加在默认条目之后**；
 *   - **空数组与未填写等价**：默认条目照常生效（设置界面保存时可能写入空数组，
 *     不能让默认保护被无声清空）；
 *   - 只有显式把 `useDefaultSensitive` 设为 `false`，才丢弃 `DEFAULT_SENSITIVE`
 *     （`useDefaultSensitiveAllow` 对放行名单同理）。
 *
 * schema 依赖 DSH 自带的 `@deepseek-ai/schemastery`（第三方插件 dsh-context、dshmarket
 * 同样把它声明为 peer）。**拿不到它不影响使用**：这时导出的 `Config` 是 undefined，
 * cordis 对没有 schema 的插件会原样透传配置（cordis/lib/index.js:956-958），
 * 默认值与校验仍由本文件的纯 JS 逻辑（`resolveConfig`）保证。
 *
 * @module dsh-drift-guard/config
 */

import { normalize } from './paths.js';

/**
 * 敏感名单的默认条目：读取类工具命中即拦截（工作区内、外一视同仁）。
 * 浏览器配置目录限定在厂商路径下，避免误伤同名目录。
 */
export const DEFAULT_SENSITIVE = [
  '.env',
  '.env.*',
  '.credentials*',
  'id_rsa',
  'id_ed25519',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '.ssh',
  '.aws',
  '.gnupg',
  '.git-credentials',
  '.netrc',
  '.pypirc',
  '.docker/config.json',
  'Google/Chrome/User Data',
  'Microsoft/Edge/User Data',
  'Mozilla/Firefox/Profiles',
];

/**
 * 放行名单的默认条目：文件名像凭据、内容却是给人看的示例文件，命中即放行。
 * 这些条目走放行名单（而不是代码里硬编码），用户可以按同样的写法**追加**，也可以
 * 用 `useDefaultSensitiveAllow: false` 停用。
 */
export const DEFAULT_SENSITIVE_ALLOW = ['.env.example', '.env.sample', '.env.template'];

/**
 * 交接收益比 R 的默认参数（公式与含义见 README「交接收益比」一节）。
 *
 * `R = r·[(C − C₀)·N + D·L·C] / H`：
 *   - `C`：主会话上下文规模（token），读不到计量时按 `calls × tokensPerCall` 估算；
 *   - `C₀`：上下文基线，低于基线的部分不计入（`(C − C₀)` 取不小于 0）；
 *   - `N`：剩余工作量的**调用次数**（= 未打勾项数 × 已完成项的平均调用数）；
 *   - `D`：当前偏离强度，`D = Σ wᵢ·e^(−Δcallsᵢ/decayCalls)`；
 *   - `L`：每单位偏离强度预计浪费的调用次数（与 `N` 同为"次数"，两项量纲一致）；
 *   - `H`：一次交接的实际 token 成本（默认 60000）；
 *   - `r`：把"浪费的调用次数 × 上下文规模"折算成钱的单价系数，取 DeepSeek 缓存命中价
 *     ¥0.02 / 百万 token（未命中 ¥1.00 / 百万 token，峰谷同比例）——**r 与 H 只以比值 r/H
 *     进入公式**，改价时按 README 的说明同步更新。
 * `C ≥ capTokens` 时无论 R 多少都提醒：兜住"R 上不去"的组合——`N = 0`（PLAN.md 可解析、
 * 且一项未勾的都不剩）同时又没有 S1–S4 在命中（`D = 0`）时 R 恒为 0，上下文再大也不提醒。
 * 注意计划**缺失或未维护**时 `N` 取 `defaultN`（20），不是 0。
 */
export const DEFAULT_HANDOFF_RATIO = {
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
};

/** R 参数各自的**下界（含）**：权重类可以是 0（等于关掉该项），分母类必须为正。 */
const RATIO_MIN = {
  r: 0,
  c0: 0,
  h: 1,
  l: 0,
  decayCalls: 1,
  wS1: 0,
  wS2: 0,
  wS3: 0,
  wS4: 0,
  wS6: 0,
  defaultN: 0,
  tokensPerCall: 1,
  capTokens: 1,
};

/** 各信号的默认阈值与通用参数。 */
export const DEFAULTS = {
  /** S1：同一工具 + 相同参数 + 相同结果，连续多少次算打转（只记日志，不注入模型）。 */
  s1Repeats: 4,
  /** S2：两组"工具+参数"来回交替多少个完整 A→B 循环（1 轮 = 2 次调用）。 */
  s2Alternations: 6,
  /** S3：同一文件在内容未修改时重复读取到第几次提醒。 */
  s3Reads: 3,
  /** S4：PLAN.md 已打勾步骤数连续多少次工具调用没有增加。 */
  s4IdleCalls: 20,
  /** S6：连续多少次工具调用既没写文件、也没推进计划/todo，算"漫游"。 */
  s6RoamCalls: 12,
  /** todo 快照在“有 PLAN.md 可用”时，连续多少次调用没更新就不再采信（回退 PLAN）。 */
  todoStaleCalls: 30,
  /** 原规则 3：同一工具 + 相同参数连续失败多少次提醒（只记日志，不注入模型）。 */
  failureRepeats: 3,
  /** 同一信号提醒过后，至少再过多少次工具调用才能重复提醒。 */
  cooldownCalls: 10,
  /** 是否使用内置敏感名单；只有显式设为 false 才停用（空数组不会停用它）。 */
  useDefaultSensitive: true,
  /** 是否使用内置放行名单（示例文件豁免）；只有显式设为 false 才停用。 */
  useDefaultSensitiveAllow: true,
  /** 敏感名单的默认条目；匹配写法见 lib/sensitive.js 顶部。 */
  sensitive: DEFAULT_SENSITIVE,
  /** 放行名单的默认条目（示例文件豁免），优先级高于敏感名单。 */
  sensitiveAllow: DEFAULT_SENSITIVE_ALLOW,
  /** 交接收益比 R 的参数组（见 `DEFAULT_HANDOFF_RATIO`）。 */
  handoffRatio: DEFAULT_HANDOFF_RATIO,
};

/** 必须为正整数的配置键。 */
const NUMBER_KEYS = [
  's1Repeats',
  's2Alternations',
  's3Reads',
  's4IdleCalls',
  's6RoamCalls',
  'todoStaleCalls',
  'failureRepeats',
  'cooldownCalls',
];

/** 布尔开关配置键：只有 `true`/`false` 才收下，其余忽略。 */
const BOOLEAN_KEYS = ['useDefaultSensitive', 'useDefaultSensitiveAllow'];

/**
 * 合并一份名单：默认条目在前，用户条目追加在后；非法项丢掉，重复项去掉（归一后比较）。
 *
 * @param {string[]} defaults - 内置条目（开关关掉时传空数组）。
 * @param {unknown} value - 用户配置里的值。
 * @returns {string[]}
 */
function mergeList(defaults, value) {
  const out = [...defaults];
  const seen = new Set(out.map((item) => normalize(item)));
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    const text = item.trim();
    if (seen.has(normalize(text))) continue;
    seen.add(normalize(text));
    out.push(text);
  }
  return out;
}

/**
 * 合并 R 的参数组：逐键覆盖，非法值（非数字、NaN、小于下界）忽略并退回默认值。
 * 整个 `handoffRatio` 不是对象时等同未填写。
 *
 * @param {unknown} value - 用户配置里的 `handoffRatio`。
 * @returns {typeof DEFAULT_HANDOFF_RATIO}
 */
function mergeRatio(value) {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = { ...DEFAULT_HANDOFF_RATIO };
  for (const [key, min] of Object.entries(RATIO_MIN)) {
    const item = input[key];
    if (typeof item === 'number' && Number.isFinite(item) && item >= min) out[key] = item;
  }
  return out;
}

/**
 * 把插件配置合并到默认值上。
 *
 * 无效值（类型不对、不是正整数、不是布尔）**忽略并退回默认值**；名单里混进非字符串时
 * 只丢掉那一项；`handoffRatio` 参数组逐键覆盖，非法键同样退回默认值。
 * 名单是**追加**语义，且**空数组与未填写等价**——默认条目照常生效，
 * 只有把对应的 `useDefault*` 开关显式设为 `false` 才会丢弃默认条目。
 * 任何情况下都不抛异常——插件内部出错不能影响工具执行。
 *
 * @param {unknown} raw - cordis 传进来的插件配置。
 * @returns {typeof DEFAULTS} 完整的配置。
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...DEFAULTS };
  for (const key of NUMBER_KEYS) {
    const value = input[key];
    if (Number.isInteger(value) && value > 0) out[key] = value;
  }
  for (const key of BOOLEAN_KEYS) {
    const value = input[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  out.sensitive = mergeList(input.useDefaultSensitive === false ? [] : DEFAULT_SENSITIVE, input.sensitive);
  out.sensitiveAllow = mergeList(
    input.useDefaultSensitiveAllow === false ? [] : DEFAULT_SENSITIVE_ALLOW,
    input.sensitiveAllow,
  );
  out.handoffRatio = mergeRatio(input.handoffRatio);
  return out;
}

/**
 * 尽量拿到 schemastery；拿不到就返回 undefined，交给 `resolveConfig` 的纯 JS 兜底。
 * `~standard` 是 cordis 校验配置时用的接口，缺了它宁可不导出 schema，
 * 也好过让 cordis 在加载时抛错。
 */
async function loadSchema() {
  let z;
  try {
    const mod = await import('@deepseek-ai/schemastery');
    z = mod.default ?? mod;
  } catch {
    return undefined;
  }
  if (z === undefined || z === null || typeof z.object !== 'function') return undefined;
  try {
    const schema = z.object({
      s1Repeats: z.number().default(DEFAULTS.s1Repeats),
      s2Alternations: z.number().default(DEFAULTS.s2Alternations),
      s3Reads: z.number().default(DEFAULTS.s3Reads),
      s4IdleCalls: z.number().default(DEFAULTS.s4IdleCalls),
      s6RoamCalls: z.number().default(DEFAULTS.s6RoamCalls),
      todoStaleCalls: z.number().default(DEFAULTS.todoStaleCalls),
      failureRepeats: z.number().default(DEFAULTS.failureRepeats),
      cooldownCalls: z.number().default(DEFAULTS.cooldownCalls),
      useDefaultSensitive: z.boolean().default(DEFAULTS.useDefaultSensitive),
      useDefaultSensitiveAllow: z.boolean().default(DEFAULTS.useDefaultSensitiveAllow),
      sensitive: z.array(z.string()).default([...DEFAULT_SENSITIVE]),
      sensitiveAllow: z.array(z.string()).default([...DEFAULT_SENSITIVE_ALLOW]),
      handoffRatio: z.object({
        r: z.number().default(DEFAULT_HANDOFF_RATIO.r),
        c0: z.number().default(DEFAULT_HANDOFF_RATIO.c0),
        h: z.number().default(DEFAULT_HANDOFF_RATIO.h),
        l: z.number().default(DEFAULT_HANDOFF_RATIO.l),
        decayCalls: z.number().default(DEFAULT_HANDOFF_RATIO.decayCalls),
        wS1: z.number().default(DEFAULT_HANDOFF_RATIO.wS1),
        wS2: z.number().default(DEFAULT_HANDOFF_RATIO.wS2),
        wS3: z.number().default(DEFAULT_HANDOFF_RATIO.wS3),
        wS4: z.number().default(DEFAULT_HANDOFF_RATIO.wS4),
        wS6: z.number().default(DEFAULT_HANDOFF_RATIO.wS6),
        defaultN: z.number().default(DEFAULT_HANDOFF_RATIO.defaultN),
        tokensPerCall: z.number().default(DEFAULT_HANDOFF_RATIO.tokensPerCall),
        capTokens: z.number().default(DEFAULT_HANDOFF_RATIO.capTokens),
      }),
    });
    const standard = schema?.['~standard'];
    if (standard === undefined || typeof standard.validate !== 'function') return undefined;
    return schema;
  } catch {
    return undefined;
  }
}

/** 插件 Config schema；宿主拿不到 schemastery 时为 undefined（配置照样生效）。 */
export const Config = await loadSchema();
