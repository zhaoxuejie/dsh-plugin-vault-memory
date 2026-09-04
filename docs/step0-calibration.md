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
