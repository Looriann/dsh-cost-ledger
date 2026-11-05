# dsh-cost-ledger · 设计文档

> 状态：草案 v0.1 · 2026-11-04
> 作者：你（第一作者）· 目标读者：你自己，以及未来来改这个项目的人
> 决策前提：走**战略 B** —— 不做第四个 token 面板，只补「**价格口径 + 每日账本 + 对账**」
> 参考实现（都在你机器上，随时能翻）：`dsh-context` 0.77、`@kidli1412/dsh-session-cost` 0.3.2、`dsh-whale-widget` 0.4.2

---

## 0. TL;DR

1. **token 采集这件事 DSH 已经做对了**，每个步骤的 usage、provider、model 都在事件里。
2. 你看到的「不准」，是**价格换算**不准：模型身份认错、价目表查不到、计价规则套错、币种和免费额度没算。
3. 所以本项目只做三件事：**价格解析引擎**、**按天账本**、**对账**。
4. 技术上是一个双半边的 DSH 插件：Host 半边（Node）收事件、算钱、落盘、开 HTTP 接口；Client 半边（React）加一个「费用」标签页画图。
5. 先做 M1（2 天）就能解决你自己的问题，别一上来做自动抓价。

---

## 1. 预备知识：一个 DSH 插件到底是什么

这一章是给小白的。看完你应该能回答：「我在写的东西跑在哪个进程里？它是怎么被加载的？它能碰什么、不能碰什么？」

### 1.1 DSH 是"两半"的程序

DSH 是一个 Electron 应用，本质上是两个运行环境拼在一起：

| | Host 半边 | Client 半边 |
|---|---|---|
| 跑在哪 | Electron 主进程里的 Node | 窗口里的浏览器（Chromium） |
| 谁在跑 | agent 主循环、工具执行、会话日志、模型调用 | React 单页应用，就是你看得见的界面 |
| 能干什么 | 读写文件、起 HTTP 服务、发网络请求、读 `~/.dsh` | 只能操作 DOM、发 `fetch` |
| 你的插件写什么语言 | JavaScript / TypeScript（Node ESM） | JavaScript / TypeScript + React 组件 |
| 两边怎么说话 | 通过 Host 注册的 HTTP 路由（`/api/...`）互相 `fetch` | 同左 |

**为什么必须分成两半？** 因为浏览器里不能直接读磁盘、不能拿 API key、不能算几万条日志。所以「数据和计算」放 Host，「展示」放 Client。这条边界是 DSH 故意画的，也是所有正经桌面应用的标准做法。

> 你现在看到的界面里，「对话 / 轨迹 / 上下文 / 编队」那一排标签，是 Client 半边渲染的；「上下文」和「编队」两个标签就是 `dsh-context` 这个插件加上去的 —— 也就是说**"多一个栏目"这件事，插件完全做得到**。

### 1.2 cordis：DSH 的"插座系统"

cordis 是 DSH 用的插件框架（`@deepseek-ai/cordis`）。你只需要记住三个词：

- **service（服务）**：别人提供的能力，比如 `webServer`（开路由）、`sessions`（会话注册表）、`credentials`（拿密钥）、`settings`。用 `ctx.get('名字')` 或声明 `inject` 拿到。
- **plugin（插件）**：一个导出了 `apply(ctx)` 的模块。这就是你的代码。
- **context（上下文）**：`apply` 收到的那个 `ctx`，上面挂着所有服务，还有 `ctx.on` / `ctx.effect` / `ctx.slots` 这些工具。

两个关键词汇，写代码时天天用：

```js
export const inject = ["webServer", "sessions"]   // 声明依赖：这两个服务就绪了我才启动
export function apply(ctx, config) {              // 插件入口，只调一次
  ctx.effect(() => ctx.on("session/event", handler), "cost-ledger: 订阅")
  //  ↑ ctx.effect 会在插件卸载/热重载时自动调用返回的清理函数，防止监听器泄漏
}
```

`inject` 写错名字的后果是：插件**静默不启动**，日志里只留一行。这是新手第一个坑，记住排查顺序是「先看 inject 名字对不对」。

### 1.3 一个插件包的最小结构

```
dsh-cost-ledger/
├─ package.json          # 声明：我是 DSH 插件，我的两个半边在哪
├─ cordis.patch.yml      # 往 DSH 的插件树里"插一行"
├─ lib/
│  ├─ index.js           # Host 半边（Node）
│  ├─ client.js          # Client 半边（浏览器，React）
│  ├─ ledger.js          # 账本：写样本、算日汇总
│  ├─ pricing.js         # 价格解析引擎
│  └─ sync.js            # 价目表同步
├─ scripts/
│  └─ replay.mjs         # 拿真实会话日志回放做验证（离线、可测试）
└─ README.md
```

`package.json` 里真正让 DSH 认你的，是这几个字段（照抄你机器上 `@kidli1412/dsh-session-cost` 的写法）：

```jsonc
{
  "name": "dsh-cost-ledger",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",          // Host 半边入口
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // ① 怎么插进插件树
    "client": {                                     // ② 浏览器半边怎么加载
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation"
      ]
    },
    "compatibility": { "dshReleases": { "0.2.0-rc.2": "compatible" } }
  }
}
```

`cordis.patch.yml` 只有三行，作用是「在插件树末尾插一行」：

