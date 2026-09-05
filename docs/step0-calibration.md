# Step 0 环境校准记录（2026-xx，实测）

开工前对 phase1 规范中标注 ⚠️ 的复核点逐项实测，结论如下。本文档即"校准点"的最终答案。

## 1. dsh CLI / 安装链路

- `dsh` 版本 `0.1.1-rc.2`（`C:\Users\Lenovo\AppData\Local\hermes\node\dsh.ps1`）。
- `dsh plugin --profile <name> add <dir>` = 在 profile 目录执行 **`pnpm add <dir>`**（支持本地目录链接安装），随后自动应用 `cordis.patch.yml`。
- profile 现有 `web` / `desktop` 两个；开发验证用 `web`。
- ⚠️ 已知小坑：`dsh plugin --profile web list` 当前因 pnpm 自身 store 库报 `ERR_SQLITE_ERROR`，不影响 `add`。

## 2. 工具注册 API（dsh-tools）

- 插件代码运行在宿主进程，**不能也不需 import 任何 `@deepseek-ai/*` 包**（profile 的 `@deepseek-ai` 目录只有客户端包；声明 peer 会导致 pnpm 解析失败 → 不写 peerDependencies）。
- `ctx.tools.register(definition)`：definition = 普通对象 `{ name, description, parameters, timeoutMs, output:{ schema, render, presentationMeta? }, execute(args, exec), presentCall?, presentResult?, isConcurrencySafe? }`；`defineTool` 仅是 TS 类型助手（JS 不需要）。
- 注册返回 dispose；工具层作用域 = 调用 ctx（插件级注册即全局可见）。
- 执行体返回 canonical JSON 值；`exec.signal` 为协作取消信号；`output.render` 产出 content 文本。
- 错误：抛 `Error` 带 `code` 属性即可（`HarnessError` 的 `{name,code}` 仅一方内部使用，插件无需 import）。

## 3. SQLite 驱动：`node:sqlite`（DatabaseSync）

- 一方 `@deepseek-ai/dsh-session-query-sqlite` 即用 `node:sqlite` DatabaseSync → **选型对齐，零原生依赖**。
- 实测 harness 自带 Node（v22.23.0）与 PATH node 均可用（仅 ExperimentalWarning，无 flag 要求）。
- API：`new DatabaseSync(path)`、`db.exec`、`db.prepare().run/get/all`、事务 `db.exec("BEGIN")/COMMIT/ROLLBACK`。

## 4. FTS5 中文检索实测结论（决定分词方案）

实测（见下）发现两个内置分词器对中文都不可用：

| 分词器 | 实测 | 结论 |
|---|---|---|
| `trigram` | "消费降级"命中；**"省钱"（2 字）漏检** | 词长 ≥3 才能检索，中文 2 字词大量漏检 ❌ |
| `unicode61`（默认） | 连续中文整段=一个 token；"你好"搜不到"你好世界" | 中文无分词 → 子串/短词失效 ❌ |

**方案（已定）**：自研 CJK bigram 分词 —— 中文连续段切成重叠二元组（"知识库"→"知识 识库"），英文/数字按空格保持原样；索引与查询两侧同规则。FTS5 表用默认 unicode61 存分词结果（token 已由我们预切好）。查询侧所有 token 双引号包裹（转义内部引号）后 AND 连接，防注入。

**短查询兜底**：FTS 零命中时，对 `content_plain` 做 `LIKE '%q%'`（转义 `%_`）兜底保证召回（规模 1 万篇内毫秒级）。

**snippet 自研**：不用 fts5 snippet/highlight（bigram 下高亮错位），改在原文 `content_plain` 上定位查询串截窗口。

bm25 返回负值（越小越相关），展示时取反归一。

## 5. 设置注册

- `settings.register(name, Schema.object({...}), { applies: "live" })` → `scope.get()` / `scope.watch(cb)` 热更新（dsh-daily-digest 同款，已核）。
- profile 中已有 `schemastery@3.18.0`（lockfile 两处引用）→ `package.json` 依赖钉 `^3.18.0`，安装可复用 store、无网络压力。

## 6. 文件访问与沙箱边界

- bundle 插件用 `node:fs` 直读宿主磁盘（dsh-daily-digest 读 `<DSH_HOME>/data` 先例）；插件工具执行体同样跑在宿主进程。
- 本插件对 vault 的读写全部走自研**路径监狱**（resolve+realpath 复检），不依赖 ctx.fs/会话沙箱；vault 路径由用户在设置中显式配置 = 授权。
- 运行数据：`<DSH_HOME>/data/vault-memory/<vaultHash>.db`（DSH_HOME = `C:\Users\Lenovo\.dsh`）。

## 7. 对其他设计点的影响

- `vault_read` 改为**直接从磁盘按行读**（带行号窗口），天然新鲜，不依赖 DB 缓存内容。
- links 解析：parser 产出候选目标；store 用内存 path→id 映射解析 `resolved_note`（悬空=NULL）。
- tokenize 单独成模块 `src/core/tokenize.mjs`（parser 不掺检索词），供 store 索引与 search 查询共用。

## 8. 真机验证发现（Step 3，headless profile 实测修正）

