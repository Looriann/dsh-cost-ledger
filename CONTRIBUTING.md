# 贡献指南

先说结论：**这个项目的核心不是画图，是「不把价格算错」**。
所以任何 PR 的评判标准都是：改了之后，`npm test` 能不能证明它没算错。

## 环境

- Node.js `^22.19.0 || >=24.0.0`（需要 `zlib.zstdDecompressSync` 读会话日志）
- 零运行时依赖，**不需要 `npm install`**
- 想真机调试需要 DSH 桌面版

## 本地跑起来

```bash
git clone https://github.com/Looriann/dsh-cost-ledger.git
cd dsh-cost-ledger

npm run check      # 语法检查
npm test           # 22 项单元用例 + 8 项插件冒烟
npm run replay     # 回放本机真实会话，打印每日花费
```

装进 DSH 调试：

```bash
dsh plugin --profile desktop add link:<本仓库绝对路径>
# 改完 host 代码重启 DSH；只改 client.js 的话硬刷新页面即可
```

## 目录结构

| 路径 | 作用 | 改动风险 |
|---|---|---|
| `lib/ingest.js` | 事件 → 样本，幂等键 | 高（算错就重复计费） |
| `lib/pricing.js` | 身份归一、匹配、阶梯、微元 | 高（算错就金额错） |
| `lib/ledger.js` | 账本、按天汇总、价目表读写 | 高 |
| `lib/routes.js` | HTTP 路由（回环限制） | 中 |
| `lib/backfill.js` | 多帧 zstd 日志回填 | 中 |
| `lib/client.js` | 浏览器半边（手写 bundle，无构建） | 中 |
| `scripts/fetch-prices.mjs` | 价目抓取/解析 | 中 |

## 想加一个价目来源？

1. 在 `scripts/fetch-prices.mjs` 里加一个 `fetchXxx()`，产出统一的 row 形状：

```js
{
  provider: "bailian",        // 服务商标识，和事件里的 provider 对齐
  model: "qwen3.8-max",       // 原始模型名
  currency: "CNY",            // 没有币种的源不要收（USD 会算错）
  unit: "1M",                 // 每百万 token
  buckets: { input, cacheRead, cacheWrite, output },  // 或
  tiers: [{ maxPrompt, input, output }],               // 阶梯
  source: "official",         // official | aggregator | manual
  sourceUrl: "https://…",     // 必须写，方便别人复核
  fetchedAt: Date.now(),
  confidence: "official"
}
```

2. 币种不是 CNY 的，先换算并在 `note` 里写清汇率与日期 —— **不要静默混币种**。

## 提交规范

```
feat: 新增 xxx
fix: 修正 xxx
docs: 文档
test: 用例
chore: 杂项
```

一个 PR 只做一件事；改了计价口径的，必须同时补用例。

## 发布到 npm

```bash
npm login                       # 首次
npm version patch               # 或 minor / major
npm publish                     # prepublishOnly 会自动跑 check + test
```

发完把新版本号同步到本文件与 `CHANGELOG.md`，再在插件商场刷新索引即可。

> 第一次发布、需要一步步点 GitHub Desktop 的，看 [docs/发布教程.md](docs/发布教程.md)。

## 补一张截图

`docs/screenshot.png` 本仓库还没放（作者截一张就行）：

1. 打开任意会话 → 点顶部「费用」
2. 截图，宽度建议 1600px 左右
3. 存为 `docs/screenshot.png`
4. 把 README 里那段被注释掉的 `<img>` 取消注释

## 行为准则

技术讨论就事论事；不欢迎针对个人、厂商或同行的攻击。价格数据有争议时，**以官方文档链接为准**。