```yaml
- insert:
    - id: cost-ledger
      name: dsh-cost-ledger
```

这里的 `id`（`cost-ledger`）很重要：它就是**设置表单的 key**，浏览器里用 `ctx.configForms.get("cost-ledger")` 找到你的配置。

### 1.4 它是怎么被装进来的（加载链路）

```
① ~/.dsh/profiles/desktop/package.json 里的 dsh.profile.bundles 列出要装的包
        │  （你现在的列表：dsh-base, dsh-web-app, dshmarket, modlens, archify,
        │    dsh-context, dsh-plugin-save-token, dsh-session-cost, dsh-whale-widget）
        ▼
② 每个包自带 cordis.patch.yml，DSH 把它们依次叠加成一张"插件清单"
        ▼
③ 清单里每一行 = 一个 entry，有 id 和 name（= 包名）
        ▼
④ Loader 按 name 去 node_modules 里 import 这个包的主入口 → 这就是 Host 半边
        ▼
⑤ 同时看 package.json 的 dsh.client → 把 lib/client.js 当作浏览器脚本注入页面
        ▼
⑥ 结果是：一个包，两个进程，各跑各的 apply()
```

**装插件**就是改第 ① 步那个列表 + 装依赖。命令行（你这台机器的 `dsh` 在 runtime 里，不在 PATH）：

```powershell
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:C:\Users\Lenovo\Desktop\DSH_project\DSH_cost
```

`link:` 是开发模式：不复制，直接指向你的目录，改完重启 DSH 就生效（Client 半边要重新构建 + `Ctrl+Shift+R` 硬刷新）。

### 1.5 插件在运行时能看见什么

**看见事件流。** 宿主会把会话里发生的每一件事广播出来，你的插件订阅：

```js
ctx.on("session/event", (session, event) => {
  // session.id —— 会话 id
  // event.type —— 事件类型，event.data —— 载荷
})
```

你这个会话的日志里实际出现了 19 种事件（附录 A 有完整清单）。其中对我们唯一重要的是 `assistant/message`：

```json
{
  "type": "assistant/message",
  "seq": 42,
  "time": 1762248000000,
  "data": {
    "turn": 1,
    "step": 0,
    "message": {
      "source": { "kind": "model", "provider": "bailian", "model": "deepseek-v4.1-flash-1017" }
    },
    "usage": {
      "inputTokens": 2392,
      "cacheReadTokens": 8960,
      "outputTokens": 675,
      "totalTokens": 12027
    }
  }
}
```

这就是**全部原料**：谁（provider + model）、什么时候（time）、花了多少（四个 token 分项）。剩下的全是价格问题。

**还能看见"插槽"。** Client 半边通过命名插槽往界面里塞东西，插槽名是字符串。你这台机器上已经用到的插槽：

| 插槽名 | 位置 | 谁在用 |
|---|---|---|
| `conversation.view` | **会话顶部那排标签页**（对话/轨迹/上下文/编队） | `dsh-context` 的上下文页、编队页 |
| `conversation.composer.dock` | 输入框下面那条统计栏 | `dsh-session-cost` 的费用 pill |
| `conversation.input.overlay` | 输入框浮层 | `dsh-context` |
| `sidebar.panellist` | 左侧边栏一级入口（插件、自动化任务那一列） | `dsh-context` 的洞察页 |
| `sidebar.right.pane.tab` | 右侧栏标签 | `dsh-context` |
| `main` | 主区域 | `dsh-context` |
| `plugins.bundle.config` | 插件配置区 | `dsh-context` |

我们要的「多一个栏目」，就是往 `conversation.view` 注册一个标签。

### 1.6 开发闭环

```
改代码 → 重启 DSH（Host 生效）→ 构建 client.js → 浏览器 Ctrl+Shift+R
   ↓ 出问题
看日志：
  ~/.dsh/profiles/desktop/.plugin-manager/logs/*.log   ← 装插件/依赖的日志
  D:\DSH\log\                                          ← 应用日志
  浏览器 DevTools Console                              ← Client 半边报错
  你的 /api/cost-ledger/health                          ← 我们自己加的"自检"接口
```

---

## 2. 问题定义

### 2.1 用户故事

> 我用的是阿里百炼（还挂着学生免费额度），模型是 `deepseek-v4.1-flash-1017`、`cmaas-glm-5.3` 这种。
> 我想知道：**今天花了多少、这个月花了多少、哪一轮最贵、钱花在哪个模型上、还剩多少免费额度。**
> 现在的插件要么显示 ¥0.00，要么数字明显不对，而且我在百炼控制台里翻半天也找不到像样的用量页。

### 2.2 现有三件套的失效点（实测）

| 插件 | 它的价格从哪来 | 对你的具体失效 |
|---|---|---|
| `dsh-context` 0.77 | models.dev，**按模型名前缀猜 provider**（`qwen*`→alibaba、`glm-*`→zhipuai） | 忽略事件里真实的 `provider: "bailian"`；`cmaas-*`、`vanchin/*` 查不到 → 静默无价 |
| `@kidli1412/dsh-session-cost` 0.3.2 | `lib/cost.js` 里**硬编码的 DeepSeek CNY 价表** + 可选 raw config 覆盖 | 7 个模型里只认得 deepseek 系列，而且套的是**官方 DeepSeek 的峰谷规则**（高峰 ×2），百炼转售不一定有这个规则 |
| `dsh-whale-widget` 0.4.2 | **余额差观测**（打开界面时对比余额变化） | 百炼没有 `/user/balance` 这种接口 → 退化成"本地估算"，且要求界面一直开着 |