| # | 现象 | 根因 | 修正 |
|---|---|---|---|
| 1 | 插件加载报 `Cannot find package 'schemastery'` | `link:` 直链安装时依赖从**仓库路径**解析，仓库未跑过 `pnpm install` | 仓库内 `pnpm install`（发布安装不受影响）；README 注明开发前置步骤 |
| 2 | 注册即炸 `unsupported JSON schema: ... required is not supported on type "string"` | `defineTool` 才会做"参数规格→JSON Schema"转换；`register(普通对象)` 原样直传。per-property `required: true` 是规格语法，不是 JSON Schema | `output.schema` 与 `parameters` 一律写**标准 JSON Schema 子集**：根 `type:"object"`、`required` 顶层数组、`items`/`additionalProperties` 按类型合法 |
| 3 | provider 报 `Invalid schema for function 'vault_query' ... got 'type: null'` | 同上根因的另一面：无 `required` 标记的参数对象被当作"已是 JSON Schema"直传，根无 `type` | 同上（vault_query 全可选参数也显式写 `type:"object"` 根） |
| 4 | agent 调用工具返回"未配置任何 vault"，entry `config:` 没生效 | loader 的 entry config 经 `apply(ctx, config)` 第二参数传入；settings 的分层 = schema 默认 → **base（注册时传入的入口 config）** → 用户文档 | `apply(ctx, entryConfig)` + `settings.register(name, Config, { applies:"live", base: entryConfig })` |

**验收结果（headless + 真库 moqian-work）**：
- ✅ agent 调用 `vault_search` 命中真实笔记 `tools/docker-practical-guide.md`，标题正确、标注库名 work
- ✅ 未配置场景 agent 明确说"没有配置/找不到"，不编造笔记
- ✅ 插件经 `dsh plugin --profile web add` 装入 web profile（下次重启生效），索引库落 `<DSH_HOME>/data/vault-memory/605069b85a6bd5eb.db`
- 注意：`apply(ctx)` 第二参数 config 是 loader 传入的 entry config；settings 服务存在时以 `register(..., { base })` 合并，不存在时直接用它兜底。

## 9. Phase 2 真机校准（记忆注入 / GUI / 捕获）

| # | 现象 | 根因 | 修正 |
|---|---|---|---|
| 1 | 不带 `--patch` 的 headless 运行里 agent 说"没有 vault 工具" | 手动 `pnpm add` 只装包**不挂载**；挂载来自 bundles 记录（`dsh plugin add`）或 `--patch` 覆盖层 | headless 验证一律 `--patch <overlay>`；此前"工具存在"的运行其实都带了 overlay |
| 2 | `systemPrompt.context()` 注入的快照 agent 看不到 | context 是"user 角色动态上下文快照"，headless 组装路径未物化 | 改 `systemPrompt.section({ text: fn })` —— 函数型 text 每次组装求值，静态/函数 section 均真机验证可见 |
| 3 | 记忆快照一直为空 | 两个叠加：a) provider 早于后台全扫完成（ready=false → 空串）；b) `runtime.vaultKeys` 项**没带 index 引用**，蒸馏永远拿不到索引 | provider 前 `waitReady`（ensureReady + 短轮询）；rebuildIndexes 把 index 挂进 vaultKeys 项 |
| 4 | schemastery 嵌套 object 配 `.default(() => ({}))` 导致 boot 校验炸（"expected object but got () => ()"） | 该 schemastery 版本把 default 工厂当字面值校验 | 嵌套 object 不写 default，缺失由 `resolveConfig` 防御合并兜底 |
| 5 | 功能型与静态 section 都能渲染 → 证明 bundle 插件 section 通道正常；先前"看不到"均为未挂载（见 #1） | — | — |

**Phase 2 验收结果（headless + moqian-work）**：
- ✅ 记忆注入：agent 能复述注入快照（库 work、7 篇、活跃目录 dsh插件/tools、近期笔记路径）——真实数据
- ✅ `vault_related` 端到端执行：孤立笔记优雅返回"无关联"（moqian-work 确无链接网）
- ✅ `vault_search` 相关度排序与片段正确（PowerShell 主题笔记第一）
- ✅ GUI 浮卡：用户重启 web 后确认可见（曾因 client 未 `appendChild(document.body)` 成孤儿 DOM，修复 `c693de5`）

## 10. Phase 3 真机校准（巡检 / 审查 / 工具输出）

| # | 现象 | 根因 | 修正 |
|---|---|---|---|
| 1 | boot 炸 `cannot get property "timer" without inject` | 直接读未挂载的 `ctx.interval` 会触发 cordis 服务代理抛错 | 用 try/catch 包裹 `ctx.interval(...)`，失败退回原生 `setInterval`（fiber 清理由 effect dispose 承担） |
| 2 | 工具报 `value is not lossless JSON` | 返回对象里带**显式 `undefined` 属性**（`candidates: undefined`）——`JSON.stringify` 会丢、harness 无损 JSON 校验会拒 | 工具返回一律条件赋值，禁止显式 undefined 属性（通用经验，全工具适用） |
| 3 | review 路由找不到建议 | routes.test 的 `vaultKeys` 项没带 `index`（生产 rebuildIndexes 会挂） | 测试 fixture 补 `index` 引用；findSuggestion 扫 `k.index` |

**Phase 3 验收结果（headless + moqian-work，真机）**：
- ✅ `vault_health(run=true)`：openTotal 9（orphan 7 / broken_link 2），理由/路径真实；第二轮 run 幂等去重 0 新增；全程未改任何 vault 文件
- ✅ 审查写回/回滚/幂等/dismiss/stats：单测覆盖（fixture 上批准→备份→回滚内容一致；moc 建→回滚删）
- ⏳ GUI「审查」tab + 每日定时（03:00）：代码就绪，**需用户重启 web profile 后浏览器确认**
- ⏳ 语义嵌入（v1.1）：本机 Ollama 未运行 → embedder 未落地，装好 Ollama（`nomic-embed-text`/`bge-m3`）后按 phase3 规范 §3 补实现
- 注意：孤儿建议按规则排除 <20 字占位；moc 阈值默认 8（可配 `review.mocThreshold`）；断链候选不足时批准需显式指定目标