我拿你配置里的模型去 models.dev 实测探测的结果：

| 模型 ID | 命中情况 |
|---|---|
| `qwen3.8-max` | ✅ 有（`alibaba`，$2 / $6 per 1M，USD） |
| `deepseek-v4.1-flash-1017` | ⚠️ 只在 `cortecs` / `llmgateway` / `alibaba-token-plan` 这类**转售商**名下，`alibaba` 主条目里没有 |
| `glm-5.3` | ⚠️ 只有 `aihubmix` 之类转售商 |
| `cmaas-glm-5.3` | ❌ 完全查不到 |
| `kimi/kimi-k3.1-pro` | ❌ 完全查不到 |
| `vanchin/deepseek-v4-pro` | ❌ 完全查不到 |

**结论：这不是"再写一个图表插件"能解决的问题，是"价格从哪来、怎么核验"的问题。**

> **勘误（实现阶段核实）**：上表只代表 models.dev 的情况。百炼官方价目页其实上架了这些第三方模型，
> 所以 `kimi/kimi-k3.1-pro`（13 / 68 元）、`vanchin/deepseek-v4-pro`（12 / 24 元）、
> `deepseek-v4.1-flash-1017`（2 / 8 元）、`glm-5.3`（8 / 28 元）都是**能自动抓到官方价**的。
> 真正查不到的只剩私有部署（`cmaas-glm-5.3` 这类带租户前缀的）。
> 这也修正了 2.3 的第 2 条：目录问题的边界是「私有部署」，不是「第三方模型」。

### 2.3 根因拆成四条

1. **身份问题**：同一份权重，通过不同 provider 卖，价格不同。所以价格表的 key 必须是 `(provider, model)` 二元组，不能只用 model。
2. **目录问题**：公共价目表覆盖不到**私有部署**（`cmaas-` 前缀就是这类），必须有**本地价目 + 手动覆盖**作为一等公民。（第三方模型在百炼官方页里有价，见上方勘误）
3. **规则问题**：价格不是 4 个数字，是「分档 × 峰谷 × 缓存 × 批量」的规则集，抄错一条就整体偏移。
4. **币种与额度问题**：models.dev 是 USD，百炼是 CNY，学生权益是**免费 token 额度**而不是钱。只显示 ¥ 会让人误解。

---

## 3. 产品定义

### 3.1 一句话

> 一个**诚实的**费用账本：每个数字都能说清「从哪条事件来、用哪条价、置信度多少」，并和真实账单对得上。

### 3.2 三个能力（也是三个里程碑）

| 能力 | 说明 | 里程碑 |
|---|---|---|
| **A. 价格解析引擎** | `(provider, model)` → 规则集；五级优先级；每个价格带来源和抓取时间 | M1（手动）/ M2（自动同步） |
| **B. 每日账本** | 事件 → 样本 → 按 `天 × provider × model` 汇总；跨会话、跨子 agent；可导出 CSV | M1 |
| **C. 对账与额度** | 估算 vs 余额/账单；免费额度剩余；预算告警 | M3 |

### 3.3 明确的非目标（这一节和功能列表一样重要）

- ❌ **不做** token 采集的原创新实现 —— 直接复用 DSH 的事件，口径对齐 `dsh-token-meter`。
- ❌ **不做**「余额监控」—— 那是鲸鱼插件的活，我们只做「账单对账」，且明确标注是估算。
- ❌ **不做**多云代理/转发 —— 不碰你的 API 请求链路，零侵入。
- ❌ **不猜** —— 查不到价格就显示「未定价」，绝不用一个随便的默认价糊上去。

### 3.4 成功标准（可验证，不是"感觉不错"）

1. 任意一条 `assistant/message`，能在界面上点开看到它被算成了多少钱、用的哪条价、什么置信度。
2. 回放你 `~/.dsh/sessions/` 下的真实日志，`scripts/replay.mjs` 的输出与界面数字**逐位一致**。
3. 连续 30 天的估算 vs 真实账单，差额 < 5%（或每一笔差异都能解释）。
4. 首次打开时，7 个模型里至少 6 个能自动定价或明确告知「为什么定不了」。

---

## 4. 记账模型（本文档最核心的一章）

### 4.1 事实层：一条 usage sample

把每个 `assistant/message` 归一化成一条**不可变**的样本：

```ts
type UsageSample = {
  sessionId: string
  turn: number
  step: number          // 幂等键 = (sessionId, turn, step)
  ts: number            // 毫秒时间戳，来自 event.time
  provider: string      // 来自 data.message.source.provider
  model: string         // 来自 data.message.source.model
  input: number         // 未命中缓存的输入
  cacheRead: number     // 缓存命中读
  cacheWrite: number    // 缓存写（部分 provider 没有，缺省 0）
  output: number        // 输出（reasoning 已包含在内！）
}
```

三条纪律：

1. **以分项为准，不用 `totalTokens` 算钱。** `totalTokens` 只用来做一致性校验（`input + cacheRead + cacheWrite + output`）。
2. **reasoning 不单独计价。** DSH 保证 `reasoningTokens ⊆ outputTokens`，再加一遍就是双倍（有插件踩过，实测偏高约一倍）。
3. **时间戳用事件自己的 `time`**，不用「处理时刻」。否则补算历史日志时，峰谷判断会全错。

### 4.2 幂等：同一个 `(session, turn, step)` 只能算一次

DSH 对同一个步骤可能上报多次（流式 usage chunk + 最终 message），也可能因为重连重复投递。所以：

- 内存里维护 `Set<"sessionId:turn:step">`，命中就**替换**旧样本而不是累加；
- 落盘时先按 key 查重（`samples.ndjson` 顺序扫描 + 启动时建索引）；
- `POST /rebuild` 做全量重放时也要遵守同一规则。

> 这条规则是「数字突然翻倍」类 bug 的唯一防线。

### 4.3 价格解析：五级优先级 + 置信度

给定 `(provider, model, ts)`，按顺序找第一个命中的价：

| 级别 | 来源 | 置信度标签 | UI 展示 |
|---|---|---|---|
| 1 | 用户手填（带"已核对"日期） | `exact` | 绿点 |
| 2 | 供应商官方价目快照（我们抓的/你贴的） | `official` | 蓝点 |
| 3 | 聚合目录（models.dev / LiteLLM / OpenRouter） | `aggregator` | 灰点 |
| 4 | 同模型在其它 provider 下的价格（继承） | `inherited` | 黄点 + 提示 |
| 5 | 同系列兜底（如 `cmaas-*` → 用同系列 flash 价） | `estimated` | 橙点 + 醒目提示 |
| — | 都没有 | `unpriced` | 红点，成本记 `null`，token 照常计数 |

**关键设计**：`null` 和 `0` 是两回事。没有价格时成本是 `null`，界面显示「未定价（12.3K tokens）」，绝不显示 ¥0.00。

匹配顺序（M1 只做前面几条）：

```
精确 (provider, model, effectiveAt 之前最新的一条)
  → 去掉日期后缀（-2026-01-15 / -1017 / -0731）
  → 去掉 provider 前缀（vanchin/deepseek-v4-pro → deepseek-v4-pro）
  → 大小写归一 + 分隔符归一（_ . : @ → -）
  → 别名表（你手填的 alias）
  → 交给下一级来源
```

### 4.4 计价公式

```
cost = Σ_bucket ( tokens_bucket / 1e6 × rate_bucket )

bucket ∈ { input, cacheRead, cacheWrite, output }
rate_bucket = price(provider, model, ts).bucket
            × tierMultiplier(promptTokens)        // 输入长度分档
            × periodMultiplier(ts)                // 峰谷（仅当 provider 开启）
            × fxRate                              // 仅当价格是 USD 而账本是 CNY
```

实现要点：

- **整数微元**：内部用 `microCNY`（= ¥ × 1e6，整数）记账，显示时再除。浮点累加 30 天后会出现分位漂移。
- **分档**：`promptTokens = input + cacheRead + cacheWrite`，用它选档。qwen 系的档位边界（32K/128K 之类）写进价目表，不写进代码。
- **峰谷**：只在价目行标记 `peakWindows` 时才启用。百炼的 deepseek 是否峰谷计价，**必须你核对后勾选**，不能默认继承 DeepSeek 官方规则。
- **缓存写**：缺价时按 `input` 价计（保守），并在 UI 上注明。

### 4.5 币种与额度

- 账本统一记 **CNY**，价目行记**原币种**，换算用**抓取当天的汇率快照**（存下来，不实时查，否则历史数字会变）。
- 免费额度是**独立的计量轴**：`额度消耗 = Σ tokens`（按模型分），不参与金额换算。界面上并列显示：
  - `折算成本 ¥12.40`（如果按标价付费是多少）
  - `免费额度 已用 1.2M / 剩余 8.8M tokens`
- 两者都展示，用户才不会误解。

### 4.6 算例（用你 11-04 那条真实事件）

样本：`input=2392, cacheRead=8960, output=675`，假设价目（¥/1M）：

```
input ¥1.00 · cacheRead ¥0.02 · cacheWrite ¥1.00 · output ¥4.00
```

```
input     : 2392 / 1e6 × 1.00  = 0.0023920
cacheRead : 8960 / 1e6 × 0.02  = 0.0001792
output    :  675 / 1e6 × 4.00  = 0.0027000
                         合计  = 0.0052712  → ¥0.0052712
```

顺手得到两个有用的派生指标：

- 缓存命中率 = `8960 / (2392 + 8960)` = **78.9%**
- 等效单价 = `0.0052712 / 12027 × 1e6` = **¥0.438 / 1M tokens**

> **顺带解释你的截图**：官方那张图 hover 显示 `¥0.00` 不是 bug —— 单轮成本是 ¥0.005，两位小数直接抹平了。所以我们的界面对小额必须自适应精度（≥4 位有效数字），否则你会以为插件坏了。

### 4.7 已知误差来源（必须写进 README）

| 来源 | 影响 | 我们的处理 |
|---|---|---|
| 阶梯计价选错档 | 高估/低估 2–3 倍 | 档位存价目表，用 promptTokens 选 |
| 峰谷规则误套 | 系统性 ×2 | 只有价目行显式标记才启用 |
| 缓存写缺失 | 低估 | 按 input 价保守计，UI 标注 |
| 汇率漂移 | ±2% | 存抓取日汇率快照 |
| 免费额度/赠送金 | 估算 ≠ 实付 | 并列显示"折算价"和"额度" |
| 供应商四舍五入/按次计费 | 小额偏差 | 对账页展示差额 |
| 子 agent 会话 | 漏算 | 按会话树聚合，scope 明示 |

---

## 5. 架构

### 5.1 总览

```
                    ┌──────────────── Client 半边（浏览器 / React）────────────────┐
                    │  会话标签页「费用」(conversation.view, order=40)              │
                    │   ├ KPI 条：今日 / 7 天 / 本月 / 缓存命中率 / 预算占比        │
                    │   ├ 每日堆叠柱状图（天 × 模型，hover tooltip）                │
                    │   ├ 模型明细表（provider·model·token 分项·单价·成本·徽章）    │
                    │   └ 价格编辑抽屉（手填 / 同步 diff / 未定价一键补）           │
                    └───────────────────────┬──────────────────────────────────────┘
                                            │ fetch /api/cost-ledger/*
                    ┌───────────────────────▼──────────────────────────────────────┐
                    │  Host 半边（Node / cordis plugin）                            │
                    │                                                              │
                    │  ingest ──► samples.ndjson ──► fold ──► rollups.json         │
                    │   ▲             │                │                            │
                    │   │             ▼                ▼                            │
                    │  ctx.on      pricing.js ◄──── prices.json ◄── sync.js        │
                    │  session/      五级优先级      （带来源/时间）     │            │
                    │  event                                             ▼            │
                    │                                              models.dev /        │
                    │  routes: /summary /day /session /prices /sync  LiteLLM /        │
                    │          /diff /rebuild /health                OpenRouter        │
                    └──────────────────────────────────────────────────────────────┘
                                            │
                                    ~/.dsh/cost-ledger/   （数据目录）
```

### 5.2 Host 模块划分

| 文件 | 职责 | 关键约束 |
|---|---|---|
| `lib/index.js` | 导出入 `name` / `inject` / `Config` / `apply`；订阅事件、注册路由、定时同步 | 不超过 200 行，只做接线 |
| `lib/ingest.js` | 事件 → `UsageSample`；幂等去重；兼容多种 usage 位置 | 纯函数，可单测 |
| `lib/pricing.js` | 五级解析 + 计价公式；返回 `{micro, confidence, rule, source}` | 纯函数，**不碰 IO** |
| `lib/ledger.js` | `samples.ndjson` 追加、启动重放、`rollups.json` 物化、按天查询 | 原子写（临时文件 + rename） |
| `lib/sync.js` | 抓 models.dev / LiteLLM / OpenRouter，归一成统一价目行，算 diff | 超时、重试、离线回退 |
| `lib/routes.js` | HTTP 处理 + loopback 校验 + 参数校验 | 只读接口为主，写接口要 CSRF 防护 |

`pricing.js` 和 `ingest.js` 保持纯函数，是为了能在 `scripts/replay.mjs` 里离线跑 —— **能离线验证的账本才可信**。

### 5.3 HTTP 契约

所有路由都用 `ctx.webServer.register({ kind: "exact", path, handler })` 注册，且**只监听本机回环**（DSH 自己还会校验浏览器会话 cookie，未登录的调用根本到不了）。

| 方法 | 路径 | 说明 | 返回要点 |
|---|---|---|---|
| GET | `/api/cost-ledger/summary?days=7` | KPI + 每日汇总 | `{days:[{day,tokens,micro,confidence,byModel:[...]}], kpi:{...}}` |
| GET | `/api/cost-ledger/day?day=2026-11-04` | 单日明细（按 turn 拆） | `{turns:[{turn,tokens,micro,models:[...]}]}` |
| GET | `/api/cost-ledger/session?session=<id>` | 单会话每轮成本 | 同上，过滤 session |
| GET | `/api/cost-ledger/prices` | 当前价目表 + 来源 | `[{provider,model,rates,confidence,source,fetchedAt}]` |
| PUT | `/api/cost-ledger/prices` | 手填/修正一条价 | 校验：非负数、最多 6 位小数 |
| POST | `/api/cost-ledger/prices/sync` | 触发同步 | `{added,changed,unchanged,sources:[...]}` |
| GET | `/api/cost-ledger/prices/diff` | 待审阅的变更（不自动应用） | `[{model, old, new, source}]` |
| POST | `/api/cost-ledger/rebuild` | 全量重放 samples | `{samples, days, tookMs}` |
| GET | `/api/cost-ledger/health` | 自检 | `{events, samples, priced, unpriced, unknownEventTypes}` |

`/health` 是给自己留的后路：当用户说"数字是 0"时，它能立刻区分「没收到事件」「收到了但没认出来」「认出来了但没价」三种情况。

### 5.4 Client 组件树

```
CostLedgerTab
├─ KpiRow                 今日 / 7天 / 本月 / 缓存命中率 / 预算进度
├─ DailyChart             自绘 SVG 堆叠柱状图
│   └─ Tooltip            天 + 总额 + 每模型一行（对齐官方样式）
├─ ModelTable             按天或按范围聚合；每行带置信度徽章
│   └─ ConfidenceBadge    exact / official / aggregator / inherited / estimated / unpriced
├─ UnpricedBanner         "3 个模型未定价，共 1.2M tokens" + 一键补价
└─ PriceDrawer            手填表单 / 同步 diff 审阅 / 导出导入 JSON
```

### 5.5 价格同步流水线

```
fetch（三源并行，各自超时 10s）
   → normalize（统一成 {provider, model, currency, unit:"1M", buckets, tiers, peak}）
   → match（用我们的 model id 去对齐，记下匹配方式和置信度）
   → diff（和本地 prices.json 比，产出 added/changed/removed，不自动写入）
   → review（UI 里人看一眼；或 config 里 autoApply=true 才自动写）
   → commit（写 prices.json + 记 sync_log：时间、源、条目数、失败源）
```

**为什么必须有人工审阅这一步？** 因为你这条链路上，自动同步大概率会把 `deepseek-v4.1-flash-1017` 匹配到某个转售商的价格（$0.203/$0.609），和百炼的实际扣费不是一回事。宁可不自动改，也不要悄悄变贵。

### 5.6 存储 schema

M1 用文件，不用数据库（对小白友好：能直接打开看、能 diff、能 git 管理）。

```
~/.dsh/cost-ledger/
├─ samples.ndjson     每行一条 UsageSample（只追加）
├─ rollups.json       {"version":1, "days": {"2026-11-04": {...}}}
├─ prices.json        {"version":1, "rows":[...], "fx": {"USDCNY": {"rate":7.12,"at":...}}}
├─ settings.json      {"version":1, ...}
└─ sync.log.ndjson    每次同步一行（源、结果、耗时）
```

`rollups.json` 是**缓存**，随时可由 `samples.ndjson` 重建 —— 这条性质让「算错了」永远可修复。等数据量真的到几十万条再换 `node:sqlite`（Node 24 内置，无原生依赖），接口不变。

### 5.7 启动时序

```
DSH 启动
  → Loader import 本包 → 检查 inject 服务齐全
  → apply(ctx)
      ├ 读 settings.json / prices.json（坏文件 → 备份 + 用默认值，绝不崩）
      ├ 打开 ledger，增量重放 samples.ndjson 尾部
      ├ ctx.on("session/event") 开始收
      ├ 注册 4 个路由
      └ 若 autoSync：延迟 30s 后台同步一次（不阻塞启动）
  → 用户发消息 → assistant/message 到达 → 1ms 内落样本
  → 用户切到「费用」标签 → fetch /summary → 渲染
```

---

## 6. 关键 API 速查（都在你机器上验证过）

### 6.1 Host 半边

```js
// lib/index.js —— 这是骨架，不是最终代码
import z from "@deepseek-ai/schemastery";
import { openLedger } from "./ledger.js";
import { registerRoutes } from "./routes.js";

export const name = "cost-ledger";
export const inject = ["webServer", "sessions"];

export const Config = z.object({
  currency: z.union([z.const("CNY"), z.const("USD")]).default("CNY").volatile(),
  budgetCNY: z.number().min(0).default(20).volatile(),
  autoSync: z.boolean().default(true).volatile()
});

export function apply(ctx, config = {}) {
  const ledger = openLedger({ home: process.env.DSH_HOME, config });

  ctx.effect(
    () => ctx.on("session/event", (session, event) => {
      ledger.ingest(session?.id ?? "unknown", event);
    }),
    "cost-ledger: session events"
  );

  registerRoutes(ctx, ledger);   // 内部用 ctx.webServer.register({kind:"exact",...})
}
```

服务名与用途（来自 `dsh-session-cost` 的 `inject` 声明，已验证）：

| 服务 | 用途 |
|---|---|
| `webServer` | `ctx.webServer.register({ kind, path, handler })` 开路由 |
| `sessions` | `ctx.sessions.list()` 拿活跃会话（可选，用于实时补算） |
| `credentials` | 取 API key（调余额/账单接口时才需要） |
| `settings` | 读宿主设置（比如知道当前 provider 配了哪些模型） |
| `sessionTitle` | `ctx.get('sessionTitle').get(session)` 拿会话标题（做"哪一轮最贵"时好认） |

其他可用事件：`subagent/start`、`subagent/end`、`session/disposed`（清理内存用）。

**Config 的坑（务必记住）**：字段必须加 `.volatile()`，否则它**不会**出现在设置表单里，而且写入会报 `Plugin entry "..." has no volatile fields`。这是 schemastery 的约定，报错信息完全不提"你忘了 volatile"。

### 6.2 Client 半边

```js
// lib/client.js —— 加一个「费用」标签页
import { createElement as h, useEffect, useState } from "react";

export const name = "cost-ledger";
export const inject = ["slots", "locale"];

export function apply(ctx) {
  ctx.effect(
    () => ctx.locale.register("cost-ledger", { zh, en }),
    "cost-ledger: dictionaries"
  );

  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register({
      name: "conversation.view",
      id: "cost-ledger",            // 同插槽内唯一
      order: 40,                    // 编队是 30，我们排后面
      locale: "cost-ledger",
      label: () => "费用"
    }, CostLedgerTab)
  );
}
```

React 由宿主注入（`dsh.client.inject` 里那些包），**不要自己再打一份 React**，否则 hooks 会崩。

### 6.3 一次完整调用的数据流

```
用户提问
  → Host 调模型 → 流式返回 → 步骤结束落 assistant/message 事件
  → 我们的 ctx.on 收到 → ingest 归一化 → 去重 → 追加 samples.ndjson
  → （懒计算）用户打开标签页 → GET /summary → pricing 逐条定价 → 聚合成 rollups
  → 返回 JSON → React 渲染柱状图
```

注意：**收事件时不做价格计算**。收了就存，查询时才算。这样改价/补价后，历史数字自动跟着变（而且能一键 rebuild）。

---

## 7. 界面设计

### 7.1 标签页

位置：`对话 | 轨迹 | 上下文 | 编队 | **费用**`

首屏四块（自上而下）：

```
┌──────────────────────────────────────────────────────────────────┐
│ 今日 ¥0.42   近7天 ¥2.18   本月 ¥6.90   缓存命中 81%   预算 35%  │
│ ⚠ 2 个模型未定价（cmaas-glm-5.3, vanchin/*），共 1.2M tokens  ›  │
├──────────────────────────────────────────────────────────────────┤
│  ¥                                                               │
│  2 ┤                    ▂                                        │
│  1 ┤          ▄        ██        ▄                              │
│  0 └──┬────┬────┬────┬────┬────┬────┬──                          │
│      10/29 30   31   11/1  2    3    4                           │
│      └ 选区切换：金额 / tokens（对齐官方的「调用类型」开关）      │
├──────────────────────────────────────────────────────────────────┤
│  模型                    输入    缓存读   输出     单价      成本  │
│  bailian·deepseek-v4.1-flash-1017  12.3K  48.1K  3.4K  …   ¥0.31 │
│  bailian·cmaas-glm-5.3             8.1K     —     2.2K  未定价    │
└──────────────────────────────────────────────────────────────────┘
```

### 7.2 图表规格（对齐你截图里官方那张）

- 类型：**按天堆叠柱状图**，每段 = 一个模型（同一 provider 用同色系深浅区分）
- X 轴：日期；Y 轴：¥（自适应，最小刻度 0.01）
- 空日期保留占位（不塌缩），否则"没花钱"和"没记录"会看起来一样
- hover：白底圆角浮层，左「2026-11-04」右「¥0.42」，下方可展开每模型一行 —— **跟官方样式一致**
- 精度：值 < 0.01 显示 4 位有效数字（`¥0.0053`），≥ 1 显示 2 位
- 点击某天 → 切到单日视图（按 turn 列出）

实现：手写 SVG（约 250 行）就够。不引 echarts（几 MB，且我们要控制包体）。

### 7.3 价格编辑

```
┌ 价格：bailian · cmaas-glm-5.3 ───────────────────────────┐
│ 输入 ¥[ 2.00 ]  缓存读 ¥[ 0.20 ]  缓存写 ¥[ 2.00 ]        │
│ 输出 ¥[ 6.00 ]   分档：无 ▾      峰谷：关闭 ▾              │
│ 来源：手动填写   核对日期：[2026-11-04]   备注：[百炼控制台]│
│                                        [取消]  [保存]      │
└──────────────────────────────────────────────────────────┘
```

保存后立刻重算并刷新图表 —— 这是整个插件最爽的一刻：**你终于能把"未定价"变成"真数字"**。

### 7.4 文案原则

- 用「折算成本」而不是「花费」，用「估算」而不是「账单」。
- 每个数字旁边能点开「这钱怎么算的」（显示公式和四个分项）。
- 未定价时显示 token 数，不显示 ¥0.00。

---

## 8. 里程碑

### M1 · 能看清自己花了多少（2 天）

- [ ] 包骨架 + `cordis.patch.yml` + `package.json`（能被 DSH 加载）
- [ ] `ingest.js`：事件 → 样本，幂等键去重
- [ ] `ledger.js`：`samples.ndjson` + `rollups.json` + 原子写
- [ ] `pricing.js`：手动价目表（你 7 个模型）
- [ ] `/summary` `/day` `/health`
- [ ] Client：`conversation.view` 标签 + KPI + 7 天柱状图 + 模型表
- [ ] `scripts/replay.mjs`：喂真实日志，打印逐轮金额

**验收**：打开任意历史会话，界面的每轮成本 = `replay.mjs` 输出；`/health` 显示 `events > 0 && unpriced === 0`（在你补完 7 个模型价格之后）。

### M2 · 价格自动化（4 天）

- [ ] `sync.js`：三源抓取 + 归一 + diff（不自动应用）
- [ ] 价格审阅 UI（逐条接受/拒绝）
- [ ] 置信度徽章 + 未定价横幅 + 一键补价
- [ ] 汇率快照；USD 价目自动换算
- [ ] 分档 / 峰谷规则（价目行可选）
- [ ] 导出/导入 `prices.json`

**验收**：断网时插件照常工作并提示"上次同步时间"；同步后 `deepseek-v4.1-flash-1017` 不会被静默改成一个离谱的转售价。

### M3 · 对账 + 发布（1 周）

- [ ] 预算告警（今日/本月超阈值 → 标签页小红点）
- [ ] CSV 导出（天 × 模型 × token × 成本）
- [ ] 对账页：DeepSeek 余额 / OpenRouter credits / 手动贴账单 CSV
- [ ] 免费额度视角（按模型 token 累计）
- [ ] README（含"为什么 token 准、价格不准"的实测分析）+ 截图 + npm 发布 + DSH Market 上架

**验收**：30 天估算 vs 账单差额 < 5%；陌生人按 README 能在 10 分钟内装上并看到自己的数字。

---

## 9. 风险与对策

| 编号 | 风险 | 概率 | 对策 |
|---|---|---|---|
| R1 | DSH 事件结构随版本变化（`usage` 字段改名/挪位置） | 高 | 解析容错 + `/health` 记录未知事件类型 + 声明 `dsh.compatibility` |
| R2 | 自动同步匹配到错误 provider 的价格 | **高** | diff 必须人工确认；匹配方式写进日志；`provider` 必须命中才升到 `official` |
| R3 | 币种混淆（USD 当 CNY） | 中 | 价目行强制带 `currency` 字段；缺失即拒绝入库 |
| R4 | 重复计数（流式 chunk / 重连 / 子 agent） | 高 | 幂等键 + 替换语义 + 单测覆盖 |
| R5 | 日志变大后变慢 | 中 | 增量 fold + rollups 缓存 + 只读尾部 |
| R6 | 隐私 | 低 | 全部本地；出站仅三个价格域名白名单；README 明示 |
| R7 | 和已有插件写同一个文件/同一个 UI 位置 | 中 | 数据目录独立（`~/.dsh/cost-ledger/`）；插槽 `order` 避开冲突 |
| R8 | 许可证 | 低 | 参考实现是 MIT；我们重写实现，README 致谢并列出参考点 |

---

## 10. 附录

### A. 真实事件样本（你的会话日志，已脱敏）

本会话日志（`session.v4.jsonl.zstd`，78 个 zstd 帧、149 条事件）里出现的类型：

```
session, permission/preset, sandbox/mode, approval/policy,
agent/inbox/spliced, turn/start, step/start, system/message, user/message,
request/header, request/context, session/title, session/title-llm-request,
assistant/message, tool/call, job/registered, job/settled, tool/result, step/end
```

对我们的账本，只有 `assistant/message` 有金额意义；`turn/start` / `turn/end` 用来切轮次；`request/header` 里的 `config.model` 是 usage chunk 没有 model 时的兜底来源。

解压方式（Node 24 内置 zstd）：

```js
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
// 注意：整个文件是"多帧"拼接的，要按魔数 28 B5 2F FD 切帧逐个解压
```

### B. 本机参考实现索引

| 想学什么 | 去看 |
|---|---|
| 怎么加一个标签页 | `~/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js` → 搜 `conversation.view` |
| 怎么订阅会话事件 | `.../dsh-whale-widget/lib/index.js` → 搜 `session/event` |
| 怎么开 HTTP 路由 + 写 Config | `.../@kidli1412/dsh-session-cost/lib/index.js` → `apply()` |
| 幂等/峰谷/计价的正确口径 | `.../@kidli1412/dsh-session-cost/lib/cost.js`（读它，别抄它的价表） |
| 插件清单长什么样 | `~/.dsh/profiles/desktop/{package.json, cordis.patch.yml}` |

### C. 术语表

| 术语 | 人话 |
|---|---|
| cordis | DSH 的插件框架，负责加载/依赖/卸载 |
| service | 别人提供的能力，如 `webServer` |
| inject | 声明"我需要哪些 service"，缺了就不启动 |
| entry | 插件清单里的一行（id + 包名） |
| bundle / patch | 插件包自带的一段清单，叠加进 profile |
| slot | 界面上的命名"插座"，插件往里塞组件 |
| fold | 把事件流"折叠"成累计状态（账本的核心动作） |
| usage sample | 一次模型调用的 token 记录（我们的原子事实） |
| confidence | 价格的可信度标签（exact / official / aggregator / …） |
| 微元（microCNY） | ¥×1e6 的整数，避免浮点误差 |

### D. 给小白的学习路线（4 周，边做边学）

| 周 | 学什么 | 对应本项目的工作 |
|---|---|---|
| 1 | JS 基础（对象/数组/async）、Node 的 `fs`/`http`、JSON | 读日志、写 `replay.mjs`（不碰 UI） |
| 2 | 事件驱动 + 纯函数 + 单元测试（vitest） | `ingest.js` + `pricing.js` + 测试 |
| 3 | React 函数组件 + hooks（`useState`/`useEffect`） | 标签页、KPI、SVG 柱状图 |
| 4 | HTTP 接口设计、npm 发布、README 写作 | `/summary` 路由接通 UI，发布 |

**建议顺序**：先让"命令行能算出正确数字"，再做界面。因为界面骗人，数字不会。

---

## 11. 下一步（等你点头）

1. 你先审这份文档：**第 4 章的记账规则**和**第 8 章的 M1 范围**是重点，其它都能改。
2. 确认后我按 M1 搭脚手架（含 `replay.mjs` 和你 7 个模型的初始价目表），你跑一遍看数字对不对。
3. 数字对了，我们再谈 M2 的自动抓价 —— 那才是真正开始"像产品"的地方。